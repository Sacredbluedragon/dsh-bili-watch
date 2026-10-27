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
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`)
  const m = re.exec(src)
  if (!m) return null
  const end = src.indexOf('\n}', m.index)
  return end < 0 ? null : src.slice(m.index, end + 2)
}

/** 去掉行注释与块注释，避免注释里的词被当成用户可见文案 */
function stripComments(src) {
  if (!src) return ''
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
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
const PKG = (() => {
  try {
    return JSON.parse(SRC.pkg || '{}')
  } catch {
    return null
  }
})()

// ══════════════════════════════════════════════════════════════════════
// B1  11-11  deps-config.json 硬编码本机 ffmpeg 路径
// ══════════════════════════════════════════════════════════════════════
guard('B1', '11-11 deps-config 硬编码本机路径', () => {
  if (!SRC.depsCfg) return ok('B1', '11-11 deps-config 硬编码本机路径', 'deps/deps-config.json 不存在（无本机路径可泄露）')
  const abs = SRC.depsCfg.match(/"[A-Za-z]:[\\/]{1,2}[^"]*"/g) || []
  const gsv = /GPT-SoVITS/i.test(SRC.depsCfg)
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
  if (abs.length) parts.push(`${abs.length} 条盘符绝对路径${gsv ? '（含 GPT-SoVITS）' : ''}：${abs.slice(0, 2).join(' ')}`)
  if (tracked === true) parts.push('且该文件已被 git 跟踪（git ls-files 命中）')
  if (parts.length === 0)
    return ok(
      'B1',
      '11-11 deps-config 硬编码本机路径',
      `无盘符绝对路径、无 GPT-SoVITS${tracked === false ? '，且未被 git 跟踪' : '（git 状态未取到）'}`,
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
  const body = fnBody(LOOK, 'cleanKey')
  if (!body) return bad('B3', '15-9 cleanKey 带后缀保留名', '未找到 cleanKey()（改名或已删）')
  const MARK = 'con|prn|aux|nul|com[0-9]|lpt[0-9])'
  const at = body.indexOf(MARK)
  if (at < 0) return bad('B3', '15-9 cleanKey 带后缀保留名', 'cleanKey 里完全没有保留名判断')
  // 取保留名分组右括号之后的 8 个字符，看是 $ 收尾还是容忍 .后缀
  const after = body.slice(at + MARK.length, at + MARK.length + 8)
  const onlyExact = after.trimStart().startsWith('$')
  const tolerantByRegex = /\\\./.test(after)
  const tolerantByCode =
    /split\(\s*['"]\.['"]\s*\)/.test(body) || /replace\(\s*\/\\\.[^/]*\/\s*,\s*''\s*\)/.test(body)
  if (!onlyExact || tolerantByRegex || tolerantByCode)
    return ok('B3', '15-9 cleanKey 带后缀保留名', `保留名判断容忍扩展名（分组后为「${after.trim()}」）`)
  bad(
    'B3',
    '15-9 cleanKey 带后缀保留名',
    `保留名正则以 $ 收尾（分组后为「${after.trim()}」），只挡 con 本身；con.txt / NUL.txt 放行`,
  )
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
  const q = /QUIET\s*=\s*opts\.format\s*===\s*'srt'/.exec(body)
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
  const body = fnBody(LOOK, 'downloadTo')
  if (!body) return bad('B13', '9-15 风控 HTML 当直链', '未找到 downloadTo()')
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
  const body = fnBody(LOOK, 'jget')
  if (!body) return bad('B14', '9-2 412 无提示且降级 ASR', '未找到 jget()')
  const has412 = /412/.test(body) || /412/.test(LOOK || '')
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
  const peek = fnBody(LOOK, 'peekFrames')
  const cache = fnBody(LOOK, 'cachedMp4')
  if (!peek || !cache) return bad('B16', '4-3 peek/frames 各下一份 mp4', '未找到 peekFrames() 或 cachedMp4()')
  const peekDir = /join\(CACHE,\s*'frames',\s*`([^`]*)`\)/.exec(peek)
  const cachePrefix = /startsWith\(`([^`]*)`\)/.exec(cache)
  if (!peekDir || !cachePrefix)
    return bad('B16', '4-3 peek/frames 各下一份 mp4', '目录模板或 cachedMp4 前缀未识别，需人工看')
  const p = peekDir[1]
  const c = cachePrefix[1]
  // peek 目录形如 `${bv}-peek-p${p}`，cachedMp4 只认 `${bv}-p${page}-`
  if (p.includes('-peek-') && c.includes('${bv}-p${page}-'))
    return bad(
      'B16',
      '4-3 peek/frames 各下一份 mp4',
      `peek 落在 "${p}"，cachedMp4 只认 "${c}" → peek 的 mp4 永不被 frames 复用，各下一份`,
    )
  ok('B16', '4-3 peek/frames 各下一份 mp4', `peek 目录 "${p}" 与 cachedMp4 前缀 "${c}" 可对上`)
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
  const m = /关键词命中不到\s*\d+%/.exec(SRC.readme || '')
  if (!m) return ok('B29', '10-6 README 反钓鱼判据错', 'README 未再写「关键词命中不到 N%」')
  const line = (SRC.readme || '').split('\n').find((l) => l.includes('关键词命中不到')) || ''
  const independent = !/且|同时|配合/.test(line)
  const codeSays = /只在语速也异常|补充理由|speedBad/.test(LOOK || '')
  if (!independent) return ok('B29', '10-6 README 反钓鱼判据错', 'README 该行已写明需配合其它条件')
  bad(
    'B29',
    '10-6 README 反钓鱼判据错',
    `README 把「${m[0]}」列为独立触发条件${codeSays ? '；代码 baitSignals 只在语速也异常时才用它当补充理由' : ''}`,
  )
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
  if (!/argv\.includes\(['"]--quiet['"]\)/.test(LOOK || '')) misses.push('look.mjs 未解析 --quiet')
  else if (!/QUIET\s*=\s*true/.test(LOOK || '')) misses.push('look.mjs 解析了 --quiet 但未置 QUIET=true')
  if (!/const say = \(\.\.\.a\) => \(QUIET \? console\.error : console\.log\)/.test(LOOK || ''))
    misses.push('say() 在 QUIET 时未走 console.error')
  if (!/extra\.push\(['"]--quiet['"]\)/.test(INDEX || '')) misses.push('index.js execute 未无条件下发 --quiet')
  if (misses.length === 0)
    return ok('B33', '2-27 进度行进 stdout', '三条判据齐备：look 解析 --quiet→QUIET=true、say 在 QUIET 时走 stderr、index 无条件下发 --quiet')
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