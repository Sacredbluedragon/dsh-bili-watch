// C205 夹具：把 tools/look.mjs 的 dayUtc 原样抠出来真跑，并检查两处调用同源。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(ROOT, 'tools', 'look.mjs'), 'utf8')
const i = src.indexOf('function dayUtc(')
const j = src.indexOf('\n}', i)
if (i < 0 || j < 0) throw new Error('dayUtc 抽取点变了')
const dayUtc = new Function(`return (${src.slice(i, j + 2)})`)()
console.log(JSON.stringify({
  normal: dayUtc(1762500000),
  zero: dayUtc(0),
  missing: dayUtc(undefined),
  callSites: (src.match(/const day = dayUtc\(it\.pubdate\)/g) || []).length,
  defCount: (src.match(/toISOString\(\)\.slice\(0, 10\)/g) || []).length,
}))
