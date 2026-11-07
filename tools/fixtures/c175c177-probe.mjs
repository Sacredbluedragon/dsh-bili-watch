/**
 * 0.4.8 C2 + C4a + C4b 的真跑夹具，给 tools/verify.mjs 的 C175 / C177 用。
 *
 * 只吐一行 JSON、永远 exit 0，判定全在 verify 里做（探针自己崩了要能被看出来，
 * 所以每条切函数体失败都写 notes.fatal，而不是静默给个 false）。
 *
 * C175（C2）：真起生产 scripts/fetch-deps.mjs，锁根用 BILI_WATCH_DEPS 隔离到临时目录。
 *   · secondBlocked：A 持锁（等到锁体 pid 真等于 A.pid 才放 B），B 必须退 3 且出路带 pid / 锁路径
 *   · otherTarget：预置另一个 target 的 held 锁，B 被挡且报出那个 target
 *   · eexistNotSwallowed：**确定性竞态**——锁文件在但内容损坏，readLock() 读成 null，
 *     于是 lockState=free，只有 wx 才会抛 EEXIST。去掉 wx 就变成覆盖写、两路都以为拿到锁。
 *   · normalStillAcquires / staleStillCleared：正常单进程仍拿得到锁、残留锁仍能接管（D2 打这里）
 *
 * C177（C4a/C4b）：抠 index.js / client.js 的**原样函数体**在桩环境里真跑。
 *   · inProcessConflictHasOwner：Map<target,{at,pid}> 的冲突文案带 pid / 目标 / 开始时刻
 *   · statusShapeUnchanged：/status 只列目标名；downloadProgress 收 .keys() 仍能判 live
 *   · crossProcessWhyHasPidAndPath：runDownload 同步预检把锁占用方放进 results[i].why
 *   · verdictCarriesLockBusy / outLogIncrementWired：子进程退 3 时 outLog 本次增量透到结论
 *   · clientShowsWhy：面板 readDownloadResp 真会把 results[].why 显示出来
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { depsLockFile, DEPS_LOCK_STALE_MS } from '../../lib/plugin-paths.mjs'
import { classifyLock } from '../../lib/locks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const fetchScript = join(ROOT, 'scripts', 'fetch-deps.mjs')
const idx = readFileSync(join(ROOT, 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const cli = readFileSync(join(ROOT, 'client.js'), 'utf8').replace(/\r\n/g, '\n')

const defect = {}
const capability = {}
const notes = {}
const fatal = (msg) => { notes.fatal = String(msg) }

/** 切「行首 } 收尾」的原样函数体；切不出来要显式记 fatal，不许伪装成被测代码红。 */
function sliceFn(src, sig) {
  const start = src.indexOf(sig)
  if (start < 0) { fatal('找不到定义 ' + sig); return '' }
  const end = src.indexOf('\n}\n', start)
  if (end < 0 || end < start) { fatal(sig + ' 没有行首 } 收尾'); return '' }
  const body = src.slice(start, end + 3)
  if (!body.startsWith(sig)) { fatal('切出来的不是 ' + sig); return '' }
  return body
}
const ctxOf = (extra) => {
  const c = {
    process, console, Date, JSON, Math, Number, String, Array, Object, Set, Map,
    Buffer, Promise, RegExp, setTimeout, clearTimeout,
    join, readFileSync, statSync, writeFileSync, existsSync,
    ...extra,
  }
  c.globalThis = c
  return c
}
const runVM = (code, extra = {}) => {
  const c = ctxOf(extra)
  vm.runInNewContext(code, c, { timeout: 8000 })
  return c
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sandbox = mkdtempSync(join(tmpdir(), 'bw-c175c177-'))
const envFor = (name) => ({ ...process.env, BILI_WATCH_DEPS: join(sandbox, name, 'deps') })
const lockAt = (name) => depsLockFile({ env: envFor(name) })
const runFd = (env, args) => spawnSync(process.execPath, [fetchScript, ...args], {
  encoding: 'utf8', timeout: 25000, env, windowsHide: true,
})
const stderrOf = (r) => String(r.stderr || '')
const stdoutOf = (r) => String(r.stdout || '')

try {
  // ── C175 ① A 持锁 → B 被挡（真并发，不靠固定 sleep 猜谁先启动） ──────────────
  {
    const env = envFor('race')
    const lf = lockAt('race')
    mkdirSync(dirname(lf), { recursive: true })
    rmSync(lf, { force: true })
    const a = spawn(process.execPath, [fetchScript, 'lockcheck', '--hold=1200'], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let aHeld = false
    for (let i = 0; i < 80; i++) {
      try {
        const j = JSON.parse(readFileSync(lf, 'utf8'))
        if (j.pid === a.pid) { aHeld = true; break }
      } catch {}
      await sleep(50)
    }
    const b = runFd(env, ['lockcheck'])
    const err = stderrOf(b)
    defect.C175_secondBlocked = aHeld && b.status === 3
      && /已经有一个安装进程在跑/.test(err)
      && new RegExp(`pid=${a.pid}\\b`).test(err)
      && err.includes(lf)
    notes.race = { aHeld, aPid: a.pid, bStatus: b.status, bErr: err.slice(0, 300), lock: lf }
    if (a.exitCode === null) await new Promise((r) => a.on('exit', r))
  }

  // ── C175 ② 不同 target：A 在装 ffmpeg，B 全新实例来抢，出路要报出 ffmpeg ──────
  {
    const env = envFor('other')
    const lf = lockAt('other')
    mkdirSync(dirname(lf), { recursive: true })
    writeFileSync(lf, JSON.stringify({ pid: process.pid, startedAt: Date.now(), target: 'ffmpeg' }), 'utf8')
    const b = runFd(env, ['lockcheck'])
    const err = stderrOf(b)
    defect.C175_otherTarget = b.status === 3 && /目标 ffmpeg/.test(err)
      && /pid=/.test(err) && err.includes(lf)
    notes.other = { bStatus: b.status, bErr: err.slice(0, 300) }
    rmSync(lf, { force: true })
  }

  // ── C175 ③ EEXIST 不许被吞：锁文件在但内容损坏 → readLock=null → free → wx 抛 ──
  //   这是**确定性**的并发窗口，不靠两个进程恰好同时启动。去掉 wx 会变成覆盖写、exit 0。
  {
    const env = envFor('eexist')
    const lf = lockAt('eexist')
    mkdirSync(dirname(lf), { recursive: true })
    writeFileSync(lf, '{broken', 'utf8')
    const b = runFd(env, ['lockcheck'])
    const err = stderrOf(b)
    defect.C175_eexistNotSwallowed = b.status === 3
      && /已经有一个安装进程在跑/.test(err)
      && err.includes(lf)
      && !/pid=undefined/.test(err)
    notes.eexist = { bStatus: b.status, bErr: err.slice(0, 300) }
    rmSync(lf, { force: true })
  }

  // ── C175 ④ 正常单进程仍拿得到锁（D2：把 lockState 恒 held 就必须红） ──────────
  {
    const env = envFor('normal')
    const lf = lockAt('normal')
    mkdirSync(dirname(lf), { recursive: true })
    rmSync(lf, { force: true })
    const one = runFd(env, ['lockcheck', '--hold=100'])
    capability.C175_normalStillAcquires = one.status === 0
      && stdoutOf(one).split(/\r?\n/)[0] === lf
    notes.normal = { status: one.status, firstLine: stdoutOf(one).split(/\r?\n/)[0], lock: lf }
  }

  // ── C175 ⑤ 残留锁仍能接管（同一个 D2 的另一半） ────────────────────────────
  {
    const env = envFor('stale')
    const lf = lockAt('stale')
    mkdirSync(dirname(lf), { recursive: true })
    writeFileSync(lf, JSON.stringify({ pid: 999999999, startedAt: Date.now(), target: 'ghost' }), 'utf8')
    const one = runFd(env, ['lockcheck', '--hold=100'])
    capability.C175_staleStillCleared = one.status === 0
      && /清掉了上次残留的锁/.test(stdoutOf(one))
    notes.stale = { status: one.status, out: stdoutOf(one).slice(0, 200) }
  }

  // ── C177 ① 本进程内冲突文案带占用方 ───────────────────────────────────────
  {
    const c = runVM(`
      ${sliceFn(idx, 'function downloadConflict(target, running) {')}
      globalThis.__r = downloadConflict('ytdlp', new Map([['ffmpeg', { at: ${Date.now()}, pid: 4242 }]]))
    `)
    const s = String(c.__r || '')
    defect.C177_inProcessConflictHasOwner = /ffmpeg/.test(s) && /pid=4242/.test(s) && /开始于/.test(s)
    notes.inProcess = s
  }

  // ── C177 ② /status 形状不变：downloading 仍是目标名数组、progress 仍判 live ────
  {
    const dir = join(sandbox, 'status')
    mkdirSync(dir, { recursive: true })
    const part = join(dir, 'x.part')
    writeFileSync(join(dir, '.download-part.json'), JSON.stringify({ dep: 'ffmpeg', label: 'FFmpeg', part, at: Date.now() }), 'utf8')
    writeFileSync(part, 'abc', 'utf8')
    const c = runVM(`
      const PART_STATE_NAME = '.download-part.json'
      ${sliceFn(idx, 'function downloadProgress(dir, opts = {}) {')}
      globalThis.__r = downloadProgress(${JSON.stringify(dir)}, {
        activeDepIds: new Map([['ffmpeg', { at: 1, pid: 2 }]]).keys(),
      })
    `)
    const p = c.__r
    const keys = Array.from(new Map([['ffmpeg', { at: 1, pid: 2 }]]).keys())
    defect.C177_statusShapeUnchanged = Boolean(p && p.basis === 'live' && p.bytes === 3)
      && keys.length === 1 && keys.every((k) => typeof k === 'string')
      && /downloading:\s*Array\.from\(DOWNLOADING\.keys\(\)\)/.test(idx)
    notes.statusShape = { progress: p, keys }
  }

  // ── C177 ③ 跨进程：runDownload 同步预检把占用方放进 results[i].why ──────────
  //    锁体是**真文件**，readDepsLock / depsLockPidAlive / downloadLockBusy / lockBusyText
  //    全是 index.js 的原样函数体，只有 spawn 及其之后被截在 return 之外。
  {
    const lf = join(sandbox, 'host.lock')
    writeFileSync(lf, JSON.stringify({ pid: process.pid, startedAt: Date.now(), target: 'ffmpeg' }), 'utf8')
    const c = runVM(`
      const DEPS_LOCK_FILE = ${JSON.stringify(lf)}
      ${sliceFn(idx, 'function depsLockVerdict(cur) {')}
      ${sliceFn(idx, 'function downloadLockBusy() {')}
      ${sliceFn(idx, 'function lockBusyText(cur, lockPath) {')}
      const DOWNLOADING = new Map()
      ${sliceFn(idx, 'function downloadConflict(target, running) {')}
      const SCRIPTS = '/stub/scripts'
      const DEPS = '/stub/deps'
      const DOWNLOAD_LOG = '/stub/download.log'
      const existsSync = () => true
      const appendFileSync = () => {}
      const openSync = () => 3
      const closeSync = () => {}
      const spawn = () => ({ pid: 4242, on() {}, once() {}, unref() {} })
      ${sliceFn(idx, 'function runDownload(target) {')}
      globalThis.__r = runDownload('ytdlp')
    `, { classifyLock, DEPS_LOCK_STALE_MS })
    const r = c.__r || {}
    const why = String(r.why || '')
    defect.C177_crossProcessWhyHasPidAndPath = r.started === false
      && /pid=/.test(why) && /开始于/.test(why) && /ffmpeg/.test(why) && why.includes(lf)
    notes.crossProcess = { ret: r, lock: lf }
  }

  // ── C177 ④ 子进程退 3 时结论不再只是「退出码 3」 ────────────────────────────
  {
    const busy = '已经有一个安装进程在跑（pid=4242，目标 ffmpeg，开始于 X）；锁文件：/tmp/L'
    const c = runVM(`
      const DOWNLOAD_TARGET_DEPS = {}
      ${sliceFn(idx, 'function downloadVerdict(target, code, signal, rows, ctx = {}) {')}
      globalThis.__r = downloadVerdict('ytdlp', 3, null, null, { lockBusy: ${JSON.stringify(busy)} })
    `)
    const v = c.__r || {}
    defect.C177_verdictCarriesLockBusy = v.ok === false
      && /pid=4242/.test(String(v.note)) && !/退出码 3/.test(String(v.note))
    const iExit = idx.indexOf("child.on('exit'")
    const iUnref = idx.indexOf('child.unref()', iExit)
    const seg = iExit > 0 && iUnref > iExit ? idx.slice(iExit, iUnref) : ''
    defect.C177_outLogIncrementWired = /subarray\(outSizeBefore\)/.test(seg)
      && /已经有一个安装进程在跑/.test(seg)
      && /verdictCtx\s*=\s*\{[^}]*lockBusy/.test(seg)
    notes.verdict = { v, segLen: seg.length }
  }

  // ── C177 ⑤ 面板真会把 results[].why 显示出来 ───────────────────────────────
  {
    const why = '已经有一个安装进程在跑（pid=4242）；锁文件：/tmp/L'
    const c = runVM(`
      ${sliceFn(cli, 'function readDownloadResp(j) {')}
      globalThis.__r = readDownloadResp({ ok: true, data: { results: [{ started: false, why: ${JSON.stringify(why)} }], started: 0 } })
    `)
    const r = c.__r || {}
    defect.C177_clientShowsWhy = /pid=4242/.test(String(r.why)) && /\/tmp\/L/.test(String(r.why))
    notes.client = { why: r.why }
  }
} catch (e) {
  fatal(String(e && e.stack ? e.stack : e).slice(0, 600))
}

try { rmSync(sandbox, { recursive: true, force: true }) } catch {}
process.stdout.write(JSON.stringify({ defect, capability, notes }))
