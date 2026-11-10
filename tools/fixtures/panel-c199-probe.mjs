// C199 夹具：把 client.js 的 lockNote 原样抠出来真跑。
// 验「有下载时点名目标 + 复用 why」「没下载时不占版面」「旧实现（只有图标）会被抓到」。
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

const good = new Function(`return (${fnOf(src, 'lockNote')})`)()
const legacy = new Function(`return (function lockNote(st) { return '' })`)()

const one = { downloading: ['ffmpeg'], download: {} }
const two = { downloading: ['ffmpeg', 'asr'], download: { why: '拿不到 .part 文件' } }
console.log(JSON.stringify({
  empty: good({}),
  emptyArr: good({ downloading: [] }),
  nullSt: good(null),
  one: good(one),
  two: good(two),
  noDownloadObj: good({ downloading: ['model'] }),
  legacyTwo: legacy(two),
  srcUsesFn: src.includes('lockNote(st) ? h('),
  srcNoteAttr: src.includes("lockNote(st) ? h('div', { 'data-bl-note': '' }"),
}))
