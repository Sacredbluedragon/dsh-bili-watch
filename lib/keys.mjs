/**
 * lib/keys.mjs —— 「一个用户输入怎么变成安全的文件名 / 目录名」
 *
 * 为什么单独一个模块（2026-10-31）：
 *   这四个函数在 index.js（DSH 进程内）与 tools/look.mjs（CLI 子进程）里各有一份
 *   逐字相同的实现。两份的成本不是「多 40 行」，而是「改一处要记得改两处」——
 *   漏了就会出现「面板建的目录名和 CLI 算出来的不一样」，同一个视频在缓存里落两个目录，
 *   用户看到的是「清理不干净」。搬到这里之后两个进程各 import 一份，物理上不可能分叉。
 *
 * 依赖：OWN_CACHE_DIRS 与 PROVEN_TOOL_TXT_RE 两个只读常量（+ node:fs 的 readdirSync）。
 *   不读任何可变状态，所以两个进程各加载一份也不会算出不同结果。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_MARK, OWN_CACHE_DIRS, PROVEN_TOOL_TXT_RE } from './consts.mjs'

/**
 * 只留字母数字与 `_ . -`；挡掉 `..` / `.` / Windows 保留设备名，避免用户输入直接决定磁盘路径。
 *
 * P2-5（2026-10-28 全量检查）：面板与 CLI 不许各算一个目录名——
 *   ① 尾部点号/空格在 Windows 上会被系统吃掉，「建出来的目录名」与「下次拼出来的目录名」不一致；
 *   ② 保留名要连后缀一起挡（con.txt / NUL.ini 在 Windows 上照样是设备名），按去扩展名后的基名判。
 */
export function cleanKey(s) {
  const k = String(s || '').replace(/[^\w.-]/g, '').slice(0, 40).replace(/[\s.]+$/, '')
  const base = k.split('.')[0]
  if (!k || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(base)) return '_misc'
  return k
}

/**
 * 从任意输入里取 BV 号；取不到就原样返回。
 *
 * T34-P0-1 / E6-02（2026-10-30）：模型可能把整条链接当 key 传进来，先取 BV 再建目录。
 *   CLI 的 positional 是原样接的，比插件侧更容易收到整条链接，漏了这一侧会造出 http 开头的目录名。
 */
export function bvOf(s) {
  const m = /(BV[0-9A-Za-z]{10})/.exec(String(s || ''))
  return m ? m[1] : s
}

/**
 * 按码点截断。
 *
 * N05-B4（2026-10-27 加）：emoji 是代理对，`slice(0, n)` 会从中间切开，回显末位变成 U+FFFD（`�`）；
 *   落盘文件是完整的，只有给模型/回显的这段被切坏。与 slugTitle 同口径。
 */
export function cutCp(s, n) {
  const str = String(s ?? '')
  if (str.length <= n) return str
  const a = Array.from(str)
  return a.length <= n ? str : a.slice(0, n).join('')
}

// ── 0.4.17（1913）从 cache-own.mjs 上移：归属凭证常量 + isProvenDotName ──
// 归属判断属于判断层（keys），不属于常量层（consts）；上移后 keys→consts、
// cache-own→keys+consts，无循环依赖。cache-own.mjs 改为从此处 import。
export const PROVEN_FIXED_NAMES = new Set([
  'manifest.json',         // lib/frames.mjs:92 writeManifest
  'meta.json',             // tools/look.mjs:2292 writeMeta
  'runs.jsonl',            // index.js:515 / tools/look.mjs:883 runsFile()
  'runs.jsonl.1',          // lib/runs.mjs:18 appendJsonLine 轮转
  'last-error.json',       // tools/look.mjs:3530 / lib/runs.mjs:89
  'injection-warned.json', // tools/look.mjs:2427 WARN_STATE()
  // 登录二维码写在缓存根，removeOwned 早就单列分支认它是自己的产物（见本文件下方）。
  //   两值归属后 --all 走 classifyLoose，没有这张凭证就会被判 foreign 默认保留，
  //   于是同一张图「立即清理删得掉、彻底清空删不掉」。补进固定产物名单让两条路径同源。
  'login-qr.png',          // tools/look.mjs 登录二维码落盘点
])

/**
 * 我们把控的生成规则 —— 逐处 grep 生产落盘点得来，不凭记忆（见《逐目录凭证表》）。
 *   ・`<BV>-NN.jpg`                       look.mjs:838 / frameFilesToKeep(frames.mjs:70)
 *   ・`f_<m>m<ss>s.jpg`                   look.mjs:831 / frames.mjs:71
 *   ・`peek-NN.jpg`                       look.mjs:574 / :646
 *   ・`sheets/<BV>-pN-*.jpg`              look.mjs:2013 / :2084
 *   ・`sheets/<BV>-pN-*.manifest.json`    look.mjs:2022
 *   ・`asr/<BV>-pN-*.txt|wav|tmp`         look.mjs:1059-1060
 *   ・`asr/<BV>-pN-*.cues.json`           look.mjs:1153
 *   ・`*.tool.txt`（精确产物形态）        lib/consts.mjs PROVEN_TOOL_TXT_RE / index.js trimForModel
 * **没有「补零帧序号」**：`0001.jpg` 不是任何真实产物。
 *   留下它会让用户放一张 `01.jpg` 就被认成我们的 —— 那是真实的数据丢失口子。
 */
// 0.4.11 / issue #15 根因 1：`<kind>` 全集的唯一事实源。
//   `.txt` / `.wrapped.txt` / `.json` 三条共用这一份，不许各写一份清单。
//   这份常量由判据侧守住同源：C162 / C348 从 tools/look.mjs 的 printText( 调用点
//   现抽全集后真跑 provableNamesIn() 双向回验，漏一个 kind 或漏一种后缀判据就红。
//   不在运行时去解析 tools/look.mjs 源码 —— 那会让归属判定依赖发布包里的源码文本。
const PRINT_TEXT_KINDS = '(?:text|sub|sub-txt|sub-md|sub-srt|sub-json|asr|ocr|ocr-frames|local-json)'
export const PROVEN_NAME_RE = new RegExp('^(?:' + [
  'BV[0-9A-Za-z]{10}-\\d{2,}\\.jpg',
  'f_\\d+m\\d+s\\.jpg',
  'peek-\\d{2,}\\.jpg',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.jpg',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.manifest\\.json',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.(?:txt|wav|tmp)',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.cues\\.json',
  // printText 落的 `<kind>.txt` / `<kind>.wrapped.txt`。
  //   kind 全集来自 tools/look.mjs 的 printText( 调用点（共 10 个），verify.mjs C162 有同源反查。
  //   `view` 不是 kind：cmdView 只调 writeMeta、全仓无 `view.txt` 落盘点，留着它等于按名字
  //   认领用户文件（与 1457 删掉 `0001.jpg` 同型，夹具 V 组盯着）。
  //   不按 `.txt` 后缀通吃 —— 用户自己放的 notes.txt 不能算我们的。
  `${PRINT_TEXT_KINDS}(?:\\.wrapped)?\\.txt`,
  // C221/A·B7 的 `<kind>.json` 结构化副本（lib/text-json.mjs:11 textJsonPath）。
  //   只认 `<kind>.json` 这个精确形状，不许按后缀通吃：
  //   meta.json / manifest.json / last-error.json 各有各的凭证，
  //   <kind>.cues.json 另有一条；按后缀认领等于把用户放的 .json 也当我们的（0.4.7 同型坑）。
  `${PRINT_TEXT_KINDS}\\.json`,
  // C242：writeMeta 失败时落的错误记录，只有本插件会写这个名字。
  'last-error\\.json',
].join('|') + ')$', 'i')

export function isProvenDotName(name) {
  if (name === '.lock') return true
  if (/^\.write-test-\d+$/.test(name)) return true
  if (!name.endsWith('.lock')) return false
  const base = name.slice(0, -5)
  if (!base || /^\.+$/.test(base)) return false     // `.lock` 已单列；空串 / 纯点不认
  if (/^\.meta-/.test(base)) return true           // ②
  if (/^\.write-test-/.test(base)) return true     // ⑥ 带 .lock 后缀的变体
  const core = base.startsWith('.') ? base.slice(1) : base
  if (!core || /^\.+$/.test(core)) return false
  // ③④⑤：底名必须是一个 BV 号（可带 -pN / -NxN 派生），BV 号是我们自己的身份凭证
  if (/^BV[0-9A-Za-z]{10}(?:-p\d+(?:-[0-9A-Za-z_]+)*|-\d+x\d+)?$/i.test(core)) return true
  if (PROVEN_FIXED_NAMES.has(core) || PROVEN_NAME_RE.test(core)) return true
  if (/\.tool\.txt$/i.test(core)) return true
  return false
}

/**
 * 这个目录是不是「我们自己建的、名字像 URL 的」缓存目录（短链没解析成 BV 时 cleanKey 会压成
 * `httpsb23.tvabc123` 这种名字）。
 *
 * 不认它，「立即清除」会留一堆删不掉的垃圾（剩 3 个）。
 * 又剩两个：`hot` 落 `_hot`（index.js 的 trimForModel 以 `_hot` 为 bv 调用 videoDir）；
 *   旧注释还说「search 的落盘目录名来自查询词」——2026-11-21 件一实核全仓 grep：
 *   生产代码只有 cmdSearch 打印到 stdout，没有任何以查询词建目录的落盘点，那句是陈旧描述。
 * 判据（收紧后）：名字必须像 http(s)，且里面**只有**我们自己的产物。
 *   旧版还把「至少有一个 `*.tool.txt`」当独立认领门槛，于是任何用户自建目录
 *   （名字不像 URL、不在 OWN_CACHE_DIRS）只要塞一个 `.tool.txt` 就被整棵认领并真删（F-01 第二现场）。
 *   现在 `.tool.txt` 只能作为「内容里允许出现的产物」通过 PROVEN_TOOL_TXT_RE 校验，
 *   不再单独授予认领权；名字不像 URL 的目录一律不认。空的 http(s) 目录仍只认名字。
 */
/**
 * URL 形目录是不是「我们自己建的」。0.4.17 再返修：保守口径，
 *   接受集严格是基线 `9bc913d` 的子集，扩大 0 项。
 *
 *   名字像 http(s) 只是入场券，目录里还要「每一项都能给出强凭证」才认领整棵。
 *   强凭证只有两类，其余一律 `return false` 整棵跳过、不做部分删除：
 *     · 精确 `*.tool.txt` 产物（PROVEN_TOOL_TXT_RE）；
 *     · 真正以 `.lock` 结尾且 isProvenDotName 认定的锁 / 点文件（`.lock`、`.BV*.lock` 等）。
 *
 *   为什么不再有 weak 档：此前 `urlDirEntryKind` 把 `meta.json` / `manifest.json` /
 *   `runs.jsonl` / `login-qr.png` / BV jpg / 文本类等归为 weak，`urlDirAllProven`
 *   末尾 `return strong` 让它们只要旁边有一个 `.tool.txt` 就被顺带删掉——一个强产物
 *   替同目录里本来没有任何归属依据的文件取得了整棵删除权（可复现误删）。
 *   从规则层关掉：任何非强凭证条目（含上述 weak 名字、用户文本、外来文件、其他点文件）
 *   出现即整棵 false。
 *
 *   `CACHE_MARK`（.bili-watch-root）从「中性跳过」改为「阻断」：基线下它让整棵判 false，
 *   中间版本把它当中性（于是旁边有 .tool.txt 就 true），这是扩大项 T+Wr / D+Wr / TJ+Wr
 *   的成因。按上界口径改回阻断。真实场景里 URL 目录内出现根标记几乎不可能（缓存根在上一层）。
 *
 *   `.write-test-N` 不再单独算凭证（它是插件写测试文件名，用户目录里放同名不该换来整棵删除权）：
 *   只有真正以 `.lock` 结尾、且 isProvenDotName 认定的才算强凭证。
 *
 *   空目录、只含弱凭证或外来文件的目录一律保留；只有全项强凭证的目录才整棵认领，
 *   真插件产物（只含 *.tool.txt 的 URL 目录，正对照 7/7）仍能清。
 */
function urlDirAllProven(p, depth = 0) {
  if (depth > 4) return false
  let ents
  try { ents = readdirSync(p, { withFileTypes: true }) } catch { return false }
  if (!ents.length) return false // 空目录拿不出任何凭证
  let strong = false
  for (const e of ents) {
    // 根标记出现即阻断（基线上界口径），不再中性跳过。
    if (e.name === CACHE_MARK) return false
    if (e.isDirectory()) {
      if (!OWN_CACHE_DIRS.has(e.name)) return false
      if (!urlDirAllProven(join(p, e.name), depth + 1)) return false
      continue
    }
    // 强凭证只有两类：精确 .tool.txt 产物；以 .lock 结尾且经 isProvenDotName 认定的点文件。
    if (PROVEN_TOOL_TXT_RE.test(e.name)) { strong = true; continue }
    if (/\.lock$/i.test(e.name) && isProvenDotName(e.name)) { strong = true; continue }
    // 其余一律阻断：meta.json / manifest.json / runs.jsonl / login-qr.png /
    // last-error.json / BV jpg / 用户文本 / 外来文件 / 其他点文件 / .write-test-N。
    return false
  }
  return strong // 至少要有一项强凭证，且没有任何阻断项
}

export function looksLikeOwnUrlDir(p, name) {
  if (!/^https?/i.test(name)) return false
  return urlDirAllProven(p)
}
