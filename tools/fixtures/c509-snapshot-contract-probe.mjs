/**
 * c509-snapshot-contract-probe.mjs —— 2128 续派 C509 新旧逐字段契约对照。
 * 从 git 50792ac:lib/ 导出旧实现，与当前 cachePreview 在同一磁盘状态上跑：
 * previewAll(count/files/bytes/tokens 有序/unknownFiles) 与
 * cacheBreakdown(occupied/removable/unrecognized/unrecognizedCount/unknownFiles) 必须逐字段一致。
 * 输出一行 CONTRACT_JSON=<json>，跑完自清临时根。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.argv[2] || '.')
const BASE_REF = process.argv[3] || '50792ac36e7c3d0774c2b704283a207516505910'
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c509-base-'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c509-root-'))
const out = {}

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}
function exportOldLib() {
  const tree = git(['ls-tree', '--name-only', BASE_REF, 'lib/'])
  if (tree.status !== 0) throw new Error(`ls-tree failed: ${tree.stderr}`)
  const files = String(tree.stdout || '').split('\n').map(s => s.trim()).filter(s => /^lib\/.*\.mjs$/.test(s))
  if (!files.length) throw new Error('old lib list empty')
  for (const pathspec of files) {
    const r = git(['show', `${BASE_REF}:${pathspec}`])
    if (r.status !== 0) throw new Error(`show failed: ${pathspec}: ${r.stderr}`)
    const dst = path.join(base, pathspec)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, r.stdout)
  }
  return path.join(base, 'lib', 'cache-own.mjs')
}
function pickPreview(p) {
  return { count: p.count, files: p.files, bytes: p.bytes, tokens: p.tokens, unknownFiles: p.unknownFiles }
}
function pickBreakdown(b) {
  return { occupied: b.occupied, removable: b.removable, unrecognized: b.unrecognized, unrecognizedCount: b.unrecognizedCount, unknownFiles: b.unknownFiles }
}

try {
  fs.writeFileSync(path.join(root, '.bili-watch-root'), '')
  const d = path.join(root, 'httpsb23.tvC5090001')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'a.mwxyz123.tool.txt'), 'snapshot-contract')
  fs.writeFileSync(path.join(root, 'user.txt'), 'foreign')
  fs.mkdirSync(path.join(root, '_logs'), { recursive: true })
  fs.writeFileSync(path.join(root, '_logs', 'run.log'), 'log')

  const oldPath = exportOldLib()
  const oldMod = await import(pathToFileURL(oldPath).href)
  const newMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'cache-own.mjs')).href)
  const oldPreview = pickPreview(oldMod.previewAll(root, {}))
  const oldBreakdown = pickBreakdown(oldMod.cacheBreakdown(root, {}))
  const combined = newMod.cachePreview(root, {})
  const newPreview = pickPreview(combined)
  const newBreakdown = pickBreakdown(combined.breakdown)
  out.old = { preview: oldPreview, breakdown: oldBreakdown }
  out.now = { preview: newPreview, breakdown: newBreakdown }
  out.samePreview = JSON.stringify(oldPreview) === JSON.stringify(newPreview)
  out.sameBreakdown = JSON.stringify(oldBreakdown) === JSON.stringify(newBreakdown)
  out.sameTokensOrder = JSON.stringify(oldPreview.tokens) === JSON.stringify(newPreview.tokens)
  out.sameUnknownFiles = JSON.stringify(oldPreview.unknownFiles) === JSON.stringify(newPreview.unknownFiles) &&
    JSON.stringify(oldBreakdown.unknownFiles) === JSON.stringify(newBreakdown.unknownFiles)
} catch (e) { out.fatal = String(e?.stack || e).slice(0, 1200) }
finally {
  try { fs.rmSync(base, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
}
console.log('CONTRACT_JSON=' + JSON.stringify(out))
