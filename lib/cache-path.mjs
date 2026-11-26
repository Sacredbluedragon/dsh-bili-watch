// 缓存根：路径推导、认领判定、可写探测、旧目录下沉、按视频分目录。
//
// 2026-10-31：这里搬的不是函数，是**状态与初始化时序**——`CACHE` 这个可变模块值、
//   `ensureCache()` 这个「一次进程只做一次」的初始化、以及「谁在什么时候调它」。
//   前三次搬纯函数时可以靠 `compile()` 抽出来跑，等价于真跑；这一片不行，所以判据也不同：
//   见 tools/verify.mjs 的 C64（真起两个进程比对实际路径）/ C65（未初始化必抛）。
//
// 形状（与前两次同一套路：lib 管行为，入口只喂配置）：
//   initCachePath(want)  幂等初始化：先迁移旧根、再建根探测，返回 { dir, fallback, first }
//   cacheDir()           唯一读入口，**没初始化就抛**——不给「看着能用」的默认值
//   previewCacheDir()    纯算不落盘，只给「初始化失败时打日志」用（那时还没定论）
//   resolveCacheDir(want) / cacheAdoptNotice(want) / pickCacheDir(want) / migrateLegacyCache()
//                        拆开的四个动作，测试要单独压边界
//
// 为什么 cacheDir() 必须抛，而不是像原来那样 `let CACHE = resolveCacheDir()` 先给个纯路径：
//   那条「先给个值」的注释本意是防 undefined，实际效果是**把「没初始化」伪装成「初始化好了」**。
//   一旦有哪条命令路径忘了调，它会拿着一个「算出来但对不上」的路径一路写下去——
//   建出一棵干净的、没人会去清的缓存树。基线里 look.mjs 的 runsFile() 就是直接读 CACHE 的，
//   正是这种分叉：日志写到没探测过可写性的路径上。
//
// **两个入口的读法并不一样，这是有意的**（2026-11-01 第 11 条把这段写准，原来这里写的是
//   「现在两侧统一走 cacheDir()」，与代码不符）：
//   · tools/look.mjs：`runsFile()` 走 cacheDir() —— 进程活着就一条命令，没初始化就是真没初始化，
//     当场抛最省事。
//   · index.js：`runsFile()` 走本文件的 `ensureCache()`（= initCachePath(cacheWant).dir，幂等）——
//     面板是常驻进程，runLogRecord 可能在 apply() 之前的路径上被调到；就地初始化才不会把整条日志丢掉。
//     它不是「拿未初始化的纯路径」，而是「自己把它初始化好」，所以不属于上面那种伪装。
//   两边算出来的**根是同一个**（C64 真起两个进程比过），差异只在「谁负责初始化」。

import { appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { CACHE_MARK, OWN_CACHE_DIRS } from './consts.mjs'
import { isAdoptableDir } from './locks.mjs'
import { dirStat } from './cache-own.mjs'
import { bvOf, cleanKey } from './keys.mjs'

/** $DSH_HOME 的默认值。每次调用现算：两个入口原来一个在模块加载期取、一个在调用时取，
 *  统一到调用时取——模块加载期取的版本在「env 在 import 之后才设好」的场景里会拿到错值。 */
export function defaultHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 缓存下沉（2026-10-27）：默认根是 bili-watch/cache，凭证在它的上一层（bili-watch/credential.json）。 */
export function defaultCacheRoot() {
  return join(defaultHome(), 'bili-watch', 'cache')
}

/**
 * 新日志根：$DSH_HOME/bili-watch/logs/。
 * 与 defaultCacheRoot 同层同风格，复用 defaultHome()。
 *
 * 不受自定义缓存根影响：日志是插件级诊断数据，生命周期跟安装走、
 * 不跟用户数据缓存走。用户把 BILI_WATCH_CACHE 指到别的盘时，日志留在 $DSH_HOME 原处——
 * 排障找的是「插件日志」而不是「某个缓存目录的日志」；若跟着缓存根走，换根后旧日志会
 * 「消失」，且新根日志可能与清理面纠缠。计划表 :330 也定的 $DSH_HOME/bili-watch/logs/。
 */
export function defaultLogsRoot() {
  return join(defaultHome(), 'bili-watch', 'logs')
}

/**
 * 实际路径（非字符串）重叠校验：相等 / 嵌套 / 符号链接(junction)指向同一实体。
 * 存在的部分用 realpathSync.native 解析（junction 落到真身）；不存在的部分保留字面后缀，
 * 只有「realpath 父相同且后缀也相同」才算重叠。
 *
 * 为什么不能只退到存在父目录：首次升级时 cache 与 logs 两个目录都还不存在，
 * 一起退到共同父 bili-watch会被误判成「同一实际路径」，于是所有旧日志都被跳过不归档——
 * 恰好在最该归档的场景全军覆没。带上后缀后 bili-watch/cache 与 bili-watch/logs 分离。
 */
function realOf(p) {
  const abs = resolve(p)
  let cur = abs
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  let base
  try { base = realpathSync.native(cur) } catch { base = resolve(cur) }
  const suffix = abs === cur ? '' : abs.slice(cur.length).replace(/^[/\\]+/, '')
  return suffix ? join(base, suffix) : base
}
function isInside(child, parent) {
  const c = resolve(child), p = resolve(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}
export function checkLogsRootOverlap(cacheRoot, logsRoot = defaultLogsRoot()) {
  const rc = realOf(cacheRoot)
  const rl = realOf(logsRoot)
  if (rc === rl) return { overlap: true, reason: '日志目录与缓存目录指向同一个实际路径' }
  if (isInside(rl, rc)) return { overlap: true, reason: '日志目录位于缓存目录内部' }
  if (isInside(rc, rl)) return { overlap: true, reason: '缓存目录位于日志目录内部' }
  return { overlap: false, reason: '' }
}

/**
 * 归一「用户想用的缓存根」这个配置值。**只有字符串才算数**，其余一律当「没配」。
 *
 * 为什么不能用 `String(want)`：那会把非法配置变成合法路径字符串，于是
 *   mkdirSync 不再抛错 → pickCacheDir 的 catch 不触发 → 不回退默认根 →
 *   缓存根被建在进程 CWD 下（用户的视频缓存被写到别处，且无告警）。
 * 基线（两入口直接拿配置值当路径用）在这种场景下会抛 → 被 catch 捕获 → 回退默认根。
 * 归一后的语义 = 基线的回退语义。
 *
 * 2026-10-31 三审抓出并修。内部函数、不导出：
 * resolveCacheDir 与 cacheAdoptNotice 各用它一次，避免同一语义两处实现走偏。
 */
function normWant(want) {
  return typeof want === 'string' && want ? want : ''
}

/**
 * 纯算路径，不 mkdir、不写探针、不搬目录（D98：`--help` / 缺参这些路径不该留下任何痕迹）。
 * `want` 由调用方给：index.js 走 `depsCfg().cache`，look.mjs 走 `depsCfg.cache`——
 * 两个 accessor 名字不同，读到的都是同一份 deps-config.json，所以配置读取留在各自入口。
 */
export function resolveCacheDir(want) {
  // ⚠ 这里**不能**写成 `want ? String(want) : ''`。
  //   基线两入口都是 `process.env.BILI_WATCH_CACHE || depsCfg().cache` 直接拿配置值当路径用
  //   （`git show bc25a07:index.js` 第 546 行、look.mjs 第 211 行）。
  //   基线里配置值若不是字符串（deps-config.json 是用户可手改的明文 JSON），
  //   mkdirSync 会抛 ERR_INVALID_ARG_TYPE → 被 pickCacheDir 的 catch 捕获 → **回退默认根**，
  //   用户数据仍在 $DSH_HOME/bili-watch/cache。
  //   加上 String() 之后，123 变成 '123'、{} 变成 '[object Object]' —— 都是合法字符串，
  //   mkdirSync 不再抛 → 不回退 → **缓存根被建在进程当前工作目录下**，
  //   用户的视频缓存被写到别处，且没有任何告警（基线至少会打「已回退到…」）。
  //   2026-10-31 三审抓出并修：非字符串一律当「没配」，落回默认根，与基线回退语义一致。
  const userWant = normWant(want)
  let dir = userWant || defaultCacheRoot()
  // 用户指定了外部目录、且它还不是本工具的缓存根时，拼一个专属子目录——
  // 绝不把用户自己的目录直接当缓存根，否则 clean 会在用户目录里找 frames/asr 删。
  // 追加一配套（2026-10-29）：这里原来判「目录里有 BV* 子目录、且里面有 meta.json」就认领它，
  //   而素材库完全可能长这样。改成认「标记 / 空目录 / 不存在」，认不出来就退到它下面的专属子目录：
  //   既不认领、也不删用户的任何东西（直接认领会把素材库 4 个用户文件删掉）。
  if (userWant && !isAdoptableDir(dir)) dir = join(userWant, 'bili-watch-cache')
  return dir
}

/** 只给「初始化失败」那条日志用：那时还没有定论，不能调 cacheDir()（它会抛）。 */
export function previewCacheDir(want) {
  return resolveCacheDir(want)
}

/**
 * 追加四（2026-10-29，T35-EXT）：旧缓存提示——只说不做。
 * 用户把缓存指到外部目录、那目录里已经有东西、又不是我们的根时，resolveCacheDir 会退到它下面的
 * bili-watch-cache；旧目录原封不动留着，用户容易以为「清了就是清了」。这里只生成一句话，不清理。
 * 严格「只提示」：认领旧目录的开关（--adopt）还没做，所以提示里不提任何当前版本不存在的参数。
 *
 * 这里**不带节流**：index.js 的 /status 是 8 秒轮询，dirStat 会递归 walk 用户目录
 *   （2.8 万文件 664 ms），所以 10 分钟节流留在 index.js 侧（它与轮询周期有关，不是路径语义）。
 */
export function cacheAdoptNotice(want) {
  try {
    const userWant = normWant(want)
    if (!userWant) return null               // 默认根就是我们自己的，不提示
    if (!existsSync(userWant)) return null   // 不存在：resolveCacheDir 会直接用它
    if (isAdoptableDir(userWant)) return null // 空目录 / 已带标记：会被认领，不该提示
    const st = dirStat(userWant)              // 与面板「当前占用」「删除口径」同一个 lstat 实现
    if (!st.files) return null                // 有目录没文件：算空，不提示
    return { old: userWant, next: resolveCacheDir(userWant), files: st.files, mb: Math.round(st.bytes / 104857.6) / 10 }
  } catch {
    return null
  }
}

/**
 * 落盘 + 可写探测。**这是唯一会改盘的一步**（建根、写标记、写删探针），所以与 resolveCacheDir 分开。
 * 返回 { dir, fallback }：fallback 为 null 表示用的是算出来的根；否则表示回退到了默认根 + 原因。
 * 回退文案不在这里打——index.js 要进 /status.warnings，look.mjs 要打 stderr，两边口径不同。
 */
export function pickCacheDir(want) {
  const defaultDir = defaultCacheRoot()
  const dir = resolveCacheDir(want)
  try {
    mkdirSync(dir, { recursive: true })
    // 写缓存根标记（幂等；标记存在就不重写）
    const mark = join(dir, CACHE_MARK)
    if (!existsSync(mark)) {
      writeFileSync(mark, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }), 'utf8')
    }
    // P2-2（2026-10-28 全量检查）：必须真写一次探针文件。只 mkdir + 写标记时，标记已存在就连写都不写，
    //   于是只读目录 / 配额满 / 盘符掉线时「能建根、写不进」：两个入口算出同一个根，之后所有落盘
    //   都失败却一路报 ok。探针是这一步唯一能证明「这个根现在真的可写」的东西。
    const probe = join(dir, `.write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return { dir, fallback: null }
  } catch (e) {
    try { mkdirSync(defaultDir, { recursive: true }) } catch {}
    // P1-①（2026-10-29 全量审）：回退根必须也带标记。
    //   删除面第一行是 `if (!isOurCacheRoot(dir)) return`，回退根没标记 → 本次运行里 clean 与自动清理
    //   永远删不动、面板报「已清理 0 个文件」，而回退是每次重算的，不会自己恢复。
    try {
      const m = join(defaultDir, CACHE_MARK)
      if (!existsSync(m)) writeFileSync(m, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), fallback: true }), 'utf8')
    } catch {}
    return { dir: defaultDir, fallback: String(e?.message || e) }
  }
}

/**
 * 缓存下沉迁移：把旧根 bili-watch/ 下的 BV* 目录和缓存子目录挪到 bili-watch/cache/
 * 凭证、login-qr.png 等根级文件不动；只 rename，不删；幂等；不阻断启动。
 * C2（2026-10-27）：index.js 启动时做一次；CLI 直接跑时也要做一次，
 *   否则从命令行冷启动时旧根下的 BV* 不会被挪进 cache/。
 */
export function migrateLegacyCache() {
  const oldRoot = join(defaultHome(), 'bili-watch')
  const newRoot = join(oldRoot, 'cache')
  if (!existsSync(oldRoot)) return
  let moved = 0
  let skipped = 0
  const anomalies = []
  try {
    mkdirSync(newRoot, { recursive: true })
    let entries = []
    try { entries = readdirSync(oldRoot, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === 'cache') continue // 不挪 cache/ 自己
      // 只挪 BV* 目录和 OWN_CACHE_DIRS 里的项
      const isBv = /^BV[0-9A-Za-z]{10}/i.test(e.name)
      const isOwn = OWN_CACHE_DIRS.has(e.name)
      if (!isBv && !isOwn) { skipped++; continue }
      const src = join(oldRoot, e.name)
      const dst = join(newRoot, e.name)
      if (existsSync(dst)) { skipped++; continue } // 幂等：目标已存在就跳过，不覆盖
      try { renameSync(src, dst); moved++ } catch (e) { skipped++; anomalies.push(e.name || String(e)) }
    }
    // 止写：只记实际迁移(moved>0)或有行动价值的异常(anomalies)。
    // skipped 里全是例行保留项（deps/ 这类）时不写、不打——否则每次初始化都多行噪声，
    // 本机历史 migrate.log 1,746,363B / 15,733 行、去时间戳只剩 1 种句子就是这么来的。
    if (moved > 0 || anomalies.length > 0) {
      try {
        const logDir = defaultLogsRoot()
        mkdirSync(logDir, { recursive: true })
        appendFileSync(join(logDir, 'migrate.log'),
          `[${new Date().toISOString()}] [migrate] 已下沉 ${moved} 项到 cache/，跳过 ${skipped} 项（凭证与根级文件不动）${anomalies.length ? `，异常 ${anomalies.length} 项` : ''}\n`, 'utf8')
      } catch {}
      console.error(`[migrate] 已下沉 ${moved} 项到 cache/，跳过 ${skipped} 项（凭证与根级文件不动）${anomalies.length ? `，异常 ${anomalies.length} 项` : ''}`)
    }
  } catch {}
}


/**
 * 历史日志按原字节归档，源保留不动。
 *
 * 三来源：老迁移后仍存的顶层 bili-watch/_logs、默认 bili-watch/cache/_logs、
 * 当前生效自定义缓存根的 _logs。相同实际路径只处理一次（realpath 去重）。
 * 按来源建子目录，现场 B 那种同名不同内容能同时收进并分辨来自哪个根。
 * 无锁并发：临时名写盘 + rename，目标已存在则核 sha256——一致复用、不一致另存并报冲突。
 * 读源/校验/提交任一步出错，或复制期间源 size/mtime 变化，一律保留现场、不提交半份、允许重试。
 * 只复制不删源（自动升级保留源）；不阻断启动。
 */
/**
 * 原子发布 tmp 到 dst：只有 dst 不存在时才成功；dst 已存在返回 'exists' 且一个字节都不动它。
 * 硬链接优先（tmp 与 dst 同目录、天然同卷，linkSync 在目标存在时抛 EEXIST 且不覆盖）；
 * 非 NTFS / 跨卷 / 无权限时回退 openSync(dst,'wx') 原子创建——两条路径都是「目标已存在即失败」
 * 的原子语义，绝不静默降级成 rename 覆盖（rename 会在并发时吃掉先到者）。
 */
function exclusivePublish(tmp, dst, buf) {
  try {
    linkSync(tmp, dst)
    return 'created'
  } catch (er) {
    if (er?.code !== 'EEXIST' && !existsSync(dst)) {
      // 硬链接不可用：wx 原子创建后必须自己证明提交完整。
      // 宁可报「可重试失败 + 保留源 + 清掉半份」，也不留「报成功但盘上只有半份」。
      // 回退分支：短写/抛错/close 失败/回读不一致一律判失败，不静默当写完。
      let fd = null
      let mine = false
      try {
        fd = openSync(dst, 'wx')            // 目标已存在则 EEXIST，绝不碰别人的文件
        mine = true
        // length 是「要写多少」，返回值才是「实际写了多少」——短写必须判定失败。
        const wrote = writeSync(fd, buf, 0, buf.length)
        if (wrote !== buf.length) throw new Error(`writeSync 短写（${wrote}/${buf.length}），判定失败可重试`)
        closeSync(fd); fd = null
        // 逐字节核对：写完读回与源 buf 完全一致才算成功，否则清掉算失败。
        if (Buffer.compare(readFileSync(dst), buf) !== 0) throw new Error('归档写入回读逐字节核对不一致，判定失败可重试')
        return 'created'
      } catch (er2) {
        if (fd !== null) { try { closeSync(fd) } catch {} }   // 先关句柄再删（Windows 未关句柄 rmSync 会 EPERM）
        if (mine) { try { rmSync(dst, { force: true }) } catch {} }  // 清掉半份，源一个字节不动
        if (er2?.code === 'EEXIST') return 'exists'
        throw er2   // 作为可重试失败抛给 archiveOldLogs 记 errors，源完整保留
      }
    }
    return 'exists'
  }
}

let LAST_ARCHIVE = null
export function archiveStatus() { return LAST_ARCHIVE }

// 给状态页用的脱敏摘要：只给计数，不回传 errors/skipped 里可能带本机路径的 why。
//   ran=false 表示本进程还没跑过归档（例如宿主没走 initCachePath）；面板据此不谎称「已归档」。
export function archiveStatusSummary() {
  const r = LAST_ARCHIVE
  if (!r) return { ran: false, archived: 0, reused: 0, conflictCount: 0, skippedCount: 0, errorCount: 0 }
  return {
    ran: true,
    archived: Number(r.archived) || 0,
    reused: Number(r.reused) || 0,
    conflictCount: Array.isArray(r.conflicts) ? r.conflicts.length : 0,
    skippedCount: Array.isArray(r.skipped) ? r.skipped.length : 0,
    errorCount: Array.isArray(r.errors) ? r.errors.length : 0,
  }
}

export function archiveOldLogs(customCacheRoot = null, _opts = {}) {
  const home = defaultHome()
  const bili = join(home, 'bili-watch')
  const logsRoot = defaultLogsRoot()
  const archiveRoot = join(logsRoot, 'archive')
  const R = { sources: [], archived: 0, reused: 0, conflicts: [], errors: [], skipped: [] }
  LAST_ARCHIVE = R

  const raw = [
    { id: 'old-root', cacheRoot: join(bili, 'cache'), logsDir: join(bili, '_logs') },
    { id: 'default-cache', cacheRoot: join(bili, 'cache'), logsDir: join(bili, 'cache', '_logs') },
  ]
  if (typeof customCacheRoot === 'string' && customCacheRoot) {
    raw.push({ id: 'custom-cache', cacheRoot: customCacheRoot, logsDir: join(customCacheRoot, '_logs') })
  }
  const seen = new Set()
  const sha = (buf) => createHash('sha256').update(buf).digest('hex')

  for (const src0 of raw) {
    if (!existsSync(src0.logsDir)) continue
    let rp = resolve(src0.logsDir)
    try { rp = realpathSync.native(src0.logsDir) } catch {}
    if (seen.has(rp)) continue // 相同实际路径只处理一次
    seen.add(rp)
    const ov = checkLogsRootOverlap(src0.cacheRoot, logsRoot)
    if (ov.overlap) {
      R.skipped.push({ source: src0.id, why: ov.reason + '，保留现场未归档' })
      continue
    }
    R.sources.push(src0.id)
    let ents
    try { ents = readdirSync(src0.logsDir, { withFileTypes: true }) } catch (e) {
      R.errors.push({ source: src0.id, name: '(dir)', why: String(e?.message || e) })
      continue
    }
    const dstDir = join(archiveRoot, src0.id)
    try { mkdirSync(dstDir, { recursive: true }) } catch (e) {
      R.errors.push({ source: src0.id, name: '(mkdir)', why: String(e?.message || e) })
      continue
    }
    for (const e of ents) {
      // 只收普通文件（旧日志/轮转/历史副本）；子目录、符号链接、未知条目保留现场，不宣称已迁。
      if (!e.isFile()) {
        R.skipped.push({ source: src0.id, name: e.name, why: '非普通文件（目录/链接），保留现场' })
        continue
      }
      const src = join(src0.logsDir, e.name)
      let st0, buf
      try { st0 = lstatSync(src); buf = readFileSync(src) } catch (er) {
        R.errors.push({ source: src0.id, name: e.name, why: String(er?.message || er) })
        continue
      }
      const h = sha(buf)
      const tmp = join(dstDir, '.' + e.name + '.' + process.pid + '.' + Date.now() + '.tmp')
      try {
        writeFileSync(tmp, buf)
        const st1 = lstatSync(src)
        if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs) {
          R.errors.push({ source: src0.id, name: e.name, why: '复制期间源文件变化，放弃本次，可重试' })
          continue
        }
        // A 件：主档用原子创建。目标已存在（含并发刚写入的不同内容）绝不覆盖：
        //   同字节复用；不同字节另存到空位 .N，先到者的字节完整保留。
        let dst = join(dstDir, e.name)
        // 仅测试可见的最窄注入点：生产路径 _opts 恒为空对象，不执行。
        // 在 tmp 写完、st1 校验之后模拟「别的进程刚把 dst 写成不同内容」的并发窗口，
        // 用于把并发覆盖缺陷稳定打红/打绿，不靠 sleep，也不改对外生产语义。
        if (typeof _opts?.testHook === 'function') _opts.testHook({ dst, buf, h, dstDir, name: e.name })
        if (exclusivePublish(tmp, dst, buf) === 'created') {
          R.archived++
        } else {
          // 主档已存在：同字节直接复用（改冲突分流时别把这一步丢了，否则重复归档会白堆 .2）。
          let dh = ''
          try { dh = sha(readFileSync(dst)) } catch {}
          if (dh === h) { R.reused++; continue }
          // B 件：主档哈希不同时，先扫全部已有冲突副本 .2/.3/... —— 命中同哈希即复用
          //（重复调用不继续堆后缀）；只有走到空位才原子另存。后缀分配靠 exclusivePublish
          // 原子抢位，抢不到记 error 重试，不依赖「先读后写」的窗口。
          let n = 2
          let reusedCopy = false
          for (;;) {
            const cand = join(dstDir, e.name + '.' + n)
            if (!existsSync(cand)) { dst = cand; break }
            let ch = ''
            try { ch = sha(readFileSync(cand)) } catch {}
            if (ch === h) { R.reused++; reusedCopy = true; break }
            n++
          }
          if (!reusedCopy) {
            if (exclusivePublish(tmp, dst, buf) === 'created') {
              R.conflicts.push({ source: src0.id, name: e.name, keptAs: e.name + '.' + n })
              R.archived++
            } else {
              R.errors.push({ source: src0.id, name: e.name, why: '冲突副本位被并发占用，放弃本次，可重试' })
            }
          }
        }
      } catch (er) {
        R.errors.push({ source: src0.id, name: e.name, why: String(er?.message || er) })
      } finally {
        rmSync(tmp, { force: true }) // 任何分支都不留 .tmp 残骸
      }
    }
  }
  return R
}

// 未初始化是 null，不是「算出来的纯路径」——这个 null 就是 cacheDir() 抛错的依据。
let CACHE = null
let INIT = null

/**
 * 一次进程只做一次：先迁移旧根、再建根探测（顺序不能反——迁移的目标就是探测要建的那个根）。
 * 返回 { dir, fallback, first }：first 只在「这一次真的初始化了」时为 true，
 *   两侧据此决定要不要打回退告警（原实现靠各自的 CACHE_READY / 一次性的 pickCacheDir 副作用，
 *   现在这个「只报一次」的判据在 lib 里给出，省得两边各写一遍还写岔）。
 *
 * `want` 可以传值，也可以传**函数**：传函数时只在真要初始化那一次才求值。
 *   这一条是必须的——两个入口的 want 都要读 deps-config.json（每次读盘），
 *   而 ensureCache() 在 logRun → runsFile 里每写一条日志都会被调一次；
 *   参数在入口处就求值的话，等于把「已经初始化好了」这个早退路径的读盘开销又加回来。
 */
export function initCachePath(want) {
  if (INIT) return { ...INIT, first: false }
  const w = typeof want === 'function' ? want() : want
  migrateLegacyCache()
  const pick = pickCacheDir(w)
  // 老迁移先→建缓存根→再归档旧日志（按顺序）。归档不阻断启动。
  // 归档异常不让启动失败，但要把失败记进状态，不再静默吞掉——面板据此如实分档显示。
  try {
    archiveOldLogs(pick.dir)
  } catch (er) {
    const prev = LAST_ARCHIVE || { sources: [], archived: 0, reused: 0, conflicts: [], errors: [], skipped: [] }
    prev.errors.push({ source: '(init)', name: '', why: String(er?.message || er) })
    LAST_ARCHIVE = prev
  }
  CACHE = pick.dir
  INIT = { dir: pick.dir, fallback: pick.fallback }
  return { ...INIT, first: true }
}

/** 唯一读入口。没初始化就抛——不许返回默认值（那是「写进一棵没人会清的树」的起点）。 */
export function cacheDir() {
  if (!CACHE) {
    throw new Error('缓存根尚未初始化：先调 initCachePath()（index.js 在 apply() 开头调，tools/look.mjs 在 dispatch 之前调）')
  }
  return CACHE
}

/** 按视频分目录：CACHE/<BV>/<kind>.txt —— 同一个视频各层识别结果都收在同一个文件夹里。 */
export function videoDir(bv) {
  const root = cacheDir()
  const base = cleanKey(bvOf(bv))
  mkdirSync(root, { recursive: true })
  // 同一个 BV 已经有目录（可能被 CLI 改成「BV_标题」）就用它，别建第二个兄弟目录
  try {
    for (const d of readdirSync(root)) {
      if (d === base || d.startsWith(base + '_')) return join(root, d)
    }
  } catch {}
  const d = join(root, base)
  mkdirSync(d, { recursive: true })
  return d
}
