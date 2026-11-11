// 近似参数名拒绝路线的取证夹具：stdout 只吐 JSON，所有断言留给 verify.mjs 自己做。
//   主态：隔离根上真跑 CLI，给 rc / 原始输出 / 逐项快照；
//   副本态：在隔离副本树上把拒绝判定摘掉，同一组实验给出对照；
//   纯函数：真参数表的返回值（可注入命令表）。
// 缓存根、宿主家目录、依赖目录全在临时树里，finally 整棵清掉，不碰真实数据。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unsupportedNearFlag, nearFlagHit } from '../../lib/params.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c335-'))
const MARK = '.bili-watch-root'
const BV = 'BV19dJQ6sE9F'
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

function seed(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MARK), 'bili-watch cache root\n')
  mkdirSync(join(dir, BV), { recursive: true })
  writeFileSync(join(dir, BV, 'meta.json'), JSON.stringify({ bv: BV }) + '\n')
  writeFileSync(join(dir, BV, 'text.txt'), 'A'.repeat(111))
  writeFileSync(join(dir, 'login-qr.png'), 'B'.repeat(222))
  mkdirSync(join(dir, 'frames'), { recursive: true })
  writeFileSync(join(dir, 'frames', 'manifest.json'), '{"files":[]}\n')
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

// 只跑 CLI、不造缓存条目的对照组：用来比较非删除类命令的输出是否逐字一致。
function cliOnly(look, args, cache) {
  return run(look, args, cache)
}

const result = {}
try {
  for (const d of [join(tmp, 'home'), join(tmp, 'deps')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(tmp, 'deps', 'deps-config.json'), '{}\n')

  const shared = join(tmp, 'cache-shared')
  seed(shared)

  result.main = {
    near: experiment(LOOK, ['clean', '--dryrun'], join(tmp, 'cache-near')),
    dry: experiment(LOOK, ['clean', '--dry-run'], join(tmp, 'cache-dry')),
    help: cliOnly(LOOK, ['help', '--dryrun'], shared),
    doctor: cliOnly(LOOK, ['doctor', '--dryrun'], shared),
    sheet: cliOnly(LOOK, ['sheet', '--dryrun'], shared),
  }
  // 安全档参数被「砍掉尾巴」的手打缩写。修前 rc=0 且 permanent 真删，
  //   修后必须 rc=2 且逐项快照（含哈希）零变化。
  result.main.abbrev = {}
  for (const name of ['dry', 'recy', 'rec', 'sm']) {
    result.main.abbrev[name] = experiment(LOOK, ['clean', `--${name}`], join(tmp, 'cache-ab', name))
  }
  // 分档放宽安全档之后，原来就拒的样本不许变成放行（也不许真删）。
  result.main.still = {}
  for (const name of ['sma', 'recycl', 'al', 'dryrun']) {
    result.main.still[name] = experiment(LOOK, ['clean', `--${name}`], join(tmp, 'cache-still', name))
  }

  // 他处脚本的合法参数 / 单字母全局参数的近似形态：在 clean 上不许因
  // 「近似某个已知名」被拒。用同一个隔离根逐次跑，只看 rc 与 stderr。
  // p/pe/pr 是短名门槛要管的边界：p 归一化长度 1，只比相等不比前缀。
  result.reverse = {}
  for (const name of ['p', 'pe', 'pr', 'proxy', 'gpu', 'no-proxy', 'mirror']) {
    result.reverse[name] = cliOnly(LOOK, ['clean', `--${name}`], join(tmp, 'cache-rev', name))
  }

  // 副本树：结构与仓库同形，look.mjs 的 ../lib 解析到副本里的参数表。
  // 逐文件复制，Windows 上整目录复制会撞符号链接权限。
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
  const lookSrc = readFileSync(treeLook, 'utf8')
  // 不依赖某一行精确文案：把拒绝判定的标识符整体换成一个恒 null 的替身。
  // 这样主态无论被改成哪种形态，副本态都稳定停在「没接这条闸」的修前行为，
  // 不会因为某个锚点被扰动改动就退化成「对照建不出来」的假红。
  const NEEDLE = 'NEAR_FLAG_REJECT'
  result.mutated = { built: lookSrc.includes(NEEDLE) }
  if (result.mutated.built) {
    let patched = lookSrc.split(NEEDLE).join('NEAR_FLAG_REJECT_DISABLED')
    patched = patched.replace(/const NEAR_FLAG_REJECT_DISABLED = [^\n]*/,
      'const NEAR_FLAG_REJECT_DISABLED = null')
    writeFileSync(treeLook, patched, 'utf8')
    result.mutated.near = experiment(treeLook, ['clean', '--dryrun'], join(tmp, 'cache-m-near'))
    // 反向对照必须覆盖四个缩写本身：摘掉拒绝判定后它们必须退回「照删」，
    // 否则 C338 的正向 rc=2 有可能只是别处顺带挡住的假绿。
    result.mutated.abbrev = {}
    for (const name of ['dry', 'recy', 'rec', 'sm']) {
      result.mutated.abbrev[name] = experiment(treeLook, ['clean', `--${name}`], join(tmp, 'cache-m-ab', name))
    }
    result.mutated.help = cliOnly(treeLook, ['help', '--dryrun'], shared)
    result.mutated.doctor = cliOnly(treeLook, ['doctor', '--dryrun'], shared)
    result.mutated.sheet = cliOnly(treeLook, ['sheet', '--dryrun'], shared)
    result.mutated.reverse = {}
    for (const name of ['p', 'pe', 'pr', 'proxy', 'gpu', 'no-proxy', 'mirror']) {
      result.mutated.reverse[name] = cliOnly(treeLook, ['clean', `--${name}`], join(tmp, 'cache-m-rev', name))
    }
  }

  // 真参数表纯函数：可注入命令表，验「非删除类命令」与「将来新增的删除类命令」。
  const FUTURE = { 'future-clean': { deletes: true, accepts: ['dry-run'] } }
  result.pure = {
    cleanNear: unsupportedNearFlag('clean', ['--dryrun']),
    cleanDry: unsupportedNearFlag('clean', ['--dry-run']),
    textNear: unsupportedNearFlag('text', ['--dryrun']),
    viewNear: unsupportedNearFlag('view', ['--dryrun']),
    sheetNear: unsupportedNearFlag('sheet', ['--dryrun']),
    sheetDry: unsupportedNearFlag('sheet', ['--dry-run']),
    proxy: unsupportedNearFlag('clean', ['--proxy']),
    gpu: unsupportedNearFlag('clean', ['--gpu']),
    noProxy: unsupportedNearFlag('clean', ['--no-proxy']),
    mirror: unsupportedNearFlag('clean', ['--mirror']),
    outFree: unsupportedNearFlag('clean', ['--out', '/tmp/x']),
    futureNear: unsupportedNearFlag('future-clean', ['--dryrun'], FUTURE),
    futureDry: unsupportedNearFlag('future-clean', ['--dry-run'], FUTURE),
    // 三向：① 危险方向漏判的四个缩写、② 原就拒的、③ 单字母全局参数。
    dry: unsupportedNearFlag('clean', ['--dry']),
    recy: unsupportedNearFlag('clean', ['--recy']),
    rec: unsupportedNearFlag('clean', ['--rec']),
    sm: unsupportedNearFlag('clean', ['--sm']),
    sma: unsupportedNearFlag('clean', ['--sma']),
    recycl: unsupportedNearFlag('clean', ['--recycl']),
    al: unsupportedNearFlag('clean', ['--al']),
    p: unsupportedNearFlag('clean', ['--p']),
    pe: unsupportedNearFlag('clean', ['--pe']),
    pr: unsupportedNearFlag('clean', ['--pr']),
    // 安全档「不设长度差门槛」的代价取证：极短前缀也会被拒。按
    // 「错拒只是重敲一次」的口径接受，这里只留证据、不写成必须行为。
    shortD: unsupportedNearFlag('clean', ['--d']),
    shortS: unsupportedNearFlag('clean', ['--s']),
    shortK: unsupportedNearFlag('clean', ['--k']),
    // CLI 的 lev 跳过与拒绝判定同源，不许「拦 A 跳 B」。
    hitDry: nearFlagHit('clean', ['--dry']),
    hitProxy: nearFlagHit('clean', ['--proxy']),
    hitText: nearFlagHit('text', ['--dryrun']),
  }
  result.stat = { bv: BV, user: USER, mark: MARK }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
