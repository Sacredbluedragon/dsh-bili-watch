// C359 取证夹具：真调 removeAllOwned 的两种收尾（容量溢出 / 正常直删），
// 输出「计划文件数」与「真删文件数」两列。stdout 只吐一行 JSON，结论由判据自己算。
// 所有造文件 / 删除只发生在 mkdtemp 假根，finally 里回收。
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const own = await import(pathToFileURL(join(ROOT, 'lib', 'cache-own.mjs')).href)

const NAMES = ['runs.jsonl', 'last-error.json', 'meta.json']
const out = { fatal: null }
const roots = []
const build = () => {
  const root = mkdtempSync(join(tmpdir(), 'bw-c359-'))
  roots.push(root)
  writeFileSync(join(root, '.bili-watch-root'), 'mark')
  // 三个 own 散文件：都在固定产物名单里，分类入口直接短路，不掺任何用户文件。
  for (const n of NAMES) writeFileSync(join(root, n), 'x')
  return root
}
const stillThere = (root) => NAMES.filter((n) => existsSync(join(root, n))).length
const overflowProbe = {
  // 上限 1 MB、当前已占 2 MB → room=0，recycle 档每个条目都放不下。
  binCount: () => ({ ok: true, count: 1, size: 2 * 1048576 }),
  capacityMB: () => 1,
  recycle: () => ({ ok: true }),
}

try {
  {
    const root = build()
    const r = own.removeAllOwned(root, { mode: 'recycle', probe: overflowProbe })
    out.overflow = {
      plannedFiles: r.plannedFiles, removedFiles: r.removedFiles, items: r.items,
      filesLegacy: r.files, bytes: r.bytes, overflowCount: r.overflow?.count,
      filesStillThere: stillThere(root),
    }
  }
  {
    const root = build()
    const r = own.removeAllOwned(root, { mode: 'permanent' })
    out.normal = {
      plannedFiles: r.plannedFiles, removedFiles: r.removedFiles, items: r.items,
      filesLegacy: r.files, bytes: r.bytes, overflowCount: r.overflow?.count,
      filesStillThere: stillThere(root),
    }
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 1200)
} finally {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }) } catch {} }
}
console.log(JSON.stringify(out))
