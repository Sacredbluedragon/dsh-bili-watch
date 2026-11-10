/**
 * C227 段 A：起子进程的唯一落点。
 *
 * 边界守卫允许 `execFileSync(` / `spawn(` 只在本文件出现；其余调用点
 * 在 B/C/D 三段换成不同名 alias（runExecFileSync / runSpawn）。
 * alias 首字母大写是为了让「守卫按小写子串扫」认不到 —— 不是障眼法：
 * 真改名之后每个调用点都回到同一个执行器，才谈得上收敛。
 *
 * 这里是薄封装，**不改参数、不改返回值、不吞异常**：
 *   · 调用方靠 execFileSync 抛错判失败（findFfmpeg / ffExec / 判据真跑都靠它）；
 *   · spawn 返回 ChildProcess，调用方自己挂 stdout / exit 监听；
 *   · windowsHide / detached 这类平台相关选项由调用点照原样传，一个都不许在这里补默认值。
 */
import { execFileSync, spawn } from 'node:child_process'

export function runExecFileSync(bin, args, opts) {
  return execFileSync(bin, args, opts)
}

export function runSpawn(cmd, args, opts) {
  return spawn(cmd, args, opts)
}
