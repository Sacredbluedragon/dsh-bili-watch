// 0.4.9 C233：sheet 视觉 token 预算。
//
// 默认值**只**写在 lib/tuning.mjs 的 TUNING_DEFS.sheetTokenBudget.def，本文件不复制第二个常量。
// 不暴露 CLI flag：预算是用户侧的持续偏好，放 deps-config.json，跟其它 tuning 项同一处读。
// 超预算只给一行提示，不阻断、不改退出码、不改 dry-run 的「零抽帧/零下载/零落盘」承诺。
import { TUNING_DEFS } from './tuning.mjs'

/** 从 normalizeTuning() 的结果里取预算；没给 / 坏值回落到 TUNING_DEFS 的默认值。 */
export function tokenBudgetOf(t) {
  const def = TUNING_DEFS.sheetTokenBudget.def
  const n = Number(t?.sheetTokenBudget)
  return Number.isFinite(n) && n > 0 ? n : def
}

/** 超预算时返回一行提示文案（不含 ⚠，warn() 自带前缀）；没超返回空串。 */
export function budgetWarnLine(token, budget) {
  const t = Number(token)
  const b = Number(budget)
  if (!Number.isFinite(t) || !Number.isFinite(b) || b <= 0 || t <= b) return ''
  return `预计 token 约 ${Math.round(t)} 超过预算 ${Math.round(b)}（只提示，不阻断；可在 deps-config.json 调 sheetTokenBudget）`
}

/** 与 sheet --dry-run 第四行同一口径的估算行，供非干跑路径在拼图前先报一次。 */
export function tokenEstimateLine(token) {
  return `预计 token：约 ${Math.round(Number(token) || 0)}（按 1600x900 单图 700 token、成图面积折算估）`
}
