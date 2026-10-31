// 进程级路由守卫（T41-P0-1）：fiber 重放 / 多实例下，同一路径只许注册一个 handler。
//
// 参照 dsh-memory-evolve/lib/route-guard.js（MIT）：claim 成功才 register；
// effect dispose 时 release，否则重放后新回调跳过注册、路由永久 404。
//
// 2026-10-31 切片 7：从 index.js 搬过来，原样不改。搬的理由是「可测」——
//   在 index.js 里它是私有函数，只能靠 apply() 黑盒间接验证（C72 做的就是这个）；
//   收进 lib 后它是导出函数，可以直接 import 断言「同路径第二次被拒 / 不同路径互不影响 /
//   release 之后能重新登记」，不需要为了测试往生产代码上开口子。
//
// 状态是进程级的：ESM 模块在一个进程里只有一份实例，与原来 index.js 里的模块级 Set 等价。
const CLAIMED = new Set()

/** 登记一条路由：首次返回 true，重复返回 false（调用方应跳过注册）。 */
export function claimRoute(path) {
  if (CLAIMED.has(path)) return false
  CLAIMED.add(path)
  return true
}

/** 释放登记（effect dispose 时调），释放后才能重新 claim。 */
export function releaseRoute(path) {
  CLAIMED.delete(path)
}

/** 只读观察：当前已登记的路径（断言与排查用，别拿它做控制流）。 */
export function claimedPaths() {
  return [...CLAIMED]
}
