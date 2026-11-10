// C197 夹具：把 client.js 的 tuneDefaultLabel 原样抠出来真跑。
// 验「后端改默认值后面板跟着变」「asrMaxSec 秒→分钟只在一处换算」「缺 meta 退回兜底」，
// 并用一份硬编码旧实现做对照，证明判据不是只看有没有这个函数。
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

const fn = fnOf(src, 'tuneDefaultLabel')
const good = new Function(`return (${fn})`)()
const legacy = new Function(`return (function tuneDefaultLabel(key, meta, unit, fallback) {
  return '30 分钟'
})`)()

const meta = (o) => ({ defaults: o, ranges: {} })
const out = {
  asr1800: good('asrMaxSec', meta({ asrMaxSec: 1800 }), '分钟', '30 分钟'),
  asr2400: good('asrMaxSec', meta({ asrMaxSec: 2400 }), '分钟', '30 分钟'),
  frames500: good('maxFrames', meta({ maxFrames: 500 }), '张', '500 张'),
  frames777: good('maxFrames', meta({ maxFrames: 777 }), '张', '500 张'),
  missing: good('maxFrames', meta({}), '张', '500 张'),
  nullMeta: good('maxFrames', null, '张', '500 张'),
  legacyAsr2400: legacy('asrMaxSec', meta({ asrMaxSec: 2400 }), '分钟', '30 分钟'),
  noHardcodedDef: !["def: '30 分钟'", "def: '500 张'", "def: '900 秒'", "def: '300 秒'", "def: '180 秒'", 'def: `${x.def} ${x.unit}`'].some((s) => src.includes(s)),
  callCount: (src.match(/tuneDefaultLabel\(/g) || []).length,
  restoreCalls: (src.match(/已恢复默认（\$\{tuneDefaultLabel/g) || []).length,
  convInFn: fn.includes('/ 60'),
  convAtDef: /def:[^\n]*\/ 60/.test(src),
  srcHasAsrCall: src.includes("tuneDefaultLabel('asrMaxSec', tuneMeta, '分钟', '30 分钟')"),
}
console.log(JSON.stringify(out))
