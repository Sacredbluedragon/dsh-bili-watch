// C206 夹具：把 client.js 的 fmtCleanMB 原样抠出来真跑，
// 并核清理回显两处同源、下载进度与依赖体积仍用 fmtBytes（不误伤）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
const m = /const fmtCleanMB = ([^\n]+)/.exec(src)
if (!m) throw new Error('fmtCleanMB 抽取点变了')
const fmtCleanMB = new Function(`return (${m[1]})`)()
const clean = src.slice(src.indexOf('缓存清理完成'), src.indexOf('此后按'))
console.log(JSON.stringify({
  small: fmtCleanMB(0),
  half: fmtCleanMB(524288),
  one: fmtCleanMB(1048576),
  big: fmtCleanMB(1073741824),
  cleanCallSites: (src.match(/fmtCleanMB\(d\.bytes\)/g) || []).length,
  cleanUsesFmtBytes: /fmtBytes\(Number\(d\.bytes/.test(clean),
  fmtBytesStillUsed: ['fmtBytes(dl.bytes)', 'fmtBytes(d.size)', 'fmtBytes(cache.bytes)']
    .every((s) => src.includes(s)),
  fmtBytesCallSites: (src.match(/fmtBytes\(/g) || []).length,
}))
