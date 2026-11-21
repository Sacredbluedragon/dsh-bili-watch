/**
 * lib/deps-lock.mjs —— deps 跨进程锁的三态判据，宿主面板 / 后台迁移 / doctor 共用一份
 *
 * 2026-11-21（0.4.15 件一）：这份判据原来只写在 index.js，lib/doctor.mjs 的 deps 项
 * 另抄了一份「只看 6 小时时间窗、不探 pid 死活」的简化版——进程崩了锁没删、未到 6 小时，
 * doctor 仍报「有正在下载的活锁（不算故障）」。同一判据两个住处，两边口径已经分叉。
 * 本文件把宿主侧那份三态判据收为唯一住处，index.js 与 doctor.mjs 都从这里 import。
 *
 * 本体仍在 lib/locks.mjs 的 classifyLock（pid 探活 + TTL 过期在同一次调用里连续判完，
 * 不许拆）；这里只做锁体字段映射：deps 锁体 { pid, startedAt, target } → classifyLock
 * 认的 { pid, at, ttlMs }。
 *
 * 没有 startedAt 的老锁不能判过期（等于「不知道」，宁可误拒不可误放）——给它一个极大
 * ttlMs，pid 活着就仍是 live；这是原来 `!Number.isFinite(startedAt) || ...` 的保守语义，
 * 统一判据不能把这一侧削掉。锁体没有合法 pid（写了一半 / 损坏）归 corrupt，不拦用户。
 */
import { classifyLock } from './locks.mjs'
import { DEPS_LOCK_STALE_MS } from './plugin-paths.mjs'

/**
 * deps 跨进程锁的唯一判据（C48-P2-1）。
 *
 * @param {object|null} cur 锁体 { pid, startedAt, target }；读不出 JSON 由调用方传 null
 * @param {{now?: number}} [opts] now 可注入（doctor 的 ctx.now 同源）；不传按 Date.now()。
 *   classifyLock → lockExpired 本体写死 Date.now()（本体不许改），注入 now 时把 at
 *   平移同样的墙钟差值，过期比较仍在 lockExpired 内连续跑完，本函数不另写一套 TTL 算式；
 *   不传 now 时差值为 0，行为与原来逐字一致。
 * @returns {{state: 'live'|'stale'|'corrupt', why: 'live'|'dead-pid'|'expired'|'corrupt'}}
 *   调用方判占用一律只看 `.state === 'live'`；why 给残留 / 损坏的细分原因。
 */
export function depsLockVerdict(cur, { now } = {}) {
  if (!cur || !Number.isInteger(cur.pid) || cur.pid <= 0) return { state: 'corrupt', why: 'corrupt' }
  const hasAt = Number.isFinite(cur.startedAt) && cur.startedAt > 0
  const base = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const shiftedAt = (hasAt ? cur.startedAt : 0) + (Date.now() - base)
  return classifyLock({
    pid: cur.pid,
    at: shiftedAt,
    ttlMs: hasAt ? DEPS_LOCK_STALE_MS : Number.MAX_SAFE_INTEGER,
  }, DEPS_LOCK_STALE_MS)
}
