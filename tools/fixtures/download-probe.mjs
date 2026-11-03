// downloadTo 探针：本地 http 服务器把「下载会被怎么坑」的六种响应各走一遍。
//
// 为什么单独子进程：verify 的执行器是同步的（C77 钉的就是「async 回调被记成 PASS」），
//   而这里要起服务器、要 await。
//
// 为什么值得测：downloadTo 的五个分支（非 200 / 200+HTML 风控 / 超上限 / 小于 1 KB / 网络层）
//   全是**只有出错才走到**的路径，输出基线只覆盖成功下载（frames/sheet 那两条），
//   任何一支被搬丢都不会在基线上留下痕迹。把它搬进 lib/media.mjs 时，
//   上限文案还从写死的「512 MB」改成由 maxBytes 算出来——这里顺手把「上限=2 MB」钉住。
import http from 'node:http'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { downloadTo } = await import('../../lib/media.mjs')

const server = http.createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.alloc(2048, 7))
  } else if (req.url === '/html') {
    // 200 但是验证页：B13 要按类型拦，不能把网页存成 mp4
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>请完成验证</body></html>')
  } else if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"code":-352}')
  } else if (req.url === '/big') {
    // 显式给 Content-Length 3 MB > maxBytes 2 MB：判定发生在读 body 之前（省流量那条路）
    const b = Buffer.alloc(3 * 1024 * 1024, 1)
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(b.length) })
    res.end(b)
  } else if (req.url === '/big-chunked') {
    // 不给 Content-Length（Node 对 writeHead 后再 write 的响应走 chunked）：
    //   这时「先看头」的预检什么都看不到，只能靠读完 body 再比 —— 两条判据都得在。
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.write(Buffer.alloc(1024 * 1024, 1))
    res.end(Buffer.alloc(2 * 1024 * 1024, 1))
  } else if (req.url === '/tiny') {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.alloc(100, 2))
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const dir = mkdtempSync(join(tmpdir(), 'bw-dl-'))
const out = {}
const run = async (name, url, opts = {}) => {
  const dest = join(dir, `${name}.mp4`)
  const r = {}
  try {
    await downloadTo(url, dest, {
      headers: { 'user-agent': 'probe', referer: 'http://127.0.0.1/' },
      maxBytes: 2 * 1024 * 1024,
      ...opts,
    })
    r.ok = true
    r.bytes = existsSync(dest) ? statSync(dest).size : -1
  } catch (e) {
    r.ok = false
    r.err = String(e?.message ?? e)
  }
  r.destExists = existsSync(dest)
  r.partLeft = existsSync(`${dest}.part`)
  out[name] = r
}

await run('ok', `${base}/ok`)
await run('html', `${base}/html`)
await run('json', `${base}/json`)
await run('notfound', `${base}/nope`)
await run('big', `${base}/big`)
await run('bigChunked', `${base}/big-chunked`)
await run('tiny', `${base}/tiny`)
// 网络层：端口 1 上没有监听，连接直接被拒 —— 传一个会留痕的 onNetError，
//   用它证明「注入的翻译函数确实被调用」（CLI 侧注入的是 friendlyNetError）。
await run('net', 'http://127.0.0.1:1/x', {
  onNetError: (e, url) => new Error(`NETWRAP:${e?.cause?.code || e?.message}@${url}`),
})

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify(out))
