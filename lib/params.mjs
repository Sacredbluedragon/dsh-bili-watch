// 参数表：命令 × 参数的唯一事实源。
//
// 2026-11-02 第一步（第二步之后 look.mjs:115 已 import 本文件，见 24 行的说明）。
//   行为还是原来那套（分派链 3373-3482 手写 18 段 if-else、HELP 手写 39 行、
//   KNOWN_FLAGS 手写 27 项、README 再手写一份）。本文件只是把「现状」抄成一张表，
//   然后让 `audit()` 去和那四处对账 —— 第二步才让分派链改用这张表。
//
// 为什么不直接改分派链（原计划 7.3 就是先搬）：
//   参数层的四处声明里，**三处是给人读的**（HELP / README / 工具 description），
//   一处是给机器用的（KNOWN_FLAGS + 分派链）。先搬代码，等于把「机器那份」搬走了、
//   留下三份人读的继续各自漂移；而且搬的时候判据是「输出逐字节相同」，
//   那条判据恰好禁止了任何收口（失败路径要修，行为就必须变）。
//   所以顺序反过来：先把表立起来、让它咬住现状，再让代码去用表。
//
// 表与现状不一致时怎么办：
//   **不许改表去迁就现状、也不许改现状来迁就表**（第一步零行为变化）。有差异就登记进 GAPS，
//   每条 GAPS 带一个 check()——check 为 true 表示「这个差异现在还真的在」。
//   · 未登记的新差异 → audit 报 errors → 红
//   · 登记了但已经修好（check 变 false）→ audit 报 stale → **也红**
//   两个方向都咬，是因为只咬一边就会腐烂：只报新差异，修好的人不会回来撤登记，
//   半年后 GAPS 全是一堆早就没了的条目，没人再看得懂它。
//
// 谁在用：`tools/verify-params.mjs` 的「参数契约-8/9/10」三条静态断言。
// 第二步之后 look.mjs 也 import 本文件，那时这三条的作用从「记录现状」变成「锁住新写法」。

// ── flag 声明 ────────────────────────────────────────────────────
// kind：bool 不带值；num 带数值域；enum 带可选值；path/str 是自由文本。
//
// **本表是「有这个 flag」的唯一来源**（第二步）：`tools/cli-io.mjs` 的 VALUE_OPTS 与
//   `tools/look.mjs` 的 KNOWN_FLAGS 都从这里生成，不再各写一份。加一个 flag 只改这里。
//
// range：数值域，只设「显然无意义」的边界。**刻意不设上限** —— 上限是各命令自己的语义
//   （search 的 limit 实际被 `Math.min(20, …)` 截到 20，hot 没有上限），在这一层写死
//   会造出「表说 100、代码截到 20」的第二处不一致，正是这张表要消灭的那种东西。
const NUM = (min, int = true) => ({ min, int })

export const FLAGS = {
  // 全局：所有命令都读，但只有一部分命令真的用
  help: { kind: 'bool', doc: '打印全文 HELP，不执行任何命令（分派前拦截）' },
  cred: { kind: 'path', doc: '凭证文件路径（只有 sub / text 真的用）' },
  step: { kind: 'num', range: NUM(0, false), def: 0, doc: '抽帧步长（秒）；0 / 不传 = 按视频时长自动' },
  p: { kind: 'num', range: NUM(1), def: 1, doc: '多 P 视频的第几个分P' },

  // 逐命令
  limit: { kind: 'num', range: NUM(1), def: 10, doc: '条数（search / hot）' },
  order: { kind: 'enum', values: ['pubdate', 'click'], blank: true, doc: 'search 排序；空 = 综合' },
  days: { kind: 'num', range: NUM(0), def: 0, doc: 'search 时间窗口（天）；0 = 不限' },
  format: { kind: 'enum', values: ['text', 'json'], doc: '输出格式；可选值随命令变（见 COMMANDS[].overrides）' },
  out: { kind: 'path', doc: '落盘路径（受 checkOutDir 黑名单拦）' },
  head: { kind: 'num', range: NUM(1), doc: '只取前 N 行/句' },
  full: { kind: 'bool', doc: '取全文（与 head 互斥，full 更大）' },
  'no-time': { kind: 'bool', doc: '去掉 [mm:ss] 时间码' },
  fast: { kind: 'bool', doc: '跳过慢路径（不跑本地转写）' },
  verify: { kind: 'bool', doc: '字幕可疑时抽帧 OCR 核对画面' },
  'mark-seen': { kind: 'bool', doc: '标记为已看过' },
  ffmpeg: { kind: 'path', doc: '指定 ffmpeg 可执行文件' },
  fresh: { kind: 'bool', doc: '忽略已有抽帧缓存' },
  // C236b：clean --all 与三档一次性覆盖。它们是 bool 开关，不是配置项；
  // 长期的 deleteMode 在 cache-config.json 里，这里只覆盖「这一次」。
  all: { kind: 'bool', doc: 'clean 用：清到只剩缓存根标记（面板需两步确认）' },
  'keep-source': { kind: 'bool', doc: '通用 URL 的 frames / text / asr：显式保留本次下载的原视频或音轨（默认用完即删）' },
  permanent: { kind: 'bool', doc: 'clean --all 一次性覆盖：全部直删，不进回收站' },
  recycle: { kind: 'bool', doc: 'clean --all 一次性覆盖：全部走系统回收站' },
  smart: { kind: 'bool', doc: 'clean --all 一次性覆盖：重要文件走回收站，其余直删' },
  ocr: { kind: 'bool', doc: '抽帧后再 OCR' },
  scene: { kind: 'bool', doc: '吸附画面变化点抽帧' },
  frames: { kind: 'bool', doc: 'local 命令额外抽帧' },
  'dry-run': { kind: 'bool', doc: 'sheet 只出计划：不抽帧、不下载、不写盘；clean 只列出会删什么，一个文件都不删' },
  dur: { kind: 'num', range: NUM(1, false), doc: 'sheet --dry-run 出计划用的视频时长（秒）；离线给定时长即可算时间点' },
  at: { kind: 'str', doc: '指定时刻列表（750 / 12:30 / 12:30-13:10）' },
  grid: { kind: 'str', def: '3x3', doc: '九宫格行列数（如 3x3）' },
  // 2026-11-02：宫格挂台词。加它只改了本文件一处 + COMMANDS.sheet.accepts + HELP 一句，
  //   KNOWN_FLAGS / VALUE_OPTS / 未知参数提示全部自动跟上 —— 这是第二步把三张表合成一张之后
  //   第一次加 flag，正好验那张表是不是真的降低了成本。
  cues: { kind: 'bool', doc: 'sheet 的每格下方挂该时段的台词（视频要有字幕轨）' },
  key: { kind: 'str', doc: '登录二维码 key（login --poll 用）' },
  poll: { kind: 'bool', doc: '轮询扫码状态' },
  check: { kind: 'bool', doc: '只检查凭证是否还有效' },
  'asr-max': { kind: 'num', range: NUM(1), unit: 'ms', doc: '转写闸门覆盖（毫秒）；在 tuning() 里读，不在分派链上' },
  // 2026-11-02 第二步更正（第一步判错了）：这不**不是**死 flag。
  //   `tools/cli-io.mjs:88` 有 `if (argv.includes('--quiet')) setQuiet(true)` —— 它真的生效，
  //   只是没用 flag() 这个辅助函数读，所以按 `opt()/flag()` 扫消费点会漏掉它。
  //   `tools/verify-todo.mjs` 的 B33 还有一整条判据守着这条链（解析 → setQuiet(true) →
  //   say 走 stderr → index 无条件下发 → look 不许再定义第二份 say）。
  //   它真正的问题只有一个：**HELP 和 README 都不写它**（台账 L85 的原口径就是这个）。
  quiet: { kind: 'bool', doc: '把过程说明改走 stderr，stdout 只留正文（面板会无条件加它）' },
  // 0.4.8 C1：只给 clean 用。缓存根有目录读不出来（unknown）时默认拒绝清理，
  //   加这个 flag 才放行；对 locked（真有活锁）一律无效 —— 不能拿它跳过占用检查。
  'force-unknown': { kind: 'bool', doc: 'clean 遇「缓存根有目录读不出来」仍强制清理；只对 unknown 生效，活锁一律拒绝' },
}

/** 带值的 flag（`--x v` / `--x=v`）。cli-io 的 VALUE_OPTS 从这里生成。 */
export const VALUE_FLAG_NAMES = Object.freeze(Object.keys(FLAGS).filter((n) => FLAGS[n].kind !== 'bool'))

/** 全部已知 flag。look.mjs 的 KNOWN_FLAGS 从这里生成（未知参数警告用）。 */
export const KNOWN_FLAG_NAMES = Object.freeze(Object.keys(FLAGS))

/**
 * 取一个 flag 的原始字符串值，语义与 cli-io 的 `opt()` **逐字相同**：
 *   `--name=v` 优先；否则找 `--name` 且下一个词不以 `--` 开头。
 * 两处必须一致，否则会出现「校验的是 A、用的是 B」——verify-params 有一条真跑断言钉这个。
 */
export function rawValue(argv, name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}

/**
 * 参数值校验。返回错误串数组（空数组 = 通过）。
 * 只判**值本身有没有意义**，不判「这个命令认不认它」——
 *   后者判不了：index.js 的 execute 会无条件/按模型入参下发 --step / --p / --limit，
 *   一个命令收到不属于自己的参数是正常路径，不是错误（要收窄得先改 index.js 的下发逻辑）。
 * 第二步之前这些非法值全部被静默接受：`--step abc` 走 `Number()` 得 NaN、
 *   `NaN > 0` 为假，于是落进「自动」分支——用户以为设了 2 秒，实际按自动抽。
 */
export function checkFlagValues(argv) {
  const errors = []
  for (const name of KNOWN_FLAG_NAMES) {
    const f = FLAGS[name]
    if (f.kind !== 'num') continue
    const raw = rawValue(argv, name)
    if (raw === undefined) continue
    const n = Number(raw)
    const r = f.range || {}
    if (!Number.isFinite(n)) {
      errors.push(`--${name} 要一个数字，收到「${raw}」`)
    } else if (r.int !== false && !Number.isInteger(n)) {
      errors.push(`--${name} 要整数，收到「${raw}」`)
    } else if (n < r.min) {
      errors.push(`--${name} 不能小于 ${r.min}，收到「${raw}」`)
    } else if (r.max !== undefined && n > r.max) {
      errors.push(`--${name} 不能大于 ${r.max}，收到「${raw}」`)
    }
  }
  return errors
}

// 全局参数：在分派链之前被统一读掉（look.mjs 的 CRED / STEP / P 三个常量），
//   所以**任何命令都"接受"它们**——哪怕这个命令根本用不到。
//   这是登记在案的现状，不是设计意图：第二步要把它们挪进各命令的声明里。
export const GLOBAL_PARAMS = ['help', 'cred', 'step', 'p']

// C230 / B3 缩小版：运行时「该命令认不认这个参数」的唯一判据来源。
//   额外豁免不是拍脑袋加的，是现算出来的：求值 COMMANDS 的 accepts 并集，
//   KNOWN_FLAG_NAMES 里从未出现的恰好是 help / asr-max / quiet / keep-source 这 4 个
//   （help 已在 GLOBAL_PARAMS；其余 3 个就是下面的额外豁免）。
//     · asr-max：在 tuning() 里读，从不在分派链上出现，但真的生效（HELP 也宣传了它）；
//     · quiet：index.js 的 execute 对**所有命令**无条件下发，CLI 侧由 setQuiet() 统一读；
//     · keep-source：通用 URL 的下载产物收尾开关，在 runGeneric() 里由 flag() 读，
//       而 runGeneric() 位于分派链之前（dispatchParams 的扫描起点是 --help 拦截那行），
//       所以它和 asr-max 一样「真生效但不在任何命令段里」。它不能写进 asr/frames/text
//       的 accepts —— 那三个命令段是 B 站 BV 路径，根本不下载原片，写进去就是假声明。
//   少了这几条，`asr --asr-max 1000`、面板发来的任何一次调用、以及
//   `frames <通用URL> --keep-source` 都会被 C230 打成「本命令不接受」——参数明明生效。
//   这份集合只做「不误伤」，不用来放宽任何现有校验；新增全局读的 flag 必须同步这里，
//   同时补一条 GAPS 登记，让「消费点不在分派链」这件事有两端咬的记录。
//   clean 是例外：它不读 keep-source，由 unsupportedKeepSource() 在分派前明确拒绝（rc=2）。
//   豁免只是不打那句会误导人的「已按忽略处理」，不代表参数可以静默无效。
export const RUNTIME_GLOBAL_PARAMS = Object.freeze([...GLOBAL_PARAMS, 'asr-max', 'quiet', 'keep-source'])

/**
 * 返回 argv 里「本命令不接受」的已知 flag 名（排序去重）。
 * 纯函数：不读环境、不碰 IO、不改退出码。只给 CLI 打一行 ⚠ 用，不拦执行、不下发参数。
 *  · 未知 flag 不在返回里 —— 那条已有「未知参数」提示，别对同一个参数报两遍。
 *  · COMMANDS 里没有的命令返回空 —— 元命令与裸跑不归这条管。
 */
export function unacceptedFlags(cmd, argv = []) {
  const c = COMMANDS[cmd]
  if (!c) return []
  const accepted = new Set([...(c.accepts || []), ...RUNTIME_GLOBAL_PARAMS])
  const out = new Set()
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue
    const n = a.slice(2).split('=')[0]
    if (!n || !KNOWN_FLAG_NAMES.includes(n)) continue
    if (!accepted.has(n)) out.add(n)
  }
  return [...out].sort()
}

/**
 * 删除类命令的干跑契约：`deletes: true` 的命令必须自己实现 --dry-run。
 *
 * 没实现却收到 --dry-run 时返回拒绝原因，调用方据此 rc=2 拒绝执行；不许退化成
 * 「打一行『已按忽略处理』后照删」——那正是会真删用户缓存的形态。
 * 纯函数：不读环境、不碰 IO、不改退出码。`commands` 可注入，于是「将来新增一个
 * 删除类命令却忘了实现干跑」也能被同一条判据当场验到，不必等它先出一次事故。
 */
export function unsupportedDryRun(cmd, argv = [], commands = COMMANDS) {
  const c = commands?.[cmd]
  if (!c || c.deletes !== true) return null
  const wantsDry = argv.some((a) => typeof a === 'string' && (a === '--dry-run' || a.startsWith('--dry-run=')))
  if (!wantsDry) return null
  if ((c.accepts || []).includes('dry-run')) return null
  return `${cmd} 是删除类命令，但还没实现 --dry-run；为防止误删，本次已拒绝执行（去掉 --dry-run 才会真正执行）`
}

/**
 * 清缓存命令收到 --keep-source 时必须明确拒绝，不许静默忽略后照删。
 *
 * --keep-source 在 RUNTIME_GLOBAL_PARAMS 里（消费点在分派链之前的 runGeneric()），
 * 所以 unacceptedFlags() 对它一律豁免、连一行「本命令不接受」都不会打；而 clean 段
 * 完全不读它。用户显式表达了「我要保留原片」，程序却按默认策略把 gen-<hash> 下的
 * 原视频/音轨永久删掉 —— 承诺与行为相反，和 C236 的「--dry-run 被忽略后照删」同一家族。
 *
 * 与 unsupportedDryRun 同构：靠 deletes: true 认删除类命令，可注入 commands，
 * 纯函数、不读环境、不碰 IO、不改退出码。将来某条命令真把 keep-source 写进 accepts
 * 并实现了保留，这里自动放行，不需要再拆闸。
 */
export function unsupportedKeepSource(cmd, argv = [], commands = COMMANDS) {
  const c = commands?.[cmd]
  if (!c || c.deletes !== true) return null
  const wants = argv.some((a) => typeof a === 'string' && (a === '--keep-source' || a.startsWith('--keep-source=')))
  if (!wants) return null
  if ((c.accepts || []).includes('keep-source')) return null
  return `${cmd} 不接受 --keep-source：它是通用 URL 下载产物的保留开关，对清缓存没有作用。为避免「以为原片留着、实际被删除」，本次已拒绝执行（去掉 --keep-source 才会真正执行）`
}

// ── 命令表 ──────────────────────────────────────────────────────
// accepts：该命令在分派链上真的把哪些参数传下去了。
//   判据是**代码**，不是抽取器的眼睛：`step: STEP` / `p: P` 这类经全局常量的传参
//   也是真传了。第一步起草时抽取器认不出常量形态（当时的抽取器已修），
//   那批就把 step / p 从全表删掉了 —— 判据的盲区不该由被测对象来补。
// overrides：该命令下某个 flag 的域覆盖（format 是唯一一个域随命令变的）。
// target：缺目标时提示里该说「缺什么」。
export const COMMANDS = {
  login: { accepts: ['check', 'key', 'poll'], target: '（无目标）', doc: '扫码登录 / 检查凭证' },
  help: { accepts: [], target: '（无目标）', meta: true, doc: '打印 HELP（元命令，不列进 HELP 的命令清单）' },
  search: { accepts: ['days', 'limit', 'order'], target: '搜索关键词', doc: '搜视频' },
  hot: { accepts: ['limit'], target: '（无目标）', doc: '综合热门榜' },
  peek: { accepts: ['ffmpeg', 'fresh', 'p'], target: 'BV 号或链接', doc: '标题/简介/热评 + 5 帧' },
  view: { accepts: ['p'], target: 'BV 号或链接', doc: '元数据与热评' },
  sub: {
    accepts: ['cred', 'format', 'full', 'head', 'no-time', 'out', 'p'], target: 'BV 号或链接',
    overrides: { format: { values: ['text', 'srt', 'json', 'md', 'txt'], def: 'text' } },
    doc: '字幕',
  },
  comments: {
    accepts: ['format', 'out'], target: 'BV 号或链接',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: '评论区',
  },
  danmaku: {
    accepts: ['format', 'out', 'p'], target: 'BV 号或链接',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: '弹幕热区',
  },
  asr: { accepts: ['ffmpeg', 'p'], target: 'BV 号 / 链接 / 通用 URL', doc: '本地转写' },
  frames: {
    accepts: ['at', 'ffmpeg', 'format', 'fresh', 'ocr', 'out', 'p', 'scene', 'step'], target: 'BV 号 / 链接 / 通用 URL',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: '抽帧',
  },
  sheet: {
    accepts: ['at', 'cred', 'cues', 'dry-run', 'dur', 'ffmpeg', 'format', 'fresh', 'grid', 'out', 'p', 'step'], target: 'BV 号或链接',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: 'N 帧拼九宫格（--cues 挂台词；--dry-run 只出计划）',
  },
  substrip: {
    accepts: ['ffmpeg', 'format', 'fresh', 'out', 'p', 'step'], target: 'BV 号或链接',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: '底部字幕带竖拼',
  },
  ocr: {
    accepts: ['ffmpeg', 'format', 'out', 'p', 'step'], target: 'BV 号或链接',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: '抽帧 + OCR',
  },
  text: {
    accepts: ['cred', 'fast', 'ffmpeg', 'format', 'full', 'head', 'mark-seen', 'no-time', 'out', 'p', 'step', 'verify'],
    target: 'BV 号 / 链接 / 通用 URL',
    overrides: { format: { values: ['text', 'json', 'md'], def: 'text' } },
    doc: '字幕 + 转写 + OCR 的合一入口',
  },
  local: {
    accepts: ['ffmpeg', 'format', 'frames', 'ocr', 'out', 'step'], target: '本地文件路径',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: '本地视频/音频转写 + 抽帧 OCR',
  },
  // deletes: true 是语义标记，不是装饰：unsupportedDryRun() 靠它拦住「删除类命令
  // 收到没实现的 --dry-run」，拦不住就会重演「提示一句忽略、实际照删」。
  clean: { accepts: ['dry-run', 'force-unknown', 'all', 'permanent', 'recycle', 'smart'], deletes: true, target: '（无目标）', doc: '清缓存（--dry-run 只列不删，--all 清到只剩标记）' },
  doctor: {
    accepts: ['format'], target: '（无目标）',
    overrides: { format: { values: ['text', 'json'], def: 'text' } },
    doc: '六项环境自检（不联网 / 不改文件 / 不写缓存）',
  },
}

// ── 现状偏差登记 ────────────────────────────────────────────────
// 每条 check 接收 audit 采集到的 facts，返回 true = 「差异现在还真的在」。
// 修好之后 check 会变 false，audit 立刻报 stale —— 逼着人回来撤登记。
//
// **这里只放静态可判的**。行为类的偏差（--step 拿到 NaN、--grid 传 abc 会怎样、
//   text --format xml 报错却 rc=0）静态读源码判不了，归到 verify-params 的真跑断言
//   （参数契约-4 已覆盖 --step），第二步逐条转成真跑判据。
export const GAPS = [
  // 已消：quiet-undocumented（第一步登记，第二步撤）。HELP 补上了 `--quiet` 的说明，
  //   差异不复现 —— 蹭到的是常驻断言「参数契约-7：表里每个 flag 都要在 HELP/README 有一处说明」，
  //   不需要在 GAPS 里再留一条。顺带更正第一步的错判：--quiet **不是**死 flag，
  //   `tools/cli-io.mjs:88` 的 `argv.includes('--quiet')` 就是它的消费点，B33 还有整条判据守着；
  //   第一步判错是因为消费点扫描器只认 opt()/flag()，已在 verify-params 里补上第三种形态。
  {
    id: 'asr-max-off-dispatch',
    what: '--asr-max 不在分派链上：它在 tuning() 内部 opt(\'asr-max\') 读，所以「哪个命令认它」从分派链看不出来',
    check: (f) => f.consumed.includes('asr-max') && !f.dispatchParamsAny.includes('asr-max'),
  },
  {
    // 与 asr-max 同构：消费点在分派链**之前**的 runGeneric() 里（通用 URL 下载产物收尾开关），
    //   dispatchParams 的扫描起点是 --help 拦截那行，根本扫不到它。
    // 判据作者早已把 src.type === 'generic' 段排除在命令归属外（「任意命令遇到通用 URL，
    //   不是某一条命令的参数」），所以这个 flag 天然不属于任何 COMMANDS[].accepts。
    // 唯一正确的归属是 RUNTIME_GLOBAL_PARAMS（运行时不误伤）+ 本条登记（位置偏差两端咬）。
    // 谁把它挪进分派链命令段，check 会变 false → 判据报 stale，逼他撤登记并同步 accepts。
    id: 'keep-source-off-dispatch',
    what: '--keep-source 不在分派链上：它在分派链之前的 runGeneric() 里由 flag() 读，靠 RUNTIME_GLOBAL_PARAMS 豁免，不能写进 asr/frames/text 的 accepts（那三段是 B 站 BV 路径，不下载原片）',
    check: (f) => f.consumed.includes('keep-source') && !f.dispatchParamsAny.includes('keep-source'),
  },
  {
    id: 'global-step-p-accepted-everywhere',
    what: '--step / --p 在分派链之前被统一读掉（STEP / P 常量），所以 clean / login / view 这些命令也"接受"它们（传了不报错、也不生效）',
    // 2026-11-02：这条原来还包含 --cred。--cred 后来从「分派前统一读的 CRED 常量」
    //   改成 sub / sheet / text 各自在分派链里 opt('cred')，它不再是「全局接受」，
    //   所以本条收窄成 step / p 两个 —— 它们确实还是 STEP / P 常量。
    //   注意这**没修掉** clean / login / view 收到 --cred 也不报错这件事：那属于
    //   「没有任何机制检查命令认不认某参数」（见 verify-params 契约-9 的注释），是另一件事。
    // 2026-11-02 第二步补（抽取器认常量之后）：原来的 check 是
    //   `!f.dispatchParamsAny.includes('step')` —— 抽取器一认出 `step: STEP`，这个条件
    //   就恒为 false，这条登记会立刻被判「过期」。可差异其实还在，是判据表达错了。
    //   现在改成**真跑**：给 view 一个它不用的 --step（也不给 BV），只要 stderr 里
    //   没有「未知参数」，就说明命令层面还没有过滤参数的出口。
    //   后面把那个出口做出来之后，这条会自然变 false → 判据提示撤登记。
    check: (f) => ['step', 'p'].every((n) => f.consumed.includes(n)) && f.stepAcceptedByNonUser,
  },
  {
    id: 'unknown-cmd-says-missing-target',
    what: '未知命令报的是「缺少 BV 号或视频链接」rc=2，而不是「未知命令」rc=1：分派链的 empty 分支在未知命令之前就把它接走了',
    check: (f) => f.unknownCmdSaysMissing === true,
  },
]

// ── 对账 ────────────────────────────────────────────────────────
// facts 由调用方从 look.mjs 源码抽出来（抽取器在 tools/verify-params.mjs，
//   因为「解析被测对象」这件事不该住在被测对象将来要 import 的模块里）。
//   helpCmds        HELP 正文里 `node look.mjs <cmd>` 出现的命令
//   dispCmds        分派链 `} else if (cmd === 'x')` 的命令
//   knownFlags      KNOWN_FLAGS 的条目
//   consumed        全文件真正被 opt('x') / flag('x') 读过的 flag
//   dispatchParams  { 命令: [该命令段内出现的 flag] }
// 返回 { cmds, flags, gaps, stale }：前三组是「未登记的差异」，最后一组是「已登记但已失效」。
//   分四组而不是一个扁平数组，是为了让三条断言各盯一组——红了能直接看出是哪一层对不上，
//   不用去猜一串中文里哪句是关于命令的、哪句是关于 flag 的。
export function audit(facts) {
  const cmds = []
  const flags = []
  const gaps = []
  const stale = []
  const setOf = (a) => new Set(a)
  const tableCmds = Object.keys(COMMANDS)
  const bizCmds = tableCmds.filter((c) => !COMMANDS[c].meta)

  // ① 命令表 × 分派链：双向一致（元命令豁免 HELP 清单，但必须真的在分派链里）
  const disp = setOf(facts.dispCmds)
  const notInDisp = tableCmds.filter((c) => !disp.has(c))
  if (notInDisp.length) {
    cmds.push(`参数表有、分派链没有：${notInDisp.join(' ')} —— 表在承诺一个不存在的命令`)
  }
  const notInTable = facts.dispCmds.filter((c) => !tableCmds.includes(c))
  if (notInTable.length) {
    cmds.push(`分派链有、参数表没登记：${notInTable.join(' ')} —— 加了命令没进表，下一次改动会漏掉它`)
  }

  // ② 命令表 × HELP：业务命令必须都在 HELP 清单里
  const help = setOf(facts.helpCmds)
  const notInHelp = bizCmds.filter((c) => !help.has(c))
  if (notInHelp.length) {
    cmds.push(`参数表有、HELP 没列：${notInHelp.join(' ')} —— 用户查不到这个命令`)
  }
  const helpNotInTable = facts.helpCmds.filter((c) => !tableCmds.includes(c))
  if (helpNotInTable.length) {
    cmds.push(`HELP 列了、参数表没登记：${helpNotInTable.join(' ')}`)
  }

  // ③ 命令表 accepts × 分派链实际传的：逐命令逐个比
  //    这是整张表最有用的一条 —— 它把「这个命令认 X」和「代码真的把 X 传下去了」钉在一起。
  for (const c of tableCmds) {
    const declared = [...COMMANDS[c].accepts].sort()
    const actual = [...(facts.dispatchParams[c] || [])].sort()
    const onlyDeclared = declared.filter((x) => !actual.includes(x))
    const onlyActual = actual.filter((x) => !declared.includes(x))
    if (onlyDeclared.length) {
      cmds.push(`${c}：参数表声明 ${onlyDeclared.join(' ')}，分派链没传 —— 声明了却没生效`)
    }
    if (onlyActual.length) {
      cmds.push(`${c}：分派链传了 ${onlyActual.join(' ')}，参数表没声明 —— 表漏了`)
    }
  }

  // ④ 每个 flag 都要有消费点。
  //    第一步这里还兼管「dead 分类」——那是错的：`--quiet` 有消费点（argv.includes 形态），
  //    只是判据的扫描器不认那种写法。现在**没有 dead 这个分类**：一个 flag 要么有人读，
  //    要么它就是多余的，不该靠一个标记留在表里。
  //    `consumed` 由调用方采集，必须同时认 `opt('x')` / `flag('x')` / `argv.includes('--x')` 三种形态。
  const tableFlags = Object.keys(FLAGS)
  const consumed = setOf(facts.consumed)
  for (const f of tableFlags) {
    if (!consumed.has(f)) {
      flags.push(`--${f} 在表里，但全文件没人读它 —— 要么补消费点，要么从表里删掉（不许静默留着）`)
    }
  }

  // ⑤ GAPS 两端咬：该在的必须还在，修好了必须撤登记
  for (const g of GAPS) {
    let still
    try {
      still = g.check(facts)
    } catch (e) {
      gaps.push(`GAPS[${g.id}] 的 check 抛了：${e.message}`)
      continue
    }
    if (!still) {
      stale.push(
        `${g.id}：这个差异已经不复现了 —— 先确认是真修好了，再把这条从 GAPS 删掉` +
          `（过期登记会让后来的人以为还有坑，比没登记更费时间）`,
      )
    }
  }

  return { cmds, flags, gaps, stale }
}
