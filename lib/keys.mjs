/**
 * lib/keys.mjs —— 「一个用户输入怎么变成安全的文件名 / 目录名」
 *
 * 为什么单独一个模块（2026-10-31）：
 *   这四个函数在 index.js（DSH 进程内）与 tools/look.mjs（CLI 子进程）里各有一份
 *   逐字相同的实现。两份的成本不是「多 40 行」，而是「改一处要记得改两处」——
 *   漏了就会出现「面板建的目录名和 CLI 算出来的不一样」，同一个视频在缓存里落两个目录，
 *   用户看到的是「清理不干净」。搬到这里之后两个进程各 import 一份，物理上不可能分叉。
 *
 * 依赖：OWN_CACHE_DIRS 与 PROVEN_TOOL_TXT_RE 两个只读常量（+ node:fs 的 readdirSync）。
 *   不读任何可变状态，所以两个进程各加载一份也不会算出不同结果。
 */
import { readdirSync } from 'node:fs'
import { OWN_CACHE_DIRS, PROVEN_TOOL_TXT_RE } from './consts.mjs'

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
 * 不认它，「立即清除」会留一堆删不掉的垃圾（剩 3 个）。
 * 又剩两个：`hot` 落 `_hot`（index.js 的 trimForModel 以 `_hot` 为 bv 调用 videoDir）；
 *   旧注释还说「search 的落盘目录名来自查询词」——2026-11-21 件一实核全仓 grep：
 *   生产代码只有 cmdSearch 打印到 stdout，没有任何以查询词建目录的落盘点，那句是陈旧描述。
 * 判据（收紧后）：名字必须像 http(s)，且里面**只有**我们自己的产物。
 *   旧版还把「至少有一个 `*.tool.txt`」当独立认领门槛，于是任何用户自建目录
 *   （名字不像 URL、不在 OWN_CACHE_DIRS）只要塞一个 `.tool.txt` 就被整棵认领并真删（F-01 第二现场）。
 *   现在 `.tool.txt` 只能作为「内容里允许出现的产物」通过 PROVEN_TOOL_TXT_RE 校验，
 *   不再单独授予认领权；名字不像 URL 的目录一律不认。空的 http(s) 目录仍只认名字。
 */
export function looksLikeOwnUrlDir(p, name) {
  let ents
  try { ents = readdirSync(p, { withFileTypes: true }) } catch { return false }
  if (!ents.length) return /^https?/i.test(name)
  for (const e of ents) {
    if (e.isDirectory()) {
      if (!OWN_CACHE_DIRS.has(e.name)) return false
      continue
    }
    if (PROVEN_TOOL_TXT_RE.test(e.name)) continue
    if (!/^(meta\.json|.*\.lock)$/i.test(e.name)) return false
  }
  return /^https?/i.test(name)
}
