// C200 夹具：把 client.js 的 versionLabel 原样抠出来真跑，并静态核 /status 回包确实带 version。
// 本机不启停服务（默认只读），后端字段只做源码核，未起 HTTP 真跑 —— 报告里如实标注。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const cli = readFileSync(join(ROOT, 'client.js'), 'utf8')
const idx = readFileSync(join(ROOT, 'index.js'), 'utf8')

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

const good = new Function(`return (${fnOf(cli, 'versionLabel')})`)()
const legacy = new Function(`return (function versionLabel(st) { return '' })`)()

console.log(JSON.stringify({
  v048: good({ version: '0.4.8' }),
  v049: good({ version: '0.4.9' }),
  empty: good({}),
  nullSt: good(null),
  badType: good({ version: 48 }),
  legacyV048: legacy({ version: '0.4.8' }),
  srcIndexField: idx.includes('version: PLUGIN_VERSION,'),
  srcIndexDef: idx.includes('const PLUGIN_VERSION = readPluginVersion(HERE)'),
  srcClientUsesFn: cli.includes('versionLabel(st) ? h('),
  srcClientNoteAttr: cli.includes("versionLabel(st) ? h('span', { 'data-bl-note': '' }"),
}))
