// C367：日志不参与任何清理。
// 真调产品函数，只写 mkdtemp 假根：两档 dryRun + 真删 + 面板占用。
// 正向能力：login-qr.png 有凭证、必进 plan、真删后应消失 —— 防「整棵树没跑」的假绿。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { removeOwned, removeAllOwned, cacheBreakdown, isOwnedEntry, dirStat } from '../../lib/cache-own.mjs'
import { CACHE_MARK } from '../../lib/consts.mjs'

const out = {}
const root = mkdtempSync(join(tmpdir(), 'bw-c367-'))
const put = (rel, data) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, data, 'utf8')
  return p
}
const runsPath = join(root, '_logs', 'runs.jsonl')
const linesOf = (p) => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : -1
const names = (list) => (list || []).map((e) => e.name)
const withWhy = (list) => (list || []).map((e) => ({ name: e.name, why: e.why }))

try {
  put(CACHE_MARK, '{}')
  put('_logs/runs.jsonl', '{"command":"view","code":0}\n{"command":"text","code":0}\n')
  put('_logs/migrate.log', 'migrated')
  put('login-qr.png', 'QR')
  put('我的素材.zip', 'ZIP')

  const runsBefore = linesOf(runsPath)
  const dryOwned = removeOwned(root, { dryRun: true, mode: 'permanent' })
  const dryAll = removeAllOwned(root, { dryRun: true, mode: 'permanent' })
  // 0.4.18：日志搬出三栏。第四栏用 logsDir 单独统计；缓存根里的旧 _logs 不再计入 occupied。
  const bd = cacheBreakdown(root, { logsDir: join(root, '_logs') })

  out.dry = {
    ownedPlan: names(dryOwned.plan),
    ownedSkipped: withWhy(dryOwned.skipped),
    allPlan: names(dryAll.plan),
    allSkipped: withWhy(dryAll.skipped),
    autoClaimsLogs: isOwnedEntry(root, join(root, '_logs')) === true,
    occupied: bd.occupied,               // 0.4.18：已不含 _logs
    logs: bd.logs,                       // 第四栏：日志字节单独统计
    statNoLogs: dirStat(root),           // 默认口径（本就等于去日志后的 occupied）
    runsLinesBefore: runsBefore,
  }

  const real = removeAllOwned(root, { mode: 'permanent' })
  out.real = {
    runsStillThere: existsSync(runsPath),
    runsLinesAfter: linesOf(runsPath),
    qrGone: !existsSync(join(root, 'login-qr.png')),
    userZipSurvived: existsSync(join(root, '我的素材.zip')),
    removedFiles: real.removedFiles,
    plannedFiles: real.plannedFiles,
  }
} catch (e) {
  out.fatal = String(e?.stack || e)
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
