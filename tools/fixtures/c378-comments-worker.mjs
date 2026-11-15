/**
 * C378/C379/C381 的本地接口替身（跑在 worker 线程里，避开 spawnSync 冻住主线程）。
 *   记账每个请求的 Cookie 与路径；顶层评论给两页，第二页故意回第一页已有的 rpid。
 *   接缝沿用 tools/fixtures/bili-mock-preload.mjs：域名被拼进第一段路径。
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

const { logFile } = workerData
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

const VIEW = {
  code: 0,
  data: {
    aid: 999, bvid: 'BV1c37800001', title: '评论区夹具视频',
    desc: '', owner: { name: '夹具UP', mid: 456 },
    stat: { view: 1234, reply: 4 }, pages: [{ cid: 789, page: 1, duration: 125 }], duration: 125,
  },
}

const reply = (rpid, rcount, message) => ({
  rpid, ctime: 1700000000, like: 1, state: 0,
  member: { uname: `U${rpid}`, mid: rpid },
  content: { message }, rcount,
})
const page = (replies, cursor) => ({ code: 0, data: { replies, cursor } })

const PAGE1 = page(
  [reply(101, 5, '第一页第一条'), reply(102, 0, '第一页第二条')],
  { next: 1, is_end: false, all_count: 4 },
)
const PAGE2 = page(
  [reply(101, 5, '第二页重复第一条'), reply(103, 0, '第二页新的一条')],
  { next: 2, is_end: true, all_count: 4 },
)

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const seg = u.pathname.replace(/^\//, '')
  const slash = seg.indexOf('/')
  const host = slash < 0 ? seg : seg.slice(0, slash)
  const path = slash < 0 ? '/' : seg.slice(slash)
  const key = `${host}${path}`
  try {
    appendFileSync(logFile, JSON.stringify({
      host, path, query: u.search, cookie: String(req.headers.cookie || ''),
    }) + '\n')
  } catch { /* 记账失败不该让请求失败 */ }
  const send = (obj, status = 200) => {
    const body = JSON.stringify(obj)
    res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  switch (key) {
    case 'api.bilibili.com/x/web-interface/view':
      return send(VIEW)
    case 'api.bilibili.com/x/v2/reply/main':
      return send(u.searchParams.get('next') === '0' ? PAGE1 : PAGE2)
    case 'api.bilibili.com/x/v2/reply/reply':
      return send({ code: 0, data: { replies: [], page: { count: 0 } } })
    default:
      return send({ code: -404, message: `c378 mock 没有这条路由：${key}` }, 404)
  }
})

server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ port: server.address().port })
})
