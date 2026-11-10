// 0.4.6 自审（2026-11-03 第二轮，DSH 22:36 派单）：审的是**上一轮那四条改动自己会怎么坏**。
//
// 用法：node tools/fixtures/deps-review-probe.mjs <E|F|G|H>
//   退出码 0 = PASS；1 = 红；2 = 探针自身失效（切不出函数体 / 沙箱崩了），不当 PASS
//
//   E  probeGpu 的「没卡」判定：ENOENT 只说明 PATH 里没这个命令，不等于没卡。
//      判据三条：绝对路径兜底能认到卡、已有运行库时不谎称无卡、真没卡真没库时才早退。
//      改坏方式：把 nvidiaSmiCands 的绝对路径去掉、或删掉 cudaLibsBytes 那段判断，本节必红。
//   F  手点「刷新」必须跳过缓存：gpuCacheHit 的 fresh 分支 + pyProbe 的 opts.fresh。
//      改坏方式：gpuCacheHit 忽略 fresh、或 pyProbe 仍无条件吃缓存，本节必红。
//   G  cuda 装完必须先作废 GPU 缓存再复查（否则红点要挂满 5 分钟、日志还写一行假失败）。
//      改坏方式：删掉 beforeRecheck 里的 resetGpu 调用，本节必红。
//   H  两个精确边界：dropImportCacheUnder 的键匹配、downloadConflict 的互斥对称性。
//      改坏方式：前缀判断去掉 `|`、或让 all 与单项只单向互斥，本节必红。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const section = (process.argv[2] || '').toUpperCase()

function broken(msg) {
  console.error('PROBE-BROKEN: ' + msg)
  process.exit(2)
}
function sliceFn(src, sig) {
  src = src.replace(/\r\n/g, '\n')
  const start = src.indexOf(sig)
  if (start < 0) broken('没找到定义 ' + sig)
  const end = src.indexOf('\n}\n', start)
  if (end < 0) broken(sig + ' 没有行首 } 收尾（切法失效）')
  const body = src.slice(start, end + 3)
  if (body.split('\n')[0].indexOf(sig.slice(0, sig.indexOf('('))) < 0) broken('切出来的不是 ' + sig)
  return body
}
function newCtx(extra) {
  // C227-B：同 deps-guards-probe，补真平台别名，别用恒 true 的假桩把平台分支测没了。
  const ctx = { process, isWin: () => process.platform === 'win32', isMac: () => process.platform === 'darwin', hostPlatform: () => process.platform, console, Date, JSON, Math, Number, String, Array, Object, Set, Promise, setTimeout, clearTimeout, ...extra }
  ctx.globalThis = ctx
  return ctx
}
const fails = []
function must(cond, msg) {
  if (!cond) fails.push(msg)
}
function report(passMsg) {
  if (fails.length) {
    console.log('FAIL: ' + fails.join('；'))
    process.exit(1)
  }
  console.log('PASS: ' + passMsg)
  process.exit(0)
}

const src = readFileSync(join(root, 'index.js'), 'utf8')

if (section === 'E') {
  const cands = sliceFn(src, 'function nvidiaSmiCands() {')
  const smiFn = sliceFn(src, 'async function probeNvidiaSmi() {')
  const probeFn = sliceFn(src, 'async function probeGpu() {')

  /** @param {'abs'|'libs'|'none'} mode */
  const run = async (mode) => {
    const stub = `
      globalThis.__pyCalls = 0
      globalThis.__smiCalls = []
      const execFileP = async (cmd, args) => {
        if (/nvidia-smi/.test(cmd)) {
          globalThis.__smiCalls.push(cmd)
          if (cmd === 'nvidia-smi') return { ok: false, stdout: '', err: { code: 'ENOENT' } }
          if (__ABS) return { ok: true, stdout: 'GPU 0: NVIDIA GeForce RTX 4090 (UUID: x)\\n', err: null }
          return { ok: false, stdout: '', err: { code: 'ENOENT' } }
        }
        globalThis.__pyCalls++
        if (args && args[0] === '-c') return { ok: __LIBS === 1, stdout: '', err: {} }
        if (args && args[1] === '--probe-gpu') return { ok: __DLL === 1, stdout: '', err: {} }
        return { ok: false, stdout: '', err: {} }
      }
      const existsSync = () => true
      const venvAsr = () => ['/stub/venv/python.exe']
      const join = (...a) => a.join('/')
      const DEPS = '/stub/deps'
      const GPU_PROBE_TIMEOUT_MS = 1000
      const probeWhy = () => 'stub'
      const cudaLibsBytes = () => __LIBBYTES
      ${cands}
      ${smiFn}
      ${probeFn}
      globalThis.__ret = probeGpu()
    `
    const ctx = newCtx({
      __ABS: mode === 'abs',
      __LIBS: mode === 'libs' || mode === 'libs-nodll' ? 1 : 0,
      __DLL: mode === 'libs' ? 1 : 0,
      __LIBBYTES: mode === 'libs' || mode === 'libs-nodll' ? 1300 * 1048576 : 0,
    })
    try {
      vm.runInNewContext(stub, ctx, { timeout: 8000 })
    } catch (e) {
      broken('沙箱 E/' + mode + ' 抛了 ' + e.message)
    }
    const ret = await ctx.__ret
    if (!ret || !ret.val) broken('probeGpu 没返回 { val }（mode=' + mode + '）')
    return { ret, smiCalls: ctx.__smiCalls, pyCalls: ctx.__pyCalls }
  }

  // ① PATH 里没有 nvidia-smi，但 System32 里那份在 → 必须认到卡
  const abs = await run('abs')
  must(abs.ret.val.deviceCount === 1, '①绝对路径兜底：deviceCount 应为 1，实际 ' + abs.ret.val.deviceCount)
  must(abs.ret.val.noCard === false, '①绝对路径兜底：noCard 应为 false，实际 ' + abs.ret.val.noCard)
  must(abs.smiCalls.length === 2, '①应先试裸名再试绝对路径（2 次），实际 ' + abs.smiCalls.length + ' 次：' + JSON.stringify(abs.smiCalls))

  // ② 哪儿都找不到 nvidia-smi，但 venv 里已有运行库 → 不许谎称「本机无显卡」，继续探加载能力
  const libs = await run('libs')
  must(libs.ret.val.noCard === false, '②已有运行库时 noCard 应为 false（不许谎称无卡），实际 ' + libs.ret.val.noCard)
  must(libs.ret.val.dllReady === true, '②已有运行库时应继续探 --probe-gpu 并采用结论，实际 dllReady=' + libs.ret.val.dllReady)
  must(!/本机无 NVIDIA 显卡/.test(String(libs.ret.val.note || '')), '②note 里仍写着「本机无 NVIDIA 显卡」：' + libs.ret.val.note)

  // ④ 有库、但 --probe-gpu 也验不出来 → 既不能说「没卡」，也不能说「加载失败」
  const blind = await run('libs-nodll')
  must(blind.ret.val.unknown === true, '④有库但验不出加载：unknown 应为 true，实际 ' + blind.ret.val.unknown)
  must(blind.ret.val.noCard === false, '④有库但验不出加载：noCard 必须是 false（有库就证明不了没卡），实际 ' + blind.ret.val.noCard)
  must(!/加载失败/.test(String(blind.ret.val.note || '')), '④note 里还写着「加载失败」（把「没法验证」说成「库坏了」）：' + blind.ret.val.note)

  // ③ 真没卡、也真没库 → 早退，一句「本机无 NVIDIA 显卡」，python 侧一次都不许调
  const none = await run('none')
  must(none.ret.val.noCard === true, '③没卡没库：noCard 应为 true，实际 ' + none.ret.val.noCard)
  must(none.ret.confident === true, '③没卡没库：confident 应为 true，实际 ' + none.ret.confident)
  must(none.pyCalls === 0, '③没卡没库：不该再探 python 侧，实际调用了 ' + none.pyCalls + ' 次')

  report('没卡判定三态：绝对路径兜底认卡、有库时不谎称无卡、真无卡才早退（python 侧 0 次）')
}

if (section === 'F') {
  const cacheFn = sliceFn(src, 'function gpuCacheHit(cache, now, ttl, fresh) {')
  // 2026-11-06 面板首屏：pyProbe 改 async / execFileP，桩与调用同步跟着改（否则 F 段拿 Promise 假绿）。
  const probeFn = sliceFn(src, 'async function pyProbe(py, code, opts = {}) {')
  const stub = `
    globalThis.__calls = 0
    const IMPORT_TTL_MS = 5 * 60 * 1000
    const IMPORT_TTL_FAIL_MS = 30 * 1000
    let importCache = {}
    const statSync = () => ({ mtimeMs: 1 })
    const execFileP = async () => {
      globalThis.__calls++
      const e = new Error('boom'); e.stderr = 'ImportError: no module'
      return { ok: false, stdout: '', err: e }
    }
    const probeWhy = () => 'stub'
    ${cacheFn}
    ${probeFn}
    globalThis.__r = (async () => {
      const now = 1700000000000
      const hot = { at: now - 1000, val: { deviceCount: 1 } }
      const cold = { at: now - 10 * 60 * 1000, val: { deviceCount: 1 } }
      const r1 = await pyProbe('/py.exe', 'import x')
      const r2 = await pyProbe('/py.exe', 'import x')
      const r3 = await pyProbe('/py.exe', 'import x', { fresh: true })
      return {
        hitFreshOff: gpuCacheHit(hot, now, 5 * 60 * 1000, false),
        hitFreshOn: gpuCacheHit(hot, now, 5 * 60 * 1000, true),
        hitCold: gpuCacheHit(cold, now, 5 * 60 * 1000, false),
        hitEmpty: gpuCacheHit({ at: now, val: null }, now, 5 * 60 * 1000, false),
        firstCached: r1.cached === true,
        secondCached: r2.cached === true,
        thirdCached: r3.cached === true,
        calls: globalThis.__calls,
      }
    })()
  `
  const ctx = newCtx({})
  try {
    vm.runInNewContext(stub, ctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱 F 抛了 ' + e.message)
  }
  const r = await ctx.__r
  if (!r) broken('没拿到结果 F')
  must(r.hitFreshOff === true, 'F/GPU：没传 fresh 且缓存未过期时应命中，实际 ' + r.hitFreshOff)
  must(r.hitFreshOn === false, 'F/GPU：传了 fresh 就必须跳过缓存，实际 ' + r.hitFreshOn)
  must(r.hitCold === false, 'F/GPU：缓存过期时应重探，实际 ' + r.hitCold)
  must(r.hitEmpty === false, 'F/GPU：没有 val 时不算命中，实际 ' + r.hitEmpty)
  must(r.firstCached === false, 'F/探针：第一次必须真跑，实际 cached=' + r.firstCached)
  must(r.secondCached === true, 'F/探针：第二次应命中缓存，实际 cached=' + r.secondCached)
  must(r.thirdCached === false, 'F/探针：传 fresh 时必须绕过缓存，实际 cached=' + r.thirdCached)
  must(r.calls === 2, 'F/探针：整个过程只该真跑 2 次，实际 ' + r.calls + ' 次')

  report('手点刷新跳过两类缓存：gpuCacheHit 的 fresh 分支与 pyProbe 的 fresh 生效，轮询路径仍吃缓存')
}

if (section === 'G') {
  const fn = sliceFn(src, 'function beforeRecheck(target, hooks = {}) {')
  const ctx = newCtx({})
  const stub = `
    let __reset = 0
    ${fn}
    const hooks = { resetGpu: () => { __reset++ } }
    beforeRecheck('cuda', hooks)
    const afterCuda = __reset
    __reset = 0
    beforeRecheck('asr', hooks)
    beforeRecheck('ocr', hooks)
    beforeRecheck('all', hooks)
    const afterOthers = __reset
    __reset = 0
    let threw = ''
    try { beforeRecheck('cuda', {}) } catch (e) { threw = String(e && e.message) }
    globalThis.__r = { afterCuda, afterOthers, threw }
  `
  try {
    vm.runInNewContext(stub, ctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱 G 抛了 ' + e.message)
  }
  const r = ctx.__r
  if (!r) broken('没拿到结果 G')
  must(r.afterCuda === 1, 'G：cuda 装完必须作废 GPU 缓存（应调 1 次），实际 ' + r.afterCuda)
  must(r.afterOthers === 0, 'G：asr/ocr/all 不该动 GPU 缓存，实际调了 ' + r.afterOthers + ' 次')
  must(r.threw === '', 'G：hooks 缺 resetGpu 时不许抛，实际抛了 ' + r.threw)

  report('cuda 下载结束先 resetGpuCache 再复查（asr/ocr/all 不动 GPU 缓存，缺钩子不抛）')
}

if (section === 'H') {
  const dropFn = sliceFn(src, 'function dropImportCacheUnder(cache, pys) {')
  const conflictFn = sliceFn(src, 'function downloadConflict(target, running) {')
  const stub = `
    ${dropFn}
    ${conflictFn}
    const P = 'D:\\\\deps\\\\.venv-asr\\\\Scripts\\\\python.exe'
    const Q = 'D:\\\\deps\\\\.venv-ocr\\\\Scripts\\\\python.exe'
    const cache = {}
    cache[P + '|1|import faster_whisper'] = { ok: false }
    cache[P + '|2|import faster_whisper'] = { ok: false }   // 同解释器不同 mtime：也该清
    cache[Q + '|1|import rapidocr'] = { ok: false }
    cache['D:\\\\deps\\\\.venv-asr\\\\Scripts\\\\python.exe.bak|1|x'] = { ok: false } // 兄弟路径，不该清
    cache['D:\\\\other\\\\python.exe|1|x'] = { ok: false }
    const n = dropImportCacheUnder(cache, [P])
    globalThis.__r = {
      n,
      left: Object.keys(cache).sort(),
      upperMiss: (() => {
        const c2 = {}
        c2['D:\\\\DEPS\\\\.venv-asr\\\\Scripts\\\\python.exe|1|x'] = { ok: false }
        return dropImportCacheUnder(c2, ['D:\\\\deps\\\\.venv-asr\\\\Scripts\\\\python.exe'])
      })(),
      sepMiss: (() => {
        const c3 = {}
        c3['D:/deps/.venv-asr/Scripts/python.exe|1|x'] = { ok: false }
        return dropImportCacheUnder(c3, ['D:\\\\deps\\\\.venv-asr\\\\Scripts\\\\python.exe'])
      })(),
      same: downloadConflict('asr', ['asr']),
      allBlocksSingle: downloadConflict('ffmpeg', ['all']),
      singleBlocksAll: downloadConflict('all', ['asr']),
      free: downloadConflict('asr', []),
    }
  `
  const ctx = newCtx({})
  try {
    vm.runInNewContext(stub, ctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱 H 抛了 ' + e.message)
  }
  const r = ctx.__r
  if (!r) broken('没拿到结果 H')
  must(r.n === 2, 'H/清缓存：同一解释器两条（mtime 不同）都该清，应返回 2，实际 ' + r.n)
  must(r.left.length === 3, 'H/清缓存：应剩 3 条（另一个 venv + 兄弟路径 + 无关路径），实际 ' + r.left.length + '：' + JSON.stringify(r.left))
  must(!r.left.some((k) => k.indexOf('import faster_whisper') >= 0), 'H/清缓存：asr 的探针键没清干净：' + JSON.stringify(r.left))
  must(r.same !== '', 'H/互斥：同目标必须拒，实际放行')
  must(/一键装全部/.test(r.allBlocksSingle), 'H/互斥：all 在跑时点单项，理由要说明是「一键装全部」在跑，实际：' + r.allBlocksSingle)
  must(/asr/.test(r.singleBlocksAll), 'H/互斥：单项在跑时点 all，理由要指明是谁在跑，实际：' + r.singleBlocksAll)
  must(r.free === '', 'H/互斥：没有下载在跑时必须放行，实际：' + r.free)
  must(r.upperMiss === 0, 'H/归一化（已知边界）：大小写不同的路径清不掉，本条用来固化现状，实际返回 ' + r.upperMiss)
  must(r.sepMiss === 0, 'H/归一化（已知边界）：正反斜杠混用时清不掉，本条用来固化现状，实际返回 ' + r.sepMiss)

  report('清缓存按解释器精确匹配（同解释器多 mtime 全清、兄弟目录不动）；互斥两个方向都拒且理由指明是谁在跑；大小写/斜杠变体清不掉（已记录为边界）')
}

if (section === 'I') {
  // 这一节守的是 issue #10 与 discussion #9 的**原文要求**，不是我的理解。
  const csrc = readFileSync(join(root, 'client.js'), 'utf8')
  const stub = `
    ${sliceFn(src, 'function cudaRowNa(gpu) {')}
    ${sliceFn(csrc, 'function rowBusy(id, clickedId, downloading) {')}
    globalThis.__r = {
      naNoCard: cudaRowNa({ noCard: true }),
      naUnknownNoDll: cudaRowNa({ unknown: true, dllReady: false }),
      naUnknownWithDll: cudaRowNa({ unknown: true, dllReady: true }),
      naHasCard: cudaRowNa({ deviceCount: 1, dllReady: false }),
      naEmpty: cudaRowNa(null),
      busyClicked: rowBusy('asr', 'asr', []),
      busyFromHost: rowBusy('asr', '', ['asr']),
      busyOther: rowBusy('ocr', '', ['asr']),
      busyNoList: rowBusy('cuda', '', undefined),
    }
  `
  const ctx = newCtx({})
  try {
    vm.runInNewContext(stub, ctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱 I 抛了 ' + e.message)
  }
  const r = ctx.__r
  if (!r) broken('没拿到结果 I')

  // issue #10 问题 1 建议 2：没卡 → 「不适用」
  must(r.naNoCard === true, 'I/issue1-建议2：没有显卡时必须判「不适用」，实际 ' + r.naNoCard)
  must(r.naHasCard === false, 'I/issue1-建议3：有卡（deviceCount>0）但库没装好，不许判「不适用」，实际 ' + r.naHasCard)
  must(r.naEmpty === false, 'I：没有 gpu 数据时不该判「不适用」，实际 ' + r.naEmpty)
  // 第三种状态：有库但没法确认显卡 → 也必须走「不适用」，否则只能报「加载失败」
  must(r.naUnknownNoDll === true, 'I：找不找得到 nvidia-smi 都不知道且验不出加载时，应判「不适用」，实际 ' + r.naUnknownNoDll)
  must(r.naUnknownWithDll === false, 'I：验出加载能力就该给绿，不该判「不适用」，实际 ' + r.naUnknownWithDll)

  // issue #10 问题 3 建议 1：面板把按钮置灰
  must(r.busyClicked === true, 'I/issue3-建议1：刚点的行应禁用，实际 ' + r.busyClicked)
  must(r.busyFromHost === true, 'I/issue3-建议1：宿主说该目标正在下载时也应禁用（面板原来不知道），实际 ' + r.busyFromHost)
  must(r.busyOther === false, 'I/issue3-建议1：别的行不该被牵连禁用，实际 ' + r.busyOther)
  must(r.busyNoList === false, 'I：宿主没给 downloading 列表时不该禁用，实际 ' + r.busyNoList)

  // 契约：/status 必须真的把这张表发出去，否则上面那条判据守的是死代码
  // 0.4.8 C4a：活性表由 Set 改成 Map<target,{at,pid}>，取 .keys() 才仍是「只列目标名的字符串数组」。
  // 断言仍是「/status 把活性表以 downloading 字段发出去」，只跟着改接线字面；形状由 C177 真跑守。
  must(/downloading:\s*Array\.from\(DOWNLOADING\.keys\(\)\)/.test(src), 'I/契约：/status 没把 DOWNLOADING 以 downloading 字段发出去')

  report('issue #10 三条建议逐条对上：没卡→不适用（有卡时不许）、无法确认→不适用且不报加载失败、下载中→面板禁用对应行')
}

// 未知节名必须显式失败：上面每一节都是 if(...)，拼错名字会什么都不跑、静默 exit 0，
//   而 verify 只读退出码 —— 那就成了一条永远绿的判据。
if (!['E', 'F', 'G', 'H', 'I'].includes(section)) {
  broken('未知节名「' + section + '」（可选 E/F/G/H/I）')
}
