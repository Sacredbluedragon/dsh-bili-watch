/**
 * 判据登记扫描器：把 tools/verify.mjs 的每条 check()/slowCheck() 当成**结构化调用**解析，
 * 而不是拿整份源码做 includes。
 *
 * 三件事都是真做的：
 *   ① 按行首调用起点切块，逐块用 vm.Script 编译，编译不过就是解析失败要点名；
 *   ② 词法级（跳字符串/注释）收集断言体里的调用名，区分「真执行」与「纯字面量比对」；
 *   ③ 真读登记表做差集，把违例逐条点名（行号 + 判据名）。
 *
 * 这个文件本身不跑判据、不写盘；导出 scanGate() 给主闸调用，也能单独当 CLI 跑出 JSON 取证。
 */
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MARK_TAG = '[结构判据]'
export const COVER_RE = /\[结构判据\]\s*行为由\s+(C\d+(?:\s*(?:与|、|,)\s*C\d+)*)\s*覆盖/

/** 真跑信号：起子进程 / 写盘 / 造临时树 / 抠函数体真求值 / 调生产模块。 */
const BUILTIN_BEHAVIOR = new Set([
  'spawnSync', 'spawn', 'execFileSync', 'execSync', 'runExecFileSync',
  'writeFileSync', 'mkdtempSync', 'rmSync', 'renameSync', 'copyFileSync',
  'mkdirSync', 'symlinkSync', 'chmodSync', 'openSync', 'closeSync',
  'runInNewContext', 'runInContext', 'compile', 'SourceTextModule',
  // 2026-11-11（发前外审 R1-Q2）：runFixture 定义在首个 check 之后（verify.mjs:7886），
  // preflightHelperNames 只扫首个 check 之前，C230 因此被误判成纯字面量静态判据。
  // 不补这一条，下面「覆盖者必须真行为」会把 C1（覆盖者正是 C230）直接判红。
  'runFixture',
])

/** 词法掩码：产出 code[]，1 = 代码区字符；字符串 / 模板 / 注释里的内容一律 0。 */
function codeMask(s) {
  const code = new Uint8Array(s.length)
  let i = 0
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1]
    if (c === '/' && c2 === '/') {
      i += 2
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue }
        if (s[i] === q) { i++; break }
        i++
      }
      continue
    }
    code[i] = 1
    i++
  }
  return code
}

/** 在代码区里收集 identifier( 的调用名，以及「真跑 helper」的前置定义名。 */
function callsIn(text) {
  const code = codeMask(text)
  const names = new Set()
  for (let i = 0; i < text.length; i++) {
    if (!code[i] || !/[A-Za-z_$]/.test(text[i])) continue
    let j = i
    while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++
    let k = j
    while (k < text.length && /\s/.test(text[k])) k++
    if (text[k] === '(' && code[k]) names.add(text.slice(i, j))
    i = j - 1
  }
  return names
}

/** 从 import 语句里取出「调生产模块」的函数名（lib/ 与 fixtures/ 与 cli-io）。 */
function importedNames(src) {
  const names = new Set()
  const re = /import\s+(?:\*\s+as\s+(\w+)|\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    const spec = m[4]
    // 判据执行器（check-run.mjs）里的 must/matchOnly 不是「调被测代码」，不能算真跑信号。
    if (!/^\.\.\/lib\/|^\.\/fixtures\/|^\.\/cli-io\.mjs$/.test(spec)) continue
    if (m[1]) names.add(m[1])
    if (m[3]) names.add(m[3])
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const bits = part.trim().split(/\s+as\s+/)
        const n = (bits[1] || bits[0]).trim()
        if (n) names.add(n)
      }
    }
  }
  return names
}

/** 第一个 check( 之前定义的、函数体里真起子进程的 helper 名（不写死任何编号）。 */
function preflightHelperNames(src, firstCallLine) {
  const head = src.split('\n').slice(0, firstCallLine).join('\n')
  const names = new Set()
  const re = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?)(?=^const\s|^function\s|^export\s|^check\(|^slowCheck\(|\Z)/gm
  for (const m of head.matchAll(re)) {
    if (/\b(?:spawnSync|spawn|execFileSync|execSync|runExecFileSync|runFixture)\s*\(/.test(m[2])) names.add(m[1])
  }
  return names
}

/**
 * 按行首 check(/slowCheck( 起点切块。终点取「第一个能让整块通过 vm.Script 编译的 ^}) 行」，
 * 单行调用直接一行。这样不会把下一条判据的顶层代码吞进当前块。
 */
export function parseCalls(src) {
  const lines = src.split('\n')
  const starts = []
  lines.forEach((l, i) => { if (/^(?:check|slowCheck)\(/.test(l)) starts.push(i) })
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const next = k + 1 < starts.length ? starts[k + 1] : lines.length
    let block = '', syntax = false
    const oneLine = /^(?:check|slowCheck)\(.*\)\s*$/.test(lines[s])
    if (oneLine) {
      block = lines[s]
    } else {
      for (let e = s; e < next; e++) {
        if (!/^\}\)\s*$/.test(lines[e])) continue
        block = lines.slice(s, e + 1).join('\n')
        if (compiles(block)) { syntax = true; break }
      }
      if (!syntax) block = lines.slice(s, next).join('\n')
    }
    if (oneLine && compiles(block)) syntax = true
    const m = /^(?:check|slowCheck)\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(block)
    const name = m ? m[2] : ''
    out.push({ line: s + 1, name, body: m ? block.slice(m[0].length) : block, block, syntax })
  }
  return out
}

function compiles(block) {
  try {
    // vm.Script 是脚本上下文，源码里的 import.meta 只在模块上下文合法；
    // 换成普通标识符只为验证语法，不改变任何断言体结构。
    const text = block.trimEnd().replace(/;\s*$/, '').replace(/import\.meta/g, '__import_meta')
    new vm.Script('(' + text + ')')
    return true
  } catch { return false }
}

/** 分类：判定依据来自字符串比对、且断言体里没有任何真执行 → 静态判据。 */
export function classify(body, behaviorNames) {
  const calls = callsIn(body)
  const real = [...calls].filter((n) => BUILTIN_BEHAVIOR.has(n) || behaviorNames.has(n))
  const compares = /\.(?:includes|indexOf|match|search|test)\s*\(/.test(body)
  return { static: real.length === 0 && compares, real: real.sort(), callCount: calls.size }
}

/**
 * 主入口：真解析 + 真数 + 真点名。
 * @param {string} src tools/verify.mjs 全文
 * @param {{required: string[], staticNames: string[]}} baseline 登记表
 */
export function scanGate(src, baseline) {
  const calls = parseCalls(src)
  const behaviorNames = new Set([...importedNames(src), ...preflightHelperNames(src, calls[0]?.line ? calls[0].line - 1 : 0)])
  const required = new Set((baseline && baseline.required) || [])
  const known = new Set((baseline && baseline.staticNames) || [])
  // 基线登记「当前必须是真行为」的带标记判据（历史豁免的遗留形态）。
  // 它们一旦退化成纯字面量，原有 [结构判据] 标记就失去依据，必须当场红；
  // 显式登记是为了不让「顺手把它补进 staticNames」变成新的绕过口。
  const liveBehavior = new Set((baseline && baseline.liveBehavior) || [])
  const rows = calls.map((c) => {
    const text = c.name + '\n' + c.body
    const marked = c.name.includes(MARK_TAG) || c.body.includes(MARK_TAG)
    const cls = classify(c.body, behaviorNames)
    const id = (/^\s*((?:C\d+|W-\d+))/.exec(c.name) || [])[1] || ''
    const cover = COVER_RE.exec(text)
    const coverIds = cover ? (cover[1].match(/C\d+/g) || []) : []
    return { ...c, id, marked, coverIds, ...cls }
  })
  const rowById = new Map()
  rows.forEach((r) => { if (r.id && !rowById.has(r.id)) rowById.set(r.id, r) })
  const violations = []
  rows.forEach((r) => {
    if (!r.syntax) { violations.push(`L${r.line} ${r.name.slice(0, 56)}：断言体语法编译失败，解析不可信`); return }
    if (required.has(r.id) && !r.marked) violations.push(`L${r.line} ${r.name.slice(0, 56)}：本批登记的结构判据标记被摘`)
    if (r.marked) {
      const at = `L${r.line} ${r.name.slice(0, 56)}`
      if (!r.coverIds.length) violations.push(`${at}：带标记但没点名「行为由 Cxxx 覆盖」`)
      r.coverIds.forEach((id) => {
        const cov = rowById.get(id)
        if (!cov) { violations.push(`${at}：覆盖者 ${id} 在主闸里不存在`); return }
        if (cov.static || cov.marked) {
          violations.push(`${at}：覆盖者 ${id} 是${cov.marked ? '带结构标记的' : '纯字面量静态'}判据，不许当覆盖者（必须本身是真行为判据）`)
        }
      })
      // 旧规则是 !required.has(id) && !r.static：真行为判据贴标记要红，但一旦把它
      // 「去势」成纯字面量（static=true），!r.static 为假，标记就变成永久豁免口。
      // 现在只要没登记就一律红，与当前是不是静态无关。
      if (!required.has(r.id)) violations.push(`${at}：未登记的结构标记判据（贴标记不能当去势豁免）`)
      if (r.static && !known.has(r.name)) violations.push(`${at}：带标记的去势判据未登记，原有标记失效`)
      if (liveBehavior.has(r.id) && r.static) violations.push(`${at}：本应是真行为的判据退化成纯字面量，原有结构标记失效（补登记也不放行）`)
    } else if (r.static && !known.has(r.name)) {
      violations.push(`L${r.line} ${r.name.slice(0, 56)}：新增纯字面量判据未登记（补标记并点名覆盖者，或登记进基线）`)
    }
  })
  return {
    total: rows.length,
    syntaxOk: rows.filter((r) => r.syntax).length,
    staticCount: rows.filter((r) => r.static).length,
    behaviorCount: rows.filter((r) => !r.static).length,
    markedCount: rows.filter((r) => r.marked).length,
    requiredCount: required.size,
    registeredCount: known.size,
    violations,
    rows,
  }
}

// 单独跑：node tools/fixtures/gate-scan.mjs [verify.mjs 路径] [baseline.json 路径]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = readFileSync(process.argv[2] || join(HERE, '..', 'verify.mjs'), 'utf8')
  const baseline = process.argv[3]
    ? JSON.parse(readFileSync(process.argv[3], 'utf8'))
    : { required: [], staticNames: [] }
  const r = scanGate(src, baseline)
  console.log(JSON.stringify({
    total: r.total, syntaxOk: r.syntaxOk, staticCount: r.staticCount,
    behaviorCount: r.behaviorCount, markedCount: r.markedCount,
    requiredCount: r.requiredCount, registeredCount: r.registeredCount,
    violations: r.violations,
    rows: r.rows.map((x) => ({ line: x.line, id: x.id, name: x.name.slice(0, 90), static: x.static, marked: x.marked, coverIds: x.coverIds, real: x.real })),
  }, null, 2))
}
