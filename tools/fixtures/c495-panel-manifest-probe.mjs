/**
 * c495-panel-manifest-probe.mjs —— B-4 面板缺清单/无效清单零删（端到端真实路由）。
 * 真起 index.js 路由；面板确认请求（all+confirmed）在缺 tokens / tokens 非数组时必须
 * 拒绝执行、提示重预览、零删；tokens:[] 是有效清单（零删+skipped「确认清单为空」）；
 * 真实 preview tokens 是正对照（真删）。前端 doClearAll 原样组包参与至少一条。
 * 输出一行 PANEL_JSON=<json>。
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const idxUrl = process.argv[2]
const mod = await import(idxUrl)
const regs = []
const mkCtx = () => ({
  logger: { warn() {}, info() {}, error() {} },
  commands: { register() {} }, on() {},
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
  code: null, body: null,
  writeHead(c) { this.code = c; return this },
  setHeader() { return this },
  end(b) { this.body = String(b); return this },
  write() { return this },
})
const mkReq = (body) => ({
  method: 'POST', url: '/api/bili-watch/cache/clear',
  headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
  socket: { remoteAddress: '127.0.0.1' },
  on(ev, cb) { if (ev === 'data') setTimeout(() => cb(JSON.stringify(body)), 0); if (ev === 'end') setTimeout(cb, 0); return this },
})
const call = async (url, body) => {
  const res = mkRes()
  const req = { ...mkReq(body), url }
  await route.handler(req, res)
  let j = null; try { j = JSON.parse(res.body) } catch {}
  return { code: res.code, json: j }
}
const reset = () => {
  for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n), { recursive: true, force: true })
  fs.writeFileSync(path.join(root, '.bili-watch-root'), '')
}
const mkBv = () => {
  const d = path.join(root, 'BV1panel1234')
  fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'meta.json'), '{}')
  return d
}
const exists = (p) => fs.existsSync(p)

// 抠 doClearAll 组包：confirmedTokens 为 undefined 时不会挂 tokens（模拟面板 bug 漏挂）
const fnAt = clientSrc.indexOf('const doClearAll = async () => {')
const open = clientSrc.indexOf('{', fnAt)
const end = clientSrc.indexOf('\n      }', open)
const fnBody = fnAt >= 0 && end > open ? clientSrc.slice(open + 1, end) : ''
const packBody = async (confirmedTokens) => {
  let captured = null
  const ctx = {
    includeUnknown: false,
    jpost: async (url, b) => { captured = b; return { ok: true, data: {} } },
    setMsg: () => {}, dirtyRef: { current: true }, load: async () => {}, refreshFacts: async () => {},
    confirmedTokens,
  }
  const fn = new Function('ctx',
    `const { includeUnknown, jpost, setMsg, dirtyRef, load, refreshFacts } = ctx
     const confirmedTokens = ctx.confirmedTokens
     return (async () => { ${fnBody} })()`)
  await fn(ctx)
  return captured
}

const out = { fnBodyLen: fnBody.length }
try {
  // 缺清单：面板确认请求但前端组包没挂 tokens（confirmedTokens=undefined）→ 拒绝、零删
  reset(); let art = mkBv()
  const bodyMissing = await packBody(undefined)
  out.missing = { hasTokens: Object.prototype.hasOwnProperty.call(bodyMissing || {}, 'tokens') }
  let r = await call('/api/bili-watch/cache/clear', bodyMissing)
  out.missing = { ...out.missing, ok: r.json?.ok, needRepreview: r.json?.data?.needRepreview,
    why: r.json?.why, removed: r.json?.data?.removed, artKept: exists(art), code: r.code }

  // 无效清单：tokens 不是数组 → 拒绝、零删
  reset(); art = mkBv()
  r = await call('/api/bili-watch/cache/clear', { all: true, confirmed: true, tokens: 'not-an-array' })
  out.invalid = { ok: r.json?.ok, needRepreview: r.json?.data?.needRepreview,
    removed: r.json?.data?.removed, artKept: exists(art), code: r.code }

  // 空清单：tokens:[] 是有效清单 → 零删 + skipped「确认清单为空」。
  //   必须造「真·空现场」：预览和确认之间不建任何可认领对象，否则 built.entries 非空、
  //   changedCount>0 会被判成 all-stale（ok=false）。缓存根标记（reset 已建）验它保住。
  reset(); art = path.join(root, '.bili-watch-root')
  r = await call('/api/bili-watch/cache/clear', { all: true, confirmed: true, tokens: [] })
  out.empty = { ok: r.json?.ok, removed: r.json?.data?.removed, artKept: exists(art),
    skipped: (r.json?.data?.skipped || []).map(s => s.why || s.name) }

  // 正对照：真实 preview tokens → 真删（证明不是一律不删）
  reset(); art = mkBv()
  const pv = await call('/api/bili-watch/cache/preview', {})
  const bodyValid = await packBody(pv.json?.data?.tokens || [])
  r = await call('/api/bili-watch/cache/clear', bodyValid)
  out.valid = { tokensLen: (pv.json?.data?.tokens || []).length, removed: r.json?.data?.removed, artGone: !exists(art) }

  // CLI 老路：all+confirmed 但根本不模拟面板（直接 body 无 tokens 且 confirmed 缺失）→ 走老路照删（第三入口/doc 口径）
  reset(); art = mkBv()
  r = await call('/api/bili-watch/cache/clear', { all: true, confirmed: true, tokens: (await call('/api/bili-watch/cache/preview', {})).json?.data?.tokens || [] })
  out.cliOld = { note: 'CLI 走 look.mjs 不经本路由；此处按有效清单对照', removed: r.json?.data?.removed }
} catch (e) { out.fatal = String(e?.stack || e).slice(0, 1200) }
console.log('PANEL_JSON=' + JSON.stringify(out))
