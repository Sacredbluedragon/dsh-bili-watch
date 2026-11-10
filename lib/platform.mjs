/**
 * C227 段 A：平台判定的唯一落点。
 *
 * 边界守卫（scripts/check-boundaries.mjs）把 `process.platform` 列为禁词，
 * 只允许本文件与 lib/plugin-paths.mjs 出现。其余 46 处调用点会在 B/C/D 三段
 * 逐个换成这里导出的**不同名 alias** —— 不是重导出：守卫按子串扫源码，
 * `export { process as platform }` 之类的写法改完调用点照样含禁词，会红。
 *
 * 只求值、不缓存：同一个进程里平台不会变，但缓存会让「把平台桩掉」的判据
 * 从此测不到真值。返回值与 process.platform 逐字一致。
 */
export function hostPlatform() {
  return process.platform
}

/** 调用点里已有同名局部变量时，用 hostPlatform() === 'win32'，别让 import 被遮蔽。 */
export function isWin() {
  return hostPlatform() === 'win32'
}

export function isMac() {
  return hostPlatform() === 'darwin'
}
