/**
 * c500-stale-receipt-probe.mjs —— 1939 A 件过期回执四态（真实入口 preview→clear + 前端真实文案）。
 * 真起 index.js 路由，抠 client.js 的 doClearAll 原样函数体（桩 setMsg 捕获可见文字、桩 jpost
 * 真打路由并回传真实回包）：
 *   ①真正空 tokens:[] ②全过期（preview 后改写内容使 token 变、用旧 tokens）③部分过期
 *   ④缺清单/无效清单（C498 保住）。
 * 输出 STALE_JSON=<json>。
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
const mkReq = (url, body) => ({
  method: 'POST', url,
  headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
  socket: { remoteAddress: '127.0.0.1' },
  on(ev, cb) { if (ev === 'data') setTimeout(() => cb(JSON.stringify(body)), 0); if (ev === 'end') setTimeout(cb, 0); return this },
})
const call = async (url, body) => {
  const res = mkRes()
  await route.handler(mkReq(url, body), res)
  let j = null; try { j = JSON.parse(res.body) } catch {}
  return { code: res.code, json: j }
}
const reset = () => {
  for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n), { recursive: true, force: true })
  fs.writeFileSync(path.join(root, '.bili-watch-root'), '')
}
const mkBv = (name, content = '{}') => {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'meta.json'), content)
  return d
}
const exists = (p) => fs.existsSync(p)

// 抠 doClearAll 原样函数体：jpost 真打路由，setMsg 捕获前端可见文字
const fnAt = clientSrc.indexOf('const doClearAll = async () => {')
const open = clientSrc.indexOf('{', fnAt)
const end = clientSrc.indexOf('\n      }', open)
const fnBody = fnAt >= 0 && end > open ? clientSrc.slice(open + 1, end) : ''
const runPanel = async (confirmedTokens) => {
  const msgs = []
  let captured = null
  let lastResponse = null
  const ctx = {
    includeUnknown: false,
    jpost: async (url, b) => {
      captured = b
      // 真实 client.js 里 jpost 经 request() 会拼 API='/api/bili-watch' 前缀，桩里补上同一前缀。
      const full = url.startsWith('/api/') ? url : '/api/bili-watch' + url
      const r = await call(full, b)
      lastResponse = r
      return r.json || {}
    },
    setMsg: (m) => msgs.push(String(m)),
    dirtyRef: { current: true }, load: async () => {}, refreshFacts: async () => {},
    confirmedTokens,
  }
  const fn = new Function('ctx',
    `const { includeUnknown, jpost, setMsg, dirtyRef, load, refreshFacts } = ctx
     const confirmedTokens = ctx.confirmedTokens
     return (async () => { ${fnBody} })()`)
  await fn(ctx)
  return { msgs, body: captured, response: lastResponse }
}

const out = { fnBodyLen: fnBody.length }
try {
  // 2033 C-2（Astra 2028 第3条）：造「真正始终为空」——预览与确认之间什么都不写。
  //   旧夹具在 preview 之后 mkBv 造了个 BV 目录，且名字 BV1empty0000 只有 BV+9 位过不了 isOwnBvDir，
  //   既没测到真空也没测到新增。这里 preview 空 tokens → 前端 tokens:[] → clear，全程零写入。
  reset()
  const art0 = path.join(root, '.bili-watch-root') // 缓存根标记：确认空清单后必须还在（且不进 preview 认领清单）
  const pv0 = await call('/api/bili-watch/cache/preview', {})
  const emptyTokens = pv0.json?.data?.tokens || []
  const emptyCountBefore = emptyTokens.length
  const r1 = await runPanel(emptyTokens)
  const c1 = r1.response
  out.empty = { ok: c1.json?.ok, clearState: c1.json?.data?.clearState,
    removed: c1.json?.data?.removed, tokensBefore: emptyCountBefore,
    artKept: exists(art0),
    skippedKinds: (c1.json?.data?.skipped || []).map(s => s.kind), msgs: r1.msgs }

  // 2033 C-2/C-3：空预览之后有新增——新增项用合格 BV 名（BV+10 位），preview 空 → 新增 → 用空 tokens 确认。
  //   应报「实际清理 0 项 + 新增项保留 + 提示重新预览」(clearState=all-stale)，不能被 empty 抢先。
  reset()
  const pvE = await call('/api/bili-watch/cache/preview', {})
  const emptyTok = pvE.json?.data?.tokens || []
  const newArt = mkBv('BV1neww00001') // BV + 10 位，合格归属名
  const rE = await runPanel(emptyTok)
  const cE = rE.response
  out.emptyThenNew = { ok: cE.json?.ok, clearState: cE.json?.data?.clearState,
    removed: cE.json?.data?.removed, changedCount: cE.json?.data?.changedCount,
    newArtKept: exists(newArt), why: cE.json?.why, msgs: rE.msgs }

  // ②全过期：preview 一个 BV → 改写内部内容使 token 变 → 用旧 tokens 真打 clear → ok:false + 0 删 + 内容保住
  reset()
  const art = mkBv('BV1stale0001')
  const pv = await call('/api/bili-watch/cache/preview', {})
  const staleTokens = pv.json?.data?.tokens || []
  fs.writeFileSync(path.join(art, 'meta.json'), '{"changed":true}') // 内容变化，token 变
  const r2 = await runPanel(staleTokens)
  const c2 = r2.response
  out.allStale = { ok: c2.json?.ok, clearState: c2.json?.data?.clearState,
    changedCount: c2.json?.data?.changedCount, removed: c2.json?.data?.removed,
    artKept: exists(art), content: exists(art) ? fs.readFileSync(path.join(art, 'meta.json'), 'utf8') : null,
    skippedKinds: (c2.json?.data?.skipped || []).map(s => s.kind), why: c2.json?.why, msgs: r2.msgs }

  // ③部分过期：preview 两个 BV → 只改一个 → 旧 tokens 真打 clear → 删 1、跳 1、两个都报
  reset()
  const a = mkBv('BV1stale0010'); const b = mkBv('BV1fresh0011')
  const pv2 = await call('/api/bili-watch/cache/preview', {})
  const t2 = pv2.json?.data?.tokens || []
  fs.writeFileSync(path.join(a, 'meta.json'), '{"changed":true}')
  const r3 = await runPanel(t2)
  const c3 = r3.response
  out.partialStale = { ok: c3.json?.ok, clearState: c3.json?.data?.clearState,
    changedCount: c3.json?.data?.changedCount, removed: c3.json?.data?.removed,
    staleKept: exists(a), freshGone: !exists(b), msgs: r3.msgs }

  // ④缺清单：前端组包不给 tokens → 服务端拒绝、零删、needRepreview（C498 现状保住）
  reset()
  const art4 = mkBv('BV1missing01')
  const r4 = await runPanel(undefined)
  const c4 = r4.response
  out.missing = { ok: c4.json?.ok, needRepreview: c4.json?.data?.needRepreview,
    removed: c4.json?.data?.removed, artKept: exists(art4), msgs: r4.msgs }
} catch (e) { out.fatal = String(e?.stack || e).slice(0, 1200) }
console.log('STALE_JSON=' + JSON.stringify(out))
