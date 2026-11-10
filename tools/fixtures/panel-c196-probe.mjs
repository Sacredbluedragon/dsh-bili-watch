// C196 夹具：把 client.js 的页面级 head 与「运行依赖」sechead 两个 h(...) 调用
// 按括号平衡真切出来（不是简单 grep 行号），判刷新按钮到底挂在谁里面。
// 同时做一次「移回 sechead」的内存扰动，证明结构判定不是纸老虎。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

// 从 '(' 下标起，引号/行注释感知地切出整个调用表达式
const callSpan = (s, open) => {
  let depth = 0, q = ''
  for (let i = open; i < s.length; i++) {
    const c = s[i], n = s[i + 1]
    if (q) {
      if (c === '\\') { i++; continue }
      if (c === q) q = ''
      continue
    }
    if (c === '/' && n === '/') {
      const e = s.indexOf('\n', i)
      i = e < 0 ? s.length : e
      continue
    }
    if (c === "'" || c === '"' || c === '`') { q = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

const blocksOf = (s, marker) => {
  const out = []
  let from = 0, p
  while ((p = s.indexOf(marker, from)) >= 0) {
    const open = s.indexOf('(', p)
    const end = callSpan(s, open)
    if (end > 0) out.push({ start: p, end, text: s.slice(p, end) })
    from = p + marker.length
  }
  return out
}

const analyse = (s) => {
  const heads = blocksOf(s, "h('div', { 'data-bl-head': '' }")
  const secs = blocksOf(s, "h('div', { 'data-bl-sechead': '' }")
  const head = heads.find((b) => b.text.includes('依赖与状态')) || heads[0] || { text: '' }
  const sec = secs.find((b) => b.text.includes('运行依赖')) || { text: '' }
  const t = head.text, u = sec.text
  return {
    headHasRefresh: t.includes("'刷新'"),
    headHasFresh: /await load\(true\)/.test(t),
    headHasDisabled: /disabled:\s*refreshing/.test(t),
    headHasFeedback: t.includes('刷新中'),
    headHasTitle: t.includes('依赖与状态'),
    secHasRefresh: u.includes("'刷新'"),
    secHasTitle: u.includes('运行依赖'),
    refreshCount: s.split("'刷新'").length - 1,
    headLen: t.length,
    secLen: u.length,
  }
}

const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
const real = analyse(src)

// 内存扰动：把 head 里的刷新按钮整块抽出来，塞回「运行依赖」sechead，再算一次。
const heads = blocksOf(src, "h('div', { 'data-bl-head': '' }")
const head = heads.find((b) => b.text.includes('依赖与状态')) || heads[0]
const btnRe = /h\('button', \{\s*'data-bl-btn': '',\s*disabled: refreshing,[\s\S]*?\}, refreshing \? '刷新中…' : '刷新'\)/
const btnM = btnRe.exec(head ? head.text : '')
const anchor = "h('span', { 'data-bl-sec-title': '' }, '运行依赖'),"
let moved = null
if (btnM && src.includes(anchor)) {
  const movedSrc = src.replace(btnM[0], '').replace(anchor, anchor + '\n            ' + btnM[0] + ',')
  moved = analyse(movedSrc)
}

console.log(JSON.stringify({ real, moved, btnFound: Boolean(btnM), anchorFound: src.includes(anchor) }))
