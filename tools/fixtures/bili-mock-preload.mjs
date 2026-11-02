/**
 * 命令级真跑的接缝：把发往 B 站的 fetch 整体改写到本地 mock server。
 *
 * 用 `node --import <这个文件的 file:// URL> tools/look.mjs ...` 预载，它在本进程里
 * 包一层 globalThis.fetch —— look.mjs / lib/bili-api.mjs / lib/cred.mjs 用的都是全局 fetch，
 * 所以这一层对它们透明，**生产代码不需要任何开关或注入点**。
 *
 * 为什么不在源码里加 `BILI_WATCH_API_ROOT`：那等于为了好测而改生产行为（多一个用户可配的地址，
 * 就多一种「缓存/风控判断对不上」的现场），而且一旦那个变量泄漏进用户环境，就会真的把请求
 * 打到别处。测试的接缝留在测试侧，生产侧不动。
 *
 * 只改写四个已知域名：api / passport / comment（弹幕）/ i0.hdslb.com（图床）。
 * 其它地址原样放行——这样断言看到的是「命令本来会发的那些请求」，不是被拦死的。
 */
const PORT = process.env.BW_MOCK_PORT || ''
const HOSTS = new Set(['api.bilibili.com', 'passport.bilibili.com', 'comment.bilibili.com', 'i0.hdslb.com'])
const realFetch = globalThis.fetch

globalThis.fetch = function mockFetch(input, init) {
  if (!PORT) return realFetch(input, init)
  try {
    const raw = typeof input === 'string' ? input : String(input?.url ?? input)
    const u = new URL(raw)
    if (HOSTS.has(u.hostname)) {
      // 把 host 拼成第一段路径：同一台 mock 才能按域名分路由（api 与 passport 的路径会撞）
      return realFetch(`http://127.0.0.1:${PORT}/${u.hostname}${u.pathname}${u.search}`, init)
    }
  } catch {
    /* 解析不了就原样放行 */
  }
  return realFetch(input, init)
}
