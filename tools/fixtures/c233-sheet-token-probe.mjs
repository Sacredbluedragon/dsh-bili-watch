// C233 sheet 视觉 token 预算取证夹具：stdout 只吐 JSON。
// ① 真 lib 纯函数；② 真 CLI 三组 dry-run（默认 / 小预算 / 显式 --out），核三零与不阻断；
// ③ 真源码切片跑 cmdSheet 的非干跑开头，核「拼图前先报同一行 token」。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { TUNING_DEFS, normalizeTuning } from '../../lib/tuning.mjs'
import { tokenBudgetOf, budgetWarnLine, tokenEstimateLine } from '../../lib/sheet-token.mjs'
import { sheetPlan } from '../../lib/sheet-plan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c233-'))
const cache = join(tmp, 'cache')
const deps = join(tmp, 'deps')
mkdirSync(deps, { recursive: true })
const BV = 'BV19dJQ6sE9F'

function snapshot(dir) {
  const out = []
  const walk = (d, rel) => {
    let items = []
    try { items = readdirSync(d) } catch { return }
    for (const name of items) {
      const p = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      let st = null
      try { st = statSync(p) } catch {}
      if (st?.isDirectory()) walk(p, r)
      else out.push(`${r}:${st?.size ?? '?'}`)
    }
  }
  walk(dir, '')
  return out.sort()
}

function runCli({ budget = null, grid = '3x3', explicit = '' } = {}) {
  const cfg = budget == null ? {} : { sheetTokenBudget: budget }
  writeFileSync(join(deps, 'deps-config.json'), JSON.stringify(cfg) + '\n', 'utf8')
  const before = snapshot(cache)
  const env = { ...process.env, BILI_WATCH_CACHE: cache, BILI_WATCH_DEPS: deps, DSH_HOME: join(tmp, 'home') }
  delete env.BILI_WATCH_OUT
  const args = [LOOK, 'sheet', BV, '--dry-run', '--dur', '60', '--grid', grid]
  if (explicit) args.push('--out', explicit)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 })
  const after = snapshot(cache)
  const fresh = after.filter((x) => !before.includes(x))
  // C224 同口径：缓存根标记与 runs.jsonl 台账 append 是启动期写入，不算「干跑落盘」；
  //   这里只把真正的产物文件算进 newFiles，另把台账条数如实带出去。
  const ledger = (x) => x.startsWith('_logs/runs.jsonl') || x.startsWith('.bili-watch-root')
  const out = String(r.stdout || '')
  return {
    rc: r.status,
    out,
    err: String(r.stderr || ''),
    planLines: out.split(/\r?\n/).filter((l) => l.startsWith('[dry-run]')).length,
    hasToken: out.includes('预计 token'),
    hasOver: /超过预算/.test(String(r.stderr || '')),
    newFiles: fresh.filter((x) => !ledger(x)),
    ledgerWrites: fresh.filter(ledger).length,
  }
}

const result = { pure: {}, cli: {}, vm: {} }
try {
  result.pure = {
    def: TUNING_DEFS.sheetTokenBudget.def,
    fromDefault: tokenBudgetOf(normalizeTuning({})),
    fromCfg: tokenBudgetOf(normalizeTuning({ sheetTokenBudget: 100 })),
    // 低于 min 的越界值：与其它 tuning 项同一套行为——回落 def，不是钳到 min。
    belowMin: tokenBudgetOf(normalizeTuning({ sheetTokenBudget: 5 })),
    // C240：别再手写期望数，直接取 sheetPlan 的真值，公式改了这里自动跟着变。
    noWarn: budgetWarnLine(sheetPlan({ bv: BV, grid: '3x3' }).token, 12000),
    warn: budgetWarnLine(sheetPlan({ bv: BV, grid: '3x3' }).token, 100),
    estimate: tokenEstimateLine(sheetPlan({ bv: BV, grid: '3x3' }).token),
    token9: sheetPlan({ bv: BV, grid: '3x3' }).token,
    token16: sheetPlan({ bv: BV, grid: '4x4' }).token,
  }

  result.cli.default = runCli()
  result.cli.small = runCli({ budget: 100 })
  result.cli.smallWithOut = runCli({ budget: 100, explicit: join(tmp, 'explicit.jpg') })
  result.cli.bigGrid = runCli({ budget: 100, grid: '4x4' })

  // ③ 真源码切片：cmdSheet 开头到 grabFrames 之前，opts.dryRun=false → 应先打 token 行再走到抽帧
  const src = readFileSync(join(ROOT, 'tools', 'look.mjs'), 'utf8')
  const mark = 'async function cmdSheet(bv, opts = {}) {'
  const st = src.indexOf(mark)
  const grabAt = src.indexOf('  const r = await grabFrames(', st)
  const body = src.slice(st + mark.length, src.indexOf('\n', grabAt))
  const logs = []
  let chainError = ''
  const sandbox = {
    String, Number, Math, Array, Object, JSON,
    console: { log: (...a) => logs.push(a.map(String).join(' ')), error: () => {} },
    process: { exitCode: 0 },
    opts: { grid: '3x3', p: 1, at: '', dur: '60', tokenBudget: 12000 },
    bv: BV,
    join: (...a) => a.join('/'), dirname: (p) => String(p).split('/').slice(0, -1).join('/'),
    cacheDir: () => '<TMP>', atTagOf: (s) => String(s),
    sheetPlan, manifestPathOf: (p) => String(p).replace(/\.jpg$/, '.manifest.json'),
    artifactOut: (f, e) => e || `<TMP>/sheets/${f}`,
    budgetWarnLine, tokenEstimateLine, warn: () => {},
    grabFrames: async () => { throw new Error('走到抽帧（切片按预期到此为止）') },
  }
  try { await vm.runInNewContext(`(async () => {${body}\n})()`, sandbox, { timeout: 3000 }) } catch (e) { chainError = String(e.message || e) }
  result.vm = { bodyLength: body.length, logs, chainError, firstIsToken: logs[0]?.includes('预计 token：约') === true }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
