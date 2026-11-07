// C194 常驻夹具：F14-2「活锁被 unknown 折叠」的双向真跑。
//
// 设计约定（按本条判据的硬要求）：
//  · 真造目录：一个带活锁的 frames/BV1-p1-2s/.lock，一个 readdir 会抛 EACCES 的 blocked/。
//    不 mock lockState 的返回值 —— lockState 是 lib/locks.mjs 原样函数，只是把默认 readdir
//    换成「真 readdirSync + 指定目录抛 EACCES」的桩（c1a1a2-probe.mjs S7 的注入手法）。
//  · 真调被测对象：假 ctx + 真 import index.js + 真调 route.handler，和 c1a1a2-child.mjs 同形。
//  · 注入计数器落在被测对象之外：数 fs.rmSync 对缓存根下路径的调用、数 fs.readdirSync 对
//    缓存根（withFileTypes）的调用。文案对但真删了是最坏情况，所以「没删」必须由计数器 +
//    哨兵文件快照两条独立证据一起判；D2(a) 的 rootReads>=2 / deletes>0 反过来证明计数器有牙。
//  · 一个用例一个子进程：cacheDir() / CACHE_CFG 在 import 时定死，且桩是进程全局的。
//
// stdout 只打一行 JSON：{ defect, capability, notes }。全 true 才允许绿。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const IDX_URL = pathToFileURL(join(ROOT, 'index.js')).href
const LOCKS_URL = pathToFileURL(join(ROOT, 'lib/locks.mjs')).href
const TTL = 1800000

const defect = {}
const capability = {}
const notes = { runs: {} }

// 子进程代码：静态字符串拼接，避免模板字面量嵌套。文件写在系统临时目录，不进仓库。
const CHILD = [
  "import { createRequire, syncBuiltinESMExports } from 'node:module'",
  "import { Readable } from 'node:stream'",
  "import { existsSync } from 'node:fs'",
  "const require = createRequire(import.meta.url)",
  "const fs = require('node:fs')",
  "const plan = JSON.parse(process.env.C194_PLAN)",
  "const origReaddir = fs.readdirSync",
  "const origRm = fs.rmSync",
  "const norm = (p) => String(p).replace(/\\\\/g, '/').replace(/\\/+$/, '').toLowerCase()",
  "const BLOCKED = norm(plan.blocked)",
  "const CACHE = norm(plan.cache)",
  "const probe = { rootReads: 0, deletes: 0, eaccesHits: 0, readdirCalls: 0 }",
  "globalThis.__C194__ = { probe, reset() { probe.rootReads = 0; probe.deletes = 0; probe.eaccesHits = 0; probe.readdirCalls = 0 } }",
  "fs.readdirSync = function (p, opts) {",
  "  probe.readdirCalls++",
  "  const n = norm(p)",
  "  if (n === BLOCKED) { probe.eaccesHits++; const e = new Error('denied'); e.code = 'EACCES'; throw e }",
  "  if (n === CACHE && opts && opts.withFileTypes) probe.rootReads++",
  "  return origReaddir(p, opts)",
  "}",
  "fs.rmSync = function (p, opts) {",
  "  if (norm(p).indexOf(CACHE + '/') === 0) probe.deletes++",
  "  return origRm(p, opts)",
  "}",
  "syncBuiltinESMExports()",
  "let route = null",
  "const logs = []",
  "const ctx = {",
  "  logger: { warn: (s) => logs.push(String(s)), info: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)) },",
  "  commands: { register() {} }, on() {}, get() { return { register() {} } },",
  "  effect(fn) { return fn() },",
  "  webServer: { register(rt) { route = rt; return () => {} } },",
  "}",
  "let fatal = null",
  "try { const mod = await import(plan.idxUrl); mod.apply(ctx) } catch (e) { fatal = String(e && e.message || e) }",
  "if (!route && !fatal) fatal = 'NO_ROUTE'",
  "// 启动期 bootCache 也会读根/删文件，计数器只统计请求期间 —— 在 apply 之后清零。",
  "globalThis.__C194__.reset()",
  "const calls = []",
  "for (const c of (fatal ? [] : plan.calls)) {",
  "  const bodyStr = c.body === undefined ? '' : JSON.stringify(c.body)",
  "  const req = Readable.from(bodyStr ? [bodyStr] : [])",
  "  req.method = c.method; req.url = c.path",
  "  req.headers = { host: '127.0.0.1:1', 'content-type': 'application/json' }",
  "  req.socket = { remoteAddress: '127.0.0.1' }",
  "  let code = 0, payload = null",
  "  const res = { writeHead(n) { code = n; return this }, setHeader() { return this },",
  "    write() { return this }, end(b) { try { payload = JSON.parse(String(b)) } catch { payload = { raw: String(b) } } } }",
  "  try { await route.handler(req, res) } catch (e) { payload = { thrown: String(e && e.message || e) } }",
  "  calls.push({ path: c.path, code, payload,",
  "    sentinels: (plan.watchPaths || []).map((p) => ({ p, exists: existsSync(p) })) })",
  "}",
  "console.log(JSON.stringify({ ok: !fatal, fatal, calls, logs, probe }))",
  "process.exit(0)",
].join('\n')

const CODE_DIR = mkdtempSync(join(tmpdir(), 'bw-c194-code-'))
const CHILD_FILE = join(CODE_DIR, 'child.mjs')
writeFileSync(CHILD_FILE, CHILD, 'utf8')

const baseEnv = (over) => {
  const env = { ...process.env }
  for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME', 'C194_PLAN']) delete env[k]
  return { ...env, ...over }
}

function mkRoot(tag, { liveLock = false, blocked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bw-c194-' + tag + '-'))
  const home = join(root, 'home'), deps = join(root, 'deps'), cache = join(root, 'cache')
  for (const d of [home, deps, cache]) mkdirSync(d, { recursive: true })
  writeFileSync(join(cache, '.bili-watch-root'), '')
  // 关掉启动期的自动清理：bootCache 会删老文件，干扰哨兵与计数器基线。
  writeFileSync(join(deps, 'cache-config.json'), JSON.stringify({ days: 7, maxMb: 2048, autoClean: false }))
  const bv = join(cache, 'BV1aaaaaaaaa')
  mkdirSync(bv, { recursive: true })
  writeFileSync(join(bv, 'meta.json'), JSON.stringify({ files: ['BV1aaaaaaaaa-01.jpg'], at: Date.now() }))
  const jpg = join(bv, 'BV1aaaaaaaaa-01.jpg')
  writeFileSync(jpg, 'x') // 新 mtime：启动不清，只有 removeOwned 手动清会删
  const lockDir = join(cache, 'frames', 'BV1-p1-2s')
  if (liveLock) {
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), ttlMs: TTL }))
  }
  let blockedDir = null
  if (blocked) {
    blockedDir = join(cache, 'blocked')
    mkdirSync(blockedDir, { recursive: true })
    writeFileSync(join(blockedDir, 'x.txt'), 'x')
  }
  return { root, home, deps, cache, jpg, blockedDir, lockFile: join(lockDir, '.lock') }
}

function runChild(s, calls) {
  const plan = {
    idxUrl: IDX_URL, cache: s.cache, blocked: s.blockedDir || join(s.root, '__no_such_blocked__'),
    calls, watchPaths: [s.jpg],
  }
  const r = spawnSync(process.execPath, [CHILD_FILE], {
    encoding: 'utf8', timeout: 90000, cwd: ROOT,
    env: baseEnv({ DSH_HOME: s.home, BILI_WATCH_CACHE: s.cache, BILI_WATCH_DEPS: s.deps, C194_PLAN: JSON.stringify(plan) }),
  })
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean)
  let j = null
  try { j = JSON.parse(lines[lines.length - 1]) } catch {}
  return { rc: r.status, j, stderr: String(r.stderr || '').slice(-400), raw: String(r.stdout || '').slice(-400) }
}

const clear = (body) => ({ method: 'POST', path: '/api/bili-watch/cache/clear', body })
const first = (r) => r.j?.calls?.[0]
const alive = (r) => first(r)?.sentinels?.[0]?.exists === true
const dead = (r) => first(r)?.sentinels?.[0]?.exists === false

try {
  // —— D1：活锁 + EACCES + forceUnknown=1，仍必须拒绝，且 removeOwned 一次都没被调用 ——
  {
    const s = mkRoot('d1', { liveLock: true, blocked: true })
    const r = runChild(s, [clear({ forceUnknown: 1 })])
    const c = first(r), p = c?.payload, pr = r.j?.probe
    notes.runs.d1 = { rc: r.rc, fatal: r.j?.fatal, ok: p?.ok, why: p?.why, locked: p?.data?.locked,
      unknown: p?.data?.unknown, sentinelAlive: alive(r), probe: pr, stderr: r.stderr }
    defect.C194_d1Rejected = r.rc === 0 && !r.j?.fatal && p?.ok === false
    defect.C194_d1WhyHasBoth = /正在被占用/.test(String(p?.why || '')) && /读不出来/.test(String(p?.why || ''))
      && /EACCES/.test(String(p?.why || '')) && /forceUnknown=1/.test(String(p?.why || ''))
    defect.C194_d1LivePreserved = p?.data?.locked === true && p?.data?.unknown === true
    defect.C194_d1NoRemoveOwned = pr?.rootReads === 1 && pr?.deletes === 0 && alive(r)
    defect.C194_d1InjectReallyHit = (pr?.eaccesHits || 0) >= 1
  }

  // —— D2(a)：只有 EACCES、没有活锁 → forceUnknown=1 照旧放行（C174 能力不许被削） ——
  {
    const s = mkRoot('d2a', { blocked: true })
    const r = runChild(s, [clear({ forceUnknown: 1 })])
    const c = first(r), p = c?.payload, pr = r.j?.probe
    notes.runs.d2a = { rc: r.rc, fatal: r.j?.fatal, ok: p?.ok, removed: p?.data?.removed,
      sentinelGone: dead(r), probe: pr }
    capability.C194_d2aEaccesOnlyCleans = p?.ok === true && Number(p?.data?.removed) > 0 && dead(r)
    // 计数器有牙的反向证明：真清理时 rootReads 会到 2、deletes 会 >0；恒 0 的桩不许当门禁。
    capability.C194_d2aCounterHasTeeth = (pr?.rootReads || 0) >= 2 && (pr?.deletes || 0) > 0
  }

  // —— D2(b)：只有活锁、没有 EACCES → 带不带 forceUnknown 都拒绝（C174 S9 不退化） ——
  {
    const s = mkRoot('d2b', { liveLock: true })
    const r = runChild(s, [clear({}), clear({ forceUnknown: 1 })])
    const a = r.j?.calls?.[0]?.payload, b = r.j?.calls?.[1]?.payload
    const pr = r.j?.probe
    notes.runs.d2b = { rc: r.rc, fatal: r.j?.fatal, noForce: { ok: a?.ok, locked: a?.data?.locked, why: a?.why },
      withForce: { ok: b?.ok, locked: b?.data?.locked, why: b?.why }, probe: pr }
    defect.C194_d2bRejectNoForce = a?.ok === false && a?.data?.locked === true
    defect.C194_d2bRejectWithForce = b?.ok === false && b?.data?.locked === true
    defect.C194_d2bSentinelAlive = r.j?.calls?.[0]?.sentinels?.[0]?.exists === true
      && r.j?.calls?.[1]?.sentinels?.[0]?.exists === true
    defect.C194_d2bNoDelete = (pr?.deletes || 0) === 0
  }

  // —— D2(c)：两个都没有 → 正常清理 ——
  {
    const s = mkRoot('d2c')
    const r = runChild(s, [clear({})])
    const p = first(r)?.payload, pr = r.j?.probe
    notes.runs.d2c = { rc: r.rc, fatal: r.j?.fatal, ok: p?.ok, removed: p?.data?.removed, sentinelGone: dead(r), probe: pr }
    capability.C194_d2cBothAbsentCleans = p?.ok === true && Number(p?.data?.removed) > 0 && dead(r)
    capability.C194_noAlwaysRed = (pr?.eaccesHits || 0) === 0
  }

  // —— lib 层坐实：同一棵真目录 + 注入 readdir，unknown 返回值必须带 live ——
  {
    const { lockState } = await import(LOCKS_URL)
    const s = mkRoot('lib', { liveLock: true, blocked: true })
    // 真 readdirSync + 指定目录抛：不 mock 返回值，lockState 函数体原样跑。
    const { readdirSync } = await import('node:fs')
    const inj = (p, opts) => {
      if (String(p).replace(/\\/g, '/').toLowerCase() === String(s.blockedDir).replace(/\\/g, '/').toLowerCase()) {
        const e = new Error('denied'); e.code = 'EACCES'; throw e
      }
      return readdirSync(p, opts)
    }
    const ls = lockState(s.cache, TTL, { readdir: inj })
    notes.runs.lib = { state: ls.state, code: ls.code, hasLive: !!ls.live, pid: ls.live?.owner?.pid,
      lockPathTail: ls.live?.lockPath ? String(ls.live.lockPath).slice(-30) : null, keys: Object.keys(ls).sort() }
    defect.C194_libUnknownCarriesLive = ls.state === 'unknown' && ls.code === 'EACCES'
      && !!ls.live && Number(ls.live?.owner?.pid) > 0 && /\.lock$/.test(String(ls.live?.lockPath || ''))
  }
} catch (e) {
  notes.fatal = String(e?.stack || e)
} finally {
  try { rmSync(CODE_DIR, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify({ defect, capability, notes }))
