// C207 夹具（C240 b 批重写）：顶层函数不许引用 factory 内标识符 —— **正面解析自由变量**。
//
// 事发经过（2026-11-08 P0）：C1 把 lastRunDetail 写成顶层函数，却引用了定义在
//   MODULE_LOADER.load 的 factory 里的 fmtTime。模块作用域取不到 factory 作用域，语法
//   合法、node --check 通过、C195 全绿（夹具给它注入了假 fmtTime），真机 Panel 一渲染
//   就 ReferenceError —— 整个插件面板空白。
//
// 旧版是「交集法」：先列出 factory 内 4 空格缩进的 const/let/var/function 名字，再看
//   顶层函数体里有没有出现这些名字。三个洞：factory 里**现在没有**的悬空符号抓不到、
//   `const { a } = ...` 解构声明抓不到、将来才加的标识符抓不到。
// 本版改成正面解析：对每个顶层函数体做词法切分，列出**全部标识符引用**，减去参数、
//   本地声明（含解构 / 箭头参数 / catch）、模块顶层声明、语言关键字与显式全局白名单，
//   剩下的就是自由变量 —— 任何一条都报违规。factory 内的声明故意**不**收进已声明集，
//   所以「factory 内标识符」天然落在自由变量里。
//
// 范围说明：这是针对本文件顶层纯函数体的轻量词法分析，不追求覆盖全部 JS 语法。
//   解析面由 C268 的「函数数 / 顶层声明数 / token 总数 / 自由变量与源码逐字对齐」守住。
// 只输出原始证据，判与不判交给 tools/verify.mjs 的 C207 / C268。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SRC = readFileSync(join(ROOT, 'client.js'), 'utf8')

/** 显式全局白名单：只有语言内置值才会被顶层纯函数引用。
 *  宿主/浏览器全局（window / document / fetch / console / require / process …）当前
 *  一个都没被顶层函数用到，所以**一条都不预先放行** —— 将来真要用，必须在这里显式
 *  补一行并写清理由，不能靠放宽判据蒙过去。 */
export const GLOBAL_ALLOW = Object.freeze([
  'Array',   // isArray：fmtSkippedNote / rowBusy / anyDownloading / lockNote / readDownloadResp
  'Boolean', // .filter(Boolean)：readDownloadResp
  'Date',    // new Date(t)：fmtTime
  'Math',    // Math.round：tuneDefaultLabel
  'Number',  // Number.isFinite / Number.isNaN：fmtTime / lastRunDetail / tuneDefaultLabel
  'String',  // String(...)：fmtDelMsg / fmtSkippedNote / fmtTime
])
const ALLOW = new Set(GLOBAL_ALLOW)

const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield await async of get set static null true false undefined NaN Infinity').split(' '))
const REGEX_KEYWORDS = new Set('return typeof case delete void in of instanceof new throw else do yield await'.split(' '))
const idStart = (c) => /[A-Za-z_$]/.test(c || '')
const idPart = (c) => /[A-Za-z0-9_$]/.test(c || '')

function skipQuoted(s, k) {
  const q = s[k]
  let j = k + 1
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue }
    if (s[j] === q) return j + 1
    j++
  }
  return j
}

/** 轻量词法：注释与字符串文本丢弃；模板串的 ${} 插值递归 lex（插值里的标识符是真引用）。 */
export function lex(text) {
  const out = []
  const n = text.length
  let i = 0
  const push = (t, v) => out.push({ t, v })
  const last = () => (out.length ? out[out.length - 1] : null)
  const canRegex = () => {
    const p = last()
    if (!p) return true
    if (p.t === 'id') return REGEX_KEYWORDS.has(p.v)
    if (p.t === 'punc') return ![')', ']', '}'].includes(p.v)
    return false
  }
  const scanTemplate = (start) => {
    let j = start + 1
    while (j < n) {
      if (text[j] === '\\') { j += 2; continue }
      if (text[j] === '`') return j + 1
      if (text[j] === '$' && text[j + 1] === '{') {
        let k = j + 2
        let depth = 1
        while (k < n && depth > 0) {
          const ch = text[k]
          if (ch === '"' || ch === "'" || ch === '`') { k = skipQuoted(text, k); continue }
          if (ch === '{') depth++
          else if (ch === '}') depth--
          k++
        }
        for (const t of lex(text.slice(j + 2, k - 1))) push(t.t, t.v)
        j = k
        continue
      }
      j++
    }
    return j
  }
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (/\s/.test(c)) { i++; continue }
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (c === "'" || c === '"') { const j = skipQuoted(text, i); push('str', text.slice(i, j)); i = j; continue }
    if (c === '`') { const j = scanTemplate(i); push('str', '`tmpl`'); i = j; continue }
    if (c === '/' && canRegex()) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) { j++; while (/[a-z]/i.test(text[j] || '')) j++; break }
        else if (text[j] === '\n') break
        j++
      }
      push('re', text.slice(i, j))
      i = j
      continue
    }
    if (idStart(c)) {
      let j = i + 1
      while (j < n && idPart(text[j])) j++
      push('id', text.slice(i, j))
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9a-fx._]/i.test(text[j])) j++
      push('num', text.slice(i, j))
      i = j
      continue
    }
    if (text.slice(i, i + 3) === '...') { push('punc', '...'); i += 3; continue }
    if (text.slice(i, i + 2) === '=>' || text.slice(i, i + 2) === '?.') { push('punc', text.slice(i, i + 2)); i += 2; continue }
    push('punc', c)
    i++
  }
  return out
}

function matchParen(toks, open) {
  let depth = 0
  for (let k = open; k < toks.length; k++) {
    if (toks[k].v === '(') depth++
    else if (toks[k].v === ')') { depth--; if (depth === 0) return k }
  }
  return -1
}

/** 收集函数体内所有绑定名；箭头标记是标点 token，必须在「非 id 跳过」之前处理。 */
export function bindingsOf(toks, paramToks) {
  const b = new Set()
  for (const t of paramToks) if (t.t === 'id' && !KEYWORDS.has(t.v)) b.add(t.v)
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.v === '=>') {
      const prev = toks[k - 1]
      if (prev?.v === ')') {
        let o = k - 2
        let depth = 1
        while (o >= 0 && depth > 0) { if (toks[o].v === ')') depth++; else if (toks[o].v === '(') depth--; o-- }
        for (let m = o + 2; m < k - 1; m++) if (toks[m].t === 'id' && !KEYWORDS.has(toks[m].v)) b.add(toks[m].v)
      } else if (prev?.t === 'id') b.add(prev.v)
      continue
    }
    if (t.t !== 'id') continue
    if (t.v === 'const' || t.v === 'let' || t.v === 'var') {
      for (let m = k + 1; m < toks.length; m++) {
        const u = toks[m]
        if (u.t === 'punc' && (u.v === '=' || u.v === ';' || u.v === ')')) break
        if (u.t === 'id' && (u.v === 'of' || u.v === 'in')) break
        if (u.t === 'id' && !KEYWORDS.has(u.v)) b.add(u.v)
      }
      continue
    }
    if (t.v === 'function' || t.v === 'class') {
      if (toks[k + 1]?.t === 'id') b.add(toks[k + 1].v)
      const oi = toks[k + 1]?.v === '(' ? k + 1 : (toks[k + 2]?.v === '(' ? k + 2 : -1)
      if (oi >= 0) {
        const e = matchParen(toks, oi)
        for (let m = oi + 1; m < e; m++) if (toks[m].t === 'id' && !KEYWORDS.has(toks[m].v)) b.add(toks[m].v)
      }
      continue
    }
    if (t.v === 'catch' && toks[k + 1]?.v === '(') {
      const e = matchParen(toks, k + 1)
      for (let m = k + 2; m < e; m++) if (toks[m].t === 'id') b.add(toks[m].v)
    }
  }
  return b
}

/** 全部标识符引用：排除关键字、属性名、对象字面量 key。 */
export function refsOf(toks) {
  const r = new Set()
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.t !== 'id' || KEYWORDS.has(t.v)) continue
    const prev = toks[k - 1]
    if (prev?.t === 'punc' && (prev.v === '.' || prev.v === '?.')) continue
    const next = toks[k + 1]
    if (next?.v === ':' && prev && (prev.v === '{' || prev.v === ',' || prev.v === ';' || prev.v === '(')) continue
    r.add(t.v)
  }
  return r
}

/** 模块顶层声明（顶格）；factory 内的 4 空格缩进声明故意不收。 */
function topLevelDecls(lines) {
  const s = new Set()
  for (const l of lines) {
    const m = l.match(/^(?:function|class)\s+([A-Za-z_$][\w$]*)/) || l.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)
    if (m) s.add(m[1])
  }
  return s
}

export function analyze(src) {
  const lines = src.split('\n')
  const loadLine = lines.findIndex((l) => /^MODULE_LOADER\.load\(/.test(l))
  if (loadLine < 0) return { ok: false, why: '找不到 MODULE_LOADER.load 边界' }
  const tops = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/)
    if (!m) continue
    let end = lines.length - 1
    for (let j = i + 1; j < lines.length; j++) if (/^}/.test(lines[j])) { end = j; break }
    tops.push({ name: m[1], line: i + 1, text: lines.slice(i, end + 1).join('\n') })
  }
  const topDecls = topLevelDecls(lines.slice(0, loadLine))
  const rows = []
  for (const f of tops) {
    const toks = lex(f.text)
    const oi = toks.findIndex((t) => t.v === '(')
    const pe = oi < 0 ? -1 : matchParen(toks, oi)
    const body = pe < 0 ? toks : toks.slice(pe + 1)
    const binds = bindingsOf(body, pe > oi ? toks.slice(oi + 1, pe) : [])
    const refs = refsOf(body)
    const freeRaw = [...refs].filter((v) => !binds.has(v) && !topDecls.has(v)).sort()
    // 括号配平前提：函数体切错（提前截断）时直接报失效，不让解析面悄悄塌掉
    const braces = toks.filter((t) => t.v === '{').length - toks.filter((t) => t.v === '}').length
    rows.push({
      fn: f.name, line: f.line, tokenCount: toks.length, balanced: braces === 0,
      freeRaw, free: freeRaw.filter((v) => !ALLOW.has(v)),
    })
  }
  return {
    ok: true, loadLine: loadLine + 1, topCount: tops.length,
    topDecls: [...topDecls], topDeclCount: topDecls.size,
    parsedTokenTotal: rows.reduce((n, r) => n + r.tokenCount, 0),
    rows,
  }
}

const real = analyze(SRC)
const freeRawUnion = [...new Set(real.rows.flatMap((r) => r.freeRaw))].sort()
const freeUnion = [...new Set(real.rows.flatMap((r) => r.free))].sort()

// —— 四类注入：DSH 点名的「悬空名 / 未来才加 / 解构声明」+ 旧法能抓的常规声明回归 ——
const POISON_NAMES = Object.freeze({
  dangling: '__c207Dangling',
  future: '__c207Future',
  destructure: '__c207Destructured',
  factoryRegular: 'fmtBytes',
})
const intoFn = (s, name, code) => s.replace(new RegExp(`^(function ${name}\\([^)]*\\) \\{)`, 'm'), `$1\n  ${code}`)
const intoFactory = (s, code) => s.replace(/^(    const PKG = 'dsh-bili-watch')/m, `$1\n${code}`)

const POISON_SNIPPETS = {
  dangling: (n) => `void ${n}()`,
  future: (n) => `void ${n}`,
  destructure: (n) => `void ${n}`,
  factoryRegular: (n) => `void ${n}(1)`,
}
const POISON_FACTORY = {
  future: (n) => `    const ${n} = 1`,
  destructure: (n) => `    const { ${n} } = { ${n}: 1 }`,
}
const poisons = {}
for (const [label, name] of Object.entries(POISON_NAMES)) {
  const snippet = POISON_SNIPPETS[label](name)
  let mutated = SRC
  if (POISON_FACTORY[label]) mutated = intoFactory(mutated, POISON_FACTORY[label](name))
  mutated = intoFn(mutated, 'versionLabel', snippet)
  const injected = mutated !== SRC && mutated.includes(snippet)
  const got = analyze(mutated)
  const ids = got.ok ? [...new Set(got.rows.flatMap((r) => r.free))].sort() : []
  poisons[label] = { name, snippet, injected, caught: injected && ids.includes(name), ids }
}

// —— 不误伤控制组：局部声明与箭头参数必须与「自由变量」严格区分 ——
const NO_FALSE = {
  localDecl: intoFn(SRC, 'versionLabel', 'const __c207Local = 1; if (__c207Local) {}'),
  arrowParam: intoFn(SRC, 'versionLabel', 'const __c207Shadow = (p) => p; __c207Shadow(1)'),
}
const noFalsePositive = {}
for (const [label, mutated] of Object.entries(NO_FALSE)) {
  const got = analyze(mutated)
  const ids = got.ok ? [...new Set(got.rows.flatMap((r) => r.free))].sort() : ['<解析失效>']
  noFalsePositive[label] = { ok: ids.length === 0, ids }
}

console.log(JSON.stringify({
  realOk: real.ok === true,
  realTopCount: real.topCount,
  topDeclCount: real.topDeclCount,
  topDecls: real.topDecls,
  loadLine: real.loadLine,
  parsedTokenTotal: real.parsedTokenTotal,
  allBalanced: real.rows.every((r) => r.balanced),
  globalAllow: [...GLOBAL_ALLOW],
  freeRawUnion,
  freeUnion,
  realViolations: real.rows.filter((r) => r.free.length).map((r) => ({ fn: r.fn, line: r.line, ids: r.free })),
  perFunction: real.rows.map((r) => ({ fn: r.fn, line: r.line, tokenCount: r.tokenCount, freeRaw: r.freeRaw, free: r.free })),
  poisonNames: POISON_NAMES,
  poisons,
  noFalsePositive,
}))
