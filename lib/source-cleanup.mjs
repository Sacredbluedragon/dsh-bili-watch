/**
 * 通用 URL 下载的产物目录：谁写谁删。
 *
 * frames-dl / audio-dl 里的原视频与音轨动辄几十上百 MB，用完留在缓存根里，
 * 常规 clean 又因为内部文件名认不出归属清不掉。这里在**下载的那一刻**登记目录，
 * 正常收尾主动清，进程退出 / 中断由钩子兜底 —— 抛错与 process.exit 都绕不过去。
 *
 * 只有显式 --keep-source 才留。钩子只在 CLI 启动时装一次；判据注入假 process 验五种形态。
 */
import { rmSync } from 'node:fs'

const pending = new Set()
let keepSource = false
const installedProcs = new WeakSet()

export function setKeepSource(v) { keepSource = !!v }
export function pendingCount() { return pending.size }

export function trackSource(dir) {
  if (!dir) return dir
  if (!keepSource) pending.add(dir)
  return dir
}

function drop(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  pending.delete(dir)
}

/** 正常收尾：只删本次登记的那一个目录，不动兄弟目录（并发任务各写各的）。 */
export function releaseSource(dir) {
  if (keepSource) { pending.delete(dir); return }
  drop(dir)
}

/** 退出 / 中断兜底：抛错、process.exit(1)、SIGINT、SIGTERM 都会走到。 */
export function cleanupAllSources() {
  for (const dir of [...pending]) drop(dir)
  pending.clear()
}

export function installSourceCleanup(proc = process) {
  // 按 proc 去重：同一进程只装一次，但判据可以注入多个假 process 分别验钩子。
  if (installedProcs.has(proc)) return
  installedProcs.add(proc)
  proc.once('exit', cleanupAllSources)
  proc.once('SIGINT', () => { cleanupAllSources(); proc.exit(130) })
  proc.once('SIGTERM', () => { cleanupAllSources(); proc.exit(143) })
}
