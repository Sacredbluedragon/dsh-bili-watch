#!/usr/bin/env node
/**
 * fetch-deps.mjs —— dsh-bili-watch 可选依赖一键下载（Windows / Linux / macOS 同一份）
 *
 * 用法：
 *   node scripts/fetch-deps.mjs all
 *   node scripts/fetch-deps.mjs ytdlp --force
 *   node scripts/fetch-deps.mjs all --dry-run
 *   node scripts/fetch-deps.mjs all --mirror cn
 *   node scripts/fetch-deps.mjs all --proxy http://127.0.0.1:7890
 *   node scripts/fetch-deps.mjs all --no-proxy
 *   node scripts/fetch-deps.mjs where            # 只回答「装到哪」，不下载不建目录
 *   node scripts/fetch-deps.mjs lockcheck       # 只报告跨进程锁路径并试抢一次，不下载
 *   node scripts/fetch-deps.mjs lockcheck --hold=1500   # 持锁 1.5 秒，供并发自检
 *
 * 目标（可单独装，也可 all 全装）：
 *   ffmpeg  Windows：BtbN 静态构建（GPL）→ deps/ffmpeg.exe、deps/ffprobe.exe
 *           Linux：johnvansickle 静态包 → deps/ffmpeg、deps/ffprobe
 *           macOS：只提示 brew install ffmpeg（没有可用的静态包）
 *   ytdlp   deps/yt-dlp.exe（Windows）/ deps/yt-dlp（Linux）/ yt-dlp_macos（macOS）
 *   asr     建 deps/.venv-asr 并装 faster-whisper（需 Python 3.10+ 或 uv）
 *   ocr     建 deps/.venv-ocr 并装 rapidocr-onnxruntime
 *   model   预下载 faster-whisper-small 到 deps/.hf-home（约 464 MB；不装也能跑，首次转写会自动下）
 *   cuda    往 ASR 环境里装 GPU 运行库（cuBLAS + cuDNN + nvrtc）
 *   all     依次执行 ffmpeg / ytdlp / asr / ocr / model（不含 cuda，见下）
 *
 * 2026-11-02：本文件由 scripts/fetch-deps.ps1（801 行）+ scripts/fetch-deps.sh（382 行）合并而来。
 *   合并的理由不是「少两种语言」，是两份实现里有三处只有一边做对了，而用户只在自己那个平台上
 *   遇到其中一半：
 *     · **装完复验**：.sh 在 pip 返回 0 之后还会 `import <module>` 再验一次（守卫 C98 覆盖这点），
 *       .ps1 只在**入口**验（半成品陷阱），装完没验 → Windows 上 pip 返回 0 但
 *       import 失败时脚本打 ✓，等跑 ASR 才炸。合并后两个平台都复验。
 *     · **get-pip 引导**：.sh 处理「python3 -m venv 失败 / 没有 ensurepip」（Ubuntu 26.04 的
 *       python3.14 就没有），.ps1 没有这条路径。
 *     · **代理探测**：.ps1 会读 Windows 的 WinINet 系统代理，.sh 不会。
 *   还有一类收益是结构性的：.sh 里那些 `| head` / `grep -q` / pipefail 的 SIGPIPE 坑
 *   （见原文件 P2 注释）、.ps1 里 `$ErrorActionPreference='Stop'` 让原生命令写 stderr 就抛
 *   NativeCommandError 的坑，在 node 里**整个类别都不存在**——没有管道、没有全局错误策略。
 *
 * 说明：
 *   · 幂等：目标已存在默认跳过，--force 重下。
 *   · --dry-run 只打印将执行的命令，不下载不写盘。
 *   · 国内网络用 --mirror cn：GitHub 走 gh-proxy、PyPI 走清华、模型走 hf-mirror。
 *   · --gpu ask|yes|no：要不要装 CUDA 运行库（约 1.4 GB）。ask 会问一句（非交互时按 no）。
 *   · pip 包锁死四版本（能跑）：faster-whisper==1.2.1、av==15.1.0、
 *     ctranslate2==4.8.3（10-28 issue #2 P3-2：4.8.4 在部分机器加载模型即 0xC0000005 硬崩，
 *     自己没有显式依赖，是 faster-whisper 拖进来的，所以必须自己钉）、
 *     rapidocr-onnxruntime==1.2.3。yt-dlp 不锁版本，必须跟上游走。
 *   · 二进制不锁版本，但装完会把 ffmpeg -version 首行与 yt-dlp --version 记进 deps/last-bin.json。
 *   · --verify-hash：可选开关。传了就在下载完成后打印每个二进制的 SHA256（仓库暂不内置期望
 *     摘要，仅打印供人工比对，不据此失败）。
 *   · curl 强制 https（--proto =https --proto-redir =https），不允许明文 http 跳转。
 *   · 代理：-ProxyUrl > 环境变量 BILI_WATCH_PROXY > HTTP(S)_PROXY > Windows WinINet 注册表。
 *     探测到就写进进程级 HTTP_PROXY/HTTPS_PROXY（huggingface_hub 靠这个）并给 curl / pip 显式带
 *     --proxy。--no-proxy 强制直连；探测不到就按直连跑，不影响没开代理的机器。
 *   · Python：优先 uv（uv venv --python 3.12/3.13），其次 Windows 的 py 启动器
 *     3.13/3.12/3.11/3.10/3.14，最后 PATH 上的 python/python3；跳过 WindowsApps 应用商店存根。
 *   · 日志：每一步进度和失败原因 append 到 deps/download.log；面板「一键下载」的日志就是这个文件。
 *   · **deps 装在哪个目录由 lib/plugin-paths.mjs 决定**，与运行时（index.js / tools/look.mjs）
 *     是同一份代码，不是同一段注释。这条以前两边各写一份，判据差一截（一个判「目录存在」、
 *     一个判「有内容」），装到哪、读哪个 venv 会各说各话。
 */
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { createInterface } from 'node:readline'
import { resolveDepsDir, depsLockFile, DEPS_LOCK_STALE_MS } from '../lib/plugin-paths.mjs'
import { inspectModelHomes } from '../lib/model-integrity.mjs'
// C227-B：平台判定收敛到 lib/platform.mjs。
import { isMac, isWin } from '../lib/platform.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = isWin()
const IS_MAC = isMac()

// ── 参数 ────────────────────────────────────────────────────────
// 位置参数也收（旧 .sh 的用法 `bash fetch-deps.sh all`），因为 README 里两种写法都出现过。
const argv = process.argv.slice(2)
function opt(name, def = '') {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : def
}
const has = (name) => argv.includes(`--${name}`)

const TARGETS = ['all', 'ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'cuda', 'where', 'lockcheck']
const positional = argv.find((a) => !a.startsWith('--'))
const TARGET = opt('target', positional || 'all')
if (!TARGETS.includes(TARGET)) {
  console.error(`用法：node scripts/fetch-deps.mjs <${TARGETS.join('|')}> [--force] [--dry-run] [--mirror auto|cn|global]`)
  console.error('      where：只打印 deps 目录装在哪（不下载、不建目录）')
  process.exit(2)
}
const FORCE = has('force')
const DRY = has('dry-run')
const VERIFY_HASH = has('verify-hash')
const NO_PROXY = has('no-proxy')
const PROXY_ARG = opt('proxy')
const MIRROR = opt('mirror', 'auto')
if (!['auto', 'cn', 'global'].includes(MIRROR)) {
  console.error(`--mirror 只认 auto / cn / global，收到「${MIRROR}」`)
  process.exit(2)
}
const GPU = opt('gpu', 'ask')
if (!['ask', 'yes', 'no'].includes(GPU)) {
  console.error(`--gpu 只认 ask / yes / no，收到「${GPU}」`)
  process.exit(2)
}
const PYTHON_ARG = opt('python')
const IN_ALL = TARGET === 'all'

// ── deps 目录 ───────────────────────────────────────────────────
// 判据来自 lib/plugin-paths.mjs，与 index.js / tools/look.mjs 同一份代码。
//   这里只做一件事：把「结果来自哪一级」算出来给人看（排障时用户要知道装到哪去了）。
const DEPS = resolveDepsDir({ pluginRoot: ROOT, mkdirPref: !DRY && TARGET !== 'where' })
const PREF = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-watch', 'deps')
const LOCAL = join(ROOT, 'deps')
const DEPS_FROM = process.env.BILI_WATCH_DEPS
  ? 'BILI_WATCH_DEPS'
  : resolve(DEPS) === resolve(LOCAL)
    ? '包内（插件目录下的 deps 已有内容，包外还没有）'
    : resolve(DEPS) === resolve(PREF)
      ? existsSync(PREF)
        ? '包外（$DSH_HOME/bili-watch/deps，已存在）'
        : '包外（$DSH_HOME/bili-watch/deps，新建）'
      : '（未知来源）'

// 排障时要能看出装到哪去了，所以这一行固定打 stderr（stdout 留给进度）
console.error(`==> deps 目录：${DEPS}（来源：${DEPS_FROM}）`)
if (TARGET === 'where') {
  // 只回答「装到哪」，不建目录、不下载。
  //   必须在 mkdir 之前返回 —— 顺手建一个空的包外目录，会让「包内 deps 已有内容」的机器
  //   下次改用那个空目录，等于把已有 venv 和模型丢掉。
  // stdout 只给纯路径：`DEPS="$(node scripts/fetch-deps.mjs where)"` 要能直接拿到值。
  //   上面那行解释走 stderr —— 以前两个都走 stderr，README 里那条赋值其实一直拿到空串。
  console.log(DEPS)
  process.exit(0)
}
// lockcheck 只验锁、不下载，不许顺手建出 DEPS —— 那会改变 resolveDepsDir 的判据③，
// 把「包外还不存在」这个状态抹掉（判据 L 要在这个状态下量一次）。
if (!DRY && TARGET !== 'lockcheck') {
  try {
    mkdirSync(DEPS, { recursive: true })
  } catch {}
}

// ── 跨进程锁 ────────────────────────────────────────────────────
// issue #10 问题 3（2026-11-03）：宿主侧的 DOWNLOADING 表只在**一个进程的内存**里，
//   两个窗口 / 两个宿主实例各有一份，挡不住并发。所以锁必须落到磁盘：
//   .fetch-deps.lock 写 {pid, startedAt, target}；pid 还活着且没过期 = 别人在跑。
// 锁的**绝对路径**由 lib/plugin-paths.mjs 的
//   depsLockFile() 给，宿主侧后台迁移也调它。绝不能再把锁名拼进 DEPS 目录：
//   DEPS 是 resolveDepsDir() 的结果，会随迁移进度在包内/包外之间变，同一进程的两个
//   时刻算出两个锁路径，互斥就形同虚设（端到端实跑证实）。
const LOCK_FILE = depsLockFile()
// 2026-11-03 自审改的：原来 1 小时，且**先看时间再看 pid** —— 一个跑满 1 小时的下载
//   （模型 1 GB 起，慢线路 + 镜像限速很常见）会被判成「残留锁」，后来者直接删锁接管，
//   两个进程同时动 venv，正好是 issue #10 要修的那件事。现在 pid 活着就是 held，
//   时间只兜「pid 被复用」这一个极端：6 小时够任何一次 all 跑完。
const LOCK_STALE_MS = DEPS_LOCK_STALE_MS // 单点在 lib/plugin-paths.mjs（C48-P2-1），别再写第二份字面量
/**
 * 纯函数：现有锁算不算「有人正在跑」。抽出来是为了能真跑断言（C145），不靠读源码猜。
 * 判定顺序：没有 pid -> free；pid 活着 -> held（超过 6 小时才翻成 stale，兜 pid 复用）；
 *   pid 不在了 -> stale（崩溃残留，立刻可接管）。
 * @param {{pid?:number, startedAt?:number}|null} cur 读到的锁内容（没有锁传 null）
 * @param {{now?:number, staleMs?:number, alive?:(pid:number)=>boolean}} opts 测试可注入
 * @returns {'free'|'stale'|'held'}
 */
function lockState(cur, opts = {}) {
  if (!cur || !Number.isFinite(cur.pid)) return 'free'
  const now = opts.now ?? Date.now()
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const startedAt = Number.isFinite(cur.startedAt) ? cur.startedAt : 0
  const alive = opts.alive ?? ((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      // EPERM = 进程在、只是没权限问；其它（ESRCH）才算不在了
      return e && e.code === 'EPERM'
    }
  })
  if (!alive(cur.pid)) return 'stale'
  // 活着 + 超时 = 只可能是 pid 被别的进程复用了（下载再慢也不该跑 6 小时）
  if (startedAt && now - startedAt > staleMs) return 'stale'
  return 'held'
}
function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
  } catch {
    return null
  }
}
/** 只删自己写的锁：别人的锁不能顺手清掉。 */
function releaseLock() {
  try {
    const cur = readLock()
    if (cur && cur.pid === process.pid) rmSync(LOCK_FILE, { force: true })
  } catch {}
}
/**
 * 三行拒绝原因只留一份：held（启动时就看见别人的锁）与 EEXIST（并发抢锁输了）共用。
 * cur 可能是 null —— 锁文件在但内容读不出来（写了一半 / 损坏）时，pid 显示 ? 而不是
 * undefined，免得「比不报更误导」。
 */
function printLockBusy(cur) {
  const since = cur?.startedAt ? new Date(cur.startedAt).toLocaleString() : '未知时间'
  const pid = Number.isFinite(cur?.pid) ? cur.pid : '?'
  console.error(`✗ 已经有一个安装进程在跑（pid=${pid}，目标 ${cur?.target || '?'}，开始于 ${since}）`)
  console.error('  等它结束再重试。确认它已经不在了的话，删掉这个文件后重来：')
  console.error(`  ${LOCK_FILE}`)
}
function acquireLock() {
  const cur = readLock()
  const st = lockState(cur)
  if (st === 'held') {
    printLockBusy(cur)
    process.exit(3)
  }
  if (st === 'stale') {
    try {
      rmSync(LOCK_FILE, { force: true })
    } catch {}
    console.log('    清掉了上次残留的锁')
  }
  try {
    // wx = 原子独占创建。原来无条件覆盖写：两个进程同时读到「没锁」或都判 stale 时，
    // 两边都删、两边都写，后写的赢，前一个还以为自己拿到了锁。
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now(), target: TARGET }), { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    if (e?.code === 'EEXIST') {
      // 重读再报：刚才 readLock 看到的那份可能已经过期或是空的，直接用旧变量会报 pid=undefined。
      printLockBusy(readLock())
      process.exit(3)
    }
    throw e
  }
  process.on('exit', releaseLock)
}
// dry-run 不抢锁：它不写盘，也不该被别人的下载挡住（否则「只想看一眼」就跑不了）
// lockcheck：只回答「锁落在哪 / 别的进程能不能拿到」，不下载、不建 DEPS。
//   stdout 第一行给锁的绝对路径（判据 L 用它做下载侧取值）；--hold=<ms> 持锁一段时间，
//   好让判据 M 起第二个进程验「被占用」。两个进程都走生产 acquireLock，不是复刻。
if (TARGET === 'lockcheck') {
  console.log(LOCK_FILE)
  if (!DRY) {
    try { mkdirSync(dirname(LOCK_FILE), { recursive: true }) } catch {}
    acquireLock()
  }
  const holdMs = Number(opt('hold')) || 0
  // 必须**同步**阻塞再退出：只挂 setTimeout 的话代码会继续落到下面的 acquireLock /
  // 下载逻辑，第二次抢到自己刚写的锁，报「已经有一个安装进程在跑」并把进程提前放掉。
  if (holdMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs)
  process.exit(0)
}
if (!DRY) acquireLock()

// ── 日志 ────────────────────────────────────────────────────────
const LOG_FILE = join(DEPS, 'download.log')
function log(msg) {
  if (DRY) return
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch {}
}
const step = (m) => {
  console.log(`==> ${m}`)
  log(`==> ${m}`)
}
const skip = (m) => {
  console.log(`    ${m}（已存在，跳过；--force 重下）`)
  log(`跳过：${m}（已存在）`)
}

// ── 小工具 ──────────────────────────────────────────────────────
function mb(n) {
  return `${Math.round((n / 1024 / 1024) * 10) / 10} MB`
}
function dirSize(p) {
  let total = 0
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name)
      try {
        if (e.isDirectory()) total += dirSize(f)
        else total += statSync(f).size
      } catch {}
    }
  } catch {}
  return total
}
/** 跑一条命令，返回 { code, out, err }。**不用 shell**：参数数组直接给，没有引号/转义/管道。 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: opts.env || process.env,
    cwd: opts.cwd,
    timeout: opts.timeout ?? 0,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: r.status === null ? -1 : r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
    error: r.error,
  }
}
/** 外部命令的全部命中路径。Windows 的 where 会返回多行（PATH 里每个命中一行），POSIX 的 which 一般一行。 */
function whichAll(cmd) {
  const probe = IS_WIN ? 'where' : 'which'
  const r = run(probe, [cmd])
  if (r.code !== 0) return []
  return r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}
function which(cmd) {
  // 2026-11-02（发版前审查）：原来只取首行。Windows 上 `where python` 经常是
  //   「应用商店存根在前、真解释器在后」，只取首行等于把真的漏掉——systemPython 的存根
  //   跳过逻辑只看到一个存根，最后报「只找到存根」，用户明明装了 Python 也用不了。
  //   需要多命中的调用方改用 whichAll。
  return whichAll(cmd)[0] || ''
}

// ── 代理（G-01，2026-10-29）─────────────────────────────────────
// curl 不读 WinINet 的系统代理，pip / huggingface_hub 只认环境变量，于是「开了系统代理但
// GitHub 直连超时」的机器上一键下载必然静默失败。优先级：
//   --proxy > BILI_WATCH_PROXY > HTTP(S)_PROXY > 注册表 WinINet
function formatProxy(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  // 注册表可能是按协议的列表：http=...;https=...
  if (/(?:^|;)\s*https?\s*=/.test(s)) {
    const map = {}
    for (const part of s.split(';')) {
      const m = part.match(/^\s*(https?)\s*=\s*(\S+)\s*$/)
      if (m) map[m[1].toLowerCase()] = m[2]
    }
    s = map.https || map.http || ''
    if (!s) return ''
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `http://${s}`
  return s.replace(/\/+$/, '')
}
function wininetProxy() {
  if (!IS_WIN) return ''
  try {
    const k = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const en = run('reg', ['query', k, '/v', 'ProxyEnable'])
    if (en.code !== 0 || !/0x1\b/.test(en.out)) return ''
    const sv = run('reg', ['query', k, '/v', 'ProxyServer'])
    if (sv.code !== 0) return ''
    const m = sv.out.match(/ProxyServer\s+REG_SZ\s+(.+)/)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}
function resolveProxy() {
  if (NO_PROXY) return ''
  if (PROXY_ARG) {
    const p = formatProxy(PROXY_ARG)
    if (!p) throw new Error(`代理地址看不懂：${PROXY_ARG}（示例：--proxy http://127.0.0.1:7890）`)
    return p
  }
  if (process.env.BILI_WATCH_PROXY) {
    const p = formatProxy(process.env.BILI_WATCH_PROXY)
    if (p) return p
  }
  for (const n of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const p = formatProxy(process.env[n])
    if (p) return p
  }
  return formatProxy(wininetProxy())
}
let PROXY = ''
try {
  PROXY = resolveProxy()
} catch (e) {
  console.error(`✗ ${e.message}`)
  process.exit(2)
}
// pip / huggingface_hub / uv 只认这些环境变量；curl 认 http_proxy，但我们另外显式传 --proxy，双保险
if (PROXY) {
  for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) process.env[n] = PROXY
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    process.env.no_proxy = 'localhost,127.0.0.1,::1'
  }
}
if (PROXY) console.log(`    代理：${PROXY}（curl/pip 显式 --proxy；huggingface_hub 走 HTTP(S)_PROXY）`)
else if (NO_PROXY) console.log('    代理：--no-proxy，强制直连')
else console.log('    代理：未探测到（直连）')

log(`==== fetch-deps 开始：Target=${TARGET} Mirror=${MIRROR} DryRun=${DRY}`)
log(`依赖目录：${DEPS}`)
log(`代理：${PROXY || '未配置（直连）'}`)

// ── 镜像（C-01 / C-02，2026-10-29）──────────────────────────────
let USE_CN = MIRROR === 'cn' || (MIRROR === 'auto' && process.env.BILI_WATCH_MIRROR === 'cn')
/** 裸 TCP 探测：国内用户跑默认命令时 github / huggingface 直连会卡到超时，这里 1.5 秒决定要不要切镜像。 */
function tcpReachable(host, port = 443) {
  return new Promise((ok) => {
    const s = new net.Socket()
    let done = false
    const fin = (v) => {
      if (done) return
      done = true
      try {
        s.destroy()
      } catch {}
      ok(v)
    }
    s.setTimeout(1500)
    s.once('connect', () => fin(true))
    s.once('error', () => fin(false))
    s.once('timeout', () => fin(false))
    s.connect(port, host)
  })
}
if (!USE_CN && MIRROR === 'auto' && !process.env.BILI_WATCH_MIRROR && !DRY && !PROXY) {
  // 有代理就别猜——代理能出去就是 global，误切镜像反而慢
  if (!(await tcpReachable('huggingface.co')) && (await tcpReachable('hf-mirror.com'))) {
    USE_CN = true
    console.log('    探测到 huggingface.co 不可达、hf-mirror.com 可达，自动切国内镜像（要直连请加 --mirror global）')
  }
}
const GH_PROXY = USE_CN ? 'https://gh-proxy.com/' : ''
const PY_INDEX = USE_CN ? 'https://pypi.tuna.tsinghua.edu.cn/simple' : 'https://pypi.org/simple'
// 模型镜像默认跟 tools/look.mjs 对齐：运行时首次自动下载写死 hf-mirror.com，预下载也走同一个，
//   否则国内等于「预下载这条路是摆设」。只有显式 --mirror global 才直连 huggingface.co。
const HF_ENDPOINT = MIRROR === 'global' ? 'https://huggingface.co' : 'https://hf-mirror.com'

// ── 下载（E-06 / G-01）─────────────────────────────────────────
// 断点续传：开下之前不删 .part，用 curl -C - 续；服务器不支持 Range（curl 非 0）就删掉从头下一次。
function curlBin() {
  if (!IS_WIN) return 'curl'
  const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
  return existsSync(sys) ? sys : 'curl.exe'
}
/**
 * Windows 上必须用 System32 的 bsdtar（绝对路径），不能用裸 `tar`。
 *   2026-11-02 真跑踩到：Git Bash 里 PATH 上有 GNU tar（/usr/bin/tar），裸 `tar -xf x.zip -C C:\...`
 *   被 GNU tar 解析成「连到远程主机 C」—— 报 `tar: Cannot connect to C: resolve failed`。
 *   而 System32\tar.exe 是 bsdtar，既能解 zip，也认 Windows 路径。判据只认这一个。
 */
function tarBin() {
  if (!IS_WIN) return 'tar'
  const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  if (existsSync(sys)) return sys
  throw new Error(`找不到 ${sys}（Windows 10 1803+ 自带 bsdtar）。请手动解压 ffmpeg.zip 或用系统包管理器装 ffmpeg。`)
}
function curlBase() {
  const a = ['-L', '--fail', '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '--connect-timeout', '20']
  if (PROXY) a.push('--proxy', PROXY)
  return a
}
// 把「正在下的那个 .part 在哪」写成独立状态文件，面板据此
//   statSync 出实时字节数。为什么不写 download.log：那是 append 流水，要取最后一条、
//   还会累积旧行，而且里面的体积是下载**完**才写的；为什么不让面板自己猜 .part 路径：
//   pip / huggingface 那几项根本没有 .part，猜出来就是假进度。
const PART_STATE = join(DEPS, '.download-part.json')
function writePartState(v) {
  try {
    if (v) writeFileSync(PART_STATE, JSON.stringify(v), 'utf8')
    else rmSync(PART_STATE, { force: true })
  } catch {}
}
/**
 * 下载一个文件。
 * @param {string} url
 * @param {string} out 落地文件名
 * @param {string} label 给人看的名字（写日志用）
 * @param {string} [depId] 面板上对应那一行的 id（ffmpeg / ytdlp / …）。
 *   **只有会写 .part 的大文件才传**：传了面板才敢把字节数挂到那一行上；
 *   不传（如 get-pip.py 那 2 MB）就是「没有进度可报」，不许借用别的行的估算体积当分母。
 */
function download(url, out, label, depId = '') {
  const tmp = `${out}.part`
  if (DRY) {
    const px = PROXY ? ` --proxy "${PROXY}"` : ''
    console.log(`    [dry-run] curl -L --fail --proto =https --proto-redir =https${px} -C - -o "${tmp}" "${url}"`)
    return
  }
  const via = PROXY ? `代理 ${PROXY}` : '直连'
  log(`下载 ${label}（${via}）：${url}`)
  // 状态文件在 curl 起来之前写：面板 8 秒一轮，写晚了第一轮就看不到这一项。
  //   dep 为空串表示「这一项没有可挂的行」，面板不会去猜。
  writePartState({ dep: depId, part: tmp, out, label, url, at: Date.now(), pid: process.pid })
  const curl = curlBin()
  let r
  if (existsSync(tmp)) {
    console.log(`    发现上次没下完的 .part（${mb(statSync(tmp).size)}），续传 ${label} ...`)
    r = run(curl, [...curlBase(), '-C', '-', '-o', tmp, url], { timeout: 0 })
    if (r.code !== 0) {
      console.log('    续传失败（服务器可能不支持 Range），删掉从头重下')
      log(`续传失败（curl 退出码 ${r.code}），删掉 .part 从头重下 ${label}`)
      try {
        rmSync(tmp, { force: true })
      } catch {}
      r = run(curl, [...curlBase(), '-o', tmp, url], { timeout: 0 })
    }
  } else {
    console.log(`    下载 ${label} ...`)
    r = run(curl, [...curlBase(), '-o', tmp, url], { timeout: 0 })
  }
  if (r.code !== 0 || !existsSync(tmp)) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {}
    let hint = `curl 退出码 ${r.code}`
    if (r.error) hint += `（${r.error.message}）`
    if (!PROXY) hint += '；如果这台机器要走代理，试 --proxy 或检查 --no-proxy'
    log(`下载失败 ${label}（${hint}）：${url}`)
    // 失败时清掉状态：.part 已被删，留着这条只会让面板显示一个永远不动的进度。
    writePartState(null)
    throw new Error(`下载失败：${url}（${hint}）`)
  }
  const size = statSync(tmp).size
  try {
    rmSync(out, { force: true })
  } catch {}
  copyFileSync(tmp, out)
  try {
    rmSync(tmp, { force: true })
  } catch {}
  writePartState(null) // 完成了：状态文件不留，面板随之收起这一行
  log(`下载完成 ${label}（${mb(size)}）-> ${out}`)
  if (VERIFY_HASH) {
    const h = createHash('sha256').update(readFileSync(out)).digest('hex')
    console.log(`    SHA256(${label}) = ${h}`)
  }
}

// ── ffmpeg ─────────────────────────────────────────────────────
function ensureFfmpeg() {
  const exe = join(DEPS, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')
  const probe = join(DEPS, IS_WIN ? 'ffprobe.exe' : 'ffprobe')
  if (existsSync(exe) && existsSync(probe) && !FORCE) return skip(IS_WIN ? 'deps\\ffmpeg.exe' : 'deps/ffmpeg')

  if (IS_MAC) {
    step('ffmpeg：macOS 请用系统包管理器安装')
    console.log('    brew install ffmpeg')
    console.log(`    装好后 look.mjs 会从 PATH 找到它（也可以自己放到 ${DEPS}/ffmpeg）。`)
    return
  }
  if (!IS_WIN) return ensureFfmpegLinux(exe, probe)

  step('ffmpeg（Windows 静态构建，BtbN GPL）')
  const url = GH_PROXY + 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'
  const zip = join(tmpdir(), 'bili-watch-ffmpeg.zip')
  try {
    download(url, zip, 'ffmpeg-master-latest-win64-gpl.zip', 'ffmpeg')
  } catch (e) {
    // 80 MB 的 BtbN zip 在 GitHub 直连不稳时大概率断流；给替代路径，别让安装卡死在这
    console.warn('ffmpeg 下载失败。可选替代路径：')
    console.log(`  1) 手动下载 ffmpeg.exe 放进 ${DEPS} 后重跑本脚本（会自动跳过）`)
    console.log('  2) 已有 ffmpeg 时设环境变量 BILI_WATCH_FFMPEG = <ffmpeg.exe 路径>')
    console.log('  3) 换镜像重试：--mirror cn（走 gh-proxy）')
    throw new Error(`ffmpeg 未安装（见上面的替代路径）：${e.message}`)
  }
  if (DRY) return
  const tmpDir = join(tmpdir(), 'bili-watch-ffmpeg-bin')
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  mkdirSync(tmpDir, { recursive: true })
  // Windows 10 1803+ 自带 bsdtar，能解 zip；不额外引第三方解压库（这个包只该有 qrcode 一个依赖）
  const t = run(tarBin(), ['-xf', zip, '-C', tmpDir])
  if (t.code !== 0) throw new Error(`解压 ffmpeg.zip 失败：${t.err || t.code}（需要系统自带 tar，Win10 1803+ 有）`)
  const found = findFirst(tmpDir, 'ffmpeg.exe')
  if (!found) throw new Error('解压后没找到 ffmpeg.exe')
  copyFileSync(found, exe)
  // ffprobe：预留（look.mjs 暂不引用），解压顺手带上
  const pr = findFirst(tmpDir, 'ffprobe.exe')
  if (pr) {
    try {
      copyFileSync(pr, probe)
    } catch {}
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(zip, { force: true })
  } catch {}
  // 2026-11-02（发版前审查，E1-01 同族）：cp 成功 ≠ 跑得起来。Windows 侧原来直接打 ✓，
  //   而 look.mjs 的 resolveFfmpeg 会真试跑 -version 判定「没装」——脚本说装好了、运行时说没装，
  //   用户看到的就是「装完还是用不了」。与 Linux 分支（下方 ffmpeg 段）对齐，只认 ffmpeg 自己的退出码。
  const v = run(exe, ['-version'])
  if (v.code !== 0) {
    console.error(`✗ 文件已放到 ${exe}，但 ffmpeg -version 跑不起来（rc=${v.code}：被安全策略拦 / 架构不对 / 文件不完整）`)
    console.error('  这不是「没装上」：文件在，但系统不让它执行。查杀软与组策略，确认解出来的是 win64 版。')
    console.error('  改用系统包管理器：winget install Gyan.FFmpeg，或 scoop install ffmpeg')
    throw new Error('ffmpeg 装上了但跑不起来')
  }
  const ver = v.out.split(/\r?\n/)[0] || '（未打出横幅，但退出码为 0）'
  console.log(`    ✓ ${exe}（${ver}）`)
}

/** 在 dir 下递归找第一个文件名等于 name 的文件（限 3 层，够用且不会扫爆临时目录）。 */
function findFirst(dir, name, depth = 0) {
  if (depth > 3) return ''
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === name) return p
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = findFirst(join(dir, e.name), name, depth + 1)
      if (r) return r
    }
  }
  return ''
}

/**
 * Linux 静态包（issue #6 坑 2，2026-10-31）：以前这里只打印「请用系统包管理器安装」，
 *   WSL / 容器 / 无 sudo 场景直接死路，面板 ffmpeg 那行永远不可用。
 *   两条硬要求：解压前必须预校验（镜像/代理返回 HTML 错误页时 curl 可能照样 exit 0），
 *   校验失败要说清「拿到了什么」。
 */
function ensureFfmpegLinux(exe, probe) {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : ''
  if (!arch) {
    console.error(`✗ 静态包只提供 amd64 / arm64，本机是 ${process.arch}`)
    console.error('  请用系统包管理器装：Debian/Ubuntu: sudo apt install ffmpeg')
    throw new Error('ffmpeg 未安装（架构不在静态包覆盖范围）')
  }
  const url = process.env.BILI_WATCH_FFMPEG_URL || `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch}-static.tar.xz`
  step(`ffmpeg（静态包，约 40 MB）：${url}`)
  const tmp = join(tmpdir(), `bili-watch-ffmpeg-${process.pid}`)
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
  mkdirSync(tmp, { recursive: true })
  const tgz = join(tmp, 'ffmpeg.tar.xz')
  try {
    download(url, tgz, 'ffmpeg 静态包', 'ffmpeg')
  } catch {
    console.error(`✗ 下载 ffmpeg 失败：${url}`)
    console.error(`  离线/被墙可换源：BILI_WATCH_FFMPEG_URL=<镜像地址> node scripts/fetch-deps.mjs ffmpeg`)
    console.error('  或直接用系统包管理器：sudo apt install ffmpeg（Debian/Ubuntu）')
    throw new Error('ffmpeg 未安装（下载失败）')
  }
  if (DRY) return
  // tar -t 预校验：区分「归档本身不对（HTML / 截断）」和「本机 tar 解不了 xz」两种失败
  //
  //   2026-11-02（合一）：原来这里写的是裸 `'tar'`，与上面 ZIP 分支的 `tarBin()` 不一致 ——
  //   Windows 上裸 `tar` 走 PATH 命中 Git Bash 的 **GNU tar**（它把 `C:\` 当远程主机，
  //   报 `tar: Cannot connect to C: resolve failed`），于是「归档坏了」和「本机 tar 不行」
  //   混成同一个失败，用户被指去装 xz-utils 而真因不在这里。统一用 tarBin()。
  const list = run(tarBin(), ['-tJf', tgz])
  if (list.code !== 0 || !list.out) {
    const e = list.err || ''
    if (/xz.*not found|Cannot exec|xz: /i.test(e)) {
      console.error('✗ 本机 tar 解不了 .tar.xz（缺 xz 解压器），不是下载的问题')
      console.error('  先装：sudo apt install xz-utils（Debian/Ubuntu） / sudo dnf install xz（Fedora）')
    } else {
      console.error('✗ 下载到的不是有效的 .tar.xz（xz 解不开或不是 tar 归档）。前 200 字节：')
      try {
        console.error(readFileSync(tgz).subarray(0, 200).toString('utf8').replace(/[^\x20-\x7e\n]/g, '.'))
      } catch {}
    }
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
    throw new Error('ffmpeg 未安装（归档校验失败）')
  }
  const missing = ['ffmpeg', 'ffprobe'].filter((n) => !new RegExp(`(^|/)${n}$`, 'm').test(list.out))
  if (missing.length) {
    console.error(`✗ 归档里没有 ${missing.join(' ')}（下到的可能不是官方静态包）。归档前 10 项：`)
    console.error(list.out.split(/\r?\n/).slice(0, 10).join('\n'))
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
    throw new Error('ffmpeg 未安装（归档结构不对）')
  }
  const x = run(tarBin(), ['-xJf', tgz, '-C', tmp])
  if (x.code !== 0) {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
    throw new Error(`解压失败（磁盘满？）：${x.err || x.code}`)
  }
  const src = dirname(findFirst(tmp, 'ffmpeg') || '')
  if (!src || src === '.') {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
    throw new Error('解压后没找到 ffmpeg 可执行文件（归档结构变了？）')
  }
  copyFileSync(join(src, 'ffmpeg'), exe)
  copyFileSync(join(src, 'ffprobe'), probe)
  chmodSync(exe, 0o755)
  chmodSync(probe, 0o755)
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
  // E1-01 同族：脚本说「成功」必须由产物证明，不能由 cp 的退出码推导。
  //   被安全策略拦、架构不对、解出半截文件时，文件在、跑不起来——这时打 ✓，运行时
  //   （look.mjs 的 resolveFfmpeg 会真试跑 -version）判定「没装」，两边又对不上。
  //   只认 ffmpeg 自己的退出码；stderr 上说什么都不能证明「跑得起来」。
  const v = run(exe, ['-version'])
  if (v.code !== 0) {
    console.error(`✗ 文件已放到 ${exe}，但 ffmpeg -version 跑不起来（rc=${v.code}：被安全策略拦 / 架构不对 / 文件不完整）`)
    console.error('  这不是「没装上」：文件在，但系统不让它执行。查 mount 的 noexec、SELinux、架构是否对得上。')
    console.error('  改用系统包管理器：sudo apt install ffmpeg（Debian/Ubuntu）')
    throw new Error('ffmpeg 装上了但跑不起来')
  }
  const ver = v.out.split(/\r?\n/)[0] || '（未打出横幅，但退出码为 0）'
  console.log(`    ✓ ${exe}（${ver}）`)
}

// ── yt-dlp ─────────────────────────────────────────────────────
function ensureYtdlp() {
  const exe = join(DEPS, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
  if (existsSync(exe) && !FORCE) return skip(IS_WIN ? 'deps\\yt-dlp.exe' : 'deps/yt-dlp')
  step(IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
  const base = IS_MAC ? 'yt-dlp_macos' : IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'
  const url = `${GH_PROXY}https://github.com/yt-dlp/yt-dlp/releases/latest/download/${base}`
  download(url, exe, base, 'ytdlp')
  if (DRY) return
  if (!IS_WIN) chmodSync(exe, 0o755)
  console.log(`    ✓ ${exe}`)
}

// ── Python 选择（G-02，2026-10-29）─────────────────────────────
// 顺序：--python > uv 管的 3.12/3.13（uv venv 可离线）> Windows py 启动器 3.13/3.12/3.11/3.10/3.14
//   > PATH 上的 python/python3。WindowsApps 存根一律跳过。
// 2026-10-30 更正：3.14 从「硬拒」改成「排在最后」——那个「3.14 没有 onnxruntime wheel」的
//   前提已不成立（3.14.6 的 venv 里 onnxruntime 1.31.1 能 import，ocr 真跑通）。
function pyOk(v) {
  return /^3\.(1[0-4])$/.test(String(v).trim())
}
function pyVersion(exe) {
  const r = run(exe, ['-c', "import sys;print('%d.%d'%sys.version_info[:2])"])
  return r.code === 0 ? r.out.trim() : ''
}
function pyExeOf(exe) {
  const r = run(exe, ['-c', 'import sys;print(sys.executable)'])
  return r.code === 0 ? r.out.trim() : ''
}
function uvPath() {
  const w = which('uv')
  if (w && existsSync(w)) return w
  const cands = []
  if (process.env.USERPROFILE) cands.push(join(process.env.USERPROFILE, '.local', 'bin', 'uv.exe'))
  if (process.env.LOCALAPPDATA) cands.push(join(process.env.LOCALAPPDATA, 'Programs', 'uv', 'uv.exe'))
  cands.push(join(homedir(), '.local', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv')
  for (const p of cands) if (existsSync(p)) return p
  return ''
}
function systemPython() {
  let sawStub = false
  // Windows 的 py 启动器：探测「没装的版本」时会往 stderr 写 [ERROR]，
  //   在 PS 里那会让 $ErrorActionPreference='Stop' 直接抛（issue #7）；node 没这个问题，只看 rc。
  const launcher = IS_WIN ? which('py') : ''
  if (launcher) {
    for (const v of ['3.13', '3.12', '3.11', '3.10', '3.14']) {
      const r = run(launcher, [`-${v}`, '-c', 'import sys;print(sys.executable)'])
      if (r.code === 0 && r.out && existsSync(r.out.trim())) return r.out.trim()
    }
  }
  for (const c of IS_WIN ? ['python', 'python3'] : ['python3', 'python']) {
    for (const exe of whichAll(c)) {
      // E-05（2026-10-29）：Windows「应用执行别名」会在 PATH 放一个 python.exe 存根
      //   （...\Microsoft\WindowsApps\python.exe），不报错也不给版本，跑起来弹商店或 9009 退出。
      if (/\\WindowsApps\\/i.test(exe)) {
        sawStub = true
        console.log(`    跳过应用商店的 python 存根：${exe}`)
        continue
      }
      const v = pyVersion(exe)
      if (!pyOk(v)) continue
      const real = pyExeOf(exe)
      if (real && existsSync(real)) return real
    }
  }
  if (sawStub) {
    throw new Error('只找到 Windows 应用商店的 Python 存根（WindowsApps\\python.exe），它不是真的解释器。请装 uv 或 Python 3.12，或用 --python 指定解释器路径。')
  }
  throw new Error('找不到 Python 3.10–3.14。请装 uv 或 Python 3.12，或用 --python 指定解释器路径。')
}
let PY_PLAN = null
/** 返回 { mode:'uv'|'python', version, uv, exe, desc }，整个脚本只判一次。 */
function pyPlan() {
  if (PY_PLAN) return PY_PLAN
  if (PYTHON_ARG) {
    if (!existsSync(PYTHON_ARG)) throw new Error(`指定的 Python 不存在：${PYTHON_ARG}`)
    const v = pyVersion(PYTHON_ARG)
    if (!v) throw new Error(`指定的 Python 跑不起来：${PYTHON_ARG}`)
    if (!pyOk(v)) throw new Error(`指定的 Python 是 ${v}，需要 3.10–3.14`)
    PY_PLAN = { mode: 'python', version: v, uv: '', exe: PYTHON_ARG, desc: `--python 指定的 Python ${v}` }
    return PY_PLAN
  }
  const uv = uvPath()
  if (uv) {
    for (const v of ['3.12', '3.13']) {
      const r = run(uv, ['python', 'find', v])
      if (r.code === 0) {
        PY_PLAN = { mode: 'uv', version: v, uv, exe: '', desc: `uv 的 Python ${v}（${uv}）` }
        return PY_PLAN
      }
    }
    PY_PLAN = { mode: 'uv', version: '3.12', uv, exe: '', desc: `uv（Python 3.12，本机没有时按需下载）` }
    return PY_PLAN
  }
  const exe = systemPython()
  PY_PLAN = { mode: 'python', version: '', uv: '', exe, desc: `系统 Python（${exe}）` }
  return PY_PLAN
}

// ── venv ───────────────────────────────────────────────────────
function venvPy(venv) {
  return IS_WIN ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
}
/**
 * 半成品 venv 不用递归批量删——会撞上用户的删除守卫（issue #3）。改成改名留档。
 * M-03（2026-10-29）：以前只改名不清理，反复失败会攒出好几个 xxx.old-*（每个 1–2 GB）。
 *   改名之前先清上一次留下的 .old-*——那是我们自己造的垃圾，不是用户的文件。
 */
function moveSemiVenv(venv) {
  if (!existsSync(venv)) return
  const leaf = venv.split(sep).pop()
  const parent = dirname(venv)
  try {
    const olds = readdirSync(parent).filter((n) => n.startsWith(`${leaf}.old-`))
    let freed = 0
    for (const n of olds) {
      const p = join(parent, n)
      try {
        const sz = dirSize(p)
        rmSync(p, { recursive: true, force: true })
        freed += sz
      } catch (e) {
        console.log(`    ! 旧的半成品目录删不掉：${n}（${e.message}）`)
        console.log(`      可手动删除：${p}`)
      }
    }
    if (freed > 0) console.log(`    已清掉上一次的半成品目录，回收 ${mb(freed)}`)
  } catch {}
  const dst = `${leaf}.old-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  try {
    renameSync(venv, join(parent, dst))
    console.log(`    半成品 venv 已改名为 ${dst}（确认无用后可手动删）`)
  } catch (e) {
    console.log(`    ! 半成品 venv 改名失败：${e.message}`)
    // issue #10 问题 3：目录被占着（另一个进程还在写）时**不许继续在原目录上建 venv**。
    //   原来这里只打一行就往下走，而 `python -m venv` 不会清掉已有文件 —— 最后留下一个
    //   装了一半的环境，用户看到的是「import faster_whisper 失败」，与真实原因隔了一层。
    //   EPERM / EBUSY 单拎出来：这俩就是「现在别动」，直接把话说到位。
    if (e && (e.code === 'EPERM' || e.code === 'EBUSY')) {
      throw new Error(`venv 目录正被占用（${e.code}），可能有另一个安装进程还在跑。等它结束后重试，不要在这个状态下继续装`)
    }
    console.log(`      可手动删除：${venv}`)
  }
}
/** pip 镜像失败自动回退官方 PyPI（issue #3：镜像同步可能晚于 PyPI）。uv 走 `uv pip`，不认 --proxy 参数。 */
function pipInstall(py, args) {
  const plan = pyPlan()
  const proxyArgs = PROXY && plan.mode !== 'uv' ? ['--proxy', PROXY] : []
  if (plan.mode === 'uv') {
    // uv 没有 --proxy 参数（只认 HTTP_PROXY/HTTPS_PROXY 环境变量）；而且 uv pip install 自带
    //   install 子命令，要把调用方传的 'install' 去掉，否则 uv 会把 install 当包名解析
    //   （uv pip install install rapidocr-onnxruntime → No solution found）。
    const rest = args.slice(1)
    log(`uv pip install ${rest.join(' ')}（--python ${py}）`)
    let r = run(plan.uv, ['pip', 'install', '--python', py, ...rest, '--index-url', PY_INDEX])
    if (r.code === 0) return r
    if (PY_INDEX === 'https://pypi.org/simple') return r
    console.log(`    ! 镜像装不上（${PY_INDEX}），改走官方 PyPI 重试`)
    log(`uv pip 镜像失败（${PY_INDEX}），改走官方 PyPI`)
    return run(plan.uv, ['pip', 'install', '--python', py, ...rest, '--index-url', 'https://pypi.org/simple'])
  }
  log(`pip install ${args.join(' ')}（${py}）`)
  let r = run(py, ['-m', 'pip', ...args, ...proxyArgs, '-i', PY_INDEX], { timeout: 0 })
  if (r.code === 0) return r
  if (PY_INDEX === 'https://pypi.org/simple') return r
  console.log(`    ! 镜像装不上（${PY_INDEX}），改走官方 PyPI 重试`)
  log(`pip 镜像失败（${PY_INDEX}），改走官方 PyPI`)
  return run(py, ['-m', 'pip', ...args, ...proxyArgs, '-i', 'https://pypi.org/simple'], { timeout: 0 })
}

/**
 * get-pip 引导（issue #6 坑 3，2026-10-31）：Ubuntu 26.04 的 python3.14 不带 ensurepip，
 *   `python3 -m venv` 直接失败，asr / ocr / 模型三项连带全挂。
 *   先按常规建（有 ensurepip 的系统走原路，不多一次网络请求）；失败再 --without-pip + get-pip.py。
 *   引导也失败时**不留半成品 venv**，并直接说清该手工装什么。
 */
function bootstrapPip(py) {
  if (run(py, ['-m', 'pip', '--version']).code === 0) return true
  if (run(py, ['-m', 'ensurepip', '--upgrade']).code === 0 && run(py, ['-m', 'pip', '--version']).code === 0) return true
  const gp = join(DEPS, '.get-pip.py')
  try {
    download('https://bootstrap.pypa.io/get-pip.py', gp, 'get-pip.py')
  } catch {
    console.error('✗ 取不到 get-pip.py（离线/被墙，或 deps 不可写），而本机 python3 没有 ensurepip，装不上 pip')
    console.error('  手工装好后重跑本脚本：')
    console.error('    Debian/Ubuntu: sudo apt install python3-pip python3-venv')
    console.error('    Fedora/RHEL:   sudo dnf install python3-pip')
    console.error('    macOS:         brew install python')
    console.error('  公司网络/代理下：先设 HTTPS_PROXY=http://host:port 再重跑')
    return false
  }
  const r = run(py, [gp])
  try {
    rmSync(gp, { force: true })
  } catch {}
  if (r.code !== 0) {
    console.error('✗ get-pip.py 执行失败（最后 5 行）：')
    console.error(r.out.split(/\r?\n/).slice(-5).join('\n'))
    return false
  }
  return run(py, ['-m', 'pip', '--version']).code === 0
}

/** 建 venv 并返回里面的 python；uv 失败自动回退系统 Python。 */
function newVenv(venv) {
  const plan = pyPlan()
  if (plan.mode === 'uv') {
    console.log(`    建 venv：uv venv --python ${plan.version} "${venv}"`)
    log(`uv venv --python ${plan.version} ${venv}`)
    const r = run(plan.uv, ['venv', '--python', plan.version, venv], { timeout: 0 })
    const py = venvPy(venv)
    if (r.code === 0 && existsSync(py)) return py
    console.log(`    ! uv 建 venv 失败（退出码 ${r.code}），回退系统 Python`)
    log(`uv venv 失败（退出码 ${r.code}），回退系统 Python`)
    moveSemiVenv(venv)
  }
  // discussion #9（2026-11-03）：原来这里无条件 `systemPython()`，而 `--python` 指定的解释器
  //   只记在 `plan.exe`（见 pyPlan），**从头到尾没被用过**。用户机器上 PATH 里排前面的
  //   `python.exe` 是 WindowsApps 存根，结果永远撞在存根上，报「只找到应用商店的 Python 存根」，
  //   手改成优先 plan.exe 后一次跑通。所以这里必须先认 plan.exe。
  //   uv 分支失败回退时 plan.exe 是空串（uv 模式不填 exe），仍然落到 systemPython()，行为不变。
  const sys = plan.exe || systemPython()
  console.log(`    建 venv："${sys}" -m venv "${venv}"`)
  log(`python -m venv ${venv}（${sys}）`)
  let r = run(sys, ['-m', 'venv', venv], { timeout: 0 })
  if (r.code !== 0) {
    // issue #6 坑 3：没有 ensurepip 的发行版走 --without-pip + get-pip 引导
    try {
      rmSync(venv, { recursive: true, force: true })
    } catch {}
    console.log('    python -m venv 失败，改用 --without-pip + get-pip 引导')
    if (r.err) console.log(r.err.split(/\r?\n/).slice(-3).map((l) => `    ${l}`).join('\n'))
    r = run(sys, ['-m', 'venv', '--without-pip', venv], { timeout: 0 })
    if (r.code !== 0) {
      try {
        rmSync(venv, { recursive: true, force: true })
      } catch {}
      throw new Error('连 --without-pip 也建不起来。先装 venv 支持：Debian/Ubuntu: sudo apt install python3-venv')
    }
    const py = venvPy(venv)
    if (!bootstrapPip(py)) {
      try {
        rmSync(venv, { recursive: true, force: true })
      } catch {}
      throw new Error('环境建好了但装不上 pip，已删除半成品（重跑本脚本即可重试）')
    }
    return py
  }
  const py = venvPy(venv)
  if (!existsSync(py)) throw new Error('创建 venv 失败（找不到 venv 里的 python）')
  return py
}

/**
 * 装一个 venv：建环境 → 引导 pip → 装包 → **装完复验 import**。
 *
 * 出口验证（2026-11-01，0.4.1 第 3 条，守卫 C98）：pip 返回 0 **不等于**装成了。
 *   入口那里已经验过一次 `import <mod>`（半成品陷阱），但装完之后必须再验一次：
 *   requires-python 不满足、wheel 落到别的解释器、空壳 venv 上装成「看起来装了」，
 *   这三种都是 install 成功、import 失败。不在这里拦，等到跑 ASR 才炸，
 *   用户看到的是「转写失败」，与「依赖没装上」隔了一层。
 *   —— 这段以前只有 .sh 有，.ps1 只在入口验。合并后两个平台都验。
 */
function ensureVenv(venv, mod, pkgs) {
  const py = venvPy(venv)
  if (existsSync(py) && !FORCE) {
    if (run(py, ['-c', `import ${mod}`]).code === 0) return skip(venv.replace(ROOT + sep, ''))
    console.log(`    venv 存在但 ${mod} 不可用，重建`)
    moveSemiVenv(venv)
  }
  step(`${venv.split(sep).pop()}：venv + ${pkgs.join(' ')}`)
  if (DRY) {
    const plan = pyPlan()
    console.log(`    [dry-run] Python：${plan.desc}`)
    if (plan.mode === 'uv') {
      console.log(`    [dry-run] "${plan.uv}" venv --python ${plan.version} "${venv}"`)
      console.log(`    [dry-run] "${plan.uv}" pip install --python "${py}" ${pkgs.map((p) => `"${p}"`).join(' ')} --index-url ${PY_INDEX}`)
    } else {
      console.log(`    [dry-run] "${plan.exe}" -m venv "${venv}"`)
      console.log(`    [dry-run] "${py}" -m pip install ${pkgs.map((p) => `"${p}"`).join(' ')} -i ${PY_INDEX}`)
    }
    return
  }
  const real = newVenv(venv)
  if (pyPlan().mode !== 'uv') {
    // uv 建的 venv 里没有 pip（也不需要），非 uv 路径照旧先升 pip
    if (!bootstrapPip(real)) throw new Error('venv 里没有 pip 也引导不上（见上面提示）')
    pipInstall(real, ['install', '--upgrade', 'pip'])
  }
  const r = pipInstall(real, ['install', ...pkgs])
  if (r.code !== 0) {
    moveSemiVenv(venv)
    // 2026-11-02（发版前审查）：原来只报「安装 X 失败」，pip 的真实报错被丢掉。
    //   这条路径上最常见的三种原因（连不上索引站 / 系统代理没进环境变量 / Python 版本
    //   不满足 requires-python）全都要读 stderr 才能分辨，不给就等于让用户干猜。
    const tail = (r.err || r.out || '')
      .split(/\r?\n/)
      .map((s) => s.trimEnd())
      .filter((s) => s.trim())
      .slice(-12)
    console.error(`✗ pip install 失败（rc=${r.code}），pip 自己的输出末 ${tail.length} 行：`)
    for (const line of tail.length ? tail : ['（pip 没打出任何内容，可能是进程被系统杀掉）']) console.error(`    ${line}`)
    console.error(`    半成品 venv 已改名留档，排查好重跑即可重试。常见原因：连不上 ${PY_INDEX} / 系统代理没设进环境变量 / Python 版本不满足包的 requires-python。`)
    throw new Error(`安装 ${pkgs.join(' ')} 失败（rc=${r.code}，pip 输出见上）`)
  }
  if (run(real, ['-c', `import ${mod}`]).code !== 0) {
    moveSemiVenv(venv)
    console.error(`✗ ${pkgs.join(' ')} 装完了但 import ${mod} 仍然失败（pip 返回 0 不算装成）—— 半成品 venv 已改名，重跑即可重试`)
    console.error(`    排查："${real}" -c "import ${mod}" 看真实报错；或确认 Python 版本满足包的 requires-python`)
    throw new Error(`${mod} 装了但 import 失败`)
  }
  console.log(`    ✓ ${real}`)
}

// ── CUDA 运行库（第十条，2026-10-29）────────────────────────────
// 装三个 wheel：cuBLAS + cuDNN + nvrtc（ctranslate2 在部分版本上会去要 nvrtc）。
// 装完必须真试一次 DLL——pip 装成功不代表能加载（缺 VC++ Redist 时 pip 也成功、import 才崩）。
function installCudaLibs(py = '') {
  const asrPy = py || venvPy(join(DEPS, '.venv-asr'))
  step(`GPU 运行库（cuBLAS + cuDNN + nvrtc，约 ${IS_WIN ? '1.4' : '2.2'} GB）`)
  if (!existsSync(asrPy)) {
    // 2026-11-02（合一）：旧 .sh 这里是 exit 1 + 指路，我第一版写成「打印一行就 return」——
    //   那是 rc=0，「没做成却报成功」，比死按钮更隐蔽（用户看到退出码 0 以为装好了）。
    //   改成抛错走统一失败出口（主流程 catch → failed++ → exit 1），并点名该跑哪条命令。
    throw new Error(`还没装 ASR 环境（${asrPy} 不存在）—— GPU 运行库要装进 .venv-asr，先跑 node scripts/fetch-deps.mjs asr`)
  }
  if (DRY) {
    console.log(`    [dry-run] "${asrPy}" -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-nvrtc-cu12 -i ${PY_INDEX}`)
    return
  }
  pipInstall(asrPy, ['install', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12', 'nvidia-cuda-nvrtc-cu12'])
  // 与面板 /status 的 ok 判据同一口径：不看 pip 包名，真加载一次 DLL。
  const probe = join(DEPS, '_bili-asr.py')
  if (!existsSync(probe)) {
    console.log(`    ! 找不到 ${probe}，没法自检运行库。ASR 转写时会自己加载，跑一次就知道`)
    return
  }
  const r = run(asrPy, [probe, '--probe-gpu'])
  if (r.code === 0) {
    console.log(`    ✓ ${IS_WIN ? 'cublas64_12.dll' : 'libcublas.so.12'} 能加载：ASR 会走 GPU（显存不足自动回落 CPU）`)
  } else {
    console.log('    ! 运行库装了但探测没通过（缺驱动 / 卡不可见 / CUDA 版本不匹配）；ASR 继续用 CPU，功能不受影响')
  }
}

// ── NVIDIA 探测（M-06，2026-10-29）──────────────────────────────
// 以前只看 `nvidia-smi -L` 的退出码，三种误判：驱动装了但 nvidia-smi 不在 PATH /
//   驱动 <525（CUDA 12 最低要求）白下 1.4 GB / 显存 <2 GB 装了加载即 OOM。
//   改成查 driver_version + memory.total，不满足就把原因说清楚。
function probeNvidia() {
  const smi = which('nvidia-smi') || (IS_WIN ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'), join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe')].find((p) => existsSync(p)) : '')
  if (!smi) return { ok: false, why: '没找到 nvidia-smi（未装 NVIDIA 驱动，或不是 NVIDIA 卡）' }
  const r = run(smi, ['--query-gpu=driver_version,memory.total', '--format=csv,noheader'])
  if (r.code !== 0 || !r.out) return { ok: false, why: 'nvidia-smi 查询失败（驱动异常）' }
  const first = r.out.split(/\r?\n/)[0]
  const parts = first.split(/,\s*/)
  const drv = parts[0] || ''
  const memMb = (parts[1] || '').match(/(\d+)/) ? Number((parts[1] || '').match(/(\d+)/)[1]) : 0
  const drvNum = (drv.match(/^(\d+)\./) || [])[1] ? Number((drv.match(/^(\d+)\./) || [])[1]) : 0
  if (drvNum > 0 && drvNum < 525) return { ok: false, why: `驱动 ${drv} 太旧（CUDA 12 要 525+），装了运行库也用不了` }
  if (memMb > 0 && memMb < 2048) return { ok: false, why: `显存 ${memMb} MB 太小（small 模型约需 1 GB），装了容易 OOM` }
  return { ok: true, why: '' }
}

// ── ASR ────────────────────────────────────────────────────────
async function ensureAsr() {
  const venv = join(DEPS, '.venv-asr')
  const py = venvPy(venv)
  if (existsSync(py) && !FORCE) {
    // 半成品陷阱：venv 建好、pip 装包失败时目录仍在，只看 python 会永远跳过
    if (run(py, ['-c', 'import faster_whisper']).code === 0) return skip(IS_WIN ? 'deps\\.venv-asr' : 'deps/.venv-asr')
    console.log('    venv 存在但 faster_whisper 不可用，重建')
    moveSemiVenv(venv)
  }
  step('ASR 环境（.venv-asr + faster-whisper==1.2.1）')
  ensureVenv(venv, 'faster_whisper', ['faster-whisper==1.2.1', 'av==15.1.0', 'ctranslate2==4.8.3'])
  if (DRY) {
    console.log('    [dry-run] 检测到 NVIDIA 显卡时会问一句「装 GPU 运行库吗（约 1.4 GB）」，选是才装 nvidia-cublas-cu12 / nvidia-cudnn-cu12（非交互或 --gpu no 则跳过）')
    return
  }
  // issue #3 第 4 条：不装 CUDA 12 的 cuBLAS + cuDNN 时，--device auto 能探到 GPU、模型也能加载，
  //   但一转写就报 Library cublas64_12.dll is not found。有 N 卡就顺手装上（pip 包，不用装整套 toolkit）。
  const nv = probeNvidia()
  if (!nv.ok) console.log(`    不装 GPU 运行库：${nv.why}`)
  let wantGpu = false
  if (nv.ok) {
    if (GPU === 'yes') wantGpu = true
    else if (GPU === 'no') wantGpu = false
    else if (IN_ALL) {
      // 第十条：all 不问、不装（要装请 --target cuda / --gpu yes）
      console.log('    (all) 跳过 GPU 运行库（约 1.4 GB）；要装请单独跑 cuda')
    } else if (!process.stdin.isTTY) {
      // 无人值守（面板拉起）时不要卡在提问上，按「不装」处理
      console.log('    检测到 NVIDIA 显卡；非交互环境跳过 GPU 运行库（要装请传 --gpu yes）')
    } else {
      console.log('    检测到 NVIDIA 显卡。要不要装 CUDA 运行库（cuBLAS + cuDNN，约 1.4 GB）？')
      console.log('      装了：ASR 用 GPU 转写，比 CPU 约快 2 倍；不装：ASR 走 CPU，功能一样但慢些。')
      const ans = (await ask('    装 GPU 运行库？[y/N] ')).trim()
      wantGpu = /^(y|yes|是)$/i.test(ans)
    }
  }
  if (wantGpu) {
    console.log('    检测到 NVIDIA 显卡，补装 CUDA 12 运行库（cuBLAS + cuDNN，约 1.4 GB）…')
    installCudaLibs(venvPy(venv))
  } else if (nv.ok) {
    console.log('    按你的选择不装 GPU 运行库，ASR 走 CPU')
  } else {
    console.log('    未检测到 NVIDIA 显卡，跳过 GPU 运行库（ASR 用 CPU）')
  }
}
/** 问一句、读一行（只在 --gpu ask 且真在终端里时用；面板拉起时 isTTY 为假，走不到这里）。 */
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (a) => {
      rl.close()
      resolve(a || '')
    })
  })
}

// ── OCR ────────────────────────────────────────────────────────
function ensureOcr() {
  const venv = join(DEPS, '.venv-ocr')
  const py = venvPy(venv)
  if (existsSync(py) && !FORCE) {
    if (run(py, ['-c', 'import rapidocr_onnxruntime']).code === 0) return skip(IS_WIN ? 'deps\\.venv-ocr' : 'deps/.venv-ocr')
    console.log('    venv 存在但 rapidocr_onnxruntime 不可用，重建')
    moveSemiVenv(venv)
  }
  step('OCR 环境（.venv-ocr + rapidocr-onnxruntime==1.2.3）')
  ensureVenv(venv, 'rapidocr_onnxruntime', ['rapidocr-onnxruntime==1.2.3'])
}

// ── 模型 ───────────────────────────────────────────────────────
function ensureModel() {
  const asrPy = venvPy(join(DEPS, '.venv-asr'))
  const hfHome = join(DEPS, '.hf-home')
  if (existsSync(join(hfHome, 'hub')) && !FORCE) return skip(IS_WIN ? 'deps\\.hf-home' : 'deps/.hf-home')
  if (!DRY && !existsSync(asrPy)) throw new Error('模型要用 ASR 环境里的 huggingface_hub。先跑 asr。')
  // --force 时若留着体积不足的 model.bin，snapshot_download 见到已有文件可能直接跳过，
  // 于是「强制重下」什么也没修。先删掉那一份快照目录；下载逻辑本身不动。
  // 只删体积不足这一种：缺别的文件由 snapshot_download 自己补齐，不需要整目录删掉。
  // 干跑只打印、不删（干跑的承诺是「什么都没改」）。
  if (FORCE) {
    const left = inspectModelHomes([hfHome])
    if (left.tooSmall === true && left.snapshotDir) {
      if (DRY) {
        console.log(`    [dry-run] 会先删掉半截快照 ${left.snapshotDir}，再重新下载`)
      } else {
        rmSync(left.snapshotDir, { recursive: true, force: true })
        log(`清掉半截快照 ${left.snapshotDir}（${left.reason}）`)
      }
    }
  }
  step('faster-whisper-small 模型（约 464 MB）')
  if (DRY) {
    console.log(`    [dry-run] HF_HOME="${hfHome}" HF_ENDPOINT=${HF_ENDPOINT} HF_HUB_DISABLE_XET=1 "${asrPy}" -c "snapshot_download('Systran/faster-whisper-small')"`)
    return
  }
  const env = { ...process.env, HF_HOME: hfHome, HF_HUB_DISABLE_XET: '1' }
  if (!env.HF_ENDPOINT) env.HF_ENDPOINT = HF_ENDPOINT
  log(`下载模型 Systran/faster-whisper-small（${PROXY ? `代理 ${PROXY}` : '直连'}，HF_ENDPOINT=${env.HF_ENDPOINT}，HF_HOME=${hfHome}）`)
  const r = run(asrPy, ['-c', "from huggingface_hub import snapshot_download; print(snapshot_download('Systran/faster-whisper-small'))"], { env, timeout: 0 })
  if (r.code !== 0) {
    log(`模型下载失败（退出码 ${r.code}）：${env.HF_ENDPOINT}`)
    throw new Error(`模型下载失败${r.err ? `：${r.err.split(/\r?\n/).slice(-3).join(' / ')}` : ''}`)
  }
  console.log(`    ✓ ${hfHome}`)
}

// ── 版本记录 ───────────────────────────────────────────────────
// 只写 deps/last-bin.json（装包版本快照），不碰 deps/last-run.json（运行排障记录，只由 index.js 写）。
//   两个文件互不 read-modify-write 对方。
function recordBinaryVersions() {
  if (DRY) {
    console.log('    [dry-run] 记录 ffmpeg -version 首行 与 yt-dlp --version 到 deps/last-bin.json')
    return
  }
  const rec = { ffmpeg: '<未获取>', ytDlp: '<未获取>', at: new Date().toISOString() }
  const ff = join(DEPS, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')
  if (existsSync(ff)) {
    const r = run(ff, ['-version'])
    rec.ffmpeg = r.code === 0 ? r.out.split(/\r?\n/)[0] || '<空>' : '<获取失败>'
  }
  const yt = join(DEPS, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
  if (existsSync(yt)) {
    const r = run(yt, ['--version'])
    rec.ytDlp = r.code === 0 ? r.out.split(/\r?\n/)[0] || '<空>' : '<获取失败>'
  }
  const out = join(DEPS, 'last-bin.json')
  try {
    writeFileSync(out, JSON.stringify(rec), 'utf8')
    console.log(`    ✓ 二进制版本记录 -> ${out}`)
  } catch (e) {
    console.log(`    ! 版本记录写不进 ${out}：${e.message}`)
  }
}

// ── 主流程 ─────────────────────────────────────────────────────
// 第十条：all 不自动带 cuda——保持「不问、不装 1.4 GB」的语义，要装请 --target cuda 或 --gpu yes
const STEPS = TARGET === 'all' ? ['ffmpeg', 'ytdlp', 'asr', 'ocr', 'model'] : [TARGET]

if (DRY) {
  console.log('[dry-run] 只打印命令，不下载、不写盘。')
  // 验收要求 --dry-run 能看到代理与 Python 的选择（ytdlp 这类不建 venv 的目标也要打出来）
  try {
    console.log(`    [dry-run] Python：${pyPlan().desc}`)
  } catch (e) {
    console.log(`    [dry-run] Python：${e.message}`)
  }
}

let failed = 0
for (const s of STEPS) {
  log(`开始：${s}`)
  try {
    if (s === 'ffmpeg') ensureFfmpeg()
    else if (s === 'ytdlp') ensureYtdlp()
    else if (s === 'asr') await ensureAsr()
    else if (s === 'ocr') ensureOcr()
    else if (s === 'model') ensureModel()
    else if (s === 'cuda') installCudaLibs()
    log(`完成：${s}`)
  } catch (e) {
    failed++
    log(`失败：${s} —— ${e.message}`)
    console.warn(`「${s}」失败：${e.message}`)
  }
}

console.log('')
if (failed > 0) {
  console.warn(`有 ${failed} 项失败，看上面每项的原因；已完成的项不受影响。`)
  log(`==== 结束：${failed} 项失败（Target=${TARGET}）`)
  process.exit(1)
}
recordBinaryVersions()
console.log('完成。验证：node tools/look.mjs view <BV号>')
log(`==== 结束：全部完成（Target=${TARGET}）`)
