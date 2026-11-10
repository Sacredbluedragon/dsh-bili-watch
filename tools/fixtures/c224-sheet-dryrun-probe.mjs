// C224：sheet --dry-run 出计划不出图。
// 三层取证：① 真跑 CLI（离线、缓存指向临时目录）② 跑前后目录逐文件快照 + existsSync 三零
// ③ 把 cmdSheet 开头到 grabFrames 那段源码原样切出在 vm 里跑，桩 grabFrames 计数。
// ③ 的意义：把短路摘掉时，会真的走到 grabFrames，判据红在「真抽帧了」而不是别的地方。
import { mkdtempSync, readdirSync, statSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { sheetPlan } from '../../lib/sheet-plan.mjs'
import { manifestPathOf } from '../../lib/sheet-manifest.mjs'
// C231：cmdSheet 干跑段里的落点 helper 是模块级自由变量，vm 切片跑不到定义；
//   补真 lib 实现（无配置时返回值与旧的 <TMP>/sheets/<name> 逐字节相同）。
import { pictureOutPath } from '../../lib/default-out.mjs'
// C233：cmdSheet 干跑段新增的 token 预算 helper，补真 lib 实现（不是恒值假桩）。
import { budgetWarnLine, tokenEstimateLine } from '../../lib/sheet-token.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const look = join(root, 'tools', 'look.mjs')
const src = readFileSync(look, 'utf8')

const snapshot = (dir) => {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out.push(`${relative(dir, p).split('\\').join('/')}:${st.size}`)
    }
  }
  walk(dir)
  return out.sort()
}

const tmp = mkdtempSync(join(tmpdir(), 'c224-'))
// 启动期台账先建好：这两份是**每条命令**都会写/追加的全局记录（migrate 根标记 + logRun 运行记录），
// 不是 dry-run 短路写的。放进基线，判据只比「新增路径」；但 size 变化仍如实输出。
mkdirSync(join(tmp, '_logs'), { recursive: true })
writeFileSync(join(tmp, '.bili-watch-root'), 'seed')
writeFileSync(join(tmp, '_logs', 'runs.jsonl'), '')
mkdirSync(join(tmp, 'sheets'), { recursive: true })
const env = { ...process.env, BILI_WATCH_CACHE: tmp }
const before = snapshot(tmp)
const runCli = (args) => {
  const r = spawnSync(process.execPath, [look, 'sheet', 'BV19dJQ6sE9F', ...args], { encoding: 'utf8', env, timeout: 30000 })
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}
// 短路被摘掉时**不真跑 CLI**：那会绕过 dry-run 去 grabFrames 发网络请求（风控 412）。
// 跳过要如实标出来，由桩版消费链报「真抽帧了」，判据的行为断言放在最前面。
const shortCircuitPresent = src.includes('  if (opts.dryRun) {')
const cliSkipped = !shortCircuitPresent
const withDur = cliSkipped ? { rc: null, out: 'skipped：短路被摘，避免联网' } : runCli(['--dry-run', '--dur', '123', '--grid', '4x4'])
const noDur = cliSkipped ? { rc: null, out: 'skipped：短路被摘，避免联网' } : runCli(['--dry-run'])
const after = snapshot(tmp)
const pathsOf = (arr) => arr.map((x) => x.split(':')[0])
const beforePaths = new Set(pathsOf(before))
// 只算「新增路径」：台账 append 会让 size 变，但不是新文件，也不属短路行为。
const newFiles = pathsOf(after).filter((p) => !beforePaths.has(p))
const changedFiles = after.filter((x) => !before.includes(x)).map((x) => x.split(':')[0]).filter((p) => beforePaths.has(p))
// 咬合：豁免不能是纸老虎 —— 注入一张假拼图，快照必须抓得到它。
writeFileSync(join(tmp, 'sheets', '__c224_injection.jpg'), 'x')
const injected = snapshot(tmp)
const injectionCaught = pathsOf(injected).filter((p) => !beforePaths.has(p)).includes('sheets/__c224_injection.jpg')
const outJpg = join(tmp, 'sheets', 'BV19dJQ6sE9F-p1-4x4.jpg')
const outManifest = join(tmp, 'sheets', 'BV19dJQ6sE9F-p1-4x4.manifest.json')

// 原样切出 cmdSheet 开头到 grabFrames 调用（含），在 vm 里跑一次 dryRun=true。
// 锚点一律从 bodyStart 起找：短路被摘时 dryAt 会是 -1，若拿它当起点会命中别处的
// grabFrames，切出空串，桩版什么都没跑（grabCalls 恒 0）—— 判据就成了纸老虎。
const startMark = 'async function cmdSheet(bv, opts = {}) {'
const start = src.indexOf(startMark)
const bodyStart = start + startMark.length
const dryAt = src.indexOf('  if (opts.dryRun) {', bodyStart)
const grabAt = src.indexOf('  const r = await grabFrames(', bodyStart)
const placementOk = dryAt > bodyStart && grabAt > dryAt
const grabLineEnd = src.indexOf('\n', grabAt)
const body = src.slice(bodyStart, grabLineEnd)
const logs = []
let grabCalls = 0
const sandbox = {
  String, Number, Math, Array, Object, JSON, console: { log: (...a) => logs.push(a.join(' ')), error: () => {} },
  process: { exitCode: 0 },
  opts: { dryRun: true, dur: '123', grid: '4x4', p: 1, at: '' },
  bv: 'BV19dJQ6sE9F',
  join: (...a) => a.join('/'),
  cacheDir: () => '<TMP>',
  artifactOut: (filename, explicitOut) => String(pictureOutPath({ cfg: {}, env: {}, cacheDir: '<TMP>', filename, explicitOut })).replace(/\\/g, '/'),
  budgetWarnLine: (t, b) => budgetWarnLine(t, b),
  tokenEstimateLine: (t) => tokenEstimateLine(t),
  warn: () => {},
  atTagOf: (s) => String(s),
  sheetPlan, manifestPathOf,
  grabFrames: async () => { grabCalls++; throw new Error('短路失效：真的去抽帧了') },
}
let chainError = ''
try {
  await vm.runInNewContext(`(async () => {${body}\n})()`, sandbox, { timeout: 3000 })
} catch (e) { chainError = String(e.message || e) }

// 纯函数两种输入
const plan = sheetPlan({ bv: 'BV19dJQ6sE9F', grid: '4x4', dur: 123, out: '<TMP>/out.jpg' })
const planNoDur = sheetPlan({ bv: 'BV19dJQ6sE9F', grid: '3x3', out: '<TMP>/out.jpg' })

// 必须在删临时目录之前取，否则恒 false 等于没验（自己造的假判据）
const outJpgExists = existsSync(outJpg)
const outManifestExists = existsSync(outManifest)
rmSync(tmp, { recursive: true, force: true })
console.log(JSON.stringify({
  cliSkipped, shortCircuitPresent, withDur, noDur, newFiles, changedFiles, injectionCaught,
  outJpgExists, outManifestExists,
  placementOk, bodyLength: body.length,
  grabCalls, chainError, chainLogs: logs,
  planLines: plan.lines, planNDurLines: planNoDur.lines,
  planToken: plan.token, planTimes: plan.times,
}))
