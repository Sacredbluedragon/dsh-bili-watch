// C167（A1 开关）/ C168（A2 skipReason + lastRealClean）/ C174（C1 锁三态）常驻夹具。
//
// 设计约定：
//  · 一个用例一个真进程：模块级状态（CACHE_CFG / lastCleanAt / lastRealClean）与 env 都在 import 时定死，
//    注入伪造测不出「启动那次到底做了什么」。
//  · 「关开关后启动不清」必须用**会被清掉的老文件**做对照：默认开时 bootCache 会删、关了才不删。
//    用刚造的新文件判「没清」是假绿（开着也不会删）。
//  · C174 的 unknown 至少一次真权限（icacls /deny 造 EPERM），EACCES 只走注入并单列「未核」一栏。
//  · 清理顺序固定：先 icacls /remove:d，再 rmSync，否则 deny 过的目录删不掉、临时目录越堆越多。
//
// stdout 只打一行 JSON：{ defect, capability, notes }。defect/capability 全 true 才允许绿。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const IDX = join(ROOT, 'index.js')
const CHILD = join(HERE, 'c1a1a2-child.mjs')
const USER = process.env.USERNAME || process.env.USER || ''
const TTL = 1800000

const defect = {}
const capability = {}
const notes = { eperm: { attempted: false, threw: false, code: null }, env: { user: USER, win32: process.platform === 'win32' } }
const sandboxes = []
const occurrences = (src, needle) => src.split(needle).length - 1
// 计数只数代码行：index.js / locks.mjs 的注释里会写「原来调 xxx(...)」当作反例说明，
// 连注释一起数会把「调用点几个」数多，也会让删了真调用点的扰动被注释顶成假绿。
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const baseEnv = (over) => {
  const env = { ...process.env }
  for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME']) delete env[k]
  return { ...env, ...over }
}
const icacls = (args) => spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 })

function mkRoot(tag, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bw-c1a1a2-' + tag + '-'))
  const home = join(root, 'home'); mkdirSync(home, { recursive: true })
  const deps = join(root, 'deps'); mkdirSync(deps, { recursive: true })
  const cache = join(root, 'cache'); mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, '.bili-watch-root'), '')
  const bv = join(cache, 'BV1aaaaaaaaa'); mkdirSync(bv, { recursive: true })
  writeFileSync(join(bv, 'meta.json'), JSON.stringify({ files: ['BV1aaaaaaaaa-01.jpg'], at: Date.now() }))
  const jpg = join(bv, 'BV1aaaaaaaaa-01.jpg')
  writeFileSync(jpg, 'x')
  // 8 天前：默认开时 bootCache 的按天清理必然删它，关开关才留得住。这是 C167 的对照前提。
  const old = (Date.now() - 8 * 86400000) / 1000
  utimesSync(jpg, old, old)
  if (opts.cfg) writeFileSync(join(deps, 'cache-config.json'), JSON.stringify(opts.cfg))
  if (opts.liveLock) {
    writeFileSync(join(cache, 'a.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), ttlMs: TTL }))
  }
  if (opts.staleLock) {
    writeFileSync(join(cache, 'a.lock'), JSON.stringify({ pid: 99999999, at: Date.now(), ttlMs: TTL }))
  }
  if (opts.deep) {
    const p = join(cache, 'frames', 'a', 'b', 'c', 'd')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'deep.txt'), 'x')
  }
  let blocked = null
  if (opts.deny) {
    blocked = join(cache, 'blocked')
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, 'x.txt'), 'x')
    icacls([blocked, '/deny', USER + ':(R)'])
  }
  const s = { root, home, deps, cache, jpg, blocked, deny: !!opts.deny }
  sandboxes.push(s)
  return s
}

function runChild(s, calls, extraEnv = {}) {
  const env = baseEnv({ DSH_HOME: s.home, BILI_WATCH_CACHE: s.cache, BILI_WATCH_DEPS: s.deps, ...extraEnv })
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify({ calls, watchPaths: [s.jpg] }), IDX],
    { encoding: 'utf8', env, timeout: 90000, cwd: ROOT })
  let parsed = null
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean)
  try { parsed = JSON.parse(lines[lines.length - 1]) } catch {}
  return { rc: r.status, parsed, stdoutTail: String(r.stdout || '').slice(-300), stderrTail: String(r.stderr || '').slice(-300) }
}
const call = (r, i) => r.parsed?.calls?.[i]
const cacheOf = (c) => c?.payload?.data?.cache
const stateOf = (c) => cacheOf(c)?.lastAutoClean?.skipReason?.state

try {
  // —— S1：默认开 + 老文件 → bootCache 真清掉（对照组的「该清时清」）——
  {
    const s = mkRoot('s1')
    const r = runChild(s, [{ method: 'GET', path: '/api/bili-watch/status' }])
    capability.C167_defaultOnReallyCleans = cacheOf(call(r, 0))?.autoClean === true && call(r, 0)?.files?.[0]?.exists === false
    notes.s1 = { rc: r.rc, fatal: r.parsed?.fatal, state: stateOf(call(r, 0)), jpgAfter: call(r, 0)?.files?.[0]?.exists }
  }

  // —— S2：关开关 + 老文件 → 启动不清、面板说 disabled、手动清仍清得掉 ——
  {
    const s = mkRoot('s2', { cfg: { days: 7, maxMb: 2048, autoClean: false } })
    const r = runChild(s, [
      { method: 'GET', path: '/api/bili-watch/status' },
      { method: 'POST', path: '/api/bili-watch/cache/clear', body: {} },
    ])
    const st = call(r, 0), cl = call(r, 1)
    defect.C167_offDisabled = stateOf(st) === 'disabled'
    capability.C167_bootDidNotClean = st?.files?.[0]?.exists === true
    capability.C167_manualStillClears = cl?.payload?.ok === true && cl?.payload?.data?.removed > 0 && cl?.files?.[0]?.exists === false
    defect.C167_clearSkippedArray = Array.isArray(cl?.payload?.data?.skipped)
    defect.C167_autoCleanSkippedBoolean = typeof cacheOf(st)?.lastAutoClean?.skipped === 'boolean'
    notes.s2 = { rc: r.rc, fatal: r.parsed?.fatal, state: stateOf(st), jpgAfterStatus: st?.files?.[0]?.exists,
      clearOk: cl?.payload?.ok, removed: cl?.payload?.data?.removed, jpgAfterClear: cl?.files?.[0]?.exists }
  }

  // —— S3：/config 只传 maxMb 不抹 autoClean（patch 语义，漏点就是在这里）——
  {
    const s = mkRoot('s3')
    const r = runChild(s, [
      { method: 'POST', path: '/api/bili-watch/config', body: { autoClean: false } },
      { method: 'POST', path: '/api/bili-watch/config', body: { maxMb: 3000 } },
      { method: 'GET', path: '/api/bili-watch/status' },
    ])
    defect.C167_patchPreserves = call(r, 1)?.payload?.data?.autoClean === false
      && call(r, 2)?.payload?.data?.cache?.autoClean === false
      && stateOf(call(r, 2)) === 'disabled'
    notes.s3 = { rc: r.rc, first: call(r, 0)?.payload?.ok, second: call(r, 1)?.payload?.data?.autoClean,
      statusAutoClean: cacheOf(call(r, 2))?.autoClean, state: stateOf(call(r, 2)) }
  }

  // —— S4：坏值回 true（只有显式 false 才关）——
  {
    const s = mkRoot('s4', { cfg: { days: 7, maxMb: 2048, autoClean: 'garbage' } })
    const r = runChild(s, [{ method: 'GET', path: '/api/bili-watch/status' }])
    defect.C167_badValueFallsBackTrue = cacheOf(call(r, 0))?.autoClean === true && stateOf(call(r, 0)) !== 'disabled'
    notes.s4 = { rc: r.rc, autoClean: cacheOf(call(r, 0))?.autoClean, state: stateOf(call(r, 0)) }
  }

  // —— S5：活锁从启动就在 → 连打 3 次 /status 都 locked（C168 D2）——
  {
    const s = mkRoot('s5', { liveLock: true })
    const r = runChild(s, [0, 1, 2].map(() => ({ method: 'GET', path: '/api/bili-watch/status' })))
    const states = [0, 1, 2].map((i) => stateOf(call(r, i)))
    defect.C168_lockedStable = states.every((x) => x === 'locked')
    notes.s5 = { rc: r.rc, states }
  }

  // —— S6：bootCache 那次（含 truncated）不能被启动后第一次 /status 的节流盖掉 ——
  {
    const s = mkRoot('s6', { deep: true })
    const r = runChild(s, [0, 1, 2].map(() => ({ method: 'GET', path: '/api/bili-watch/status' })))
    const cs = [0, 1, 2].map((i) => call(r, i))
    // 不能只判「不是 throttled」：把 lastAutoClean 整个换成 {} 也能过。必须同时要求它
    // 带着真跑结果的字段（removed 是数字），否则「保留真实原因」就是一句空话。
    defect.C168_throttlePreservesReal = cs.every((c) => stateOf(c) !== 'throttled'
      && typeof cacheOf(c)?.lastAutoClean?.removed === 'number')
    defect.C168_bootTruncatedVisible = cs.every((c) => cacheOf(c)?.lastAutoClean?.truncated === true
      && cacheOf(c)?.lastAutoClean?.truncatedDirs > 0)
    notes.s6 = { rc: r.rc, states: cs.map(stateOf), truncated: cs.map((c) => cacheOf(c)?.lastAutoClean?.truncated),
      dirs: cs.map((c) => cacheOf(c)?.lastAutoClean?.truncatedDirs) }
  }

  // —— S7：lockState 四态 + 残留锁 + 深度截断（lib 层真跑，含注入与真权限）——
  {
    const { lockState } = await import(pathToFileURL(join(ROOT, 'lib/locks.mjs')).href)
    const a = mkRoot('s7-free')
    defect.C174_free = lockState(a.cache, TTL).state === 'free'
    const b = mkRoot('s7-eacces')
    const inj = lockState(b.cache, TTL, { readdir: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e } })
    defect.C174_eaccesUnknown = inj.state === 'unknown' && inj.code === 'EACCES' && /EACCES/.test(inj.reason)
    const c = mkRoot('s7-locked', { liveLock: true })
    const lk = lockState(c.cache, TTL)
    defect.C174_liveLocked = lk.state === 'locked' && Number(lk.owner?.pid) > 0
    const d = mkRoot('s7-stale', { staleLock: true })
    const sk = lockState(d.cache, TTL)
    defect.C174_staleIsFree = sk.state === 'free' && sk.staleLocks.some((x) => x.why === 'dead-pid')
    const e = mkRoot('s7-deep', { deep: true })
    const dp = lockState(e.cache, TTL)
    defect.C174_deepTruncated = dp.state === 'free' && dp.truncated === true && dp.truncatedDirs > 0
    const f = mkRoot('s7-eperm', { deny: true })
    notes.eperm.attempted = true
    let threw = false, code = null
    try { readdirSync(f.blocked, { withFileTypes: true }) } catch (er) { threw = true; code = er.code }
    notes.eperm = { attempted: true, threw, code, user: USER }
    const real = lockState(f.cache, TTL)
    // 真权限造不出来时不进 defect（既不硬红也不假绿），只记进 notes：
    // verify 的 C174 按 notes.eperm.threw 分支——造得出就硬判 unknown+EPERM，
    // 造不出就在 detail 写「未核」并单列一栏。EACCES 注入那条永远硬判。
    notes.epermUnverified = !threw
    notes.s7 = { free: defect.C174_free, inj: { state: inj.state, code: inj.code }, locked: { state: lk.state, pid: lk.owner?.pid },
      stale: { state: sk.state, whys: sk.staleLocks.map((x) => x.why) }, deep: { state: dp.state, dirs: dp.truncatedDirs },
      eperm: { threw, code, state: real.state, gotCode: real.code, reason: real.reason } }
  }

  // —— S8：unknown 默认拒绝带出路；forceUnknown=1 真清；清前后各一行带 reason ——
  {
    const s = mkRoot('s8', { deny: true })
    const r = runChild(s, [
      { method: 'POST', path: '/api/bili-watch/cache/clear', body: {} },
      { method: 'POST', path: '/api/bili-watch/cache/clear', body: { forceUnknown: 1 } },
    ])
    const noForce = call(r, 0), forced = call(r, 1)
    const logs = r.parsed?.logs || []
    defect.C174_unknownDefaultRejected = noForce?.payload?.ok === false
      && noForce?.payload?.data?.unknown === true
      && /forceUnknown=1/.test(String(noForce?.payload?.why || ''))
      && /EPERM|EACCES/.test(String(noForce?.payload?.why || ''))
    capability.C174_forceUnknownReallyCleans = forced?.payload?.ok === true
      && forced?.payload?.data?.removed > 0 && forced?.files?.[0]?.exists === false
    defect.C174_forceLogsBothSides = logs.some((x) => /强制清理：我将忽略/.test(x))
      && logs.some((x) => /强制清理完成/.test(x))
      && logs.filter((x) => /忽略/.test(x)).length >= 2
    notes.s8 = { rc: r.rc, noForce: noForce?.payload?.why, forcedOk: forced?.payload?.ok,
      removed: forced?.payload?.data?.removed, logs: logs.filter((x) => /强制清理/.test(x)) }
  }

  // —— S9：locked 时 forceUnknown 必须无效（该拦时拦）——
  {
    const s = mkRoot('s9', { liveLock: true })
    const r = runChild(s, [{ method: 'POST', path: '/api/bili-watch/cache/clear', body: { forceUnknown: 1 } }])
    const c = call(r, 0)
    defect.C174_forceRejectedOnLocked = c?.payload?.ok === false && c?.payload?.data?.locked === true
      && c?.files?.[0]?.exists === true
    notes.s9 = { rc: r.rc, ok: c?.payload?.ok, why: c?.payload?.why, locked: c?.payload?.data?.locked, jpgAlive: c?.files?.[0]?.exists }
  }

  // —— S10：静态同源面（清单只在实现里有一份，判据不抄第二份）——
  {
    const locks = codeOnly(readFileSync(join(ROOT, 'lib/locks.mjs'), 'utf8'))
    const idx = codeOnly(readFileSync(join(ROOT, 'index.js'), 'utf8'))
    const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
    const look = readFileSync(join(ROOT, 'tools/look.mjs'), 'utf8')
    const params = readFileSync(join(ROOT, 'lib/params.mjs'), 'utf8')
    const tri = 'pidAlive(owner.pid) && !lockExpired(owner, ttlMs)'
    defect.C174_classifyShared = occurrences(locks, 'export function classifyLock(') === 1
      && occurrences(locks, tri) === 1
      && occurrences(locks, 'classifyLock(') >= 4
    const states = ['disabled', 'throttled', 'missing-root', 'noMark', 'locked', 'unknown']
    defect.C168_sixStates = states.every((v) => idx.includes(`state: '${v}'`))
    defect.C168_recordCleanBothSides = occurrences(idx, 'recordClean(') === 3 // 定义 1 + bootCache 1 + /status 1
    defect.C168_truncatedPanelHint = /深层目录未检查/.test(client) && /lastAutoClean\.truncated/.test(client)
    defect.C174_cliFlagRegistered = /force-unknown/.test(look) && /force-unknown/.test(params)
    capability.C167_writeCacheCfgPatch = /function writeCacheCfg\(patch\)/.test(idx)
      && occurrences(idx, 'writeCacheCfg(') === 3 // 定义 1 + /cache/clear 1 + /config 1
    notes.s10 = {
      classifyDefs: occurrences(locks, 'export function classifyLock('), triCount: occurrences(locks, tri),
      classifyCalls: occurrences(locks, 'classifyLock('), states: states.filter((v) => idx.includes(`state: '${v}'`)),
      recordClean: occurrences(idx, 'recordClean('), writeCacheCfg: occurrences(idx, 'writeCacheCfg('),
    }
  }
} catch (e) {
  notes.fatal = String(e?.stack || e)
} finally {
  for (const s of sandboxes) {
    if (s.deny && s.blocked) {
      try { icacls([s.blocked, '/remove:d', USER]) } catch {}
    }
    try { rmSync(s.root, { recursive: true, force: true }) } catch {
      // 权限还没撤干净时再撤一次、再删一次；仍失败就留给 OS 临时目录，不阻塞判据结论。
      try { icacls([s.root, '/remove:d', USER]); rmSync(s.root, { recursive: true, force: true }) } catch {}
    }
  }
}

console.log(JSON.stringify({ defect, capability, notes }))
