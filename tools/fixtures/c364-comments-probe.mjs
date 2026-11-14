/**
 * C364/C365/C366 取证夹具：真调 lib/bili-api.mjs 的 topComments，只桩 get。
 *   桩给的是接口原始响应形状，结论由主闸三条判据自己算；不注入任何同名假实现。
 *
 * 四个场景：
 *   ① 两页顶层（cursor.next 推进 + is_end 停）
 *   ② 一条 rcount=100 的顶层走 reply/reply，桩故意给 100 条子回复
 *   ③ 匿名态（loggedIn:false）与登录态（loggedIn:true）对照
 *   ④ 旧接口形状（没有 cursor）只给一页，验兼容不打第二次请求
 */
import { topComments, REPLY_LIMITS } from '../../lib/bili-api.mjs'

const clip = (s) => String(s).slice(0, 5000)
const reply = (rpid, rcount = 0, msg = '评论内容') => ({
  rpid,
  ctime: 1700000000,
  like: 1,
  state: 0,
  member: { uname: `U${rpid}`, mid: rpid },
  content: { message: msg },
  rcount,
})
const page = (replies, cursor) => ({ code: 0, data: { replies, ...(cursor ? { cursor } : {}) } })

// ① 两页：第一页 3 条 next=1，第二页 2 条 is_end=true，上游 all_count=5
const twoUrls = []
const twoPageGet = async (url) => {
  twoUrls.push(url)
  if (/[?&]next=0(?:&|$)/.test(url)) {
    return page([reply(1), reply(2), reply(3)], { next: 1, is_end: false, all_count: 5 })
  }
  return page([reply(4), reply(5)], { next: 2, is_end: true, all_count: 5 })
}
const two = await topComments({ get: twoPageGet, clip }, 999, 10, { loggedIn: true })

// ② 楼中楼：主接口一条 rcount=100，子回复接口桩给 100 条
const subUrls = []
const subGet = async (url) => {
  subUrls.push(url)
  if (url.includes('/x/v2/reply/reply?')) {
    return { code: 0, data: { replies: Array.from({ length: 100 }, (_, i) => reply(1000 + i)), page: { count: 100 } } }
  }
  return page([reply(7, 100)], { next: 1, is_end: true, all_count: 1 })
}
const subs = await topComments({ get: subGet, clip }, 999, 10, { loggedIn: true, withReplies: true })

// ③ 匿名 / 登录对照：上游 358，只给 2 条
const anonGet = async () => page([reply(21), reply(22)], { next: 1, is_end: true, all_count: 358 })
const anon = await topComments({ get: anonGet, clip }, 999, 10, { loggedIn: false })
const logged = await topComments({ get: anonGet, clip }, 999, 10, { loggedIn: true })

// ④ 没有 cursor 的旧形状：必须只打一次请求
const legacyUrls = []
const legacyGet = async (url) => {
  legacyUrls.push(url)
  return page([reply(31), reply(32)])
}
const legacy = await topComments({ get: legacyGet, clip }, 999, 10, { loggedIn: true })

process.stdout.write(JSON.stringify({
  limits: REPLY_LIMITS,
  two: {
    shown: two.shown, total: two.total, pages: two.pages,
    rpids: two.list.map((x) => x.rpid), urls: twoUrls,
  },
  subs: {
    repliesLength: subs.list[0]?.replies?.length ?? -1,
    repliesTotal: subs.repliesTotal,
    subUrls: subUrls.filter((u) => u.includes('/x/v2/reply/reply?')),
  },
  anon: { note: anon.note, shown: anon.shown, total: anon.total, truncated: anon.truncated, loggedIn: anon.loggedIn },
  logged: { note: logged.note },
  legacy: { shown: legacy.shown, pages: legacy.pages, urls: legacyUrls.length },
}))
