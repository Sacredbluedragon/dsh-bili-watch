// 1354 第一批取证夹具：新日志根改道 + migrate.log 止写。
//   driver 模式 spawn 两份独立子进程（child 模式），各自设隔离 DSH_HOME 再 import lib，
//   避开 verify.mjs 本进程已经 init 过的 cache-path 单例，也避免改 env 污染别的判据。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

function childEnv(home) {
  const e = { ...process.env }
  e.DSH_HOME = home
  delete e.BILI_WATCH_CACHE
  return e
}

// child 模式：migrate 止写实验。造旧根例行跳过项(deps/)，连跑三次 migrateLegacyCache，
// 再放一个真 BV 目录跑一次，分别报告 migrate.log 行数。
function runMigrateChild(home) {
  const script = `
import { migrateLegacyCache, defaultLogsRoot } from ${JSON.stringify('file://' + join(ROOT, 'lib', 'cache-path.mjs').replace(/\\\\/g, '/'))}
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const log = join(defaultLogsRoot(), 'migrate.log')
const lines = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0
migrateLegacyCache(); const a = lines()
migrateLegacyCache(); const b = lines()
migrateLegacyCache(); const c = lines()
console.log(JSON.stringify({ before: a, second: b, third: c, logExists: existsSync(log) }))
`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: childEnv(home), cwd: ROOT, timeout: 30000,
  })
  return { rc: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// child 模式：放一个真 BV 目录后跑一次 migrate（有实际迁移才该写一行）。
function runMigrateWithBvChild(home) {
  const script = `
import { migrateLegacyCache, defaultLogsRoot } from ${JSON.stringify('file://' + join(ROOT, 'lib', 'cache-path.mjs').replace(/\\\\/g, '/'))}
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
migrateLegacyCache()
const log = join(defaultLogsRoot(), 'migrate.log')
const n = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0
console.log(JSON.stringify({ lines: n, exists: existsSync(log) }))
`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: childEnv(home), cwd: ROOT, timeout: 30000,
  })
  return { rc: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function main() {
  const base = mkdtempSync(join(tmpdir(), 'c515-'))
  try {
    const home = join(base, 'home')
    const bw = join(home, 'bili-watch')
    mkdirSync(join(bw, 'deps'), { recursive: true }) // 例行跳过项，非 OWN_CACHE_DIRS、非 BV
    const stop = runMigrateChild(home)
    // 再放一个真 BV 目录（老迁移认领），跑一次
    mkdirSync(join(bw, 'BV1a2b3c4d5e'), { recursive: true })
    const withBv = runMigrateWithBvChild(home)
    // 四写手改道：源码静态确认都用 defaultLogsRoot
    const idxSrc = readFileSync(join(ROOT, 'index.js'), 'utf8')
    const lookSrc = readFileSync(join(ROOT, 'tools', 'look.mjs'), 'utf8')
    const cpHit = /runsFile\s*=\s*\(\)\s*=>\s*join\(defaultLogsRoot\(\),\s*'runs\.jsonl'\)/.test(idxSrc)
    const lookHit = /runsFile\s*=\s*\(\)\s*=>\s*join\(defaultLogsRoot\(\),\s*'runs\.jsonl'\)/.test(lookSrc)
    const crashHit = /const dir\s*=\s*defaultLogsRoot\(\)/.test(lookSrc)
    const cpImport = /defaultLogsRoot/.test(idxSrc) && /defaultLogsRoot/.test(lookSrc)
    const out = {
      stop: { ...stop, json: safeJson(stop.out) },
      withBv: { ...withBv, json: safeJson(withBv.out) },
      writers: { indexRuns: cpHit, lookRuns: lookHit, lookCrash: crashHit, bothImport: cpImport },
    }
    process.stdout.write('C515_JSON=' + JSON.stringify(out) + '\n')
  } finally { rmSync(base, { recursive: true, force: true }) }
}

function safeJson(s) { try { return JSON.parse(s) } catch { return null } }

if (process.argv[2] === '--run') main()
else main()
