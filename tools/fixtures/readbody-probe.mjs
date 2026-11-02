/**
 * readJsonBody 的「真跑」探针（给 tools/verify.mjs 的 C118 用）。
 *
 * 为什么不用假 req 自己造：判据要盯的恰恰是 **IncomingMessage.destroy() 之后还会不会
 * emit end/error** —— 用 EventEmitter 假造就等于把自己的假设当成了被测事实。
 * 所以这里起一个真的 http server，把 handler 直接设成**从 index.js 逐字抠出来的
 * readJsonBody**，再用真客户端把 body 发上去。被验的是源码原文，环境是真的。
 *
 * 环境变量：
 *   PROBE_JSON   要发的 body（缺省 = 一个 **合法** JSON，填充到 70 KB）
 *   PROBE_BYTES  填充目标字节数（缺省 70*1024，只在没给 PROBE_JSON 时生效）
 *
 * 输出（只吐一行 JSON，永远 exit 0；判定交给 verify）：
 *   { ok:true, status:200, ms:14, body:'{}' }                    ← 超闸：落地 + 回空对象
 *   { ok:true, status:200, ms:3,  body:'{"a":1}' }               ← 未超闸：正常解析
 *   { ok:false, why:'连接出错…', code:'ECONNRESET' }              ← 旧形态（destroy 毁 socket）
 *   { ok:false, why:'5 秒内没有响应' }                             ← 真挂死
 */
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = join(HERE, '..', '..', 'index.js')
const LIMIT = 5_000

/** 缺省 body：**合法 JSON**，填充到 70 KB。故意合法 —— 这样「回 {} 」只可能是超闸分支
 *  干的，不可能是 JSON.parse 失败兜的底；「闸被整个删掉」时它会原样回 70 KB（body 不再是 {}）。 */
function defaultBody() {
  const want = Number(process.env.PROBE_BYTES || 70 * 1024)
  const head = '{"pad":"'
  const tail = '"}'
  return head + 'x'.repeat(Math.max(0, want - head.length - tail.length)) + tail
}
const PAYLOAD = process.env.PROBE_JSON ?? defaultBody()

/** 从源码里逐字抠出一个函数声明（按大括号配对，跳过字符串与注释里的括号）。 */
function grabFn(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`源码里找不到 function ${name}(`)
  let i = src.indexOf('{', at)
  let depth = 0
  let q = null
  for (; i < src.length; i++) {
    const c = src[i]
    const prev = src[i - 1]
    if (q) {
      if (c === q && prev !== '\\') q = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error(`function ${name} 的大括号没配平`)
}

const fnSrc = grabFn(readFileSync(INDEX, 'utf8'), 'readJsonBody')
// 逐字求值：拿到的就是 index.js 里那段代码本身，不是抄来的副本
const readJsonBody = new Function(`${fnSrc}; return readJsonBody;`)()

const done = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0) }
const hardTimer = setTimeout(() => done({ ok: false, why: '探针自身兜底超时' }), LIMIT + 2000)

const server = createServer((req, res) => {
  readJsonBody(req)
    .then((v) => {
      const body = JSON.stringify(v ?? {})
      if (res.destroyed) return done({ ok: false, why: 'socket 已被销毁，200 写不回去', body })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
    .catch((e) => done({ ok: false, why: 'handler 抛了：' + String(e?.message || e) }))
})

server.listen(0, '127.0.0.1', () => {
  const t0 = Date.now()
  const req = httpRequest({
    host: '127.0.0.1',
    port: server.address().port,
    method: 'POST',
    path: '/',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(PAYLOAD)) },
  })
  req.on('response', (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (d) => { body += d })
    res.on('end', () => {
      clearTimeout(hardTimer)
      done({
        ok: res.statusCode === 200,
        status: res.statusCode,
        ms: Date.now() - t0,
        body: body.length > 120 ? body.slice(0, 120) + `…(${body.length}B)` : body,
        bodyLen: body.length,
      })
    })
  })
  req.on('error', (e) => {
    clearTimeout(hardTimer)
    done({ ok: false, why: '连接出错（没拿到 HTTP 响应）', code: String(e?.code || ''), mode: String(e?.message || e) })
  })
  req.end(PAYLOAD)
  setTimeout(() => { clearTimeout(hardTimer); done({ ok: false, why: '5 秒内没有响应' }) }, LIMIT)
})
