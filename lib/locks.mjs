/**
 * lib/locks.mjs —— 「这个缓存目录现在有没有人在写」
 *
 * 为什么单独一个模块（2026-10-31）：
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
 *   lockTtlMs 的归口是 tuning 模块（config/tuning）；统一之后它可以再收回来。
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
 * 「这把锁活不活」的唯一判据（0.4.8 C1）。
 *
 * 原来这条三合一表达式在 hasAnyLock / tryLockSync / tryLock 各写一遍。三态化只改其中一份，
 * 就会出现「面板判活、CLI 判死」——这个文件开头要解决的就是那件事。所以抽出来四处共用
 * （含新增的 lockState）。
 *
 * **本体不拆**：`owner && pidAlive(...) && !lockExpired(...)` 必须在同一次调用里连续判完。
 * 拆成「先判 pid、过一会儿再判 TTL」会在续期窗口里把活锁判成残留（X-13 / X-14 踩过双持）。
 *
 * 返回 `{ state, why }`：state 是三态（live / stale / corrupt），why 给 lockState 的 staleLocks
 * 清单细分原因（dead-pid / expired / corrupt）。调用方判占用一律只看 `.state === 'live'`。
 */
export function classifyLock(owner, ttlMs) {
  if (owner && pidAlive(owner.pid) && !lockExpired(owner, ttlMs)) return { state: 'live', why: 'live' }
  if (!owner) return { state: 'corrupt', why: 'corrupt' }
  if (!pidAlive(owner.pid)) return { state: 'stale', why: 'dead-pid' }
  return { state: 'stale', why: 'expired' }
}

/**
 * 整棵缓存树里有没有「活着的锁」。深度 ≤3，与实际目录结构对齐
 * （`frames/<BV>-p1-2s/.lock`、`sheet-tmp/.xxx.lock`、`asr/.BV-p1.lock` 都在三层内）。
 *
 * 只认文件名以 `.lock` 结尾；残留锁（持有者已死或已过期）**不算占用**——
 * 真清的时候由 tryLock / unlockStale 负责删，这里判成占用只会让缓存永远清不掉。
 */
/**
 * 缓存根的锁三态（0.4.8 C1）。
 *
 * 取代原来「hasAnyLock 读不出来就 catch → return false」的形态：读不出来不是「没有锁」，
 * 是「不知道」。把不知道压成没有，清理就会在一个 EPERM 目录旁边照删 —— 这正是本次要拆的形态。
 *
 * - `free`：整棵树（深度 ≤3）都读成功、没有活锁。残留锁不阻断，进 staleLocks。
 * - `locked`：命中活锁（classifyLock().state === 'live'），带 lockPath 与锁体 owner 原样。
 * - `unknown`：任意一次 readdir 抛异常。`err.code` 与出问题的绝对路径原样透传，**不建码表**
 *   （本机可用 icacls /deny 真造出 EPERM；EACCES 只能靠注入覆盖，两种来源要能分别验）。
 *
 * 三种 state 的返回值都带 `live` 字段（活锁对象 `{lockPath, owner}` 或 null）：unknown 只是
 *   「读不全」，不抹掉已经扫到的活锁。判「能不能清」的调用方必须同时看 state 与 live。
 *
 * `depth > 3` 不再下钻，记 `truncated` + 被跳过的目录数 `truncatedDirs`，**不判 unknown**：
 * 超深度是「树比预期深」，不是「读不出来」；而我们最深的产物是三层
 * （`frames/<BV>-pN-Ns/.lock`），第 4 层按 isOwnedEntry 本来就过不了归属判据、根本不会被删。
 * 归 unknown 会让用户自建一层深目录就把自动清理永久堵死，且 reason 用户没法解。
 *
 * 优先级：unknown > locked > free（读不全时先保守）。
 * `readdir` 可注入，判据不依赖 OS 权限就能真跑三态；真权限那一路另由 C174 单独钉。
 */
export function lockState(root, ttlMs, { readdir = readdirSync } = {}) {
  const staleLocks = []
  let truncatedDirs = 0
  let unknown = null
  let live = null

  const walk = (d, depth) => {
    if (depth > 3) { truncatedDirs += 1; return }
    let ents
    try {
      ents = readdir(d, { withFileTypes: true })
    } catch (e) {
      if (!unknown) {
        unknown = {
          reason: `${String(e?.code || 'UNKNOWN')} at ${d}`,
          code: String(e?.code || 'UNKNOWN'),
          path: d,
        }
      }
      return
    }
    for (const e of ents || []) {
      if (e.isFile() && e.name.endsWith('.lock')) {
        const f = join(d, e.name)
        const owner = readLock(f)
        const c = classifyLock(owner, ttlMs)
        if (c.state === 'live') {
          if (!live) live = { lockPath: f, owner }
        } else {
          staleLocks.push({ lockPath: f, why: c.why })
        }
      } else if (e.isDirectory()) {
        walk(join(d, e.name), depth + 1)
      }
    }
  }
  walk(root, 0)

  // live 是「有人在用」的确定事实，unknown 是「有目录读不全」的不确定信息，两者可以同时
  //   成立（一个子目录扫到活锁、另一个 readdir 抛 EACCES）。旧写法在 unknown 分支直接返回，
  //   把已扫到的活锁丢掉，于是调用方的强制清理能把「有人正在写」一起绕过。所以 live 永远
  //   作为字段带回（活锁对象或 null）；state 优先级仍是 unknown > locked > free，不变。
  const tail = { staleLocks, truncated: truncatedDirs > 0, truncatedDirs, live }
  if (unknown) return { state: 'unknown', ...unknown, ...tail }
  if (live) return { state: 'locked', ...live, ...tail }
  return { state: 'free', ...tail }
}

/**
 * 布尔兼容入口：只给「不需要区分为什么不能清」的老调用方与 C6 真跑判据用。
 * 语义是 fail-closed —— unknown 也算「不能清」。需要 reason / forceUnknown 的入口
 * 一律直接调 lockState，别拿这个布尔再猜一次。
 */
export function hasAnyLock(root, ttlMs) {
  return lockState(root, ttlMs).state !== 'free'
}

/**
 * 抢锁 / 放锁（2026-10-31 从 tools/look.mjs 搬来，逐字保留判断）。
 *
 * 为什么是工厂而不是五个顶层函数：
 *   抢锁要往锁体里写「这一把的 TTL」，而 TTL 读自配置（tuning()，面板与 CLI 读法不同）。
 *   做成顶层函数就得再偷渡一次配置——上一轮刚把那条清掉（见文件头）。所以 TTL 由调用方
 *   给一个**取值函数**：每次抢锁时求值，面板改完下一把立刻生效。
 *   sleep 同理（CLI 有 jitter/sleep 工具，面板里不一定有），不给就用默认。
 *
 * 返回：newLockBody / tryLockSync / tryLock / unlock / heartbeat。
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
  //   B 的 unlink 会把 A 刚写的新锁删掉，随后 B 的 write(wx) 也成功 → 双持（150 轮中 101 轮）。
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
        if (classifyLock(owner, ttl()).state === 'live') return null
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
        if (classifyLock(owner, ttl()).state === 'live') {
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

  // X-14 第一步（2026-11-01）：续期。
  //   为什么需要它：`lockTtlMsOf` 覆盖的是**一次转写**（asrTimeoutSec），但持锁段比它长——
  //   中间还有「下载 DASH 音轨 + ffmpeg 转 wav」，时长随视频大小增长，而余量只有固定的 +120 秒。
  //   面板把「锁过期时长」拉到 5 分钟时，余量就退到 120s，几百 MB 的音频超 2 分钟是常事 →
  //   锁被判过期 → 别的进程抢进来 → 两个进程同时写同一个 `cacheTxt + '.tmp'`（**这个 tmp 名不带
  //   pid**），内容交错，转写结果损坏。详见锁续期设计与
  //   `tools/fixtures/x14-probe.mjs`。
  //
  //   刷的是锁体里的 `at`，不是文件 mtime：`lockExpired` 读的就是 `at`，改 mtime 它看不见。
  //
  //   **必须 `unref()`**：不 unref 的 `setInterval` 会让 CLI 跑完任务还挂着不退出——
  //   这是本方案最容易踩的坑，`C119` 第三条专门钉它。
  //
  //   丢锁不许静默：锁没了 / 换人了 / 写不进去，一律停表并回调 `onLost`。不给默认行为，
  //   逼调用方显式表态（继续写就是两个进程写同一份数据）。
  function heartbeat(lock, { everyMs, onLost } = {}) {
    const f = typeof lock === 'string' ? lock : lock?.f
    const mine = typeof lock === 'string' ? null : lock?.owner
    if (!f || !mine) {
      throw new Error('heartbeat 只接受 {f, owner} 形态的锁：拿不到 owner 就没法校验「这锁还是不是我的」')
    }
    // 缺省按 TTL/3 刷（TTL 是抢锁时写进锁体的那一份，见 lockExpired 的注释）；
    // 下限 50ms 只是防呆，别让人用 everyMs:1 把 CPU 打满。
    const fallback = Math.max(60000, Number(ttl()) || 0) / 3
    const period = Math.max(50, Math.floor(Number(everyMs) || fallback))

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    }
    const beat = () => {
      if (stopped) return
      const cur = readLock(f)
      if (!cur) {
        stop()
        if (typeof onLost === 'function') {
          onLost({ why: existsSync(f) ? 'corrupt' : 'gone', file: f })
        }
        return
      }
      // 有 owner 就比 owner（X-13 之后写的锁都有）；老锁文件没有 owner，退化成比 pid
      const stillMine = cur.owner ? cur.owner === mine : cur.pid === process.pid
      if (!stillMine) {
        stop()
        if (typeof onLost === 'function') onLost({ why: 'taken', file: f, owner: cur.owner, pid: cur.pid })
        return
      }
      try {
        // 直写而不是 tmp+rename：锁体只有一行 JSON、同进程内串行；且 readLock 对坏 JSON
        // 返回 null（当成没锁），真正危险的是「先删再写」，那会开一个别人可抢的窗口。
        writeFileSync(f, JSON.stringify({ ...cur, at: Date.now() }), 'utf8')
      } catch (e) {
        // 写不进去 = 续期没成，不能装作续上了（那等于让调用方以为锁还在）
        stop()
        if (typeof onLost === 'function') onLost({ why: 'write-failed', file: f, error: String(e?.message || e) })
      }
    }

    const timer = setInterval(beat, period)
    // 这一行是判据 C119 第三条的对象：删掉它，`node look.mjs text …` 跑完就不会退出
    if (typeof timer.unref === 'function') timer.unref()
    return { stop, period, file: f }
  }

  return { newLockBody, tryLockSync, tryLock, unlock, heartbeat }
}

/**
 * 能不能把「用户指定的目录」直接当缓存根。
 *
 * 能认领的只有三种：不存在（我们会新建）/ 空的 / 已经带我们的标记。
 * 有内容又没有标记 = 用户自己的目录（素材库、下载目录），绝不认领 ——
 * 否则 pickCacheDir 这次就把标记写进去，紧接着 removeOwned 看到标记就开始按名字删，
 * 守卫等于空转（指向素材库跑 clean 会删掉 4 个用户文件）。
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
