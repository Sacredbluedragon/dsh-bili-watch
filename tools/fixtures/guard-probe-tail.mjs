// —— 探针尾巴（2026-11-02，护栏判据 C129 / C130）——
//
// 上面（拼进来的那一段）是从 tools/look.mjs **原样切出来**的常量与 scanInjection：
//   INVISIBLE_RES / SUSPECT_ALL / SUSPECT_HIGH / scanInjection / KIND_LABEL / labelOf / untrustedMeta
// 一个字都没改，所以这里跑的是真代码，不是复刻件。
//
// 尾巴只做「喂输入、吐结果」：不碰 fs、不碰网络、不碰 stderr。
//   判据要的就是 hits 数组；「警告有没有打」「标记有没有跟着数据走」那两件事
//   由 C127 / C128 用真命令 + 本地 mock 去验 —— 合成一条就成了「用 scanInjection 验 scanInjection」。
const CASES = JSON.parse(process.env.BW_GUARD_CASES || '[]')
const out = CASES.map((c) => ({
  name: c.name,
  long: scanInjection(c.text, { short: false }),
  short: scanInjection(c.text, { short: true }),
}))
process.stdout.write('\n__GUARD_JSON__' + JSON.stringify(out))
