// jget 探针：用本地 http 服务器把「B 站会怎么欺负你」的五种响应各走一遍。
//
// 为什么单独一个子进程（与 verify.mjs 的 ROUTE_PROBE 同理）：verify 的执行器是同步的，
//   而这里要起服务器、要 await。塞进 check() 只会得到一笔假 PASS（C77 钉的就是这个）。
//
// 为什么值得测：jget 是**所有**网络请求的唯一入口，它的四个特殊分支（412 风控、200+HTML 风控、
//   -352 风控码、非 JSON）和「5xx 只重试一次」的退避，此前一条断言都没有——
//   把它搬进 lib/ 时，任何一支被搬丢，输出基线都看不出来（基线只覆盖成功路径）。
import http from 'node:http'

const { jget } = await import('../../lib/bili-api.mjs')

const hits = []
const server = http.createServer((req, res) => {
  // 2026-11-01（0.4.1 第 1 条）：连请求头一起记 —— 只记 url 的话，「jget 裸奔」这个缺陷
  //   在探针里完全看不见（服务器收到的 user-agent 说什么都不会被任何断言读到）。
  hits.push({ url: req.url, headers: req.headers })
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { x: 1 } }))
  } else if (req.url === '/html') {
    // 200 但返回验证页：W-36 判为风控，必须抛错而不是当成「不是 JSON」的普通失败
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>请完成验证</body></html>')
  } else if (req.url === '/412') {
    res.writeHead(412, { 'content-type': 'text/plain' })
    res.end('blocked')
  } else if (req.url === '/500') {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"code":-1,"message":"boom"}')
  } else if (req.url === '/notjson') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end('hello')
  } else if (req.url === '/risk352') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: -352, message: '请求过于频繁' }))
  } else {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"code":-404,"message":"nope"}')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const diags = []
const out = {}
const grab = async (name, path) => {
  try {
    const val = await jget(base + path, { onDiag: (u, s, b) => diags.push([path, s, String(b).length]) })
    out[name] = { ok: true, val }
  } catch (e) {
    out[name] = { ok: false, err: String(e?.message ?? e) }
  }
}

await grab('ok', '/ok')
await grab('html', '/html')
await grab('412', '/412')
await grab('notjson', '/notjson')
await grab('risk352', '/risk352')
await grab('http500', '/500')
await grab('http404', '/404')

out.diagCount = diags.length
out.diagFirst = diags[0]
out.diagHtml = diags.find((d) => d[0] === '/html')
out.hitsTotal = hits.length
out.hits500 = hits.filter((h) => h.url === '/500').length
// 服务器端收到的请求头：去重成「这次跑下来一共出现过几种」。
//   走到 lib 的默认头 → 只有一种 UA、一种 Referer；退回 `{}` 或 UA 被写成空串 → 立刻变形。
const uniq = (pick) => [...new Set(hits.map((h) => String(pick(h.headers) || '')))]
out.hdrUA = uniq((hd) => hd['user-agent'])
out.hdrRef = uniq((hd) => hd.referer)
out.hdrCookie = uniq((hd) => hd.cookie)

server.close()
console.log(JSON.stringify(out))
