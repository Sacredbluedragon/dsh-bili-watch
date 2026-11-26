/**
 * c499-same-byte-rewrite-probe.mjs —— C 件同字节重写行为记录判据取证。
 * 构造「预览 → 同字节 tmp+rename 重写 → 带旧清单清理」，断言：
 *   ino 变化、指纹 token 变化、removedFiles===0、目录保住、skipped 里有 kind:'changed' 条目。
 * 模拟 writeMeta 的 tmp+rename（内容字节完全相同），证明「同字节重写也判内容已变化」这一
 * 故意保留的保守行为被判据固定下来。输出一行 REWRITE_JSON=<json>，跑完自清临时根。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.argv[2] || '.')
const own = await import(pathToFileURL(path.join(ROOT, 'lib', 'cache-own.mjs')).href)
const { previewAll, removeAllOwned } = own
const exists = (p) => fs.existsSync(p)
const out = {}
const roots = []
try {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'samebyte-'))
  roots.push(r)
  fs.writeFileSync(path.join(r, '.bili-watch-root'), '')
  const d = path.join(r, 'httpsb23.tvSAME001')
  fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, 'a.mwxyz123.tool.txt')
  const CONTENT = 'same-bytes-content'
  fs.writeFileSync(f, CONTENT)
  const inoBefore = fs.statSync(f).ino
  const tokBefore = previewAll(r, {}).tokens.slice()
  const fpBefore = tokBefore.find((t) => t.startsWith('httpsb23'))
  // 模拟 writeMeta 的 tmp+rename：写入完全相同的字节，但走新 inode。
  const tmp = f + '.tmp-rewrite'
  fs.writeFileSync(tmp, CONTENT)
  fs.renameSync(tmp, f)
  const inoAfter = fs.statSync(f).ino
  const fpAfter = previewAll(r, {}).tokens.find((t) => t.startsWith('httpsb23'))
  const res = removeAllOwned(r, { mode: 'permanent', tokens: tokBefore })
  out.rewrite = {
    contentSame: fs.readFileSync(f, 'utf8') === CONTENT,
    inoChanged: inoBefore !== inoAfter,
    fpChanged: fpBefore !== fpAfter,
    removedFiles: res.removedFiles,
    dirKept: exists(d),
    changedSkipped: (res.skipped || []).filter((s) => s.kind === 'changed').map((s) => s.why),
    allSkippedKinds: (res.skipped || []).map((s) => s.kind || null),
  }
} catch (e) { out.fatal = String(e?.stack || e) }
finally { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch {} } }
console.log('REWRITE_JSON=' + JSON.stringify(out))
