// B4：text 默认路径命中磁盘缓存时的标注。
// 单独成模块是为了让 verify 能直接 import 真跑，不用把 cmdText 抠出来补环境
// （C195 就是给被测函数补假 fmtTime，把整块面板白屏放过去了）。
//
// 带 ⚠ 是硬要求：工具层只把含 ⚠ 的 stderr 行回灌给模型，不带 ⚠ 的进度行会被丢，
// 等于没说。json 出口本来就有 cached: true，这里只服务 text 路径，不许拿去改 json。
export function cacheNotice(cached) {
  return cached
    ? '⚠ 转写（缓存）：本次复用磁盘缓存，不是当次实时结果（要重转加 --fresh）'
    : ''
}
