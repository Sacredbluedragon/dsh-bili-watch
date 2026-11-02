/**
 * 命令级真跑用的「假 B 站」的 http 端：**跑在 worker 线程里**。
 *
 * 为什么必须是另一个线程：断言是 `spawnSync` 起子进程、同步等它结束的。spawnSync 期间
 * 主线程的事件循环是**停的**——如果 http server 也住在主线程，它就永远收不到请求，
 * 子进程一直等到超时（实测：rc=null、stdout 空、一条 hit 都没有，看着像「命令挂了」，
 * 实际是夹具自己把自己锁死了）。worker 有独立的事件循环，主线程阻塞时它照常应答。
 *
 * 记账走文件而不是 postMessage：断言在主线程里同步取「这次命令打了几跳」，
 * postMessage 是异步的，取不到「刚刚那一次」的结果。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

// 夹具视频：时长挑 125 秒——fmtSec 的两种写法（`2m05s`）都得走到
const VIEW = {
  code: 0,
  data: {
    aid: 999,
    bvid: 'BV1mock00001',
    title: '夹具视频标题',
    desc: '夹具简介一行',
    owner: { name: '夹具UP', mid: 456 },
    stat: { view: 1234, reply: 56 },
    pages: [{ cid: 789, page: 1, duration: 125 }],
    duration: 125,
  },
}

// 热评：第一条有 like 无 tag（`[赞7]`），第二条同样——两条都进「热评:」区
// 2026-11-02：第一条正文可被 workerData.commentText 替换（护栏判据要喂带注入的评论）。
//   不传时就是原来的「好片子」，老判据看到的 JSON 一个字节没变。
const REPLY1 = workerData.commentText || '好片子'
const REPLIES = {
  code: 0,
  data: {
    replies: [
      { member: { uname: '甲', mid: 1 }, content: { message: REPLY1 }, like: 7, rpid: 11 },
      { member: { uname: '乙', mid: 2 }, content: { message: '第二条热评' }, like: 3, rpid: 12 },
    ],
  },
}

// 热榜：三条。`--limit 2` 时第三条不许出现（顺带验 slice）。
// pubdate 1759276800 = 2025-10-01T00:00:00Z；duration 225 = 3:45；view 12345 → 「1.2万」
const RANKING = {
  code: 0,
  data: {
    list: [
      { bvid: 'BV1mock00002', stat: { view: 12345 }, duration: 225, pubdate: 1759276800, title: '第二个视频', owner: { name: '夹具UP2' } },
      { bvid: 'BV1mock00003', stat: { view: 999 }, duration: 45, pubdate: 1759276800, title: '第三个视频', owner: { name: '夹具UP3' } },
      { bvid: 'BV1mock00004', stat: { view: 1 }, duration: 60, pubdate: 1759276800, title: '不该出现的第四条', owner: { name: '夹具UP4' } },
    ],
  },
}

// 登录检查：uname/mid/level_info.current_level——E7 那处「Lvundefined」的字段就在这里
// 2026-11-02：补 wbi_img——fetchSubtitle 要先拿 wbi 签名 key，没有这两个字段就永远「无字幕轨」。
//   键名本身可以是假的（这里不校签名），只要 img_url/sub_url 的 basename 非空。
const NAV = {
  code: 0,
  data: {
    isLogin: true,
    uname: '夹具账号',
    mid: 10086,
    level_info: { current_level: 6 },
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
}

// 字幕正文：workerData.subtitleText 可替换（护栏判据要真跑 sub 的落盘），默认两句正常字幕。
//   给了 subtitleText 就重复成 30 段：C128 要走到「超过 textLimit → 摘要 + read 指引」那条分支，
//   两句话的字幕只会走「全打」，那条提示词根本不出现（那样断言会空过）。
const SUB_BODY = workerData.subtitleText
  ? {
      body: Array.from({ length: 30 }, (_, i) => ({
        from: i * 4, to: (i + 1) * 4, content: `${workerData.subtitleText}（第 ${i + 1} 段）`,
      })),
    }
  : {
      body: [
        { from: 0, to: 2.5, content: '夹具字幕第一句' },
        { from: 2.5, to: 5, content: '夹具字幕第二句' },
      ],
    }

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
// listen 之后才知道真实端口；字幕 URL 要指回本机自己（preload 不改写 127.0.0.1，会原样打过来）
let PORT = 0

const server = createServer((req, res) => {
  // preload 把域名拼成第一段路径：/api.bilibili.com/x/web-interface/view?bvid=...
  const u = new URL(req.url, 'http://127.0.0.1')
  const seg = u.pathname.replace(/^\//, '')
  const slash = seg.indexOf('/')
  const host = slash < 0 ? seg : seg.slice(0, slash)
  const path = slash < 0 ? '/' : seg.slice(slash)
  const key = `${host}${path}`
  try {
    appendFileSync(workerData.logFile, JSON.stringify({ host, path, query: u.search, cookie: String(req.headers.cookie || '') }) + '\n')
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
      return send(REPLIES)
    case 'api.bilibili.com/x/web-interface/ranking/v2':
      return send(RANKING)
    case 'api.bilibili.com/x/web-interface/nav':
      return send(NAV)
    // 2026-11-02：字幕轨（护栏判据要真跑 sub 的落盘与 wrapped 副本）。
    //   subtitle_url 直接指回本机 mock：preload 只改写四个 B 站域名，127.0.0.1 原样放行 → 正中这里。
    case 'api.bilibili.com/x/player/wbi/v2':
      return send({
        code: 0,
        data: { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: `http://127.0.0.1:${PORT}/subtitle.json` }] } },
      })
    case 'subtitle.json/':
      return send(SUB_BODY)
    // 直链指回本机自己：真要下也留在夹具里，不会摸到外网
    case 'api.bilibili.com/x/player/playurl':
      return send({ code: 0, data: { durl: [{ url: `http://127.0.0.1:${server.address().port}/media/fixture.mp4`, size: 2048 }] } })
    // videoshot 一律「没给 image/index」：peek 会回落 mp4 抽帧这条老路，不在这里假装成功
    case 'api.bilibili.com/x/player/videoshot':
      return send({ code: 0, data: { image: [], index: [] } })
    default:
      return send({ code: -404, message: `mock 没有这条路由：${key}` }, 404)
  }
})

server.listen(0, '127.0.0.1', () => {
  PORT = server.address().port
  parentPort.postMessage({ port: PORT })
})
