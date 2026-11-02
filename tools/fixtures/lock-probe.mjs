#!/usr/bin/env node
/**
 * tools/fixtures/lock-probe.mjs —— 异步抢锁真跑探针
 *
 * 为什么单独一个文件：makeLocks 的 tryLock 是 async（它要 sleep 重试），
 *   而 verify.mjs 的 check() 回调必须同步（C77：async 回调会被记成 PASS，断言体根本没跑）。
 *   所以异步那半截只能另起进程跑，父进程 spawnSync 读 JSON。
 *
 * 断三件事：
 *   ① 第一次 tryLock 拿到锁（f 与 owner 都在）
 *   ② 主人还活着时第二次 tryLock 返回 null（两个进程不能同时持锁）
 *   ③ unlock 之后能再抢到（锁没被 unlock 弄坏）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeLocks } from '../../lib/locks.mjs'

const out = {}
const tmp = mkdtempSync(join(tmpdir(), 'bw-lock-'))
try {
  const dir = join(tmp, 'd')
  mkdirSync(dir, { recursive: true })
  const locks = makeLocks({ ttlMs: () => 60000 })

  const l1 = await locks.tryLock(dir)
  out.gotLock = Boolean(l1 && l1.f && l1.owner)
  out.fExists = l1?.f ? (await import('node:fs')).existsSync(l1.f) : false

  const l2 = await locks.tryLock(dir)
  out.secondIsNull = l2 === null

  // 主人还活着时，抢不到锁**不许**把主人的锁删掉
  out.lockStillThere = l1?.f ? (await import('node:fs')).existsSync(l1.f) : false

  locks.unlock(l1)
  out.afterUnlockGone = l1?.f ? !(await import('node:fs')).existsSync(l1.f) : false

  const l3 = await locks.tryLock(dir)
  out.reLock = Boolean(l3 && l3.f)
  locks.unlock(l3)

  // 主人已死的锁可接管
  const dead = join(dir, '.lock')
  writeFileSync(dead, JSON.stringify({ pid: 2147483646, at: Date.now(), ttlMs: 60000, owner: 'ghost' }), 'utf8')
  const l4 = await locks.tryLock(dir)
  out.takeOver = Boolean(l4 && l4.f === dead)
  locks.unlock(l4)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

process.stdout.write(JSON.stringify(out))
