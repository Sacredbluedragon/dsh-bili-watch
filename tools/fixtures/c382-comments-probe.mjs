/**
 * C382 / H 取证：真起 look.mjs 进程跑 comments，只把 HTTP 响应换成本地替身。
 *   两组桩（有 rcount>2 / 全 ≤2）× 两种渲染（默认 / --full）× 两个出口（text / json）。
 *   结论由主闸判据自己算，这里只交出 stdout、stderr 与 json 出口。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const PRELOAD = pathToFileURL(join(HERE, 'bili-mock-preload.mjs')).href
const WORKER = new URL('./c382-render-worker.mjs', import.meta.url)
const BV = 'BV1c38200001'

const start = async (variant) => {
  const worker = new Worker(WORKER, { workerData: { variant } })
  const port = await new Promise((resolve, reject) => {
    worker.once('message', (m) => resolve(m.port))
    worker.once('error', reject)
  })
  return { worker, port }
}

const run = (port, full, format) => {
  const home = mkdtempSync(join(tmpdir(), 'bw-c382-home-'))
  const deps = mkdtempSync(join(tmpdir(), 'bw-c382-deps-'))
  const cache = mkdtempSync(join(tmpdir(), 'bw-c382-cache-'))
  const env = { ...process.env }
  for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME', 'BILI_WATCH_FFMPEG']) delete env[k]
  Object.assign(env, { BW_MOCK_PORT: String(port), DSH_HOME: home, BILI_WATCH_DEPS: deps, BILI_WATCH_CACHE: cache })
  const args = ['comments', BV, '3']
  if (full) args.push('--full')
  if (format === 'json') args.push('--format', 'json')
  const r = spawnSync(process.execPath, ['--import', PRELOAD, LOOK, ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  })
  let payload = null
  if (format === 'json') { try { payload = JSON.parse((r.stdout || '').trim()) } catch {} }
  const out = {
    status: r.status,
    stdout: (r.stdout || '').slice(0, 6000),
    stderr: (r.stderr || '').slice(0, 600),
    payload,
    repliesLens: Array.isArray(payload?.replies) ? payload.replies.map((x) => x.items?.length ?? -1) : [],
    subLines: ((r.stdout || '').match(/└ /g) || []).length,
  }
  for (const d of [home, deps, cache]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  return out
}

let fatal = ''
const result = {}
try {
  for (const variant of ['mixed', 'small']) {
    const { worker, port } = await start(variant)
    result[variant] = {
      jsonDefault: run(port, false, 'json'),
      jsonFull: run(port, true, 'json'),
      textDefault: run(port, false, 'text'),
      textFull: run(port, true, 'text'),
    }
    await worker.terminate()
  }
} catch (e) {
  fatal = String(e?.stack ?? e)
}
process.stdout.write(JSON.stringify({ fatal, ...result }))
