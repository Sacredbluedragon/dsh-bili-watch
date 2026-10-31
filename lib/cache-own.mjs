/**
 * lib/cache-own.mjs —— 「缓存根里的这一格，是不是我们自己的」
 *
 * 为什么单独一个模块（2026-10-31 切片 2）：
 *   这是**唯一会删用户文件**的那条线。index.js（面板自动清理 / 手动清除）与 tools/look.mjs
 *   （clean 命令）各有一份实现，历史上已经因为判据不同踩过两次：
 *     ① 2026-10-29：clean 指向素材库，按名字把 4 个用户文件删了（认领判据宽于实际所有权）；
 *     ② 2026-10-30 E8 #1：removeOwned 早就改成「名字 + meta.json」，isOwnedEntry 却还按
 *        `/^BV…/` 直接认领，于是自动清理把用户自己的 `BV1234567890/` 连文件一起删。
 *   两份实现 = 两个判据，只修一边就是「面板删、CLI 不删」或者反过来。搬成一份，物理上不可能分叉。
 *
 * 依赖：`CACHE_MARK` / `OWN_CACHE_DIRS`（lib/consts.mjs）+ `looksLikeOwnUrlDir`（lib/keys.mjs）。
 *   **不读模块级可变状态**：缓存根一律由调用方传入（`isOwnedEntry(root, p)`），
 *   所以切片 4 把 CACHE 搬进状态模块时，这里一行都不用改，只换实参。
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CACHE_MARK, OWN_CACHE_DIRS } from './consts.mjs'
import { looksLikeOwnUrlDir } from './keys.mjs'

/**
 * 这个目录是不是「我们的缓存根」（有没有我们写的标记文件）。
 *
 * CACHE 来自 BILI_WATCH_CACHE / deps-config.json，用户能指到任何目录；指到一个恰好含 BV* 子目录的
 * 素材库，按名字判据就会把用户文件删掉。pickCacheDir() 返回前一定写标记（幂等），所以正常路径上
 * 标记一定在；标记不在就一律不删——宁可留垃圾，也不删用户文件。
 */
export function isOurCacheRoot(dir) {
  try {
    return existsSync(join(dir, CACHE_MARK))
  } catch {
    return false
  }
}

/**
 * BV 目录不能只认名字——名字像 BV 且（里面真有我们写的 meta.json，或者目录是空的），才算我们的产物。
 *
 * meta.json 只有 writeMeta() 会写，用户素材库不会有；`frames` / `asr` / `_logs` 这类通用名
 * 不当身份凭证。正则右边界 `(_|$)` 是为 `videoDir()` 的 `BV_标题` 命名留的：
 * 去掉它，`BV1234567890extra/` 这种用户目录也会被认领（C26 钉住这条）。
 * 放宽到「空目录」是 E7 的补充：`videoDir()` 先 mkdir 再校验 BV 有效性，所以
 * `view BV0000000000` 这类失败请求会留下一个空壳，原判据要求 meta.json，于是它既清不掉也永远不消失。
 */
export function isOwnBvDir(p, name) {
  if (!/^BV[0-9A-Za-z]{10}(_|$)/i.test(name)) return false
  if (existsSync(join(p, 'meta.json'))) return true
  try {
    if (readdirSync(p).length === 0) return true
  } catch {}
  return false
}

/**
 * 自动清理（autoCleanCache → walkEntries）按条目判归属。`root` 是缓存根，由调用方传入。
 *
 * 判据必须与 removeOwned（用户点清理）完全一致，否则「自动清理删了、手点不删」——
 * 这正是 E8 #1 的形态：同一个删除面两个入口，判据宽的那个就成了漏洞。
 */
/**
 * 我们写过的文件扩展名（小写，含点）。白名单目录里的顶层文件按这个判「是不是我们的」。
 * 来源：逐处 grep 出来的落盘文件名——manifest/清单(.json) / 运行日志(.jsonl/.log) /
 *   字幕(.srt/.vtt/.ass) / 帧(.jpg/.png) / 媒体(.mp4/.m4a/.webm/.mp3) / 半成品(.part/.tmp) / 锁(.lock)。
 */
const OUR_ENTRY_EXT = new Set([
  '.json', '.jsonl', '.log', '.txt', '.srt', '.vtt', '.ass',
  '.jpg', '.jpeg', '.png', '.webp',
  '.mp4', '.m4a', '.webm', '.mp3',
  '.part', '.lock', '.tmp',
])

/**
 * 我们写过的子目录形状：BV 目录（`BV1xx…-p1-2s`）、带页码的（`…-p3-at-1p`）、
 * 以 step 结尾的（`…-2s` / `…-scene-3s`）、以及 `shots`。
 * 判据保守：不匹配就当「不是我们的」，于是整目录不删——宁可留垃圾，不删用户文件。
 */
const OUR_DIR_NAME = /(?:BV[0-9A-Za-z]{10}|-p\d+|-at-\d+p|-\d+(?:\.\d+)?s$|^shots$)/

function isOurChild(e) {
  if (e.name === CACHE_MARK) return true
  // .lock / .meta-* / .part / .write-test-* 一律是我们的（前导点是我们自己起的名）
  if (e.name.startsWith('.')) return true
  if (e.isDirectory()) return OUR_DIR_NAME.test(e.name)
  const dot = e.name.lastIndexOf('.')
  return dot > 0 && OUR_ENTRY_EXT.has(e.name.slice(dot).toLowerCase())
}

/**
 * 白名单目录（frames / asr / _logs …）能不能整棵认领。
 *
 * 原来 `OWN_CACHE_DIRS.has(name)` 一票通过——**只看名字**。可是缓存根可以被
 * `BILI_WATCH_CACHE` / `deps-config.json` 指到任何目录（只要有我们的标记文件），
 * 用户在那种根下自己建一个 `frames/` 放素材，点「清除」就被整棵删掉了。
 *
 * 现在加一层内容校验：只有「顶层每一个条目都像我们的产物」才认领；
 * 出现一个不像的（用户自己的 `工程文件.psd`、`素材/` 子目录…），整目录不动。
 * 空目录照样认领（删了不损失任何东西，还能把 mkdir 留下的空壳清掉）。
 */
function whitelistDirIsOurs(p) {
  let list
  try {
    list = readdirSync(p, { withFileTypes: true })
  } catch {
    return false // 读不出来就当不是我们的（安全侧）
  }
  if (list.length === 0) return true
  return list.every(isOurChild)
}

export function isOwnedEntry(root, p) {
  const rel = relative(root, p)
  const first = rel.split(/[\\/]/)[0]
  if (OWN_CACHE_DIRS.has(first)) {
    // 2026-11-01（DSH 00:44 P1-5）：原来这里直接 `return true`。现在要看内容。
    return whitelistDirIsOurs(join(root, first))
  }
  if (/^\.(meta-|write-test-)/.test(first)) return true
  return isOwnBvDir(join(root, first), first)
}

/**
 * 统计一棵子树的「文件数 / 字节数」。
 *
 * 两处口径必须一致，否则面板「当前占用」与 clean 报的「已清理 X MB」对不上：
 *   - 跳过标记文件与 `_logs`：「占用」应当等于「立即清除能清掉的量」，
 *     否则清了以后永远显示 52 B + 日志大小，用户以为没清干净；
 *   - 一律 `lstat`：`rmSync` 删符号链接只删链接本身，按 `stat` 取的是目标大小，会虚高；
 *   - 非目录（含符号链接）按自身大小计一次：原来 look.mjs 那份写 `else if (e.isFile())`，
 *     链接两个分支都不进、直接被跳过，与 index.js 的 `else` 口径不同。
 */
export function dirStat(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === CACHE_MARK || e.name === '_logs') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        files += 1
        try {
          bytes += lstatSync(p).size
        } catch {}
      }
    }
  }
  try {
    walk(dir)
  } catch {}
  return { bytes, files }
}

/**
 * 用户点「清除」走这条：删掉缓存根下**属于我们的**条目，别人的东西一个都不动。
 *
 * 三道闸，缺一道就会删到用户文件：
 *   ① 不是带标记的缓存根 → 一个文件都不动（`isOurCacheRoot`）；
 *   ② 每一格都要过归属判据（`isOwnBvDir` / `OWN_CACHE_DIRS` / `looksLikeOwnUrlDir`）；
 *   ③ 删不掉的记 `failed`（不是「没动」），调用方据此改退出码——
 *      原来 EPERM 混在 skipped 里还说「没动」，用户以为清干净了。
 */
export function removeOwned(dir) {
  let files = 0
  let bytes = 0
  const skipped = [] // 非本插件条目，不动（不算失败）
  const failed = [] // 本插件条目但真没删掉（只读目录 / 权限）
  if (!isOurCacheRoot(dir)) return { files, bytes, skipped: [{ name: dir, why: '不是一个带标记的缓存根，不动' }], failed }
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return { files, bytes, skipped, failed } }
  for (const e of list) {
    const p = join(dir, e.name)
    if (e.isDirectory() && (isOwnBvDir(p, e.name) || OWN_CACHE_DIRS.has(e.name) || looksLikeOwnUrlDir(p, e.name))) {
      const st = dirStat(p)
      try { rmSync(p, { recursive: true, force: true }); files += st.files; bytes += st.bytes } catch (err) { failed.push({ name: e.name, why: String(err?.message || err) }) }
    } else if (e.isFile() && /^\.(meta-|write-test-)/.test(e.name)) {
      try { const st = lstatSync(p); rmSync(p, { force: true }); files += 1; bytes += st.size } catch (err) { failed.push({ name: e.name, why: String(err?.message || err) }) }
    } else if (e.isFile() && e.name === 'login-qr.png') {
      // E7 顺带（2026-10-30）：登录二维码写在缓存根，而原判据只认 BV 目录与 10 个固定子目录，
      //   于是 clean 每次都把它当「不是 bili-watch 的数据」跳过——迁移函数却专门保留它，
      //   两处口径互相矛盾，结果是这张图永远留在缓存根。它确实是我们写的，该清。
      try { const st = lstatSync(p); rmSync(p, { force: true }); files += 1; bytes += st.size } catch (err) { failed.push({ name: e.name, why: String(err?.message || err) }) }
    } else if (e.isFile() && e.name === CACHE_MARK) {
      // 缓存根标记：静默保留，不进 skip 清单（这是我们自己写的，不是别人的东西）
    } else {
      skipped.push({ name: e.name, why: '不是 bili-watch 的缓存条目，不动' })
    }
  }
  return { files, bytes, skipped, failed }
}
