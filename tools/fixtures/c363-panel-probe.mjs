/**
 * C363 取证夹具：只读 client.js，产出原始事实，结论由主闸 C363 自己算。
 *
 * 四组事实：
 *   ① 「当前占用」字面量在 client.js 里出现几次；
 *   ② 那次是否落在 cacheFactsNode 原样函数体内（不是整文件包含性判断）；
 *   ③ 两个清理按钮属性在 data-bl-sechead 区块内各出现几次、全文各几次；
 *   ④ cacheFactsNode 原样函数体真求值：渲染出的「当前占用」是否挂在 data-bl-fact-x 上、值是否来自 breakdown。
 *
 * 夹具不替被测函数造环境：cacheFactsNode 只依赖参数 h / o.breakdown / o.fmt，
 *   抽出来直接 new Function 编译，不注入任何同名假实现。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CLIENT = join(ROOT, 'client.js')

const LABEL = "'当前占用'"
const CLEAN_ATTR = "'data-bl-clean-now': ''"
const ALL_ATTR = "'data-bl-clear-all': ''"

const out = { fatal: null }

/** 收集一棵 h() 渲染树里的字符串叶子。 */
function stringsIn(n, acc = []) {
  if (n == null) return acc
  if (typeof n === 'string') { acc.push(n); return acc }
  if (Array.isArray(n)) { for (const x of n) stringsIn(x, acc); return acc }
  if (typeof n === 'object' && Array.isArray(n.kids)) { for (const x of n.kids) stringsIn(x, acc) }
  return acc
}

/** 从 h( 起点按圆括号配平切出整段调用；跳过字符串与 // 注释里的括号。 */
function balancedCall(src, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

try {
  const src = readFileSync(CLIENT, 'utf8')
  out.labelHits = src.split(LABEL).length - 1

  // ① cacheFactsNode 函数体：起止标记只依赖被抽对象自身（行首声明 → 行首 }）。
  const sig = /^(?:export\s+)?function\s+cacheFactsNode\s*\(/m
  const m = sig.exec(src)
  if (!m) {
    out.fatal = '找不到 cacheFactsNode 声明'
  } else {
    const end = src.indexOf('\n}', m.index)
    const body = end > m.index ? src.slice(m.index, end + 2) : ''
    out.factsBodyLength = body.length
    out.labelInFactsBody = body.includes(LABEL)
    out.factsBodyHasFactX = body.includes("'data-bl-fact-x': ''")

    // ② 原样函数体真求值。h 是最小渲染器，fmt 是最小格式化器，都是被测函数的入参。
    const h = (tag, props, ...kids) => ({ tag, props: props || {}, kids })
    const fmt = (n) => String(n)
    let F = null
    try {
      F = new Function(body + '\nreturn cacheFactsNode')()
    } catch (e) {
      out.fatal = 'cacheFactsNode 真求值编译失败：' + String(e?.message || e)
    }
    if (F) {
      const breakdown = {
        occupied: { bytes: 12345, files: 7 },
        removable: { bytes: 2000, count: 3 },
        unrecognized: { bytes: 10345, files: 4 },
        unrecognizedCount: 4,
      }
      let tree = null
      try {
        tree = F(h, { breakdown, fmt })
      } catch (e) {
        out.fatal = 'cacheFactsNode 真求值抛错：' + String(e?.message || e)
      }
      if (tree) {
        const rows = Array.isArray(tree.kids) ? tree.kids : []
        const labelRow = rows.find((row) => stringsIn(row).includes('当前占用'))
        const detail = labelRow && Array.isArray(labelRow.kids)
          ? labelRow.kids.find((k) => k && typeof k === 'object'
            && Object.prototype.hasOwnProperty.call(k.props || {}, 'data-bl-fact-x'))
          : null
        out.factsRender = {
          rows: rows.length,
          labelOnFactX: !!detail,
          usesBreakdown: !!detail && String((detail.kids || [])[0] || '').includes('12345'),
          labelRowTexts: labelRow ? stringsIn(labelRow).slice(0, 4) : [],
        }
      }
    }
  }

  // ③ sechead 区块：从含「抽帧缓存」标题的那一个 h('div', { 'data-bl-sechead': '' }, 起切。
  const titleAt = src.indexOf("'抽帧缓存'")
  const headAt = src.lastIndexOf("h('div', { 'data-bl-sechead': '' },", titleAt)
  const head = headAt >= 0 ? balancedCall(src, headAt) : ''
  out.secheadLength = head.length
  out.secheadHasTitle = head.includes("'抽帧缓存'")
  out.btnCleanInHead = head.split(CLEAN_ATTR).length - 1
  out.btnAllInHead = head.split(ALL_ATTR).length - 1
  out.btnCleanTotal = src.split(CLEAN_ATTR).length - 1
  out.btnAllTotal = src.split(ALL_ATTR).length - 1
} catch (e) {
  out.fatal = String(e?.stack || e)
}

process.stdout.write(JSON.stringify(out))
