// C195 夹具：把 client.js 的 lastRunDetail 原样抠出来真跑。
// 两种形态一起验：① 当前实现要带退出码与耗时（该活时活）；
// ② 退回旧实现（只有时间 + 成功/失败）时目标文本必须消失（该红时红）。
// 夹具只输出原始字符串证据，判与不判交给 tools/verify.mjs 的 C195。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const src = readFileSync(join(ROOT, 'client.js'), 'utf8')

const fnOf = (s, name) => {
  const re = new RegExp(`(?:^|\\n)[ \\t]*function[ \\t]+${name}[ \\t]*\\(`, 'g')
  let hit = null
  for (let m; (m = re.exec(s));) hit = m
  if (!hit) throw new Error(`找不到 function ${name}`)
  const i = hit.index + hit[0].indexOf('function')
  const j = s.indexOf('\n}', i)
  if (j < 0) throw new Error(`${name} 没有行首闭合括号`)
  return s.slice(i, j + 2)
}

const fmtTime = (t) => `T${t}`
const mk = (fn) => new Function('fmtTime', `return (${fn})`)(fmtTime)

const good = mk(fnOf(src, 'lastRunDetail'))
// 旧实现（C1 修复前）：只显示时间 + 成功/失败，code/ms 全丢。
const legacy = [
  'function lastRunDetail(r) {',
  "  if (!r || !r.time) return '还没有记录'",
  "  return fmtTime(r.time) + '（' + (r.ok ? '成功' : '失败') + '）'",
  '}',
].join('\n')
const bad = mk(legacy)

console.log(JSON.stringify({
  goodFull: good({ time: 1, ok: true, code: 0, ms: 123 }),
  goodFail: good({ time: 2, ok: false, code: 2, ms: 45 }),
  goodNoCode: good({ time: 3, ok: true }),
  goodEmpty: good({}),
  goodNull: good(null),
  badFull: bad({ time: 1, ok: true, code: 0, ms: 123 }),
  srcHasCall: src.includes('lastRunDetail(lastRun)'),
}))
