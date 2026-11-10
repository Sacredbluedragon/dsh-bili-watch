/**
 * C222 / `node look.mjs doctor`：六项环境自检的**只读**判据。
 *
 * 设计约束：
 *   · 不联网：只跑本地二进制的 -version / --version，不请求任何 API；
 *   · 不改文件：全程 existsSync / accessSync / statSync / statfsSync / readCred，没有一次写入；
 *   · 不写缓存：不调 initCachePath()，缓存根只用 previewCacheDir() 纯算路径；
 *     入口把 doctor 留在 CACHE_COMMANDS 之外，退出钩子也就不会落 runs.jsonl。
 *
 * 为什么二进制探测要由入口注入 probe(bin, args)：
 *   lib 本身不自带子进程执行器（那是 lib/exec.mjs 搬家后的职责，见 C227）。
 *   注入还有第二个用处——判据可以对每一项单独把 probe 打坏，验「这一项真的在探测」，
 *   而不是拿一张硬编码的 ✓ 表骗人。probe 必须同步返回布尔，抛异常按「跑不通」处理。
 *
 * 路径一律不进 detail：自检输出会被贴进工单/日志，本机绝对路径不该跟着出门。
 * 每项 fix 只给一条能直接复制的命令；POSIX 与 Windows 分叉写在 detail 里。
 */
import { accessSync, constants, existsSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { resolveDepsDir, depsLockFile, DEPS_LOCK_STALE_MS } from './plugin-paths.mjs'
import { credPaths, readCred } from './cred.mjs'
import { previewCacheDir } from './cache-path.mjs'
import { inspectModelHomes, MODEL_MIN_BYTES } from './model-integrity.mjs'

export const DOCTOR_IDS = ['ffmpeg', 'ffprobe', 'asr', 'credential', 'cache', 'deps']

const FIX = {
  ffmpeg: 'node scripts/fetch-deps.mjs ffmpeg',
  ffprobe: 'node scripts/fetch-deps.mjs ffmpeg',
  asr: 'node scripts/fetch-deps.mjs asr',
  credential: 'node look.mjs login',
  cache: 'BILI_WATCH_CACHE=<可写目录> node look.mjs doctor',
  deps: 'node scripts/fetch-deps.mjs lockcheck',
}
const MODEL_FIX = 'node scripts/fetch-deps.mjs model --force'

const item = (id, ok, detail, fix = FIX[id]) => ({ id, ok: Boolean(ok), detail: String(detail), fix: String(fix) })

/** 按候选顺序试 -version，第一个跑通的就是这次会用的那份。probe 抛异常 = 这份不可用。 */
function probeFirst(cands, probe) {
  for (const c of cands) {
    if (!c || typeof c !== 'string') continue
    try { if (probe(c, ['-version'])) return c } catch { /* 换下一个候选 */ }
  }
  return ''
}

function firstExisting(cands) {
  return cands.find((p) => p && existsSync(p)) || ''
}

/** 与 index.js 的 credState() 同一口径：updatedAt 优先，其次文件 mtime；超过 30 天算过期。 */
function ageDaysOf(path, value) {
  const t = value?.updatedAt || statSync(path).mtime.toISOString()
  const ms = new Date(t).getTime()
  return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 86400000)) : null
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`

/**
 * @param {{env?: object, pluginRoot?: string, home?: string, cfg?: object, probe: (bin:string,args:string[])=>boolean}} ctx
 * @returns {{ok: boolean, items: Array<{id:string,ok:boolean,detail:string,fix:string}>, available: number, total: number}}
 */
export function doctorReport(ctx = {}) {
  const env = ctx.env || process.env
  const probe = ctx.probe
  if (typeof probe !== 'function') throw new Error('doctorReport 需要 probe(bin, args)：lib 不自带执行器')
  const pluginRoot = ctx.pluginRoot || process.cwd()
  const home = ctx.home || homedir()
  const cfg = ctx.cfg || {}
  const now = Number(ctx.now) || Date.now()

  // 三个路径入口全用「纯算、不建目录」的形态；resolveDepsDir 的 mkdirPref 默认 false。
  const deps = resolveDepsDir({ pluginRoot, env, home })
  const proj = env.BILI_WATCH_PROJ || cfg.proj || deps
  const items = []

  // ① ffmpeg：候选顺序与运行时 findFfmpeg(FFMPEG_CAND) 同源 —— 环境变量 → deps-config.json → PATH。
  //    刻意不额外塞 deps/ffmpeg.exe：那样自检会报「可用」，而运行时回落链根本不看它，等于说谎。
  const ffmpegArg = env.BILI_WATCH_FFMPEG || cfg.ffmpeg || ''
  const ffmpegBin = probeFirst([ffmpegArg, 'ffmpeg'], probe)
  const ffmpegFrom = ffmpegBin && ffmpegBin !== 'ffmpeg'
    ? (env.BILI_WATCH_FFMPEG ? 'BILI_WATCH_FFMPEG 指定的那份' : 'deps-config.json 里配置的那份')
    : 'PATH 里的 ffmpeg'
  items.push(item('ffmpeg', Boolean(ffmpegBin), ffmpegBin
    ? `找到可用二进制（${ffmpegFrom}，-version 跑通）`
    : '找不到可用 ffmpeg：环境变量 / deps-config.json / PATH 三个候选都没跑通 -version'))

  // ② ffprobe：显式 BILI_WATCH_FFPROBE 只认这一份（不回落 —— 用户点名的那份跑不通，
  //    拿别处的 ffprobe 报 ✓ 等于把配置错误藏起来）；没指定才按兄弟 / deps / PATH 找。
  const exeExt = ffmpegBin && basename(ffmpegBin).toLowerCase().endsWith('.exe') ? '.exe' : ''
  const sibling = ffmpegBin && ffmpegBin !== 'ffmpeg' ? join(dirname(ffmpegBin), 'ffprobe' + exeExt) : ''
  const explicitProbe = env.BILI_WATCH_FFPROBE || ''
  const ffprobeBin = explicitProbe
    ? probeFirst([explicitProbe], probe)
    : probeFirst([sibling, join(deps, 'ffprobe.exe'), join(deps, 'ffprobe'), 'ffprobe'], probe)
  items.push(item('ffprobe', Boolean(ffprobeBin), ffprobeBin
    ? '找到可用二进制（ffprobe -version 跑通）'
    : explicitProbe
      ? 'BILI_WATCH_FFPROBE 指定的那份跑不通 -version（显式指定不回落到别处）'
      : '找不到可用 ffprobe：ffmpeg 同目录 / deps / PATH 都没跑通 -version'))

  // ③ ASR：python 解释器能跑 + _bili-asr.py 在 + 模型完整且体积达标，三件缺一即 ✗。
  //    平台差异不靠运行时平台常量猜，两种目录形态都探，取第一个存在的。
  const asrPy = firstExisting([
    join(deps, '.venv-asr', 'Scripts', 'python.exe'), join(deps, '.venv-asr', 'bin', 'python'),
    join(proj, '.venv-asr', 'Scripts', 'python.exe'), join(proj, '.venv-asr', 'bin', 'python'),
  ])
  const asrScript = firstExisting([join(deps, '_bili-asr.py'), join(proj, '_bili-asr.py')])
  let pyOk = false
  if (asrPy) { try { pyOk = Boolean(probe(asrPy, ['--version'])) } catch { pyOk = false } }
  const model = inspectModelHomes([join(deps, '.hf-home'), join(proj, '.hf-home')])
  const modelOk = model.state === 'complete' && model.bytes >= MODEL_MIN_BYTES
  const asrOk = pyOk && Boolean(asrScript) && modelOk
  const asrDetail = [
    `python ${pyOk ? '能跑' : '跑不起来或没装'}`,
    `_bili-asr.py ${asrScript ? '在' : '不在'}`,
    `模型 ${model.state === 'complete' ? `${mb(model.bytes)} ≥ ${mb(MODEL_MIN_BYTES)} 下限` : `不完整（${model.state}${model.reason ? '：' + model.reason : ''}）`}`,
  ].join(' / ')
  // 模型缺件与开发环境缺件是两种修法，按最具体的那一件给 fix。
  items.push(item('asr', asrOk, asrDetail,
    asrScript && pyOk && !modelOk ? MODEL_FIX : FIX.asr))

  // ④ B 站凭证：credPaths() 实际返回 shared / legacy 两处（不是三处，按真实接口核），
  //    第三处是环境直给 SESSDATA —— 只作展示，不参与判定（运行时不读它，不能算「已登录」）。
  //    四字段清单与 30 天口径都取自 lib/cred.mjs 与 index.js 的 credState()。
  const cp = credPaths(deps)
  let credOk = false
  let credAge = null
  const credNotes = []
  for (const [label, path] of [['shared', cp.shared], ['legacy', cp.legacy]]) {
    const r = readCred(path)
    if (!r.ok) { credNotes.push(`${label}=${r.why}`); continue }
    let age = null
    try { age = ageDaysOf(path, r.value) } catch { age = null }
    credNotes.push(`${label}=四字段齐${age == null ? '' : `（${age} 天）`}`)
    // 两处任一「齐字段且没过 30 天」就算有效：shared 过期但 legacy 新是可能的，
    // 写成「按第一处定生死」会把一份能用的凭证判死。
    if (age == null || age <= 30) credOk = true
    if (credAge == null || (age != null && age < credAge)) credAge = age
  }
  if (env.SESSDATA) credNotes.push('env.SESSDATA=已设（仅提示，运行时不读）')
  items.push(item('credential', credOk,
    credOk ? `凭证有效：${credNotes.join(' / ')}` : `凭证不可用或已过 30 天：${credNotes.join(' / ')}`))

  // ⑤ 缓存目录：不建、不写探针。目录不存在 ≠ 可用（要说清「doctor 不创建」）。
  const cache = previewCacheDir(env.BILI_WATCH_CACHE || cfg.cache || '')
  const cacheExists = existsSync(cache)
  let writable = false
  let freeBytes = null
  if (cacheExists) {
    try { accessSync(cache, constants.W_OK); writable = true } catch { /* 只读或权限不足 */ }
    try { const s = statfsSync(cache); freeBytes = s.bavail * s.bsize } catch { freeBytes = null }
  }
  const freeText = freeBytes == null ? '剩余空间读不出来' : `剩余 ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
  items.push(item('cache', cacheExists && writable,
    !cacheExists ? `目录尚不存在（doctor 不创建）：${freeText}` : `${writable ? '可写' : '不可写'}，${freeText}；Windows PowerShell 用 $env:BILI_WATCH_CACHE="<可写目录>"`))

  // ⑥ deps：落点由 resolveDepsDir() 同步决定（同一份判据，不另抄一份）；
  //    .fetch-deps.lock 只有「过期的残留」才算故障，正在下载的活锁不算。
  const lock = depsLockFile({ env, home })
  let staleLock = false
  if (existsSync(lock)) {
    try {
      const j = JSON.parse(readFileSync(lock, 'utf8'))
      const startedAt = Number(j.startedAt) || statSync(lock).mtimeMs
      staleLock = now - startedAt > DEPS_LOCK_STALE_MS
    } catch { staleLock = true }
  }
  const depsOk = existsSync(deps) && !staleLock
  items.push(item('deps', depsOk,
    `${existsSync(deps) ? 'deps 目录在' : 'deps 目录不存在'}；${existsSync(lock) ? (staleLock ? '有过期的 .fetch-deps.lock 残留' : '有正在下载的活锁（不算故障）') : '无 .fetch-deps.lock'}`))

  const available = items.filter((i) => i.ok).length
  return { ok: available === items.length, available, total: items.length, items }
}

/** 人读输出：每项一行结论 + 一行修复命令，最后给合计。纯函数，判据可以直接比。 */
export function doctorProse(report) {
  const lines = []
  for (const it of report.items) {
    lines.push(`${it.ok ? '✓' : '✗'} ${it.id}：${it.detail}`)
    lines.push(`    修复：${it.fix}`)
  }
  lines.push(`合计 ${report.available}/${report.total} 项可用（doctor 不联网 / 不改文件 / 不写缓存）`)
  return lines
}
