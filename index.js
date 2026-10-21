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
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @deepseek-ai/dsh-tools 是可选 peer：桌面版 autoInstallPeers:false，市场安装时不会自动装上。
// 缺了只少一个 bili_watch 工具，/bili 命令、插件面板与路由照常工作，不能因此整块加载失败。
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

// 设置页端点读的落点，与 tools/look.mjs 同源（look.mjs:41/52/54/46/48/51）
const DEPS = join(HERE, 'deps')
const PROJ = process.env.BILI_WATCH_PROJ || DEPS
const CRED_FILE = join(DEPS, 'credential.json')
const LAST_RUN = join(DEPS, 'last-run.json')
const CACHE = join(tmpdir(), 'bili-watch')
const PY_DIR = process.platform === 'win32' ? 'Scripts' : 'bin'
const PY_EXE = process.platform === 'win32' ? 'python.exe' : 'python'
const VENV_ASR = [join(DEPS, '.venv-asr', PY_DIR, PY_EXE), join(PROJ, '.venv-asr', PY_DIR, PY_EXE)]
const VENV_OCR = [join(DEPS, '.venv-ocr', PY_DIR, PY_EXE), join(PROJ, '.venv-ocr', PY_DIR, PY_EXE)]
const FFMPEG_CANDS = [
  process.env.BILI_WATCH_FFMPEG,
  join(DEPS, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
].filter(Boolean)
const HF_HOME = [join(DEPS, '.hf-home'), join(PROJ, '.hf-home')]
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

function runLook(args, { timeoutMs = 1_200_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (res) => {
      if (done) return
      done = true
      resolve(res)
    }
    let child
    try {
      child = spawn(process.execPath, [LOOK, ...args], { windowsHide: true })
    } catch (e) {
      finish({ code: -1, out: '', err: `启动失败：${e?.message ?? e}` })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish({ code: -2, out: out.trim(), err: (err + '\n[超时]').trim() })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ code: -1, out: out.trim(), err: String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, out: out.trim(), err: err.trim() })
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
 * 成功时把凭证写进 deps\credential.json——与 tools/look.mjs login --poll 同一个格式。
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
      writeFileSync(
        CRED_FILE,
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
        'utf8',
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
function writeLastRun(command, code) {
  try {
    writeFileSync(LAST_RUN, JSON.stringify({ time: new Date().toISOString(), command, code, ok: code === 0 }), 'utf8')
  } catch {}
}

function readLastRun() {
  try {
    const j = JSON.parse(readFileSync(LAST_RUN, 'utf8'))
    return { time: j.time ?? null, command: j.command ?? null, ok: j.ok ?? null }
  } catch {
    return { time: null, command: null, ok: null }
  }
}

function credState() {
  if (!existsSync(CRED_FILE)) return { exists: false, state: 'missing', updatedAt: null, ageDays: null }
  try {
    const j = JSON.parse(readFileSync(CRED_FILE, 'utf8'))
    const t = j.updatedAt || statSync(CRED_FILE).mtime.toISOString()
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

/** 缓存目录里每个文件的 { path, size, mtime }，用于按天数/总量清理。 */
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
      if (e.isDirectory()) walk(p)
      else {
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

/**
 * 缓存自动清理：先按天数删过期文件，再按总量从最旧删到阈值内。
 * 返回被删统计，供面板显示。
 */
function autoCleanCache() {
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
  return { removed, bytes }
}

/** 面板上的依赖行：一条依赖一个状态 + 体积 + 是否需要下载。 */
function depRows() {
  const ffmpeg = FFMPEG_CANDS.find((p) => existsSync(p)) || ''
  let ffmpegSize = 0
  try {
    ffmpegSize = ffmpeg ? statSync(ffmpeg).size : 0
  } catch {}
  const ytdlp = join(DEPS, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  let ytdlpSize = 0
  try {
    ytdlpSize = existsSync(ytdlp) ? statSync(ytdlp).size : 0
  } catch {}
  const asrPython = VENV_ASR.find((p) => existsSync(p)) || ''
  const ocrPython = VENV_OCR.find((p) => existsSync(p)) || ''
  const model = HF_HOME.find((d) => existsSync(d)) || ''
  const rows = [
    {
      id: 'ffmpeg',
      name: 'ffmpeg（抽帧 / 取音轨）',
      ok: Boolean(ffmpeg),
      detail: ffmpeg || '没找到，抽帧与转写取音轨会失败',
      path: ffmpeg,
      removable: false,
      removableWhy: '在插件目录外，这里不删',
      size: ffmpegSize,
      estimate: ESTIMATES.ffmpeg,
    },
    {
      id: 'ytdlp',
      name: 'yt-dlp（通用 URL）',
      ok: existsSync(ytdlp),
      detail: existsSync(ytdlp) ? ytdlp : '没找到，非 B 站 URL 不可用',
      path: ytdlp,
      removable: true,
      size: ytdlpSize,
      estimate: ESTIMATES.ytdlp,
    },
    {
      id: 'asr',
      name: 'ASR 环境（本地转写）',
      ok: Boolean(asrPython),
      detail: asrPython || '没找到 python 环境，无字幕视频无法转写',
      path: asrPython,
      removable: false,
      removableWhy: '在插件目录外，这里不删',
      size: asrPython ? dirStat(join(asrPython, '..', '..')).bytes : 0,
      estimate: ESTIMATES.asr,
    },
    {
      id: 'ocr',
      name: 'OCR 环境（画面文字）',
      ok: Boolean(ocrPython),
      detail: ocrPython || '没找到 python 环境，画面文字无法识别',
      path: ocrPython,
      removable: false,
      removableWhy: '在插件目录外，这里不删',
      size: ocrPython ? dirStat(join(ocrPython, '..', '..')).bytes : 0,
      estimate: ESTIMATES.ocr,
    },
    {
      id: 'model',
      name: '转写模型（faster-whisper small）',
      ok: Boolean(model),
      detail: model || '没找到模型目录，本地转写不可用',
      path: model,
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
    path: CRED_FILE,
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
    credential: CRED_FILE,
  }
  const deleted = []
  const skipped = []
  for (const t of targets) {
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
  let step = ''
  let cred = ''
  while (tokens.length) {
    const t = tokens.shift()
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
      extra.push('--out', tokens.shift())
    } else if (t === '--ffmpeg' && tokens.length) {
      extra.push('--ffmpeg', tokens.shift())
    } else if (t === '--format' && tokens.length) {
      extra.push('--format', tokens.shift())
    } else if (t === '--fresh' || t === '--ocr' || t === '--poll' || t === '--check' || t === '--fast' || t === '--scene' || t === '--mark-seen') {
      extra.push(t)
    } else if (!t.startsWith('--')) {
      // 非选项 token 都当位置参数收着：BV / 搜索词 / 评论条数都可能出现在选项前后
      positionals.push(t)
    }
  }
  return { command, bv: positionals[0] || '', extra, step, cred }
}

async function lookup({ command, bv, extra = [] }) {
  if (!command || !COMMANDS.includes(command)) {
    return { ok: false, text: `用法：/bili <${COMMANDS.join('|')}> <BV> [--step 2] [--cred 凭证路径]` }
  }
  if (!['clean', 'login', 'hot'].includes(command) && !bv) {
    return { ok: false, text: `缺少 BV 号，用法：/bili ${command} <BV>` }
  }
  const args =
    command === 'clean'
      ? ['clean']
      : command === 'login'
        ? ['login', ...extra]
        : command === 'hot'
          ? ['hot', ...extra]
          : [command, bv, ...extra]
  const r = await runLook(args)
  // login 只生成二维码，真正的登录成功由面板 poll 写；命令层不记 lastRun，避免「生成成功」被读成「已登录」
  if (command !== 'login') writeLastRun(command, r.code)
  const text = (r.out || r.err || '').trim() || '（没有输出）'
  return { ok: r.code === 0, text }
}

function apply(ctx) {
  // 启动时按「天数 + 总量阈值」清一次缓存，不点按钮也不会无限涨
  try {
    const r = autoCleanCache()
    if (r.removed) ctx.logger?.info?.(`[dsh-bili-watch] 自动清理缓存 ${r.removed} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB`)
  } catch {}

  // ① 斜杠命令：人敲，确定性执行，不花推理 token
  ctx.commands.register({
    definitionId: 'dsh-bili-watch',
    name: 'bili',
    description: '看 B 站视频内容：字幕 → 本地转写 → 抽帧 OCR，输出最可信的一份文本',
    input: {
      hint: '<search 关键词|hot|peek|view|sub|comments|danmaku|asr|frames|sheet|substrip|ocr|text|login|clean> [BV] [--p N] [--step 2] [--days 3] [--order pubdate|click] [--cred 凭证路径] [--fast] [--scene] [--grid 3x3] [--format srt|json] [--out 文件]',
    },
    handler: async (invocation) => {
      const { command, bv, extra } = parseCommandLine(invocation?.rawInput)
      const r = await lookup({ command, bv, extra })
      return { kind: r.ok ? 'success' : 'error', text: r.text }
    },
  })

  // ①-b 单条链接软提示：只往消息流里加一条旁白，绝不替用户调用工具
  //     开关落 deps/ui-config.json 的 autoHint（DEFAULT_UI_CFG 见上）
  try {
    if (createUserMessage && uiCfg().autoHint !== false) {
      const hinted = new Map() // message.id → true，同一条消息只提示一次
      const hint = (msg) => {
        const { ok, text } = textOfUserMessage(msg)
        if (!ok) return null
        const r = matchSingleVideoLink(text)
        if (!r.hit) return null
        const line = r.kind === 'short'
          // 短链：look.mjs 不能展开，只让用户展开
          ? '[bili-watch] 这条消息只有一条 b23.tv 短链。本插件不能展开短链，先请用户把浏览器地址栏里的完整链接发过来；不要凭短链猜内容。'
          : `[bili-watch] 这条消息只有一条 B 站视频链接（BV ${r.bv}）。要读内容就调 bili_watch（command=peek 最便宜）；用户没说要看时不要自己跑。`
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
  if (defineTool && ctx.tools) {
  ctx.tools.register(defineTool({
    name: 'bili_watch',
    description:
      '用户给出 B 站视频链接 / BV 号，要我看、总结、判断这条视频讲了什么、有没有坑、值不值得看时使用。读取一个 B 站视频的内容材料（只读、匿名）。优先级：字幕 → 本地 ASR 转写 → 抽帧 OCR。command=peek 最便宜：只拿标题/简介/热评 + 均匀 5 帧，用来先判断是口播还是画面，再决定走 text 还是 ocr；command=text 会按优先级自动降级并返回最可信的一份文本（推荐）；view=元数据与热评；comments=评论区；asr=强制本地转写；frames=抽帧（可加 ocr=true 顺带识别画面文字）；ocr=抽帧并识别画面文字；sub=只要字幕；search=按关键词搜视频（配 days 可只留最近 N 天发布的，结果按播放量降序，用来看「这几天有什么值得看」）；hot=综合热门榜（B 站按热度排的前 N 条）；danmaku=弹幕热区（观众在哪一段反应最集中，判断名场面在哪）；sheet=把 N 帧拼成九宫格一张图（看图省 token）；substrip=把底部字幕逐段竖拼成一张图（硬字幕视频最省）。多 P 视频用 p 指定第几个分P（默认 P1）。拿到文本后由你负责理解与总结。',
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
        description: 'command=sub 时可选 srt 或 json（带官方时间戳）；command=text 时可选 json（含时间轴口径：字幕 exact，转写与 OCR 是估算）。不传默认纯文本。',
      },
      out: {
        type: 'string',
        description: 'command=sub/text 且传了 format 时，把结果写到这个文件路径；不传打印到标准输出。',
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
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '').slice(0, 24000) }],
    },
    execute: async (args) => {
      const extra = []
      if (typeof args.p === 'number' && Number.isInteger(args.p) && args.p > 0) extra.push('--p', String(args.p))
      if (typeof args.step === 'number' && Number.isFinite(args.step) && args.step > 0) extra.push('--step', String(args.step))
      if (args.ocr) extra.push('--ocr')
      if (args.fast) extra.push('--fast')
      if (args.scene) extra.push('--scene')
      if (typeof args.grid === 'string' && args.grid.trim()) extra.push('--grid', args.grid.trim())
      if (typeof args.days === 'number' && args.days > 0) extra.push('--days', String(Math.floor(args.days)))
      if (typeof args.limit === 'number' && args.limit > 0) extra.push('--limit', String(Math.floor(args.limit)))
      if (typeof args.format === 'string' && args.format.trim()) extra.push('--format', args.format.trim())
      if (typeof args.out === 'string' && args.out.trim()) {
        const out = args.out.trim()
        // 工具层是模型可调的：只允许写工作区内的相对路径，挡住绝对路径 / 盘符 / .. 与家目录
        if (/^([/\\]|[A-Za-z]:|~)|\.\./.test(out)) {
          return { ok: false, text: '--out 只接受工作区内的相对路径（不能用绝对路径、盘符、~ 或 ..）' }
        }
        extra.push('--out', out)
      }
      if (args.command === 'hot') {
        const r = await lookup({ command: 'hot', bv: '', extra })
        return { ok: r.ok, text: r.text }
      }
      const target = args.command === 'search' ? String(args.keyword ?? '').trim() : String(args.bv ?? '').trim()
      if (args.command === 'search' && !target) return { ok: false, text: 'search 需要 keyword 参数（要搜什么词）' }
      if (!target) return { ok: false, text: '缺少 BV 号或分享链接' }
      const r = await lookup({ command: args.command, bv: target, extra })
      return { ok: r.ok, text: r.text }
    },
  }))
  } else {
    console.warn('[dsh-bili-watch] 未找到 @deepseek-ai/dsh-tools，bili_watch 工具未注册（/bili 命令与插件面板不受影响）')
  }

  // ③ 设置页：读盘状态 + 清缓存（只读优先；唯一写操作是删本机抽帧缓存目录）
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/api/bili-watch',
          handler: async (req, res) => {
            try {
              const url = new URL(req.url, 'http://127.0.0.1')
              if (req.method === 'GET' && url.pathname === '/api/bili-watch/status') {
                const cleaned = autoCleanCache()
                return sendJson(res, 200, {
                  ok: true,
                  data: {
                    credential: credState(),
                    deps: depRows(),
                    cache: { ...dirStat(CACHE), ...cacheCfg(), lastAutoClean: cleaned },
                    lastRun: readLastRun(),
                    ui: uiCfg(),
                  },
                })
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/cache/clear') {
                const body = await readJsonBody(req)
                if (Number.isFinite(body?.days) || Number.isFinite(body?.maxMb)) {
                  writeCacheCfg(
                    Number.isFinite(body?.days) ? Math.max(1, body.days) : cacheCfg().days,
                    Number.isFinite(body?.maxMb) ? Math.max(100, body.maxMb) : cacheCfg().maxMb,
                  )
                }
                const before = dirStat(CACHE)
                try {
                  rmSync(CACHE, { recursive: true, force: true })
                } catch {}
                return sendJson(res, 200, { ok: true, data: { removed: before.files, bytes: before.bytes } })
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
                return sendJson(res, 200, { ok: true, data: next })
              }
              sendJson(res, 404, { ok: false, why: 'not found' })
            } catch (e) {
              sendJson(res, 500, { ok: false, why: String(e?.message || e) })
            }
          },
        }),
      'dsh-bili-watch: /api/bili-watch 设置页端点',
    )
  } catch (e) {
    try {
      ctx.logger?.info?.(`[dsh-bili-watch] 设置页端点没挂上：${e?.message ?? e}`)
    } catch {}
  }
}

export { apply, inject, name, parseCommandLine }
