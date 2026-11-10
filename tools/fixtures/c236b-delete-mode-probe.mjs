// C236b 取证夹具：stdout 只吐 JSON，所有结论留给 verify.mjs 自己算。
//   ① 真 CLI：clean --all 的干跑 / permanent / recycle / smart，给原始输出与逐项快照；
//   ② 真回收站：SHQueryRecycleBin 前后 i64NumItems（permanent 不变 / recycle 增加 / smart 只进重要文件）；
//   ③ 确定性桩：容量不足、API 失效回落、路径 > 260 三个失效面；
//   ④ 等效修前态副本：摘掉 --all 与 deleteMode 接线，给同一组输入下的原始输出。
// 缓存根、依赖目录、家目录全部隔离到临时树；不碰生产缓存，不清空用户回收站。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recycleBinCount, deletePaths, isImportant, normalizeDeleteMode } from '../../lib/recycle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c236b-'))
const MARK = '.bili-watch-root'
const BV = 'BV19dJQ6sE9F'

const mkEnv = (cache) => ({
  ...process.env,
  BILI_WATCH_CACHE: cache,
  BILI_WATCH_DEPS: join(tmp, 'deps'),
  DSH_HOME: join(tmp, 'home'),
})

/** 造一棵全是本插件产物、且每个顶层条目都能给出正面凭证的缓存根。 */
function seed(dir, opts = {}) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, BV), { recursive: true })
  writeFileSync(join(dir, BV, 'meta.json'), JSON.stringify({ bv: BV }) + '\n')
  writeFileSync(join(dir, BV, 'text.txt'), 'A'.repeat(111))
  writeFileSync(join(dir, 'login-qr.png'), 'B'.repeat(222))
  mkdirSync(join(dir, 'frames'), { recursive: true })
  writeFileSync(join(dir, 'frames', 'manifest.json'), '{"files":[]}\n')
  writeFileSync(join(dir, 'frames', `${BV}-01.jpg`), 'D'.repeat(444))
  if (opts.userFile) writeFileSync(join(dir, '用户素材.psd'), 'U'.repeat(55))
  if (opts.smart) {
    // 重要文件用 *.txt（ASR 转写），非重要文件用 jpg（重跑就有）。
    mkdirSync(join(dir, 'BV28dJQ6sE9A'), { recursive: true })
    writeFileSync(join(dir, 'BV28dJQ6sE9A', 'meta.json'), JSON.stringify({ bv: 'BV28dJQ6sE9A' }) + '\n')
    writeFileSync(join(dir, 'BV28dJQ6sE9A', 'asr.txt'), 'T'.repeat(77))
  }
  writeFileSync(join(dir, MARK), 'bili-watch cache root\n')
}

/** 逐项快照：相对路径 → 类型 / 大小 / 内容 sha256。排除标记与运行日志目录。 */
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

/** 顶层条目数（标记除外）与总字节数：判据的双断言，不采信 CLI 自述。 */
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

const run = (look, args, cache) => {
  const r = spawnSync(process.execPath, [look, ...args], {
    cwd: ROOT, env: mkEnv(cache), encoding: 'utf8', timeout: 120000,
  })
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

/** 一组 CLI 实验：造树 → 快照 → 干跑 → 快照 → 真删 → 快照；回收站计数前后各一次。 */
function experiment(look, cache, args, opts = {}) {
  seed(cache, opts)
  const before = totals(cache)
  const snapBefore = snap(cache)
  const dry = run(look, ['clean', '--all', '--dry-run', ...args], cache)
  const snapDry = snap(cache)
  const binBefore = recycleBinCount(cache)
  const real = run(look, ['clean', '--all', ...args], cache)
  const binAfter = recycleBinCount(cache)
  const snapAfter = snap(cache)
  return { before, after: totals(cache), snapBefore, snapDry, snapAfter, dry, real, binBefore, binAfter }
}

const result = {}
try {
  for (const d of [join(tmp, 'home'), join(tmp, 'deps')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(tmp, 'deps', 'deps-config.json'), '{}\n')

  result.main = experiment(LOOK, join(tmp, 'cache-main'), ['--permanent'])
  result.recycle = experiment(LOOK, join(tmp, 'cache-recycle'), ['--recycle'])
  result.smart = experiment(LOOK, join(tmp, 'cache-smart'), ['--smart'], { smart: true })
  // 常规 clean（不带 --all）不许把用户误放的文件删掉：底线不能被「强制」冲掉。
  result.conservative = experiment(LOOK, join(tmp, 'cache-conservative'), ['--permanent'], { userFile: true })

  // 确定性桩：三个失效面与容量闸，不依赖本机回收站状态。
  const stubRoot = join(tmp, 'stub')
  mkdirSync(stubRoot, { recursive: true })
  const mk = (name, size = 10) => {
    const p = join(stubRoot, name)
    writeFileSync(p, 'x'.repeat(size))
    return { path: p, name, rel: name, files: 1, bytes: size }
  }
  const okProbe = { binCount: () => ({ ok: true, count: 1, size: 1 }), capacityMB: () => null, recycle: () => ({ ok: true }) }
  const overflowProbe = {
    // 上限 1 MB，当前已占 2 MB → room=0，任何字节都放不下。
    binCount: () => ({ ok: true, count: 1, size: 2 * 1048576 }),
    capacityMB: () => 1,
    recycle: () => ({ ok: true }),
  }
  const failProbe = {
    binCount: () => ({ ok: true, count: 1, size: 1 }),
    capacityMB: () => null,
    recycle: () => ({ ok: false, why: '无回收站卷' }),
  }
  const e1 = mk('overflow.txt', 20)
  result.overflow = { ...deletePaths([e1], { mode: 'recycle', root: stubRoot, probe: overflowProbe }), stillThere: existsSync(e1.path) }
  const e2 = mk('fallback.txt', 20)
  result.fallback = { ...deletePaths([e2], { mode: 'recycle', root: stubRoot, probe: failProbe }), stillThere: existsSync(e2.path) }
  // Windows 单文件名 >255 直接造不出来；判据要验的是「代码不把长路径当成功」，
  //   所以注入一个总长 >260 的路径形态（不落盘），看它有没有被记进 failed。
  const longPath = join(stubRoot, 'd'.repeat(90), 'e'.repeat(90), 'f'.repeat(90), 'g.txt')
  const e3 = { path: longPath, name: 'g.txt', rel: 'd/e/f/g.txt', files: 1, bytes: 20 }
  result.longPath = { pathLen: longPath.length, ...deletePaths([e3], { mode: 'recycle', root: stubRoot, probe: okProbe }), stillThere: false }
  // smart 档的「重要进 / 非重要不进」用确定性桩分开判：真回收站只记总项数，
  //   看不出哪一条被送进去。这里让桩逐条记 path。
  const sent = []
  const splitProbe = { ...okProbe, recycle: (p) => { sent.push(p); return { ok: true } } }
  const mix = [mk('asr.txt', 20), mk('frame.jpg', 20), mk('frames-dl', 20)]
  // 桩不真删文件，removed 只反映模式分支；断言的是 sent 里有哪些。
  const split = deletePaths(mix.map((e) => ({ ...e, rel: e.name })), { mode: 'smart', root: stubRoot, probe: splitProbe })
  result.smartSplit = { ...split, sent: sent.map((p) => p.replace(/\\/g, '/').split('/').pop()) }
  result.modes = {
    normalized: ['permanent', 'recycle', 'smart', 'bogus', undefined, null].map(normalizeDeleteMode),
    important: ['frames-dl/gen-1/a.mp4', 'audio-dl/gen-2/a.m4a', 'BV1/asr.txt', 'frames/BV1-01.jpg', 'sheet-tmp/t.json'].map((p) => [p, isImportant(p)]),
  }
  // 自动清理的「同款策略」由 verify.mjs 抠 index.js 真函数体另判；这里给桩结果作交叉证据。
  const e4 = mk('auto.txt', 20)
  result.autoStub = {
    permanent: deletePaths([{ ...e4 }], { mode: 'permanent', root: stubRoot, probe: okProbe }),
    recycle: deletePaths([mk('auto-r.txt', 20)], { mode: 'recycle', root: stubRoot, probe: okProbe }),
    smart: deletePaths([mk('auto-s.txt', 20)], { mode: 'smart', root: stubRoot, probe: okProbe }),
  }
  // permanent 档一次 PowerShell 都不许起：用计数桩验行为，不靠读源码猜。
  const apiCalls = []
  const countingProbe = {
    binCount: () => { apiCalls.push('binCount'); return { ok: true, count: 0, size: 0 } },
    capacityMB: () => { apiCalls.push('capacityMB'); return null },
    recycle: () => { apiCalls.push('recycle'); return { ok: true } },
  }
  const ep = mk('permanent.txt', 20)
  result.permanentNoApi = { ...deletePaths([ep], { mode: 'permanent', root: stubRoot, probe: countingProbe }), apiCalls }

  // 等效修前态副本：只搬 CLI 真会加载的文件，摘掉 --all 与 deleteMode 接线。
  const tree = join(tmp, 'tree')
  const copyDir = (src, dst) => {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, e.name)
      const d = join(dst, e.name)
      if (e.isDirectory()) copyDir(s, d)
      else if (e.isFile()) copyFileSync(s, d)
    }
  }
  copyDir(join(ROOT, 'lib'), join(tree, 'lib'))
  mkdirSync(join(tree, 'tools'), { recursive: true })
  for (const f of ['look.mjs', 'cli-io.mjs', 'check-run.mjs']) copyFileSync(join(ROOT, 'tools', f), join(tree, 'tools', f))
  copyFileSync(join(ROOT, 'package.json'), join(tree, 'package.json'))
  const lookPath = join(tree, 'tools', 'look.mjs')
  const replaceOnce = (file, from, to) => {
    const s = readFileSync(file, 'utf8')
    if (!s.includes(from)) return false
    writeFileSync(file, s.replace(from, to), 'utf8')
    return true
  }
  const a = replaceOnce(lookPath, "const mode = normalizeDeleteMode(override || cfgMode)", "const mode = 'permanent'")
  const b = replaceOnce(lookPath,
    'const cleared = all\n        ? removeAllOwned(cacheDir(), { dryRun, mode })\n        : removeOwned(cacheDir(), { dryRun, mode })',
    'const cleared = removeOwned(cacheDir(), { dryRun, mode })')
  result.pre = { built: a && b }
  if (a && b) result.pre = { built: true, ...experiment(join(tree, 'tools', 'look.mjs'), join(tmp, 'cache-pre'), ['--recycle']) }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
