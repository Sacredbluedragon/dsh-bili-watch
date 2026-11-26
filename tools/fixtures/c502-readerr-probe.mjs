/**
 * c502-readerr-probe.mjs —— 2033 A-2 读不全保留取证。
 * 造一份 cache-own.mjs 的 clone，把「打不开文件」注入为对含 UNREADABLE 的路径 openSync 抛错，
 * 验证带 withContent 时该对象不进 entries、进 skipped（无法核实，保留）。
 * 输出一行 C503_JSON=<json>，跑完自清。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.argv[2] || '.')
let src = fs.readFileSync(path.join(ROOT, 'lib', 'cache-own.mjs'), 'utf8')
const marker = "try { fd = openSync(p, 'r') } catch { return null }"
if (!src.includes(marker)) { console.log('C503_JSON=' + JSON.stringify({ fatal: 'openSync anchor not found' })); process.exit(0) }
src = src.replace(marker, "try { fd = openSync(p, 'r'); if (p.includes('UNREADABLE')) { closeSync(fd); throw new Error('simulated-EACCES') } } catch { return null }")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c503-'))
const libClone = path.join(tmp, 'lib')
fs.mkdirSync(libClone)
fs.writeFileSync(path.join(libClone, 'cache-own.mjs'), src)
for (const dep of fs.readdirSync(path.join(ROOT, 'lib'))) {
  const s = path.join(ROOT, 'lib', dep)
  if (fs.statSync(s).isFile() && dep !== 'cache-own.mjs') fs.copyFileSync(s, path.join(libClone, dep))
}
const out = {}
try {
  const own = await import(pathToFileURL(path.join(libClone, 'cache-own.mjs')).href)
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'c503-root-'))
  fs.writeFileSync(path.join(r, '.bili-watch-root'), '')
  fs.writeFileSync(path.join(r, 'top.mwxyz123.tool.txt'), '1111')           // 正常
  fs.writeFileSync(path.join(r, 'UNREADABLE.mwxyz789.tool.txt'), '1111')     // 注入读失败
  const en = own.enumerateForAll(r, { withContent: true })
  out.normalInEntries = en.entries.some(e => e.name === 'top.mwxyz123.tool.txt')
  out.unreadableInEntries = en.entries.some(e => e.name === 'UNREADABLE.mwxyz789.tool.txt')
  const unreadable = en.skipped.find(s => String(s.name).includes('UNREADABLE') && String(s.why).includes('读不全'))
  out.unreadableSkipped = Boolean(unreadable)
  out.unreadableSkippedKind = unreadable?.kind || null
  out.unreadableSkippedWhy = unreadable?.why || null
  fs.rmSync(r, { recursive: true, force: true })
} catch (e) { out.fatal = String(e?.stack || e).slice(0, 600) }
finally { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
console.log('C503_JSON=' + JSON.stringify(out))
