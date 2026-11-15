/**
 * C380 取证：真调 lib/bili-api.mjs 的 topComments，只桩 get。
 *   四象限各一次（匿名截断 / 匿名不截断 / 登录截断 / 登录不截断），
 *   结论由主闸判据自己算；不注入同名假实现、不预判对错。
 */
import { topComments } from '../../lib/bili-api.mjs'

const clip = (s) => String(s).slice(0, 5000)
const reply = (rpid) => ({
  rpid, ctime: 1700000000, like: 1, state: 0,
  member: { uname: `U${rpid}`, mid: rpid },
  content: { message: `评论 ${rpid}` }, rcount: 0,
})
const page = (allCount) => ({
  code: 0,
  data: {
    replies: [reply(1), reply(2)],
    cursor: { next: 1, is_end: true, all_count: allCount },
  },
})

const run = async (name, loggedIn, allCount) => {
  const r = await topComments({ get: async () => page(allCount), clip }, 999, 10, { loggedIn })
  return { name, loggedIn: r.loggedIn, total: r.total, shown: r.shown, truncated: r.truncated, note: r.note }
}

const cases = [
  await run('anonTruncated', false, 100),
  await run('anonComplete', false, 2),
  await run('loggedTruncated', true, 100),
  await run('loggedComplete', true, 2),
]
process.stdout.write(JSON.stringify({ cases }))
