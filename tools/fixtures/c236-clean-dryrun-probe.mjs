// C236 取证夹具：stdout 只吐 JSON，所有断言留给 verify.mjs 自己做。
//   ① 主态：真 CLI 跑 clean --dry-run / clean，给出运行原始输出与逐项快照；
//   ② 副本态：在隔离副本树上改参数表 / 摘掉拒绝守卫，给出同样的原始输出与快照；
//   ③ 真 lib 纯函数直接调用的结果。
// 隔离一棵临时树给缓存根、宿主家目录与依赖目录，不碰生产缓存。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as paramsNs from '../../lib/params.mjs'

// 命名空间 + 可选调用：实现未落地时夹具仍能把主态实验跑完（只是纯函数那组为 undefined），
// 不把「脚本崩」伪装成「判据红」。夹具 stdout 与 stderr 会被拼起来当 JSON 解析，禁止写调试输出。
const unsupportedDryRun = (...a) => paramsNs.unsupportedDryRun?.(...a)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c236-'))
const MARK = '.bili-watch-root'
const BV = 'BV19dJQ6sE9F'
// 会被清掉的三个顶层条目；第四个是用户的文件，必须全程不动。
const OWN = [BV, 'login-qr.png', 'frames']
const USER = '用户素材.psd'

function mkEnv(cache) {
  return {
    ...process.env,
    BILI_WATCH_CACHE: cache,
    BILI_WATCH_DEPS: join(tmp, 'deps'),
    DSH_HOME: join(tmp, 'home'),
  }
}

function seed(dir) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, BV), { recursive: true })
  writeFileSync(join(dir, BV, 'meta.json'), JSON.stringify({ bv: BV }) + '\n')
  writeFileSync(join(dir, BV, 'text.txt'), 'A'.repeat(111))
  writeFileSync(join(dir, 'login-qr.png'), 'B'.repeat(222))
  mkdirSync(join(dir, 'frames'), { recursive: true })
  writeFileSync(join(dir, 'frames', 'manifest.json'), '{"files":[]}\n')
  writeFileSync(join(dir, 'frames', `${BV}-01.jpg`), 'D'.repeat(444))
  writeFileSync(join(dir, USER), 'U'.repeat(55))
  writeFileSync(join(dir, MARK), 'bili-watch cache root\n')
}

/**
 * 逐项快照：相对路径 → 类型 / 大小 / mtime / 内容 sha256。
 * 排除运行日志目录（每次退出都追加一行）与缓存根标记（本来就不参与清理）。
 * 返回原始对象，不在夹具里下结论 —— 比对由判据自己做。
 */
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

/**
 * 一组完整实验：造树 → 干跑前快照 → 干跑 → 干跑后快照 → 真删 → 真删后快照。
 * 不预热：快照已排除运行日志与缓存根标记（这两样每次运行都会变），其余条目在
 * 命令启动阶段不会被改写；多一轮预热反而会在修前形态下先把哨兵删光，证据失真。
 */
function experiment(look, cache) {
  seed(cache)
  const before = snap(cache)
  const dry = run(look, ['clean', '--dry-run'], cache)
  const after = snap(cache)
  const real = run(look, ['clean'], cache)
  const realAfter = snap(cache)
  return { before, dry, after, real, realAfter }
}

const result = {}
try {
  for (const d of [join(tmp, 'home'), join(tmp, 'deps')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(tmp, 'deps', 'deps-config.json'), '{}\n')

  result.main = experiment(LOOK, join(tmp, 'cache'))

  // 副本树：结构上与仓库同形，look.mjs 的 ../lib 解析到副本里的参数表。
  // 逐文件复制：Windows 上整目录 cpSync 在这台机器会把进程直接带走（rc=127、无异常），
  // 自己走 readdir + copyFileSync 反而可控，也只搬 CLI 真会加载的那几个文件。
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
  const paramsPath = join(tree, 'lib', 'params.mjs')
  const lookPath = join(tree, 'tools', 'look.mjs')

  const replaceOnce = (file, from, to) => {
    const src = readFileSync(file, 'utf8')
    if (!src.includes(from)) return false
    writeFileSync(file, src.replace(from, to), 'utf8')
    return true
  }

  // ① 删除类命令还在、但参数表声明不再支持 --dry-run：应当 rc=2 拒绝，一个字节不删。
  const CLEAN_NEW = "clean: { accepts: ['dry-run', 'force-unknown', 'all', 'permanent', 'recycle', 'smart'], deletes: true"
  const CLEAN_OLD = "clean: { accepts: ['force-unknown', 'all', 'permanent', 'recycle', 'smart'], deletes: true"
  result.reject = { built: false }
  if (replaceOnce(paramsPath, CLEAN_NEW, CLEAN_OLD)) {
    result.reject = { built: true, ...experiment(treeLook, join(tmp, 'cache-r')) }
  }

  // ② 再把拒绝守卫与干跑传递一并摘掉：等价于修前形态，应当重新变成「打一行 ⚠ 后真删」。
  const REJECT_LINE = 'const DRY_RUN_REJECT = unsupportedDryRun(cmd, argv)'
  const CALL_NEW = 'removeOwned(cacheDir(), { dryRun, mode })'
  const CALL_OLD = 'removeOwned(cacheDir())'
  let mutated = false
  if (result.reject.built) {
    const a = replaceOnce(lookPath, REJECT_LINE, 'const DRY_RUN_REJECT = null')
    const b = replaceOnce(lookPath, CALL_NEW, CALL_OLD)
    mutated = a && b
  }
  result.mutated = { built: mutated }
  if (mutated) result.mutated = { built: true, ...experiment(treeLook, join(tmp, 'cache-m')) }

  // ③ 真 lib 纯函数：期望写在调用点，不拿被测函数读的那张表当答案。
  result.pure = {
    cleanSupported: unsupportedDryRun('clean', ['clean', '--dry-run']),
    cleanNoFlag: unsupportedDryRun('clean', ['clean']),
    futureDelete: unsupportedDryRun('future-clean', ['future-clean', '--dry-run'], {
      'future-clean': { deletes: true, accepts: [] },
    }),
    futureNoFlag: unsupportedDryRun('future-clean', ['future-clean'], {
      'future-clean': { deletes: true, accepts: [] },
    }),
    nonDelete: unsupportedDryRun('view', ['view', '--dry-run']),
    eqForm: unsupportedDryRun('future-clean', ['future-clean', '--dry-run=1'], {
      'future-clean': { deletes: true, accepts: [] },
    }),
  }
  result.stat = { own: OWN, user: USER }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
