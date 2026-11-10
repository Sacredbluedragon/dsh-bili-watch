// C287 取证夹具：stdout 只吐 JSON，所有断言留给 verify.mjs 自己做。
//   ① 主态：真 CLI 跑 clean --all --keep-source / clean --all，给原始输出与逐项快照；
//   ② 副本态：在隔离副本树上摘掉拒绝判定，复现「静默忽略后照删」的修前形态；
//   ③ 真 lib 纯函数直接调用的原始返回值。
// 隔离一棵临时树给缓存根、宿主家目录与依赖目录，不碰生产缓存。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as paramsNs from '../../lib/params.mjs'

// 命名空间 + 可选调用：实现未落地时夹具仍能把主态实验跑完（只是纯函数那组为 undefined），
// 不把「脚本崩」伪装成判据红。夹具 stdout 与 stderr 会被拼起来当 JSON 解析，禁止写调试输出。
const unsupportedKeepSource = (...a) => paramsNs.unsupportedKeepSource?.(...a)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c287-'))
const MARK = '.bili-watch-root'
const BV = 'BV19dJQ6sE9F'
const GEN = 'gen-abcdef1234'
const GEN_FILES = [`frames-dl/${GEN}/video.mp4`, `audio-dl/${GEN}/audio.wav`]
// 顶层用户文件：两档 clean 都必须跳过，用来证明「真删」不是把整棵根铲了。
const USER = '用户素材.psd'

function mkEnv(cache) {
  return {
    ...process.env,
    // 删除类实验一律还原原生 rmSync：本机 shim 默认把删除改送回收站，会污染磁盘观察。
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
    CODEBUDDY_SAFE_DELETE_SANDBOX: '0',
    CODEBUDDY_BROKERED_FS_HOOK_ENABLED: '0',
    BILI_WATCH_CACHE: cache,
    BILI_WATCH_DEPS: join(tmp, 'deps'),
    DSH_HOME: join(tmp, 'home'),
  }
}

function seed(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MARK), 'bili-watch cache root\n')
  mkdirSync(join(dir, BV), { recursive: true })
  writeFileSync(join(dir, BV, 'meta.json'), JSON.stringify({ bv: BV }) + '\n')
  writeFileSync(join(dir, BV, 'text.txt'), 'A'.repeat(111))
  // --all 靠 GEN_DIR_RE 认领 gen-<hash>，这两个文件正是 --keep-source 想留的原片。
  mkdirSync(join(dir, 'frames-dl', GEN), { recursive: true })
  writeFileSync(join(dir, 'frames-dl', GEN, 'video.mp4'), 'V'.repeat(64))
  mkdirSync(join(dir, 'audio-dl', GEN), { recursive: true })
  writeFileSync(join(dir, 'audio-dl', GEN, 'audio.wav'), 'A'.repeat(64))
  writeFileSync(join(dir, USER), 'U'.repeat(55))
}

/** 逐项快照：相对路径 → 类型 / 大小 / mtime / 内容 sha256。排除运行日志与缓存根标记。 */
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

/** 一组完整实验：造树 → 前快照 → 真跑 CLI → 后快照。不在夹具里下结论。 */
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

  // ① 拒绝路线：带 --keep-source，rc 必须是 2 且磁盘一个字节不变。
  result.keep = experiment(LOOK, ['clean', '--all', '--keep-source'], join(tmp, 'cache-keep'))
  // ② 双向对照：不带 --keep-source，同样的树必须真删（防「一律不删」蒙混过关）。
  result.plain = experiment(LOOK, ['clean', '--all'], join(tmp, 'cache-plain'))
  // ③ 带值写法与 --help 优先，都是同一个出口的边界。
  result.eqForm = experiment(LOOK, ['clean', '--all', '--keep-source=1'], join(tmp, 'cache-eq'))
  result.help = run(LOOK, ['clean', '--help', '--keep-source'], join(tmp, 'cache-keep'))

  // 副本树：结构上与仓库同形，look.mjs 的 ../lib 解析到副本里的参数表。
  // 逐文件复制：Windows 上整目录 cpSync 在这台机器会把进程直接带走（rc=127、无异常）。
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
  const lookPath = join(tree, 'tools', 'look.mjs')

  const REJECT_LINE = 'const KEEP_SOURCE_REJECT = unsupportedKeepSource(cmd, argv)'
  const src = readFileSync(lookPath, 'utf8')
  const built = src.includes(REJECT_LINE)
  if (built) writeFileSync(lookPath, src.replace(REJECT_LINE, 'const KEEP_SOURCE_REJECT = null'), 'utf8')
  result.mutated = { built }
  // 修前形态：连「本命令不接受」都不会打（RUNTIME_GLOBAL_PARAMS 豁免），然后照删。
  if (built) {
    result.mutated = {
      built: true,
      ...experiment(treeLook, ['clean', '--all', '--keep-source'], join(tmp, 'cache-mutated')),
    }
  }

  // ④ 真 lib 纯函数：期望写在调用点，不拿被测函数读的那张表当答案。
  const future = { 'future-clean': { deletes: true, accepts: [] } }
  const supported = { 'future-clean': { deletes: true, accepts: ['keep-source'] } }
  result.pure = {
    cleanKeep: unsupportedKeepSource('clean', ['clean', '--all', '--keep-source']),
    cleanNoFlag: unsupportedKeepSource('clean', ['clean', '--all']),
    viewKeep: unsupportedKeepSource('view', ['view', '--keep-source']),
    futureKeep: unsupportedKeepSource('future-clean', ['future-clean', '--keep-source'], future),
    futureNoFlag: unsupportedKeepSource('future-clean', ['future-clean'], future),
    futureEq: unsupportedKeepSource('future-clean', ['future-clean', '--keep-source=1'], future),
    supported: unsupportedKeepSource('future-clean', ['future-clean', '--keep-source'], supported),
  }
  result.stat = { bv: BV, gen: GEN, genFiles: GEN_FILES, user: USER }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
