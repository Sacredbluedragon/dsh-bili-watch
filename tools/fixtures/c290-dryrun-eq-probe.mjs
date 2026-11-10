// C290 取证夹具：stdout 只吐 JSON，所有断言留给 verify.mjs 自己做。
//   ① 真 CLI 跑 clean --dry-run / =1 / =0 / =false，给原始输出与逐项快照；
//   ② 副本树把 flag() 改回 argv.includes（修前形态），同一组实验必须重新真删；
//   ③ 真 cli-io 的 flagFromArgv 纯函数直接调用的返回值（可注入 argv）。
// 不设 PROBE_CHILD 轻量分支：这三条判据在任何路径都真跑，不新增阉割入口。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagFromArgv } from '../cli-io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c290-'))
const MARK = '.bili-watch-root'
const BV = 'BV19dJQ6sE9F'
const GEN = 'gen-abcdef1234'
const GEN_FILES = [`frames-dl/${GEN}/video.mp4`, `audio-dl/${GEN}/audio.wav`]
const OWN = [BV, 'login-qr.png', 'frames']
const USER = '用户素材.psd'

function mkEnv(cache) {
  return {
    ...process.env,
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
    CODEBUDDY_SAFE_DELETE_SANDBOX: '0',
    CODEBUDDY_BROKERED_FS_HOOK_ENABLED: '0',
    BILI_WATCH_CACHE: cache,
    BILI_WATCH_DEPS: join(tmp, 'deps'),
    DSH_HOME: join(tmp, 'home'),
  }
}

// 常规 clean 认领 3 项 / 4 文件：BV 两文件 + login-qr.png + frames/manifest.json。
// 另造 --all 才会认领的 gen-<hash> 原片与顶层用户文件，作「不许误删」的对照。
function seed(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MARK), 'bili-watch cache root\n')
  mkdirSync(join(dir, BV), { recursive: true })
  writeFileSync(join(dir, BV, 'meta.json'), JSON.stringify({ bv: BV }) + '\n')
  writeFileSync(join(dir, BV, 'text.txt'), 'A'.repeat(111))
  writeFileSync(join(dir, 'login-qr.png'), 'B'.repeat(222))
  mkdirSync(join(dir, 'frames'), { recursive: true })
  writeFileSync(join(dir, 'frames', 'manifest.json'), '{"files":[]}\n')
  mkdirSync(join(dir, 'frames-dl', GEN), { recursive: true })
  writeFileSync(join(dir, 'frames-dl', GEN, 'video.mp4'), 'V'.repeat(64))
  mkdirSync(join(dir, 'audio-dl', GEN), { recursive: true })
  writeFileSync(join(dir, 'audio-dl', GEN, 'audio.wav'), 'A'.repeat(64))
  writeFileSync(join(dir, USER), 'U'.repeat(55))
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
        t: e.isDirectory() ? 'd' : 'f',
        s: st.size,
        m: st.mtimeMs,
        h: e.isDirectory() ? '' : createHash('sha256').update(readFileSync(p)).digest('hex'),
      }
      if (e.isDirectory()) walk(p)
    }
  }
  try { walk(dir) } catch (e) { out.__error = String(e?.message || e) }
  return out
}

function run(look, args, cache) {
  const r = spawnSync(process.execPath, [look, ...args], {
    cwd: ROOT, env: mkEnv(cache), encoding: 'utf8', timeout: 30000,
  })
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

function experiment(look, args, cache) {
  seed(cache)
  const before = snap(cache)
  const cli = run(look, args, cache)
  const after = snap(cache)
  return { before, cli, after }
}

const result = {}
try {
  for (const d of [join(tmp, 'home'), join(tmp, 'deps')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(tmp, 'deps', 'deps-config.json'), '{}\n')

  result.plain = experiment(LOOK, ['clean', '--dry-run'], join(tmp, 'cache-plain'))
  result.eqOne = experiment(LOOK, ['clean', '--dry-run=1'], join(tmp, 'cache-eq1'))
  result.eqZero = experiment(LOOK, ['clean', '--dry-run=0'], join(tmp, 'cache-eq0'))
  result.eqFalse = experiment(LOOK, ['clean', '--dry-run=false'], join(tmp, 'cache-eqf'))

  // 副本树：结构与仓库同形，look.mjs 的 ../tools/cli-io 解析到副本里那份。
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
  for (const f of ['look.mjs', 'cli-io.mjs', 'check-run.mjs']) {
    copyFileSync(join(ROOT, 'tools', f), join(tree, 'tools', f))
  }
  copyFileSync(join(ROOT, 'package.json'), join(tree, 'package.json'))
  const treeLook = join(tree, 'tools', 'look.mjs')
  const cliPath = join(tree, 'tools', 'cli-io.mjs')
  const NEW = 'const flag = (name) => flagFromArgv(argv, name)'
  const OLD = 'const flag = (name) => argv.includes(`--${name}`)'
  const src = readFileSync(cliPath, 'utf8')
  const built = src.includes(NEW)
  if (built) writeFileSync(cliPath, src.replace(NEW, OLD), 'utf8')
  result.mutated = { built }
  if (built) {
    result.mutated = {
      built: true,
      ...experiment(treeLook, ['clean', '--dry-run=1'], join(tmp, 'cache-mutated')),
    }
  }

  // 纯函数：可注入 argv，不依赖 process.argv。
  const f = (a) => flagFromArgv(a, 'full')
  result.pure = {
    bare: f(['--full']),
    eqOne: f(['--full=1']),
    eqZero: f(['--full=0']),
    none: f([]),
    eqFalse: f(['--full=false']),
    eqNo: f(['--full=no']),
    eqOff: f(['--full=off']),
    eqEmpty: f(['--full=']),
    eqYes: f(['--full=YES']),
    otherName: f(['--verify=1']),
  }
  result.stat = { own: OWN, bv: BV, gen: GEN, genFiles: GEN_FILES, user: USER }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
