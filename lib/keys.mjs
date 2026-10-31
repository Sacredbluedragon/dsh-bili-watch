/**
 * lib/keys.mjs —— 「一个用户输入怎么变成安全的文件名 / 目录名」
 *
 * 为什么单独一个模块（2026-10-31 切片 1）：
 *   这四个函数在 index.js（DSH 进程内）与 tools/look.mjs（CLI 子进程）里各有一份
 *   逐字相同的实现。两份的成本不是「多 40 行」，而是「改一处要记得改两处」——
 *   漏了就会出现「面板建的目录名和 CLI 算出来的不一样」，同一个视频在缓存里落两个目录，
 *   用户看到的是「清理不干净」。搬到这里之后两个进程各 import 一份，物理上不可能分叉。
 *
 * 依赖：只有 OWN_CACHE_DIRS 一个只读常量（+ node:fs 的 readdirSync）。
 *   不读任何可变状态，所以两个进程各加载一份也不会算出不同结果。
 */
import { readdirSync } from 'node:fs'
import { OWN_CACHE_DIRS } from './consts.mjs'

/**
 * 只留字母数字与 `_ . -`；挡掉 `..` / `.` / Windows 保留设备名，避免用户输入直接决定磁盘路径。
 *
 * P2-5（2026-10-28 全量检查）：面板与 CLI 不许各算一个目录名——
 *   ① 尾部点号/空格在 Windows 上会被系统吃掉，「建出来的目录名」与「下次拼出来的目录名」不一致；
 *   ② 保留名要连后缀一起挡（con.txt / NUL.ini 在 Windows 上照样是设备名），按去扩展名后的基名判。
 */
export function cleanKey(s) {
  const k = String(s || '').replace(/[^\w.-]/g, '').slice(0, 40).replace(/[\s.]+$/, '')
  const base = k.split('.')[0]
  if (!k || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(base)) return '_misc'
  return k
}

/**
 * 从任意输入里取 BV 号；取不到就原样返回。
 *
 * T34-P0-1 / E6-02（2026-10-30）：模型可能把整条链接当 key 传进来，先取 BV 再建目录。
 *   CLI 的 positional 是原样接的，比插件侧更容易收到整条链接，漏了这一侧会造出 http 开头的目录名。
 */
export function bvOf(s) {
  const m = /(BV[0-9A-Za-z]{10})/.exec(String(s || ''))
  return m ? m[1] : s
}

/**
 * 按码点截断。
 *
 * N05-B4（2026-10-27 加）：emoji 是代理对，`slice(0, n)` 会从中间切开，回显末位变成 U+FFFD（`�`）；
 *   落盘文件是完整的，只有给模型/回显的这段被切坏。与 slugTitle 同口径。
 */
export function cutCp(s, n) {
  const str = String(s ?? '')
  if (str.length <= n) return str
  const a = Array.from(str)
  return a.length <= n ? str : a.slice(0, n).join('')
}

/**
 * 这个目录是不是「我们自己建的、名字像 URL 的」缓存目录（短链没解析成 BV 时 cleanKey 会压成
 * `httpsb23.tvabc123` 这种名字）。
 *
 * 2026-10-28：不认它，「立即清除」会留一堆删不掉的垃圾（用户实测剩 3 个）。
 * 10-28 又实测剩两个：`search` 的落盘目录名来自查询词（如 `DeepSeekHarness`）、`hot` 落 `_hot`。
 * 判据：里面**只有**我们自己的产物，且至少有一个 `*.tool.txt`。用户素材目录装的是 mp4/jpg，
 *   不会是这个形态；要求「至少一个 tool.txt」是给「名字不像 URL 的目录」加门槛，
 *   空目录仍只认名字像 URL 的。
 */
export function looksLikeOwnUrlDir(p, name) {
  let ents
  try { ents = readdirSync(p, { withFileTypes: true }) } catch { return false }
  if (!ents.length) return /^https?/i.test(name)
  let hasToolTxt = false
  for (const e of ents) {
    if (e.isDirectory()) {
      if (!OWN_CACHE_DIRS.has(e.name)) return false
      continue
    }
    if (/\.tool\.txt$/i.test(e.name)) hasToolTxt = true
    else if (!/^(meta\.json|.*\.lock)$/i.test(e.name)) return false
  }
  return hasToolTxt || /^https?/i.test(name)
}
