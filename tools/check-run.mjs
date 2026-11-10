/**
 * 断言执行器：一条断言怎么算「跑过」、怎么算「通过」。
 *
 * 为什么单独成文件（2026-10-31 单独成文件）：
 *   原来这个函数是 tools/verify.mjs 里的一个局部 const，**外面碰不到**，于是它自己是唯一
 *   没有任何断言的代码——而它恰恰是「所有断言是否真跑」的唯一开关。
 *   今天实证的假绿（`check('X', async () => {...})` → 记一笔 PASS、断言体一行没跑）就住在
 *   这几行里：反向测试救不了它（反向也不跑），三问也救不了它（它连问题都不进场）。
 *
 *   所以把判据抽到这里，让 verify.mjs 里的 C77 能**直接 import 它**、喂一个 async 回调，
 *   验「它必须记 FAIL」。这条自检与 fnBody 的编译自检同一优先级：验的是「我们还在检查」。
 *
 * 契约（别改，改了 C77 会红）：
 *   - 入参 results 是调用方的结果数组，本函数只往里 push，不持有状态；
 *   - 回调返回 thenable → 记 FAIL（本验证器是同步的，Promise 永远不会被 await）；
 *   - 回调内部已 push 过结果（skip()）→ 不再补 PASS，避免同一条断言 PASS+SKIP 各记一笔；
 *   - 回调抛错 → 记 FAIL，detail 取错误消息。
 *
 * 第二参数 select（C247）：可选函数，返回 false 时**在调用 fn 之前直接 return**。
 *   不传（或传 null）时行为与加这个参数之前逐字节一致 —— C77 与 verify-params 都不传，
 *   默认路径不因 `--only` 多跑或漏跑任何一条。过滤只做「不执行」，不做「跑了再过滤输出」。
 */

/**
 * @param {Array<{name: string, ok: boolean, skip?: boolean, detail?: string}>} results
 * @returns {(name: string, fn: () => unknown) => void}
 */
/**
 * 把抛出物转成 detail 字符串，**任何情况下都不许再抛**（2026-11-01，P1-7）。
 *
 * 为什么不能直接 `String(e)`：它不是安全的。
 *   - `Object.create(null)` → TypeError: Cannot convert object to primitive value
 *   - 自定义 `toString()` 自己抛的对象 → 原样抛出来
 *   - 把 Symbol 拼进模板串 → TypeError
 * 而那行原来就在 `catch` 里 —— 于是「记录失败」这一步自己失败，验证器崩在做记录这一行，
 * 一条结果都没 push，进程退出码还不是 1（是 uncaughtException 的 1，但汇总一行都没打，
 * 看上去像是「验证器根本跑不起来」，而不是「有一条断言失败」）。
 *
 * 顺序：先要 message（最常见，Error 实例）→ 再 String() → 再 Object.prototype.toString
 *   （这个对 null 原型对象也是安全的，返回 '[object Object]'）→ 最后给一句人话兜底。
 */
function safeMsg(e) {
  try {
    if (e !== null && e !== undefined) {
      const m = e.message
      if (m != null) return String(m)
    }
  } catch {}
  try {
    return String(e)
  } catch {}
  try {
    return Object.prototype.toString.call(e)
  } catch {}
  return '<抛出物无法转成字符串>'
}

export function makeChecker(results, select = null) {
  if (!Array.isArray(results)) throw new TypeError('makeChecker 需要一个结果数组')
  if (select !== null && typeof select !== 'function') throw new TypeError('makeChecker 的 select 必须是函数或 null')

  return function check(name, fn) {
    // C247：这一行必须在 try / fn() 之前。放在后面就成了「跑了再丢结果」，
    // 那既没省上下文也没省时间，还让「只跑了 N 条」变成一句谎话。
    if (select && !select(name)) return
    const before = results.length
    try {
      const detail = fn()
      // 本验证器是同步的：async 回调返回的 Promise 不会被 await，也就不会抛到下面的 catch 里——
      //   结果是「断言体一行没跑，却记了一笔 PASS」。这是最省事的一种假绿（比 C73 那版还隐蔽），
      //   所以在这里直接拦住，而不是靠写的人记得「别写 async」。
      //   C77 就是钉这一条的：喂 async 回调，必须看到 FAIL。
      if (detail && typeof detail.then === 'function') {
        // 2026-11-01（P1-6）：既然我们把 Promise 拒之门外，就得负责接住它的拒绝。
        //   不接的后果：那个 Promise 的 reject 没人处理 → unhandledRejection。
        //   实测 C77 自己 ① 的 selftest（async 回调里 `throw new Error('这行永远进不了 catch')`）
        //   就是靠这一句，在 verify 末尾的「延迟异步检测」里被报成「断言体之外起的异步里抛了错」
        //   —— 假阳性。执行器造成的未处理拒绝，应该在执行器这里消掉。
        if (typeof detail.catch === 'function') detail.catch(() => {})
        throw new Error('check 的回调返回了 Promise：验证器是同步的，异步断言会被记成通过（假绿）。改成同步写法')
      }
      // 2026-10-30（WB-CN）：断言内部调了 skip() 再 return 时，这里不能再补一条 PASS——
      //   skip() 已经自己 push 过一笔，补进去就成了「同一条断言 SKIP + PASS 各一行」，
      //   通过数虚高 1（发布树的 C11 一直是这样：53 通过/3 跳过，真实是 52/3）。
      //   判据用「这一趟有没有新结果」，不猜名字——skip() 传的是短名，与 check 的全名对不上。
      //
      // 局部 skip 例外（C164）：只跳过某一个子项、其余子项仍跑完并返回了实质说明串，
      // 这时主 check 必须补一条 PASS，否则硬判结果和 return 的 detail 都被吞掉，
      // 汇总里只剩一条短名 SKIP。整体 skip 的写法统一是 return 'ok' / return（无值），
      // 只有返回了非空、非 'ok' 的说明串才算局部 skip —— 不会碰 C114/C11/C41/C115 等。
      const skippedHere = results.slice(before).some((r) => r.skip)
      const partialSkip = skippedHere && typeof detail === 'string'
        && detail.length > 0 && detail !== 'ok'
      if (results.length === before || partialSkip) {
        results.push({ name, ok: true, detail: detail ?? '' })
      }
    } catch (e) {
      // 2026-11-01（P1-7）：原来是 `e?.message ?? String(e)` —— String(e) 自己会抛（见 safeMsg 注释）。
      results.push({ name, ok: false, detail: safeMsg(e) })
    }
  }
}

/**
 * 断言的失败信号：`must(cond, msg)` 判据不成立就抛。
 *
 * 为什么也搬进来（2026-11-01，P0-3）：
 *   verify.mjs 里 700 多处断言全靠它把「不成立」变成异常。它原来只是 verify.mjs 的
 *   文件局部常量，**外面碰不到，所以它自己是唯一没有任何断言的代码**——和上面 check()
 *   当初一模一样的处境。把它打空（`const must = () => {}`）实测：97 通过 / 7 失败 / 2 跳过，
 *   而 C77 当时仍然 PASS —— 那个 97 里的每一条都是假绿。
 *
 *   搬到这里之后，C77 能 import 同一个绑定、直接喂 false 验「必须抛」。
 *   注意 C77 验的是**这个文件导出的 must**；verify.mjs 必须 import 它而不是另写一份
 *   （另写一份 = 又回到「验的和用的不是一个东西」）。
 *
 * 契约（别改，改了 C77 会红）：
 *   - 只有 falsy 算失败（false / 0 / '' / null / undefined / NaN）；
 *   - 抛 Error，消息就是 msg 原文——C77 靠消息是不是原文判「抛的是不是 this must」。
 */
export function must(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ── C247 · `--only` 的三个纯函数 ──
// 抽出来不是为了复用，是为了让 C271 能**真求值**被测对象：解析 / 匹配 / 提示行
// 三件事都在生产代码里，判据直接喂输入输出，不抠 verify.mjs 的源码文本猜行为。
// 分母口径（C286 统一后）：总数 = 判据单元数 = 所有 check() 调用数 + 顶层独立 skip 数；
// 分子 = 实际调用过断言体的条数。「其余 = 总数 − 分子」才自洽，且这个总数与默认全量
// 汇总行「通过 + 失败 + 跳过」同源。本函数不猜单位，由调用方把算好的总数传进来。
export function parseOnlySpecs(argv) {
  let raw = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') { raw = argv[i + 1] ?? ''; break }
    if (argv[i].startsWith('--only=')) { raw = argv[i].slice('--only='.length); break }
  }
  if (raw === null) return null
  return raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
}

/**
 * 编号或编号前缀：C268 精确、C24 前缀。
 * C284（0750 §四 bug 1）：以前这里只拼 'C' + 数字，把 C124b / W-07 / W-22 这类
 *   名字的字母后缀与 W- 前缀全丢了，--only C124b 永远选不中。
 *   现在统一走 checkId()：C124b → C124B、W-07 → W-07、中文开头 → null。
 *   --only C124B 只选 C124b 一条（精确）；--only C124 选 C124 与 C124b 两条（前缀）。
 *   W-07 这类非 C 编号同样支持 --only W-07 —— 派单要求「支持或文档写明不支持」，
 *   这里选支持，不改 README。
 */
export function matchOnly(name, specs) {
  if (specs === null) return true
  const id = checkId(name)
  if (id === null) return false
  return specs.some((s) => id === s || id.startsWith(s))
}

/** 默认路径（active=false）必须返回 null —— 不许天天冒出这行凭证变成噪音。 */
export function onlyNoticeLine(total, ran, active) {
  if (!active) return null
  return `[--only] 本 run 只跑了 ${ran} / ${total} 条，其余 ${total - ran} 条未执行`
}

// ── C272 · 输出瘦身（2026-11-10，0750 派单第一层）──
// 抽出来不是为复用，是为让 C272 能**真求值**被测对象：默认该打什么、--verbose 该打什么，
// 判据直接喂一个结果数组看返回的 lines，不读 verify.mjs 的源码文本抠 console.log。
//
// 口径（与 0750 §二 的示例一致，两处例外是对派单的更正，见交付报告）：
//   - verbose=false（默认全量 / --fast）：只打 FAIL 与 SKIP 明细；PASS 不逐条列，
//     改成一行「[N 条 PASS 未列明细，加 --verbose 看]」；全绿时整段 ≤2 KB。
//   - verbose=true（--verbose，以及 --only 路径）：逐条打全明细，与瘦身之前逐字节同形。
//     --only 本来就是「只想看这几条」，把它们也瘦掉会违背它的用途，所以不瘦。
//   - 汇总行、空行位置、跳过明细块都不归本函数管（跳过明细仍在 verify.mjs 里），
//     这样「默认路径与今天逐字节一致」只剩「PASS 行换成计数行」这一处变化。
export function renderResults(results, opts = {}) {
  const verbose = !!opts.verbose
  const lines = []
  let pass = 0, fail = 0, skipN = 0
  for (const r of results) {
    if (r.skip) skipN++
    else if (r.ok) pass++
    else fail++

    if (verbose || !r.ok || r.skip) {
      const tag = r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'
      lines.push(`${tag}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`)
    }
  }
  if (!verbose && pass > 0) lines.push(`[${pass} 条 PASS 未列明细，加 --verbose 看]`)
  lines.push('')
  lines.push(`${pass} 通过 / ${fail} 失败 / ${skipN} 跳过`)
  return { lines, pass, fail, skipN }
}

// ── C275–C277 · 第二层「--fast 分档」（2026-11-10，0750 派单 §三）──
//
// 不许靠「看名字像不像慢判据」来跳：那是又一个按形状猜的坑（0.4.7 拿扩展名当归属证据
// 把用户文件删了）。这里三条路都是可枚举、可被判据真求值的：
//   ① 老判据走 SLOW_CHECKS（下面这份过渡清单，按编号，C276 用双向差集守着不漂）；
//   ② 本轮新判据一律用 slowCheck() 显式声明，工厂把「登记」做成可注入回调，
//      C276 真求值它必须真的调了 register 与 check，而不是一份空实现；
//   ③ 提示行是纯函数，判据直接喂数字，不读源码文本。
//
// 清单口径（对 0750 §三 的更正，见二层报告）：派单写「50 条 / 64 处」，那是只数
// spawnSync 与 execFileSync 的结果；派单判据 2 又要求把 runFixture 一起扫，两者合并
// 后是 93 条 / 114 处。本清单按后者，且排除 const runFixture = ... 定义体本身
// （它含 spawnSync，容易被误算到前一个判据头上）。处数明细在 _临时/r-verify/slow-draft.json。

/** 从判据全名取编号：C124b… → C124B、W-07… → W-07、C29… → C29；中文开头 → null。 */
export function checkId(name) {
  const m = /^([A-Za-z]+(?:-\d+|\d+[a-z]*)?)/.exec(name)
  return m ? m[1].toUpperCase() : null
}

/**
 * 过渡清单：默认全量时含子进程调用的 93 条老判据编号。
 * 为什么慢：块内真起子进程（spawnSync / execFileSync / runFixture），或真跑一遍发布链 /
 * 真跑另一个主闸。每项都不按「名字长得像」挑，是同一份扫描脚本切块扫出来的。
 * 编号一律大写，与 checkId() 的返回值同源；C276 会验「每项 === 自身 toUpperCase()」。
 */
export const SLOW_CHECKS = Object.freeze([
  'W-07', 'W-22', 'W-25', 'C20', 'C29', 'C133', 'C40', 'C53', 'C54', 'C115',
  'C116', 'C55', 'C56', 'C58', 'C59', 'C64', 'C65', 'C67', 'C68', 'C69',
  'C78', 'C82', 'C83', 'C80', 'C87', 'C88', 'C93', 'C104', 'C107', 'C118',
  'C119', 'C121', 'C122', 'C124', 'C124B', 'C125', 'C126', 'C127', 'C142', 'C146',
  'C151', 'C162', 'C163', 'C164', 'C166', 'C174', 'C177', 'C176', 'C182', 'C183',
  'C184', 'C186', 'C187', 'C188', 'C189', 'C193', 'C194', 'C195', 'C196', 'C197',
  'C235', 'C199', 'C200', 'C207', 'C208', 'C216', 'C218', 'C223', 'C226', 'C224',
  'C217', 'C219', 'C220', 'C221', 'C222', 'C225', 'C229', 'C230', 'C231', 'C232',
  'C233', 'C234', 'C245', 'C246', 'C253', 'C258', 'C261', 'C266', 'C267', 'C268',
  'C269', 'C270', 'C271',
])

/**
 * 返回 slowCheck(name, fn)：与本文件 makeChecker 的 check 完全同签名，
 * 只是在调用 check 之前把名字登记进调用方给的 register。
 *
 * 用工厂而不是模块级可变绑定，是因为「绑定一份模块级 check」正是 §五 点名要防的
 * 「同名重导出一份空实现」——工厂让绑定显式、也让 C276 能喂假 check 真求值注册行为。
 * register 必须先于 check：verify.mjs 的 select 在 check 内部第一行就跑，
 * 那时 declaredSlow 里必须已经有这个名字，--fast 才跳得掉。
 */
export function makeSlowChecker(check, register) {
  if (typeof check !== 'function') throw new TypeError('makeSlowChecker 需要一个 check 函数')
  if (typeof register !== 'function') throw new TypeError('makeSlowChecker 需要一个 register 函数')
  return function slowCheck(name, fn) {
    register(name)
    return check(name, fn)
  }
}

/** --fast 的跳过提示。默认路径（active=false）返回 null，不许冒出这行噪音。 */
export function fastNoticeLine(skipped, ran, active) {
  if (!active) return null
  return `[--fast] 本次跳过 ${skipped} 条含子进程判据，其余 ${ran} 条已跑`
}
