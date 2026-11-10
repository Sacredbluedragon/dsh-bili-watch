// 0.4.9 C231 / A3 默认输出目录（最小版）。
//
// 只做「配置项 + sheet/ocr/substrip 三条命令的默认目录 + --out 仍可覆盖」。
// 面板设置页保持原样。不动删除面、不动 lib/cache-own.mjs、不改 --out 黑名单。
//
// 兼容口径：**没配 defaultOut 时，返回的路径与改动前逐字节相同**。
// 所以既有判据（C219 索引 / C224 dry-run 三零 / C221 三处落盘）不会被这一项改动碰到。
//
// 优先级：CLI --out > 环境变量 BILI_WATCH_OUT > deps-config.json 的 defaultOut > 原 cacheDir()/sheets。
// 纯函数：不读盘、不建目录、不 import 任何状态模块；调用方负责 mkdir 与 checkOutDir 黑名单。
import { join, resolve } from 'node:path'

export const DEFAULT_OUT_KEY = 'defaultOut'

/** 返回配置里的默认输出目录（绝对路径），没配 / 空白 → 空串。 */
export function defaultOutValue(cfg = {}, env = process.env) {
  const raw = env?.BILI_WATCH_OUT ?? cfg?.[DEFAULT_OUT_KEY]
  return typeof raw === 'string' && raw.trim() ? resolve(raw.trim()) : ''
}

/**
 * 成图类产物（sheet / substrip 的 jpg）的完整落点。
 * @param {{cfg?:object, env?:object, cacheDir:string, filename:string, explicitOut?:string}} o
 * @returns {string} 绝对或相对路径；未配置且未传 --out 时 = join(cacheDir,'sheets',filename)
 */
export function pictureOutPath({ cfg = {}, env = process.env, cacheDir, filename, explicitOut = '' } = {}) {
  const explicit = typeof explicitOut === 'string' ? explicitOut.trim() : ''
  if (explicit) return resolve(explicit)
  const dir = defaultOutValue(cfg, env)
  return dir ? join(dir, filename) : join(cacheDir, 'sheets', filename)
}

/** 文本类产物（ocr 的识别结果）的落点；未配置且未传 --out 时返回空串，让 printText 走原路径。 */
export function textOutPath({ cfg = {}, env = process.env, filename, explicitOut = '' } = {}) {
  const explicit = typeof explicitOut === 'string' ? explicitOut.trim() : ''
  if (explicit) return resolve(explicit)
  const dir = defaultOutValue(cfg, env)
  return dir ? join(dir, filename) : ''
}
