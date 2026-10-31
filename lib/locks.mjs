/**
 * lib/locks.mjs —— 「这个缓存目录现在有没有人在写」
 *
 * 为什么单独一个模块（2026-10-31 切片 2）：
 *   这 5 个函数在 index.js（DSH 进程内，面板的自动清理）与 tools/look.mjs（CLI 子进程，clean）
 *   里各有一份**逐字相同**的实现。两份的成本不是「多 70 行」，而是「改一处要记得改两处」——
 *   漏了就会出现「面板认为没人在写、CLI 认为有人」：一边照清，另一边拒绝清，或者反过来
 *   锁文件成了永不消失的堵点（2026-10-28 就踩过：残留 .lock 让 clean 永久拒绝）。
 *
 * 关于 ttlMs 为什么是**参数**而不是模块内的 lockTtlMs()：
 *   lockExpired 原本写 `owner.ttlMs || lockTtlMs()`，而 lockTtlMs 读的是磁盘配置
 *   （index.js 走 readTuning()、tools/look.mjs 走 tuning()，连名字都不同）。
 *   把它一起搬进来等于把「配置」偷渡进「锁判据」：模块加载顺序、配置读取时机都会影响判锁结果。
 *   所以 TTL 由调用方算好传进来——本模块只关心「给定 ttl，这把锁过期了没有」。
 *   lockTtlMs 的归口是切片 3 的 tuning 模块（config/tuning）；统一之后它可以再收回来。
 *
 * 依赖：`CACHE_MARK` 一个只读常量（lib/consts.mjs）+ node:fs / node:path。
 *   不读任何可变状态，所以两个进程各加载一份也不会算出不同结果。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CACHE_MARK } from './consts.mjs'

/**
 * pid 还活着吗。
 *
 * 用 `process.kill(pid, 0)` 只探不杀：进程在 → 正常返回；进程不在 → 抛 ESRCH。
 * Windows 上跨用户/提权进程会抛 EPERM —— 那也是「活着」，只是无权发信号，所以 EPERM 算活。
 * 非法 pid（0 / 负数 / 非整数）直接 false：`kill(-1, 0)` 在 POSIX 上是「向所有进程发信号」的语义，
 * 放过去会把「参数写错」读成「有人在写」。
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * 读锁文件。读不出来 / 不是合法 JSON / 没有正整数的 pid → null（当作没有锁）。
 *
 * 不校验 owner/at：那是 lockExpired 的事，两件事分开才好各自测边界。
 */
export function readLock(f) {
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (Number.isInteger(j?.pid) && j.pid > 0) return j
  } catch {}
  return null
}

/**
 * 锁过期了吗。`ttlMs` 由调用方给（见文件头）。
 *
 * 先看锁自己带的 `owner.ttlMs`：抢锁时写进去的那份是「当时的配置」，
 * 用户中途改了设置不该让在跑的转写突然变成「锁已过期、可以抢」。
 * 没有 ttlMs 的老锁文件才回落到调用方给的当前值。
 * `owner` 为空一律算过期（没有持有者就不存在占用）。
 */
export function lockExpired(owner, ttlMs) {
  if (!owner) return true
  return Date.now() - (owner.at || 0) > (owner.ttlMs || ttlMs)
}

/**
 * 整棵缓存树里有没有「活着的锁」。深度 ≤3，与实际目录结构对齐
 * （`frames/<BV>-p1-2s/.lock`、`sheet-tmp/.xxx.lock`、`asr/.BV-p1.lock` 都在三层内）。
 *
 * 只认文件名以 `.lock` 结尾；残留锁（持有者已死或已过期）**不算占用**——
 * 真清的时候由 tryLock / unlockStale 负责删，这里判成占用只会让缓存永远清不掉。
 */
export function hasAnyLock(root, ttlMs) {
  const walk = (d, depth) => {
    if (depth > 3) return false
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return false }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.lock')) {
        const owner = readLock(join(d, e.name))
        if (owner && pidAlive(owner.pid) && !lockExpired(owner, ttlMs)) return true
        continue // 残留锁不算占用（真清的时候由 tryLock / unlockStale 负责删）
      }
      if (e.isDirectory() && walk(join(d, e.name), depth + 1)) return true
    }
    return false
  }
  return walk(root, 0)
}

/**
 * 抢锁 / 放锁（2026-10-31 切片 10 从 tools/look.mjs 搬来，逐字保留判断）。
 *
 * 为什么是工厂而不是五个顶层函数：
 *   抢锁要往锁体里写「这一把的 TTL」，而 TTL 读自配置（tuning()，面板与 CLI 读法不同）。
 *   做成顶层函数就得再偷渡一次配置——切片 2 刚把那条清掉（见文件头）。所以 TTL 由调用方
 *   给一个**取值函数**：每次抢锁时求值，面板改完下一把立刻生效。
 *   sleep 同理（CLI 有 jitter/sleep 工具，面板里不一定有），不给就用默认。
 *
 * 返回：newLockBody / tryLockSync / tryLock / unlock。
 *   unlockStale 不导出——它只服务 tryLock 的「清残留」这一步，导出去会让人以为
 *   「抢不到锁时可以自己清一把」（A-1 那条双持就是这么来的）。
 */
export function makeLocks({ ttlMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const ttl = () => (typeof ttlMs === 'function' ? ttlMs() : ttlMs)

  // X-13：每次抢锁生成新的 owner，写进锁文件；返回给调用方用于解锁时自证身份
  function newLockBody() {
    const body = { pid: process.pid, at: Date.now(), ttlMs: ttl(), owner: randomBytes(8).toString('hex') }
    return { text: JSON.stringify(body), owner: body.owner }
  }

  // A-1（2026-10-28 阶段A）：清理残留锁必须「只删自己刚判定为残留的那一份」。
  //   原写法在 catch 里无条件 unlock(f)：A 判残留→unlock→写新锁，与 B 判残留→unlock 交错时，
  //   B 的 unlink 会把 A 刚写的新锁删掉，随后 B 的 write(wx) 也成功 → 双持（150 轮实测 101 轮）。
  //   判据：删前重读当前锁；若 pid/at 已不是 stale（被别人换人/换时间）就不动。
  //   stale 为 null（坏 JSON 或文件读不到）时按「坏锁该清」处理，但文件已不存在则不动。
  function unlockStale(f, stale) {
    try {
      if (!existsSync(f)) return
      const cur = readLock(f)
      if (cur && stale && (cur.pid !== stale.pid || cur.at !== stale.at || (cur.owner && stale.owner && cur.owner !== stale.owner))) return
      unlinkSync(f)
    } catch {}
  }

  function tryLockSync(dir, name = '.lock') {
    const f = join(dir, name)
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const mine = newLockBody()
    for (let i = 0; i < 2; i++) {
      try {
        writeFileSync(f, mine.text, { flag: 'wx' })
        return { f, owner: mine.owner }
      } catch {
        const owner = readLock(f)
        if (owner && pidAlive(owner.pid) && !lockExpired(owner, ttl())) return null
        unlockStale(f, owner) // A-1：只删判定为残留的那份，别删别人刚写的新锁
      }
    }
    return null
  }

  async function tryLock(dir, name = '.lock') {
    const f = join(dir, name)
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const mine = newLockBody()
    // 首抢 1 次，失败且主人活着时最多再等 3 次（间隔 500ms），仍拿不到就放弃由调用方报「另一个进程正在处理」
    for (let i = 0; i < 4; i++) {
      try {
        writeFileSync(f, mine.text, { flag: 'wx' })
        return { f, owner: mine.owner }
      } catch {
        const owner = readLock(f)
        if (owner && pidAlive(owner.pid) && !lockExpired(owner, ttl())) {
          if (i >= 3) return null
          await sleep(500)
          continue
        }
        unlockStale(f, owner) // A-1：同上，只删残留锁，不删别人刚写的新锁
      }
    }
    return null
  }

  // X-13（2026-10-29）：解锁必须校验 owner。原来是无条件 unlink——长任务超过 TTL 被判残留后，
  //   老主人（进程还活着，只是慢了）退出时会把**新主人**刚写的锁删掉，第三个进程随即也能挤进来。
  //   参数兼容字符串（老调用）与 {f, owner}（新调用）；拿不到 owner 时退化成「只删自己 pid 写的」。
  function unlock(lock) {
    try {
      const f = typeof lock === 'string' ? lock : lock?.f
      const mine = typeof lock === 'string' ? null : lock?.owner
      if (!f || !existsSync(f)) return
      const cur = readLock(f)
      if (mine && cur && cur.owner && cur.owner !== mine) return // 已经不是我的锁了，不动
      if (!mine && cur && cur.pid !== process.pid) return // 老式调用：至少别删别人进程的锁
      unlinkSync(f)
    } catch {}
  }

  return { newLockBody, tryLockSync, tryLock, unlock }
}

/**
 * 能不能把「用户指定的目录」直接当缓存根。
 *
 * 能认领的只有三种：不存在（我们会新建）/ 空的 / 已经带我们的标记。
 * 有内容又没有标记 = 用户自己的目录（素材库、下载目录），绝不认领 ——
 * 否则 pickCacheDir 这次就把标记写进去，紧接着 removeOwned 看到标记就开始按名字删，
 * 守卫等于空转（2026-10-29 实测：指向素材库跑 clean 会删掉 4 个用户文件）。
 */
export function isAdoptableDir(dir) {
  try {
    if (!existsSync(dir)) return true
    if (existsSync(join(dir, CACHE_MARK))) return true
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}
