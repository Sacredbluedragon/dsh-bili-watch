// 面板首屏 4 请求合并 + 失败重试语义：客户端侧的真跑夹具。
//
// 不把整个 client.js 塞进 VM（它要 React / slots / window / document，桩一堆反而测不准）。
// 做法分三层，都落在被测对象之外：
//   ① 词法数「首屏到底会发几个 /status」——jget('/status') 字面只能剩 1 处（共享 promise 内），
//      三处组件必须都取用 statusOnce()；拆回各自请求（扰动 D1）这一条立刻红。
//   ② 把 client.js 里 statusOnce 的定义段**原样**抠进 VM 真跑：桩 jget 按调用序号给成功 /
//      HTTP 500，模拟多轮渲染（每轮三个组件连调），验成功固定 1 个请求、失败每轮重试、
//      失败后转成功能拿到状态、在飞期间一轮仍共享。
//   ③ 另起 unhandledRejection 监听，验「组件没挂载、没人取用时」也不会漏一个没人接的 rejection；
//      词法验没有引入节流计时器（成功才缓存的方案不需要节流）。
//
// 输出一行 JSON：defect / capability / notes。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const src = readFileSync(join(ROOT, 'client.js'), 'utf8').replace(/\r\n/g, '\n')
const report = { fatal: null, defect: {}, capability: {}, notes: {} }
const d = report.defect
const c = report.capability

// 原样抠定义段：从 let statusOncePromise 到 const jpost 之前，中间一个字不改。
const from = src.indexOf('let statusOncePromise = null')
const to = src.indexOf('const jpost =')
const seg = from >= 0 && to > from ? src.slice(from, to) : ''

let unhandled = 0
const onUnhandled = () => { unhandled++ }
process.on('unhandledRejection', onUnhandled)

// plan：按 jget 调用序号给响应（'ok' / 'reject'），超出部分沿用最后一项。
// rounds：模拟多少轮渲染；每轮三个组件同步连调，等这一轮全部落地后再进下一轮。
const runVM = (plan, rounds = 1) => {
  const stub = `
    let __calls = []
    const __plan = ${JSON.stringify(plan)}
    const jget = (p) => {
      const i = __calls.push(p) - 1
      const kind = __plan[Math.min(i, __plan.length - 1)]
      return kind === 'reject'
        ? Promise.reject(new Error('HTTP 500'))
        : Promise.resolve({ ok: true, data: { ui: { showInSettings: true, activationSeen: false, hintDismissed: false }, deps: [] } })
    }
    ${seg}
    globalThis.__go = async () => {
      const roundsOut = []
      for (let r = 0; r < ${rounds}; r++) {
        const a = statusOnce()
        const b = statusOnce()
        const c = statusOnce()
        const values = await Promise.all([a, b, c])
        await Promise.resolve()
        roundsOut.push({
          samePromise: a === b && b === c,
          values,
          allNull: values.every((v) => v === null),
          allSame: values.every((v) => v === values[0] && v !== null),
        })
      }
      return {
        calls: __calls.slice(),
        rounds: roundsOut,
        samePromise: roundsOut[0].samePromise,
        values: roundsOut[0].values,
        allNull: roundsOut[0].allNull,
        allSame: roundsOut[0].allSame,
      }
    }
  `
  const ctx = vm.createContext({ Promise, Error, setTimeout, clearTimeout })
  vm.runInContext(stub, ctx, { timeout: 5000 })
  return ctx.__go()
}

try {
  report.notes.segFound = seg.length > 0
  report.notes.segBytes = seg.length
  if (!seg) { report.fatal = 'client.js 里找不到 statusOnce 定义段' }

  // ① 词法：首屏请求数
  const jgetStatus = (src.match(/jget\('\/status'\)/g) || []).length
  const onceUses = (src.match(/statusOnce\(\)/g) || []).length
  const freshExpr = src.includes("fresh ? '/status?fresh=1' : '/status'")
  report.notes.jgetStatus = jgetStatus
  report.notes.onceUses = onceUses
  report.notes.freshExpr = freshExpr

  d.C185_firstScreenRequestCount2 = jgetStatus === 1 && onceUses === 3
  c.C185_freshStillSeparate = freshExpr && !/fresh/.test(seg)
  c.C185_sharedCatchesToNull = /\.catch\(\(\) => null\)/.test(seg)
  c.C185_threeConsumersGuardNull = (src.match(/if \(!j \|\| !j\.ok\)|if \(j && j\.ok|if \(!j\) return/g) || []).length >= 3

  if (!report.fatal) {
    // ② C185：成功与 500 两种响应各真跑一轮
    const ok = await runVM(['ok'])
    const bad = await runVM(['reject'])
    report.notes.okCalls = ok.calls.length
    report.notes.rejectCalls = bad.calls.length
    d.C185_sharedPromise = ok.samePromise && ok.calls.length === 1
    c.C185_successReturnsSame = ok.allSame
    // 失败只要求「三次取用都拿到 null 且不崩」；请求数交给 C186 判
    //   （失败不缓存后，一轮渲染内仍共享 1 个在飞 promise，跨轮才重试）。
    c.C185_fiveHundredReturnsNull = bad.allNull

    // ③ C186：失败不缓存，跨轮真跑
    const retry = await runVM(['reject'], 3)
    const pinned = await runVM(['ok'], 3)
    const mixed = await runVM(['reject', 'ok', 'ok'], 3)
    report.notes.retryCalls = retry.calls.length
    report.notes.pinnedCalls = pinned.calls.length
    report.notes.mixedCalls = mixed.calls.length
    report.notes.retryRounds = retry.rounds.map((r) => (r.allNull ? 'null' : 'other'))
    report.notes.mixedRounds = mixed.rounds.map((r) => (r.allNull ? 'null' : r.allSame ? 'ok' : 'mixed'))

    // 恒失败：每轮重新发一个请求，三轮 3 个；每轮内三个组件仍共享同一个在飞 promise
    d.C186_failureRetriable = retry.calls.length === 3
      && retry.rounds.every((r) => r.allNull && r.samePromise)
    // 恒成功：成功后固定，三轮加起来只发 1 个
    c.C186_successPinned = pinned.calls.length === 1
      && pinned.rounds.every((r) => r.allSame && r.samePromise)
    // 失败 → 成功：第一轮 null，第二轮拿到状态，第三轮复用成功结果，共 2 个请求
    d.C186_failureThenSuccess = mixed.calls.length === 2
      && mixed.rounds[0].allNull && mixed.rounds[1].allSame && mixed.rounds[2].allSame
    // 方案 (b) 不需要节流：定义段里不许出现计时器 / 时间戳节流
    c.C186_noThrottle = !/setTimeout|Date\.now|retryAt|lastTry|throttle/.test(seg)
    // 词法辅助（主判据是上面的 VM 真跑）：必须同时有「在飞复用」与「失败清记录」
    c.C186_lexicalSuccessOnly = /if \(statusOncePromise\) return statusOncePromise/.test(seg)
      && /statusOncePromise = null/.test(seg)

    // ④ 给事件循环一个 tick，让「没人接的 rejection」有机会冒出来
    await new Promise((r) => setTimeout(r, 60))
    report.notes.unhandled = unhandled
    c.C185_noRejectionLeak = unhandled === 0
    c.C186_noRejectionLeak = unhandled === 0
  }
} catch (e) {
  report.fatal = String(e?.stack || e).slice(0, 600)
} finally {
  process.off('unhandledRejection', onUnhandled)
}

console.log(JSON.stringify(report))
