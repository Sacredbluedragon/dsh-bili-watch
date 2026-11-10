// C232 成本回报取证夹具：stdout 只吐 JSON。
// ① 真 lib 纯函数（形状 / 估算 / 未知 / 不覆盖）；
// ② 真源码切片：emitTextJson 函数体原样在 vm 里跑，核 json 多了 cost、既有键一字不动；
// ③ 真包装层：runCommandJson 真调用，核 frames/ocr 的 result.cost 能穿过 json 出口。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { costOf, costProse, withCost } from '../../lib/cost-line.mjs'
import { runCommandJson } from '../../lib/command-json.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const result = { pure: {}, emit: {}, pipe: {} }
try {
  // ① 真 lib 纯函数
  const c = costOf({ t0: 1000, now: 3500, frames: 24, bytes: 2048, cached: true })
  result.pure = {
    fixed: c,
    prose: costProse(c),
    unknownProse: costProse(costOf({ t0: 1000, now: 1000, cached: null })),
    noStart: costOf({ now: 5000 }).ms,
    notNegative: costOf({ t0: 9000, now: 1000 }).ms,
    badNum: costOf({ t0: 0, now: 0, frames: 'abc', bytes: -5 }).frames,
    withCost: withCost({ ok: true, text: 'T' }, c),
    noOverride: withCost({ ok: true, cost: 'KEEP' }, c),
    nullSafe: withCost(null, c),
  }

  // ② emitTextJson 真源码切片（起止只依赖被抽对象自身）
  const src = readFileSync(join(ROOT, 'tools', 'look.mjs'), 'utf8')
  const mark = 'function emitTextJson(opts, payload) {'
  const st = src.indexOf(mark)
  const en = src.indexOf('\n}\n', st)
  const body = src.slice(st + mark.length, en)
  const base = { ok: true, source: 'text', text: '正文ABC', chars: 3 }
  const payload = { ...base }
  let printed = ''
  const sandbox = {
    String, JSON, Buffer,
    console: { log: (s) => { printed = String(s) }, error: () => {} },
    opts: { format: 'json', costT0: 1000, costCached: true },
    payload,
    costOf: (o) => costOf({ ...o, now: 3500 }),
    scanInjection: () => [],
    emitWarn: () => {}, labelOf: () => 'text', untrustedMeta: () => ({}),
    payloadTextOf: (p) => String(p?.text ?? ''),
    isAbsolute: () => false, join: () => '',
    process: { cwd: () => '' }, mkdirSync: () => {}, writeFileSync: () => {},
  }
  vm.runInNewContext(`(function(opts, payload){${body}\n})(opts, payload)`, sandbox, { timeout: 3000 })
  let parsed = null
  try { parsed = JSON.parse(printed) } catch {}
  result.emit = {
    bodyLength: body.length,
    parseOk: Boolean(parsed),
    keys: parsed ? Object.keys(parsed).sort().join(',') : '',
    baseIntact: parsed ? ['ok', 'source', 'text', 'chars'].every((k) => parsed[k] === base[k]) : false,
    cost: parsed?.cost ?? null,
    prose: printed.slice(0, 120),
  }
  // 反证：没给 costT0 时不许多出 cost 字段
  const payload2 = { ...base }
  let printed2 = ''
  const sandbox2 = { ...sandbox, payload: payload2, opts: { format: 'json' }, console: { log: (s) => { printed2 = String(s) }, error: () => {} } }
  vm.runInNewContext(`(function(opts, payload){${body}\n})(opts, payload)`, sandbox2, { timeout: 3000 })
  result.emit.noStartHasCost = Object.prototype.hasOwnProperty.call(JSON.parse(printed2), 'cost')

  // ③ 真包装层：frames/ocr 的 result.cost 要能穿过 json 出口，且既有键不变
  const origWrite = process.stdout.write
  let captured = ''
  const costSample = costOf({ t0: 1000, now: 2500, frames: 7, bytes: 512, cached: false })
  try {
    process.stdout.write = (s) => { captured += String(s); return true }
    await runCommandJson({
      opts: { format: 'json', result: { dir: 'D', frames: 7, cached: false, cost: costSample } },
      source: 'frames', bv: 'BV1xx', getVideo: () => { throw new Error('不该联网') },
      fn: async () => { console.log('散文 1'); console.log('散文 2') },
    })
  } finally { process.stdout.write = origWrite }
  let piped = null
  try { piped = JSON.parse(captured) } catch {}
  result.pipe = {
    parseOk: Boolean(piped),
    keys: piped ? Object.keys(piped).sort().join(',') : '',
    cost: piped?.cost ?? null,
    frames: piped?.frames ?? null,
    prose: piped?.prose ?? null,
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
}
console.log(JSON.stringify(result, null, 2))
