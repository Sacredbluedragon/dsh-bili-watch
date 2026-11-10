/**
 * lib/cache-own.mjs —— 「缓存根里的这一格，是不是我们自己的」
 *
 * 为什么单独一个模块（2026-10-31）：
 *   这是**唯一会删用户文件**的那条线。index.js（面板自动清理 / 手动清除）与 tools/look.mjs
 *   （clean 命令）各有一份实现，历史上已经因为判据不同踩过两次：
 *     ① 2026-10-29：clean 指向素材库，按名字把 4 个用户文件删了（认领判据宽于实际所有权）；
 *     ② 2026-10-30 E8 #1：removeOwned 早就改成「名字 + meta.json」，isOwnedEntry 却还按
 *        `/^BV…/` 直接认领，于是自动清理把用户自己的 `BV1234567890/` 连文件一起删。
 *   两份实现 = 两个判据，只修一边就是「面板删、CLI 不删」或者反过来。搬成一份，物理上不可能分叉。
 *
 * 依赖：`CACHE_MARK` / `OWN_CACHE_DIRS`（lib/consts.mjs）+ `looksLikeOwnUrlDir`（lib/keys.mjs）。
 *   **不读模块级可变状态**：缓存根一律由调用方传入（`isOwnedEntry(root, p)`），
 *   所以 CACHE 搬进状态模块时，这里一行都不用改，只换实参。
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { CACHE_MARK, OWN_CACHE_DIRS } from './consts.mjs'
import { looksLikeOwnUrlDir } from './keys.mjs'
import { readManifest } from './frames.mjs'
import { deletePaths, isImportant } from './recycle.mjs'

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
  let list
  try { list = readdirSync(p, { withFileTypes: true }) } catch { return false }
  if (list.length === 0) return true // 空壳：我们建过又清空的，清掉不损失任何东西
  // C242：只有 last-error.json 的 BV 目录也是我们自己写的失败记录，不是用户文件。
  //   以前只认 meta.json，于是 `view BV0000000000` 留下的错误目录永远清不掉。
  if (!existsSync(join(p, 'meta.json')) && !existsSync(join(p, 'last-error.json'))) return false
  // 删除面约束：顶层 BV 目录原来只要「名字像 + 有
  //   meta.json」就整棵删，用户在里面放一张 `1.jpg` 会跟着没。现在必须里面每一项
  //   都有正向凭证 —— 与 `whitelistDirIsOurs` 同一套判据，两个入口不再分叉。
  return dirIsProvablyOurs(p, 0)
}

/**
 * 自动清理（autoCleanCache → walkEntries）按条目判归属。`root` 是缓存根，由调用方传入。
 *
 * 判据必须与 removeOwned（用户点清理）完全一致，否则「自动清理删了、手点不删」——
 * 这正是 E8 #1 的形态：同一个删除面两个入口，判据宽的那个就成了漏洞。
 */
/**
 * 2026-11-05（0.4.7 删除面 P0）：**扩展名退出归属判据**。
 *   原来 `OUR_ENTRY_EXT` 证明的是「这类文件我们会写」，`isOurChild` 却拿它当
 *   「这个文件是我们写的」——用户拍的 `1.jpg` 同样是 .jpg，于是整棵 frames/ 被删，
 *   而且 `skipped` 是空数组。现在只认下面三类正向凭证，没有凭证就承认认不出、不动。
 */
const PROVEN_FIXED_NAMES = new Set([
  'manifest.json',         // lib/frames.mjs:92 writeManifest
  'meta.json',             // tools/look.mjs:2292 writeMeta
  'runs.jsonl',            // index.js:515 / tools/look.mjs:883 runsFile()
  'runs.jsonl.1',          // lib/runs.mjs:18 appendJsonLine 轮转
  'last-error.json',       // tools/look.mjs:3530 / lib/runs.mjs:89
  'injection-warned.json', // tools/look.mjs:2427 WARN_STATE()
])

/**
 * 我们把控的生成规则 —— 逐处 grep 生产落盘点得来，不凭记忆（见《逐目录凭证表》）。
 *   ・`<BV>-NN.jpg`                       look.mjs:838 / frameFilesToKeep(frames.mjs:70)
 *   ・`f_<m>m<ss>s.jpg`                   look.mjs:831 / frames.mjs:71
 *   ・`peek-NN.jpg`                       look.mjs:574 / :646
 *   ・`sheets/<BV>-pN-*.jpg`              look.mjs:2013 / :2084
 *   ・`sheets/<BV>-pN-*.manifest.json`    look.mjs:2022
 *   ・`asr/<BV>-pN-*.txt|wav|tmp`         look.mjs:1059-1060
 *   ・`asr/<BV>-pN-*.cues.json`           look.mjs:1153
 *   ・`*.tool.txt`                        lib/keys.mjs:74 looksLikeOwnUrlDir
 * **没有「补零帧序号」**：`0001.jpg` 不是任何真实产物。
 *   留下它会让用户放一张 `01.jpg` 就被认成我们的 —— 那是真实的数据丢失口子。
 */
const PROVEN_NAME_RE = new RegExp('^(?:' + [
  'BV[0-9A-Za-z]{10}-\\d{2,}\\.jpg',
  'f_\\d+m\\d+s\\.jpg',
  'peek-\\d{2,}\\.jpg',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.jpg',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.manifest\\.json',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.(?:txt|wav|tmp)',
  'BV[0-9A-Za-z]{10}-p\\d+-.*\\.cues\\.json',
  // printText 落的 `<kind>.txt` / `<kind>.wrapped.txt`。
  //   kind 全集来自 tools/look.mjs 的 printText( 调用点（共 10 个），verify.mjs C162 有同源反查。
  //   `view` 不是 kind：cmdView 只调 writeMeta、全仓无 `view.txt` 落盘点，留着它等于按名字
  //   认领用户文件（与 1457 删掉 `0001.jpg` 同型，夹具 V 组盯着）。
  //   不按 `.txt` 后缀通吃 —— 用户自己放的 notes.txt 不能算我们的。
  '(?:text|sub|sub-txt|sub-md|sub-srt|sub-json|asr|ocr|ocr-frames|local-json)(?:\\.wrapped)?\\.txt',
  // C242：writeMeta 失败时落的错误记录，只有本插件会写这个名字。
  'last-error\\.json',
].join('|') + ')$', 'i')

/**
 * 本轮给不出「每一项都有正向凭证」的目录 —— 一律不认领（宁可少删），不编规则填表。
 *   ・sheet-tmp / substrip-tmp：内部是 `%02d.jpg`，与用户 `01.jpg` 不可区分（look.mjs:2010/:2081）
 *   ・frames-dl / audio-dl：通用 URL 下载目录，内部文件名来自网络、不可枚举（look.mjs:3399/:3413）
 *   ・_hot：全仓 grep 无任何落盘点，`OWN_CACHE_DIRS` 里疑似历史遗留
 * 这五个都由夹具的 `*_userSurvived` / `*_notClaimed` 覆盖。
 */
const UNPROVABLE_DIRS = new Set(['sheet-tmp', 'substrip-tmp', 'frames-dl', 'audio-dl', '_hot'])

// C242：--all 下的「目录由本插件创建」正面凭证。三类任一即可：
//   meta.json / manifest.json / gen-<hash> 命名；并且内部不许出现用户扩展名。
// 常规 clean 与自动清理仍然一律跳过这五个名字，放开只挂在 --all 上。
const USER_EXT_RE = /\.(?:psd|ai|eps|docx?|xlsx?|pptx?|pdf|zip|rar|7z|exe|dll|msi|iso|torrent|key|pem)$/i
const GEN_DIR_RE = /^gen-[0-9a-f]{6,}$/i

function allProofDir(p, depth = 0) {
  if (depth > 4) return false
  let list
  try { list = readdirSync(p, { withFileTypes: true }) } catch { return false }
  const ownFile = (n) => n === 'meta.json' || n === 'manifest.json' || n === 'last-error.json' || PROVEN_NAME_RE.test(n)
  const hasProof = list.some((e) => !e.isDirectory() && ownFile(e.name)) || GEN_DIR_RE.test(basename(p))
  const subDirs = list.filter((e) => e.isDirectory())
  // 顶层容器自己没有清单时，允许「每个子目录都有凭证」；但混进一个没凭证的子目录就整棵不认。
  if (!hasProof && (subDirs.length === 0 || !subDirs.every((e) => allProofDir(join(p, e.name), depth + 1)))) return false
  for (const e of list) {
    if (e.isDirectory()) {
      if (!allProofDir(join(p, e.name), depth + 1)) return false
    } else if (USER_EXT_RE.test(e.name)) {
      return false
    }
  }
  return true
}

/** 读该目录的 manifest.files 书面记账；坏文件 / 没清单 → 空集（当作没记过）。 */
function manifestFilesOf(dir) {
  const m = readManifest(dir)
  return new Set(Array.isArray(m?.files) ? m.files.filter((f) => typeof f === 'string') : [])
}

/**
 * 点开头名字的**精确白名单**。
 *
 * 原来这里写 `if (e.name.startsWith('.')) return true`，把用户的 `.gitignore` /
 * `.obsidian/app.json` 也认领；1526 换成 `endsWith('.lock')` 后，又轮到用户的
 * `.obsidian.lock` 被删。**按前导点猜、按后缀猜，都是猜**——现在只认逐个 grep 到
 * 落盘点的真实锁名，且剥掉 `.lock` 后底下的名字还得能过同一套凭证。
 *
 * 真实写入点（逐处 grep 生产代码，不凭记忆）：
 *   ① `.lock`                  lib/locks.mjs:125 tryLockSync(dir, '.lock') 默认名
 *   ② `.meta-<base>.lock`     tools/look.mjs:2287 / :2303
 *   ③ `.<BV>-p<N>.lock`       tools/look.mjs:1057（asr 转写互斥）
 *   ④ `.<BV>-<NxN>.lock`      tools/look.mjs:2011（sheet 拼图互斥）
 *   ⑤ `.<BV>.lock`            tools/look.mjs:2082（字幕带拼图互斥）
 *   ⑥ `.write-test-<pid>`     lib/cache-path.mjs:138（无 .lock 后缀）
 * `CACHE_MARK` 在 hasPositiveProof 里已有单独一行，不走这里。
 *
 * 边界如实写：用户的 `.obsidian.lock` 剥完底名是 `.obsidian`，过不了任何一条 → 不动；
 * `notes.lock` 不以点开头，根本不进这个函数，落 `PROVEN_NAME_RE.test()` 判 false → 不动。
 * `.${tag}.lock`（tools/look.mjs:3280 本地转写，tag 由调用方给、形状不可枚举）本轮
 * **不认领**：宁可留一个我们自己的残留锁，也不猜用户文件。不放行点开头的目录
 * （`.obsidian/` / `.git/`）：名字不算证据。
 */
function isProvenDotName(name) {
  if (name === '.lock') return true
  if (/^\.write-test-\d+$/.test(name)) return true
  if (!name.endsWith('.lock')) return false
  const base = name.slice(0, -5)
  if (!base || /^\.+$/.test(base)) return false     // `.lock` 已单列；空串 / 纯点不认
  if (/^\.meta-/.test(base)) return true           // ②
  if (/^\.write-test-/.test(base)) return true     // ⑥ 带 .lock 后缀的变体
  const core = base.startsWith('.') ? base.slice(1) : base
  if (!core || /^\.+$/.test(core)) return false
  // ③④⑤：底名必须是一个 BV 号（可带 -pN / -NxN 派生），BV 号是我们自己的身份凭证
  if (/^BV[0-9A-Za-z]{10}(?:-p\d+(?:-[0-9A-Za-z_]+)*|-\d+x\d+)?$/i.test(core)) return true
  if (PROVEN_FIXED_NAMES.has(core) || PROVEN_NAME_RE.test(core)) return true
  if (/\.tool\.txt$/i.test(core)) return true
  return false
}

/**
 * 逐条正向凭证。`manifest` 是所在目录的 manifest.files 集合。
 * 目录一律递归：名字像不算证据，必须里面每一项都过。
 */
function hasPositiveProof(dir, e, manifest, depth) {
  if (e.name === CACHE_MARK) return true
  if (e.name.startsWith('.')) return isProvenDotName(e.name)
  if (e.isDirectory()) return dirIsProvablyOurs(join(dir, e.name), depth + 1)
  if (PROVEN_FIXED_NAMES.has(e.name)) return true
  if (manifest.has(e.name)) return true
  if (/\.tool\.txt$/i.test(e.name)) return true
  // `${out}.part` 是断点续传的半成品（`lib/media.mjs:115` / `scripts/fetch-deps.mjs:443`）。
  //   不按 `.part` 后缀猜归属：剥掉后缀后**底下的名字本身还得能过同一套凭证**，
  //   于是 `BV…-01.jpg.part` 清得掉，用户放的 `随便.part` 依然认不出、不动。
  if (/\.part$/i.test(e.name)) {
    const base = e.name.slice(0, -5)
    return PROVEN_FIXED_NAMES.has(base) || manifest.has(base)
      || /\.tool\.txt$/i.test(base) || PROVEN_NAME_RE.test(base)
  }
  return PROVEN_NAME_RE.test(e.name)
}

/** 保留这个名字：`removeOwned` 与自动清理的内容校验都从这里进。 */
function isOurChild(e, dir, manifest, depth) {
  return hasPositiveProof(dir, e, manifest, depth)
}

/**
 * 「整棵删」的唯一授权：目录里每一项都有正向凭证（全或无）。
 *   空目录 true（清掉 mkdir 留下的空壳）；读不出来 / 超过 8 层 → false（安全侧）。
 */
function dirIsProvablyOurs(p, depth = 0, opts = {}) {
  if (depth > 8) return false
  if (UNPROVABLE_DIRS.has(basename(p))) {
    if (!opts.all) return false
    return allProofDir(p)
  }
  let list
  try { list = readdirSync(p, { withFileTypes: true }) } catch { return false }
  if (list.length === 0) return true
  const manifest = manifestFilesOf(p)
  return list.every((e) => isOurChild(e, p, manifest, depth))
}

/** CLI `--fresh` 那条路径用：返回该目录里「有正向凭证」的条目名集合。 */
export function provableNamesIn(dir) {
  const ok = new Set()
  let list
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return ok }
  const manifest = manifestFilesOf(dir)
  for (const e of list) if (hasPositiveProof(dir, e, manifest, 0)) ok.add(e.name)
  return ok
}

/**
 * 白名单目录（frames / asr / _logs …）能不能整棵认领。
 *
 * 原来 `OWN_CACHE_DIRS.has(name)` 一票通过——**只看名字**；后来改成「顶层每个条目
 * 都像我们的产物」（`list.every(isOurChild)`），但 `isOurChild` 拿扩展名当证据，
 * 用户的 `1.jpg` 照样过判，而且只看顶层、不进 BV 子目录。
 *
 * 现在统一走 `dirIsProvablyOurs`：递归、全或无、只认正向凭证。
 * 出现一个没凭证的条目（用户自己的 `工程文件.psd`、`素材/` 子目录…），整目录不动。
 */
function whitelistDirIsOurs(p, opts = {}) {
  return dirIsProvablyOurs(p, 0, opts)
}

export function isOwnedEntry(root, p) {
  const rel = relative(root, p)
  const first = rel.split(/[\\/]/)[0]
  if (OWN_CACHE_DIRS.has(first)) {
    // 2026-11-01（P1-5）：原来这里直接 `return true`。现在要看内容。
    return whitelistDirIsOurs(join(root, first))
  }
  // 1526 返工：顶层点文件与白名单目录内部走同一套精确白名单，两个删除入口不分叉。
  if (first.startsWith('.') && isProvenDotName(first)) return true
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
 * `opts.dryRun` 为真时只枚举不删，`plan` 逐项列出「这次会删什么 / 多少文件 / 多少字节」。
 * 干跑与真删共用同一个循环和同一套归属判据 —— 单写一份干跑枚举迟早与真删分叉。
 *
 * 三道闸，缺一道就会删到用户文件：
 *   ① 不是带标记的缓存根 → 一个文件都不动（`isOurCacheRoot`）；
 *   ② 每一格都要过归属判据（`isOwnBvDir` / `OWN_CACHE_DIRS` + 内容校验 / `looksLikeOwnUrlDir`）；
 *      白名单目录**不能只认名字**：缓存根可以被指到任何目录，用户自建的 `frames/` 会被整棵删掉；
 *   ③ 删不掉的记 `failed`（不是「没动」），调用方据此改退出码——
 *      原来 EPERM 混在 skipped 里还说「没动」，用户以为清干净了。
 */
export function removeOwned(dir, opts = {}) {
  const dryRun = opts?.dryRun === true
  // C236b：三档 deleteMode 共用这一个删除函数。这里只用字面量归一，不调外部函数——
  //   C10 的 vm 夹具会抠走本函数体单独编译，prelude 里没有那些依赖。
  const mode = opts?.mode === 'recycle' || opts?.mode === 'smart' ? opts.mode : 'permanent'
  let files = 0
  let bytes = 0
  const plan = [] // 干跑时逐项记「这次会删什么」；与真删共用下面同一轮枚举，不另写一套判据
  const skipped = [] // 非本插件条目，不动（不算失败）
  const failed = [] // 本插件条目但真没删掉（只读目录 / 权限）；干跑没删，恒为空
  const overflow = { count: 0, bytes: 0 } // 回收站放不下而跳过的重要文件，绝不静默降级成直删
  const fallback = [] // 回收站 API 失效后直删，明确记「这是永久删除」
  const recycled = []
  const emptyResult = (extraSkipped) => ({ files, bytes, skipped: extraSkipped || skipped, failed, dryRun, plan, mode, overflow, fallback, recycled })
  if (!isOurCacheRoot(dir)) return emptyResult([{ name: dir, why: '不是一个带标记的缓存根，不动' }])
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return emptyResult() }
  // 干跑与真删只差「最后那一下删除」：归属判据、体积统计、跳过清单全部同一轮。
  const record = (name, f, b) => { files += f; bytes += b; plan.push({ name, files: f, bytes: b }) }
  /**
   * 单个条目的删除落点。permanent 直删；recycle / smart 交给统一入口（含容量闸、
   * 长路径 failed、API 失效回落）。返回 null=删掉 / '__SKIP__'=放不下跳过 / 字符串=失败原因。
   */
  const del = (p, name, f, b) => {
    if (mode === 'permanent') {
      try { rmSync(p, { recursive: true, force: true }); return null } catch (err) { return String(err?.message || err) }
    }
    const r = deletePaths([{ path: p, name, rel: name, files: f, bytes: b }], { mode, root: dir, probe: opts?.probe })
    if (r.overflow.count) { overflow.count += r.overflow.count; overflow.bytes += r.overflow.bytes; return '__SKIP__' }
    if (r.fallback.length) fallback.push(...r.fallback)
    if (r.recycled.length) recycled.push(...r.recycled)
    return r.failed.length ? r.failed[0].why : null
  }
  const tally = (e, err, f, b) => {
    if (err === '__SKIP__') skipped.push({ name: e.name, why: '回收站空间不足，跳过不删（没有改走永久删除）' })
    else if (err) failed.push({ name: e.name, why: err })
    else { files += f; bytes += b }
  }
  for (const e of list) {
    const p = join(dir, e.name)
    // 2026-11-01（X-02）：`OWN_CACHE_DIRS.has(name)` 原来是一票通过——只看名字，不看内容。
    //   缓存根可以被 BILI_WATCH_CACHE / deps-config.json 指到任何目录（只要有标记文件），
    //   用户在那种根下自建 frames/ 放素材，点「清除」就被整棵删掉，skipped 里还一个字不提。
    //   标记 + frames/用户.psd + 一个有 meta 的 BV → removed=2，psd 没了，skipped 是空数组。
    //   现在与自动清理（isOwnedEntry）共用同一个内容判据，两条删除路径只保留一个口径。
    const named = OWN_CACHE_DIRS.has(e.name)
    const namedOurs = named ? whitelistDirIsOurs(p) : false
    if (e.isDirectory() && (isOwnBvDir(p, e.name) || namedOurs || looksLikeOwnUrlDir(p, e.name))) {
      const st = dirStat(p)
      if (dryRun) record(e.name, st.files, st.bytes)
      else tally(e, del(p, e.name, st.files, st.bytes), st.files, st.bytes)
    } else if (e.isFile() && e.name.startsWith('.') && isProvenDotName(e.name)) {
      try { const st = lstatSync(p); if (dryRun) record(e.name, 1, st.size); else tally(e, del(p, e.name, 1, st.size), 1, st.size) } catch (err) { failed.push({ name: e.name, why: String(err?.message || err) }) }
    } else if (e.isFile() && e.name === 'login-qr.png') {
      // E7 顺带（2026-10-30）：登录二维码写在缓存根，而原判据只认 BV 目录与 10 个固定子目录，
      //   于是 clean 每次都把它当「不是 bili-watch 的数据」跳过——迁移函数却专门保留它，
      //   两处口径互相矛盾，结果是这张图永远留在缓存根。它确实是我们写的，该清。
      try { const st = lstatSync(p); if (dryRun) record(e.name, 1, st.size); else tally(e, del(p, e.name, 1, st.size), 1, st.size) } catch (err) { failed.push({ name: e.name, why: String(err?.message || err) }) }
    } else if (e.isFile() && e.name === CACHE_MARK) {
      // 缓存根标记：静默保留，不进 skip 清单（这是我们自己写的，不是别人的东西）
    } else if (e.isDirectory() && named) {
      // 名字在白名单里但内容判据不认领：可能是真混了别人的东西，也可能是这五个目录
      //   的内部文件名给不出归属凭证（UNPROVABLE_DIRS）。两种都不动，别把后者说成前者
      //   ——旧措辞会把本插件产物说成用户误放的东西，改后只如实说「认不出归属」。
      skipped.push({ name: e.name, why: `${e.name}/ 暂不自动清理（内部文件名无法区分归属，需手动处理）` })
    } else {
      skipped.push({ name: e.name, why: '不是 bili-watch 的缓存条目，不动' })
    }
  }
  return { files, bytes, skipped, failed, dryRun, plan, mode, overflow, fallback, recycled }
}

/**
 * C236b：`clean --all` / 面板「清空全部」的枚举与删除。目标是清到只剩 CACHE_MARK 一个条目。
 *
 * 与常规 clean 共用上面那一套归属判据（isOurCacheRoot → isOwnBvDir / 白名单内容校验 /
 * 正面文件名）。认不出归属的条目照样跳过——`--all` 是「强制清我们自己的产物」，不是
 * 「删掉这个目录里的一切」；只有带标记的缓存根才会被清，用户误放进来的文件一个都不动。
 *
 * 删除不再直接 rmSync：与常规 clean、自动清理一样交给 lib/recycle.mjs 的 deletePaths，
 * 三档 deleteMode、容量闸、失效面回落在三条路径上完全一致。
 */
/** 目录里有没有「重要文件」：--all 整棵删时按最保守的一档决定要不要进回收站。 */
function dirHasImportant(p, depth = 0) {
  if (depth > 4) return false
  let list
  try { list = readdirSync(p, { withFileTypes: true }) } catch { return false }
  for (const x of list) {
    if (isImportant(x.name)) return true
    if (x.isDirectory() && dirHasImportant(join(p, x.name), depth + 1)) return true
  }
  return false
}

export function enumerateForAll(dir) {
  const entries = []
  const skipped = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === CACHE_MARK) continue
    const p = join(dir, e.name)
    const named = OWN_CACHE_DIRS.has(e.name)
    const ours = e.isDirectory()
      ? (isOwnBvDir(p, e.name) || (named && whitelistDirIsOurs(p, { all: true })) || looksLikeOwnUrlDir(p, e.name))
      : ((e.name.startsWith('.') && isProvenDotName(e.name)) || e.name === 'login-qr.png')
    if (!ours) { skipped.push({ name: e.name, why: '认不出归属，--all 也不动' }); continue }
    const st = e.isDirectory() ? dirStat(p) : { files: 1, bytes: lstatSync(p).size }
    // smart 档只把显式清单里的重要文件送回收站。整棵删时 rel 是顶层目录名，
    //   认不出目录内的 asr.txt / frames-dl；这里把「目录含重要文件」翻成一个能触发
    //   同一份 isImportant 的相对路径，宁可整棵进回收站也不漏掉可恢复性。
    const important = e.isDirectory() ? dirHasImportant(p) : isImportant(e.name)
    entries.push({ name: e.name, path: p, rel: important ? `${e.name}/asr.txt` : `${e.name}/`, files: st.files, bytes: st.bytes })
  }
  return { entries, skipped }
}

/** 只在用户点「清空全部」那一下跑：确认框要写「将删除 N 项 / X MB」，绝不能进 /status 轮询。 */
export function previewAll(root) {
  if (!isOurCacheRoot(root)) return { count: 0, bytes: 0, files: 0 }
  try {
    const { entries } = enumerateForAll(root)
    return { count: entries.length, files: entries.reduce((n, e) => n + e.files, 0), bytes: entries.reduce((n, e) => n + e.bytes, 0) }
  } catch { return { count: 0, bytes: 0, files: 0 } }
}

export function removeAllOwned(dir, opts = {}) {
  const mode = opts?.mode === 'recycle' || opts?.mode === 'smart' ? opts.mode : 'permanent'
  const dryRun = opts?.dryRun === true
  if (!isOurCacheRoot(dir)) {
    return { items: 0, files: 0, bytes: 0, skipped: [{ name: dir, why: '不是一个带标记的缓存根，不动' }], failed: [], dryRun, plan: [], mode, overflow: { count: 0, bytes: 0 }, fallback: [], recycled: [] }
  }
  let built
  try { built = enumerateForAll(dir) } catch (e) {
    return { items: 0, files: 0, bytes: 0, skipped: [], failed: [{ name: dir, why: String(e?.message || e) }], dryRun, plan: [], mode, overflow: { count: 0, bytes: 0 }, fallback: [], recycled: [] }
  }
  const { entries } = built
  const sums = entries.reduce((a, e) => ({ files: a.files + e.files, bytes: a.bytes + e.bytes }), { files: 0, bytes: 0 })
  if (dryRun) {
    return { items: entries.length, ...sums, skipped: built.skipped, failed: [], dryRun, plan: entries, mode, overflow: { count: 0, bytes: 0 }, fallback: [], recycled: [] }
  }
  const r = deletePaths(entries, { mode, root: dir, probe: opts?.probe })
  const skipped = [...built.skipped]
  if (r.overflow.count) skipped.push({ name: `回收站空间不足（${r.overflow.count} 项）`, why: '跳过不删，没有改走永久删除' })
  return {
    items: r.removed, files: sums.files, bytes: r.bytes, skipped, failed: r.failed,
    dryRun, plan: entries, mode, overflow: r.overflow, fallback: r.fallback, recycled: r.recycled,
  }
}
