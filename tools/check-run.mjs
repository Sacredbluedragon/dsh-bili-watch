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

export function makeChecker(results) {
  if (!Array.isArray(results)) throw new TypeError('makeChecker 需要一个结果数组')

  return function check(name, fn) {
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
      if (results.length === before) results.push({ name, ok: true, detail: detail ?? '' })
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
