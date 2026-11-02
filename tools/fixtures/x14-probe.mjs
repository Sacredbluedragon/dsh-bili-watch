/**
 * X-14 锁续期的「真跑」探针（给 tools/verify.mjs 的 C119 用）。
 *
 * 用真的 `lib/locks.mjs` API，TTL 压到 300ms（比 5 分钟快），持锁 1200ms，
 * 600ms 时（已超 TTL 两倍）起子进程抢锁。四种模式：
 *
 *   hold   不续期（旧行为）→ 子进程**必须抢到**（钉住「缺陷真的存在」）
 *   renew  每 100ms 续期    → 子进程**必须抢不到**
 *   exit   抢锁 + 续期 + 立刻结束 → 进程必须自己退出（钉住 `setInterval` 忘了 `unref`）
 *   lost   续期中把锁换人   → `onLost` 必须被调用
 *
 * 一律只吐一行 JSON、永远 exit 0（判定在 verify 里做，探针只负责把事实量出来）。
 *
 * 注意：父进程用**异步 spawn** 起子进程，不能用 `spawnSync` —— 它会冻住事件循环，
 * 续期定时器跟着停摆，renew 那组会假红。这跟「mock server 必须跑在 worker 线程」同一个坑。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeLocks, readLock } from '../../lib/locks.mjs'

const SELF = fileURLToPath(import.meta.url)
const TTL = 300
const GRAB_AT = 600
const EVERY = 100

const mode = process.argv[2] || 'hold'
const done = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0) }

/** 子进程：只管抢一次锁，把结果说出来。 */
function asChild(dir) {
  const { tryLockSync } = makeLocks({ ttlMs: TTL })
  const got = tryLockSync(dir, '.lock')
  process.stdout.write(got ? 'GOT' : 'NOPE')
  process.exit(0)
}

if (mode === 'try') asChild(process.argv[3]) // 子进程分支：抢完就退，不走下面父进程那套

/** 异步起子进程抢锁 → resolve 'GOT' | 'NOPE' | 'ERR:…' */
function grab(dir) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SELF, 'try', dir], { windowsHide: true })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.on('error', (e) => resolve('ERR:' + String(e?.message || e)))
    c.on('close', () => resolve(out.trim() || 'ERR:no-output'))
  })
}

const dir = mkdtempSync(join(tmpdir(), 'bw-x14-'))
const { tryLockSync, heartbeat, unlock } = makeLocks({ ttlMs: TTL })
const lock = tryLockSync(dir, '.lock')
if (!lock) {
  rmSync(dir, { recursive: true, force: true })
  done({ ok: false, why: '探针自己没抢到锁（空目录不可能有锁）' })
}

if (mode === 'exit') {
  // 这条不发子进程：只验「续期中的进程能不能自己退出」。
  // **故意不调 process.exit、也不注册兜底定时器** —— 那两个都会把进程强行结束/拖住，
  // 于是 unref 有没有都「能退出」，判据就白写了。
  // **也故意不解锁**：第一版我在这里 unlock 了，结果下一次 beat 发现锁没了就 stop()，
  // 进程照样自己退出 —— 那验的是「丢锁会停表」，跟 unref 一点关系都没有。
  // 现在锁一直持着、定时器一直该跑：只有 unref 能让进程撒手。
  const hb = heartbeat(lock, { everyMs: EVERY, onLost: () => {} })
  process.stdout.write(JSON.stringify({ ok: true, mode, period: hb.period }))
} else if (mode === 'lost') {
  // 模拟「被别人抢走」：直接把锁文件换成一个别人的 owner
  let lostWhy = null
  const hb = heartbeat(lock, { everyMs: EVERY, onLost: (e) => { lostWhy = e.why } })
  writeFileSync(lock.f, JSON.stringify({ pid: process.pid, at: Date.now(), ttlMs: TTL, owner: 'someone-else' }), 'utf8')
  setTimeout(() => {
    hb.stop()
    rmSync(dir, { recursive: true, force: true })
    done({ ok: lostWhy === 'taken', mode, lostWhy, period: hb.period })
  }, EVERY * 3)
  setTimeout(() => done({ ok: false, why: 'lost 模式超时' }), 15000)
} else {
  // hold / renew：持锁到 GRAB_AT，起子进程抢一次，然后收尾
  const hb = mode === 'renew' ? heartbeat(lock, { everyMs: EVERY, onLost: () => {} }) : null
  setTimeout(() => {
    grab(dir).then((got) => {
      const cur = readLock(lock.f)
      const mineBefore = cur ? (cur.owner === lock.owner ? 'mine' : 'other') : 'gone'
      if (hb) hb.stop()
      unlock(lock)
      rmSync(dir, { recursive: true, force: true })
      done({ ok: true, mode, child: got, lockBeforeRelease: mineBefore })
    })
  }, GRAB_AT)
  setTimeout(() => done({ ok: false, why: '探针自身超时' }), 15000)
}
