/**
 * C386 / C387 取证（0.4.12 第三刀，1547 派单 F3 + F6）。
 *   F3 ①：真调 lib/bili-api.mjs 的 topComments（只桩 get），三态验 truncated 与 note 措辞。
 *   F3 ②：真起 look.mjs 进程跑 comments --format json（HTTP 换成本地替身），验 payload 字段。
 *   F6：四个非法条数真跑 CLI（校验发生在发请求之前），另跑合法 3 与不传条数两条路径。
 *   结论由主闸判据自己算，这里只交出真跑输出。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { topComments } from '../../lib/bili-api.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const PRELOAD = pathToFileURL(join(HERE, 'bili-mock-preload.mjs')).href
const WORKER = new URL('./c382-render-worker.mjs', import.meta.url)
const BV = 'BV1c38200001'

// ── F3 ①：真调 API，三态（主动少取 / 被动截断 / 无差额） ──────────────────
const clip = (s) => String(s).slice(0, 5000)
const reply = (rpid) => ({
  rpid, ctime: 1700000000, like: 1, state: 0,
  member: { uname: `U${rpid}`, mid: rpid },
  content: { message: `评论 ${rpid}` }, rcount: 0,
})
const page = (n, allCount) => ({
  code: 0,
  data: {
    replies: Array.from({ length: n }, (_, i) => reply(i + 1)),
    cursor: { next: 1, is_end: true, all_count: allCount },
  },
})
const apiCase = async (name, want, count, allCount, loggedIn) => {
  const r = await topComments({ get: async () => page(count, allCount), clip }, 999, want, { loggedIn })
  return { name, want, loggedIn: r.loggedIn, total: r.total, shown: r.shown, truncated: r.truncated, note: r.note }
}

// ── F3 ② / F6：真起 look 进程，HTTP 走本地 worker ────────────────────────
const start = async (variant) => {
  const worker = new Worker(WORKER, { workerData: { variant } })
  const port = await new Promise((resolve, reject) => {
    worker.once('message', (m) => resolve(m.port))
    worker.once('error', reject)
  })
  return { worker, port }
}
const run = (port, args) => {
  const home = mkdtempSync(join(tmpdir(), 'bw-c386-home-'))
  const deps = mkdtempSync(join(tmpdir(), 'bw-c386-deps-'))
  const cache = mkdtempSync(join(tmpdir(), 'bw-c386-cache-'))
  const env = { ...process.env }
  for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME', 'BILI_WATCH_FFMPEG']) delete env[k]
  Object.assign(env, { BW_MOCK_PORT: String(port), DSH_HOME: home, BILI_WATCH_DEPS: deps, BILI_WATCH_CACHE: cache })
  const r = spawnSync(process.execPath, ['--import', PRELOAD, LOOK, ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  })
  let payload = null
  try { payload = JSON.parse((r.stdout || '').trim()) } catch {}
  const out = {
    rc: r.status,
    stdout: (r.stdout || '').slice(0, 400),
    stderr: (r.stderr || '').slice(0, 500),
    payload,
  }
  for (const d of [home, deps, cache]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  return out
}

let fatal = ''
let apiCases = []
let payload = null
let numInvalid = []
let numValid = {}
try {
  apiCases = [
    await apiCase('active', 2, 2, 100, true),
    await apiCase('passive', 10, 2, 100, false),
    await apiCase('complete', 10, 2, 2, true),
    // 第二轮块 8 抓到的边界：不指定条数、默认上限 10 条取满且上游更多。
    //   这态也走「按请求只取前 N 条」，判据不能只测显式指定 num 的那一态。
    await apiCase('defaultFull', 10, 10, 100, true),
  ]
  // many：12 根顶层，all_count=12。要 2 条 → 主动少取且 payload 带差额标记。
  const { worker, port } = await start('many')
  const two = run(port, ['comments', BV, '2', '--format', 'json'])
  payload = {
    status: two.rc,
    stderr: two.stderr,
    keys: two.payload ? Object.keys(two.payload) : [],
    total: two.payload?.total,
    shown: two.payload?.shown,
    truncated: two.payload?.truncated,
    loggedIn: two.payload?.loggedIn,
    note: two.payload?.note ?? '',
  }
  for (const n of ['-5', 'abc', '0', '201']) {
    const r = run(port, ['comments', BV, n, '--format', 'json'])
    numInvalid.push({ num: n, rc: r.rc, stderr: r.stderr })
  }
  const with3 = run(port, ['comments', BV, '3', '--format', 'json'])
  const dflt = run(port, ['comments', BV, '--format', 'json'])
  numValid = {
    with3: { rc: with3.rc, shown: with3.payload?.shown, stderr: with3.stderr },
    default: { rc: dflt.rc, shown: dflt.payload?.shown, stderr: dflt.stderr },
  }
  await worker.terminate()
} catch (e) {
  fatal = String(e?.stack ?? e)
}
process.stdout.write(JSON.stringify({ fatal, apiCases, payload, numInvalid, numValid }))
