/**
 * 「用户可手改的小 JSON」统一读法（deps-config.json / ui 配置 / 缓存策略三处共用）。
 *
 * 行为（X-16a 与 #17 两个 P1 的成果，原样保留）：
 *   - 文件不存在 → 默认值，不算异常（ENOENT 是「没配过」）；
 *   - 空文件/纯空白 → 默认值，也不算异常；
 *   - 读失败 → 默认值 + problem(kind:'read')；
 *   - 解析失败 → **先把坏文件改名留档**（`.broken-<ts>`），再回默认值 + problem(kind:'parse')。
 * 留档而不是拒绝写：拒绝写会让面板「保存」一直失败、用户也不知道该改哪个文件。
 *
 * 2026-10-31：这段原来在 index.js（写模块级 cfgWarning）与 tools/look.mjs
 *   （直接打 stderr）各一份。行为一样，只有「怎么告诉用户」不同，所以拆开：
 *   **lib 只负责行为并返回结构化 problem，文案归调用方**——
 *   index 要进 /status 的中文 warnings，look 要打 ASCII 前缀的英文 stderr
 *   （PS 5.1 管道按当前代码页解码，中文会变成问号）。
 *
 * 顺带修掉的隐患：原来 cfgWarning 是「后写的覆盖先写的」单个字符串，两个坏文件同时存在时
 *   只会看到最后一条。现在每次读都返回自己的 problem，调用方攒成数组，一条都不会被吞。
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * @param {string} p 配置文件路径
 * @param {any} fallback 读不到 / 坏掉时返回的值
 * @returns {{ value: any, problem: null | { kind: 'read'|'parse', error: string, backup?: string, backupFailed?: string } }}
 */
export function readJsonOrBackup(p, fallback) {
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return { value: fallback, problem: null }
    return { value: fallback, problem: { kind: 'read', error: String(e?.message || e) } }
  }
  if (!raw.trim()) return { value: fallback, problem: null }
  try {
    return { value: JSON.parse(raw), problem: null }
  } catch (e) {
    const bak = `${p}.broken-${Date.now()}`
    try {
      renameSync(p, bak)
      return { value: fallback, problem: { kind: 'parse', error: String(e?.message || e), backup: bak } }
    } catch (e2) {
      return { value: fallback, problem: { kind: 'parse', error: String(e?.message || e), backupFailed: String(e2?.message || e2) } }
    }
  }
}

/**
 * 「用户可手改的小 JSON」统一写法（2026-11-02：五处状态写入的原子化）。
 *
 * 为什么需要：五处写入原来都是裸 `writeFileSync`——进程在写的中途被杀，目标文件就停在半截。
 *   读侧（readJsonOrBackup）虽然有留档兜底，但兜底的代价是「配置回默认值 + 多一个 .broken 文件」。
 *   写侧不产生半截才是根治。特别是 `deps-config.json`：面板进程写、CLI 子进程读，
 *   而 `tools/look.mjs` 的 `tuning()` 在**一次 CLI 调用**里要读它十几次（每次都是新开一个读窗口）。
 *
 * 做法：写同目录 tmp → rename 覆盖。rename 在 Windows/POSIX 上都是原子替换，
 *   所以目标文件要么是旧的完整内容、要么是新的完整内容，不存在半截。
 *
 * 三处容易写错的地方（都不是假想，各有前例）：
 *   1. **tmp 名每进程唯一 + 进程内自增**。固定的 `${p}.tmp` 在同一个进程内并发写时照样互相踩：
 *      A 写完还没 rename，B 就开始往里写 → A rename 出去的是被 B 改过的半截。
 *      同 tools/look.mjs 的 W-33（那里是 `${target}.${pid}-${++TMP_SEQ}.tmp`）。
 *   2. **格式由调用方给**。五处写入今天有两种格式（缩进 2 / 不缩进），统一成一种就会改文件字节，
 *      「纯机制替换、行为完全不变」就不成立了。indent<=0 表示 `JSON.stringify(obj)` 那种。
 *   3. **不加尾换行**。今天五处都没有，这里也不加。
 *
 * 失败时先删 tmp 再抛：留一个半截 tmp 在 deps/ 里，下次谁 glob 这个目录会当成配置文件。
 *   （删 tmp 本身失败不覆盖原异常——原异常才是用户要知道的那个。）
 *
 * ⚠️ Windows 上 rename 覆盖「正被别的进程打开读」的文件会 EPERM（POSIX 不会：rename 只看目录权限，
 *   不看目标是否被打开）。这个坑在这里是**必然**会撞上的，不是理论风险：
 *   面板写 `deps-config.json` 的同时，`tools/look.mjs` 的 `tuning()` 在**一次 CLI 调用**里要读它十几次
 *   （每次都是新开一个读窗口）。一个进程密集读、另一个写 300 次，
 *   **不重试时第一次 rename 就 EPERM 退出**（writer rc=1，一次都没写成）。
 *   不重试的后果比原来的裸写更糟——裸写从不失败，加了原子性反而让「保存」随机失败。
 *
 *   所以这里带退避重试。**最终这一档的退避档位**（RENAME_RETRY_MS = [0,1,2,5,10,20,40]，
 *   即 7 次尝试、其中 6 次真睡、合计 78ms；样本 200KB 对象 × 300 次写 × 4000 次密集读）：
 *     去掉重试        → 第一次 rename 就 EPERM，writer rc=1，一次没写成
 *     7 档退避（本实现）→ 300 次写全部成功、读方 0 次半截
 *     4×5ms（试过，弃）→ 仍漏 8/300 —— 档数不够，别往回缩
 *   注意「7 档」不是「8 档」：早期实验里试过固定的 8×10ms（零失败），但最终实现用的是变长退避，
 *   两者不是同一个东西，别把那个数字当成本实现的依据。
 *   代价：最坏情况下同步阻塞事件循环 78ms；只在真撞上时才发生，本地单用户可接受。
 *
 * ⚠️ **写凭证类文件必须传 `opts.mode`**：tmp 是新建的，不传 mode 就按 umask 来（通常 0644），
 *   rename 之后目标继承了 tmp 的 inode，原来的 0600 就没了。这种回退**不会报错**，
 *   只会让凭证变成同机其他用户可读 —— 靠功能测试永远发现不了。
 *
 *   2026-11-02 加了可选 mode，做法是「tmp 建时带 mode + rename **之前** chmod 一次 tmp」：
 *   - 建时带 mode：不留一个按 umask 可读的短暂窗口；
 *   - rename 前 chmod tmp：兜的是「磁盘上残留同名 tmp、而 writeFileSync 对已存在文件不改 mode」
 *     这个缝（tmp 名带 pid+自增，撞名概率极低但不是零）。
 *   - **故意不在 rename 之后 chmod 目标**，两个理由：
 *     a) rename 是 inode 替换，目标旧 inode 的权限根本不参与，不需要兜；
 *     b) 目标若在这两步之间被别的进程删掉，chmod 会 ENOENT 抛错 —— 那是「写成功了却报失败」，
 *        比不 chmod 更糟（`tools/look.mjs` 的 login 分支就有这个窗口：写完马上删 login-key.json）。
 *   - Windows 上 mode / chmod 都是空操作（stat 恒为 666），这一层**只对 POSIX 有效**。
 *     别把「代码里写了 0600」当成 Windows 上也是 0600 —— 台账 P2 已按这个分层写。
 *
 *   0600 点（可 grep 的标记：`grep -rn "0600 点" lib index.js tools`，改任一处记得同步这里）：
 *     1. index.js 面板扫码登录     → SHARED_CRED
 *     2. lib/cred.mjs adoptLegacyCred → SHARED_CRED（新位置同一文件）
 *     3. tools/look.mjs login --poll  → SHARED_CRED（`CRED_FILE = SHARED_CRED`）
 *     4. tools/look.mjs login         → LOGIN_KEY_FILE（**另一个文件**，登录成功/二维码过期即删）
 *   —— 前三处是同一个文件的三种写法，第四处是另一个文件、生命周期更短。
 *   原来这里写的是「那三处」，工具/人和注释互相引用过一轮，把 `login-key.json` 整条漏掉了。
 */
let WRITE_SEQ = 0
// Windows rename 重试：总等待 0+1+2+5+10+20+40 = 78ms（7 档，第一档 0 表示不睡直接再试）。
const RENAME_RETRY_MS = [0, 1, 2, 5, 10, 20, 40]
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
// 同步小睡：这里必须是同步的——writeJsonAtomic 的调用方都是同步函数（HTTP handler、yield 路径），
//   改成 async 会波及五处调用点的返回值形态，那是下一轮的事，不在这次范围内。
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function renameWithRetry(tmp, p) {
  let last = null
  for (let i = 0; i < RENAME_RETRY_MS.length; i++) {
    try {
      renameSync(tmp, p)
      return
    } catch (e) {
      last = e
      if (!RENAME_RETRY_CODES.has(e?.code)) throw e
      sleepSync(RENAME_RETRY_MS[i])
    }
  }
  throw last
}

/**
 * @param {string} p 目标路径（同目录下会临时建 `p.<pid>-<n>.tmp`）
 * @param {any} obj 要写入的值
 * @param {number} [indent=2] 缩进宽度；<=0 表示不缩进（保持该文件原有的紧凑格式）
 * @param {{ mode?: number }} [opts] 只有 `mode` 一项：写凭证类文件必须传，见上面「0600 点」
 */
export function writeJsonAtomic(p, obj, indent = 2, opts = {}) {
  const mode = opts?.mode
  const tmp = `${p}.${process.pid}-${++WRITE_SEQ}.tmp`
  const text = indent > 0 ? JSON.stringify(obj, null, indent) : JSON.stringify(obj)
  try {
    writeFileSync(tmp, text, mode ? { encoding: 'utf8', mode } : 'utf8')
    // chmod 的是 **tmp**、且发生在 rename 之前 —— 不是「rename 之后再 chmod 目标」。
    // 两者都是为了 0600，但后者会多一条失败路径（目标被删 → ENOENT），理由见函数头注释。
    // 这里不吞异常：chmod 失败 = 权限没设对，正是这个参数要防的那种静默降级。
    if (mode) chmodSync(tmp, mode)
    renameWithRetry(tmp, p)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}
