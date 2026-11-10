// C242 取证夹具：stdout 只吐 JSON，结论全留给 verify.mjs。
//   ① 真 CLI：clean --all / 常规 clean 在含五类 UNPROVABLE_DIRS、last-error.json、
//      用户文件、无凭证目录的隔离缓存根上的逐项快照与条目/字节统计；
//   ② 真 lib：下载产物收尾清理的五种形态（正常 / 抛错 / exit / SIGINT / --keep-source）。
// 生产缓存、依赖目录、家目录全部隔离；不碰用户回收站。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c242-'))
const MARK = '.bili-watch-root'
const BV = 'BV19dJQ6sE9F'

const mkEnv = (cache) => ({
  ...process.env,
  BILI_WATCH_CACHE: cache,
  BILI_WATCH_DEPS: join(tmp, 'deps'),
  DSH_HOME: join(tmp, 'home'),
})

function put(p, body) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

/** 五类「认不出归属」的目录，每类都按需求给出正面凭证；用户文件与无凭证目录单独一组。 */
function seed(dir, opts = {}) {
  mkdirSync(dir, { recursive: true })
  put(join(dir, BV, 'meta.json'), JSON.stringify({ bv: BV }) + '\n')
  put(join(dir, BV, 'text.txt'), 'A'.repeat(111))
  put(join(dir, 'frames', 'manifest.json'), '{"files":[]}\n')
  put(join(dir, 'frames', `${BV}-01.jpg`), 'D'.repeat(444))
  for (const [d, inner, extra] of [
    ['sheet-tmp', `${BV}-3x3`, '01.jpg'],
    ['substrip-tmp', BV, '01.jpg'],
    ['frames-dl', 'gen-a1b2c3d4e5', 'video.mp4'],
    ['audio-dl', 'gen-f6e5d4c3b2', 'audio.m4a'],
    ['_hot', '', 'cache.json'],
  ]) {
    const p = inner ? join(dir, d, inner) : join(dir, d)
    put(join(p, 'manifest.json'), '{"files":[]}\n')
    put(join(p, extra), 'X'.repeat(33))
  }
  // 只有 last-error.json 的 BV 目录：本插件写的错误记录，不该永远留着。
  put(join(dir, 'BV0000000000', 'last-error.json'), '{"error":"x"}\n')
  if (opts.guarded) {
    put(join(dir, '用户素材.psd'), 'U'.repeat(55))
    put(join(dir, 'sheet-tmp', '没有凭证目录', '用户文件.psd'), 'P'.repeat(44))
  }
  put(join(dir, MARK), 'bili-watch cache root\n')
}

function snap(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '_logs' || e.name === MARK) continue
      const p = join(d, e.name)
      const rel = relative(dir, p).replace(/\\/g, '/')
      const st = lstatSync(p)
      out[rel] = {
        t: e.isDirectory() ? 'd' : 'f', s: st.size,
        h: e.isDirectory() ? '' : createHash('sha256').update(readFileSync(p)).digest('hex'),
      }
      if (e.isDirectory()) walk(p)
    }
  }
  try { walk(dir) } catch (e) { out.__error = String(e?.message || e) }
  return out
}

function totals(dir) {
  let count = 0
  let bytes = 0
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.name === MARK || e.name === '_logs') continue
      const q = join(p, e.name)
      if (e.isDirectory()) { count += 1; walk(q) }
      else { count += 1; try { bytes += lstatSync(q).size } catch {} }
    }
  }
  try { walk(dir) } catch (e) { return { count, bytes, error: String(e?.message || e) } }
  return { count, bytes }
}

const run = (args, cache) => {
  const r = spawnSync(process.execPath, [LOOK, ...args], {
    cwd: ROOT, env: mkEnv(cache), encoding: 'utf8', timeout: 120000,
  })
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

function experiment(cache, args, opts = {}) {
  seed(cache, opts)
  const before = totals(cache)
  const snapBefore = snap(cache)
  const dry = run(['clean', '--all', '--dry-run', ...args], cache)
  const snapDry = snap(cache)
  const real = run(['clean', '--all', ...args], cache)
  const snapAfter = snap(cache)
  return { before, after: totals(cache), snapBefore, snapDry, snapAfter, dry, real }
}

const result = {}
try {
  for (const d of [join(tmp, 'home'), join(tmp, 'deps')]) mkdirSync(d, { recursive: true })
  put(join(tmp, 'deps', 'deps-config.json'), '{}\n')
  result.main = experiment(join(tmp, 'cache-main'), ['--permanent'])
  result.guarded = experiment(join(tmp, 'cache-guarded'), ['--permanent'], { guarded: true })
  // 常规 clean（不带 --all）：五类目录与 last-error 仍按保守口径，一个字不许放宽。
  seed(join(tmp, 'cache-normal'))
  result.normal = { before: totals(join(tmp, 'cache-normal')) }
  result.normal.real = run(['clean', '--permanent'], join(tmp, 'cache-normal'))
  result.normal.after = totals(join(tmp, 'cache-normal'))
  result.normal.snapAfter = snap(join(tmp, 'cache-normal'))

  // 下载产物收尾：真调 lib（未落地时给 missing，判据据此红，不伪装成脚本崩）。
  let sc = null
  try { sc = await import('../../lib/source-cleanup.mjs') } catch (e) { result.sourceErr = String(e?.message || e) }
  if (sc) {
    const box = join(tmp, 'src')
    mkdirSync(box, { recursive: true })
    const mkDir = (name) => { const p = join(box, name); put(join(p, 'a.bin'), 'x'.repeat(20)); return p }
    const shapes = {}
    // ① 正常收尾
    let p = mkDir('ok')
    sc.setKeepSource(false)
    sc.trackSource(p)
    sc.releaseSource(p)
    shapes.normal = { gone: !existsSync(p) }
    // ② 抛错路径由调用方 finally 负责，这里验兜底清理函数本身
    p = mkDir('throw')
    sc.trackSource(p)
    try { throw new Error('boom') } catch { sc.cleanupAllSources() }
    shapes.thrown = { gone: !existsSync(p) }
    // ③ exit 钩子（模拟 process.exit 之前触发）
    p = mkDir('exit')
    sc.trackSource(p)
    const fakeProc = {
      handlers: {},
      once(ev, fn) { this.handlers[ev] = fn },
      exit() {},
    }
    sc.installSourceCleanup(fakeProc)
    fakeProc.handlers.exit?.()
    shapes.exit = { gone: !existsSync(p), events: Object.keys(fakeProc.handlers) }
    // ④ SIGINT 钩子
    p = mkDir('sigint')
    sc.trackSource(p)
    const fakeProc2 = {
      handlers: {}, exits: [],
      once(ev, fn) { this.handlers[ev] = fn },
      exit(code) { this.exits.push(code) },
    }
    sc.installSourceCleanup(fakeProc2)
    fakeProc2.handlers.SIGINT?.()
    shapes.sigint = { gone: !existsSync(p), exits: fakeProc2.exits }
    // ⑤ --keep-source 不清
    p = mkDir('keep')
    sc.setKeepSource(true)
    sc.trackSource(p)
    sc.releaseSource(p)
    shapes.keep = { stillThere: existsSync(p) }
    sc.setKeepSource(false)
    result.source = shapes
  } else {
    result.source = { missing: true }
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
