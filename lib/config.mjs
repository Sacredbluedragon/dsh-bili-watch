/**
 * 「用户可手改的小 JSON」统一读法（deps-config.json / ui 配置 / 缓存策略三处共用）。
 *
 * 行为（X-16a 与 #17 两个 P1 的成果，原样保留）：
 *   - 文件不存在 → 默认值，不算异常（ENOENT 是「没配过」）；
 *   - 空文件/纯空白 → 默认值，也不算异常；
 *   - 读失败 → 默认值 + problem(kind:'read')；
 *   - 解析失败 → **先把坏文件改名留档**（`.broken-<ts>`），再回默认值 + problem(kind:'parse')。
 * 留档而不是拒绝写：拒绝写会让面板「保存」一直失败、用户也不知道该改哪个文件。
 *
 * 2026-10-31 切片 3-B：这段原来在 index.js（写模块级 cfgWarning）与 tools/look.mjs
 *   （直接打 stderr）各一份。行为一样，只有「怎么告诉用户」不同，所以拆开：
 *   **lib 只负责行为并返回结构化 problem，文案归调用方**——
 *   index 要进 /status 的中文 warnings，look 要打 ASCII 前缀的英文 stderr
 *   （PS 5.1 管道按当前代码页解码，中文会变成问号）。
 *
 * 顺带修掉的隐患：原来 cfgWarning 是「后写的覆盖先写的」单个字符串，两个坏文件同时存在时
 *   只会看到最后一条。现在每次读都返回自己的 problem，调用方攒成数组，一条都不会被吞。
 */
import { readFileSync, renameSync } from 'node:fs'

/**
 * @param {string} p 配置文件路径
 * @param {any} fallback 读不到 / 坏掉时返回的值
 * @returns {{ value: any, problem: null | { kind: 'read'|'parse', error: string, backup?: string, backupFailed?: string } }}
 */
export function readJsonOrBackup(p, fallback) {
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return { value: fallback, problem: null }
    return { value: fallback, problem: { kind: 'read', error: String(e?.message || e) } }
  }
  if (!raw.trim()) return { value: fallback, problem: null }
  try {
    return { value: JSON.parse(raw), problem: null }
  } catch (e) {
    const bak = `${p}.broken-${Date.now()}`
    try {
      renameSync(p, bak)
      return { value: fallback, problem: { kind: 'parse', error: String(e?.message || e), backup: bak } }
    } catch (e2) {
      return { value: fallback, problem: { kind: 'parse', error: String(e?.message || e), backupFailed: String(e2?.message || e2) } }
    }
  }
}
