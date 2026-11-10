// CLI 侧的输出层与参数层（2026-10-31）。
//
// 放 tools/ 不放 lib/：index.js（面板）不用这一层——面板没有命令行参数，也不往 stdout 打给人看的东西。
// 放这儿是给 tools/commands 目录下那批命令文件用的：15 个 cmd 全都要 say() / opt() / flag() / track()，
// 而它们原来散在 look.mjs 的四个不相邻位置（205 / 1722 / 2165 / 3119 行）。搬命令之前得先有一份公共的。
//
// 搬运纪律：每一段都是从 look.mjs 原样切出来的，一行没改。唯一的新增是 QUIET 的读写入口——
//   ESM 的 import 绑定是只读的，别处不能写 `QUIET = true`，所以补 setQuiet() / isQuiet()。
//   语义与原来的模块级 let 完全一致：一个进程一份状态。

import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
// 2026-11-02：VALUE_OPTS 的唯一来源。lib/params.mjs 没有任何 IO 与副作用，
//   也不 import 本文件，所以不构成循环依赖。
import { VALUE_FLAG_NAMES } from '../lib/params.mjs'


// ── 6-10/6-11：失败现场记录——jget 风控页 URL+响应体前 1000 字、[track] 尾部落 last-error.json ──
const DIAG = { url: '', status: 0, body: '', at: '' }
function recordDiag(url, status, body) {
  try {
    DIAG.url = String(url || '').slice(0, 500)
    DIAG.status = Number(status) || 0
    DIAG.body = String(body || '').slice(0, 1000)
    DIAG.at = new Date().toISOString()
  } catch {}
}
const TRACK_BUF = []
// track() 与 say() 行为一致（QUIET 时走 stderr），额外把 [track] 行存进环形缓冲，失败时落 last-error.json
function track(...a) {
  try {
    const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')
    TRACK_BUF.push(line)
    if (TRACK_BUF.length > 30) TRACK_BUF.shift()
  } catch {}
  // say 在下方定义（const 箭头），运行到这里时已初始化
  say(...a)
}

// --format 输出结构化数据时，过程说明一律走 stderr，保证 stdout 能被 jq / 管道直接消费
let QUIET = false
const say = (...a) => (QUIET ? console.error : console.log)(...a)
// A3（2026-10-27）：warn() 专门给「值得让用户看见的警告」——不管 QUIET 与否，
//   永远走 stderr 且带 ⚠ 前缀。工具层（index.js）在成功分支里读 stderr，把含 ⚠ 的行拼到结果末尾。
const warn = (...a) => console.error('⚠', ...a)

// 2026-10-31：QUIET 搬进模块后，写只能走函数（import 到的 let 是只读绑定）。
export function setQuiet(v) { QUIET = Boolean(v) }
export function isQuiet() { return QUIET }

// P1（2026-10-28 全量检查）：resolve() 是纯词法变换，不做 Win32 的尾部点/空格裁剪、也不展开 NT 前缀，
//   于是 `C:\Windows.\Temp\x`、`C:\Windows \Temp\x`、`\\?\C:\Windows\Temp\x` 都能穿过黑名单，
//   而 Win32 会把它们归一成 `C:\Windows\Temp`（普通用户可写）——黑名单形同虚设。
//   现在先按 Win32 的归一规则处理（剥 NT 前缀、逐段剥尾部点/空格），再比对；同时补上 POSIX 黑名单
//   （原来全是 c:\ 开头，mac/Linux 下 `--out /etc/x` 直接放行，而插件自带 fetch-deps.sh 说明跨平台是目标场景）。
function checkOutDir(out) {
  const raw = String(out || '')
  if (!raw) return
  // 核对（2026-10-28 09:3x）：这里原来有一条「含 .. 段一律拒绝」。
  //   它把 `--out ..\out`（用户照 README「相对路径相对当前目录」写的正常用法）也一起拒了，
  //   属于我自己上一轮引入的行为回退——`resolve()` 本来就把 `..` 折叠成绝对路径，
  //   折叠完再比黑名单就够了，不需要额外的 `..` 禁令。
  const norm = (p) => String(p)
    .replace(/^[\\/]{2}[?.][\\/]/, '') // \\?\ / \\.\ 这类 NT 前缀
    .split(/[\\/]+/)
    .map((seg) => seg.replace(/[\s.]+$/, '')) // 每段尾部的点/空格：Win32 会静默吃掉
    .join('\\')
  const abs = norm(resolve(raw))
  // 任一盘符根：X:\
  if (/^[a-zA-Z]:\\?$/.test(abs)) {
    throw new Error('--out 不能指向系统目录或磁盘根，换一个普通文件夹')
  }
  const low = abs.toLowerCase()
  const blacklist = [
    'c:\\windows', 'c:\\program files (x86)', 'c:\\program files', 'c:\\programdata',
    '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys',
    '/library', '/system', '/applications', '/private/etc', '/var/root',
  ]
  for (const b of blacklist) {
    const nb = norm(b).toLowerCase()
    if (low === nb || low.startsWith(nb + '\\')) {
      throw new Error('--out 不能指向系统目录或磁盘根，换一个普通文件夹')
    }
  }
}

// ── 分发 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const cmd = argv[0]
// B33：工具层（index.js）无条件带 --quiet——此时 [track]/进度类走 say() 一律进 stderr，stdout 只留正文
if (argv.includes('--quiet')) setQuiet(true)
// 带值的选项：解析位置参数时必须跳过它们的值，否则 `hot --limit 2` 会把 "2" 当成 BV。
// 2026-11-02：改为从 lib/params.mjs 生成。原来这里手写 13 项，与 look.mjs 的
//   KNOWN_FLAGS 是两张各自维护的表 —— 结果 `at` 只进了 KNOWN_FLAGS、没进这张表，
//   于是 `frames --at 12:30 BV1xx` 里那个 12:30 被当成第一个位置参数（BV 落到了 pos[2]）。
//   两张表合成一张之后，这类「一边有一边没有」在结构上不会再有。
const VALUE_OPTS = new Set(VALUE_FLAG_NAMES)
function positional(list) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0]
      if (VALUE_OPTS.has(name) && !a.includes('=')) i++
      continue
    }
    out.push(a)
  }
  return out
}
const pos = positional(argv)
const opt = (name, dflt) => {
  // 兼容 `--name value` 与 `--name=value`（后者以前会被静默忽略，退回默认值）
  //   C290：布尔开关的同源实现见下面的 flagFromArgv —— 两处都认 `=` 形态，别只修一处。
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
// C290：--dry-run=1 被静默忽略后真删，根因是 flag() 只认独立 token 而 opt() 认 `=` 形态。
//   纯函数 flagFromArgv 可注入 argv（C292 单元判据真求值用），flag() 只是它的默认实参版本。
//   FALSY 表与 opt 的「值形态」注释同源：--dry-run=0 应真删，--permanent=0 不应永久删。
//   --quiet 不在这里：它由本文件顶层的 argv.includes('--quiet') 直接读，见 B33 那条链。
const FALSY_FLAG_VALUES = new Set(['', '0', 'false', 'no', 'off'])
function flagFromArgv(list, name) {
  for (const a of list) {
    if (a === `--${name}`) return true
    if (a.startsWith(`--${name}=`)) {
      return !FALSY_FLAG_VALUES.has(a.slice(name.length + 3).trim().toLowerCase())
    }
  }
  return false
}
const flag = (name) => flagFromArgv(argv, name)

// X-18（2026-10-29）：--format json/md 时，异常或提前退出也必须吐出可解析的 payload。
//   原来这类路径直接 console.error + process.exit(1)，stdout 0 字节，调用方 JSON.parse 直接崩
//   （连 {"ok":false} 都没有）。这里统一兜底，任何命令都能用。
function emitFailureJson(why) {
  const fmt = String(opt('format') || '').toLowerCase()
  if (fmt !== 'json' && fmt !== 'md') return false
  const payload = {
    ok: false,
    source: 'error',
    timeline: { exact: false, source: 'error' },
    text: null,
    empty: true,
    reason: 'exception',
    why: String(why ?? ''),
  }
  try {
    const body = fmt === 'md' ? ['# 失败', '', payload.why, ''].join('\n'): JSON.stringify(payload, null, 2)
    // E7-02（2026-10-30，P0）：这里原先只做 isAbsolute/join 就写盘，完全没过 checkOutDir。
    //   于是 `--out C:/Windows/Temp/x.json` 的实际行为是：
    //     抛「不能指向系统目录」→ 外层 catch 调本函数 → 本函数读同一个 opt('out') 把拒绝原因写进去
    //     → 同一条 stderr 里「✓ 已写入 C:/Windows/Temp/x.json」和「✗ 不能指向系统目录」并存，
    //       而文件真的落在系统目录里（241 B，内容就是那条拒绝原因）。
    //   失败出口必须过同一道闸；被拒就退回 stdout——数据不能丢（X-18 要求 json 模式必须有输出），
    //   但绝不能因为「反正是报错内容」就把它写进被拒绝的位置。
    const rawOut = opt('out') || ''
    let out = rawOut
    if (rawOut) {
      try { checkOutDir(rawOut) } catch { out = '' }
    }
    if (out) {
      const p = isAbsolute(out) ? out : join(process.cwd(), out)
      try { mkdirSync(dirname(p), { recursive: true }) } catch {}
      writeFileSync(p, body, 'utf8')
      process.stderr.write(`✓ 已写入 ${p}（source=error）
`)
      if (out !== rawOut) process.stderr.write(`  （--out ${rawOut} 被拒，正文改投 stdout）
`)
    } else {
      writeSync(1, body + '\n') // 同步写 fd 1：后面的 process.exit 不会把管道输出截掉
    }
    return true
  } catch { return false }
}

// 统一在这里导出，而不是给上面每一行加 export：搬运的块保持与 look.mjs 原样逐字相同，
//   diff 才能证明「一行没改」（判据：真搬运 = 新增只来自函数声明头 + 调用行 + import）。
export { DIAG, TRACK_BUF, argv, cmd, pos, opt, flag, flagFromArgv, positional, say, warn, track, recordDiag, checkOutDir, emitFailureJson }
