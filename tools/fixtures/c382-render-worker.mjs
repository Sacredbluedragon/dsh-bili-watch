/**
 * C382/H 取证用的本地接口替身（worker 线程，避开 spawnSync 冻住主线程）。
 *   variant=mixed：三根顶层 rcount 5/2/1（有被默认折叠的楼中楼）
 *   variant=small：三根 rcount 2/1/0（显示的就是全部）
 *   VIEW 给 3 个分P，用来验 comments 标题行有没有分P信息。
 */
import { createServer } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'

const { variant } = workerData
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const VIEW = {
  code: 0,
  data: {
    aid: 999, bvid: 'BV1c38200001', title: '评论渲染夹具视频',
    desc: '', owner: { name: '夹具UP', mid: 456 },
    stat: { view: 1234, reply: 3 },
    pages: [{ cid: 781, page: 1, duration: 100 }, { cid: 782, page: 2, duration: 100 }, { cid: 783, page: 3, duration: 100 }],
    duration: 300,
  },
}
const top = (rpid, rcount) => ({
  rpid, ctime: 1700000000, like: 1, state: 0,
  member: { uname: `U${rpid}`, mid: rpid },
  content: { message: `顶层 ${rpid}` }, rcount,
})
const sub = (rpid) => ({
  rpid, ctime: 1700000000, like: 0, state: 0,
  member: { uname: `S${rpid}`, mid: rpid },
  content: { message: `子回复 ${rpid}` },
})
const RCOUNTS = variant === 'small' ? [2, 1, 0]
  : variant === 'many' ? Array.from({ length: 12 }, () => 0)
    : [5, 2, 1]
const REPLIES = RCOUNTS.map((n, i) => top(201 + i, n))

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const seg = u.pathname.replace(/^\//, '')
  const slash = seg.indexOf('/')
  const host = slash < 0 ? seg : seg.slice(0, slash)
  const path = slash < 0 ? '/' : seg.slice(slash)
  const key = `${host}${path}`
  const send = (obj, status = 200) => {
    const body = JSON.stringify(obj)
    res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  switch (key) {
    case 'api.bilibili.com/x/web-interface/view':
      return send(VIEW)
    case 'api.bilibili.com/x/v2/reply/main':
      return send({ code: 0, data: { replies: REPLIES, cursor: { next: 1, is_end: true, all_count: RCOUNTS.length } } })
    case 'api.bilibili.com/x/v2/reply/reply': {
      const root = Number(u.searchParams.get('root') || 0)
      const i = root - 201
      const n = i >= 0 && i < RCOUNTS.length ? RCOUNTS[i] : 0
      return send({ code: 0, data: { replies: Array.from({ length: n }, (_, k) => sub(1000 + root * 10 + k)), page: { count: n } } })
    }
    default:
      return send({ code: -404, message: `c382 mock 没有这条路由：${key}` }, 404)
  }
})
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }))
