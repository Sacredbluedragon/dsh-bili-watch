// 依赖安装四个 bug 的判据探针（issue #10 / discussion #9，2026-11-03）。
//
// 用法：node tools/fixtures/deps-guards-probe.mjs <A|B|C|D>
//   退出码 0 = PASS；1 = 红；2 = 探针自身失效（切不出函数体，别静默当 PASS）
//
// 每一节都把**原样函数体抠出来真跑**，桩住外部命令，不看源码文本。
// 节名与派单的 A/B/C/D 一一对应：
//   A  probeGpu：无卡（nvidia-smi ENOENT）时必须早退。
//      判据之一是「python 侧探针一次都没被调用」——不是看 note 里有没有某个词。
//      改坏方式：删掉那段 early return、改回 notes.push('没有 nvidia-smi…')，本节必红。
//   B  pyProbe 的失败缓存 TTL + downloadVerdict 文案。
//      改坏方式：TTL 合回一条 IMPORT_TTL_MS，或把「宿主被关掉」写回文案，本节必红。
//   C  downloadConflict / runDownload 互斥 + 跨进程锁 lockState + 改名撞 EPERM 必须放弃。
//      改坏方式：删掉 runDownload 里的 downloadConflict 判断、或让 lockState 恒 free、
//      或把 moveSemiVenv 的 throw 改回只打印，本节必红。
//   D  newVenv：--python 指定的解释器必须真的拿去做 `-m venv`。
//      改坏方式：把 `plan.exe ||` 删掉，本节必红（桩的 systemPython 返回 PATH_STUB）。
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
/** 切「行首 } 收尾」的函数体。切不出来就 PROBE-BROKEN，不退化成 PASS。 */
function sliceFn(src, sig) {
  // 换行统一成 LF 再切：Windows 编辑器 / Python 文本模式会写 CRLF，
  //   「\n}\n」这种切法在 CRLF 上会切空，若当成「函数不存在」就变成假红。
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
  const ctx = {
    process,
    // C227-B：index.js 的平台判定改成 lib/platform.mjs 的别名后，切出来的函数体
    //   在 vm 里少了一个自由变量。补的是真值（不是恒 true 的假桩），平台分支照常可测。
    isWin: () => process.platform === 'win32',
    isMac: () => process.platform === 'darwin',
    hostPlatform: () => process.platform,
    console,
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    ...extra,
  }
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

if (section === 'A') {
  const src = readFileSync(join(root, 'index.js'), 'utf8')
  const body = sliceFn(src, 'async function probeGpu() {')
  // 2026-11-03 自审：probeGpu 现在先走 probeNvidiaSmi()（多路径候选），这两个函数也要抠进沙箱，
  //   否则沙箱里 ReferenceError → 脚本崩（rc 非 0），看着像「抓到 bug」其实一条断言都没跑。
  const cands = sliceFn(src, 'function nvidiaSmiCands() {')
  const smiFn = sliceFn(src, 'async function probeNvidiaSmi() {')
  const stub = `
    globalThis.__pyCalls = 0
    const execFileP = async (cmd) => {
      if (cmd === 'nvidia-smi' || /nvidia-smi/.test(cmd)) return { ok: false, stdout: '', err: { code: 'ENOENT' } }
      globalThis.__pyCalls++
      return { ok: true, stdout: '', stderr: '' }
    }
    const existsSync = () => true
    const venvAsr = () => ['/stub/venv/python.exe']
    const join = (...a) => a.join('/')
    const DEPS = '/stub/deps'
    const GPU_PROBE_TIMEOUT_MS = 1000
    const probeWhy = () => 'stub'
    const cudaLibsBytes = () => 0
    ${cands}
    ${smiFn}
    ${body}
    globalThis.__ret = probeGpu()
  `
  const ctx = newCtx({})
  try {
    vm.runInNewContext(stub, ctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱抛了 ' + e.message)
  }
  const ret = await ctx.__ret
  if (!ret || !ret.val) broken('probeGpu 没返回 { val }')
  must(ret.val.noCard === true, 'noCard 应为 true，实际 ' + JSON.stringify(ret.val.noCard))
  must(ret.confident === true, 'ENOENT 是确定结论，confident 应为 true，实际 ' + JSON.stringify(ret.confident))
  must(!/加载失败/.test(String(ret.val.note || '')), 'note 里还带着「加载失败」：' + ret.val.note)
  must(!/nvidia 包/.test(String(ret.val.note || '')), 'note 里还带着 nvidia 包探测结论：' + ret.val.note)
  must(!/ASR 环境还没装/.test(String(ret.val.note || '')), 'note 里还带着「装完 ASR 才能判断」那句：' + ret.val.note)
  must(ctx.__pyCalls === 0, '无卡时不该再探 python 侧（find_spec / --probe-gpu），实际调用了 ' + ctx.__pyCalls + ' 次')

  // 面板侧：na 行不给下载按钮、也不计入「缺 N 个依赖」（issue #10 建议 2）
  const csrc = readFileSync(join(root, 'client.js'), 'utf8')
  const cStub = `
    ${sliceFn(csrc, 'function canDownloadRow(d) {')}
    ${sliceFn(csrc, 'function missingDeps(deps) {')}
    globalThis.__c = {
      naBtn: canDownloadRow({ id: 'cuda', ok: false, na: true, installable: true }),
      naMissing: missingDeps([{ id: 'cuda', ok: false, na: true }]).length,
      normalBtn: canDownloadRow({ id: 'asr', ok: false, installable: true }),
      normalMissing: missingDeps([{ id: 'asr', ok: false }]).length,
    }
  `
  const cctx = newCtx({})
  try {
    vm.runInNewContext(cStub, cctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱（client）抛了 ' + e.message)
  }
  const c = cctx.__c
  must(c.naBtn === false, 'na 行仍给了下载按钮')
  must(c.naMissing === 0, 'na 行仍被计入「缺 N 个依赖」')
  must(c.normalBtn === true, '正常的缺依赖行不该被 na 判断误伤（按钮没了）')
  must(c.normalMissing === 1, '正常的缺依赖行不该被 na 判断误伤（计数没了）')
  // 2026-11-03 自审第二轮：na 的判定被抽成 cudaRowNa（要能同时覆盖「没卡」和「不知道有没有卡」），
  //   这里改成守「接线」——语义由 deps-review-probe 的 I 节逐条跑；这条只保证没人把它绕开。
  must(/na:\s*cudaRowNa\(gpu\)/.test(src.replace(/\r\n/g, '\n')), 'index.js 的 cuda 行没把 na 交给 cudaRowNa（判定逻辑被绕开）')
  // 自审补的一条：早退会让 cudaLibs 恒 false，无卡机器上那行就失去「删除」按钮，
  //   已装的 1.4 GB 运行库清不掉。判据只能落在源码这一行（depRows 是 async 且要真查文件系统，
  //   抠不出来单独跑），所以这里明说是文本判据，不再假装是行为判据。
  must(
    /removable:\s*gpu\.cudaLibs \|\| cudaSize > 0/.test(src.replace(/\r\n/g, '\n')),
    'cuda 行的 removable 只看 cudaLibs：无卡早退后「删除」按钮会消失，已装的运行库清不掉',
  )

  report('无卡早退（python 侧 0 次调用），note 只有一句「本机无 NVIDIA 显卡，ASR 走 CPU」；面板 na 行不给按钮、不计缺失')
}

if (section === 'B') {
  const src = readFileSync(join(root, 'index.js'), 'utf8').replace(/\r\n/g, '\n')
  const ttlConst = (src.match(/const IMPORT_TTL_MS = [^\n]+/) || [''])[0]
  const failConst = (src.match(/const IMPORT_TTL_FAIL_MS = [^\n]+/) || [''])[0]
  if (!ttlConst || !failConst) broken('找不到 IMPORT_TTL_MS / IMPORT_TTL_FAIL_MS 常量')
  // 2026-11-03 自审：签名加了 opts（手点刷新跳缓存），这里跟着改。
  //   注意 opts 必须给默认值 {}，否则桩里 pyProbe(py, code) 的旧调用会 TypeError。
  // 2026-11-06 面板首屏：pyProbe 改走 execFileP / async，沙箱里的桩与调用都要跟着 async，
  //   否则拿到的全是 Promise、B 段会「全绿但其实一条断言没跑到」。签名跟着源码同源改。
  const pyProbe = sliceFn(src, 'async function pyProbe(py, code, opts = {}) {')
  const mapSrc = /const DOWNLOAD_TARGET_DEPS = \{[\s\S]*?\n\}\n/.exec(src)
  if (!mapSrc) broken('找不到 DOWNLOAD_TARGET_DEPS')
  // issue #12（2026-11-05）：downloadVerdict 多了第 5 个 ctx 形参。这里不再把整条签名
  //   抄进探针（抄死就会在下次加参数时变成「探针自身失效」的假红，C144 已经红过一次），
  //   改成从源码取真实签名再交给 sliceFn，检查面与被检查面同源。
  const verdictSig = /function downloadVerdict\([^)]*\)\s*\{/.exec(src)?.[0]
  if (!verdictSig) broken('找不到 downloadVerdict 定义')
  const verdict = sliceFn(src, verdictSig)

  const stub = `
    ${ttlConst}
    ${failConst}
    globalThis.__now = 1700000000000
    Date.now = () => globalThis.__now
    let importCache = {}
    globalThis.__runs = 0
    globalThis.__mode = 'fail'
    const statSync = () => ({ mtimeMs: 111 })
    const execFileP = async () => {
      globalThis.__runs++
      if (globalThis.__mode === 'fail') {
        const e = new Error('boom'); e.stderr = 'ImportError: no module'
        return { ok: false, stdout: '', err: e }
      }
      return { ok: true, stdout: '', err: null }
    }
    const probeWhy = () => 'stub'
    ${pyProbe}
    ${mapSrc[0]}
    ${verdict}
    globalThis.__go = async () => {
      const a = await pyProbe('/stub/py.exe', 'import x')
      globalThis.__now += 60000
      const b = await pyProbe('/stub/py.exe', 'import x')
      const runsAfterFail = globalThis.__runs
      globalThis.__mode = 'ok'
      const c = await pyProbe('/stub/py.exe', 'import y')
      globalThis.__now += 60000
      await pyProbe('/stub/py.exe', 'import y')
      const runsTotal = globalThis.__runs
      const v = downloadVerdict('ocr', 0, null, [{ id: 'ocr', ok: false }])
      const vOk = downloadVerdict('ocr', 0, null, [{ id: 'ocr', ok: true }])
      return { a, b, c, runsAfterFail, runsTotal, v, vOk }
    }
  `
  const ctx = newCtx({})
  try {
    vm.runInNewContext(stub, ctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱抛了 ' + e.message)
  }
  const r = await ctx.__go()
  if (!r) broken('没拿到结果')
  must(r.a && r.a.ok === false, '第一次探针应失败')
  must(r.runsAfterFail === 2, '失败结果 60 秒后必须重探（应跑 2 次），实际 ' + r.runsAfterFail + ' 次 —— 失败缓存 TTL 没缩短')
  must(r.c && r.c.ok === true, '第三次应成功')
  must(r.runsTotal === 3, '成功的探针 60 秒内应命中缓存（总跑 3 次），实际 ' + r.runsTotal + ' 次')
  must(r.v && r.v.ok === false, '产物没就绪却判成功')
  must(/仍不可用/.test(String(r.v.note)), '失败文案没说「仍不可用」：' + (r.v && r.v.note))
  must(!/宿主被关掉/.test(String(r.v.note)), '失败文案又把原因写死成「宿主被关掉」：' + (r.v && r.v.note))
  must(r.vOk && r.vOk.ok === true, '产物就绪却判失败：' + (r.vOk && r.vOk.note))
  report('失败缓存 30 秒过期、成功 5 分钟命中；失败文案不写死原因')
}

if (section === 'C') {
  const src = readFileSync(join(root, 'index.js'), 'utf8').replace(/\r\n/g, '\n')
  const fd = readFileSync(join(root, 'scripts', 'fetch-deps.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const decl = 'const DOWNLOADING = new Map()'
  const conflict = sliceFn(src, 'function downloadConflict(target, running) {')
  const runDownload = sliceFn(src, 'function runDownload(target) {')
  const lockFn = sliceFn(fd, 'function lockState(cur, opts = {}) {')
  const lockConst = (fd.match(/const LOCK_STALE_MS = [^\n]+/) || [''])[0]
  if (!lockConst) broken('找不到 LOCK_STALE_MS 常量')
  // C48-P2-1：6 小时常量抽到 lib/plugin-paths.mjs 单点，沙箱② 里要先把那行定义贴上，
  //   否则 `LOCK_STALE_MS = DEPS_LOCK_STALE_MS` 在 VM 里会 ReferenceError（那是探针坏，不是被测代码红）。
  const pp = readFileSync(join(root, 'lib', 'plugin-paths.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const staleDecl = (pp.match(/export const DEPS_LOCK_STALE_MS = [^\n]+/) || [''])[0].replace(/^export /, '')
  if (!staleDecl) broken('lib/plugin-paths.mjs 里找不到 DEPS_LOCK_STALE_MS 单点常量')
  const moveSemi = sliceFn(fd, 'function moveSemiVenv(venv) {')

  // ① 进程内互斥：连点两次
  const stub1 = `
    ${decl}
    ${conflict}
    const SCRIPTS = '/stub/scripts'
    const DEPS = '/stub/deps'
    const DOWNLOAD_LOG = '/stub/download.log'
    const join = (...a) => a.join('/')
    const existsSync = () => true
    const appendFileSync = () => {}
    const openSync = () => 3
    const closeSync = () => {}
    // 0.4.8 C4b 加的跨进程锁同步预检：本节只验进程内互斥，桩成「没人占锁」。
    const DEPS_LOCK_FILE = '/stub/.fetch-deps.lock'
    const downloadLockBusy = () => null
    const lockBusyText = () => ''
    const readFileSync = () => ({ subarray: () => ({ toString: () => '' }) })
    // C227-B：runDownload 现在调 runSpawn 这个别名，桩跟着改名。
    const runSpawn = () => ({ pid: 4242, on() {}, once() {}, unref() {} })
    ${runDownload}
    globalThis.__r = (() => {
      const a = runDownload('asr')
      const b = runDownload('asr')
      const c = runDownload('ocr')
      const d = runDownload('all')
      return { a, b, c, d }
    })()
  `
  const ctx1 = newCtx({})
  try {
    vm.runInNewContext(stub1, ctx1, { timeout: 5000 })
  } catch (e) {
    broken('沙箱① 抛了 ' + e.message)
  }
  const r1 = ctx1.__r
  if (!r1) broken('没拿到结果①')
  must(r1.a && r1.a.started === true, '第一次下载应放行，实际 ' + JSON.stringify(r1.a))
  must(r1.b && r1.b.started === false, '连点第二次必须被拒，实际 ' + JSON.stringify(r1.b))
  must(/正在下载中/.test(String(r1.b && r1.b.why)), '第二次拒绝理由没说「正在下载中」：' + (r1.b && r1.b.why))
  // 2026-11-04 发前审核 P1-1：口径反转。原来允许不同目标并发，但 .download-part.json
  // 是单文件单槽位，任一路结束 rmSync 整个文件，另一路进度静默消失；两个大文件还抢带宽。
  // 现在后端全局互斥，这里必须跟着改成「也被拒」。放行场景由 C160 的空 running 用例守（单项与 all 各一条）。
  must(r1.c && r1.c.started === false, '不同目标（ocr）也必须被 asr 挡住（全局互斥），实际 ' + JSON.stringify(r1.c))
  must(r1.d && r1.d.started === false, 'asr 在跑时 all 必须被拒，实际 ' + JSON.stringify(r1.d))

  // ② 跨进程锁的判定（纯函数，注入 now / alive）
  const stub2 = `
    ${staleDecl}
    ${lockConst}
    ${lockFn}
    globalThis.__r = (() => {
      const now = 1700000000000
      const aliveTrue = () => true
      const aliveFalse = () => false
      return {
        none: lockState(null, { now }),
        held: lockState({ pid: 111, startedAt: now - 1000 }, { now, alive: aliveTrue }),
        dead: lockState({ pid: 111, startedAt: now - 1000 }, { now, alive: aliveFalse }),
        old: lockState({ pid: 111, startedAt: now - LOCK_STALE_MS - 1 }, { now, alive: aliveTrue }),
        // 2026-11-03 自审：跑了 61 分钟的下载，pid 还活着，必须仍是 held。
        //   原来的判定是「先看时间再看 pid」，这种长下载会被判成残留锁、被后来者接管。
        longRun: lockState({ pid: 111, startedAt: now - 61 * 60 * 1000 }, { now, alive: aliveTrue }),
        garbage: lockState({ startedAt: now }, { now, alive: aliveTrue }),
      }
    })()
  `
  const ctx2 = newCtx({})
  try {
    vm.runInNewContext(stub2, ctx2, { timeout: 5000 })
  } catch (e) {
    broken('沙箱② 抛了 ' + e.message)
  }
  const r2 = ctx2.__r
  if (!r2) broken('没拿到结果②')
  must(r2.none === 'free', '没有锁时应 free，实际 ' + r2.none)
  must(r2.held === 'held', 'pid 活着且没过期应 held，实际 ' + r2.held)
  must(r2.dead === 'stale', 'pid 不在了应判 stale，实际 ' + r2.dead)
  must(r2.old === 'stale', '超过 6 小时上限应判 stale（兜 pid 复用），实际 ' + r2.old)
  must(r2.longRun === 'held', '跑了 61 分钟但 pid 还活着，必须仍判 held（长下载不能被抢锁），实际 ' + r2.longRun)
  must(r2.garbage === 'free', '锁内容没有 pid 时应 free，实际 ' + r2.garbage)

  // ③ 改名撞 EPERM/EBUSY 必须放弃（抛），其它错误维持原样（只打印）
  const runMove = (code) => {
    const s = `
      const sep = '/'
      const dirname = (p) => p.split('/').slice(0, -1).join('/')
      const join = (...a) => a.join('/')
      const existsSync = () => true
      const readdirSync = () => []
      const rmSync = () => {}
      const dirSize = () => 0
      const console2 = { log: () => {} }
      const renameSync = () => { const e = new Error('rename fail'); e.code = ${JSON.stringify(code)}; throw e }
      ${moveSemi.replace(/\bconsole\b/g, 'console2')}
      let out = 'returned'
      try {
        moveSemiVenv('/stub/deps/.venv-asr')
      } catch (e) {
        out = 'threw:' + e.message
      }
      globalThis.__out = out
    `
    const c = newCtx({})
    try {
      vm.runInNewContext(s, c, { timeout: 5000 })
    } catch (e) {
      broken('沙箱③(' + code + ') 抛了 ' + e.message)
    }
    return c.__out
  }
  const eperm = runMove('EPERM')
  const ebusy = runMove('EBUSY')
  const eacces = runMove('EACCES')
  must(/^threw:/.test(eperm), 'EPERM 时应抛（放弃安装），实际 ' + eperm)
  must(/^threw:/.test(ebusy), 'EBUSY 时应抛（放弃安装），实际 ' + ebusy)
  must(eacces === 'returned', '非 EPERM/EBUSY 不该抛，实际 ' + eacces)

  // ④ 接线：runDownload 真的用了互斥；脚本真的在非 dry-run 时抢锁、并挂了释放
  must(/downloadConflict\(target, DOWNLOADING\)/.test(src), 'runDownload 里没调用 downloadConflict')
  must(/if \(!DRY\) acquireLock\(\)/.test(fd), '脚本没在非 dry-run 时 acquireLock()')
  must(/process\.on\('exit', releaseLock\)/.test(fd), '抢到锁之后没挂 releaseLock')

  report('同目标连点被拒、all 与单项互斥；锁 held/stale/free 三态正确；改名撞 EPERM/EBUSY 直接放弃')
}

if (section === 'D') {
  const src = readFileSync(join(root, 'scripts', 'fetch-deps.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const body = sliceFn(src, 'function newVenv(venv) {')
  const PLAN_EXE = 'D:/RealPython/python.exe'
  const stub = `
    const calls = []
    const VENV = '/stub/venv'
    const pyPlan = () => ({ mode: 'python', version: '3.12', uv: '', exe: ${JSON.stringify(PLAN_EXE)}, desc: 'stub' })
    const run = (cmd, args) => { calls.push([cmd, args]); return { code: 0, out: '' } }
    const existsSync = () => true
    const venvPy = (v) => v + '/Scripts/python.exe'
    const log = () => {}
    const moveSemiVenv = () => {}
    const rmSync = () => {}
    const bootstrapPip = () => true
    const systemPython = () => 'PATH_STUB'
    ${body}
    globalThis.__r = (() => {
      try {
        const py = newVenv(VENV)
        const venvCall = calls.find((c) => c[1] && c[1][0] === '-m' && c[1][1] === 'venv')
        return { py, venvCall, calls }
      } catch (e) {
        return { threw: String(e && e.message) }
      }
    })()
  `
  const ctx = newCtx({})
  try {
    vm.runInNewContext(stub, ctx, { timeout: 5000 })
  } catch (e) {
    broken('沙箱抛了 ' + e.message)
  }
  const r = ctx.__r
  if (!r) broken('没拿到结果')
  if (r.threw) {
    console.log('FAIL: newVenv 抛了 —— ' + r.threw)
    process.exit(1)
  }
  must(r.venvCall, 'newVenv 没调 `-m venv`（calls=' + JSON.stringify(r.calls) + '）')
  must(r.venvCall && r.venvCall[0] === PLAN_EXE, '`-m venv` 用的解释器应是 --python 指定的 ' + PLAN_EXE + '，实际 ' + (r.venvCall && r.venvCall[0]))
  report('--python 指定的解释器被真的用于建 venv')
}

broken('未知的节名：' + (section || '(空)'))
