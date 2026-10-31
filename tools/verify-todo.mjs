#!/usr/bin/env node
/**
 * verify-todo.mjs —— T31 台账 B1–B40 的只读验收器
 *
 * 设计原则
 *  1. 只读：只 open/read 文件，不写任何东西（系统临时目录也不用）；只读跑一次 `node --check`。
 *  2. 不联网：全部静态判定，不发 HTTP、不下载、不转写。
 *  3. 不破坏现场：不 kill、不改权限、不删缓存、不动凭证。
 *  4. 三态：PASS / FAIL / SKIP，无 UNKNOWN；SKIP 必带原因。
 *  5. 判的是「代码里有没有这个守卫」——因为派单交付物就是代码。
 *
 * 用法
 *  node verify-todo.mjs [插件目录]
 *  默认插件目录 = $BILI_WATCH_DIR 或脚本所在目录的上一级（即插件根，不硬编码本机绝对路径）
 *
 * 退出码：FAIL > 0 → 1；否则 0。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
// 2026-10-31 切片 10：peek 的目录名搬进 lib/frames.mjs（纯函数）。
//   只读原则不变：import 一个纯函数不写盘，比「正则抠源码写法」更耐改，也更接近它要断的行为。
import { framesDirName, shotsDirName } from '../lib/frames.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT =
  process.argv[2] ||
  process.env.BILI_WATCH_DIR ||
  dirname(SCRIPT_DIR)

const F = {
  look: join(ROOT, 'tools/look.mjs'),
  index: join(ROOT, 'index.js'),
  pkg: join(ROOT, 'package.json'),
  readme: join(ROOT, 'README.md'),
  cordis: join(ROOT, 'cordis.patch.yml'),
  client: join(ROOT, 'client.js'),
  depsCfg: join(ROOT, 'deps/deps-config.json'),
  // 2026-10-31 切片 7：输出层（say/warn/QUIET）与参数层搬到这里，B6/B33 要看它
  cli: join(ROOT, 'tools/cli-io.mjs'),
  // 2026-10-31 切片 8（api）：jget（412 风控分支）搬进 lib/bili-api.mjs，B14 要看它
  api: join(ROOT, 'lib/bili-api.mjs'),
  // 2026-10-31 切片 9 第二步：downloadTo（B13 的 content-type 判据）与 cachedMp4（B16 的前缀）
  //   搬进 lib/media.mjs，判据要跟着搬，否则 fnBody 抠不到函数体 = 假红。
  media: join(ROOT, 'lib/media.mjs'),
}

// ── 读文件（缺失不抛，返回 null） ───────────────────────────────────────
const SRC = {}
function load(key, p) {
  try {
    SRC[key] = readFileSync(p, 'utf8')
  } catch {
    SRC[key] = null
  }
}
for (const [k, p] of Object.entries(F)) load(k, p)

if (!SRC.look && !SRC.index) {
  process.stderr.write(`找不到插件目录：${ROOT}\n`)
  process.exit(2)
}

// ── 小工具 ─────────────────────────────────────────────────────────────
const has = (s, re) => !!s && re.test(s)
const cnt = (s, re) => (s ? (s.match(re) || []).length : 0)

/** 抽顶层函数体：从 `function name(` 起，到其后第一个「行首 }」为止。
 *  不用花括号配平：函数体里的正则/字符串可能带不配对的花括号，配平会一直吃到文件尾。
 *  本仓所有顶层函数都以列 0 的 `}` 收尾，这个假设在 13 个被测函数上逐个验过。 */
function fnBody(src, name) {
  if (!src) return null
  // 2026-10-31 切片 8：允许 `export` 前缀——lib/ 下的实现都是 `export function xxx(`，
  //   原来只认「行首（可带 async）function」，于是 B14 在 jget 搬进 lib 之后报「未找到 jget()」。
  //   这个正则本身就是「先匹配再断言」的预处理，C79 直接喂合成源码验它（B5 那次就是预处理出错）。
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`)
  const m = re.exec(src)
  if (!m) return null
  const end = src.indexOf('\n}', m.index)
  return end < 0 ? null : src.slice(m.index, end + 2)
}

/** 去掉行注释与块注释，避免注释里的词被当成用户可见文案 */
// 剥注释（保留换行，行号不变）。
//
// 2026-10-31 切片 7 重写：原来先剥 /* */ 再剥 //，于是**一行 `//` 注释里只要出现 `/*`**
//   （比如「搬到 tools/commands/*.mjs」这种写法），扫描器就以为块注释开始了，
//   一路吃到下一个 `*/`——look.mjs 那次从第 67 行吃到第 304 行，把 biliCodeReason 的
//   中文文案整段吞掉，B5 于是从 PASS 变 FAIL。判据没坏，是扫描面坏了。
//   （同族问题：C41「注释里的 $repoOnly 也算」、C54「注释里的 av 19 也算」、C73「注释掉的调用也算」。）
// 现在逐字符扫：字符串（' " `）里的 // 与 /* 都不算注释起点，注释里的 /* 也不会另起一块。
// 已知不做的事：模板串里的 ${…} 当普通字符串内容处理（本仓库没有在 ${} 里写注释的写法）。
function stripComments(src) {
  if (!src) return ''
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i++
      }
      i++ // 吃掉 '/'
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i]; i++ }
        if (i < src.length) out += src[i]
        i++
      }
      if (i < src.length) out += src[i]
      continue
    }
    out += c
  }
  return out
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length
}

/** 找第一处命中的行号，便于证据里写位置 */
function findLine(src, re) {
  if (!src) return -1
  const m = re.exec(src)
  return m ? lineOf(src, m.index) : -1
}

// ── 结果收集 ───────────────────────────────────────────────────────────
const ROWS = []
function add(id, name, status, evidence) {
  ROWS.push({ id, name, status, evidence: String(evidence).replace(/\s+/g, ' ').trim() })
}
function ok(id, name, ev) {
  add(id, name, 'PASS', ev)
}
function bad(id, name, ev) {
  add(id, name, 'FAIL', ev)
}
function skip(id, name, ev) {
  add(id, name, 'SKIP', ev)
}

/** 统一包装：任何异常都判 FAIL 并带出错误，绝不产生 UNKNOWN */
function guard(id, name, fn) {
  try {
    fn()
  } catch (e) {
    add(id, name, 'FAIL', `检查器自身异常：${e && e.message ? e.message : e}`)
  }
}

const LOOK = SRC.look
const INDEX = SRC.index
const CLI = SRC.cli
const PKG = (() => {
  try {
    return JSON.parse(SRC.pkg || '{}')
  } catch {
    return null
  }
})()

// 切片 1（2026-10-31）：cleanKey/bvOf/cutCp/looksLikeOwnUrlDir 已搬到 lib/keys.mjs。
//   这里 import 真跑，与 verify.mjs 的 C7 同口径；搬家未生效（lib 缺失）时置 null，B3 自行降级。
let libKeys = null
try {
  libKeys = await import(pathToFileURL(join(ROOT, 'lib/keys.mjs')).href)
} catch {
  libKeys = null
}

// ══════════════════════════════════════════════════════════════════════
// B1  11-11  deps-config.json 硬编码本机 ffmpeg 路径
// ══════════════════════════════════════════════════════════════════════
guard('B1', '11-11 deps-config 硬编码本机路径', () => {
  if (!SRC.depsCfg) return ok('B1', '11-11 deps-config 硬编码本机路径', 'deps/deps-config.json 不存在（无本机路径可泄露）')
  const abs = SRC.depsCfg.match(/"[A-Za-z]:[\\/]{1,2}[^"]*"/g) || []
  // 2026-10-30（用户要求全面清查本机泄漏）：这里原来还单独匹配本机另一个项目的名字。
  //   那个名字本身就是本机概念，而且「盘符绝对路径」这一条已经覆盖了它要防的东西——
  //   名字只是顺带暴露，路径才是根因。去掉名字匹配，保留路径匹配。
  // 台账判据第二半：这个文件不能被 git 跟踪（否则随仓库泄露）。只跑只读的 git ls-files。
  let tracked = null
  try {
    const g = spawnSync('git', ['ls-files', '--', 'deps/deps-config.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
    })
    if (g.status === 0) tracked = (g.stdout || '').trim().length > 0
  } catch {
    tracked = null
  }
  const parts = []
  if (abs.length) parts.push(`${abs.length} 条盘符绝对路径：${abs.slice(0, 2).join(' ')}`)
  if (tracked === true) parts.push('且该文件已被 git 跟踪（git ls-files 命中）')
  if (parts.length === 0)
    return ok(
      'B1',
      '11-11 deps-config 硬编码本机路径',
      `无盘符绝对路径${tracked === false ? '，且未被 git 跟踪' : '（git 状态未取到）'}`,
    )
  bad('B1', '11-11 deps-config 硬编码本机路径', parts.join('；'))
})

// ══════════════════════════════════════════════════════════════════════
// B2  11-10  package.json files 漏 README.md
// ══════════════════════════════════════════════════════════════════════
guard('B2', '11-10 files 漏 README.md', () => {
  const files = (PKG && PKG.files) || []
  if (!Array.isArray(files)) return bad('B2', '11-10 files 漏 README.md', 'package.json 无 files 数组')
  if (files.includes('README.md'))
    return ok('B2', '11-10 files 漏 README.md', `files 含 README.md（共 ${files.length} 项）`)
  bad('B2', '11-10 files 漏 README.md', `files 里 README.md 出现 0 次（共 ${files.length} 项）`)
})

// ══════════════════════════════════════════════════════════════════════
// B3  15-9  cleanKey 不挡「带后缀」的 Windows 保留名（con.txt）
// ══════════════════════════════════════════════════════════════════════
guard('B3', '15-9 cleanKey 带后缀保留名', () => {
  if (!libKeys || !libKeys.cleanKey)
    return bad('B3', '15-9 cleanKey 带后缀保留名', 'lib/keys.mjs 未找到或 cleanKey 未导出（切片 1 搬家未生效？）')
  const ck = libKeys.cleanKey
  // 台账 15-9：旧实现只挡裸保留名 con，放行 con.txt / NUL.ini（Windows 上仍是设备名）。
  //   新实现按去扩展名后的 base 判，应连后缀一起压成 _misc；普通名不可误伤。
  const cases = [
    ['con', '_misc', '裸保留名'],
    ['con.txt', '_misc', '带 .txt 后缀的保留名'],
    ['NUL.ini', '_misc', '带 .ini 后缀的保留名（大小写不敏感）'],
    ['com1', '_misc', 'com 系保留名'],
    ['prn.json', '_misc', 'prn 带后缀'],
    ['config', 'config', '普通名不应被误伤'],
  ]
  for (const [inp, want, why] of cases) {
    const got = ck(inp)
    if (got !== want)
      return bad(
        'B3',
        '15-9 cleanKey 带后缀保留名',
        `cleanKey(${JSON.stringify(inp)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}（${why}）`,
      )
  }
  ok('B3', '15-9 cleanKey 带后缀保留名', `${cases.length} 条对抗输入：裸保留名 + 带后缀保留名均压成 _misc，普通名不误伤`)
})

// ══════════════════════════════════════════════════════════════════════
// B4  8-13  小写 bv 前缀不识别（BV 正则缺 i 标志）
// ══════════════════════════════════════════════════════════════════════
guard('B4', '8-13 小写 bv 不识别', () => {
  // 只算「面向用户输入」的匹配：不带 ^...$ 锚点。
  // 带锚点的多是归一化之后的校验器（entry.bv、q[1]），它们不负责识别小写输入。
  const bare = []
  const anchored = []
  for (const [name, s] of [['look.mjs', LOOK], ['index.js', INDEX]]) {
    if (!s) continue
    const r = /\/\^?(BV)\[0-9A-Za-z\]\{10\}(\$)?\/([a-z]*)/g
    let m
    while ((m = r.exec(s))) {
      const flags = m[3] || ''
      if (flags.includes('i')) continue
      const tag = `${name}:${lineOf(s, m.index)}`
      if (m[2]) anchored.push(tag)
      else bare.push(tag)
    }
  }
  if (bare.length === 0)
    return ok('B4', '8-13 小写 bv 不识别', `面向输入的 BV 正则都带 i 标志（另有 ${anchored.length} 处归一化校验器不带 i，不影响）`)
  bad(
    'B4',
    '8-13 小写 bv 不识别',
    `面向输入的 BV 正则缺 i 标志 ${bare.length} 处：${bare.join('、')}（另有 ${anchored.length} 处归一化校验器不带 i）`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B5  9-3  视频不存在只抛裸 code
// ══════════════════════════════════════════════════════════════════════
guard('B5', '9-3 视频不存在无中文', () => {
  // 先剥注释：注释里出现「不可见」不算用户可见文案
  const code = stripComments(LOOK)
  const zh = /视频不存在|稿件[^`'\n]{0,6}(不存在|已删)|已删除|视频已失效/
  const m = zh.exec(code)
  if (m) return ok('B5', '9-3 视频不存在无中文', `存在中文文案「${m[0]}」（代码区，非注释）`)
  bad('B5', '9-3 视频不存在无中文', '剥掉注释后，代码区无「视频不存在/已删除/视频已失效」文案；-404 只回裸 code')
})

// ══════════════════════════════════════════════════════════════════════
// B6  2-11  sub 坏格式时错误写进 stdout
// ══════════════════════════════════════════════════════════════════════
guard('B6', '2-11 sub 坏格式错误进 stdout', () => {
  const body = fnBody(LOOK, 'cmdSub')
  if (!body) return bad('B6', '2-11 sub 坏格式错误进 stdout', '未找到 cmdSub()')
  // 切片 7：QUIET 的赋值搬成 setQuiet(...)，判据跟着改，含义不变
  const q = /setQuiet\(opts\.format\s*===\s*'srt'/.exec(body)
  const badFmt = /say\(\s*`?✗ 不认识的 --format/.exec(body)
  if (!badFmt) return ok('B6', '2-11 sub 坏格式错误进 stdout', '坏格式分支已不存在或已改走 stderr')
  if (!q) return bad('B6', '2-11 sub 坏格式错误进 stdout', 'cmdSub 不再按 format 设 QUIET，通道不明')
  bad(
    'B6',
    '2-11 sub 坏格式错误进 stdout',
    'QUIET 只对 srt/json/md/txt 置 true；--format bad 时 QUIET=false，say() 走 console.log → 错误进 stdout',
  )
})

// ══════════════════════════════════════════════════════════════════════
// B7  2-26  text --out 不带 --format 被静默忽略
// ══════════════════════════════════════════════════════════════════════
guard('B7', '2-26 text --out 无 format 静默', () => {
  const body = fnBody(LOOK, 'cmdText')
  if (!body) return bad('B7', '2-26 text --out 无 format 静默', '未找到 cmdText()')
  if (/opts\.out/.test(body)) return ok('B7', '2-26 text --out 无 format 静默', 'cmdText 里处理了 opts.out')
  const sub = fnBody(LOOK, 'cmdSub')
  const subHasGuard = sub && /--out 要配合 --format/.test(sub)
  // CLI 侧已经把 --out 解析出来传进 cmdText 了，所以不是「没解析」，是「传进去没人用」
  // 注意不能写 cmdText\([^)]*：参数对象里就有 flag('fast') 这类括号，[^)]* 会提前截断
  const cliPass = /cmdText\([\s\S]{0,400}?out:\s*opt\('out'\)/.test(LOOK || '')
  bad(
    'B7',
    '2-26 text --out 无 format 静默',
    `cmdText 内 0 次 opts.out${cliPass ? '（CLI 侧已把 out 传进来，传进去没人用）' : ''}${
      subHasGuard ? '；cmdSub 有「--out 要配合 --format」拦截，text 没有' : ''
    }；emitText 两条分支都 return false → printText 忽略 --out`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B8  2-17  [text] 前缀硬编码，asr/ocr 也打 [text]
// ══════════════════════════════════════════════════════════════════════
guard('B8', '2-17 [text] 前缀硬编码', () => {
  const body = fnBody(LOOK, 'printText')
  if (!body) return bad('B8', '2-17 [text] 前缀硬编码', '未找到 printText()')
  const n = cnt(body, /\[text\]/g)
  if (n === 0) return ok('B8', '2-17 [text] 前缀硬编码', 'printText 内无 [text] 字面，已按 kind 生成')
  // 决定性判断：[text] 那两行是否被 kind 取代。kind 目前只用于落盘文件名与 warnForeign 标签。
  const labelByKind = /`\[\$\{kind\}\]/.test(body)
  bad(
    'B8',
    '2-17 [text] 前缀硬编码',
    `printText 内 [text] 字面 ${n} 处（--full 与 --head 两条分支），${labelByKind ? '另有按 kind 生成的分支' : 'kind 只用于落盘文件名，摘要行标签恒为 [text]'}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B9  8-2  /bili hint 漏列 flag
// ══════════════════════════════════════════════════════════════════════
guard('B9', '8-2 hint 漏列 flag', () => {
  const hintM = /hint:\s*'([^']*)'/.exec(INDEX || '')
  if (!hintM) return bad('B9', '8-2 hint 漏列 flag', '未找到 hint 字符串')
  const hint = hintM[1]
  const body = fnBody(INDEX, 'parseCommandLine')
  if (!body) return bad('B9', '8-2 hint 漏列 flag', '未找到 parseCommandLine()')
  const flags = new Set()
  const r = /'--([A-Za-z][A-Za-z0-9-]*)'/g
  let m
  while ((m = r.exec(body))) flags.add(m[1])
  const missing = [...flags].filter((f) => !hint.includes(`--${f}`))
  if (missing.length === 0)
    return ok('B9', '8-2 hint 漏列 flag', `hint 覆盖解析器全部 ${flags.size} 个 flag`)
  bad(
    'B9',
    '8-2 hint 漏列 flag',
    `解析器支持 ${flags.size} 个 flag，hint 缺 ${missing.length} 个：${missing.map((f) => '--' + f).join(' ')}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B10  8-1  /bili search 缺参说成「缺少 BV 号」
// ══════════════════════════════════════════════════════════════════════
// 这条有两条入口，必须分开判：斜杠命令走 lookup()，模型工具走 apply() 里的 execute。
// 只看其中一条会得出「已修」或「没修」的错误结论。
guard('B10', '8-1 search 缺参说成 BV', () => {
  const src = INDEX || ''
  const slash = fnBody(src, 'lookup') || ''
  // 斜杠入口：`!['clean','login','hot'].includes(command) && !bv` —— 白名单里有没有 search
  const m = /!\s*\[([^\]]*)\]\s*\.includes\(\s*command\s*\)/.exec(slash)
  const whitelist = m ? m[1].replace(/[\s'"]+/g, '') : ''
  const slashFixed = /search/.test(whitelist)
  // 工具入口：`args.command === 'search' && !target` + 专属提示
  const toolGuard = /args\.command\s*===\s*'search'[^\n]{0,80}!target/.test(src)
  const toolMsg = /search[^\n]{0,16}(需要|缺少)[^\n]{0,10}(keyword|关键词)/.test(src)

  if (slashFixed && toolGuard && toolMsg)
    return ok('B10', '8-1 search 缺参说成 BV', '两条入口都按命令区分：斜杠白名单含 search，工具层报「search 需要 keyword」')
  const parts = []
  parts.push(
    slashFixed
      ? '斜杠入口已修'
      : `斜杠入口 lookup 的白名单仍是 [${whitelist || '?'}]，search 缺参仍报「缺少 BV 号」`,
  )
  parts.push(toolGuard && toolMsg ? '工具入口已修（「search 需要 keyword 参数」）' : '工具入口也未修')
  bad('B10', '8-1 search 缺参说成 BV', parts.join('；') + ' → 两条入口不一致')
})

// ══════════════════════════════════════════════════════════════════════
// B11  2-7  trimForModel 把长 JSON 从中间砍断
// ══════════════════════════════════════════════════════════════════════
guard('B11', '2-7 trimForModel 砍坏 JSON', () => {
  const body = fnBody(INDEX, 'trimForModel')
  if (!body) return bad('B11', '2-7 trimForModel 砍坏 JSON', '未找到 trimForModel()')
  if (/JSON\.parse|format\s*===\s*'json'|jsonMode/i.test(body))
    return ok('B11', '2-7 trimForModel 砍坏 JSON', 'trimForModel 内已有 JSON 感知分支')
  bad(
    'B11',
    '2-7 trimForModel 砍坏 JSON',
    `trimForModel 只按字符 slice(0, TOOL_TEXT_HEAD)，无 JSON 感知；JSON 中段被切断`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B12  3-12  ASR 缓存 key 不含 cid
// ══════════════════════════════════════════════════════════════════════
guard('B12', '3-12 缓存 key 不含 cid', () => {
  const body = fnBody(LOOK, 'transcribe')
  if (!body) return bad('B12', '3-12 缓存 key 不含 cid', '未找到 transcribe()')
  const cacheLine = /const\s+cacheTxt\s*=\s*([^\n]*)/.exec(body)
  if (!cacheLine) return bad('B12', '3-12 缓存 key 不含 cid', '未找到 cacheTxt 定义')
  if (/cid/.test(cacheLine[1]))
    return ok('B12', '3-12 缓存 key 不含 cid', `缓存名含 cid：${cacheLine[1].trim()}`)
  bad('B12', '3-12 缓存 key 不含 cid', `缓存名不含 cid：${cacheLine[1].trim()}（换源后仍命中旧转写）`)
})

// ══════════════════════════════════════════════════════════════════════
// B13  9-15  downloadTo 不判 content-type，风控 HTML 被当直链
// ══════════════════════════════════════════════════════════════════════
guard('B13', '9-15 风控 HTML 当直链', () => {
  // 2026-10-31 切片 9 第二步：downloadTo 搬进 lib/media.mjs（入口知识走参数：headers/maxBytes/onNetError）。
  //   判据跟着搬到实现处，并加一条「look.mjs 不许再留第二份」——留了就是两处判据，迟早不同步。
  const body = fnBody(SRC.media || '', 'downloadTo')
  if (!body) return bad('B13', '9-15 风控 HTML 当直链', '未找到 downloadTo()（lib/media.mjs）')
  if (/async function downloadTo|export async function downloadTo/.test(LOOK || ''))
    return bad('B13', '9-15 风控 HTML 当直链', 'look.mjs 又定义了一份 downloadTo——content-type 判据会分成两份')
  if (/content-type/i.test(body)) return ok('B13', '9-15 风控 HTML 当直链', 'downloadTo 有 content-type 判定')
  bad(
    'B13',
    '9-15 风控 HTML 当直链',
    'downloadTo 只判 r.ok / content-length / 最小 1 KB，无 content-type；HTTP 200 的 HTML 会被存成 mp4',
  )
})

// ══════════════════════════════════════════════════════════════════════
// B14  9-2  412 风控无中文提示，且静默降级 ASR
// ══════════════════════════════════════════════════════════════════════
guard('B14', '9-2 412 无提示且降级 ASR', () => {
  // 2026-10-31 切片 8（api）：jget 搬进 lib/bili-api.mjs。判据同时盯两处——
  //   实现处要有 412 分支，look.mjs 不许再留一份自己的实现（留了就是两处判据，迟早不同步）。
  const body = fnBody(SRC.api || '', 'jget')
  if (!body) return bad('B14', '9-2 412 无提示且降级 ASR', '未找到 jget()（lib/bili-api.mjs）')
  if (/async function jget[(]/.test(LOOK || '')) return bad('B14', '9-2 412 无提示且降级 ASR', 'look.mjs 又定义了一份 jget——412 判据会分成两份')
  const has412 = /412/.test(body)
  if (has412) return ok('B14', '9-2 412 无提示且降级 ASR', '代码里出现 412 分支')
  bad(
    'B14',
    '9-2 412 无提示且降级 ASR',
    'jget 对 !r.ok 一律 return {code:-status}，全文无 412/风控分支；cmdText 不看 code 直接继续走 ASR',
  )
})

// ══════════════════════════════════════════════════════════════════════
// B15  15-7  slugTitle 不处理尾部点号 / 代理对
// ══════════════════════════════════════════════════════════════════════
guard('B15', '15-7 slugTitle 尾点与 emoji', () => {
  const body = fnBody(LOOK, 'slugTitle')
  if (!body) return bad('B15', '15-7 slugTitle 尾点与 emoji', '未找到 slugTitle()')
  const tail = /replace\(\s*\/\[[^\]]*\.\][^/]*\$/.test(body) || /replace\(\s*\/\\\.\+\$\//.test(body)
  const safeSlice = /Array\.from|\[\.\.\.|codePointAt/.test(body)
  if (tail && safeSlice) return ok('B15', '15-7 slugTitle 尾点与 emoji', '已去尾点且按码点截断')
  bad(
    'B15',
    '15-7 slugTitle 尾点与 emoji',
    `${tail ? '' : '无尾点/尾空格剥离；'}${safeSlice ? '' : 'slice(0,20) 按 UTF-16 切，emoji 代理对会被切半'}`.replace(/^；/, ''),
  )
})

// ══════════════════════════════════════════════════════════════════════
// B16  4-3  peek 与 frames 各下一份 mp4
// ══════════════════════════════════════════════════════════════════════
guard('B16', '4-3 peek/frames 各下一份 mp4', () => {
  // 2026-10-31 切片 10：peek 的目录名搬进 lib/frames.mjs 的 shotsDirName（纯函数，import 即真跑）。
  //   原来这条判据是「正则抠 look.mjs 里 join(cacheDir(),'frames',`…`) 这个写法」——
  //   写法一改就假红（今晚第 N 次同族），而它要断的行为其实很具体：
  //   peek 的目录名必须落在 cachedMp4 认的 `<BV>-p<page>-` 前缀里，
  //   否则 frames 永远复用不到 peek 下载的那份 mp4，两个命令各下一份。
  const peekDir = shotsDirName('BV1aaaaaaaaa', 2)
  const cache = fnBody(SRC.media || '', 'cachedMp4')
  if (!cache) return bad('B16', '4-3 peek/frames 各下一份 mp4', '未找到 cachedMp4()（lib/media.mjs）')
  const cachePrefix = /startsWith\(`([^`]*)`\)/.exec(cache)
  if (!cachePrefix)
    return bad('B16', '4-3 peek/frames 各下一份 mp4', 'cachedMp4 前缀未识别，需人工看')
  // 把前缀模板换成真实目录名（`${bv}` → BV1aaaaaaaaa，`${page}` → 2），再问「这个目录名落在前缀里吗」
  const real = cachePrefix[1].replace(/\$\{bv\}/g, 'BV1aaaaaaaaa').replace(/\$\{page\}/g, '2')
  if (!peekDir.startsWith(real))
    return bad(
      'B16',
      '4-3 peek/frames 各下一份 mp4',
      `peek 落在 "${peekDir}"，cachedMp4 只认 "${real}" → peek 的 mp4 永不被 frames 复用，各下一份`,
    )
  // frames 自己的目录名也得落在同一前缀里：它把自己的 mp4 放在那儿，
  // cachedMp4 找不回来就等于白下（这正是这条判据要防的「各下一份」）
  const fdir = framesDirName('BV1aaaaaaaaa', 2, '5s')
  if (!fdir.startsWith(real))
    return bad('B16', '4-3 peek/frames 各下一份 mp4', `frames 目录 "${fdir}" 不在 cachedMp4 的前缀 "${real}" 里`)
  // 目录构造不许在 look.mjs 里再抄一份（抄一份就迟早分叉）
  if (/join\(\s*(?:CACHE|cacheDir\(\))\s*,\s*'frames'/.test(LOOK || ''))
    return bad('B16', '4-3 peek/frames 各下一份 mp4', 'look.mjs 又自己拼了 frames 目录——目录模板会分成两份')
  ok('B16', '4-3 peek/frames 各下一份 mp4', `peek 目录 "${peekDir}" 与 frames 目录 "${fdir}" 都能被 cachedMp4 的前缀 "${real}" 命中`)
})

// ══════════════════════════════════════════════════════════════════════
// B17  4-4  360p mp4 用完不删
// ══════════════════════════════════════════════════════════════════════
guard('B17', '4-4 mp4 用完不删', () => {
  const bodies = [fnBody(LOOK, 'peekFrames'), fnBody(LOOK, 'grabFrames')].filter(Boolean)
  if (!bodies.length) return bad('B17', '4-4 mp4 用完不删', '未找到抽帧函数')
  const del = bodies.some((b) => /(unlinkSync|rmSync)\([^)]*mp4/i.test(b))
  if (del) return ok('B17', '4-4 mp4 用完不删', '抽帧后删除了 mp4')
  bad(
    'B17',
    '4-4 mp4 用完不删',
    'peekFrames / grabFrames 内无针对 mp4 的 unlinkSync/rmSync；只删 jpg（fresh 分支）',
  )
})

// ══════════════════════════════════════════════════════════════════════
// B18  3-3  无内存/时长预判，5 分半视频 mkl_malloc 崩
// ══════════════════════════════════════════════════════════════════════
guard('B18', '3-3 无内存预判', () => {
  if (has(LOOK, /freemem|totalmem/))
    return ok('B18', '3-3 无内存预判', '存在 freemem/totalmem 探测')
  const gate = /asrReady\(\)\s*&&\s*v\.dur\s*>\s*(\d+)/.exec(LOOK || '')
  bad(
    'B18',
    '3-3 无内存预判',
    `全文无 freemem/totalmem；只有时长闸${gate ? `（asrReady() && v.dur > ${gate[1]}，第 ${lineOf(LOOK, gate.index)} 行）` : ''}，5 分钟以上到该阈值之间的片子仍会进 ASR`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B19  2-10  --out 相对路径落到进程 cwd
// ══════════════════════════════════════════════════════════════════════
guard('B19', '2-10 --out 落 cwd', () => {
  const body = fnBody(LOOK, 'emitTextJson')
  if (!body) return bad('B19', '2-10 --out 落 cwd', '未找到 emitTextJson()')
  if (/isAbsolute|resolve\(|join\(CACHE/.test(body))
    return ok('B19', '2-10 --out 落 cwd', 'emitTextJson 对 out 做了绝对化/落到 CACHE')
  // 工具层已经加了「只收工作区内相对路径」的闸，所以绝对路径那条已被挡；
  // 剩下的问题是相对路径以 DSH 进程 cwd 为基准，不落在缓存目录，clean 清不掉。
  const toolGate = /只接受工作区内的相对路径/.test(INDEX || '')
  bad(
    'B19',
    '2-10 --out 落 cwd',
    `emitTextJson 直接 writeFileSync(opts.out)，未 resolve/isAbsolute → 相对路径以进程 cwd 为基准，clean 清不掉${
      toolGate ? '；工具层虽已挡掉绝对路径/盘符/..（index.js「只接受工作区内的相对路径」），相对路径这条没管' : ''
    }`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B20  2-12  空结果与出错不可分
// ══════════════════════════════════════════════════════════════════════
guard('B20', '2-12 空结果与出错不可分', () => {
  const body = fnBody(LOOK, 'printText')
  if (!body) return bad('B20', '2-12 空结果与出错不可分', '未找到 printText()')
  const silent = /if\s*\(\s*!full\s*\)\s*return/.test(body)
  const emptyFlag = /empty\s*:\s*true|empty:true/.test(LOOK || '')
  if (!silent && emptyFlag) return ok('B20', '2-12 空结果与出错不可分', '空文本已带 empty:true')
  bad(
    'B20',
    '2-12 空结果与出错不可分',
    `${silent ? 'printText 空文本 if (!full) return，无任何标记；' : ''}${emptyFlag ? '' : '全文无 empty:true'}→ 空结果与出错都是 rc 非 0 + 空 stdout`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B21  15-1  首跑三项降级全静默
// ══════════════════════════════════════════════════════════════════════
guard('B21', '15-1 首跑无合并提示', () => {
  const body = fnBody(LOOK, 'cmdText')
  if (!body) return bad('B21', '15-1 首跑无合并提示', '未找到 cmdText()')
  const preflight = /ffmpeg[^`'\n]{0,40}asr[^`'\n]{0,40}ocr/i.test(body) || /preflight|checkDeps/i.test(LOOK || '')
  if (preflight) return ok('B21', '15-1 首跑无合并提示', 'cmdText 开头有合并式依赖预检')
  bad(
    'B21',
    '15-1 首跑无合并提示',
    'cmdText 只有三条独立 [track] skip，无合并提示；缺依赖时一路静默到兜底抽帧',
  )
})

// ══════════════════════════════════════════════════════════════════════
// B22  5-13  落盘无 tmp+rename
// ══════════════════════════════════════════════════════════════════════
guard('B22', '5-13 落盘无 tmp+rename', () => {
  const wm = fnBody(LOOK, 'writeMeta')
  const pt = fnBody(LOOK, 'printText')
  if (!wm) return bad('B22', '5-13 落盘无 tmp+rename', '未找到 writeMeta()')
  const atomic = (b) => b && /\.tmp|\.part|renameSync/.test(b)
  if (atomic(wm) && atomic(pt))
    return ok('B22', '5-13 落盘无 tmp+rename', 'writeMeta 与 printText 都走 tmp+rename')
  bad(
    'B22',
    '5-13 落盘无 tmp+rename',
    `${atomic(wm) ? '' : 'writeMeta 直接 writeFileSync(meta.json)；'}${atomic(pt) ? '' : 'printText 直接 writeFileSync(<kind>.txt)'}；Ctrl-C 留半截`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B23  11-5  dsh-llm 未声明 peerDep
// ══════════════════════════════════════════════════════════════════════
guard('B23', '11-5 dsh-llm 未声明 peerDep', () => {
  const peer = (PKG && PKG.peerDependencies) || {}
  const imported = has(INDEX, /@deepseek-ai\/dsh-llm/)
  if (peer['@deepseek-ai/dsh-llm'])
    return ok('B23', '11-5 dsh-llm 未声明 peerDep', 'peerDependencies 已含 @deepseek-ai/dsh-llm')
  bad(
    'B23',
    '11-5 dsh-llm 未声明 peerDep',
    `index.js ${imported ? '有' : '无'}动态 import dsh-llm；peerDependencies 只有 ${Object.keys(peer).join('、') || '（空）'}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B24  11-7  peerDep 允许 rc.1
// ══════════════════════════════════════════════════════════════════════
guard('B24', '11-7 peerDep 允许 rc.1', () => {
  const peer = (PKG && PKG.peerDependencies) || {}
  const hits = Object.entries(peer).filter(([, v]) => String(v).includes('rc.1'))
  if (hits.length === 0) return ok('B24', '11-7 peerDep 允许 rc.1', 'peerDependencies 内无 rc.1')
  bad(
    'B24',
    '11-7 peerDep 允许 rc.1',
    `${hits.length} 条范围含 rc.1：${hits.map(([k, v]) => `${k}=${v}`).join('；')}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B25  10-1  README sub --format 漏 txt
// ══════════════════════════════════════════════════════════════════════
guard('B25', '10-1 README sub 漏 txt', () => {
  const line = (SRC.readme || '').split('\n').find((l) => l.includes('sub <BV'))
  if (!line) return bad('B25', '10-1 README sub 漏 txt', 'README 未找到 sub 命令行')
  const codeHasTxt = /format\s*===\s*'txt'/.test(LOOK || '') || /\|txt\|/.test(LOOK || '')
  if (/\btxt\b/.test(line)) return ok('B25', '10-1 README sub 漏 txt', 'README sub 行含 txt')
  bad(
    'B25',
    '10-1 README sub 漏 txt',
    `README 行只列 srt|json|md${codeHasTxt ? '；代码确实支持 txt' : ''}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B26  10-2  README search 漏 --limit / --order
// ══════════════════════════════════════════════════════════════════════
guard('B26', '10-2 README search 漏参数', () => {
  const line = (SRC.readme || '').split('\n').find((l) => l.includes('search <关键词>'))
  if (!line) return bad('B26', '10-2 README search 漏参数', 'README 未找到 search 命令行')
  const miss = ['--limit', '--order'].filter((f) => !line.includes(f))
  if (miss.length === 0) return ok('B26', '10-2 README search 漏参数', 'README search 行含 --limit 与 --order')
  bad('B26', '10-2 README search 漏参数', `README search 行缺 ${miss.join(' 与 ')}`)
})

// ══════════════════════════════════════════════════════════════════════
// B27  10-3  README 落盘路径写成 <BV>/
// ══════════════════════════════════════════════════════════════════════
guard('B27', '10-3 README 落盘路径错', () => {
  const m = /<缓存目录>\/<BV>\//.exec(SRC.readme || '')
  const hasRename = /BV>_<|BV>_\{|<BV>_/.test(SRC.readme || '')
  if (!m) return ok('B27', '10-3 README 落盘路径错', 'README 未再写 <缓存目录>/<BV>/')
  bad(
    'B27',
    '10-3 README 落盘路径错',
    `README:${lineOf(SRC.readme, m.index)} 仍写 <缓存目录>/<BV>/<命令>.txt${hasRename ? '' : '；代码 nameVideoDir 会改名成 <BV>_<标题>'}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B28  10-4  README ffmpeg 查找顺序漏 deps-config
// ══════════════════════════════════════════════════════════════════════
guard('B28', '10-4 README ffmpeg 顺序漏项', () => {
  const m = /`ffmpeg` 查找顺序：([^\n]*)/.exec(SRC.readme || '')
  if (!m) return bad('B28', '10-4 README ffmpeg 顺序漏项', 'README 未找到 ffmpeg 查找顺序段')
  if (/deps-config/.test(m[1])) return ok('B28', '10-4 README ffmpeg 顺序漏项', '顺序里含 deps-config.json')
  const codeHas = /depsCfg\(\)\.ffmpeg|depsCfg\.ffmpeg/.test(INDEX || '') || /depsCfg\.ffmpeg/.test(LOOK || '')
  bad(
    'B28',
    '10-4 README ffmpeg 顺序漏项',
    `README 写「${m[1].trim()}」${codeHas ? '；代码 ffmpegCands() 中间还有 deps-config.json 的 ffmpeg 槽位' : ''}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B29  10-6  README 把关键词命中率写成独立触发条件
// ══════════════════════════════════════════════════════════════════════
guard('B29', '10-6 README 反钓鱼判据错', () => {
  const readme = SRC.readme || ''
  const look = LOOK || ''
  // 代码侧事实：关键词命中率只在语速也异常时才作补充（baitSignals 里是 `speedBad && …`）
  const codeConditional = /speedBad\s*&&/.test(look)
  // ① 旧错法：把「关键词命中不到 N%」写成独立条件
  const oldBad = /关键词命中不到\s*\d+%/.exec(readme)
  if (oldBad) {
    const line = readme.split('\n').find((l) => l.includes('关键词命中不到')) || ''
    if (!/且|同时|配合|只在|才/.test(line) && codeConditional) {
      return bad(
        'B29',
        '10-6 README 反钓鱼判据错',
        `README 把「${oldBad[0]}」列为独立触发条件；代码里关键词命中率只在语速也异常时才用`,
      )
    }
  }
  // ② 2026-10-29 新增：用「多重核对 / 三重检查」这类并列措辞暗示多项独立（换措辞绕不过去）
  const parallel = /多重核对|多重检查|三重核对|三重检查/.exec(readme)
  if (parallel && codeConditional) {
    const line = readme.split('\n').find((l) => l.includes(parallel[0])) || ''
    return bad(
      'B29',
      '10-6 README 反钓鱼判据错',
      `README 用「${parallel[0]}」暗示多项并列，但代码里关键词判据是条件触发（${line.trim().slice(0, 40)}）`,
    )
  }
  return ok('B29', '10-6 README 反钓鱼判据错', 'README 无「关键词命中不到 N%」独立条件、无并列措辞')
})

// ══════════════════════════════════════════════════════════════════════
// B30  10-10  %TEMP% / 系统临时目录 残留
// ══════════════════════════════════════════════════════════════════════
guard('B30', '10-10 %TEMP% 残留文案', () => {
  const hits = []
  for (const [k, s] of [['look.mjs', LOOK], ['client.js', SRC.client]]) {
    if (!s) continue
    let m
    const r = /%TEMP%|系统临时目录/g
    while ((m = r.exec(s))) hits.push(`${k}:${lineOf(s, m.index)}`)
  }
  if (hits.length === 0) return ok('B30', '10-10 %TEMP% 残留文案', '零命中')
  bad('B30', '10-10 %TEMP% 残留文案', `${hits.length} 处命中：${hits.join('、')}`)
})

// ══════════════════════════════════════════════════════════════════════
// B31  2-16  --head 超全文时提示撒谎
// ══════════════════════════════════════════════════════════════════════
guard('B31', '2-16 --head 提示撒谎', () => {
  const body = fnBody(LOOK, 'printText')
  if (!body) return bad('B31', '2-16 --head 提示撒谎', '未找到 printText()')
  const clamp = /Math\.min\(\s*head\s*,/.test(body) || /Math\.min\(\s*Number\(opts\.head\)/.test(body)
  if (clamp) return ok('B31', '2-16 --head 提示撒谎', 'head 已按全文长度夹紧')
  bad(
    'B31',
    '2-16 --head 提示撒谎',
    'head 未与 full.length 取 min，slice(0, head) 后仍打「这里给前 ${head} 字」；head > 全文时是假话',
  )
})

// ══════════════════════════════════════════════════════════════════════
// B32  2-15  --head 负数/非数字被静默吞
// ══════════════════════════════════════════════════════════════════════
guard('B32', '2-15 --head 负数静默', () => {
  const body = fnBody(LOOK, 'printText')
  if (!body) return bad('B32', '2-15 --head 负数静默', '未找到 printText()')
  const silent = /Number\(opts\.head\)\s*>\s*0\s*\?\s*Number\(opts\.head\)\s*:\s*0/.test(body)
  const validate = /--head[^`'\n]{0,30}(正整数|必须|无效)|head 需要/.test(LOOK || '')
  if (!silent && validate) return ok('B32', '2-15 --head 负数静默', 'head 有显式校验与报错')
  bad(
    'B32',
    '2-15 --head 负数静默',
    `${silent ? 'Number(opts.head) > 0 ? … : 0 —— 负数/NaN 静默归 0；' : ''}${validate ? '' : '全文无「--head 需要正整数」类校验'}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B33  2-27  进度行混进工具 stdout
// ══════════════════════════════════════════════════════════════════════
guard('B33', '2-27 进度行进 stdout', () => {
  // 2026-10-26 DSH 拍板（不是迁就）：判定器三分支全 bad、无 ok 路径是脚本 bug，补三条真判据。
  // 三条同时成立才 PASS：① look.mjs 解析 --quiet 且置 QUIET=true；② say() 在 QUIET 时走 console.error；
  // ③ index.js 工具层 execute 无条件下发 --quiet。缺哪条在证据里写明。
  const misses = []
  // 切片 7：这三样本事都在 tools/cli-io.mjs 里了（look.mjs 只剩 import）。
  //   多加一条「look.mjs 不许自己再定义 say」——否则搬出去之后有人补一份本地实现，
  //   两条判据都还是绿的，QUIET 却分成两份状态。
  if (!/argv\.includes\(['"]--quiet['"]\)/.test(CLI || '')) misses.push('cli-io.mjs 未解析 --quiet')
  else if (!/setQuiet\(true\)/.test(CLI || '')) misses.push('cli-io.mjs 解析了 --quiet 但没调 setQuiet(true)')
  if (!/const say = \(\.\.\.a\) => \(QUIET \? console\.error : console\.log\)/.test(CLI || ''))
    misses.push('say() 在 QUIET 时未走 console.error')
  if (!/export function setQuiet/.test(CLI || '')) misses.push('cli-io.mjs 没导出 setQuiet（外面写不了 QUIET）')
  if (/const say = /.test(LOOK || '')) misses.push('look.mjs 自己又定义了一份 say（QUIET 会分成两份状态）')
  if (!/from '\.\/cli-io\.mjs'/.test(LOOK || '')) misses.push('look.mjs 没有从 cli-io.mjs 引入输出层')
  if (!/extra\.push\(['"]--quiet['"]\)/.test(INDEX || '')) misses.push('index.js execute 未无条件下发 --quiet')
  if (misses.length === 0)
    return ok('B33', '2-27 进度行进 stdout', '判据齐备：cli-io 解析 --quiet→setQuiet(true)、say 在 QUIET 时走 stderr、index 无条件下发 --quiet、look 没有第二份 say')
  bad('B33', '2-27 进度行进 stdout', `缺 ${misses.length} 条判据：${misses.join('；')}`)
})

// ══════════════════════════════════════════════════════════════════════
// B34  2-28  提示「看 stderr」但模型看不到
// ══════════════════════════════════════════════════════════════════════
guard('B34', '2-28 误导性 stderr 提示', () => {
  const patterns = [/完整日志[^`'\n]{0,20}stderr/, /看[^`'\n]{0,10}stderr/, /bili-watch 的 stderr/]
  const hits = []
  for (const [k, s] of [['look.mjs', LOOK], ['index.js', INDEX]]) {
    if (!s) continue
    for (const re of patterns) {
      const m = re.exec(s)
      if (m) hits.push(`${k}:${lineOf(s, m.index)}「${m[0]}」`)
    }
  }
  if (hits.length === 0)
    return ok('B34', '2-28 误导性 stderr 提示', '两个文件都没有「看 stderr」类用户可见文案；trimForModel 走「全文已存 <路径>」')
  bad('B34', '2-28 误导性 stderr 提示', `${hits.length} 处：${hits.join('；')}`)
})

// ══════════════════════════════════════════════════════════════════════
// B35  5-8  .tool.txt 进 meta.files
// ══════════════════════════════════════════════════════════════════════
guard('B35', '5-8 .tool.txt 进 meta.files', () => {
  const body = fnBody(LOOK, 'writeMeta')
  if (!body) return bad('B35', '5-8 .tool.txt 进 meta.files', '未找到 writeMeta()')
  const filterLine = /meta\.files\s*=\s*readdirSync\(dir\)([\s\S]{0,160})/.exec(body)
  if (!filterLine) return bad('B35', '5-8 .tool.txt 进 meta.files', '未找到 meta.files 赋值')
  if (/tool\.txt/.test(filterLine[1]))
    return ok('B35', '5-8 .tool.txt 进 meta.files', 'meta.files 过滤掉了 .tool.txt')
  bad(
    'B35',
    '5-8 .tool.txt 进 meta.files',
    'meta.files 只 filter 掉 meta.json，其余目录项全收；trimForModel 写的 *.tool.txt 会被列进去',
  )
})

// ══════════════════════════════════════════════════════════════════════
// B36  6-16  [meta-debug] 调试残留
// ══════════════════════════════════════════════════════════════════════
guard('B36', '6-16 [meta-debug] 残留', () => {
  const n = cnt(LOOK, /\[meta-debug\]/g)
  if (n === 0) return ok('B36', '6-16 [meta-debug] 残留', '零命中')
  const where = []
  let m
  const r = /\[meta-debug\]/g
  while ((m = r.exec(LOOK))) where.push(lineOf(LOOK, m.index))
  bad('B36', '6-16 [meta-debug] 残留', `${n} 处，行 ${where.join('、')}，走 stderr`)
})

// ══════════════════════════════════════════════════════════════════════
// B37  12-10  死代码三处
// ══════════════════════════════════════════════════════════════════════
guard('B37', '12-10 死代码三处', () => {
  const notes = []
  // ① tmpdir 是否只有 import / 注释
  const td = cnt(LOOK, /tmpdir/g)
  const tdReal = cnt(LOOK, /tmpdir\(/g)
  if (tdReal === 0 && td > 0) notes.push(`tmpdir 出现 ${td} 次但 0 次调用（只有 import/注释）`)
  // ② parseCommandLine 是否有外部引用
  const exp = /export\s*\{[^}]*parseCommandLine/.test(INDEX || '')
  if (exp) notes.push('index.js 仍导出 parseCommandLine（未见外部消费者）')
  // ③ exitCode=1 后紧跟 exit(1)
  if (/process\.exitCode\s*=\s*1\s*\n\s*(?:process\.)?exit\(/.test(LOOK || ''))
    notes.push('存在 exitCode=1 后紧跟 exit(1) 的重复退出')
  // 语法自检（只读）
  const chk = spawnSync(process.execPath, ['--check', F.look], { encoding: 'utf8', timeout: 30000 })
  if (chk.status !== 0) notes.push(`node --check 失败：${(chk.stderr || '').split('\n')[0]}`)
  if (notes.length === 0) return ok('B37', '12-10 死代码三处', 'tmpdir 未用/导出悬空/重复退出 三项均未命中，且 --check 通过')
  bad('B37', '12-10 死代码三处', notes.join('；'))
})

// ══════════════════════════════════════════════════════════════════════
// B38  12-8  BAIT_WORD 重复项
// ══════════════════════════════════════════════════════════════════════
guard('B38', '12-8 BAIT_WORD 重复', () => {
  const m = /const BAIT_WORD = \/(.*)\/[a-z]*\s*$/m.exec(LOOK || '')
  if (!m) return bad('B38', '12-8 BAIT_WORD 重复', '未找到 BAIT_WORD 定义')
  const parts = m[1].split('|').map((s) => s.trim())
  const seen = new Map()
  const dups = []
  for (const p of parts) {
    if (seen.has(p)) dups.push(p)
    else seen.set(p, 1)
  }
  if (dups.length === 0) return ok('B38', '12-8 BAIT_WORD 重复', `${parts.length} 个分支，无重复`)
  bad('B38', '12-8 BAIT_WORD 重复', `${parts.length} 个分支里有 ${dups.length} 个重复：${dups.join('、')}`)
})

// ══════════════════════════════════════════════════════════════════════
// B39  4-9  没有 --max-frames 硬上限
// ══════════════════════════════════════════════════════════════════════
guard('B39', '4-9 无帧数上限', () => {
  if (has(LOOK, /maxFrames|MAX_FRAMES|max-frames/))
    return ok('B39', '4-9 无帧数上限', '存在帧数上限')
  const step = /function autoStep/.test(LOOK || '')
  bad(
    'B39',
    '4-9 无帧数上限',
    `全文无 maxFrames/MAX_FRAMES/max-frames；${step ? '只有 autoStep 按时长自适应，模型传小 --step 仍可抽爆' : '抽帧数完全由 step 决定'}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// B40  3-4  transcribe 不预查 asrReady
// ══════════════════════════════════════════════════════════════════════
guard('B40', '3-4 transcribe 不预查 asrReady', () => {
  const body = fnBody(LOOK, 'transcribe')
  if (!body) return bad('B40', '3-4 transcribe 不预查 asrReady', '未找到 transcribe()')
  if (/asrReady\(/.test(body)) return ok('B40', '3-4 transcribe 不预查 asrReady', 'transcribe 内部调用了 asrReady()')
  const caller = /if \(!asrReady\(\)\)/.test(LOOK || '')
  bad(
    'B40',
    '3-4 transcribe 不预查 asrReady',
    `transcribe 内 0 次 asrReady()${caller ? '；只在调用方 cmdAsr/cmdText 里查，别的调用路径会漏' : ''}`,
  )
})

// ══════════════════════════════════════════════════════════════════════
// R1  14-13 收口  deleteDeps 必须删新旧两路径（2026-10-26 DSH 拍板）
// ══════════════════════════════════════════════════════════════════════
guard('R1', '14-13 收口：deleteDeps 删新旧两路径', () => {
  const deletesBoth = /for\s*\(\s*const\s+\w+\s+of\s*\[\s*SHARED_CRED\s*,\s*LEGACY_CRED\s*\]\s*\)/.test(INDEX || '')
  if (deletesBoth)
    return ok('R1', '14-13 收口：deleteDeps 删新旧两路径', '删除循环同时遍历 SHARED_CRED 与 LEGACY_CRED——删新路径后不会被旧路径迁回')
  bad('R1', '14-13 收口：deleteDeps 删新旧两路径', '删除循环未同时含 SHARED_CRED 与 LEGACY_CRED——只删新路径的话下次读会从旧路径重新迁回，删除按钮失效')
})

// ══════════════════════════════════════════════════════════════════════
// R2  10-7 收口  _noFrameCheck 实参必须是 !*.suspect（2026-10-26 DSH 拍板）
// ══════════════════════════════════════════════════════════════════════
guard('R2', '10-7 收口：_noFrameCheck 实参是 !*.suspect', () => {
  const dynamic = /_noFrameCheck:\s*![A-Za-z_$][\w$]*\.suspect/.test(LOOK || '')
  if (!dynamic) return bad('R2', '10-7 收口：_noFrameCheck 实参', '_noFrameCheck 实参不是 !*.suspect——互斥可能被改成常量，可疑字幕与未核对声明会叠加')
  ok('R2', '10-7 收口：_noFrameCheck 实参', '_noFrameCheck 实参是 !*.suspect，与 ⚠ 字幕可疑行互斥（命中才打 ⚠、未命中才打未核对）')
})

// ══════════════════════════════════════════════════════════════════════
// 输出
// ══════════════════════════════════════════════════════════════════════
// 台账判据本身需要现场（风控响应/断网/只读目录/Ctrl-C/真视频），本脚本按「代码里有没有这个守卫」判。
// 这几条是静态代理，改完最好再按台账真跑一次。
const PROXY = ['B13', 'B14', 'B16', 'B17', 'B18', 'B21', 'B22']

const nP = ROWS.filter((r) => r.status === 'PASS').length
const nF = ROWS.filter((r) => r.status === 'FAIL').length
const nS = ROWS.filter((r) => r.status === 'SKIP').length

process.stdout.write('# verify-todo 结果（' + new Date().toISOString() + '）\n')
process.stdout.write('# 插件目录：' + ROOT + '\n')
process.stdout.write('# 编号 | 名称 | 状态 | 证据\n')
for (const r of ROWS) {
  process.stdout.write(`${r.id} | ${r.name} | ${r.status} | ${r.evidence}\n`)
}
process.stdout.write(`# 静态代理（台账判据需现场，此处按代码判定）：${PROXY.join(' ')}\n`)
process.stdout.write(`PASS ${nP} / FAIL ${nF} / SKIP ${nS}（共 ${ROWS.length}）\n`)

process.exitCode = nF > 0 ? 1 : 0