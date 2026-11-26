// C482 取证夹具：A-3 前端组包必须参与验收。
//   抠 client.js 的 doClearAll 原样函数体，桩住 jpost，真看它送给 /cache/clear 的 clearBody：
//   · confirmedTokens=[] → 必须挂 tokens:[]（空清单=确认时无可删对象）
//   · confirmedTokens=['A'] → 挂 tokens:['A']
// 结论由 verify.mjs 判据算；本夹具只吐一行 FRONT_JSON=。不删任何文件。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8')

const fnBody = () => {
  const at = clientSrc.indexOf('const doClearAll = async () => {')
  if (at < 0) return ''
  const open = clientSrc.indexOf('{', at)
  const end = clientSrc.indexOf('\n      }', open)
  return end > open ? clientSrc.slice(open + 1, end) : ''
}

const run = async (body, confirmedTokens, includeUnknown = false) => {
  if (!body) return { error: 'doClearAll 函数体抠不出来' }
  let captured = null
  const msgs = []
  const ctx = {
    includeUnknown,
    jpost: async (url, b) => { captured = { url, body: b }; return { ok: true, data: { items: 0 } } },
    setMsg: (s) => msgs.push(String(s)),
    dirtyRef: { current: true },
    load: async () => {},
    refreshFacts: async () => {},
    confirmedTokens,
  }
  // 原样函数体真跑：confirmedTokens 直接注入，不加 || []，精确控制空数组场景。
  const fn = new Function('ctx',
    `const { includeUnknown, jpost, setMsg, dirtyRef, load, refreshFacts } = ctx
     const confirmedTokens = ctx.confirmedTokens
     return (async () => { ${body} })()`)
  try {
    await fn(ctx)
  } catch (e) {
    return { error: String(e?.message || e) }
  }
  const b = captured?.body || {}
  return {
    url: captured?.url || null,
    hasTokens: Object.prototype.hasOwnProperty.call(b, 'tokens'),
    tokens: b.tokens,
    includeUnknown: b.includeUnknown === true,
    all: b.all === true,
    confirmed: b.confirmed === true,
  }
}

const body = fnBody()
const out = { bodyLength: body.length }
try {
  out.empty = await run(body, [])
  out.nonempty = await run(body, ['myToken|fp'])
  out.checked = await run(body, [], true)
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 1000)
}
console.log('FRONT_JSON=' + JSON.stringify(out))
