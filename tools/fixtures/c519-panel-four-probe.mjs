// C519：面板四栏取证——occupied 去日志、X=Y+Z 恢复、第四栏 logs 独立统计含历史副本。
// 真调 cacheBreakdown/cachePreview，自建缓存根+独立 logsDir，不读写真实缓存。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
const M = await import(pathToFileURL(path.resolve(process.argv[2] || '.', 'lib/cache-own.mjs')).href)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c519-cache-'))
const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c519-logs-'))
const W = (d, f, s) => { fs.mkdirSync(path.join(d, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s) }
try {
  W(root, '.bili-watch-root', '{}')
  W(root, 'httpsb23.tvB2000001/a.mwxyz123.tool.txt', 'x'.repeat(100))
  W(root, 'user-file.txt', 'u'.repeat(50))
  W(root, '_logs/runs.jsonl', 'L'.repeat(200)) // 旧残留日志在缓存根内
  W(logsDir, 'runs.jsonl', 'N'.repeat(30))
  W(logsDir, 'archive/old-root/runs.jsonl', 'A'.repeat(70)) // 历史副本

  const b = M.cacheBreakdown(root, { logsDir })
  const p = M.cachePreview(root, { logsDir })
  const X = b.occupied.bytes, Y = b.removable.bytes, Z = b.unrecognized.bytes
  const out = {
    occupied: b.occupied, removable: b.removable, unrecognized: b.unrecognized, logs: b.logs,
    xEqYZ: X === Y + Z,
    logsBytesOk: b.logs.bytes === 100,   // 30+70，不含缓存根内旧 _logs 的 200
    logsFileOk: b.logs.files === 2,
    previewLogsOk: p.breakdown.logs.bytes === 100,
    noOldLogsInX: X === 150,             // 100 产物 + 50 用户文件，不含 200 日志
    samePreviewBreakdown: JSON.stringify(b) === JSON.stringify(p.breakdown),
  }
  process.stdout.write('C519_JSON=' + JSON.stringify(out) + '\n')
} catch (e) {
  process.stdout.write('C519_JSON=' + JSON.stringify({ fatal: String(e?.stack || e) }) + '\n')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(logsDir, { recursive: true, force: true }) } catch {}
}
