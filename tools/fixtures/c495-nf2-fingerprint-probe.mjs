/**
 * c495-nf2-fingerprint-probe.mjs —— B 件 N-F2 元数据四元组指纹真跑取证。
 * 四现场：①目录内等长改写保留mtime ②散文件同现场 ③正对照真删 ④预览代价。
 * 每现场都给「旧指纹（rel/size/mtimeMs）相同、新指纹（size|mtimeNs|ctimeNs|ino）不同」对照，
 * 证明问题确实在输入而不在哈希长度。输出一行 NF2_JSON=<json>，跑完自清临时根。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.argv[2] || '.')
const own = await import(pathToFileURL(path.join(ROOT, 'lib', 'cache-own.mjs')).href)
const { previewAll, removeAllOwned } = own
const exists = (p) => fs.existsSync(p)
const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// 旧算法复刻（仅取证对照）：相对路径|size|mtimeMs 排序 sha256 前16
function oldStyleFp(p) {
  const parts = []
  const walk = (dir, rel) => {
    let list
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { parts.push(rel + '|ERR'); return }
    for (const e of list) {
      if (e.name === '.bili-watch-root') continue
      const cp = path.join(dir, e.name)
      const crel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { walk(cp, crel); continue }
      try { const st = fs.statSync(cp); parts.push(`${crel}|${st.size}|${st.mtimeMs}`) } catch { parts.push(`${crel}|ERR`) }
    }
  }
  walk(p, '')
  parts.sort()
  return sha16(parts.join('\n'))
}
function tmpRoot(tag) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'nf2-' + tag + '-'))
  fs.writeFileSync(path.join(r, '.bili-watch-root'), '')
  return r
}
// 固定归一化时间戳：改写前后都恢复到同一个整数毫秒值（如 2024-01-01），
// 让旧算法（size|mtimeMs）在两次读取时完全一致；ctime/ino 无法被 utimes 改写，
// 必然随写入变化——这正是四元组能抓住「保留时间戳等长替换」的那一维。
const FIXED_SEC = 1704067200 // 2024-01-01T00:00:00Z
function rewriteKeepMtime(p, content) {
  fs.writeFileSync(p, content)
  fs.utimesSync(p, FIXED_SEC, FIXED_SEC)
}
function normalizeMtime(p) { fs.utimesSync(p, FIXED_SEC, FIXED_SEC) }
// ctimeNs 有同毫秒惰性（同一时钟 tick 内连续改写 ctime 可能不变），判据不能偶发红。
// 反复等长改写+短退避，直到产品自己的指纹 token 真的变化；不改产品语义，只让现场稳定触发。
async function rewriteUntilTokenChanges(r, filePath, tokenPrefix, content, beforeToken) {
  for (let i = 0; i < 15; i += 1) {
    rewriteKeepMtime(filePath, content)
    const t = previewAll(r, {}).tokens.find((x) => x.startsWith(tokenPrefix))
    if (t !== beforeToken) return t
    await new Promise((res) => setTimeout(res, 18))
  }
  return previewAll(r, {}).tokens.find((x) => x.startsWith(tokenPrefix))
}
const out = {}
const roots = []
try {
  // 现场1：目录内等长改写 + 保留 mtime
  {
    const r = tmpRoot('inner'); roots.push(r)
    const d = path.join(r, 'httpsb23.tvabc123'); fs.mkdirSync(d, { recursive: true })
    const f = path.join(d, 'sub_text.a1b2c3.tool.txt'); fs.writeFileSync(f, '1111')
    normalizeMtime(f)
    const oldBefore = oldStyleFp(d)
    const prev = previewAll(r, {}); const tokBefore = prev.tokens.slice()
    const newBefore = tokBefore.find(t => t.startsWith('httpsb23'))
    const newAfter = await rewriteUntilTokenChanges(r, f, 'httpsb23', '2222', newBefore)
    const oldAfter = oldStyleFp(d)
    const res = removeAllOwned(r, { mode: 'permanent', tokens: tokBefore })
    out.inner = {
      oldFpSame: oldBefore === oldAfter, oldBefore, oldAfter,
      newFpChanged: newBefore !== newAfter, newBefore, newAfter,
      content: fs.readFileSync(f, 'utf8'), dirKept: exists(d),
      items: res.items, removedFiles: res.removedFiles,
      skipped: (res.skipped || []).map(s => s.why),
    }
  }
  // 现场2：散文件等长改写 + 保留 mtime（meta.json 是 PROVEN_FIXED_NAMES 里的 own 散文件）
  {
    const r = tmpRoot('loose'); roots.push(r)
    const f = path.join(r, 'meta.json'); fs.writeFileSync(f, '1111')
    normalizeMtime(f)
    const oldBefore = sha16(`meta.json|${fs.statSync(f).size}|${fs.statSync(f).mtimeMs}`)
    const prev = previewAll(r, {}); const tokBefore = prev.tokens.slice()
    const newBefore = tokBefore.find(t => t.startsWith('meta.json'))
    const newAfter = await rewriteUntilTokenChanges(r, f, 'meta.json', '2222', newBefore)
    const oldAfter = sha16(`meta.json|${fs.statSync(f).size}|${fs.statSync(f).mtimeMs}`)
    const res = removeAllOwned(r, { mode: 'permanent', tokens: tokBefore })
    out.loose = {
      oldFpSame: oldBefore === oldAfter, oldBefore, oldAfter,
      newFpChanged: newBefore !== newAfter, newBefore, newAfter,
      content: exists(f) ? fs.readFileSync(f, 'utf8') : null,
      items: res.items, skipped: (res.skipped || []).map(s => s.why),
    }
  }
  // 现场3：正对照——未变化 → 整棵真删
  {
    const r = tmpRoot('positive'); roots.push(r)
    const d = path.join(r, 'httpsb23.tvKEEP'); fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'a.mwxyz123.tool.txt'), 'data')
    const prev = previewAll(r, {})
    const res = removeAllOwned(r, { mode: 'permanent', tokens: prev.tokens.slice() })
    out.positive = { removed: res.removed, removedFiles: res.removedFiles, dirGone: !exists(d) }
  }
  // 现场4：预览代价（自建固定样本，绝不读本机真实缓存根；性能数字仅信息，不参与 pass/fail）
  {
    const root = tmpRoot('bench'); roots.push(root)
    // 2033 B-1（Astra 2028 第2条）：bench 必须让 previewAll 真能认领。
    //   旧样本混了 user*.txt，urlDirAllProven 因 block 项整棵跳过 → count=0，量到的是「一次指纹都没算」的耗时。
    //   新样本：30 个 URL 形目录，每目录只放强凭证 tool.txt（纯产物、无混入），previewAll 应 count=30。
    const BENCH_DIRS = 30, FILES_PER_DIR = 5
    for (let i = 0; i < BENCH_DIRS; i++) {
      const d = path.join(root, `httpsb23.tvBENCH${String(i).padStart(2, '0')}`)
      fs.mkdirSync(d, { recursive: true })
      for (let j = 0; j < FILES_PER_DIR; j++) fs.writeFileSync(path.join(d, `a.mwxyz${String(i).padStart(3, '0')}${j}.tool.txt`), 'x'.repeat(512))
    }
    let files = 0, bytes = 0
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size } } }
    walk(root)
    // 产品实际返回值：count/files/bytes 必须与样本预期逐项相符（B-2 count>0 必须断言）。
    const pv = previewAll(root, {})
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 3; i++) previewAll(root, {})
    const t1 = process.hrtime.bigint()
    // 同时量全量内容哈希耗时，给「元数据指纹比内容哈希快」提供同机同规模的比值依据（不设绝对阈值）。
    const crypto = await import('node:crypto')
    const t2 = process.hrtime.bigint()
    for (let i = 0; i < 3; i++) {
      const walkHash = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkHash(p); else crypto.createHash('sha256').update(fs.readFileSync(p)).digest() } }
      walkHash(root)
    }
    const t3 = process.hrtime.bigint()
    const metaMs = Math.round(Number(t1 - t0) / 1e6 / 3 * 10) / 10
    const contentMs = Math.round(Number(t3 - t2) / 1e6 / 3 * 10) / 10
    out.bench = { root: '<自建临时样本>', dirs: BENCH_DIRS, filesPerDir: FILES_PER_DIR,
      files, bytes, count: pv.count, pvFiles: pv.files, pvBytes: pv.bytes, tokens: pv.tokens.length,
      metaMs, contentMs, ratio: contentMs > 0 ? Math.round(metaMs / contentMs * 100) / 100 : null }
  }
} catch (e) { out.fatal = String(e?.stack || e) }
finally { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch {} } }
console.log('NF2_JSON=' + JSON.stringify(out))
