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
import { spawn, execFile, execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, relative, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @deepseek-ai/dsh-tools 是可选 peer：桌面版 autoInstallPeers:false，市场安装时不会自动装上。
// 缺了只少一个 bili_watch 工具，/bili 命令、插件面板与路由照常工作，不能因此整块加载失败。
// 工具输出上限：超了就把全文落文件、只回摘要。
// 由来：2026-10-26 一段 14 分钟视频的字幕 4,449 字整段塞进上下文，把会话挤爆两次。
// 2026-10-28 高级设置放开：两个上限改从 readTuning() 每次取（toolTextCap 默认 2000、toolHead 默认 800）。
// 不能写成模块级 const——index.js 是常驻进程，那样面板改了要重启才生效，和 cacheCfg 踩过的坑一样。
const toolTextCap = () => readTuning().toolTextCap
const toolTextHead = () => readTuning().toolHead

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
  // P2-5（2026-10-28 全量检查）：两处 cleanKey 必须逐字一致（面板与 CLI 不许各算一个目录名）——
  //   ① 尾部点号/空格在 Windows 上会被系统吃掉，「建出来的目录名」与「下次拼出来的目录名」不一致；
  //   ② 保留名要连后缀一起挡（con.txt / NUL.ini 在 Windows 上照样是设备名），按去扩展名后的基名判。
  const k = String(s || '').replace(/[^\w.-]/g, '').slice(0, 40).replace(/[\s.]+$/, '')
  const base = k.split('.')[0]
  if (!k || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(base)) return '_misc'
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

let TOOL_FILE_SEQ = 0
/** 长文本 → 落盘 + 摘要；短文本原样返回（不论长短都先落一份到缓存）。
 *  B11：jsonMode（或内容以 {/[ 起头）时，超长不再 slice 硬切——半截 JSON 既不能 JSON.parse，
 *  也会被模型误读成坏 JSON。直接告诉模型「全文已整体落盘，去 read 那个文件」。 */
function trimForModel(text, tag = 'out', bv = '', jsonMode = false, opts = {}) {
  const s = String(text ?? '')
  // A8（2026-10-27 批次8）：--full 时工具层不要再把已放大的文本切回 800——
  //   full 走 20000 上限；用户给的 --head N 优先于默认 800；不传 full 仍 ≤2000。
  const full = !!opts.full
  const cap = full ? 20000 : toolTextCap()
  const head = (Number.isFinite(opts.head) && opts.head > 0)
    ? Math.floor(opts.head)
    : (full ? 20000 : toolTextHead())
  let f = ''
  try {
    const base = String(tag || 'out').replace(/[^\w.-]/g, '') || 'out'
    // A-2（2026-10-28 阶段A）：同一 BV 下不同模式（--fast/--verify/--full/--head）或不同命令会写同一个
    //   `<tag>.tool.txt`，后写覆盖先写，工具层按旧路径 read 会读到别人的内容。落盘名加「时间戳36进制 + 进程内自增」
    //   绝不覆盖；返回文本里带着绝对路径，调用方照读即可。`${name}.tool.txt` 模板字面量必须保留（verify.mjs:69 断言依赖）。
    const name = `${base}.${Date.now().toString(36)}${(++TOOL_FILE_SEQ).toString(36)}`
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
const KNOWN_FLAGS = ['--step', '--p', '--cred', '--days', '--limit', '--order', '--grid', '--out', '--ffmpeg', '--head', '--full', '--verify', '--format', '--fresh', '--ocr', '--poll', '--check', '--fast', '--scene', '--mark-seen', '--asr-max']
// ↑ P2（2026-10-28 全量检查）：补 --asr-max。它早在 tools/look.mjs:2769 的 VALUE_OPTS 与 :2813 实现里
//   生效，却不在这张表里——斜杠命令传 `--asr-max 60000` 会同时「报未知参数」并「真的生效」，自相矛盾。

// 设置页端点读的落点，与 tools/look.mjs 同源（DEPS / CACHE / pickCacheDir / depsCfg 等常量定义处）
// X-30（2026-10-29）：deps 默认放到包目录之外。npm uninstall / 重装包会把包目录整个删掉，
//   用户的参数、两个 venv、460 MB 模型跟着一起没（W-12 只是 README 提醒，没堵住升级路径）。
//   放到 $DSH_HOME\bili-watch\deps 就与包的生命周期解耦；BILI_WATCH_DEPS 可覆盖（测试 / 多实例 / 换盘）。
//   包内旧 deps\ 首次启动搬一次：先 cp 到 deps.migrating 再 rename（同盘原子，不留半截）；
//   任何一步失败都回退用包内那份——功能不能因为搬家失败而哑掉。
let depsWarning = null
// X-30：手写递归复制。Node 22 的 fs.cpSync 在 Windows 中文路径下会进程级崩溃
//   （exit 127、无异常栈，实测带空格的中文路径必崩），不能用来搬 460 MB 的 deps。
function copyTreeSync(src, dst) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src, { withFileTypes: true })) copyTreeSync(join(src, e.name), join(dst, e.name))
  } else if (st.isFile()) {
    copyFileSync(src, dst)
  }
}
const DEPS_PREF = process.env.BILI_WATCH_DEPS || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-watch', 'deps')
const DEPS_LOCAL = join(HERE, 'deps')
// X-30 第二轮（2026-10-29）：搬家的标记文件。只有搬成功才写，下次启动见到它才用新位置。
const DEPS_MOVED_MARK = join(DEPS_PREF, '.deps-moved')
// 当前用哪份——**同步决定、不搬东西**。
//   第一轮是「模块加载期同步 copyTreeSync 搬 460 MB」，慢盘上堵事件循环 30–90 秒，
//   cordis 可能误判插件无响应把进程杀掉。现在加载期只做几个 existsSync，搬家交给后台。
const DEPS = (() => {
  if (resolve(DEPS_PREF) === resolve(DEPS_LOCAL)) return DEPS_PREF
  // 上次已经搬完（有标记）→ 用包外
  if (existsSync(DEPS_MOVED_MARK)) return DEPS_PREF
  // 包外已经有东西（用户手动放的 / 以前搬过但没标记）→ 用包外，不覆盖用户数据
  if (existsSync(DEPS_PREF)) return DEPS_PREF
  let srcHas = false
  try { srcHas = existsSync(DEPS_LOCAL) && readdirSync(DEPS_LOCAL).length > 0 } catch {}
  if (!srcHas) { try { mkdirSync(DEPS_PREF, { recursive: true }) } catch {} ; return DEPS_PREF }
  // 包内有内容、包外还没有 → **本次先用包内**（功能立即能用，事件循环不堵），搬家排后台
  return DEPS_LOCAL
})()
/**
 * X-30 第二轮：后台把包内 deps 搬到包外，搬完写 .deps-moved，**下次启动生效**。
 * 由 apply() 在插件注册完之后调，3 秒延迟——那时插件已经装好，堵一会儿不影响 cordis 判活。
 * 迁到一半进程被杀：留下 deps.migrating，下次这里开头的 rmSync 会清掉重搬。
 */
function scheduleDepsMigration() {
  if (resolve(DEPS) !== resolve(DEPS_LOCAL)) return // 已经在用包外，不用搬
  const tmp = DEPS_PREF + '.migrating'
  const t = setTimeout(() => {
    try {
      mkdirSync(dirname(DEPS_PREF), { recursive: true })
      try { rmSync(tmp, { recursive: true, force: true }) } catch {} // 上次迁到一半的残留
      copyTreeSync(DEPS_LOCAL, tmp)
      try { rmSync(DEPS_PREF, { recursive: true, force: true }) } catch {} // 3 秒内可能被别人建出来
      renameSync(tmp, DEPS_PREF)
      writeFileSync(DEPS_MOVED_MARK, JSON.stringify({ at: new Date().toISOString(), from: DEPS_LOCAL }), 'utf8')
      depsWarning = `依赖目录已迁到 ${DEPS_PREF}，下次启动生效；包内旧 deps\\ 可手动删除`
    } catch (e) {
      try { rmSync(tmp, { recursive: true, force: true }) } catch {}
      depsWarning = `依赖目录后台迁移失败，继续用包内 deps\\（${String(e?.message || e)}）；装依赖请先手动把 deps\\ 移到 ${DEPS_PREF}`
    }
  }, 3000)
  // 别让这个定时器拖住宿主退出；宿主活着它照样会到点
  try { t.unref?.() } catch {}
}
// 本机路径来源：env 优先，其次 deps\deps-config.json（写文件即生效，不必重启），最后 deps 自身。
// 配置文件不进包（deps 只留空目录），发布时无需脱敏。
// 解析失败不写 stdout/stderr（会污染 --format json 与 PowerShell 管道），
// 而是记进 cfgWarning，由 /status 的 warnings 带给面板；ENOENT（没配过）不算异常。
let cfgWarning = null
// issue #2 P3-3（2026-10-28）：bili_watch 工具没注册成功时原来只 console.warn，桌面端看不到控制台，
// 用户会以为「工具坏了」。改成同时记一条，由 /status 的 warnings 带到面板。
let toolsWarning = null
function depsCfg() {
  try { return JSON.parse(readFileSync(join(DEPS, 'deps-config.json'), 'utf8')) } catch (e) {
    if (e?.code !== 'ENOENT') {
      cfgWarning = `deps-config.json 解析失败，已改用 deps 目录：${String(e?.message || e)}`
    }
    return {}
  }
}
/**
 * 参数分层（2026-10-28 阶段B）：面板可调的五个数值，全部并进 deps\deps-config.json，
 * 不新开第四份配置文件。优先级 CLI flag > deps-config.json > 这里的常量默认。
 * 校验只写一处（tuneOne）：非法/超界/非数字一律静默回落默认值，不抛错、不中断命令。
 */
const TUNING_DEFS = {
  asrMaxSec: { def: 1800, min: 300, max: 3600 },
  maxFrames: { def: 500, min: 100, max: 1000 },
  asrTimeoutSec: { def: 900, min: 300, max: 3600 },
  ffmpegTimeoutSec: { def: 300, min: 60, max: 1800 },
  cmdTimeoutSec: { def: 180, min: 60, max: 900 },
  // 2026-10-28 老大要求「高级设置放开，能调的都给调」：下面 8 项原来是硬编码。
  // 全部整数（tuneOne 会 Math.floor，别写小数）；键集必须与 tools/look.mjs:2878 那份完全一致，
  // verify.mjs 的 C17 会逐键比对，改一处漏一处直接红。
  asrMemMB: { def: 1536, min: 512, max: 16384 },   // 跑本地转写要多少可用内存（MB），不够就跳
  lockTtlMin: { def: 30, min: 5, max: 240 },       // 残留锁多久算过期（分钟）
  unitLimit: { def: 5000, min: 1000, max: 20000 }, // 单个内容单元（字幕段/评论）字符上限
  textLimit: { def: 800, min: 200, max: 5000 },    // 文本层默认给多少字
  toolTextCap: { def: 2000, min: 500, max: 12000 },// 工具层单次回给模型的总字数（调大会挤占对话上下文）
  toolHead: { def: 800, min: 200, max: 5000 },     // 工具层默认 head 字数
  dmBucketSec: { def: 30, min: 5, max: 120 },      // 弹幕热区按多少秒一桶
  dmTop: { def: 5, min: 1, max: 20 },              // 弹幕热区取前几桶
  // 2026-10-28 第二批 3 项：都是「撞上了只能报 bug、自己没法自救」的。
  // 语速用 ×10 整数存（20 = 2.0 字/秒），因为 tuneOne 会 Math.floor，不能写小数。
  downloadMaxMB: { def: 512, min: 64, max: 4096 }, // 单个视频/音频下载上限（4K 素材会撞）
  subRateMin10: { def: 20, min: 5, max: 60 },      // 字幕语速下限×10，低于判「可疑」
  subRateMax10: { def: 85, min: 30, max: 200 },    // 字幕语速上限×10，高于判「可疑」
  textBrief: { def: 400, min: 100, max: 3000 },    // 超长文本只给开头多少字（其余落盘）
  // 第十条（2026-10-29）：ASR 推理设备。枚举项不走数值钳制（tuneOne 先看 kind）。
  //   只有 auto / cpu 两态：auto = 有可用 CUDA 就用、失败回落 CPU（_bili-asr.py 里实现）。
  //   不暴露 cuda 是因为「强制 cuda」在没有 GPU 的机器上只会多一次失败日志，没有收益。
  asrDevice: { def: 'auto', kind: 'enum', values: ['auto', 'cpu'] },
}
const TUNING_KEYS = Object.keys(TUNING_DEFS)
const tuningDefaults = () => Object.fromEntries(TUNING_KEYS.map((k) => [k, TUNING_DEFS[k].def]))
// 第十条（2026-10-29）：枚举项（asrDevice）的「范围」是可选值数组，不是 [min, max]
const tuningRanges = () => Object.fromEntries(TUNING_KEYS.map((k) => [k, TUNING_DEFS[k].kind === 'enum' ? TUNING_DEFS[k].values : [TUNING_DEFS[k].min, TUNING_DEFS[k].max]]))
function tuneOne(key, raw) {
  const d = TUNING_DEFS[key]
  // 第十条（2026-10-29）：枚举项（asrDevice）不走数值钳制，否则 Math.floor('auto') = NaN
  if (d.kind === 'enum') {
    const s = String(raw ?? '').trim().toLowerCase()
    return d.values.includes(s) ? s : d.def
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return d.def
  if (n < d.min || n > d.max) return d.def
  return Math.floor(n) // 与 tools/look.mjs 的 clampTuning 取整口径一致（两处必须同语义）
}
/** 每次调用都读盘（照 cacheCfg 的写法）：index.js 是常驻进程，存闭包就是「面板改了插件还是老的」。 */
function readTuning() {
  const cfg = depsCfg()
  const out = {}
  for (const k of TUNING_KEYS) out[k] = tuneOne(k, cfg[k])
  return out
}
/**
 * 读 deps-config.json，坏文件先备份再退回默认值（X-16a，2026-10-28 WB-CN N12 §2 头号）。
 *
 * 原来两处写入口都是 `try { cur = JSON.parse(readFileSync(p)) } catch {}`：
 * 解析失败 cur 变 `{}`，下次改**任意一个**参数就整份写回——ffmpeg 路径、cache 目录、
 * proj、17 项调优参数全被擦掉。单写者就能触发，不需要并发，用户只会看到「配置莫名其妙没了」。
 *
 * 现在：文件不存在 → 默认值（正常）；存在但坏了 → 改名成 `.broken-<ts>` 留档 + 默认值 + 一次告警。
 * 留档而不是直接拒绝写，是因为拒绝写会让面板「保存」一直失败、用户也不知道该改哪个文件。
 */
function readDepsCfgFile(p) {
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    if (e?.code !== 'ENOENT') cfgWarning = `${basename(p)} 读取失败：${String(e?.message || e)}`
    return {}
  }
  if (!raw.trim()) return {}
  try {
    const j = JSON.parse(raw)
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}
  } catch (e) {
    const bak = `${p}.broken-${Date.now()}`
    try { renameSync(p, bak) } catch {}
    cfgWarning = `${basename(p)} 解析失败（${String(e?.message || e)}），原文件已备份为 ${basename(bak)}，本次按默认值继续`
    return {}
  }
}
/**
 * 参数分层专用写入口：一次读盘 → 按白名单改/删 → 整份写回。
 * 不能复用 writeDepsCfg：它是合并写，删键（面板「恢复默认」）在合并写里删不掉。
 * 表外的键不认；表内键但值非法则忽略（保持原值），都不报错。
 */
function writeTuning(body) {
  const p = join(DEPS, 'deps-config.json')
  let cur = readDepsCfgFile(p)
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {}
  if (!body || typeof body !== 'object') return { ok: true, data: cur }
  let touched = false
  // D-01/D-02（2026-10-29）：值非法以前是「忽略、保持原值」，调用方照样回 ok:true，
  //   面板弹「已保存」而实际没写——这是「假保存」。现在收集所有非法项，一次报清楚，且一个都不写。
  //   注意 null 仍是合法的「恢复默认」（面板的恢复默认按钮就发 null，这里删键回落到常量）。
  const bad = []
  for (const k of TUNING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue
    const v = body[k]
    if (v === null) { delete cur[k]; touched = true; continue }
    const d = TUNING_DEFS[k]
    // 第十条（2026-10-29）：枚举项（asrDevice）按字符串白名单存，不走数值判据
    if (d.kind === 'enum') {
      const s = String(v ?? '').trim().toLowerCase()
      if (d.values.includes(s)) { cur[k] = s; touched = true } else { bad.push(`${k}=${v} 只能是 ${d.values.join(' / ')}`) }
      continue
    }
    const n = Number(v)
    if (!Number.isFinite(n)) { bad.push(`${k}=${v} 需要数字`) ; continue }
    if (n < d.min || n > d.max) { bad.push(`${k}=${n} 超出范围 ${d.min}–${d.max}`); continue }
    cur[k] = Math.floor(n)
    touched = true
  }
  if (bad.length) return { ok: false, code: 400, why: bad.join('；') }
  if (!touched) return { ok: true, data: cur }
  try {
    writeFileSync(p, JSON.stringify(cur, null, 2), 'utf8')
    return { ok: true, data: cur }
  } catch (e) {
    return { ok: false, code: 500, why: String(e?.message || e) }
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
// 2026-10-28：面板扫码写的是 bili-duty\bili_credential.small.json（小号），watch 这份不会跟着变。
// 老大的口径是「两个地方用同一份，复制一下即可」——所以这里把它做成一次自动复制，
// 不引入新的读取优先级：复制后 SHARED 的 mtime 就是现在，后面那段 mtime 仲裁照旧。
// 单向（panel small → SHARED），不反向写，避免把 watch 扫的号盖掉面板那份。
const PANEL_SMALL = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty', 'bili_credential.small.json')
// X-10（2026-10-29）：用户主动删凭证后写这份抑制记录（含删除时刻 panel small 的 mtime）。
//   放凭证同目录、同生命周期：凭证没了它也没意义，deps 被清空也不影响。
const CRED_CLEARED = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-watch', 'cred-cleared.json')
// B-10（2026-10-29）：本进程刚扫码写进 SHARED_CRED 的那一次，记下写入后的 mtime。
//   resolveCredPath 的仲裁是「panelAt >= sharedAt 就用 PANEL_CRED」——刚扫完码时 panel 那份
//   恰好也被触碰（或同毫秒）就会把新号判给旧号，用户以为登了新号、实际 watch 还在用旧号。
//   只要磁盘上还是我们自己写的那一份，就优先 SHARED，不参与 mtime 仲裁。
let sharedWrittenAt = 0
function syncPanelSmallToShared() {
  try {
    const panelAt = statSync(PANEL_SMALL).mtimeMs
    let sharedAt = 0
    try { sharedAt = statSync(SHARED_CRED).mtimeMs } catch {}
    if (sharedAt && panelAt <= sharedAt) return
    // X-10（2026-10-29）：用户主动删过凭证后，panel 小号那份不能靠 8 秒轮询再复制回来。
    //   判据用 mtime 而不是时间窗——panel 重新扫码时 PANEL_SMALL 的 mtime 会变新，复制自然恢复。
    try {
      const c = JSON.parse(readFileSync(CRED_CLEARED, 'utf8'))
      if (Number.isFinite(c?.panelMtime) && panelAt <= c.panelMtime) return
    } catch {}
    mkdirSync(dirname(SHARED_CRED), { recursive: true })
    writeFileSync(SHARED_CRED, readFileSync(PANEL_SMALL), { encoding: 'utf8', mode: 0o600 })
  } catch {}
}
function resolveCredPath() {
  syncPanelSmallToShared()
  try {
    // mtime 比较：panel 侧重登大号（更常见）后 PANEL_CRED 更新，watch 立刻跟上；
    // watch 自己扫码登了新号则 SHARED 更新，用 SHARED。同 mtime 时偏好 panel（权威源）。
    const mtimeOf = (p) => { try { return statSync(p).mtimeMs } catch { return 0 } }
    const sharedAt = mtimeOf(SHARED_CRED)
    const panelAt = mtimeOf(PANEL_CRED)
    // B-10（2026-10-29）：刚扫码写的那份优先。磁盘上还是它（mtime 没被别人改写）就直接用它，
    //   不让 panelAt >= sharedAt 把刚登的新号盖成 panel 侧的旧号。
    if (sharedWrittenAt && sharedAt === sharedWrittenAt) return SHARED_CRED
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
const OWN_CACHE_DIRS = new Set(['_logs', 'frames', 'sheets', 'sheet-tmp', 'substrip-tmp', '_misc', 'asr', 'frames-dl', 'audio-dl', '_hot'])
function hasBvLayout(dir) {
  // X-02（2026-10-29）：原来这里有一条「存在 .bili-watch-root 标记就直接认」的捷径，标记一旦落下
  //   就永久免检：用户后来把素材库指到这个目录（标记还在、BV* 目录也在、只是没有 meta.json），
  //   clean 就把整片 BV* 删掉，还再写一次标记自我固化。标记只证明「我们曾经在这里写过」，
  //   不证明「现在这里还是我们的缓存」，所以不再当判据；它只留给 dirStat / 清理白名单当「我们写过的文件」。
  // 判据（2026-10-28 W-01 改）：BV* 目录 **且** 该目录里有我们自己写的 meta.json。
  //   N05-A1 那版用「BV* + frames/asr/_logs 之一」，实测仍会误判：用户素材库只要同时有 BV 目录和
  //   一个 frames 目录，clean 就把 BV 目录整片删掉（rc=0、无警告），还顺手写下 .bili-watch-root 自我固化，
  //   此后永远走删的那条路、不会自己纠正。frames/asr/_logs 是通用名，等于拿别人的东西证明自己的身份；
  //   meta.json 只有 writeMeta() 会写，用户素材库不会有。
  //   口径必须与 tools/look.mjs 的同名函数逐字一致，否则面板与 CLI 判据分叉。
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      if (!/^BV[0-9A-Za-z]{10}/i.test(e.name)) continue
      try {
        if (existsSync(join(dir, e.name, 'meta.json'))) return true
      } catch {}
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
// A-3（2026-10-28 阶段A）：清理前确认「没有任何会写盘的子目录在被占用」。
//   原实现只查 frames/.lock 与 frames/<子>/.lock，漏掉 sheet-tmp / substrip-tmp / CACHE 根的 .meta-*.lock / asr。
//   递归扫（深度 ≤3），只认文件名以 .lock 结尾（覆盖 .lock / .BV-p1-2s.lock / .meta-xx.lock / .BV-grid.lock）。
//   与 tools/look.mjs 的同名函数必须逐字一致（面板与 CLI 判据不能分叉）。
// P1（2026-10-28 全量检查）：判据补上「判活 + 判过期」。原来只看文件名存在，于是 Ctrl-C / 强杀 / 断电
//   留下一个 .lock 会让 autoCleanCache 永远 locked、而唯一逃生口 clean 用同一判据也被堵死，
//   缓存只涨不消且没有 --force。这里与 tryLock 用完全相同的判据：持有者进程还活着且未过期才算被占用。
//   下面三个辅助函数与 tools/look.mjs:647-662 逐字一致。
// 2026-10-28 高级设置放开：与 tools/look.mjs 同源，从 readTuning().lockTtlMin 取（默认 30 分钟）
// X-14（2026-10-29）：TTL 还必须覆盖一次最长转写——asrTimeoutSec 上限 60 分钟 > 默认 TTL 30 分钟，
//   转写跑满时锁先被判过期、别的进程抢进来 → 双持。所以取两者的较大值（与 CLI 同一判据）。
const lockTtlMs = () => {
  const t = readTuning()
  return Math.max(t.lockTtlMin * 60 * 1000, (t.asrTimeoutSec + 120) * 1000)
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
function readLock(f) {
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (Number.isInteger(j?.pid) && j.pid > 0) return j
  } catch {}
  return null
}
function lockExpired(owner) {
  if (!owner) return true
  return Date.now() - (owner.at || 0) > (owner.ttlMs || lockTtlMs())
}
function hasAnyLock(root) {
  const walk = (d, depth) => {
    if (depth > 3) return false
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return false }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.lock')) {
        const owner = readLock(join(d, e.name))
        if (owner && pidAlive(owner.pid) && !lockExpired(owner)) return true
        continue // 残留锁不算占用（真清的时候由 tryLock / unlockStale 负责删）
      }
      if (e.isDirectory() && walk(join(d, e.name), depth + 1)) return true
    }
    return false
  }
  return walk(root, 0)
}
// 2026-10-28：cleanKey 会把整条链接压成目录名（如 httpsb23.tvabc123）——短链没解析成 BV 时
// 插件自己就建了这种目录，清理时必须认它，否则「立即清除」会留一堆删不掉的垃圾（用户实测剩 3 个）。
// 10-28 又实测剩两个：`search` 的落盘目录名来自查询词（如 `DeepSeekHarness`）、`hot` 落 `_hot`。
// 判据：里面**只有**我们自己的产物，且至少有一个 `*.tool.txt`。用户素材目录装的是 mp4/jpg，不会是这个形态；
// 要求「至少一个 tool.txt」是给「名字不像 URL 的目录」加门槛，空目录仍只认名字像 URL 的。
function looksLikeOwnUrlDir(p, name) {
  let ents
  try { ents = readdirSync(p, { withFileTypes: true }) } catch { return false }
  if (!ents.length) return /^https?/i.test(name)
  let hasToolTxt = false
  for (const e of ents) {
    if (e.isDirectory()) {
      if (!OWN_CACHE_DIRS.has(e.name)) return false
      continue
    }
    if (/\.tool\.txt$/i.test(e.name)) hasToolTxt = true
    else if (!/^(meta\.json|.*\.lock)$/i.test(e.name)) return false
  }
  return hasToolTxt || /^https?/i.test(name)
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
    if (e.isDirectory() && (/^BV[0-9A-Za-z]{10}/i.test(e.name) || OWN_CACHE_DIRS.has(e.name) || looksLikeOwnUrlDir(p, e.name))) {
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
    'ffmpeg', // W-57：裸名 = 走 PATH，由 resolveFfmpeg() 试跑确认（CLI 的 findFfmpeg 早就有这条）
  ].filter(Boolean)
}
let ffmpegProbeCache = { at: 0, path: '' }
/** W-57（2026-10-28 全量检查）：面板侧的 ffmpeg 探测必须与 CLI（tools/look.mjs:750 findFfmpeg）同口径——
 *  文件候选查存在性，裸 'ffmpeg' 要试跑 -version（PATH 里装了也算有）。
 *  原来只 existsSync，于是「CLI 能抽帧、面板却说没装 ffmpeg」的谎报完全成立（用户最容易当场发现）。
 *  回归复核（2026-10-28）：这个函数在 GET /status 里被同步调用，而 /status 每 8 秒轮询一次——
 *  execFileSync 会阻塞事件循环，所以 timeout 从 5000 收到 1200（ffmpeg -version 正常 <100ms），
 *  缓存从 60s 提到 300s。最坏情况从「每 60 秒卡 5 秒」降到「每 5 分钟卡 1.2 秒」；
 *  没装 ffmpeg 的机器根本不会 spawn（execFileSync 在 PATH 查找失败就抛 ENOENT，约 1ms）。 */
function resolveFfmpeg() {
  const now = Date.now()
  if (now - ffmpegProbeCache.at < 300000) return ffmpegProbeCache.path
  let hit = ''
  for (const c of ffmpegCands()) {
    if (c !== 'ffmpeg') {
      if (existsSync(c)) { hit = c; break }
      continue
    }
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 1200, windowsHide: true })
      hit = c
      break
    } catch {}
  }
  ffmpegProbeCache = { at: now, path: hit }
  return hit
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
  } catch (e) {
    // X-16a 同族（2026-10-28）：原来坏文件静默回默认值，紧接着 writeUiCfg 就把坏文件覆盖掉——
    // 用户手改坏的 4 个开关再也找不回来。这里先改名留档（rename 后文件就不存在了，不会重复备份）。
    if (e?.code !== 'ENOENT') {
      const bak = `${UI_CFG}.broken-${Date.now()}`
      try {
        renameSync(UI_CFG, bak)
        cfgWarning = `ui-config.json 解析失败（${String(e?.message || e)}），原文件已备份为 ${basename(bak)}，本次按默认值继续`
      } catch (e2) {
        cfgWarning = `ui-config.json 解析失败（${String(e?.message || e)}）且备份失败（${String(e2?.message || e2)}），本次按默认值继续`
      }
    }
    return { ...DEFAULT_UI_CFG }
  }
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
  cuda: '约 500 MB（pip 三个 wheel）',
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
      child = spawn(process.execPath, [LOOK, ...args], {
        windowsHide: true,
        // A-6（2026-10-28 阶段A）：POSIX 下 killTree 用 process.kill(-pid) 杀整个进程组，要求子进程自成进程组。
        //   spawn 未 detached 时 -pid 必抛 ESRCH（子进程不在独立进程组里）。win32 走 taskkill /T /F，不受影响，
        //   故只在非 win32 开 detached。本机是 Windows，这条 POSIX 分支未在本机验证。
        detached: process.platform !== 'win32',
      })
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
  // B-01（2026-10-29）：以前没 signal，DNS 黑洞/TCP 挂死时这个请求永久 pending，
  //   前端就一直转「正在生成二维码…」。8 秒拿不到就当网络问题报错。
  const r = await fetch(QR_GEN, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
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
  // B-05（2026-10-29）：轮询同理，没有 signal 时断网会让每次 poll 都挂到 TCP 超时。
  const res = await fetch(QR_POLL(key), { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) })
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
    // B-10（2026-10-29）：记下这次写的 mtime，resolveCredPath 见到它就优先用这份，
    //   不让 panel 侧的旧号靠 mtime 仲裁把刚扫的号盖掉。
    try { sharedWrittenAt = statSync(SHARED_CRED).mtimeMs } catch { sharedWrittenAt = 0 }
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
    // W-28（2026-10-28 阶段B-③）：与 tools/look.mjs 的 loadCred 四字段判据对齐。
    //   阶段 A 的 A-4 只修了 CLI 侧，面板这半边一直是「文件存在 + 30 天年龄」就算 ok——
    //   残缺凭证（缺 sessdata/bili_jct/buvid3/buvid4）照样报 ok，面板依赖清单打 ✓，
    //   而实际所有请求都在匿名态：用户以为登录了，拿到的却是匿名结果，且看不出哪里不对。
    const missing = ['sessdata', 'bili_jct', 'buvid3', 'buvid4'].filter((k) => !j?.[k])
    if (missing.length) return { exists: true, state: 'incomplete', missing, updatedAt: t, ageDays }
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
      // 10-28：标记文件与运行日志不算「缓存占用」——面板「当前占用」应当等于「立即清除能清掉的量」，
      // 否则清了以后永远显示 52 B + 日志大小，用户以为没清干净。
      if (e.name === CACHE_MARK || e.name === '_logs') continue
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

// WB-CN N13（2026-10-28）：原来吞异常、无返回值，三处调用都不看结果——「保存规则」写盘失败仍回
// 200 {ok:true}，与 BLK-02 同族（BLK-02 只修了 tuning 那条）。现在把结果交出去，调用方按失败处理。
function writeCacheCfg(days, maxMb) {
  try {
    writeFileSync(CACHE_CFG, JSON.stringify({ days, maxMb }), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, why: String(e?.message || e) }
  }
}

/** 合并写 deps\deps-config.json（只动指定字段，保留用户原有配置）。失败返回 {ok:false,error}，不抛。 */
function writeDepsCfg(patch) {
  const p = join(DEPS, 'deps-config.json')
  const cur = readDepsCfgFile(p)
  const next = { ...cur, ...patch }
  try {
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
    // issue #2 P2-2（2026-10-28）：resolveFfmpeg 有 5 分钟缓存，改了 ffmpeg 路径后 /status 还会
    //   报旧路径 5 分钟。配置一写就清缓存，下一次 /status 立刻重探。
    ffmpegProbeCache = { at: 0, path: '' }
    return { ok: true, data: next }
  } catch (e) {
    return { ok: false, why: String(e?.message || e) }
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
  if (!opts.force && Date.now() - lastCleanAt < 10 * 60 * 1000) return { removed: 0, bytes: 0, skipped: true, failed: [] }
  if (!existsSync(CACHE)) return { removed: 0, bytes: 0, failed: [] }
  // W-04（2026-10-28 阶段B-①）：有正在跑的转写/抽帧（任何子目录有 .lock）就不自动清，
  //   否则会删掉正在写的 asr/sheet 产物（转写白跑且无提示）。与 /cache/clear 同判据。
  if (hasAnyLock(CACHE)) return { removed: 0, bytes: 0, skipped: true, locked: true, failed: [] }
  const { days, maxMb } = cacheCfg()
  const cutoff = Date.now() - days * 86400000
  const limit = maxMb * 1024 * 1024
  const entries = walkEntries(CACHE)
  let removed = 0
  let bytes = 0
  // M-05：删不掉的文件必须记下来。以前两处 catch {} 是空的，被占用 / 只读 / 超长路径时
  //   静默跳过，removed 不加、bytes 不减，调用方以为清干净了（与 clearCache 的 failed 清单对齐）。
  const failed = []
  const fresh = []
  for (const e of entries) {
    if (e.mtime < cutoff) {
      try {
        rmSync(e.path, { force: true })
        removed += 1
        bytes += e.size
      } catch (err) {
        failed.push({ name: relative(CACHE, e.path), why: String(err?.message || err) })
      }
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
      } catch (err) {
        failed.push({ name: relative(CACHE, e.path), why: String(err?.message || err) })
      }
      if (total <= limit) break
    }
  }
  // 清单 1-7：只删文件会留一堆空目录（跑 100 个视频留 100 个空目录）；删完后自底向上清白名单内空目录
  pruneEmptyDirs(CACHE)
  lastCleanAt = Date.now()
  return { removed, bytes, failed }
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

/**
 * 10-28 豆包派单（20261028-1015-DB）：取消绝对路径遮罩，面板显示完整路径。
 * 原来按「14-8」把 /status 里的本机绝对路径遮成 `…\basename`，理由是「别把本机路径吐给面板」。
 * 现在这个理由不成立：`/api/bili-watch` 的每个请求（**含 GET /status**）在进路由分支之前
 * 都先过 `sameOriginBlocked(req)`，而它的第一条判据就是 `socket.remoteAddress` 必须是回环——
 * 非本机请求拿不到 /status，遮罩挡的是「本来就读不到的人」。
 * 保留函数（11 处调用点不改名）但退化成直通，方便以后真要遮时只改这一处。
 * 承重墙：verify C5 有行为断言盯着那条回环判据，C14 盯着「闸在路由分支之前」。
 */
function maskAbs(p) {
  return String(p || '')
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

// 第十条（2026-10-29）：GPU 状态。三个问题分开答，别混成一个布尔：
//   deviceCount——有没有 NVIDIA 卡（nvidia-smi -L 的行数）
//   dllReady——cuBLAS DLL 能不能真加载（派单要求：不看 pip 包名，真跑 ctypes.WinDLL）
//   cudaLibs——venv 里有没有 nvidia 包（只作说明，不作 ok 判据）
// 探测要跑两个子进程，/status 每 8 秒轮询一次，所以缓存 5 分钟；删完 GPU 运行库后 resetGpuCache() 立刻作废。
// GPU 第二轮（2026-10-29）：原来 probeGpu 是同步 execFileSync，缓存失效那一次会堵住事件循环，
//   而面板 8 秒轮询 + 用户手点刷新很容易同时来两个 /status。改成异步 + 模块级 in-flight Promise：
//   在飞期间所有调用复用同一个 Promise，探测完清空，缓存照旧 5 分钟。超时从 5 秒砍到 3 秒。
const GPU_PROBE_TIMEOUT_MS = 3000
const GPU_CACHE_MS = 5 * 60 * 1000
let _gpuCache = { at: 0, val: null }
let _probePromise = null
function resetGpuCache() {
  _gpuCache = { at: 0, val: null }
  _probePromise = null
}
function gpuStatus() {
  // 没有 force 形参：强刷统一走 resetGpuCache()。留一个没人传的 force 会让下一个人
  //   以为「传 true 能强刷」，而实际刷新路径已经改成 resetGpuCache()，两套机制并存会分叉。
  if (_gpuCache.val && Date.now() - _gpuCache.at < GPU_CACHE_MS) return Promise.resolve(_gpuCache.val)
  if (_probePromise) return _probePromise // 在飞就复用，并发 5 次也只起一套 nvidia-smi
  _probePromise = probeGpu()
    .then((val) => { _gpuCache = { at: Date.now(), val }; return val })
    .catch(() => {
      const val = { deviceCount: 0, dllReady: false, cudaLibs: false, note: 'GPU 探测异常，按无卡处理' }
      _gpuCache = { at: Date.now(), val }
      return val
    })
    .finally(() => { _probePromise = null })
  return _probePromise
}
/** execFile 的 Promise 版：不 reject，统一回 {ok, stdout, err}，省得每处都 try。 */
function execFileP(file, args, opts) {
  return new Promise((resolveP) => {
    try {
      execFile(file, args, opts, (err, stdout) => resolveP({ ok: !err, stdout: String(stdout ?? ''), err }))
    } catch (e) {
      resolveP({ ok: false, stdout: '', err: e })
    }
  })
}
async function probeGpu() {
  const notes = []
  let deviceCount = 0
  const smi = await execFileP('nvidia-smi', ['-L'], { timeout: GPU_PROBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true })
  if (smi.ok) {
    deviceCount = smi.stdout.split('\n').filter((l) => /^\s*GPU\s+\d+:/.test(l)).length
  } else {
    notes.push('没有 nvidia-smi（未装 NVIDIA 驱动，或不是 NVIDIA 卡）')
  }
  const py = venvAsr().find((p) => existsSync(p)) || ''
  let dllReady = false
  let cudaLibs = false
  if (py) {
    const spec = await execFileP(py, ['-c', 'import importlib.util as u, sys; sys.exit(0 if u.find_spec("nvidia") else 1)'], { timeout: GPU_PROBE_TIMEOUT_MS, stdio: 'ignore' })
    cudaLibs = spec.ok
    if (process.platform === 'win32') {
      const dll = await execFileP(py, ['-c', 'import ctypes; ctypes.WinDLL("cublas64_12.dll")'], { timeout: GPU_PROBE_TIMEOUT_MS, stdio: 'ignore' })
      dllReady = dll.ok
      if (!dllReady) notes.push('cublas64_12.dll 加载失败（GPU 运行库未装，或装了但不在 DLL 搜索路径里）')
    } else {
      notes.push('非 Windows：GPU 运行库走系统 CUDA，不做 DLL 探测')
    }
  } else {
    notes.push('ASR 环境还没装，装完才能判断 GPU 运行库')
  }
  return { deviceCount, dllReady, cudaLibs, note: notes.join('；') }
}

// C-04（2026-10-29）：面板以前只看 venv 里的 python.exe 在不在就标绿。缺 VC++ Redist 时
//   import faster_whisper 抛 "DLL load failed: vcruntime140.dll not found"——面板绿着，一跑就崩。
//   这里真跑一次 import。代价是 Windows 上 python 启动 + ctranslate2 import 约 0.5–2 秒，
//   而 /status 每 8 秒轮询一次，不能每次都跑，所以按「python 路径 + 它自己的 mtime + 探针代码」缓存 5 分钟；
//   venv 重装（python.exe 的 mtime 变）会立刻重探。
const IMPORT_TTL_MS = 5 * 60 * 1000
let importCache = {}
// OCR 的模块名 1.x 是 rapidocr_onnxruntime、2.x 是 rapidocr，两个都试；
// 真 __import__ 才能暴露 onnxruntime 的 DLL 问题，find_spec 只查得到包在不在。
const OCR_IMPORT_CODE =
  'import importlib.util as u, sys\n' +
  'for m in ("rapidocr_onnxruntime", "rapidocr"):\n' +
  '    if u.find_spec(m):\n' +
  '        __import__(m)\n' +
  '        sys.exit(0)\n' +
  'sys.exit(1)\n'
function pyProbe(py, code) {
  if (!py) return { ok: false, why: '没有 python 环境' }
  let stamp = 0
  try { stamp = statSync(py).mtimeMs } catch {}
  const key = `${py}|${stamp}|${code}`
  const hit = importCache[key]
  if (hit && Date.now() - hit.at < IMPORT_TTL_MS) return { ok: hit.ok, why: hit.why, cached: true }
  let ok = false
  let why = ''
  try {
    // stdio 必须显式写全：execFileSync 默认会把子进程 stderr 直接透到父进程 stderr，
    // 探测失败时每次都会往 DSH 日志里刷一段 Python traceback。
    execFileSync(py, ['-c', code], { timeout: 15000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    ok = true
  } catch (e) {
    const raw = String(e?.stderr || e?.message || e)
    why = (raw.split('\n').map((s) => s.trim()).filter(Boolean).slice(-1)[0] || '未知原因').slice(0, 160)
  }
  // 按 key 存，不能整体替换：depRows 每轮跑两个探针（asr 的 import faster_whisper、
  //   ocr 的 rapidocr），整体替换会让后跑的挤掉先跑的，两条永远都不命中——5 分钟 TTL 直接失效，
  //   真装了 ctranslate2 的机器上每 8 秒轮询会起 2 个子进程、阻塞事件循环 2–4 秒。
  importCache[key] = { at: Date.now(), ok, why }
  // 防涨：key 只可能来自「venv 路径 × python.exe mtime × 探针代码」这几种组合，正常 ≤4 条。
  //   超过 8 条说明 mtime 一直在变（venv 反复重装），清掉旧的、只留当前这条。
  if (Object.keys(importCache).length > 8) importCache = { [key]: importCache[key] }
  return { ok, why }
}

/** 面板上的依赖行：一条依赖一个状态 + 体积 + 是否需要下载。 */
async function depRows(gpuVal) {
  // W-57：用 resolveFfmpeg()（同 CLI 口径，含 PATH 试跑）而不是 existsSync 硬查文件
  const ffmpeg = resolveFfmpeg()
  const ffmpegOnPath = ffmpeg === 'ffmpeg'
  let ffmpegSize = 0
  try {
    ffmpegSize = (ffmpeg && !ffmpegOnPath) ? statSync(ffmpeg).size : 0
  } catch {}
  const ytdlp = join(DEPS, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  let ytdlpSize = 0
  try {
    ytdlpSize = existsSync(ytdlp) ? statSync(ytdlp).size : 0
  } catch {}
  const asrPython = venvAsr().find((p) => existsSync(p)) || ''
  const ocrPython = venvOcr().find((p) => existsSync(p)) || ''
  const model = hfHomes().find((d) => existsSync(d)) || ''
  // C-04：python.exe 在 ≠ 环境能用。真 import 一次（5 分钟缓存），失败就把原因写进 detail。
  const asrProbe = asrPython ? pyProbe(asrPython, 'import faster_whisper') : { ok: false, why: '' }
  const ocrProbe = ocrPython ? pyProbe(ocrPython, OCR_IMPORT_CODE) : { ok: false, why: '' }
  const rows = [
    {
      id: 'ffmpeg',
      name: 'ffmpeg（抽帧 / 取音轨）',
      ok: Boolean(ffmpeg),
      detail: ffmpeg
        ? (ffmpegOnPath ? '在系统 PATH 里（ffmpeg -version 可执行）' : maskAbs(ffmpeg))
        : '没找到，抽帧与转写取音轨会失败',
      path: ffmpegOnPath ? 'ffmpeg' : maskAbs(ffmpeg),
      removable: false,
      removableWhy: ffmpegOnPath ? '来自系统 PATH，插件不管它' : '在插件目录外，这里不删',
      size: ffmpegSize,
      estimate: ESTIMATES.ffmpeg,
    },
    {
      id: 'ytdlp',
      name: 'yt-dlp（通用 URL）',
      ok: existsSync(ytdlp),
      // 2026-10-28：原先 detail 只写「版本 X」，与其它依赖行（detail 都是路径）不一致，
      // 面板上就变成「只有版本号、看不出装在哪」。改成路径，版本拼在括号里。
      detail: (() => {
        if (!existsSync(ytdlp)) return '没找到，非 B 站 URL 不可用'
        const v = ytdlpVersion()
        return `${maskAbs(ytdlp)}${v ? `（v${v}）` : ''}`
      })(),
      path: maskAbs(ytdlp),
      removable: true,
      size: ytdlpSize,
      estimate: ESTIMATES.ytdlp,
    },
    {
      id: 'asr',
      name: 'ASR 环境（本地转写）',
      ok: Boolean(asrPython) && asrProbe.ok,
      detail: !asrPython
        ? '没找到 python 环境，无字幕视频无法转写'
        : (asrProbe.ok ? maskAbs(asrPython) : `python 在，但 import faster_whisper 失败：${asrProbe.why || '未知原因'}`),
      path: maskAbs(asrPython),
      removable: false,
      // P1-2（2026-10-28 全量检查）：文案原来写「在插件目录外」——错的，默认就装在 deps/.venv-asr。
      //   真实理由是这个环境目录不从这里删（删了要重跑 fetch-deps 装回来，代价远大于省下的空间）。
      removableWhy: '环境目录不从这里删（删了要重跑 fetch-deps 装回来）',
      size: asrPython ? dirStat(join(asrPython, '..', '..')).bytes : 0,
      estimate: ESTIMATES.asr,
    },
    {
      id: 'ocr',
      name: 'OCR 环境（画面文字）',
      ok: Boolean(ocrPython) && ocrProbe.ok,
      detail: !ocrPython
        ? '没找到 python 环境，画面文字无法识别'
        : (ocrProbe.ok ? maskAbs(ocrPython) : `python 在，但 import rapidocr 失败：${ocrProbe.why || '未知原因'}`),
      path: maskAbs(ocrPython),
      removable: false,
      removableWhy: '环境目录不从这里删（删了要重跑 fetch-deps 装回来）',
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
  // 第十条（2026-10-29）：第 7 项 GPU 运行库。ok 判据是「DLL 真能加载」，不是「pip 包在不在」
  //   ——包可能在 site-packages 里而 DLL 在别处（或反之）。removable 只认 pip 装的那份
  //   （系统装的 CUDA Toolkit 不归我们管，面板不给删）。
  const gpu = gpuVal || (await gpuStatus())
  const cudaSize = (() => {
    try {
      const py = venvAsr().find((p) => existsSync(p)) || ''
      if (!py || process.platform !== 'win32') return 0
      return dirStat(join(dirname(dirname(py)), 'Lib', 'site-packages', 'nvidia')).bytes
    } catch { return 0 }
  })()
  rows.push({
    id: 'cuda',
    name: 'GPU 运行库（cuBLAS + cuDNN）',
    ok: gpu.dllReady,
    detail: gpu.dllReady
      ? `已就绪${gpu.deviceCount ? `（${gpu.deviceCount} 块 NVIDIA 卡）` : ''}，转写走 GPU`
      : (gpu.deviceCount
        ? `检测到 ${gpu.deviceCount} 块 NVIDIA 卡，但运行库没装好——装上转写快 2-8 倍`
        : (gpu.note || '没有 NVIDIA 卡，转写走 CPU')),
    path: gpu.dllReady ? 'cublas64_12.dll' : '',
    removable: gpu.cudaLibs,
    removableWhy: gpu.cudaLibs ? '' : '还没装（或装在系统里，不归插件管），没什么可删的',
    size: cudaSize,
    estimate: ESTIMATES.cuda,
  })
  const cred = credState()
  rows.push({
    id: 'credential',
    name: 'B 站登录凭证',
    ok: cred.state === 'ok',
    // W-28：残缺要说出来，否则面板只显示「更新于 N 天前」，看不出其实走的是匿名
    detail: !cred.exists
      ? '没登录，AI 字幕与部分接口不可用'
      : cred.state === 'incomplete'
        ? `凭证残缺（缺 ${cred.missing.join('/')}），实际走匿名；点登录重新扫码`
        : `更新于 ${cred.updatedAt ?? '未知时间'}（${cred.ageDays ?? '?'} 天前）`,
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
  // A-下载黑洞：以前是 stdio:'ignore'——脚本 throw 的文本（比如 fetch-deps.ps1 里
  //   「找不到 Python 3.10–3.14」）全被丢掉，download.log 里只有「开始下载」一行，
  //   用户等 5 分钟看到 ASR 还是红的，不知道是 Python 没装还是版本不对。
  //   这里把子进程 stdout/stderr 直接重定向到 download.log 的文件描述符（不是 pipe）：
  //   · 不占事件循环，detached + unref 的「关掉宿主也能继续下」语义不变；
  //   · 脚本输出逐行落盘，失败时能看到真正的 throw 文本。
  let logFd = null
  try {
    logFd = openSync(DOWNLOAD_LOG, 'a')
  } catch {}
  try {
    child = spawn(cmd, args, {
      windowsHide: true,
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      detached: true,
    })
  } catch (e) {
    if (logFd !== null) try { closeSync(logFd) } catch {}
    return { started: false, why: String(e?.message ?? e) }
  }
  // 父进程这侧的句柄用完就关；子进程继承的那一份仍然有效（Windows 句柄继承 / POSIX fork 语义）
  if (logFd !== null) try { closeSync(logFd) } catch {}
  // detached 子进程不会把 spawn 失败同步抛给我们，必须自己接 error，否则 ENOENT 会带崩宿主
  child.on('error', (e) => {
    try {
      appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] 启动失败 ${target}：${e?.message ?? e}\n`, 'utf8')
    } catch {}
  })
  // A-下载黑洞（后半）：记退出码。以前脚本崩在 pip install / 模型下载中途，
  //   日志里既没有 stdout 也没有退出码，排障无路。
  child.on('exit', (code, signal) => {
    try {
      const tail = signal ? `信号 ${signal}` : `退出码 ${code ?? 'null'}`
      const bad = (code ?? 0) !== 0 || Boolean(signal)
      appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] ${target} 结束，${tail}${bad ? '（失败）' : '（成功）'}\n`, 'utf8')
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
      // X-10（2026-10-29）：删完记下「此刻 panel 小号那份的 mtime」。syncPanelSmallToShared 会跳过
      //   不晚于它的复制，否则 8 秒轮询又把 panel small 复制回来，用户看到凭证「自己长回来」。
      //   panel 重新扫码后 PANEL_SMALL 的 mtime 会变新 → 自动恢复复制，不需要用户手动解禁。
      try {
        let panelMtime = 0
        try { panelMtime = statSync(PANEL_SMALL).mtimeMs } catch {}
        mkdirSync(dirname(CRED_CLEARED), { recursive: true })
        writeFileSync(CRED_CLEARED, JSON.stringify({ at: Date.now(), panelMtime }), 'utf8')
      } catch {}
      // 2026-10-27 批次9：resolveCredPath() 现在是「两处写入口谁新用谁」，所以删掉 watch 自己的
      // 两份不等于「未登录」——panel 的大号凭证还在就会继续用它。这里如实说明，不删 PANEL
      // （那是业务侧只读身份，归 panel/业务管，watch 删它会毁掉大号）。
      if (existsSync(PANEL_CRED)) {
        skipped.push({ id: t, why: 'panel 大号凭证仍在（bili-duty/bili_credential.json），watch 会继续用它；要彻底未登录请到业务侧处理' })
      }
      continue
    }
    if (t === 'cuda') {
      // 第十条（2026-10-29）：必须走 pip uninstall——只删目录会留下 *.dist-info，
      //   重装时 pip 报「已安装」但文件没了。失败把 stderr 放进 skipped。
      const py = venvAsr().find((p) => existsSync(p)) || ''
      if (!py) { skipped.push({ id: t, why: 'ASR 环境还没装，没有 GPU 运行库可删' }); continue }
      try {
        execFileSync(py, ['-m', 'pip', 'uninstall', '-y', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12', 'nvidia-cuda-nvrtc-cu12'], {
          timeout: 120000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        })
        deleted.push(t)
        resetGpuCache() // 清探测缓存，面板下一次轮询就能看到「已删」
      } catch (e) {
        skipped.push({ id: t, why: String(e?.stderr || e?.message || e).slice(-300) })
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
  // P1（2026-10-28 全量检查）：Host 是请求方随便写的头，挡不住「宿主把 webServer 绑到 0.0.0.0」的情况——
  //   局域网内 `curl -H 'Host: 127.0.0.1' -H 'Origin: http://127.0.0.1' -H 'Content-Type: application/json'
  //   -X POST .../delete -d '{"target":"credential"}'` 能一路过掉下面所有判据。
  //   真正靠得住的对端地址只有 socket.remoteAddress，先加一条回环兜底（全文原来 0 处 remoteAddress）。
  const peer = String(req.socket?.remoteAddress || '')
  if (peer && !/^(::1|::ffff:127\.|127\.)/.test(peer)) {
    return `非本机请求被拒绝（对端地址 ${peer} 不是回环）`
  }
  const host = hostNameOf(req.headers?.host)
  // DNS rebinding：攻击者把自己的域名解析到 127.0.0.1，Origin 与 Host 就都是他自己的域名，
  // 只比两者相等挡不住（2026-10-24 wb 第二轮实测 Host/Origin 同为 evil.example:3080 返回 200）。
  // 所以先要求 Host 是回环，再比 Origin。
  if (!LOOPBACK.has(host)) return "非本机请求被拒绝（Host 必须是回环地址）"
  const method = String(req.method || 'GET').toUpperCase()
  const mutating = method !== 'GET' && method !== 'HEAD'
  const origin = req.headers?.origin
  const site = req.headers?.["sec-fetch-site"]
  // 14-6：写操作必须带 Origin 且同源。不带 Origin 的（curl 直打、旧浏览器）一律拒——
  // 原本 `if (origin)` 是可选的，等于裸 POST 没有任何同源校验。
  // 2026-10-28 issue #2 P1-1 修正：DSH 桌面端壳层的同源 fetch **不带 Origin**（实测复现：
  //   无 Origin 的 POST → 403「缺少 Origin 头」，面板所有写操作全废）。改成有 Origin 才严格同源，
  //   没 Origin 时只拒 sec-fetch-site 明确写着跨站的（cross-site / same-site），
  //   其余交给下面「必须 application/json」那条兜——CSRF 的简单请求向量走不到这里。
  if (mutating && !origin) {
    if (site === "cross-site" || site === "same-site") {
      return `跨站写请求被拒绝（缺少 Origin 且 sec-fetch-site=${site}）`
    }
  }
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
  // site 在上面写操作分支已取过（2026-10-28 issue #2 P1-1），这里直接复用，不要重复声明。
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
    // M-05：删不掉的文件别再静默跳过，至少留一行可查的日志（被 ffmpeg/python 占用、只读、超长路径）
    if (r.failed?.length) ctx.logger?.warn?.(`[dsh-bili-watch] 自动清理缓存有 ${r.failed.length} 个文件没删掉：${r.failed.slice(0, 3).map((f) => f.name).join('、')}${r.failed.length > 3 ? ' 等' : ''}`)
  } catch {}

  // X-30 第二轮：deps 搬家排后台（3 秒后，那时插件已注册完）。本次启动仍用包内那份。
  scheduleDepsMigration()

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
    toolsWarning = '[dsh-bili-watch] 未找到 @deepseek-ai/dsh-tools，bili_watch 工具未注册（/bili 命令与插件面板不受影响）'
    console.warn(toolsWarning)
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
            if (blocked) return sendJson(res, 403, { ok: false, why: blocked })
            try {
              const url = new URL(req.url, 'http://127.0.0.1')
              if (req.method === 'GET' && url.pathname === '/api/bili-watch/status') {
                const cleaned = autoCleanCache()
                // GPU 探测一次就够：depRows 的 cuda 行与 data.gpu 用同一份结果，别各探一遍
                const gpuNow = await gpuStatus()
                return sendJson(res, 200, {
                  ok: true,
                  data: {
                    credential: credState(),
                    deps: await depRows(gpuNow),
                    // 第十条（2026-10-29）：GPU 三态给面板用（有卡有库 / 有卡无库 / 无卡）。
                    //   探测结果 5 分钟缓存，不随 8 秒轮询跑子进程。
                    gpu: gpuNow,
                    cache: { ...dirStat(CACHE), ...cacheCfg(), dir: maskAbs(CACHE), lastAutoClean: cleaned },
                    tuning: readTuning(),
                    tuningDefaults: tuningDefaults(),
                    tuningRanges: tuningRanges(),
                    lastRun: readLastRun(),
                    ui: uiCfg(),
                    warnings: [cfgWarning, toolsWarning, depsWarning].filter(Boolean),
                  },
                })
              }
              // 参数分层（阶段B）：GET /config 只读回参数表本身，供面板单独取一次
              // （/status 每 8 秒轮询一次，带全量 deps 扫描；这里只回五个数值）
              if (req.method === 'GET' && url.pathname === '/api/bili-watch/config') {
                return sendJson(res, 200, {
                  ok: true,
                  data: { tuning: readTuning(), defaults: tuningDefaults(), ranges: tuningRanges() },
                })
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/cache/pick') {
                try {
                  const dir = await pickFolderDialog()
                  if (!dir) return sendJson(res, 200, { ok: false, why: '已取消' })
                  // 6-17：写 deps-config.json 可能失败（文件只读等），原来直接抛错被外层吞成 500，
                  // 面板可能显示已保存；这里显式回「保存失败」。
                  const w = writeDepsCfg({ cache: dir })
                  if (!w.ok) return sendJson(res, 500, { ok: false, why: `保存失败：${w.why || '未知错误'}` })
                  return sendJson(res, 200, { ok: true, data: { dir, restart: true } })
                } catch (e) {
                  return sendJson(res, 500, { ok: false, why: String(e?.message || e) })
                }
              }
              if (req.method === 'POST' && url.pathname === '/api/bili-watch/cache/clear') {
                const body = await readJsonBody(req)
                if (Number.isFinite(body?.days) || Number.isFinite(body?.maxMb)) {
                  const wc = writeCacheCfg(
                    Number.isFinite(body?.days) ? Math.max(1, body.days) : cacheCfg().days,
                    Number.isFinite(body?.maxMb) ? Math.max(100, body.maxMb) : cacheCfg().maxMb,
                  )
                  if (!wc.ok) return sendJson(res, 500, { ok: false, why: `清理规则保存失败：${wc.why || '未知错误'}` })
                }
                // A7（2026-10-27 批次8）：先查锁再清理——frames 下若有正在跑的抽帧锁，直接拒绝，
                //   不再像以前那样「先删完再补一句 warning」（锁外删会跟运行中的抽帧抢目录）。
                //   锁可能在 frames/.lock 根，也可能在每个抽帧子目录 frames/<bv>-pN-<step>s/.lock。
                // A-3（2026-10-28 阶段A）：原来只查 frames 一层锁，漏掉 sheet-tmp / substrip-tmp /
                //   CACHE 根的 .meta-*.lock / asr 等会写盘的子目录。改成递归扫（hasAnyLock，限深度 3）。
                const locked = hasAnyLock(CACHE)
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
                let cacheErr = null
                if (Number.isFinite(body?.days) && body.days > 0) {
                  const cur = cacheCfg()
                  const days = Math.max(1, Math.floor(body.days))
                  const maxMb = Number.isFinite(body?.maxMb) && body.maxMb > 0 ? Math.max(100, Math.floor(body.maxMb)) : cur.maxMb
                  const wc = writeCacheCfg(days, maxMb)
                  if (!wc.ok) cacheErr = wc.why || '未知错误'
                  rule = { days, maxMb }
                } else if (Number.isFinite(body?.maxMb) && body.maxMb > 0) {
                  const cur = cacheCfg()
                  const maxMb = Math.max(100, Math.floor(body.maxMb))
                  const wc = writeCacheCfg(cur.days, maxMb)
                  if (!wc.ok) cacheErr = wc.why || '未知错误'
                  rule = { days: cur.days, maxMb }
                }
                // 参数分层（阶段B）：白名单键写进 deps-config.json，表外的键忽略、不报错。
                // 值为 null = 恢复默认（从文件里删掉该键，回落到常量）；值非法 = 400 报错（D-01/D-02）。
                let tuneErr = null
                let tuneCode = 500
                if (TUNING_KEYS.some((k) => body && Object.prototype.hasOwnProperty.call(body, k))) {
                  const w = writeTuning(body)
                  if (!w.ok) { tuneErr = w.why || '未知错误'; tuneCode = w.code || 500 }
                }
                if (tuneErr) return sendJson(res, tuneCode, { ok: false, why: `参数保存失败：${tuneErr}` })
                if (cacheErr) return sendJson(res, 500, { ok: false, why: `清理规则保存失败：${cacheErr}` })
                return sendJson(res, 200, { ok: true, data: { ...next, ...(rule || {}), tuning: readTuning() } })
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
