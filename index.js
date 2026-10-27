/**
 * dsh-bili-watch —— B 站「看内容」的命令与工具入口。
 *
 * 为什么单独做插件：看视频的动作是固定的（取字幕 / 转写 / 抽帧 OCR），
 * 让人敲 /bili 少花推理 token；同时注册一个 bili_watch 工具，模型自己也能调，
 * 不会因为「只做了命令」而变成没人调度。
 *
 * 两侧执行同一份 lookup：spawn 插件自带的只读工具
 *   <插件目录>\tools\look.mjs
 * 只读、匿名，不改任何业务状态。
 */
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// @deepseek-ai/dsh-tools 是可选 peer：桌面版 autoInstallPeers:false，市场安装时不会自动装上。
// 缺了只少一个 bili_watch 工具，/bili 命令、插件面板与路由照常工作，不能因此整块加载失败。
// 工具输出上限：超了就把全文落文件、只回摘要。
// 由来：2026-10-26 一段 14 分钟视频的字幕 4,449 字整段塞进上下文，把会话挤爆两次。
const TOOL_TEXT_CAP = 2000
const TOOL_TEXT_HEAD = 800

// ── 进程级路由守卫（T41-P0-1）：fiber 重放/多实例下同一路径只注册一次 ──
// 参照 dsh-memory-evolve/lib/route-guard.js（MIT）：claim 成功才注册；
// effect dispose 时 release，否则重放后新回调跳过注册、路由永久 404。
const ROUTE_PATHS = new Set()
function claimRoute(path) {
  if (ROUTE_PATHS.has(path)) return false
  ROUTE_PATHS.add(path)
  return true
}
function releaseRoute(path) {
  ROUTE_PATHS.delete(path)
}

function cleanKey(s) {
  // 只留字母数字与 _ . -；挡掉 .. / . / Windows 保留设备名，避免输入直接决定磁盘路径
  const k = String(s || '').replace(/[^\w.-]/g, '').replace(/^\.+$/, '').slice(0, 40)
  if (!k || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(k)) return '_misc'
  return k
}

/** 按视频分目录：CACHE/<BV>/<cmd>.txt —— 同一个视频各命令的输出收在一处 */
function videoDir(key) {
  // T34-P0-1：模型可能把整条链接当 key 传进来，先取 BV 再建目录，别在缓存根下建乱码目录
  const bvHit = /(BV[0-9A-Za-z]{10})/.exec(String(key || ''))
  const base = cleanKey(bvHit ? bvHit[1] : key)
  mkdirSync(CACHE, { recursive: true })
  // 同一个 BV 已经有目录（可能被 CLI 改成「BV_标题」）就用它，别建第二个兄弟目录（2026-10-26 审查 T01/T02）
  try {
    for (const d of readdirSync(CACHE)) {
      if (d === base || d.startsWith(base + '_')) return join(CACHE, d)
    }
  } catch {}
  const d = join(CACHE, base)
  mkdirSync(d, { recursive: true })
  return d
}

/** N05-B4（2026-10-27 加）：按码点截断。emoji 是代理对，`slice(0, n)` 会从中间切开，
 *  回显末位变成 U+FFFD（`�`）；落盘文件是完整的，只有给模型的这段被切坏。 */
function cutCp(s, n) {
  const str = String(s ?? '')
  if (str.length <= n) return str
  const a = Array.from(str)
  return a.length <= n ? str : a.slice(0, n).join('')
}

/** 长文本 → 落盘 + 摘要；短文本原样返回（不论长短都先落一份到缓存）。
 *  B11：jsonMode（或内容以 {/[ 起头）时，超长不再 slice 硬切——半截 JSON 既不能 JSON.parse，
 *  也会被模型误读成坏 JSON。直接告诉模型「全文已整体落盘，去 read 那个文件」。 */
function trimForModel(text, tag = 'out', bv = '', jsonMode = false, opts = {}) {
  const s = String(text ?? '')
  // A8（2026-10-27 批次8）：--full 时工具层不要再把已放大的文本切回 800——
  //   full 走 20000 上限；用户给的 --head N 优先于默认 800；不传 full 仍 ≤2000。
  const full = !!opts.full
  const cap = full ? 20000 : TOOL_TEXT_CAP
  const head = (Number.isFinite(opts.head) && opts.head > 0)
    ? Math.floor(opts.head)
    : (full ? 20000 : TOOL_TEXT_HEAD)
  let f = ''
  try {
    const name = String(tag || 'out').replace(/[^\w.-]/g, '') || 'out'
    f = join(videoDir(bv), `${name}.tool.txt`) // .tool 后缀：别覆盖 CLI 落的同名全文
    writeFileSync(f, s, 'utf8')
  } catch { f = '' }
  if (!f) return s // 落盘失败：原样返回，不截断（保护是 best-effort，正确性优先）
  if (s.length <= cap) return s
  // 先剥掉 look.mjs 加的 [source: …] 标签再判：它本身以 [ 开头，会被误判成 JSON 数组（2026-10-26 回归）
  const bare = s.replace(/^\[source:[^\]]*\]\s*/, '')
  const looksJson = jsonMode || /^\s*[{[]/.test(bare)
  if (looksJson) {
    // B11：JSON 类输出超长整体落盘、不回半截（半截 JSON 不能 JSON.parse）
    return `（全文 ${s.length} 字，超限，JSON 已整体落盘；不要按下面内容尝试 JSON.parse，用 read 打开文件看完整结果。已存：${f}）`
  }
  return `${cutCp(s, head)}\n\n…（全文 ${s.length} 字，只回了前 ${head} 字${f ? '；全文已存：' + f : ''}）\n要看完整版：用 read 工具打开上面的文件（别再跑一遍命令）；或换更细的 command 分段取。`
}

let defineTool = null
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  defineTool = null
}
import QRCode from 'qrcode'
import { matchSingleVideoLink, textOfUserMessage } from './auto-trigger.js'
// dsh-llm 同样是可选依赖：拿不到 createUserMessage 就只保留「工具描述」这一层，
// 不能因为少一个提示能力让整个插件加载失败（同上方 defineTool 的处理方式）
let createUserMessage = null
let boundContextSummary = null
try {
  ({ createUserMessage, boundContextSummary } = await import('@deepseek-ai/dsh-llm'))
} catch {
  createUserMessage = null
  boundContextSummary = null
}

const HERE = dirname(fileURLToPath(import.meta.url))
const LOOK = join(HERE, 'tools', 'look.mjs')
const COMMANDS = ['search', 'hot', 'peek', 'view', 'sub', 'comments', 'danmaku', 'asr', 'frames', 'sheet', 'substrip', 'ocr', 'text', 'login', 'clean']
// 斜杠入口认识的 flag（与 tools/look.mjs CLI 对齐；未知 --xxx 给拼写提示而非静默吞）
const KNOWN_FLAGS = ['--step', '--p', '--cred', '--days', '--limit', '--order', '--grid', '--out', '--ffmpeg', '--head', '--full', '--verify', '--format', '--fresh', '--ocr', '--poll', '--check', '--fast', '--scene', '--mark-seen']

// 设置页端点读的落点，与 tools/look.mjs 同源（DEPS / CACHE / pickCacheDir / depsCfg 等常量定义处）
const DEPS = join(HERE, 'deps')
// 本机路径来源：env 优先，其次 deps\deps-config.json（写文件即生效，不必重启），最后 deps 自身。
// 配置文件不进包（deps 只留空目录），发布时无需脱敏。
// 解析失败不写 stdout/stderr（会污染 --format json 与 PowerShell 管道），
// 而是记进 cfgWarning，由 /status 的 warnings 带给面板；ENOENT（没配过）不算异常。
let cfgWarning = null
function depsCfg() {
  try { return JSON.parse(readFileSync(join(DEPS, 'deps-config.json'), 'utf8')) } catch (e) {
    if (e?.code !== 'ENOENT') {
      cfgWarning = `deps-config.json 解析失败，已改用 deps 目录：${String(e?.message || e)}`
    }
    return {}
  }
}
function projDir() { return process.env.BILI_WATCH_PROJ || depsCfg().proj || DEPS }
// 凭证路径（2026-10-27 批次9）：两处写入口——panel 的大号凭证
// $DSH_HOME/bili-duty/bili_credential.json（面板/手工登录写）与 watch 自己的
// $DSH_HOME/bili-watch/credential.json（插件面板扫码写）。两者并存时**谁新用谁**，
// 不再「SHARED 存在即返回」——那样 panel 侧重登大号后 watch 永远读旧快照。
// deps/credential.json 为更旧的 legacy，只在两者都缺时迁移。所有读/写/面板展示都走 resolveCredPath()。
const SHARED_CRED = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-watch', 'credential.json')
const PANEL_CRED = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty', 'bili_credential.json')
const LEGACY_CRED = join(DEPS, 'credential.json')
function resolveCredPath() {
  try {
    // mtime 比较：panel 侧重登大号（更常见）后 PANEL_CRED 更新，watch 立刻跟上；
    // watch 自己扫码登了新号则 SHARED 更新，用 SHARED。同 mtime 时偏好 panel（权威源）。
    const mtimeOf = (p) => { try { return statSync(p).mtimeMs } catch { return 0 } }
    const sharedAt = mtimeOf(SHARED_CRED)
    const panelAt = mtimeOf(PANEL_CRED)
    if (panelAt && panelAt >= sharedAt) return PANEL_CRED
    if (sharedAt) return SHARED_CRED
    if (existsSync(LEGACY_CRED)) {
      try {
        // 2026-10-26 收口（DSH 拍板）：迁移走 loadCred 同一路径——先解析 JSON 并校验必填字段，
        // 残缺该拒就拒（继续用旧路径），不把坏凭证原样搬到新路径。
        const j = JSON.parse(readFileSync(LEGACY_CRED, 'utf8'))
        const missing = ['sessdata', 'bili_jct', 'buvid3', 'buvid4'].filter((k) => !j[k])
        if (missing.length) return LEGACY_CRED
        mkdirSync(dirname(SHARED_CRED), { recursive: true })
        writeFileSync(SHARED_CRED, JSON.stringify(j, null, 2), { encoding: 'utf8', mode: 0o600 })
        return SHARED_CRED  // 2026-10-26 批次5：只在真写成功后才返回新路径
      } catch {
        return LEGACY_CRED  // JSON 解析失败或写 SHARED 抛错：继续用旧凭证，不返回没写成功的新路径
      }
    }
  } catch {}
  return SHARED_CRED
}
const LAST_RUN = join(DEPS, 'last-run.json')
// 缓存位置：env BILI_WATCH_CACHE > deps\deps-config.json 的 cache > $DSH_HOME/bili-watch/cache。发布版不含本机路径。
// 自定义目录不可写时不让功能哑掉：回退到默认路径（$DSH_HOME/bili-watch/cache），并把原因挂进 /status.warnings。
// 缓存根标记：只有我们自己写过这个文件，才认「这个目录已经是缓存根」
const CACHE_MARK = '.bili-watch-root'
const OWN_CACHE_DIRS = new Set(['_logs', 'frames', 'sheets', 'sheet-tmp', 'substrip-tmp', '_misc', 'asr', 'frames-dl', 'audio-dl'])
function hasBvLayout(dir) {
  // 判据一：我们写过的标记（新用户、二次运行都靠它）
  try { if (existsSync(join(dir, CACHE_MARK))) return true } catch {}
  // 判据二（N05-A1，2026-10-27 改）：BV* 目录 **且** 我们必建的工作目录之一，两条同时成立才算。
  //   原来只看 BV*，可目标用户就是 B 站素材库——目录名全以 BV 开头，于是把用户自己的素材库
  //   认成缓存根，removeOwned / autoCleanCache 会成片删掉 original.mp4。
  //   单看 frames/asr 也不行（通用名，别人也会有），所以改成「两者同时成立」。
  //   口径必须与 tools/look.mjs 的同名函数逐字一致，否则面板与 CLI 判据分叉。
  let hasBv = false
  let hasWork = false
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      if (/^BV[0-9A-Za-z]{10}/i.test(e.name)) hasBv = true
      else if (e.name === 'frames' || e.name === 'asr' || e.name === '_logs') hasWork = true
      if (hasBv && hasWork) return true
    }
  } catch {}
  return false
}
function isOwnedEntry(p) {
  const rel = relative(CACHE, p)
  const first = rel.split(/[\\/]/)[0]
  if (/^BV[0-9A-Za-z]{10}/i.test(first)) return true
  if (OWN_CACHE_DIRS.has(first)) return true
  if (/^\.(meta-|write-test-)/.test(first)) return true
  return false
}
function removeOwned(dir) {
  let files = 0
  let bytes = 0
  const skipped = [] // 非本插件条目，不动（不算失败）
  const failed = [] // 本插件条目但真没删掉（只读目录 / 权限）
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return { files, bytes, skipped, failed } }
  for (const e of list) {
    const p = join(dir, e.name)
    if (e.isDirectory() && (/^BV[0-9A-Za-z]{10}/i.test(e.name) || OWN_CACHE_DIRS.has(e.name))) {
      const st = dirStat(p)
      try { rmSync(p, { recursive: true, force: true }); files += st.files; bytes += st.bytes } catch (err) { failed.push({ name: e.name, why: String(err?.message || err) }) }
    } else if (e.isFile() && /^\.(meta-|write-test-)/.test(e.name)) {
      try { const st = statSync(p); rmSync(p, { force: true }); files += 1; bytes += st.size } catch (err) { failed.push({ name: e.name, why: String(err?.message || err) }) }
    } else if (e.isFile() && e.name === CACHE_MARK) {
      // 缓存根标记：静默保留，不进 skip 清单
    } else {
      skipped.push({ name: e.name, why: '不是 bili-watch 的缓存条目，不动' })
    }
  }
  return { files, bytes, skipped, failed }
}
function pickCacheDir() {
  // 缓存下沉：默认根是 bili-watch/cache，凭证在它的上一层（bili-watch/credential.json）
  const defaultDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-watch', 'cache')
  const userWant = process.env.BILI_WATCH_CACHE || depsCfg().cache
  let want = userWant ? userWant : defaultDir
  // 用户指定了外部目录、且它还不是本工具的缓存根时，拼一个专属子目录——
  // 绝不把用户自己的目录直接当缓存根，否则 clean 会在用户目录里找 frames/asr 删
  if (userWant && !hasBvLayout(want)) want = join(userWant, 'bili-watch-cache')
  try {
    mkdirSync(want, { recursive: true })
    // 写缓存根标记（幂等；标记存在就不重写）
    const mark = join(want, CACHE_MARK)
    if (!existsSync(mark)) {
      writeFileSync(mark, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }), 'utf8')
    }
    const probe = join(want, `.write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return { dir: want, fallback: null }
  } catch (e) {
    try { mkdirSync(defaultDir, { recursive: true }) } catch {}
    return { dir: defaultDir, fallback: String(e?.message || e) }
  }
}
// 缓存下沉迁移：把旧根 bili-watch/ 下的 BV* 目录和缓存子目录挪到 bili-watch/cache/
// 凭证、login-qr.png 等根级文件不动；只 rename，不删；幂等；不阻断启动
function migrateLegacyCache() {
  const oldRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-watch')
  const newRoot = join(oldRoot, 'cache')
  if (!existsSync(oldRoot)) return
  let moved = 0, skipped = 0
  try {
    mkdirSync(newRoot, { recursive: true })
    let entries = []
    try { entries = readdirSync(oldRoot, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // 不挪 cache/ 自己
      if (e.name === 'cache') continue
      // 只挪 BV* 目录和 OWN_CACHE_DIRS 里的项
      const isBv = /^BV[0-9A-Za-z]{10}/i.test(e.name)
      const isOwn = OWN_CACHE_DIRS.has(e.name)
      if (!isBv && !isOwn) { skipped++; continue }
      const src = join(oldRoot, e.name)
      const dst = join(newRoot, e.name)
      // 幂等：目标已存在就跳过，不覆盖
      if (existsSync(dst)) { skipped++; continue }
      try {
        renameSync(src, dst)
        moved++
      } catch { skipped++ }
    }
    if (moved > 0 || skipped > 0) {
      try {
        const logDir = join(newRoot, '_logs')
        mkdirSync(logDir, { recursive: true })
        appendFileSync(join(logDir, 'migrate.log'),
          `[${new Date().toISOString()}] [migrate] 已下沉 ${moved} 项到 cache/，跳过 ${skipped} 项（凭证与根级文件不动）\n`, 'utf8')
      } catch {}
      console.error(`[migrate] 已下沉 ${moved} 项到 cache/，跳过 ${skipped} 项（凭证与根级文件不动）`)
    }
  } catch {}
}
migrateLegacyCache()
const cachePick = pickCacheDir()
const CACHE = cachePick.dir
if (cachePick.fallback) cfgWarning = `缓存目录不可写，已回退到 ${maskAbs(CACHE)}：${maskAbs(cachePick.fallback)}`
const PY_DIR = process.platform === 'win32' ? 'Scripts' : 'bin'
const PY_EXE = process.platform === 'win32' ? 'python.exe' : 'python'
function venvAsr() { const p = projDir(); return [join(DEPS, '.venv-asr', PY_DIR, PY_EXE), join(p, '.venv-asr', PY_DIR, PY_EXE)] }
function venvOcr() { const p = projDir(); return [join(DEPS, '.venv-ocr', PY_DIR, PY_EXE), join(p, '.venv-ocr', PY_DIR, PY_EXE)] }
function ffmpegCands() {
  return [
    process.env.BILI_WATCH_FFMPEG,
    depsCfg().ffmpeg,
    join(DEPS, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  ].filter(Boolean)
}
function hfHomes() { const p = projDir(); return [join(DEPS, '.hf-home'), join(p, '.hf-home')] }
const SCRIPTS = join(HERE, 'scripts')
const CACHE_CFG = join(DEPS, 'cache-config.json')
const UI_CFG = join(DEPS, 'ui-config.json')
const DEFAULT_UI_CFG = { hintDismissed: false, activationSeen: false, showInSettings: true, autoHint: true }

function uiCfg() {
  try {
    const raw = JSON.parse(readFileSync(UI_CFG, 'utf8'))
    return { ...DEFAULT_UI_CFG, ...raw }
  } catch { return { ...DEFAULT_UI_CFG } }
}
function writeUiCfg(patch) {
  const cur = uiCfg()
  const next = { ...cur, ...patch }
  writeFileSync(UI_CFG, JSON.stringify(next, null, 2), 'utf8')
  return next
}
const DEFAULT_CACHE_DAYS = 7
const DEFAULT_CACHE_MAX_MB = 2048
const DOWNLOAD_LOG = join(DEPS, 'download.log')
// 一键下载的预估体积，只给面板显示，不参与逻辑
const ESTIMATES = {
  ffmpeg: '约 94 MB',
  ytdlp: '约 17 MB',
  asr: '约 294 MB（venv）',
  ocr: '约 263 MB（venv）',
  model: '约 464 MB',
}

// 面板内扫码登录（与 tools/look.mjs 的 login 同一套接口，凭证落同一个文件）
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const QR_GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const QR_POLL = (key) =>
  'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

const name = 'dsh-bili-watch'
const inject = ['commands', 'webServer', 'agents']

// ── 失败现场落盘（T25-P0-1：一次调用失败后，能只靠磁盘复现）────────────
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version || '' } catch { return '' }
})()
const RUNS_FILE = join(CACHE, '_logs', 'runs.jsonl')
function appendRunLine(entry) {
  try {
    mkdirSync(dirname(RUNS_FILE), { recursive: true })
    // 轮转：超 5 MB 或 2000 行就换成 .1（诊断日志不能无限涨）
    try {
      const st = statSync(RUNS_FILE)
      const lines = Math.max(1, readFileSync(RUNS_FILE, 'utf8').split('\n').length - 1)
      if (st.size > 5 * 1024 * 1024 || lines > 2000) {
        const bak = RUNS_FILE + '.1'
        try { rmSync(bak, { force: true }) } catch {}
        try { renameSync(RUNS_FILE, bak) } catch {}
      }
    } catch {}
    appendFileSync(RUNS_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch {}
}
function logRun({ command, bv = '', argv = [], code = 0, signal = null, ms = 0, stderr = '' }) {
  try {
    const entry = {
      at: new Date().toISOString(),
      command,
      bv: String(bv || ''),
      argv,
      code,
      signal,
      ms,
      version: PLUGIN_VERSION,
      ok: code === 0,
    }
    if (!entry.ok) {
      entry.stderr = String(stderr || '').slice(-4000)
      // 按视频一份 last-error.json：事后直接定位「这条视频坏在哪」
      if (/^BV[0-9A-Za-z]{10}$/.test(entry.bv)) {
        const d = videoDir(entry.bv)
        if (d) writeFileSync(join(d, 'last-error.json'), JSON.stringify(entry, null, 2) + '\n', 'utf8')
      }
    }
    appendRunLine(entry)
  } catch {}
}
function runLogRecord(args, code, err, ms) {
  const command = String(args?.[0] || '')
  const bv = ['clean', 'login', 'hot'].includes(command) ? '' : String(args?.[1] || '')
  logRun({ command, bv, argv: args || [], code, ms, stderr: err })
}

function runLook(args, { timeoutMs = 1_200_000, signal = null } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // C组（T42）：Buffer 分块各自 toString 会把跨 UTF-8 边界的汉字切成 ��；先攒 chunk，finish 时统一 concat 再 toString
    const chunks = []
    const errChunks = []
    const getOut = () => Buffer.concat(chunks).toString('utf8')
    const getErr = () => Buffer.concat(errChunks).toString('utf8')
    let done = false
    let child
    let timer
    // F组（T43）：Windows 上 child.kill() 只杀直接子进程，ffmpeg/python 变孤儿；用 taskkill /T /F 杀进程树
    // A4（2026-10-27 批次8）：按平台分流——win32 走 taskkill /T /F，否则 process.kill(-pid,'SIGKILL')；
    //   catch 不再静默吞（原来杀不掉子进程会让 ffmpeg/yt-dlp 变孤儿空跑），至少打一行。
    const killTree = (c) => {
      if (!c?.pid) return
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true })
        } else {
          process.kill(-c.pid, 'SIGKILL')
        }
      } catch (e) {
        console.error(`[dsh-bili-watch] killTree 杀 pid=${c.pid} 失败：${e?.message ?? e}`)
      }
    }
    const cleanupTimer = () => { try { clearTimeout(timer) } catch {} }
    // 14-7：模型取消工具调用后，必须在 1 秒内把看视频的子进程杀掉，不能让它空跑十几分钟
    const onAbort = () => {
      killTree(child)
      finish({ code: -3, out: getOut().trim(), err: '已被用户取消' })
    }
    const cleanupAbort = () => { try { signal?.removeEventListener?.('abort', onAbort) } catch {} }
    const finish = (res) => {
      if (done) return
      done = true
      cleanupTimer()
      cleanupAbort()
      const ms = Date.now() - t0
      runLogRecord(args, res.code, res.err, ms)
      resolve({ ...res, ms })
    }
    try {
      child = spawn(process.execPath, [LOOK, ...args], { windowsHide: true })
    } catch (e) {
      finish({ code: -1, out: '', err: `启动失败：${e?.message ?? e}` })
      return
    }
    timer = setTimeout(() => {
      killTree(child)
      finish({ code: -2, out: getOut().trim(), err: (getErr() + '\n[超时]').trim() })
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) {
        killTree(child)
        finish({ code: -3, out: '', err: '已被用户取消' })
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    child.stdout.on('data', (d) => {
      chunks.push(d)
    })
    child.stderr.on('data', (d) => {
      errChunks.push(d)
    })
    child.on('error', (e) => {
      finish({ code: -1, out: getOut().trim(), err: String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      finish({ code, out: getOut().trim(), err: getErr().trim() })
    })
  })
}

// ── 面板内扫码登录 ─────────────────────────────────────────────────────────
/** 从 poll 响应的 Set-Cookie 里挑登录需要的几个 cookie。 */
function pickLoginCookies(list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3', buvid4: 'buvid4' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const k = first.slice(0, i).trim()
    const v = first.slice(i + 1).trim()
    if (want[k] && v) jar[want[k]] = v
  }
  return jar
}

/** poll 往往只给 buvid3，buvid4 走 finger/spi 补。 */
async function fillBuvids(jar) {
  if (jar.buvid3 && jar.buvid4) return jar
  try {
    const r = await fetch(SPI, { headers: { 'User-Agent': UA } })
    const j = await r.json()
    if (!jar.buvid3 && j?.data?.b_3) jar.buvid3 = j.data.b_3
    if (!jar.buvid4 && j?.data?.b_4) jar.buvid4 = j.data.b_4
  } catch {}
  return jar
}

/** 生成扫码登录二维码：返回 qrcode_key 与可直接插进页面的 SVG。 */
async function loginQr() {
  const r = await fetch(QR_GEN, { headers: { 'User-Agent': UA } })
  const j = await r.json()
  const d = j?.data
  if (!d?.url || !d?.qrcode_key) return { ok: false, why: j?.message || '生成二维码失败' }
  let svg = ''
  try {
    svg = await QRCode.toString(d.url, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
  } catch (e) {
    return { ok: false, why: `二维码渲染失败：${e?.message ?? e}` }
  }
  return { ok: true, data: { key: d.qrcode_key, url: d.url, svg } }
}

/**
 * 轮询一次扫码结果（前端每 2.5 秒调一次）。
 * 成功时把凭证写进 $DSH_HOME/bili-watch/credential.json——与 tools/look.mjs login --poll 同一个格式。
 */
async function loginPollOnce(key) {
  if (!key) return { ok: false, state: 'error', why: '缺少二维码 key' }
  const res = await fetch(QR_POLL(key), { headers: { 'User-Agent': UA }, redirect: 'manual' })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  let body = {}
  try {
    body = await res.json()
  } catch {}
  const code = body?.data?.code
  if (code === 0) {
    const jar = await fillBuvids(pickLoginCookies(setCookies))
    if (!jar.sessdata) return { ok: false, state: 'error', why: '登录成功但响应里没有 SESSDATA' }
    try {
      mkdirSync(dirname(SHARED_CRED), { recursive: true })
      writeFileSync(
        SHARED_CRED,
        JSON.stringify(
          {
            sessdata: jar.sessdata,
            bili_jct: jar.bili_jct || '',
            buvid3: jar.buvid3 || '',
            buvid4: jar.buvid4 || '',
            mid: jar.dedeuserid || '',
            note: '扫码登录（插件面板），只用于读取 AI 字幕',
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (e) {
      return { ok: false, state: 'error', why: `凭证写入失败：${e?.message ?? e}` }
    }
    return { ok: true, state: 'ok', data: { mid: jar.dedeuserid || '' } }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { ok: false, state: map[code] ?? 'error', why: code === undefined ? body?.message || 'poll 返回异常' : '' }
}

// ── 设置页状态（只读端点 + 清缓存按钮）──────────────────────────────────────
function writeLastRun(command, code, ms) {
  try {
    writeFileSync(LAST_RUN, JSON.stringify({ time: new Date().toISOString(), command, code, ok: code === 0, ms: Number.isFinite(ms) ? ms : null }), 'utf8')
  } catch {}
}

function readLastRun() {
  try {
    const j = JSON.parse(readFileSync(LAST_RUN, 'utf8'))
    return { time: j.time ?? null, command: j.command ?? null, code: j.code ?? null, ok: j.ok ?? null, ms: Number.isFinite(j.ms) ? j.ms : null }
  } catch {
    return { time: null, command: null, code: null, ok: null, ms: null }
  }
}

function credState() {
  const p = resolveCredPath()
  if (!existsSync(p)) return { exists: false, state: 'missing', updatedAt: null, ageDays: null }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const t = j.updatedAt || statSync(p).mtime.toISOString()
    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 86400000))
    return { exists: true, state: ageDays > 30 ? 'expired' : 'ok', updatedAt: t, ageDays }
  } catch {
    return { exists: true, state: 'unknown', updatedAt: null, ageDays: null }
  }
}

function dirStat(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        files += 1
        try {
          bytes += statSync(p).size
        } catch {}
      }
    }
  }
  try {
    walk(dir)
  } catch {}
  return { bytes, files }
}

/**
 * 缓存目录里每个文件的 { path, size, mtime }，用于按天数/总量清理。
 * T35/T40-A1：只遍历插件自己的条目（BV_* / _logs / frames 等白名单）；
 * 根下非白名单目录（共享目录里别人的东西）整棵跳过，不 stat、不删。
 */
function walkEntries(dir) {
  const out = []
  const walk = (d) => {
    let list = []
    try {
      list = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of list) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (isOwnedEntry(p)) walk(p)
      } else {
        if (!isOwnedEntry(p)) continue
        try {
          const st = statSync(p)
          out.push({ path: p, size: st.size, mtime: st.mtimeMs })
        } catch {}
      }
    }
  }
  walk(dir)
  return out
}

function cacheCfg() {
  try {
    const j = JSON.parse(readFileSync(CACHE_CFG, 'utf8'))
    return {
      days: Number.isFinite(j.days) ? Math.max(1, j.days) : DEFAULT_CACHE_DAYS,
      maxMb: Number.isFinite(j.maxMb) ? Math.max(100, j.maxMb) : DEFAULT_CACHE_MAX_MB,
    }
  } catch {
    return { days: DEFAULT_CACHE_DAYS, maxMb: DEFAULT_CACHE_MAX_MB }
  }
}

function writeCacheCfg(days, maxMb) {
  try {
    writeFileSync(CACHE_CFG, JSON.stringify({ days, maxMb }), 'utf8')
  } catch {}
}

/** 合并写 deps\deps-config.json（只动指定字段，保留用户原有配置）。失败返回 {ok:false,error}，不抛。 */
function writeDepsCfg(patch) {
  const p = join(DEPS, 'deps-config.json')
  let cur = {}
  try { cur = JSON.parse(readFileSync(p, 'utf8')) } catch {}
  const next = { ...cur, ...patch }
  try {
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, data: next }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * 弹原生选目录框（Windows）。脚本里只用 ASCII，避免 PS 5.1 按 ANSI 解码中文变乱；
 * 选中的路径经 UTF-8 文件回传，不走 stdout——PS 5.1 的管道输出是当前代码页（中文系统为 GBK），
 * 中文路径经管道会变成问号（2026-10-24 实测：带中文的目录名过管道后，中文段全变成 ?）。
 * 取消返回 null；非 Windows 直接报错，让面板提示手填。
 */
function pickFolderDialog() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('folder picker is Windows only; set the path manually'))
    const outFile = join(tmpdir(), `bili-watch-pick-${Date.now()}.txt`)
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "bili-watch cache folder"',
      'if ($d.ShowDialog() -eq "OK") { [IO.File]::WriteAllText(\'' + outFile + '\', $d.SelectedPath, (New-Object Text.UTF8Encoding($false))) }',
    ].join('; ')
    const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false })
    let err = ''
    ps.stderr.on('data', (c) => { err += c })
    ps.on('close', (code) => {
      let picked = ''
      try {
        if (existsSync(outFile)) picked = readFileSync(outFile, 'utf8').trim()
      } catch {}
      try { rmSync(outFile, { force: true }) } catch {}
      if (code !== 0) return reject(new Error(err.trim() || ('powershell exit ' + code)))
      resolve(picked || null)
    })
    ps.on('error', reject)
  })
}

/**
 * 缓存自动清理：先按天数删过期文件，再按总量从最旧删到阈值内。
 * 返回被删统计，供面板显示。
 */
let lastCleanAt = 0

function autoCleanCache(opts = {}) {
  // T31-P2-6：面板每 8 秒轮询 /status，不许每次都全量 walk 缓存目录
  if (!opts.force && Date.now() - lastCleanAt < 10 * 60 * 1000) return { removed: 0, bytes: 0, skipped: true }
  if (!existsSync(CACHE)) return { removed: 0, bytes: 0 }
  const { days, maxMb } = cacheCfg()
  const cutoff = Date.now() - days * 86400000
  const limit = maxMb * 1024 * 1024
  const entries = walkEntries(CACHE)
  let removed = 0
  let bytes = 0
  const fresh = []
  for (const e of entries) {
    if (e.mtime < cutoff) {
      try {
        rmSync(e.path, { force: true })
        removed += 1
        bytes += e.size
      } catch {}
    } else {
      fresh.push(e)
    }
  }
  let total = fresh.reduce((n, e) => n + e.size, 0)
  if (total > limit) {
    fresh.sort((a, b) => a.mtime - b.mtime)
    for (const e of fresh) {
      try {
        rmSync(e.path, { force: true })
        removed += 1
        bytes += e.size
        total -= e.size
      } catch {}
      if (total <= limit) break
    }
  }
  // 清单 1-7：只删文件会留一堆空目录（跑 100 个视频留 100 个空目录）；删完后自底向上清白名单内空目录
  pruneEmptyDirs(CACHE)
  lastCleanAt = Date.now()
  return { removed, bytes }
}

/** 清理后把插件自己名下（白名单 / BV_*）的空目录也删掉，根目录本身与别人的目录不动。 */
function pruneEmptyDirs(root) {
  const dirs = []
  const collect = (d) => {
    let list = []
    try {
      list = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of list) {
      if (!e.isDirectory()) continue
      const p = join(d, e.name)
      if (isOwnedEntry(p)) {
        collect(p)
        dirs.push(p)
      }
    }
  }
  collect(root)
  for (const d of dirs.reverse()) {
    try {
      rmdirSync(d) // 只删空目录；非空 / 权限问题抛错被吞
    } catch {}
  }
}

/** 14-8：/status 是回环 HTTP，面板 JSON 里不吐完整本机绝对路径，遮成 …\basename。 */
function maskAbs(p) {
  const s = String(p || '')
  if (!s) return s
  if (!/^([A-Za-z]:[\\/]|\/)/.test(s)) return s
  const sep = s.includes('\\') ? '\\' : '/'
  const base = s.split(/[\\/]/).filter(Boolean).pop() || s
  return '…' + sep + base
}

// 14-17：yt-dlp 版本号。depRows 每 8 秒被 /status 轮询一次，版本按文件 size+mtime 缓存，
// 只有真换了二进制才重新 spawn 一次 --version。
let ytdlpVerCache = { key: '', ver: '' }
function ytdlpVersion() {
  const ytdlp = join(DEPS, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (!existsSync(ytdlp)) return ''
  let key = ''
  try {
    const st = statSync(ytdlp)
    key = `${st.size}:${st.mtimeMs}`
  } catch { return '' }
  if (ytdlpVerCache.key === key) return ytdlpVerCache.ver
  let ver = ''
  try {
    ver = String(execFileSync(ytdlp, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }) || '').trim().split(/\s+/)[0]
  } catch {}
  ytdlpVerCache = { key, ver }
  return ver
}

/** 面板上的依赖行：一条依赖一个状态 + 体积 + 是否需要下载。 */
function depRows() {
  const ffmpeg = ffmpegCands().find((p) => existsSync(p)) || ''
  let ffmpegSize = 0
  try {
    ffmpegSize = ffmpeg ? statSync(ffmpeg).size : 0
  } catch {}
  const ytdlp = join(DEPS, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  let ytdlpSize = 0
  try {
    ytdlpSize = existsSync(ytdlp) ? statSync(ytdlp).size : 0
  } catch {}
  const asrPython = venvAsr().find((p) => existsSync(p)) || ''
  const ocrPython = venvOcr().find((p) => existsSync(p)) || ''
  const model = hfHomes().find((d) => existsSync(d)) || ''
  const rows = [
    {
      id: 'ffmpeg',
      name: 'ffmpeg（抽帧 / 取音轨）',
      ok: Boolean(ffmpeg),
      detail: ffmpeg ? maskAbs(ffmpeg) : '没找到，抽帧与转写取音轨会失败',
      path: maskAbs(ffmpeg),
      removable: false,
      removableWhy: '在插件目录外，这里不删',
      size: ffmpegSize,
      estimate: ESTIMATES.ffmpeg,
    },
    {
      id: 'ytdlp',
      name: 'yt-dlp（通用 URL）',
      ok: existsSync(ytdlp),
      detail: existsSync(ytdlp) ? `版本 ${ytdlpVersion() || '未知'}` : '没找到，非 B 站 URL 不可用',
      path: maskAbs(ytdlp),
      removable: true,
      size: ytdlpSize,
      estimate: ESTIMATES.ytdlp,
    },
    {
      id: 'asr',
      name: 'ASR 环境（本地转写）',
      ok: Boolean(asrPython),
      detail: asrPython ? maskAbs(asrPython) : '没找到 python 环境，无字幕视频无法转写',
      path: maskAbs(asrPython),
      removable: false,
      removableWhy: '在插件目录外，这里不删',
      size: asrPython ? dirStat(join(asrPython, '..', '..')).bytes : 0,
      estimate: ESTIMATES.asr,
    },
    {
      id: 'ocr',
      name: 'OCR 环境（画面文字）',
      ok: Boolean(ocrPython),
      detail: ocrPython ? maskAbs(ocrPython) : '没找到 python 环境，画面文字无法识别',
      path: maskAbs(ocrPython),
      removable: false,
      removableWhy: '在插件目录外，这里不删',
      size: ocrPython ? dirStat(join(ocrPython, '..', '..')).bytes : 0,
      estimate: ESTIMATES.ocr,
    },
    {
      id: 'model',
      name: '转写模型（faster-whisper small）',
      ok: Boolean(model),
      detail: model ? maskAbs(model) : '没找到模型目录，本地转写不可用',
      path: maskAbs(model),
      removable: true,
      size: model ? dirStat(model).bytes : 0,
      estimate: ESTIMATES.model,
    },
  ]
  const cred = credState()
  rows.push({
    id: 'credential',
    name: 'B 站登录凭证',
    ok: cred.state === 'ok',
    detail: cred.exists ? `更新于 ${cred.updatedAt ?? '未知时间'}（${cred.ageDays ?? '?'} 天前）` : '没登录，AI 字幕与部分接口不可用',
    path: maskAbs(resolveCredPath()),
    removable: true,
    size: 0,
    estimate: '扫码登录',
  })
  return rows
}

/** 一键下载：跑插件自带的 fetch-deps 脚本，后台执行，返回日志路径。 */
function runDownload(target) {
  const script = join(SCRIPTS, 'fetch-deps.ps1')
  if (!existsSync(script)) return { started: false, why: '插件目录里没有 scripts/fetch-deps.ps1' }
  const allowed = ['ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'all']
  if (!allowed.includes(target)) return { started: false, why: `不支持的依赖：${target}` }
  try {
    appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] 开始下载 ${target}\n`, 'utf8')
  } catch {}
  const win = process.platform === 'win32'
  const cmd = win ? 'powershell.exe' : 'bash'
  const args = win
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target]
    : [script.replace(/\.ps1$/i, '.sh'), target]
  let child = null
  try {
    child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', detached: true })
  } catch (e) {
    return { started: false, error: String(e?.message ?? e) }
  }
  // detached 子进程不会把 spawn 失败同步抛给我们，必须自己接 error，否则 ENOENT 会带崩宿主
  child.on('error', (e) => {
    try {
      appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] 启动失败 ${target}：${e?.message ?? e}\n`, 'utf8')
    } catch {}
  })
  child.unref()
  return { started: true, log: DOWNLOAD_LOG }
}

/**
 * 删除插件 deps\ 里的依赖。
 * 只认这三个：yt-dlp、模型目录、登录凭证；ffmpeg / ASR / OCR 在插件目录外，一律跳过。
 */
function deleteDeps(targets) {
  const map = {
    ytdlp: join(DEPS, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    model: join(DEPS, '.hf-home'),
  }
  const deleted = []
  const skipped = []
  for (const t of targets) {
    if (t === 'credential') {
      // 凭证可能在新共享位置或旧 deps 位置，两个都删才算真删掉
      let anyDeleted = false
      for (const p of [SHARED_CRED, LEGACY_CRED]) {
        try {
          if (!existsSync(p)) continue
          rmSync(p, { recursive: true, force: true })
          anyDeleted = true
        } catch (e) {
          skipped.push({ id: t, why: String(e?.message || e) })
        }
      }
      if (anyDeleted) deleted.push(t)
      else skipped.push({ id: t, why: '本来就不存在' })
      // 2026-10-27 批次9：resolveCredPath() 现在是「两处写入口谁新用谁」，所以删掉 watch 自己的
      // 两份不等于「未登录」——panel 的大号凭证还在就会继续用它。这里如实说明，不删 PANEL
      // （那是业务侧只读身份，归 panel/业务管，watch 删它会毁掉大号）。
      if (existsSync(PANEL_CRED)) {
        skipped.push({ id: t, why: 'panel 大号凭证仍在（bili-duty/bili_credential.json），watch 会继续用它；要彻底未登录请到业务侧处理' })
      }
      continue
    }
    const p = map[t]
    if (!p) {
      skipped.push({ id: t, why: '不在插件目录内，不能从这里删' })
      continue
    }
    try {
      if (!existsSync(p)) {
        skipped.push({ id: t, why: '本来就不存在' })
        continue
      }
      rmSync(p, { recursive: true, force: true })
      deleted.push(t)
    } catch (e) {
      skipped.push({ id: t, why: String(e?.message || e) })
    }
  }
  return { deleted, skipped }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/** 写端点的同源闸：Host 必须是回环（挡 DNS rebinding），Origin 主机名须等于 Host，sec-fetch-site 只认 same-origin/none。 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])
/** 从 Host 头取主机名：同时支持 example.com:3080 与 [::1]:3080。 */
function hostNameOf(value) {
  const raw = String(value ?? "").trim().toLowerCase()
  if (!raw) return ""
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]")
    return close >= 0 ? raw.slice(0, close + 1) : raw
  }
  const colon = raw.lastIndexOf(":")
  return colon >= 0 && /^\d+$/.test(raw.slice(colon + 1)) ? raw.slice(0, colon) : raw
}
function sameOriginBlocked(req) {
  const host = hostNameOf(req.headers?.host)
  // DNS rebinding：攻击者把自己的域名解析到 127.0.0.1，Origin 与 Host 就都是他自己的域名，
  // 只比两者相等挡不住（2026-10-24 wb 第二轮实测 Host/Origin 同为 evil.example:3080 返回 200）。
  // 所以先要求 Host 是回环，再比 Origin。
  if (!LOOPBACK.has(host)) return "非本机请求被拒绝（Host 必须是回环地址）"
  const method = String(req.method || 'GET').toUpperCase()
  const mutating = method !== 'GET' && method !== 'HEAD'
  const origin = req.headers?.origin
  // 14-6：写操作必须带 Origin 且同源。不带 Origin 的（curl 直打、旧浏览器）一律拒——
  // 原本 `if (origin)` 是可选的，等于裸 POST 没有任何同源校验。
  if (mutating && !origin) return "跨站写请求被拒绝（缺少 Origin 头）"
  if (origin) {
    let oh = ""
    try { oh = new URL(origin).hostname } catch { return "非法 Origin 头" }
    if (oh !== host && !(LOOPBACK.has(host) && LOOPBACK.has(oh))) return "跨源访问被拒绝"
  }
  // 14-6：写操作必须是 application/json。text/plain / form-urlencoded / multipart 这种
  //「简单请求」不触发 CORS 预检，是 CSRF 经典向量；面板的 fetch 一律带 content-type: application/json。
  if (mutating) {
    const ct = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (ct !== 'application/json') return `跨站写请求被拒绝（Content-Type 必须是 application/json，收到：${ct || '无'}）`
  }
  const site = req.headers?.["sec-fetch-site"]
  if (site && site !== "same-origin" && site !== "none") return `跨站请求被拒绝（sec-fetch-site=${site}）`
  return null
}

/** 读 POST 的小 JSON body；读不到就返回 {}，端点自己决定默认值。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
      if (raw.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** 把 "text BV1xx --cred path --step 2" 拆成 { command, bv, extra }。 */
function parseCommandLine(raw) {
  const tokens = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const command = tokens.shift()
  const positionals = []
  const extra = []
  const unknownFlags = []
  let step = ''
  let cred = ''
  let badOut = false
  while (tokens.length) {
    let t = tokens.shift()
    // T15-4：支持 --option=value（原来整串被当位置参数静默吞掉）
    if (t.startsWith('--') && t.includes('=')) {
      const eq = t.indexOf('=')
      tokens.unshift(t.slice(eq + 1))
      t = t.slice(0, eq)
    }
    if (t === '--step' && tokens.length) {
      step = tokens.shift()
      extra.push('--step', step)
    } else if (t === '--p' && tokens.length) {
      extra.push('--p', tokens.shift())
    } else if (t === '--cred' && tokens.length) {
      cred = tokens.shift()
      extra.push('--cred', cred)
    } else if (t === '--days' && tokens.length) {
      extra.push('--days', tokens.shift())
    } else if (t === '--limit' && tokens.length) {
      extra.push('--limit', tokens.shift())
    } else if (t === '--order' && tokens.length) {
      extra.push('--order', tokens.shift())
    } else if (t === '--grid' && tokens.length) {
      extra.push('--grid', tokens.shift())
    } else if (t === '--out' && tokens.length) {
      const out = tokens.shift()
      // 斜杠命令层与工具层同一口径：只允许工作区内的相对路径
      if (/^([/\\]|[A-Za-z]:|~)|\.\./.test(out)) badOut = true
      else extra.push('--out', out)
    } else if (t === '--ffmpeg' && tokens.length) {
      extra.push('--ffmpeg', tokens.shift())
    } else if (t === '--head' && tokens.length) {
      extra.push('--head', tokens.shift())
    } else if (t === '--full' || t === '--verify') {
      extra.push(t)
    } else if (t === '--format' && tokens.length) {
      extra.push('--format', tokens.shift())
    } else if (t === '--fresh' || t === '--ocr' || t === '--poll' || t === '--check' || t === '--fast' || t === '--scene' || t === '--mark-seen') {
      extra.push(t)
    } else if (t.startsWith('--')) {
      // 2026-10-26 批次5（8-15）：未知 flag 不再静默吞，收集后给拼写提示（与终端 look.mjs 对齐）
      unknownFlags.push(t)
    } else {
      // 非选项 token 都当位置参数收着：BV / 搜索词 / 评论条数都可能出现在选项前后
      positionals.push(t)
    }
  }
  return { command, bv: positionals[0] || '', positionals, extra, step, cred, badOut, unknownFlags }
}

// 编辑距离（Levenshtein 简化）：给未知 flag 找最像的已知 flag，距离 ≤2 才提示「你是想用 X 吗」
function suggestFlag(unknown) {
  let best = null
  let bestDist = Infinity
  for (const k of KNOWN_FLAGS) {
    const a = unknown.replace(/^--/, '')
    const b = k.replace(/^--/, '')
    if (!a || !b) continue
    const m = a.length
    const n = b.length
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    if (dp[m][n] < bestDist) { bestDist = dp[m][n]; best = k }
  }
  return bestDist <= 2 ? `未知参数 ${unknown}，你是想用 ${best} 吗` : `未知参数 ${unknown}`
}

async function lookup({ command, bv, positionals = [], extra = [], badOut = false, unknownFlags = [], signal = null }) {
  if (badOut) return { ok: false, text: '--out 只接受工作区内的相对路径（不能用绝对路径、盘符、~ 或 ..）' }
  if (unknownFlags.length) return { ok: false, text: unknownFlags.map(suggestFlag).join('；') }
  if (!command || !COMMANDS.includes(command)) {
    return { ok: false, text: `用法：/bili <${COMMANDS.join('|')}> <BV> [--step 2] [--cred 凭证路径]` }
  }
  if (!['clean', 'login', 'hot', 'search'].includes(command) && !bv) {
    return { ok: false, text: `缺少 BV 号，用法：/bili ${command} <BV>` }
  }
  if (command === 'search' && !bv) {
    return { ok: false, text: '缺少搜索关键词，用法：/bili search <关键词>' }
  }
  const args =
    command === 'clean'
      ? ['clean']
      : command === 'login'
        ? ['login', ...extra]
        : command === 'hot'
          ? ['hot', ...extra]
          : command === 'comments' && String(positionals[1] || '').trim()
            ? [command, bv, String(positionals[1]).trim(), ...extra]  // T34-P0-3：评论条数是第二个位置参数，别静默丢掉
            : [command, bv, ...extra]
  const r = await runLook(args, { signal })
  // login 只生成二维码，真正的登录成功由面板 poll 写；命令层不记 lastRun，避免「生成成功」被读成「已登录」
  if (command !== 'login') writeLastRun(command, r.code, r.ms)
  const failed = r.code !== 0
  const err = String(r.err || '').trim()
  const out = String(r.out || '').trim()
  // B组（T36/T41）：--out 成功时 stdout 为空，stderr 有 look.mjs 打的「✓ 已写入 <path>」；
  // 从 stderr 提取路径上报给模型，否则模型拿到「没有输出」且 code=0 时 last-error.json 不存在。
  let outWrittenPath = null
  if (!failed) {
    const m = err.match(/✓\s*已写入\s*(.+)/)
    if (m) outWrittenPath = m[1].trim()
  }
  // A3（2026-10-27 批次8）：成功分支里也读 stderr，把含 ⚠ 的警告行拼到结果末尾（一行「警告：…」）；
  //   不含 ⚠ 的进度/日志行照旧丢弃，不污染给模型的正文。
  let warnLines = []
  if (!failed && err) {
    warnLines = err.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('⚠'))
  }
  const parts = []
  if (failed) parts.push(`（${command} 失败，退出码 ${r.code ?? '?'}）`)
  // 失败时先给 stderr（诊断），再给 stdout（可能是半截数据）；成功时反过来（T31-3）
  if (failed ? err : out) parts.push(failed ? err : out)
  if (failed && out) parts.push(out)
  if (!parts.length) {
    if (!failed && outWrittenPath) {
      parts.push(`结果已写入 ${outWrittenPath}`)
    } else if (failed) {
      parts.push(`（${command} 没有输出，退出码 ${r.code ?? '?'}；完整日志见视频缓存目录下的 last-error.json）`)
    } else {
      parts.push(`（${command} 没有输出，退出码 ${r.code ?? '?'}）`)
    }
  }
  if (warnLines.length) parts.push('警告：' + warnLines.join('；'))
  return { ok: !failed, text: parts.join(String.fromCharCode(10)) }
}

function apply(ctx) {
  // 启动时按「天数 + 总量阈值」清一次缓存，不点按钮也不会无限涨
  try {
    const r = autoCleanCache({ force: true })
    if (r.removed) ctx.logger?.info?.(`[dsh-bili-watch] 自动清理缓存 ${r.removed} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB`)
  } catch {}

  // ① 斜杠命令：人敲，确定性执行，不花推理 token
  ctx.commands.register({
    definitionId: 'dsh-bili-watch',
    name: 'bili',
    description: '看 B 站视频内容：字幕 → 本地转写 → 抽帧 OCR，输出最可信的一份文本',
    input: {
      hint: '<search 关键词|hot|peek|view|sub|comments|danmaku|asr|frames|sheet|substrip|ocr|text|login|clean> [BV] [--p N] [--step 2] [--days 3] [--order pubdate|click] [--cred 凭证路径] [--fast] [--scene] [--grid 3x3] [--format srt|json|md|txt] [--out 文件（需配合 --format）] [--limit N] [--head N] [--full] [--verify] [--ffmpeg 路径] [--fresh] [--ocr] [--poll] [--check] [--mark-seen]',
    },
    handler: async (invocation) => {
      const { command, bv, positionals, extra, badOut } = parseCommandLine(invocation?.rawInput)
      const r = await lookup({ command, bv, positionals, extra, badOut })
      // A8：斜杠命令带了 --full / --head 也透给 trimForModel，别再切回 800
      const fullOn = (extra || []).includes('--full')
      const hi = (extra || []).indexOf('--head')
      const headOn = hi >= 0 && Number(extra[hi + 1]) ? Number(extra[hi + 1]) : null
      return { kind: r.ok ? 'success' : 'error', text: trimForModel(r.text, command, bv, false, { full: fullOn, head: headOn }) }
    },
  })

  // ①-b 单条链接软提示：只往消息流里加一条旁白，绝不替用户调用工具
  //     开关落 deps/ui-config.json 的 autoHint（DEFAULT_UI_CFG 见上）
  try {
    if (createUserMessage && uiCfg().autoHint !== false) {
      const hinted = new Map() // message.id → true，同一条消息只提示一次
      const HINT_CAP = 500 // T31-P2-5：常驻 Map 不能无限涨，满了整体清空（只影响重复提示）
      const hint = (msg) => {
        const { ok, text } = textOfUserMessage(msg)
        if (!ok) return null
        const r = matchSingleVideoLink(text)
        if (!r.hit) return null
        const line = r.kind === 'short'
          // 短链：look.mjs 会先按公共 DNS 展开；展开失败才让用户贴 BV 号
          ? '[bili-watch] 这条消息只有一条 b23.tv 短链。要读内容就调 bili_watch，它会先按公共 DNS 展开短链；只有展开失败时才请用户贴 BV 号。不要凭短链猜内容。'
          : `[bili-watch] 这条消息只有一条 B 站视频链接（BV ${r.bv}）。要读内容就调 bili_watch（command=peek：需下载 360p 约每分钟 1 MB + 抽帧约 2 秒）；用户没说要看时不要自己跑。`
        return createUserMessage({
          content: [{ type: 'text', text: line }],
          source: { kind: name, form: 'notice', summary: boundContextSummary?.('检测到单条 B 站视频链接') ?? '检测到单条 B 站视频链接' },
        })
      }
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          if (decision.kind !== 'enter' || payload.step !== 1) return decision
          if (payload.signal?.aborted) return decision
          const fresh = []
          for (const msg of decision.messages) {
            if (msg?.source?.kind !== 'user') continue
            if (hinted.has(msg.id)) continue
            const extra = hint(msg)
            if (!extra) continue
            hinted.set(msg.id, true)
            if (hinted.size > HINT_CAP) hinted.clear()
            fresh.push(extra)
          }
          if (!fresh.length) return decision
          return { ...decision, messages: [...decision.messages, ...fresh] }
        } catch (e) {
          // 提示是旁白，出任何错都不许影响这一步
          try { ctx.logger?.info?.(`[dsh-bili-watch] 自动提示跳过：${e?.message ?? e}`) } catch {}
          return decision
        }
      })
    }
  } catch (e) {
    try { ctx.logger?.info?.(`[dsh-bili-watch] pre-step 钩子没挂上：${e?.message ?? e}`) } catch {}
  }

  // ② 同名工具：模型可调，需要看视频时自己来，不依赖用户敲命令
  //    必须用 defineTool 包一层：ctx.tools.register 收的是编译好的 tool 对象，
  //    直接传 options 会让发往模型的 parameters 变成 null（报 INVALID_REQUEST: schema must be type "object"）。
  const toolsSvc = (() => { try { return ctx.get?.('tools') } catch { return null } })()
  if (defineTool && toolsSvc?.register) {
  toolsSvc.register(defineTool({
    name: 'bili_watch',
    description:
      '用户给出 B 站视频链接 / BV 号，要我看、总结、判断这条视频讲了什么、有没有坑、值不值得看时使用。读取一个 B 站视频的内容材料（只读、匿名）。优先级：字幕 → 本地 ASR 转写 → 抽帧 OCR。command=peek：只拿标题/简介/热评 + 均匀 5 帧（需下载 360p 视频约每分钟 1 MB + 抽帧约 2 秒），用来先判断是口播还是画面，再决定走 text 还是 ocr；command=text 会按优先级自动降级并返回最可信的一份文本（推荐）；view=元数据与热评；comments=评论区；asr=强制本地转写；frames=抽帧（可加 ocr=true 顺带识别画面文字）；ocr=抽帧并识别画面文字；sub=只要字幕；search=按关键词搜视频（配 days 可只留最近 N 天发布的，结果按播放量降序，用来看「这几天有什么值得看」）；hot=综合热门榜（B 站按热度排的前 N 条）；danmaku=弹幕热区（观众在哪一段反应最集中，判断名场面在哪）；sheet=把 N 帧拼成九宫格一张图（看图省 token）；substrip=把底部字幕逐段竖拼成一张图（硬字幕视频最省）。多 P 视频用 p 指定第几个分P（默认 P1）。拿到文本后由你负责理解与总结。',
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: ['search', 'hot', 'peek', 'view', 'sub', 'comments', 'danmaku', 'asr', 'frames', 'sheet', 'substrip', 'ocr', 'text'],
        description: '要看哪一类材料；想要「讲了什么」的原料用 text，想先看有什么可看的用 search/hot。',
      },
      keyword: {
        type: 'string',
        description: 'command=search 时的搜索关键词（如「DeepSeek」「AI 编程」）。',
      },
      days: {
        type: 'number',
        description: 'command=search 时只保留最近 N 天发布的（再按播放量降序）；不传则不限时间。',
      },
      bv: { type: 'string', description: 'BV 号（如 BV1xx411c7mD），或直接贴 B 站分享链接（https://www.bilibili.com/video/BV.../?...），会自动提取 BV 号。search/hot 不需要。' },
      p: {
        type: 'number',
        description: '多 P 视频的分P序号（1 起）；不传默认 P1。',
      },
      step: {
        type: 'number',
        description: '抽帧间隔秒数（frames/ocr/text 用）；不传则按视频时长自适应（长视频更疏，省 CPU）。',
      },
      ocr: {
        type: 'boolean',
        description: 'command=frames 时是否顺带识别画面文字。',
      },
      fast: {
        type: 'boolean',
        description: 'command=text 时跳过本地转写，字幕拿不到就直接抽帧 OCR（画面类视频更快）。',
      },
      scene: {
        type: 'boolean',
        description: 'command=frames 时按画面变化点抽帧（吸附到变化最多的时刻，比等间隔更准，默认关）。',
      },
      grid: {
        type: 'string',
        description: 'command=sheet 时的格子，如 3x3 或 4x4（默认 3x3）。',
      },
      format: {
        type: 'string',
        description: 'command=sub 时可选 srt、json、md 或 txt（srt/md 带官方时间戳，md 的时间戳可跳回原片，txt 是一行一句）；command=text 时可选 json（含时间轴口径：字幕 exact，转写与 OCR 是估算）或 md；command=comments/danmaku 时可选 json（stdout 只有 JSON）。不传默认纯文本。',
      },
      out: {
        type: 'string',
        description: 'command=sub/text/comments/danmaku 且传了 format 时，把结果写到这个文件（只接受工作区内的相对路径）；不传打印到标准输出。',
      },
      head: {
        type: 'number',
        description: '只取前 N 字（text/sub/asr 用）。默认超过 800 字只回 400 字摘要 + 全文路径；要一次性看完改传这个。',
      },
      full: {
        type: 'boolean',
        description: '把全文直接返回（text/sub/asr 用）。长视频可能几万字，只在你确定需要全文时用，否则会挤爆上下文。',
      },
      verify: {
        type: 'boolean',
        description: 'command=text 时加一次钓鱼核对：抽首尾帧 OCR，和字幕比对，判断「字幕是不是和画面无关的诱饵」。默认不抽（省时间），遇到可疑字幕再用。',
      },
      fresh: {
        type: 'boolean',
        description: 'command=frames/peek 时强制重新下载与重新抽帧，忽略已有缓存（默认复用缓存）。只在怀疑缓存损坏/过期时用，会多花下载与抽帧时间。',
      },
      limit: {
        type: 'number',
        description: 'command=hot/search 的结果条数（hot 默认 10，search 默认 10）。',
      },
    },
    output: {
      // 注意：DSH 的 output.schema 是「author-facing spec」，编译时 allowRequired=false，
      // 写 required（无论属性级还是顶层数组）会抛 JsonSchemaError: unsupported JSON schema。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '执行是否成功' },
          text: { type: 'string', description: '输出文本' },
        },
      },
      render: (args, value) => {
        const s = String(value?.text ?? '')
        // 失败要把 ok 说出来，否则模型会把错误提示当成视频内容（2026-10-26 T31-1）
        const head = value?.ok === false ? '⚠ 本次调用失败（ok=false），下面是错误信息，不是视频内容。' + String.fromCharCode(10) : ''
        // N05-A4（2026-10-27 改）：full=true 是「用户明确要全文」，渲染层不许再截。
        //   原来一律砍成 2000+400，还会补一句「全文见上面提示里的路径」，可 full 分支（trimForModel 的 cap=20000）
        //   压根不写路径——等于承诺了一条不存在的路，8000 字实测只回 2421 字。
        if (args?.full) return [{ type: 'text', text: head + s }]
        if (s.length <= 2500) return [{ type: 'text', text: head + s }]
        // 超长时保头也保尾：尾部通常是「全文已存 → read 这个文件」，切掉就等于没给路（T31-2）
        // N05-B4：头尾都按码点切，别把 emoji 代理对切成 `�`
        const arr = Array.from(s)
        return [{ type: 'text', text: head + arr.slice(0, 2000).join('') + String.fromCharCode(10) + '…（已截断，全文见上面提示里的路径）…' + String.fromCharCode(10) + arr.slice(-400).join('') }]
      },
    },
    execute: async (args, execCtx) => {
      try {
      // 14-7：模型取消这次工具调用时，把 abort signal 透传到看视频的子进程，1 秒内杀掉
      const signal = execCtx?.signal || null
      const extra = []
      extra.push('--quiet') // B33：工具层所有命令走 clean stdout（look.mjs 侧解析 --quiet）
      if (typeof args.p === 'number' && Number.isInteger(args.p) && args.p > 0) extra.push('--p', String(args.p))
      if (typeof args.step === 'number' && Number.isFinite(args.step) && args.step > 0) extra.push('--step', String(args.step))
      if (args.ocr) extra.push('--ocr')
      if (args.fast) extra.push('--fast')
      if (args.scene) extra.push('--scene')
      if (typeof args.grid === 'string' && args.grid.trim()) extra.push('--grid', args.grid.trim())
      if (typeof args.days === 'number' && args.days > 0) extra.push('--days', String(Math.floor(args.days)))
      if (typeof args.limit === 'number' && args.limit > 0) extra.push('--limit', String(Math.floor(args.limit)))
      if (typeof args.format === 'string' && args.format.trim()) extra.push('--format', args.format.trim())
      // 2026-10-26（T01/T05/T06/T23 五份报告）：这三个之前只有斜杠命令能用，工具层 schema 没暴露，
      //   等于降级链做了但模型没入口。补上透传。
      if (typeof args.head === 'number' && Number.isFinite(args.head) && args.head > 0) extra.push('--head', String(Math.floor(args.head)))
      if (args.full) extra.push('--full')
      if (args.verify) extra.push('--verify')
      if (args.fresh) extra.push('--fresh') // T06-P2-6：fresh 强制重抽帧，schema 与透传一起暴露
      if (typeof args.out === 'string' && args.out.trim()) {
        const out = args.out.trim()
        // 工具层是模型可调的：只允许写工作区内的相对路径，挡住绝对路径 / 盘符 / .. 与家目录
        if (/^([/\\]|[A-Za-z]:|~)|\.\./.test(out)) {
          return { ok: false, text: '--out 只接受工作区内的相对路径（不能用绝对路径、盘符、~ 或 ..）' }
        }
        extra.push('--out', out)
      }
      if (args.command === 'hot') {
        const r = await lookup({ command: 'hot', bv: '', extra, signal })
        return { ok: r.ok, text: trimForModel(r.text, 'hot', '_hot') }
      }
      const target = args.command === 'search' ? String(args.keyword ?? '').trim() : String(args.bv ?? '').trim()
      if (args.command === 'search' && !target) return { ok: false, text: 'search 需要 keyword 参数（要搜什么词）' }
      if (!target) return { ok: false, text: '缺少 BV 号或分享链接' }
      const r = await lookup({ command: args.command, bv: target, extra, signal })
      return { ok: r.ok, text: trimForModel(r.text, args.command, target, false, { full: args.full, head: args.head }) }
      } catch (e) {
        // T41：别的 defineTool 都包了 try/catch，我们没包——runLook 抛错会让整轮失败
        // 9-10：除 text 外带 code/retryable/after，让调度层能区分可重试错误
        return { ok: false, text: `工具执行异常：${String(e?.message || e)}；可以先用 --fast 或换一个 BV 再试`, code: 'INTERNAL_ERROR', retryable: true, after: 5000 }
      }
    },
  }))
  } else {
    console.warn('[dsh-bili-watch] 未找到 @deepseek-ai/dsh-tools，bili_watch 工具未注册（/bili 命令与插件面板不受影响）')
  }

  // ③ 设置页：读盘状态 + 清缓存（只读优先；唯一写操作是删本机抽帧缓存目录）
  try {
    // 多实例/重放路由守卫：同一路径只注册一次，后续实例跳过（T41-P0-1）
    if (!claimRoute('/api/bili-watch')) return () => {}
    const disposeRoute = ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/api/bili-watch',
          handler: async (req, res) => {
            const blocked = sameOriginBlocked(req)
            if (blocked) return sendJson(res, 403, { ok: false, error: blocked })
            try {
              const url = new URL(req.url, 'http://127.0.0.1')
              if (req.method === 'GET' && url.pathname === '/api/bili-watch/status') {
                const cleaned = autoCleanCache()
                return sendJson(res, 200, {
                  ok: true,
                  data: {
                    credential: credState(),
                    deps: depRows(),
                    cache: { ...dirStat(CACHE), ...cacheCfg(), dir: maskAbs(CACHE), lastAutoClean: cleaned },
                    lastRun: readLastRun(),
                    ui: uiCfg(),
                    warnings: cfgWarning ? [cfgWarning] : [],
                  },
                })
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/cache/pick') {
                try {
                  const dir = await pickFolderDialog()
                  if (!dir) return sendJson(res, 200, { ok: false, why: '已取消' })
                  // 6-17：写 deps-config.json 可能失败（文件只读等），原来直接抛错被外层吞成 500，
                  // 面板可能显示已保存；这里显式回「保存失败」。
                  const w = writeDepsCfg({ cache: dir })
                  if (!w.ok) return sendJson(res, 500, { ok: false, why: `保存失败：${w.error}` })
                  return sendJson(res, 200, { ok: true, data: { dir, restart: true } })
                } catch (e) {
                  return sendJson(res, 500, { ok: false, why: String(e?.message || e) })
                }
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/cache/clear') {
                const body = await readJsonBody(req)
                if (Number.isFinite(body?.days) || Number.isFinite(body?.maxMb)) {
                  writeCacheCfg(
                    Number.isFinite(body?.days) ? Math.max(1, body.days) : cacheCfg().days,
                    Number.isFinite(body?.maxMb) ? Math.max(100, body.maxMb) : cacheCfg().maxMb,
                  )
                }
                // A7（2026-10-27 批次8）：先查锁再清理——frames 下若有正在跑的抽帧锁，直接拒绝，
                //   不再像以前那样「先删完再补一句 warning」（锁外删会跟运行中的抽帧抢目录）。
                //   锁可能在 frames/.lock 根，也可能在每个抽帧子目录 frames/<bv>-pN-<step>s/.lock。
                let locked = false
                try {
                  const framesRoot = join(CACHE, 'frames')
                  if (existsSync(framesRoot)) {
                    if (existsSync(join(framesRoot, '.lock'))) locked = true
                    else {
                      for (const e of readdirSync(framesRoot)) {
                        if (existsSync(join(framesRoot, e, '.lock'))) { locked = true; break }
                      }
                    }
                  }
                } catch {}
                if (locked) {
                  return sendJson(res, 200, {
                    ok: false,
                    why: '正在被占用：检测到正在运行的抽帧任务，已取消清理。等抽帧跑完再清。',
                    data: { removed: 0, bytes: 0, skipped: [], failed: [], locked: true },
                  })
                }
                // T35/T40-A1：只清插件自己的数据（BV_*、_logs、frames 等白名单），共享目录里别人的文件不碰
                const cleared = removeOwned(CACHE)
                // 9-8：有权限问题删不掉时不报成功，且 removed 只数真删掉的；面板按 ok/why 显示「部分失败：N 项」
                const partial = cleared.failed.length > 0
                return sendJson(res, 200, {
                  ok: !partial,
                  why: partial ? `部分失败：${cleared.failed.length} 项` : undefined,
                  data: { removed: cleared.files, bytes: cleared.bytes, skipped: cleared.skipped, failed: cleared.failed },
                })
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/download') {
                const body = await readJsonBody(req)
                const targets = Array.isArray(body?.targets) ? body.targets.map(String) : [String(body?.target ?? '')]
                const results = targets.map((t) => runDownload(t))
                const started = results.filter((r) => r.started).length
                return sendJson(res, started ? 200 : 400, { ok: started > 0, data: { results, started } })
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/delete') {
                const body = await readJsonBody(req)
                const targets = Array.isArray(body?.targets) ? body.targets.map(String) : [String(body?.target ?? '')]
                const r = deleteDeps(targets)
                return sendJson(res, 200, { ok: true, data: r })
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/login/qr') {
                const r = await loginQr()
                return sendJson(res, r.ok ? 200 : 502, r)
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/login/poll') {
                const body = await readJsonBody(req)
                const r = await loginPollOnce(String(body?.key ?? ''))
                if (r.state === 'ok') writeLastRun('login', 0)
                return sendJson(res, 200, r)
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/config') {
                const body = await readJsonBody(req)
                const patch = {}
                if (typeof body?.hintDismissed === 'boolean') patch.hintDismissed = body.hintDismissed
                if (typeof body?.activationSeen === 'boolean') patch.activationSeen = body.activationSeen
                if (typeof body?.showInSettings === 'boolean') patch.showInSettings = body.showInSettings
                if (typeof body?.autoHint === 'boolean') patch.autoHint = body.autoHint
                const next = writeUiCfg(patch)
                // A2（2026-10-27 批次8）：面板「保存规则」把 days/maxMb POST 到这里，以前被静默丢。
                //   落到 cache-config.json（与 /cache/clear 同源），不写进 ui-config.json。
                let rule = null
                if (Number.isFinite(body?.days) && body.days > 0) {
                  const cur = cacheCfg()
                  const days = Math.max(1, Math.floor(body.days))
                  const maxMb = Number.isFinite(body?.maxMb) && body.maxMb > 0 ? Math.max(100, Math.floor(body.maxMb)) : cur.maxMb
                  writeCacheCfg(days, maxMb)
                  rule = { days, maxMb }
                } else if (Number.isFinite(body?.maxMb) && body.maxMb > 0) {
                  const cur = cacheCfg()
                  const maxMb = Math.max(100, Math.floor(body.maxMb))
                  writeCacheCfg(cur.days, maxMb)
                  rule = { days: cur.days, maxMb }
                }
                return sendJson(res, 200, { ok: true, data: { ...next, ...(rule || {}) } })
              }
              sendJson(res, 404, { ok: false, why: 'not found' })
            } catch (e) {
              sendJson(res, 500, { ok: false, why: String(e?.message || e) })
            }
          },
        }),
      'dsh-bili-watch: /api/bili-watch 设置页端点',
    )
    return () => {
      try { disposeRoute?.() } catch {}
      releaseRoute('/api/bili-watch')
    }
  } catch (e) {
    try {
      ctx.logger?.info?.(`[dsh-bili-watch] 设置页端点没挂上：${e?.message ?? e}`)
    } catch {}
  }
}

export { apply, inject, name }
