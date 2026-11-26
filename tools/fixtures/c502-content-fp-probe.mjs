/**
 * c502-content-fp-probe.mjs —— 2033 A 件（Astra 2028 第1条）：内容摘要核对真跑取证。
 * 相对 37ffaa4 只靠元数据四元组挡不住「同 tick 等长改写并保留 mtime」。
 * 本夹具的现场全部「单次改写」，不含 rewriteUntilTokenChanges 那种「重试直到满足断言」的结构。
 * 支持 argv[2]=产品根目录（默认当前），便于对 37ffaa4 旧副本与新候选跑同一现场做红绿对照。
 * 输出一行 C502_JSON=<json>，跑完自清临时根。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.argv[2] || '.')
const own = await import(pathToFileURL(path.join(ROOT, 'lib', 'cache-own.mjs')).href)
const { previewAll, removeAllOwned } = own
const FIXED_SEC = 1704067200
function tmpRoot(tag) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'c502-' + tag + '-'))
  fs.writeFileSync(path.join(r, '.bili-watch-root'), '')
  return r
}
function rewriteKeepMtime(p, content) { fs.writeFileSync(p, content); fs.utimesSync(p, FIXED_SEC, FIXED_SEC) }
const out = {}
const roots = []
try {
  // 现场1：散文件（顶层 tool.txt）等长改写 + 保留 mtime，单次。
  {
    const r = tmpRoot('loose'); roots.push(r)
    const f = path.join(r, 'top.mwxyz123.tool.txt')
    fs.writeFileSync(f, '1111'); fs.utimesSync(f, FIXED_SEC, FIXED_SEC)
    const tok = previewAll(r, {}).tokens.slice()
    rewriteKeepMtime(f, '2222') // 单次，不重试
    const t2 = previewAll(r, {}).tokens.slice()
    const res = removeAllOwned(r, { mode: 'permanent', tokens: tok })
    out.loose = {
      tokenBefore: tok[0] || null, tokenAfter: t2[0] || null,
      tokenChanged: tok[0] !== t2[0],
      content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null,
      removedFiles: res.removedFiles,
      skippedKinds: [...new Set((res.skipped || []).map(s => s.kind))],
    }
  }
  // 现场2：目录内文件（URL 目录）等长改写 + 保留 mtime，单次。
  {
    const r = tmpRoot('inner'); roots.push(r)
    const d = path.join(r, 'httpsb23.tvC5020001')
    fs.mkdirSync(d)
    const f = path.join(d, 'a.mwxyz456.tool.txt')
    fs.writeFileSync(f, '1111'); fs.utimesSync(f, FIXED_SEC, FIXED_SEC)
    const tok = previewAll(r, {}).tokens.slice()
    const before = tok.find(t => t.startsWith('httpsb23'))
    rewriteKeepMtime(f, '2222') // 单次，不重试
    const t2 = previewAll(r, {}).tokens.slice()
    const after = t2.find(t => t.startsWith('httpsb23'))
    const res = removeAllOwned(r, { mode: 'permanent', tokens: tok })
    out.inner = {
      tokenChanged: before !== after,
      content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null,
      removedFiles: res.removedFiles, dirKept: fs.existsSync(d),
      skippedKinds: [...new Set((res.skipped || []).map(s => s.kind))],
    }
  }
  // 现场3：正对照——未变化对象仍整棵真删。
  {
    const r = tmpRoot('positive'); roots.push(r)
    const d = path.join(r, 'httpsb23.tvC502POS01')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'a.mwxyz789.tool.txt'), 'data')
    const tok = previewAll(r, {}).tokens.slice()
    const res = removeAllOwned(r, { mode: 'permanent', tokens: tok })
    out.positive = { count: previewAll(r, {}).count, removedFiles: res.removedFiles, dirGone: !fs.existsSync(d) }
  }
  // 现场4：读不全保留——用注入版 clone 让特定文件 openSync 失败（见 verify 侧说明）。
  //   这里用真实手法：文件名含 PROVEN 但内容被进程占用难造，改为顶层放一个指向不存在目标的 junction 失败场景跳过；
  //   读不全分支由 c502-readerr-probe.mjs 单独取证（本夹具不重复）。
  // 现场5：成本三数——候选集规模 + 首次预览 + 二次预览（显式声明首次变慢这一用户可观察变化）。
  {
    const r = tmpRoot('cost'); roots.push(r)
    // 30 URL 目录 × 5 tool.txt，纯产物可认领
    for (let i = 0; i < 30; i++) {
      const d = path.join(r, `httpsb23.tvC502C${String(i).padStart(2, '0')}`)
      fs.mkdirSync(d)
      for (let j = 0; j < 5; j++) fs.writeFileSync(path.join(d, `a.mwxyz${String(i).padStart(3, '0')}${j}.tool.txt`), 'x'.repeat(1024))
    }
    let files = 0, bytes = 0
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size } } }
    walk(r)
    const t0 = process.hrtime.bigint()
    const first = previewAll(r, {})
    const t1 = process.hrtime.bigint()
    const second = previewAll(r, {})
    const t2 = process.hrtime.bigint()
    out.cost = {
      dirs: 30, filesPerDir: 5, files, bytes,
      count: first.count, tokens: first.tokens.length,
      firstMs: Math.round(Number(t1 - t0) / 1e6 * 10) / 10,
      secondMs: Math.round(Number(t2 - t1) / 1e6 * 10) / 10,
    }
  }
} catch (e) { out.fatal = String(e?.stack || e).slice(0, 800) }
finally { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch {} } }
console.log('C502_JSON=' + JSON.stringify(out))
