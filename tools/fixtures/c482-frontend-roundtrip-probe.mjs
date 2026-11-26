/**
 * c482-frontend-roundtrip-probe.mjs —— A-1 空清单完整往返 + A-3 前端组包参与验收（2026-11-25，1516 派单 A 件）
 *
 * 真起 index.js 路由 handler，并抠 client.js 的 doClearAll 原样函数体：
 *   ① POST /cache/preview 拿 tokens（此时缓存根为空 → tokens=[]）
 *   ② 中途写入一个可清工具产物（BV 目录）
 *   ③ 把 preview 的 tokens 作为 confirmedTokens 喂给**前端真实组包代码**，拿到 clearBody
 *   ④ 把 clearBody 原样真打 POST /cache/clear
 * 断言：removed=0、产物还在、skipped 有「确认时没有可删对象」。
 *
 * 这样「前端实际组包」参与了验收——夹具不手填 tokens，只把 preview 的结果交给前端组包函数。
 * 子进程独立跑；env BILI_WATCH_CACHE 指向临时缓存根。输出一行 FRONT_ROUND_JSON=<json>。
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const idxUrl = process.argv[2]
const mod = await import(idxUrl)
const regs = []
const logs = []
const mkCtx = () => ({
  logger: { warn() {}, info(m) { logs.push(String(m)) }, error() {} },
  commands: { register() {} },
  on() {},
  get() { return { register() {} } },
  effect(fn) { return fn() },
  webServer: { register(rt) { regs.push(rt); return () => {} } },
})
mod.apply(mkCtx())
const route = regs[0]
if (!route) { console.log('NO_ROUTE'); process.exit(3) }

const fs = await import('node:fs')
const path = await import('node:path')
const root = process.env.BILI_WATCH_CACHE
const clientSrc = readFileSync(path.join(process.argv[3], 'client.js'), 'utf8')

const mkRes = () => ({
  code: null, headers: null, body: null,
  writeHead(c, h) { this.code = c; this.headers = h; return this },
  setHeader() { return this },
  end(b) { this.body = String(b); return this },
  write() { return this },
})
const mkReq = (url, body) => ({
  method: 'POST', url,
  headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
  socket: { remoteAddress: '127.0.0.1' },
  on(ev, cb) { if (ev === 'data') setTimeout(() => cb(JSON.stringify(body)), 0); if (ev === 'end') setTimeout(cb, 0); return this },
})
const call = async (url, body) => {
  const res = mkRes()
  await route.handler(mkReq(url, body), res)
  let j = null
  try { j = JSON.parse(res.body) } catch {}
  return { code: res.code, json: j }
}

// 抠 doClearAll 原样函数体：桩 jpost 捕获真正送出的 clearBody
const fnBody = () => {
  const at = clientSrc.indexOf('const doClearAll = async () => {')
  if (at < 0) return ''
  const open = clientSrc.indexOf('{', at)
  const end = clientSrc.indexOf('\n      }', open)
  return end > open ? clientSrc.slice(open + 1, end) : ''
}
// confirmedTokens 由外面注入（模拟 openClearAll 把 preview.tokens 存进 state）
const packBody = async (body, confirmedTokens, includeUnknown = false) => {
  if (!body) return null
  let captured = null
  const ctx = {
    includeUnknown,
    jpost: async (url, b) => { captured = b; return { ok: true, data: { items: 0 } } },
    setMsg: () => {}, dirtyRef: { current: true }, load: async () => {}, refreshFacts: async () => {},
    confirmedTokens,
  }
  const fn = new Function('ctx',
    `const { includeUnknown, jpost, setMsg, dirtyRef, load, refreshFacts } = ctx
     const confirmedTokens = ctx.confirmedTokens
     return (async () => { ${body} })()`)
  await fn(ctx)
  return captured
}

const reset = () => {
  for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n), { recursive: true, force: true })
  fs.writeFileSync(path.join(root, '.bili-watch-root'), '')
}
const mkBv = (name) => {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'meta.json'), '{}')
  return d
}
const exists = (p) => fs.existsSync(p)

const out = { bodyLength: fnBody().length }
try {
  // 反例一：空缓存根预览 → 写入可清产物 → 前端真实组包 → 真打 clear → 必须零删、产物还在
  reset()
  const prev = await call('/api/bili-watch/cache/preview', {})
  const tokens = prev.json?.data?.tokens || []
  const art = mkBv('BV1zzzzzzzzz')
  const clearBody = await packBody(fnBody(), tokens)   // 前端真实组包，tokens 来自 preview（空数组）
  const cleared = await call('/api/bili-watch/cache/clear', clearBody)
  out.empty = {
    tokensFromPreview: tokens.length,
    frontHasTokens: Object.prototype.hasOwnProperty.call(clearBody || {}, 'tokens'),
    frontTokensLen: Array.isArray(clearBody?.tokens) ? clearBody.tokens.length : -1,
    removed: cleared.json?.data?.removed,
    items: cleared.json?.data?.items,
    artKept: exists(art),
    skipped: Array.isArray(cleared.json?.data?.skipped) ? cleared.json.data.skipped.map((s) => s.name || s.why) : [],
    code: cleared.code,
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 1200)
}
console.log('FRONT_ROUND_JSON=' + JSON.stringify(out))
