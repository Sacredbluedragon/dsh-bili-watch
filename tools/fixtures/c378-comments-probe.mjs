/**
 * C378/C379/C381 取证：真起一个 look.mjs 进程跑 comments --format json，只把 HTTP 响应换成本地夹具。
 *   两种凭证态各跑一次（DSH_HOME 隔离，不碰本机真凭证），记录请求头里的 Cookie 与 json 出口。
 *   结论由主闸三条判据自己算，这里不注入任何同名假实现、不预判对错。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const PRELOAD = pathToFileURL(join(HERE, 'bili-mock-preload.mjs')).href
const WORKER = new URL('./c378-comments-worker.mjs', import.meta.url)
const BV = 'BV1c37800001'

const dir = mkdtempSync(join(tmpdir(), 'bw-c378-'))
const logFile = join(dir, 'hits.jsonl')
writeFileSync(logFile, '')

const worker = new Worker(WORKER, { workerData: { logFile } })
const port = await new Promise((resolve, reject) => {
  worker.once('message', (m) => resolve(m.port))
  worker.once('error', reject)
})

const hits = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const run = (withCred) => {
  const home = mkdtempSync(join(tmpdir(), 'bw-c378-home-'))
  const deps = mkdtempSync(join(tmpdir(), 'bw-c378-deps-'))
  const cache = mkdtempSync(join(tmpdir(), 'bw-c378-cache-'))
  if (withCred) {
    mkdirSync(join(home, 'bili-watch'), { recursive: true })
    writeFileSync(join(home, 'bili-watch', 'credential.json'), JSON.stringify({
      sessdata: 'SESSDATA_FIXTURE',
      bili_jct: 'JCT_FIXTURE',
      buvid3: 'BUVID3_FIXTURE',
      buvid4: 'BUVID4_FIXTURE',
    }))
  }
  const env = { ...process.env }
  for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME', 'BILI_WATCH_FFMPEG']) delete env[k]
  Object.assign(env, {
    BW_MOCK_PORT: String(port),
    DSH_HOME: home,
    BILI_WATCH_DEPS: deps,
    BILI_WATCH_CACHE: cache,
  })
  writeFileSync(logFile, '')
  const r = spawnSync(process.execPath, ['--import', PRELOAD, LOOK, 'comments', BV, '3', '--format', 'json'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  })
  let payload = null
  try { payload = JSON.parse((r.stdout || '').trim()) } catch { /* 非法 JSON 交给判据报失效 */ }
  const out = {
    status: r.status,
    payload,
    hits: hits(),
    stdout: (r.stdout || '').slice(0, 800),
    stderr: (r.stderr || '').slice(0, 800),
  }
  for (const d of [home, deps, cache]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  return out
}

let fatal = ''
let anon = null
let cred = null
try {
  anon = run(false)
  cred = run(true)
} catch (e) {
  fatal = String(e?.stack ?? e)
}
await worker.terminate()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

process.stdout.write(JSON.stringify({ fatal, anon, cred }))
