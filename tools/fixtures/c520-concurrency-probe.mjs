// C520-C523：1603 续修四现场——同内容并发复用 / 不同内容无损分流 / 冲突副本幂等 / 归档状态三档。
// driver 模式 spawn 自己 --child，每个 SCENE 独立临时 DSH_HOME（避 lib/cache-path.mjs 的
// initCachePath 进程级单例串根），真调 archiveOldLogs / archiveStatusSummary，用第二参 _opts.testHook
// 稳定模拟并发窗口（不靠 sleep、不改对外生产接口）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SELF = fileURLToPath(import.meta.url)
const LIB = pathToFileURL(path.resolve(path.dirname(SELF), '../../lib/cache-path.mjs')).href

if (process.argv[2] === '--child') {
  const SCENE = process.env.SCENE
  const HOME = process.env.HOME_DIR
  const bili = path.join(HOME, 'bili-watch')
  const topLogs = path.join(bili, '_logs')
  const arcDir = path.join(bili, 'logs', 'archive', 'old-root')
  const W = (d, f, s) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, f), s) }
  const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
  const mod = await import(LIB + '?t=' + Date.now())
  const { archiveOldLogs, archiveStatusSummary } = mod
  // 未执行档：本进程还没跑过归档
  const notRunSum = archiveStatusSummary()
  let R, extra = {}

  if (SCENE === 'same-content') {
    W(topLogs, 'runs.jsonl', 'V1-SAME')
    W(arcDir, 'runs.jsonl', 'V1-SAME') // 主档已有同内容（模拟并发先到者写完）
    R = archiveOldLogs()
    const files = fs.readdirSync(arcDir).filter((f) => !f.endsWith('.tmp')).sort()
    extra = { notRunSum, runSum: archiveStatusSummary(), main: rd(path.join(arcDir, 'runs.jsonl')), files }
  } else if (SCENE === 'diff-content') {
    W(topLogs, 'runs.jsonl', 'V1-MINE')
    let hookHits = 0
    R = archiveOldLogs(null, {
      testHook({ dst, name }) {
        if (name === 'runs.jsonl') { hookHits++; fs.writeFileSync(dst, 'V1-OTHER-PROCESS') }
      },
    })
    const files = fs.readdirSync(arcDir).filter((f) => !f.endsWith('.tmp')).sort()
    extra = {
      notRunSum, runSum: archiveStatusSummary(), hookHits,
      main: rd(path.join(arcDir, 'runs.jsonl')), two: rd(path.join(arcDir, 'runs.jsonl.2')),
      srcKept: rd(path.join(topLogs, 'runs.jsonl')), files,
      tmpLeft: fs.readdirSync(arcDir).filter((f) => f.endsWith('.tmp')),
    }
  } else if (SCENE === 'conflict-reuse') {
    W(topLogs, 'runs.jsonl', 'V2-SAME')
    W(arcDir, 'runs.jsonl', 'V1-ORIGINAL')
    W(arcDir, 'runs.jsonl.2', 'V2-SAME')
    const R1 = archiveOldLogs()
    const R2 = archiveOldLogs()
    R = R2
    const files = fs.readdirSync(arcDir).filter((f) => !f.endsWith('.tmp')).sort()
    extra = {
      notRunSum, runSum: archiveStatusSummary(), R1: { archived: R1.archived, reused: R1.reused },
      R2: { archived: R2.archived, reused: R2.reused },
      main: rd(path.join(arcDir, 'runs.jsonl')), two: rd(path.join(arcDir, 'runs.jsonl.2')), files,
    }
  } else if (SCENE === 'status-done') {
    W(topLogs, 'runs.jsonl', 'STATUS-DONE')
    R = archiveOldLogs()
    extra = { notRunSum, runSum: archiveStatusSummary() }
  } else if (SCENE === 'status-partial') {
    W(topLogs, 'runs.jsonl', 'STATUS-PART')
    fs.mkdirSync(path.join(topLogs, 'subdir'), { recursive: true }) // 非普通文件→skipped
    R = archiveOldLogs()
    extra = { notRunSum, runSum: archiveStatusSummary(), skipCount: R.skipped.length }
  } else {
    process.stdout.write('C520_JSON=' + JSON.stringify({ error: 'bad SCENE ' + SCENE }) + '\n')
    process.exit(0)
  }
  process.stdout.write('C520_JSON=' + JSON.stringify({
    scene: SCENE,
    R: { archived: R.archived, reused: R.reused, conflicts: R.conflicts.length, errors: R.errors.length, skipped: R.skipped.length },
    ...extra,
  }) + '\n')
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c520-conc-'))
const scenes = ['same-content', 'diff-content', 'conflict-reuse', 'status-done', 'status-partial']
const out = {}
for (const s of scenes) {
  const home = path.join(root, s, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env = { ...process.env, DSH_HOME: home, SCENE: s, HOME_DIR: home }
  delete env.BILI_WATCH_CACHE
  const r = spawnSync(process.execPath, [SELF, '--child'], { env, encoding: 'utf8', timeout: 30000 })
  const m = /C520_JSON=(.*)/.exec(r.stdout || '')
  try { out[s] = { rc: r.status, ...(m ? JSON.parse(m[1]) : { parseFail: true, stdout: r.stdout, stderr: r.stderr }) } }
  catch (e) { out[s] = { rc: r.status, jsonError: String(e) } }
}
process.stdout.write('C520_JSON_ALL=' + JSON.stringify(out) + '\n')
try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
