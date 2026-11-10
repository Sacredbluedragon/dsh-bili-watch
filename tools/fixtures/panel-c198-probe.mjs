// C198 夹具：把 client.js 的 depPathNote 原样抠出来真跑。
// 验「六项运行依赖也显示路径」「凭证行保留文件：措辞」「没 path 不显示」，
// 并用旧实现（只有 credential 才显示）做对照。
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

const good = new Function(`return (${fnOf(src, 'depPathNote')})`)()
const legacy = new Function(`return (function depPathNote(d) {
  return d && d.id === 'credential' && d.path ? '文件：' + d.path : ''
})`)()

const ffmpeg = { id: 'ffmpeg', path: 'C:/bin/ffmpeg.exe', ok: true }
const cred = { id: 'credential', path: 'C:/home/cred.json', ok: true }
const ids = ['ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'cuda']
console.log(JSON.stringify({
  ids,
  allSix: ids.map((id) => good({ id, path: 'P/' + id, ok: true })),
  ffmpeg: good(ffmpeg),
  model: good({ id: 'model', path: 'D:/deps/model', ok: true }),
  cred: good(cred),
  noPath: good({ id: 'cuda', ok: true }),
  emptyPath: good({ id: 'cuda', path: '' }),
  nullDep: good(null),
  legacyFfmpeg: legacy(ffmpeg),
  srcNoOldBranch: !src.includes("d.id === 'credential' && d.path ? h('span'"),
  srcUsesFn: src.includes('depPathNote(d) ? h('),
}))
