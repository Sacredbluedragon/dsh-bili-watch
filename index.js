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
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, relative, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 2026-10-31 切片 1：cleanKey / bvOf / cutCp / looksLikeOwnUrlDir 原来在本文件有一份、
//   tools/look.mjs 里也有一份（逐字相同）。搬进 lib/keys.mjs 后物理上只剩一份，两个进程各 import。
//   依赖只有一个只读常量 OWN_CACHE_DIRS（lib/consts.mjs），不碰可变状态，可以放心共用。
// 2026-10-31 切片 2：锁判据（pidAlive / readLock / lockExpired / hasAnyLock / isAdoptableDir）
//   同理搬进 lib/locks.mjs；CACHE_MARK 从 lib/consts.mjs 拿。
// 2026-10-31 切片 4：consts 里的两个常量在本文件已经没人读了——CACHE_MARK 只被 pickCacheDir 用、
//   OWN_CACHE_DIRS 只被 migrateLegacyCache 用，两者都搬进 lib/cache-path.mjs 了。
//   留着 import 会让人以为本文件还在判根标记/子目录归属。
// 切片 4：isAdoptableDir 只被 lib/cache-path.mjs 的 resolveCacheDir 用，本文件不再直接调用。
import { hasAnyLock } from './lib/locks.mjs'
// 2026-10-31 切片 2：删除面判据（归属 / 根标记 / 统计 / 清除）搬进 lib/cache-own.mjs。
//   切片 4 起 isOwnBvDir 也不再直接调用（isOwnedEntry 在 lib 里用它），这里只留还读得到的四个。
import { dirStat, isOwnedEntry, isOurCacheRoot, removeOwned } from './lib/cache-own.mjs'
import { cleanKey, bvOf, cutCp, looksLikeOwnUrlDir } from './lib/keys.mjs'
// 2026-10-31 切片 3：调优表与钳制/换算搬进 lib/tuning.mjs。
//   原来本文件与 tools/look.mjs 各写一份 TUNING_DEFS，靠 C17 逐键比对绑在一起；
//   现在物理上只有一份，两个入口只负责「把配置读出来」（depsCfg / readDepsCfg）。
import { TUNING_DEFS, TUNING_KEYS, lockTtlMsOf, normalizeTuning, tuningDefaults, tuningRanges } from './lib/tuning.mjs'
// 2026-10-31 切片 3-C：runs.jsonl 的轮转 + 追加搬进 lib/runs.mjs（收路径参数，不碰状态）。
import { logRun } from './lib/runs.mjs'
// 2026-10-31 切片 3-B：坏配置留档 + 回默认值的行为搬进 lib/config.mjs，返回结构化 problem，
//   文案由本文件组织（CLI 侧是英文，见 tools/look.mjs 的 readDepsCfg）。
import { readJsonOrBackup as readJsonOrBackupRaw } from './lib/config.mjs'
// 2026-10-31 切片 4：缓存根的**状态与初始化时序**搬进 lib/cache-path.mjs。
//   前三个切片搬的是纯函数，compile 抽出来跑等于真跑；这一片搬的是可变模块状态 + 「谁先调」，
//   所以判据也换了（C64 真起两个进程比对实际路径 / C65 未初始化必抛，见 tools/verify.mjs）。
import { cacheAdoptNotice, cacheDir, initCachePath, previewCacheDir, videoDir } from './lib/cache-path.mjs'
// 2026-10-31 切片 5：凭证的位置 / 完整性判据 / 旧路径迁移搬进 lib/cred.mjs。
//   本文件与 tools/look.mjs 原来各有一份迁移逻辑，四字段清单更是散在三处；
//   现在只有一份，两个入口各自把结构化结果翻译成自己的文案（面板静默 → /status，CLI 打 stderr）。
import { adoptLegacyCred, credPaths, fillBuvids, missingCredFields, pickLoginCookies } from './lib/cred.mjs'
// 2026-10-31 切片 7：路由守卫搬进 lib/route-claim.mjs（原样不改，只是从私有变导出，
//   好让 C74 直接断言「同路径被拒 / 不同路径不冲突 / release 后可重登记」）。
import { claimRoute, releaseRoute } from './lib/route-claim.mjs'
// @deepseek-ai/dsh-tools 是可选 peer：桌面版 autoInstallPeers:false，市场安装时不会自动装上。
// 缺了只少一个 bili_watch 工具，/bili 命令、插件面板与路由照常工作，不能因此整块加载失败。
// 工具输出上限：超了就把全文落文件、只回摘要。
// 由来：2026-10-26 一段 14 分钟视频的字幕 4,449 字整段塞进上下文，把会话挤爆两次。
// 2026-10-28 高级设置放开：两个上限改从 readTuning() 每次取（toolTextCap 默认 2000、toolHead 默认 800）。
// 不能写成模块级 const——index.js 是常驻进程，那样面板改了要重启才生效，和 cacheCfg 踩过的坑一样。
const toolTextCap = () => readTuning().toolTextCap
const toolTextHead = () => readTuning().toolHead

// 进程级路由守卫已搬到 lib/route-claim.mjs（2026-10-31 切片 7）——收进 lib 后可以直接
//   import 断言「不同路径不冲突 / release 后可重登记」，不必为了测试给生产代码开口子。

// cleanKey / bvOf 已搬到 lib/keys.mjs（2026-10-31 切片 1）——两处逐字相同的实现只留一份。
// videoDir 已搬到 lib/cache-path.mjs（2026-10-31 切片 4）——它读缓存根，而缓存根现在住在那个模块里。

// cutCp 已搬到 lib/keys.mjs（2026-10-31 切片 1）。

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
const KNOWN_FLAGS = ['--step', '--p', '--cred', '--days', '--limit', '--order', '--grid', '--out', '--ffmpeg', '--head', '--full', '--verify', '--format', '--fresh', '--ocr', '--poll', '--check', '--fast', '--scene', '--mark-seen', '--asr-max', '--quiet', '--no-time', '--at', '--help', '--frames', '--key']
// ↑ 2026-10-31：补 --key。login --poll --key <code> 要用它，表里漏了 → 提示「未知参数」并拒执行。
// ↑ 这张表只影响**提示文案**，真正决定收不收的是 parseCommandLine 的 if-else 链。两张表必须
//   保持一致，例外只有三个（C51 断言里钉住）：
//     --quiet  /bili 层有自己的渲染，用不上 CLI 的 QUIET 抑制
//     --help   /bili 没有 help 命令（look.mjs 那边才有）
//     --frames /bili 没有 local 命令；它是 --ocr 的别名，斜杠层传 --ocr 即可
// ↑ P2（2026-10-28 全量检查）：补 --asr-max。它早在 tools/look.mjs:2769 的 VALUE_OPTS 与 :2813 实现里
//   生效，却不在这张表里——斜杠命令传 `--asr-max 60000` 会同时「报未知参数」并「真的生效」，自相矛盾。
// ↑ 2026-10-30：再补 --quiet / --no-time / --at / --help / --frames。前两个是 0.3.9 新增的
//   （--no-time 在 cuesToTxt、--at 在 cmdFrames），后三个是一直漏的：--help 是真命令
//   （tools/look.mjs:4155 有 `cmd === 'help' || cmd === '--help'`）、--frames 是 local 的开关
//   （:3357 的 `opts.ocr || opts.frames`）。漏项的直接后果是给用户一句假提示「已忽略」。

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
// 而是攒进 cfgWarnings，由 /status 的 warnings 带给面板；ENOENT（没配过）不算异常。
// 2026-10-31 切片 3-B：原来是 `let cfgWarning = null`，谁后读谁覆盖——两个配置文件同时坏，
//   面板只看得到最后一条。现在攒成数组（去重，同一条不重复堆），读盘行为本身搬进 lib/config.mjs。
const cfgWarnings = []
const pushWarn = (msg) => { if (msg && !cfgWarnings.includes(msg)) cfgWarnings.push(msg) }
// issue #2 P3-3（2026-10-28）：bili_watch 工具没注册成功时原来只 console.warn，桌面端看不到控制台，
// 用户会以为「工具坏了」。改成同时记一条，由 /status 的 warnings 带到面板。
let toolsWarning = null
// #17（2026-10-30，P1）：原来这里是裸 JSON.parse——坏文件只记一条 warning 就返回 {}，
//   下一次任何写入口整份写回，就把用户手改坏的配置永久覆盖掉（正是 X-16a 修过的那个坑，
//   当时只修了 readDepsCfgFile / uiCfg，漏了读得最多的这一处）。
//   现在统一走 readDepsCfgFile：坏文件先改名留档，三个读入口只剩一种行为。
function depsCfg() {
  return readDepsCfgFile(join(DEPS, 'deps-config.json'))
}
// 参数分层（2026-10-28 阶段B）：面板可调的数值全部并进 deps\deps-config.json，不新开第四份配置文件。
// 表与钳制已搬到 lib/tuning.mjs（2026-10-31 切片 3）——原来这里与 tools/look.mjs 各写一份，
//   靠 C17 逐键比对绑在一起；现在物理上只剩一份，面板与 CLI 不可能再各读各的默认值。
/** 每次调用都读盘（照 cacheCfg 的写法）：index.js 是常驻进程，存闭包就是「面板改了插件还是老的」。 */
function readTuning() {
  return normalizeTuning(depsCfg())
}
/**
 * 读 deps-config.json，坏文件先备份再退回默认值（X-16a，2026-10-28 N12 §2 头号）。
 *
 * 原来两处写入口都是 `try { cur = JSON.parse(readFileSync(p)) } catch {}`：
 * 解析失败 cur 变 `{}`，下次改**任意一个**参数就整份写回——ffmpeg 路径、cache 目录、
 * proj、17 项调优参数全被擦掉。单写者就能触发，不需要并发，用户只会看到「配置莫名其妙没了」。
 *
 * 现在：文件不存在 → 默认值（正常）；存在但坏了 → 改名成 `.broken-<ts>` 留档 + 默认值 + 一次告警。
 * 留档而不是直接拒绝写，是因为拒绝写会让面板「保存」一直失败、用户也不知道该改哪个文件。
 */
/**
 * B2：坏 JSON 三入口统一。三处原来各写一遍「读不到 → 返回默认值；解析失败 → 改名留档 + 返回默认值」，
 *   现在抽成一个函数。行为以已经改对的那两处为准（uiCfg / cacheCfg）。
 * 留档而不是直接拒绝写，是因为拒绝写会让面板「保存」一直失败、用户也不知道该改哪个文件。
 */
/**
 * 读配置的统一薄壳：行为在 lib/config.mjs（留档 + 回默认值 + 结构化 problem），
 * 这里只负责把 problem 翻成中文文案并攒进 cfgWarnings。
 * 保留原签名（读不到就返回 fallback 本身），三处调用点（deps-config / ui / 缓存策略）不用改。
 */
function readJsonOrBackup(p, fallback) {
  const { value, problem } = readJsonOrBackupRaw(p, fallback)
  if (problem) pushWarn(cfgProblemText(p, problem))
  return value
}
/** problem → 面板上那句中文。文案留在 index.js：CLI 侧要的是 ASCII 前缀的英文（见 tools/look.mjs）。 */
function cfgProblemText(p, problem) {
  const name = basename(p)
  const err = problem.error
  if (problem.kind === 'read') return `${name} 读取失败：${err}`
  if (problem.backup) return `${name} 解析失败（${err}），原文件已备份为 ${basename(problem.backup)}，本次按默认值继续`
  return `${name} 解析失败（${err}）且备份失败（${String(problem.backupFailed || '')}），本次按默认值继续`
}

function readDepsCfgFile(p) {
  const j = readJsonOrBackup(p, {})
  return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}
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
// 凭证路径（2026-10-30 B 方案）：watch 只认自己这一份。
//   以前这里是「两处写入口谁新用谁」的 mtime 仲裁——跟随同机另一个 B 站工具写下的凭证。
//   用户拍板把这套功能整套拿掉，两个理由：
//     ① 它把一个不属于本插件的本机目录概念写进了公开源码（那个目录只在特定机器上存在，
//        于是相关分支在用户侧是死代码，却把本机信息泄露给了所有读源码的人）；
//     ② 「跟随别人写的凭证」本身就不该是 watch 的职责——读谁的号应该由用户在本插件里扫。
//   现在规则只有一条：$DSH_HOME/bili-watch/credential.json；没有就从 deps/credential.json
//   （更旧的 legacy）迁移一次；都没有就是未登录（匿名请求）。
const { shared: SHARED_CRED, legacy: LEGACY_CRED } = credPaths(DEPS)
// 迁移与校验搬进 lib/cred.mjs（2026-10-31 切片 5）：这里只要「这次该读哪个路径」。
//   面板侧原本就静默（不打印），所以这里对 problem 一律不翻译——凭证状态由 /status 的 credState 解释。
function resolveCredPath() {
  return adoptLegacyCred({ shared: SHARED_CRED, legacy: LEGACY_CRED }).path
}
const LAST_RUN = join(DEPS, 'last-run.json')
// 缓存位置：env BILI_WATCH_CACHE > deps\deps-config.json 的 cache > $DSH_HOME/bili-watch/cache。发布版不含本机路径。
// 自定义目录不可写时不让功能哑掉：回退到默认路径（$DSH_HOME/bili-watch/cache），并把原因挂进 /status.warnings。
// 缓存根标记：CACHE_MARK 已搬到 lib/consts.mjs（2026-10-31 切片 2）——两处同名同值的「身份凭证」只留一份。
// OWN_CACHE_DIRS 已搬到 lib/consts.mjs（2026-10-31 切片 1）——两处同名同值的常量只留一份。
// isOwnedEntry 已搬到 lib/cache-own.mjs（2026-10-31 切片 2），签名变成 isOwnedEntry(root, p)——
//   缓存根由调用方传入（切片 4 把 CACHE 搬进状态模块时，这里只换实参）。
//   #1（2026-10-30 E8）：BV 目录不能只认名字，否则自动清理会把用户的 BV1234567890/ 连文件一起删；
//   现在的判据与 removeOwned 完全同一套（isOwnBvDir），同族说明见 lib/cache-own.mjs 文件头。
// A-3（2026-10-28 阶段A）：清理前确认「没有任何会写盘的子目录在被占用」。
//   实现已搬到 lib/locks.mjs（2026-10-31 切片 2）——面板与 CLI 的判据物理上只留一份。
//   判活 + 判过期两条判据的由来见那边的文件头与 hasAnyLock 注释。
// 2026-10-28 高级设置放开：与 tools/look.mjs 同源，从 readTuning().lockTtlMin 取（默认 30 分钟）
// X-14（2026-10-29）：TTL 还必须覆盖一次最长转写——asrTimeoutSec 上限 60 分钟 > 默认 TTL 30 分钟，
//   转写跑满时锁先被判过期、别的进程抢进来 → 双持。所以取两者的较大值（与 CLI 同一判据）。
//   切片 2 时它没跟着锁判据搬走（它读盘，而 CLI 侧的对应物叫 tuning()，两个名字），于是
//   lib/locks.mjs 只能收一个 ttlMs 参数。切片 3 把算式收到 lib/tuning.mjs 的 lockTtlMsOf：
//   这里只剩「读配置」，两个入口喂给 lockTtlMsOf 的都是 normalizeTuning 的结果，算式不再有第二份。
const lockTtlMs = () => lockTtlMsOf(readTuning())
// pidAlive / readLock / lockExpired / hasAnyLock 已搬到 lib/locks.mjs（2026-10-31 切片 2）。
//   注意签名变了：lockExpired(owner, ttlMs)、hasAnyLock(root, ttlMs)——TTL 由调用方算好传入。
// looksLikeOwnUrlDir 已搬到 lib/keys.mjs（2026-10-31 切片 1）——两处逐字相同的实现只留一份。
// isAdoptableDir 已搬到 lib/locks.mjs（2026-10-31 切片 2）。它守住的那条线没变：
//   能认领的只有三种——不存在（我们会新建）/ 空的 / 已经带我们的标记；
//   有内容又没有标记 = 用户自己的目录（素材库、下载目录），绝不认领，否则 pickCacheDir 这次就把标记写进去，
//   紧接着 removeOwned 看到标记就开始按名字删，守卫等于空转（实测：指向素材库跑 clean 会删掉 4 个用户文件）。
// isOurCacheRoot / isOwnBvDir / removeOwned / dirStat 已搬到 lib/cache-own.mjs（2026-10-31 切片 2）。
//   搬的动机就是「删除面判据只能有一份」：历史上两次删到用户文件（2026-10-29 素材库、
//   2026-10-30 E8 #1 自动清理），根因都是两处判据不同步。三道闸与由来见那边的文件头。
// removeOwned 见上：已搬到 lib/cache-own.mjs（2026-10-31 切片 2）。
// D98（2026-10-29）：推导缓存根拆成两步——resolveCacheDir() 纯算路径（不 mkdir、不写探针），
//   pickCacheDir() 才落盘 + 可写探测。拆开是因为 pickCacheDir 会往根目录写 .write-test-<pid> 探针，
//   建目录、写探针、删探针三件事都会改根目录 mtime；而「只加载模块、还没真读缓存」的那段时间不该有痕迹。
// 2026-10-31 切片 4：这两步、以及 CACHE 这个可变状态本身，全部搬进 lib/cache-path.mjs。
//   本文件只剩三个薄壳：读配置 → 交给 lib → 处理回退文案。为什么状态必须搬走：
//   两个入口原来各有一份 `let CACHE` + 各自的 `CACHE_READY`，判据靠人肉对齐——
//   runsFile 在 index.js 里走 ensureCache()、在 look.mjs 里直接读 CACHE，就是这种分叉的产物。
//   现在读取一律走 lib 的 cacheDir()（未初始化必抛），忘记初始化当场就炸，不会静默写进错的路径。
const cacheWant = () => process.env.BILI_WATCH_CACHE || depsCfg().cache

// 回退告警只报一次：initCachePath 返回的 first 只在「这一次真的初始化了」时为 true，
//   之后都是幂等返回同一个 fallback。/status 每 8 秒轮询，没有 first 判据就会把同一条塞满 warnings。
function ensureCache() {
  const r = initCachePath(cacheWant)
  if (r.fallback && r.first) {
    pushWarn(`缓存目录不可写，已回退到 ${maskAbs(r.dir)}：${maskAbs(r.fallback)}`)
  }
  return r.dir
}

// 追加四（2026-10-29，T35-EXT）：旧缓存提示——只说不做；正文与判据在 lib/cache-path.mjs。
// 严格「只提示」：认领旧目录的开关（--adopt）还没做，所以提示里不提任何当前版本不存在的参数。
// P1-②（2026-10-29 WB 全量审）：/status 是 8 秒轮询，dirStat 会递归 walk 用户目录
//   （实测 2.8 万文件 664 ms 中位、首跑 2 秒），同步 walk 会顶到面板 10 秒超时并卡别的路由。
//   所以这里按 10 分钟节流——配置变了最多晚 10 分钟反映，换掉的是每 8 秒一次的全盘扫描。
//   节流留在本文件而不是 lib：它跟「面板轮询周期」有关，是调用方的性能策略，不是路径语义。
let adoptNoticeCacheAt = 0
let adoptNoticeCacheVal = null
function adoptNoticeThrottled() {
  if (Date.now() - adoptNoticeCacheAt < 10 * 60 * 1000) return adoptNoticeCacheVal
  adoptNoticeCacheAt = Date.now()
  adoptNoticeCacheVal = cacheAdoptNotice(cacheWant())
  return adoptNoticeCacheVal
}

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
  const raw = readJsonOrBackup(UI_CFG, DEFAULT_UI_CFG)
  return { ...DEFAULT_UI_CFG, ...raw }
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
  // issue #7（2026-10-31）实测 Windows：下载约 1.4 GB（cublas 553 MB + cudnn 743 MB + nvrtc 76 MB），
  //   装完 site-packages/nvidia 约 2.0 GB。原来写「约 500 MB」是估的，用户按它算流量会差三倍。
  // issue #5：Linux 那三个 wheel 更大（cublas 817 MB + cudnn 1.2 GB + nvrtc 217 MB，展开约 2.2 GB）。
  cuda: process.platform === 'win32' ? '约 1.4 GB（下载）/ 约 2 GB（装完）' : '约 2.2 GB（pip 三个 wheel，Linux 版更大）',
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
// D98：缓存根是懒初始化的（ensureCache），这里必须现算——顶层常量会把「未初始化时算出的纯路径」固化下来，
//   万一 pickCacheDir 因不可写回退到默认根，日志就会一直写进那个用不上的旧路径。
const runsFile = () => join(ensureCache(), '_logs', 'runs.jsonl')
// 轮转、追加、失败现场三件一起搬进 lib/runs.mjs（2026-10-31 切片 3-C 搬了追加，切片 5 补齐 logRun）。
//   两处原来逐字相同（18 行 × 2）；真正的差异用参数表达：面板侧没有 diag/trackTail（不传 extra），
//   缓存根由本文件的 ensureCache 决定（传 videoDirOf）。
function runLogRecord(args, code, err, ms) {
  const command = String(args?.[0] || '')
  const bv = ['clean', 'login', 'hot'].includes(command) ? '' : String(args?.[1] || '')
  // runsFile 传**惰性函数**而不是字符串：缓存根没初始化时 runsFile() 会抛，
  //   传字符串 = 求值点在调用点（logRun 的 try 之外）→ 异常会冒到 child.on('close') 里。
  //   传函数 = 求值点回到 logRun 内部（try 里）→ 抛了只是日志写不进去，插件继续跑（基线行为）。
  //   2026-10-31 三审（切片 5）抓出并修。
  logRun(runsFile, { command, bv, argv: args || [], code, ms, stderr: err, version: PLUGIN_VERSION }, { videoDirOf: videoDir })
}

// #12（2026-10-30，P1）：外层硬顶原来写死 20 分钟，而面板能调的内层 ASR 超时上限是 60 分钟。
//   用户把 asrTimeoutSec 调到 3600，长视频转写会在第 20 分钟被外层杀掉，报的是「超时」，
//   分不清是哪一层杀的——调大内层等于没调。
//   现在外层 = max(20 分钟, 内层上限 + 3 分钟余量)：保证内层（更具体的判据）先触发、报得出原因。
function outerBudgetMs() {
  try {
    return Math.max(1_200_000, (readTuning().asrTimeoutSec + 180) * 1000)
  } catch {
    return 1_200_000
  }
}
function runLook(args, { timeoutMs = 0, signal = null } = {}) {
  const limitMs = timeoutMs > 0 ? timeoutMs : outerBudgetMs()
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
      // #12：把「哪一层、多少预算」写进错误里。外层预算 = 内层 ASR 超时 + 3 分钟，
      //   所以内层会先触发；真看到这句就说明是外层兜底，不是转写自己超时。
      const mins = Math.round(limitMs / 60000)
      finish({ code: -2, out: getOut().trim(), err: (getErr() + `\n[超时] 整条命令超过 ${mins} 分钟，被插件外层强制结束（不是转写自己报的超时）`).trim() })
    }, limitMs)
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
// pickLoginCookies / fillBuvids 已搬到 lib/cred.mjs（2026-10-31 切片 5）——两个入口逐字相同，
//   只有 fillBuvids 的超时值不同，那属于各侧的节奏（面板侧与 QR_GEN / QR_POLL 对齐 8 秒）。

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
    const jar = await fillBuvids(pickLoginCookies(setCookies), { timeoutMs: 8000, ua: UA, spi: SPI })
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
    // W-28（2026-10-28 阶段B-③）：与 tools/look.mjs 的 loadCred 四字段判据对齐。
    //   阶段 A 的 A-4 只修了 CLI 侧，面板这半边一直是「文件存在 + 30 天年龄」就算 ok——
    //   残缺凭证（缺 sessdata/bili_jct/buvid3/buvid4）照样报 ok，面板依赖清单打 ✓，
    //   而实际所有请求都在匿名态：用户以为登录了，拿到的却是匿名结果，且看不出哪里不对。
    const missing = missingCredFields(j)
    if (missing.length) return { exists: true, state: 'incomplete', missing, updatedAt: t, ageDays }
    return { exists: true, state: ageDays > 30 ? 'expired' : 'ok', updatedAt: t, ageDays }
  } catch {
    return { exists: true, state: 'unknown', updatedAt: null, ageDays: null }
  }
}

// dirStat 已搬到 lib/cache-own.mjs（2026-10-31 切片 2）——面板「当前占用」与 clean「已清理 X MB」
//   必须同一口径（跳过标记与 _logs、一律 lstat），两处各写一份就是口径对不上的老病根。

// #11（2026-10-30，P1）：/status 是 8 秒一轮，同一路由里 autoCleanCache() 早就按 10 分钟节流了，
//   但 cache 那块占用每次都重新 dirStat(CACHE) 全盘递归 walk（3 万文件实测中位 219 ms，
//   首跑更慢）。面板一开着就是「每 8 秒白扫一遍」。
//   现在 30 秒节流；清理/清除之后调 invalidateCacheStat() 立刻失效，面板看到的是清完的真实值。
const CACHE_STAT_TTL_MS = 30 * 1000
let cacheStatAt = 0
let cacheStatVal = null
function cacheStat() {
  if (cacheStatVal && Date.now() - cacheStatAt < CACHE_STAT_TTL_MS) return cacheStatVal
  cacheStatVal = dirStat(cacheDir())
  cacheStatAt = Date.now()
  return cacheStatVal
}
function invalidateCacheStat() {
  cacheStatVal = null
  cacheStatAt = 0
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
        if (isOwnedEntry(dir, p)) walk(p)
      } else {
        if (!isOwnedEntry(dir, p)) continue
        try {
          // E6-07（2026-10-30，P1）：lstat 不是 stat。rmSync 删符号链接只删链接本身，
          //   按 stat 取的是目标大小——「按总量清理」会拿一个虚高的体积去凑阈值，
          //   实际删掉几百字节却以为腾出了几 MB。与 dirStat 同口径。
          const st = lstatSync(p)
          out.push({ path: p, size: st.size, mtime: st.mtimeMs })
        } catch {}
      }
    }
  }
  walk(dir)
  return out
}

function cacheCfg() {
  const j = readJsonOrBackup(CACHE_CFG, {})
  return {
    days: Number.isFinite(j?.days) ? Math.max(1, j.days) : DEFAULT_CACHE_DAYS,
    maxMb: Number.isFinite(j?.maxMb) ? Math.max(100, j.maxMb) : DEFAULT_CACHE_MAX_MB,
  }
}

// N13（2026-10-28）：原来吞异常、无返回值，三处调用都不看结果——「保存规则」写盘失败仍回
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
  if (!existsSync(cacheDir())) return { removed: 0, bytes: 0, failed: [] }
  // 追加一（2026-10-29，P0）：没有根标记就不是我们建过的缓存根，一律不清（CACHE 可以被指到任何目录）
  if (!isOurCacheRoot(cacheDir())) return { removed: 0, bytes: 0, skipped: true, noMark: true, failed: [] }
  // W-04（2026-10-28 阶段B-①）：有正在跑的转写/抽帧（任何子目录有 .lock）就不自动清，
  //   否则会删掉正在写的 asr/sheet 产物（转写白跑且无提示）。与 /cache/clear 同判据。
  // 切片 2：TTL 由这里算好传进去（lib 里的判据不读配置）
  if (hasAnyLock(cacheDir(), lockTtlMs())) return { removed: 0, bytes: 0, skipped: true, locked: true, failed: [] }
  const { days, maxMb } = cacheCfg()
  const cutoff = Date.now() - days * 86400000
  const limit = maxMb * 1024 * 1024
  const entries = walkEntries(cacheDir())
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
        failed.push({ name: relative(cacheDir(), e.path), why: String(err?.message || err) })
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
        failed.push({ name: relative(cacheDir(), e.path), why: String(err?.message || err) })
      }
      if (total <= limit) break
    }
  }
  // 清单 1-7：只删文件会留一堆空目录（跑 100 个视频留 100 个空目录）；删完后自底向上清白名单内空目录
  pruneEmptyDirs(cacheDir())
  lastCleanAt = Date.now()
  // #11：清了东西就让占用缓存失效，否则面板最多 30 秒还在显示清理前的体积
  if (removed) invalidateCacheStat()
  return { removed, bytes, failed }
}

/** 清理后把插件自己名下（白名单 / BV_*）的空目录也删掉，根目录本身与别人的目录不动。 */
function pruneEmptyDirs(root) {
  // 追加一：不是我们的根，连空目录也别清（clean 会在任何目录里找 frames/asr）
  if (!isOurCacheRoot(root)) return
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
      if (isOwnedEntry(root, p)) {
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
 * 10-28 派单（20261028-1015-DB）：取消绝对路径遮罩，面板显示完整路径。
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
//   dllReady——cuBLAS 运行库能不能真加载（派单要求：不看 pip 包名，真跑一次加载）。
//     Windows 是 ctypes.WinDLL("cublas64_12.dll")，Linux 是先 RTLD_GLOBAL 预载
//     nvidia/*/lib 再 CDLL("libcublas.so.12") —— 两边都下沉到 _bili-asr.py --probe-gpu，
//     这里只读退出码，不分平台写第二份判据（issue #5）。
//   cudaLibs——venv 里有没有 nvidia 包（只作说明，不作 ok 判据）
// 探测要跑两个子进程，/status 每 8 秒轮询一次，所以缓存 5 分钟；删完 GPU 运行库后 resetGpuCache() 立刻作废。
// GPU 第二轮（2026-10-29）：原来 probeGpu 是同步 execFileSync，缓存失效那一次会堵住事件循环，
//   而面板 8 秒轮询 + 用户手点刷新很容易同时来两个 /status。改成异步 + 模块级 in-flight Promise：
//   在飞期间所有调用复用同一个 Promise，探测完清空，缓存照旧 5 分钟。
// GPU 第三轮（2026-10-30，老大报「面板说运行库未装、手动跑同一个探测却 rc=0」）：
//   ① 3 秒超时 → 10 秒。探测有 5 分钟缓存，单次慢点没代价；机器忙时 3 秒偏紧，一超时就被当成「没装」。
//   ② 原来 stdio:'ignore' 把子进程输出全丢了，失败时只剩一句笼统的「加载失败」——真因（超时被 kill /
//      退出码 / stderr）看不到。现在统一 encoding:'utf8' 收输出，失败时把真因拼进 note。
//   ③ 只有「结论确定」才写缓存：一次抖动现在会锁死 5 分钟假状态，改成异常/超时只本次返回、下次重探。
const GPU_PROBE_TIMEOUT_MS = 10000
const GPU_CACHE_MS = 5 * 60 * 1000
let _gpuCache = { at: 0, val: null }
let _probePromise = null
// ④（2026-10-30，按 lifecycle 复核补的）：reset 之后，在飞那次探测的结果必须作废。
//   原来 resetGpuCache() 只把 _probePromise 置 null，旧 Promise 完成时照样 .then 写 _gpuCache——
//   用户在面板点了「重置」（比如刚装完 GPU 运行库），旧探测（基于旧环境）落地会把新结论盖掉，
//   而且盖完又有 5 分钟缓存。序号就是「这次结果还算不算数」的凭据。
let _gpuSeq = 0
function resetGpuCache() {
  _gpuCache = { at: 0, val: null }
  _probePromise = null
  _gpuSeq++
}
/**
 * ③ 只有「结论确定」才进缓存：一次抖动/超时就把假状态锁死 5 分钟，用户会盯着面板上的错结论。
 *   抽成纯函数是为了能被 verify.mjs 真跑（喂「确定 / 不确定 / 异常」三种结果，看缓存到底变不变）。
 *   res 形状：{ val, confident }；confident!==true 或异常(null) → 原样返回旧缓存，本次结论只用不记。
 */
function nextGpuCache(cache, res, now = Date.now()) {
  if (!res || res.confident !== true || !res.val) return cache
  return { at: now, val: res.val }
}
function gpuStatus() {
  // 没有 force 形参：强刷统一走 resetGpuCache()。留一个没人传的 force 会让下一个人
  //   以为「传 true 能强刷」，而实际刷新路径已经改成 resetGpuCache()，两套机制并存会分叉。
  if (_gpuCache.val && Date.now() - _gpuCache.at < GPU_CACHE_MS) return Promise.resolve(_gpuCache.val)
  if (_probePromise) return _probePromise // 在飞就复用，并发 5 次也只起一套 nvidia-smi
  const mySeq = ++_gpuSeq
  _probePromise = probeGpu()
    // ③ 只有「结论确定」才进缓存；不确定（超时/异常）只本次返回，下次重探
    // ④ 期间被 resetGpuCache() 作废过（序号变了）→ 这是过期观察，不写缓存
    .then((res) => { if (mySeq === _gpuSeq) _gpuCache = nextGpuCache(_gpuCache, res); return res.val })
    .catch((e) => {
      // 探测本身抛异常 → 同样不写缓存（否则一次崩溃锁死 5 分钟假状态）
      return { deviceCount: 0, dllReady: false, cudaLibs: false, note: `GPU 探测异常，按无卡处理（${String(e?.message ?? e).slice(0, 120)}）` }
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
/** ② 把子进程失败的真因说清楚：超时被 kill / 退出码 / stderr 末段。别只剩一句「加载失败」。 */
function probeWhy(r) {
  const e = r?.err
  if (!e) return '没有返回'
  if (e.killed) return `超时 ${GPU_PROBE_TIMEOUT_MS}ms 被中止（killed=true）`
  const out = []
  if (e.code != null) out.push(`code=${e.code}`)
  if (e.signal) out.push(`signal=${e.signal}`)
  const se = String(e.stderr ?? '').replace(/\s+/g, ' ').trim()
  const so = String(r.stdout ?? '').replace(/\s+/g, ' ').trim()
  const tail = (se || so).slice(-120)
  if (tail) out.push(tail)
  return out.length ? out.join(' ') : String(e.message ?? e).slice(0, 120)
}
async function probeGpu() {
  const notes = []
  let confident = true // 探测过程没被超时/异常打断，结论可信 → 才允许写缓存
  let deviceCount = 0
  // 「确定没有卡」单独记一个布尔：面板据此决定给不给「一键下载 GPU 运行库」的按钮。
  //   不能用 deviceCount === 0 代替 —— nvidia-smi 超时/异常时也是 0，那时我们并不知道有没有卡，
  //   把按钮藏起来会让有卡的人无从下手。只有 ENOENT（确实没这个命令）才算确定没卡。
  let noCard = false
  const smi = await execFileP('nvidia-smi', ['-L'], { timeout: GPU_PROBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true })
  if (smi.ok) {
    deviceCount = smi.stdout.split('\n').filter((l) => /^\s*GPU\s+\d+:/.test(l)).length
  } else if (smi.err?.code === 'ENOENT') {
    noCard = true
    notes.push('没有 nvidia-smi（未装 NVIDIA 驱动，或不是 NVIDIA 卡）')
  } else {
    confident = false
    notes.push(`nvidia-smi 探测失败：${probeWhy(smi)}`)
  }
  const py = venvAsr().find((p) => existsSync(p)) || ''
  let dllReady = false
  let cudaLibs = false
  if (py) {
    const spec = await execFileP(py, ['-c', 'import importlib.util as u, sys; sys.exit(0 if u.find_spec("nvidia") else 1)'], { timeout: GPU_PROBE_TIMEOUT_MS, encoding: 'utf8' })
    cudaLibs = spec.ok
    if (!spec.ok && spec.err?.killed) {
      confident = false
      notes.push(`venv 里查 nvidia 包超时：${probeWhy(spec)}`)
    }
    // 2026-10-29 修：原来在这里直接 `ctypes.WinDLL("cublas64_12.dll")`，但 pip 装的
    //   cublas 在 site-packages/nvidia/*/bin 里、不在默认 DLL 搜索路径 —— 结果是
    //   「_bili-asr.py 能跑 GPU，面板却说运行库没装」。判据现在改由 ASR 脚本自己答
    //   （它本来就先跑 _add_nvidia_dll_dirs()），一个实现，两处不会分叉。
    //
    // 2026-10-31（issue #5）：原来只有 win32 分支走这条路，非 win32 只 push 一句提示、
    //   dllReady 保持 false —— Linux 上有卡、运行库也装好了，这一行仍然恒红（面板唯一的
    //   GPU 状态出口）。现在两个平台统一走 `--probe-gpu`，平台差异全在脚本里：
    //   win32 用 WinDLL，Linux 先按 RTLD_GLOBAL 预载 nvidia/*/lib 再 CDLL("libcublas.so.12")。
    const asrPy = join(DEPS, '_bili-asr.py')
    if (!existsSync(asrPy)) {
      // 脚本确实不在 = 确定的结论（明确没环境），照常可缓存；不确定的只有「超时/异常」
      notes.push(`ASR 脚本不存在（${asrPy}），无法探测运行库`)
    } else {
      const dll = await execFileP(py, [asrPy, '--probe-gpu'], { timeout: GPU_PROBE_TIMEOUT_MS, encoding: 'utf8' })
      dllReady = dll.ok
      if (!dllReady) {
        // 超时 = 不知道结果（不确定，不写缓存）；正常非 0 退出 = 确定没装/不在搜索路径
        if (dll.err?.killed) confident = false
        notes.push(`${process.platform === 'win32' ? 'cublas64_12.dll' : 'libcublas.so.12'} 加载失败：${probeWhy(dll)}`)
      }
    }
  } else {
    // venv 确实不存在 = 确定的「明确没环境」，可缓存（不必每 8 秒重探）
    notes.push('ASR 环境还没装，装完才能判断 GPU 运行库')
  }
  return { val: { deviceCount, dllReady, cudaLibs, noCard, note: notes.join('；') }, confident }
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
      if (!py) return 0
      const venvRoot = dirname(dirname(py))
      // 2026-10-31（issue #5 同族）：原来只认 Windows 布局 <venv>\Lib\site-packages，
      //   Linux 的 site-packages 在 <venv>/lib/pythonX.Y/site-packages，这里原来恒 0。
      if (process.platform === 'win32') return dirStat(join(venvRoot, 'Lib', 'site-packages', 'nvidia')).bytes
      const libDir = join(venvRoot, 'lib')
      if (!existsSync(libDir)) return 0
      let total = 0
      for (const e of readdirSync(libDir)) {
        if (!e.startsWith('python')) continue
        total += dirStat(join(libDir, e, 'site-packages', 'nvidia')).bytes
      }
      return total
    } catch { return 0 }
  })()
  rows.push({
    id: 'cuda',
    name: 'GPU 运行库（cuBLAS + cuDNN）',
    ok: gpu.dllReady,
    // 2026-10-31（issue #5）：文案按平台分开 —— Linux 上照 Windows 说「装上快 2-8 倍」
    //   等于给了个不存在的手工路径（README 那段只写 PowerShell 脚本）。
    //   「2-8 倍」也改成「约 2 倍」：issue 作者同机多次实测 1.96–2.24×，
    //   量级差一档会让复测的人直接怀疑数据。
    detail: gpu.dllReady
      ? `已就绪${gpu.deviceCount ? `（${gpu.deviceCount} 块 NVIDIA 卡）` : ''}，转写走 GPU`
      : (gpu.deviceCount
        ? (process.platform === 'win32'
          ? `检测到 ${gpu.deviceCount} 块 NVIDIA 卡，但运行库没装好——装上转写约快 2 倍`
          : `检测到 ${gpu.deviceCount} 块 NVIDIA 卡，但运行库没装好——在 ASR 环境里装 nvidia-cublas-cu12 / nvidia-cudnn-cu12（见 README 的 Linux 装法）`)
        : (gpu.note || '没有 NVIDIA 卡，转写走 CPU')),
    path: gpu.dllReady ? (process.platform === 'win32' ? 'cublas64_12.dll' : 'libcublas.so.12') : '',
    // 确定没有 NVIDIA 卡时不给「一键下载」按钮：装了也用不上，Linux 上那是 2.2 GB。
    //   判据用 noCard（只有 nvidia-smi 是 ENOENT 才为真），不是 deviceCount === 0 ——
    //   探测超时/异常时 deviceCount 也是 0，那时藏按钮会让有卡的人无从下手。
    //   client.js 的 canDownloadRow 认这个字段（缺省 = 可下载，向后兼容）。
    installable: !gpu.noCard,
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

// E1-01（2026-10-30，P0）：「成功」不能由退出码推导，只能由产物推导。
//   现象：日志写「结束，退出码 0（成功）」，而实际什么都没装。
//   根因：Windows 上 DSH 跑在带 KILL_ON_JOB_CLOSE 的 Job Object 里（_dsh-supervise.ps1 的
//   LimitFlags=0x2800），宿主一停，内核回收整棵树；Node 的 spawn 不论 detached 真假都不请求
//   CREATE_BREAKAWAY_FROM_JOB，所以「关掉宿主继续下」在 win32 上从来就没成立过。
//   PR#4 修的是同一个功能的另一面（detached:true 让脚本一行都不执行），两个方向都没对——
//   因为真正的错在于「用退出码当成功判据」，而不是 detached 该怎么设。
//   现在：退出码 0 之后回查 depRows()（真跑 resolveFfmpeg、venv 里真 import），那一行 ok 才算成功。
const DOWNLOAD_TARGET_DEPS = {
  ytdlp: ['ytdlp'],
  ffmpeg: ['ffmpeg'],
  asr: ['asr'],
  ocr: ['ocr'],
  model: ['model'],
  cuda: ['cuda'],
  // all 不含 cuda（C20 的约定），装的是这五项
  all: ['ytdlp', 'ffmpeg', 'asr', 'ocr', 'model'],
}

/**
 * 判断一次下载的最终结论。纯函数，便于真跑断言（C32）。
 * @param {string} target 下载目标
 * @param {number|null} code 退出码
 * @param {string|null} signal 终止信号
 * @param {Array<{id:string, ok:boolean}>} rows depRows() 的结果；没查成就传 null
 * @returns {{ok:boolean, note:string}}
 */
function downloadVerdict(target, code, signal, rows) {
  if (signal) return { ok: false, note: `信号 ${signal}` }
  if ((code ?? 0) !== 0) return { ok: false, note: `退出码 ${code ?? 'null'}` }
  const ids = DOWNLOAD_TARGET_DEPS[target] || []
  // 查不到就退一步说「退出码 0」，不谎称成功也不谎称失败——但要把原因写清楚
  if (!Array.isArray(rows)) return { ok: false, note: `退出码 0，但没能复查产物（depRows 失败）` }
  const miss = ids.filter((id) => !((rows.find((r) => r && r.id === id) || {}).ok))
  if (miss.length) {
    return { ok: false, note: `退出码 0，但 ${miss.join('、')} 仍不可用（宿主被关掉时下载进程会被连带杀掉）` }
  }
  return { ok: true, note: `退出码 0，产物已复查` }
}

/** 一键下载：异步拉起插件自带的 fetch-deps 脚本，立刻返回日志路径（不等下载结束）。 */
function runDownload(target) {
  const script = join(SCRIPTS, 'fetch-deps.ps1')
  if (!existsSync(script)) return { started: false, why: '插件目录里没有 scripts/fetch-deps.ps1' }
  // issue #5（2026-10-31）：原来这张表没有 cuda，而面板的「GPU 运行库」行在没装时
  //   会渲染「一键下载」按钮（client.js 的 canDownload = !d.ok），点下去后端直接回
  //   「不支持的依赖：cuda」—— 两个平台都是死按钮，README 却写着「点那一行的下载」。
  //   现在两个脚本都有 cuda 分支（ps1 -Target cuda / sh 的 cuda），这里放行。
  const allowed = ['ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'cuda', 'all']
  if (!allowed.includes(target)) return { started: false, why: `不支持的依赖：${target}` }
  try {
    appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] 开始下载 ${target}\n`, 'utf8')
  } catch {}
  const win = process.platform === 'win32'
  // G-04（2026-10-29）：powershell 用绝对路径。以前是裸名 'powershell.exe' 交给 PATH 解析，
  //   宿主被以受限 PATH 拉起时可能解析不到；用绝对路径后日志里也能直接看出到底调了哪个 exe。
  const cmd = win
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'bash'
  const args = win
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target]
    : [script.replace(/\.ps1$/i, '.sh'), target]
  // G-04（2026-10-29，致命根因）：Windows 上 detached:true 会被 libuv 映射成 DETACHED_PROCESS，
  //   powershell.exe 启动后约 0.5 秒内以 exit code 0 退出，但 -File 脚本一行都不执行——
  //   stdout/stderr 全空，连脚本第一行该写的落盘标记都不出现。本机控制变量实测：同样的参数、
  //   stdio（ignore/inherit/pipe）与是否绝对路径都不影响结论，只把 detached 切成 false 就正常执行。
  //   注意：win32 用 detached:false 只是为了让它真的执行，**不是**为了「关掉宿主继续下」——
  //   宿主在带 KILL_ON_JOB_CLOSE 的 Job Object 里（见上方 downloadVerdict 那段），宿主一退出，
  //   内核会把下载进程一起回收。所以面板文案只说「已开始」，不许承诺能跨宿主存活。
  const detached = process.platform !== 'win32'
  // A-下载黑洞（2026-10-29 二次修正）：子进程输出不再 stdio:'ignore'，也不再和宿主事件挤同一个文件——
  //   脚本自己的逐行输出写 deps\download.out.log；deps\download.log 只留宿主侧结构化事件
  //   （开始 / pid / detached / 退出码）。fetch-deps.ps1 自己也会往 download.log 写关键节点和失败原因，
  //   两个文件合起来看：宿主确实拉起了进程 + 脚本到底跑到哪一步。
  const outLog = join(DEPS, 'download.out.log')
  let outFd = null
  try { outFd = openSync(outLog, 'a') } catch {}
  let child = null
  try {
    child = spawn(cmd, args, {
      windowsHide: true,
      stdio: outFd === null ? 'ignore' : ['ignore', outFd, outFd],
      detached,
      // G-04：显式透传环境变量——DSH 的 .env 代理机制（HTTP_PROXY/HTTPS_PROXY）靠子进程继承，
      //   不能指望 spawn 默认行为在以后被改掉。
      env: { ...process.env },
    })
  } catch (e) {
    if (outFd !== null) try { closeSync(outFd) } catch {}
    return { started: false, why: String(e?.message ?? e) }
  }
  try {
    appendFileSync(
      DOWNLOAD_LOG,
      `[${new Date().toISOString()}] ${target} 进程已拉起：pid=${child.pid ?? '?'} detached=${detached} shell=${cmd}\n`,
      'utf8',
    )
  } catch {}
  // 子进程拿的是自己那份句柄（Windows 继承 / POSIX fork），父进程这份等它退出/报错后再关
  let outClosed = false
  const closeOut = () => {
    if (outClosed) return
    outClosed = true
    if (outFd !== null) { try { closeSync(outFd) } catch {} outFd = null }
  }
  // 非 detached 的子进程同样会异步报 spawn 失败（ENOENT/EACCES），必须接 error，否则带崩宿主
  child.on('error', (e) => {
    try {
      appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] 启动失败 ${target}：${e?.message ?? e}\n`, 'utf8')
    } catch {}
    closeOut()
  })
  // A-下载黑洞（后半）：记退出码。以前脚本崩在 pip install / 模型下载中途，
  //   日志里既没有 stdout 也没有退出码，排障无路。
  // E1-01（2026-10-30，P0）：退出码 0 不再直接写「成功」——先回查产物（depRows 会真跑
  //   resolveFfmpeg、在 venv 里真 import 一次）。异步，所以写完日志再 closeOut。
  //   失败路径不复查（省几秒），只有退出码 0 才值得问一句「东西真装上了吗」。
  child.on('exit', (code, signal) => {
    const finish = (rows) => {
      try {
        const v = downloadVerdict(target, code, signal, rows)
        appendFileSync(
          DOWNLOAD_LOG,
          `[${new Date().toISOString()}] ${target} 结束，${v.note}${v.ok ? '（成功）' : '（失败）'}（详细输出见 deps\\download.out.log）\n`,
          'utf8',
        )
      } catch {}
      closeOut()
    }
    if ((code ?? 0) !== 0 || signal) { finish(null); return }
    depRows().then(finish).catch(() => finish(null))
  })
  child.unref()
  return { started: true, log: DOWNLOAD_LOG, outLog }
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
    } else if (t === '--at' && tokens.length) {
      // 2026-10-31 P1：这张 if-else 链才是「收不收」的唯一判据（KNOWN_FLAGS 只喂提示）。
      //   --at 是 0.3.9 新增（frames 精确定点），漏在这儿 → /bili frames --at 750 直接被拒执行。
      extra.push('--at', tokens.shift())
    } else if (t === '--asr-max' && tokens.length) {
      // 老洞：10-28 补进了 KNOWN_FLAGS，提示不报了，但这里仍然拒执行（当时注释写反了）
      extra.push('--asr-max', tokens.shift())
    } else if (t === '--key' && tokens.length) {
      // login --poll --key <code> 扫码轮询要用；表里有、这里没有 → 扫码登录在斜杠层走不通
      extra.push('--key', tokens.shift())
    } else if (t === '--no-time') {
      extra.push(t)
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

// ── apply() 的五个子系统（2026-10-31 切片 6）─────────────────────────────
// 原来是一个 425 行的函数：启动动作、斜杠命令、单链提示、工具注册、设置页端点全在里面。
// 拆的时候只搬不改——块内每一行都是原样搬过来的（缩进都没动）。
//   depsCfg() / readTuning() / readDepsCfg() 这些调用仍然在原来那一层，没顺手改成注入参数：
//   注入是行为改动，混在搬运里红了就分不清是谁弄坏的。

/** ① 进程级启动动作：缓存根初始化、按天数/总量清一次、deps 搬家排后台。 */
function bootCache(ctx) {
  // D98（2026-10-29）：缓存根与旧目录迁移在这里做（一个进程一次），不在模块加载期做——
  //   加载 ≠ 使用：宿主 dump 配置、跑 dsh 子命令时也会 import 这个模块，那些场景不该搬用户的目录。
  try {
    ensureCache()
  } catch (e) {
    // 切片 4：这里**不能**调 cacheDir()——正因为初始化失败才走到这条分支，它一定会抛。
    //   用 previewCacheDir 打「本来打算用的路径」，与原来「保留 CACHE 的纯路径」同一个意思。
    ctx.logger?.warn?.(`[dsh-bili-watch] 缓存目录初始化失败，继续用 ${previewCacheDir(cacheWant())}：${String(e?.message || e)}`)
  }
  // 启动时按「天数 + 总量阈值」清一次缓存，不点按钮也不会无限涨
  try {
    const r = autoCleanCache({ force: true })
    if (r.removed) ctx.logger?.info?.(`[dsh-bili-watch] 自动清理缓存 ${r.removed} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB`)
    // M-05：删不掉的文件别再静默跳过，至少留一行可查的日志（被 ffmpeg/python 占用、只读、超长路径）
    if (r.failed?.length) ctx.logger?.warn?.(`[dsh-bili-watch] 自动清理缓存有 ${r.failed.length} 个文件没删掉：${r.failed.slice(0, 3).map((f) => f.name).join('、')}${r.failed.length > 3 ? ' 等' : ''}`)
  } catch {}

  // X-30 第二轮：deps 搬家排后台（3 秒后，那时插件已注册完）。本次启动仍用包内那份。
  scheduleDepsMigration()
}

/** ② 斜杠命令：人敲，确定性执行，不花推理 token。 */
function registerSlashCommand(ctx) {
  // ① 斜杠命令：人敲，确定性执行，不花推理 token
  ctx.commands.register({
    definitionId: 'dsh-bili-watch',
    name: 'bili',
    description: '看 B 站视频内容：字幕 → 本地转写 → 抽帧 OCR，输出最可信的一份文本',
    input: {
      hint: '<search 关键词|hot|peek|view|sub|comments|danmaku|asr|frames|sheet|substrip|ocr|text|login|clean> [BV] [--p N] [--step 2] [--days 3] [--order pubdate|click] [--cred 凭证路径] [--fast] [--scene] [--grid 3x3] [--at 12:30] [--format srt|json|md|txt] [--out 文件（需配合 --format）] [--limit N] [--head N] [--full] [--verify] [--ffmpeg 路径] [--fresh] [--ocr] [--poll] [--check] [--mark-seen] [--no-time] [--asr-max 60000] [--key 轮询码]',
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
}

/** ③ 单条链接软提示：只往消息流里加一条旁白，绝不替用户调用工具。 */
function registerAutoHint(ctx) {
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
}

/** ④ 同名工具 bili_watch：模型可调，需要看视频时自己来。 */
function registerTool(ctx) {
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
}

/** ⑤ 设置页端点 /api/bili-watch：读盘状态 + 清缓存（唯一写操作是删本机缓存）。返回 dispose。 */
function registerPanelRoute(ctx) {
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
                    cache: { ...cacheStat(), ...cacheCfg(), dir: maskAbs(cacheDir()), lastAutoClean: cleaned },
                    tuning: readTuning(),
                    tuningDefaults: tuningDefaults(),
                    tuningRanges: tuningRanges(),
                    lastRun: readLastRun(),
                    ui: uiCfg(),
                    // 追加四（2026-10-29）：旧缓存提示走 warnings，与 CLI clean 的那行同源。
                    // 切片 3-B：配置告警改成数组（坏文件 / 缓存回退各一条，不再互相覆盖）。
                    warnings: [...cfgWarnings, toolsWarning, depsWarning,
                      ...(() => {
                        // 切片 4：走节流壳（lib 里那份是纯函数，每 8 秒轮询都全盘 walk 会顶穿面板超时）
                        const a = adoptNoticeThrottled()
                        if (!a) return []
                        return [`发现旧缓存 ${maskAbs(a.old)}（${a.files} 项，${a.mb} MB），已改用 ${maskAbs(a.next)}；它没有 bili-watch 的标记，本版不动它（要清理请手动删）。`]
                      })(),
                    ].filter(Boolean),
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
                const locked = hasAnyLock(cacheDir(), lockTtlMs())
                if (locked) {
                  return sendJson(res, 200, {
                    ok: false,
                    why: '正在被占用：检测到正在运行的抽帧任务，已取消清理。等抽帧跑完再清。',
                    data: { removed: 0, bytes: 0, skipped: [], failed: [], locked: true },
                  })
                }
                // T35/T40-A1：只清插件自己的数据（BV_*、_logs、frames 等白名单），共享目录里别人的文件不碰
                const cleared = removeOwned(cacheDir())
                // #11：清完立刻让占用缓存失效——面板紧接着那次 /status 要看到清完的真实体积
                invalidateCacheStat()
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
                // E4-03（2026-10-30，P1）：轮询里 fetch 抛错（断网 / 8 秒超时）原来直接冒到最外层 catch，
                //   回 { ok:false, why }——没有 state。前端拿 state 分分支，认不出就按「等待中」无限重试。
                //   轮询接口的返回形状必须永远带 state，异常也在这里就地收口。
                let r
                try {
                  r = await loginPollOnce(String(body?.key ?? ''))
                } catch (e) {
                  r = { ok: false, state: 'error', why: `轮询失败：${String(e?.message || e)}` }
                }
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

function apply(ctx) {
  bootCache(ctx)
  registerSlashCommand(ctx)
  registerAutoHint(ctx)
  registerTool(ctx)
  return registerPanelRoute(ctx)
}

export { apply, inject, name }
