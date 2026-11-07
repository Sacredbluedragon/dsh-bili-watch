/**
 * C48-P2-1 真跑夹具：同一把 deps 跨进程锁，宿主侧（面板 + 后台迁移）与 CLI 侧必须同结论。
 *
 * 只吐一行 JSON、永远 exit 0，判定全在 tools/verify.mjs 的 C183 里做。
 * 两侧都抠**原样函数体**在 VM 里跑，不是复刻实现：
 *   · 宿主侧：index.js 的 depsLockVerdict + downloadLockBusy（注入真 classifyLock / 真常量）
 *   · CLI 侧：scripts/fetch-deps.mjs 的 lockState（不注入 alive，用真 process.kill）
 * 五种锁：活锁 / 8 小时前的活锁 / 坏 JSON / 没锁 / 死 pid。
 * 改坏方式：downloadLockBusy 改回只判 pid 存活 → 8h 那条两边不一致；
 *   depsLockVerdict 恒 stale → 活锁被统一放行（D2「该活时活」红）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { classifyLock } from '../../lib/locks.mjs'
import { DEPS_LOCK_STALE_MS } from '../../lib/plugin-paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const idx = readFileSync(join(ROOT, 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const fd = readFileSync(join(ROOT, 'scripts', 'fetch-deps.mjs'), 'utf8').replace(/\r\n/g, '\n')
const pp = readFileSync(join(ROOT, 'lib', 'plugin-paths.mjs'), 'utf8').replace(/\r\n/g, '\n')

const defect = {}
const capability = {}
const notes = {}
let fatalMsg = ''

/** 切「行首 } 收尾」的原样函数体；切不出来要抛，不许静默当 PASS。 */
function sliceFn(src, sig) {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error('找不到定义 ' + sig)
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error(sig + ' 没有行首 } 收尾')
  const body = src.slice(start, end + 3)
  if (!body.startsWith(sig)) throw new Error('切出来的不是 ' + sig)
  return body
}
const runVM = (code, extra = {}) => {
  const c = {
    process, console, Date, JSON, Math, Number, String, Array, Object, Set, Map,
    Buffer, Promise, RegExp, Error, setTimeout, clearTimeout,
    ...extra,
  }
  c.globalThis = c
  vm.runInNewContext(code, c, { timeout: 8000 })
  return c
}

try {
  const verdictFn = sliceFn(idx, 'function depsLockVerdict(cur) {')
  const busyFn = sliceFn(idx, 'function downloadLockBusy() {')
  const acquireBody = sliceFn(idx, 'function acquireDepsLock(dir) {')
  const lockStateFn = sliceFn(fd, 'function lockState(cur, opts = {}) {')
  const lockConst = (fd.match(/const LOCK_STALE_MS = [^\n]+/) || [''])[0]
  const staleDecl = (pp.match(/export const DEPS_LOCK_STALE_MS = [^\n]+/) || [''])[0].replace(/^export /, '')
  if (!lockConst || !staleDecl) throw new Error('常量行抽不出来（单点被删了？）')

  const now = Date.now()
  const pid = process.pid
  const cases = [
    { tag: 'live', raw: JSON.stringify({ pid, startedAt: now - 1000, target: 'ffmpeg' }) },
    { tag: 'old8h', raw: JSON.stringify({ pid, startedAt: now - 8 * 3600 * 1000, target: 'ffmpeg' }) },
    { tag: 'corrupt', raw: '{bad json' },
    { tag: 'none', raw: null },
    { tag: 'deadPid', raw: JSON.stringify({ pid: 2147483647, startedAt: now - 1000 }) },
  ]

  const rows = []
  for (const cse of cases) {
    const logLines = []
    const panelCode = `
      const DEPS_LOCK_FILE = '/stub/.fetch-deps.lock'
      const DOWNLOAD_LOG = '/stub/download.log'
      const readFileSync = () => { if (RAW === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return RAW }
      const appendFileSync = (p, s) => { LOG.push(String(s)) }
      ${verdictFn}
      ${busyFn}
      globalThis.__busy = downloadLockBusy()
    `
    const pc = runVM(panelCode, { classifyLock, DEPS_LOCK_STALE_MS, RAW: cse.raw, LOG: logLines })
    let cur = null
    try { cur = cse.raw === null ? null : JSON.parse(cse.raw) } catch {}
    const cliCode = `
      ${staleDecl}
      ${lockConst}
      ${lockStateFn}
      globalThis.__cli = lockState(CUR)
    `
    const cc = runVM(cliCode, { CUR: cur })
    rows.push({
      tag: cse.tag,
      panelBusy: Boolean(pc.__busy),
      cliState: cc.__cli,
      corruptLogged: logLines.some((s) => /corrupt/.test(s)),
      logs: logLines,
    })
  }
  notes.rows = rows.map((r) => ({ tag: r.tag, panelBusy: r.panelBusy, cliState: r.cliState, corruptLogged: r.corruptLogged }))

  const byTag = Object.fromEntries(rows.map((r) => [r.tag, r]))
  // 分歧场景：8 小时前的长下载、pid 还活着 —— CLI 判 stale 能接管，面板也必须放行
  defect.C183_oldLiveLockAgrees = byTag.old8h.panelBusy === false && byTag.old8h.cliState === 'stale'
  defect.C183_liveLockAgrees = byTag.live.panelBusy === true && byTag.live.cliState === 'held'
  defect.C183_corruptNotBusyButNamed = byTag.corrupt.panelBusy === false
    && byTag.corrupt.cliState === 'free' && byTag.corrupt.corruptLogged === true
  defect.C183_noneAgrees = byTag.none.panelBusy === false && byTag.none.cliState === 'free'
  defect.C183_deadPidAgrees = byTag.deadPid.panelBusy === false && byTag.deadPid.cliState === 'stale'

  // D2「该活时活」：统一判据不许把保守侧也削掉
  capability.C183_liveStillBlocks = byTag.live.panelBusy === true
  capability.C183_noLockStillPasses = byTag.none.panelBusy === false && byTag.none.corruptLogged === false
  capability.C183_noAtStaysLive = (() => {
    const code = `
      ${verdictFn}
      globalThis.__v = depsLockVerdict({ pid: PID, target: 'x' })
    `
    return runVM(code, { classifyLock, DEPS_LOCK_STALE_MS, PID: pid }).__v.state === 'live'
  })()
  capability.C183_bothCallSitesWired = /depsLockVerdict\(cur\)/.test(busyFn)
    && /depsLockVerdict\(cur\)/.test(acquireBody)
  capability.C183_singleStaleConst = !/DEPS_MIGRATION_STALE_MS/.test(idx)
    && (idx.match(/6 \* 60 \* 60 \* 1000/g) || []).length === 0
    && (fd.match(/6 \* 60 \* 60 \* 1000/g) || []).length === 0
    && /export const DEPS_LOCK_STALE_MS = 6 \* 60 \* 60 \* 1000/.test(pp)
  capability.C183_baselineGreen = rows.length === 5
} catch (e) {
  fatalMsg = String(e && e.stack ? e.stack : e).slice(0, 600)
}

process.stdout.write(JSON.stringify({ defect, capability, notes, fatal: fatalMsg }))
