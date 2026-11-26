/**
 * c502-fixedmeta-probe.mjs —— 2033 A-4 新旧对照回归。
 * 注入固定元数据四元组（size 保留真实、mtimeNs/ctimeNs/ino 固定），模拟「同 tick 等长改写」
 * 下旧四元组完全相同、内容成为唯一变量的现场。
 *   - 37ffaa4（只有元数据）：两次 token 相同 → 带旧清单真删 → 内容丢失（判据应转红）。
 *   - 新候选（追加内容摘要）：两次 token 不同 → 跳过 → 内容保住（判据转绿）。
 * 接受 argv[2]=产品根目录（默认当前）。输出 C502_FIXED_JSON=<json>。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.argv[2] || '.')
let src = fs.readFileSync(path.join(ROOT, 'lib', 'cache-own.mjs'), 'utf8')
// 两版共用的元数据片段：${st.mtimeNs}|${st.ctimeNs}|${st.ino}
const anchor = '${st.mtimeNs}|${st.ctimeNs}|${st.ino}'
const hits = src.split(anchor).length - 1
if (hits < 1) { console.log('C502_FIXED_JSON=' + JSON.stringify({ fatal: 'meta anchor not found', hits })); process.exit(0) }
src = src.split(anchor).join('FIXED|FIXED|FIXED')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c502f-'))
const libClone = path.join(tmp, 'lib')
fs.mkdirSync(libClone)
fs.writeFileSync(path.join(libClone, 'cache-own.mjs'), src)
for (const dep of fs.readdirSync(path.join(ROOT, 'lib'))) {
  const s = path.join(ROOT, 'lib', dep)
  if (fs.statSync(s).isFile() && dep !== 'cache-own.mjs') fs.copyFileSync(s, path.join(libClone, dep))
}
const out = { anchorHits: hits }
try {
  const own = await import(pathToFileURL(path.join(libClone, 'cache-own.mjs')).href)
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'c502f-root-'))
  fs.writeFileSync(path.join(r, '.bili-watch-root'), '')
  // 散文件：顶层 tool.txt
  const f = path.join(r, 'top.mwxyz123.tool.txt')
  fs.writeFileSync(f, '1111')
  const tok = own.previewAll(r, {}).tokens.slice()
  fs.writeFileSync(f, '2222') // 等长改写，元数据被注入固定 → 内容唯一变量
  const t2 = own.previewAll(r, {}).tokens.slice()
  const res = own.removeAllOwned(r, { mode: 'permanent', tokens: tok })
  out.loose = {
    tokenBefore: tok[0] || null, tokenAfter: t2[0] || null,
    tokenChanged: tok[0] !== t2[0],
    content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null,
    removedFiles: res.removedFiles,
    skippedKinds: [...new Set((res.skipped || []).map(s => s.kind))],
  }
  fs.rmSync(r, { recursive: true, force: true })
} catch (e) { out.fatal = String(e?.stack || e).slice(0, 600) }
finally { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
console.log('C502_FIXED_JSON=' + JSON.stringify(out))
