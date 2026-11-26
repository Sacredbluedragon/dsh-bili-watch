// 1516 C-4：autoCleanCache 宿主验证（补成判据 C489）。
// 复用 c1a1a2-child.mjs 真起一个独立进程 → 真 import index.js → 真调 route.handler
// 打 GET /api/bili-watch/status → 读 payload.data.cache.lastAutoClean。
//
// 为什么每个场景独立进程：CACHE_CFG / lastCleanAt / lastRealClean / DSH_HOME / BILI_WATCH_*
// 都在 import 那一刻定死。坏 JSON 连打两次必须是两个进程，才验得到「第二次不再被移走」。
// 取数路径是 payload.data.cache（不是 payload.cache）——0.4 踩过。
//
// stdout 只打一行 JSON（driver 侧的 spawnSync 解析）：AUTOCLEAN_JSON=...
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const IDX = join(ROOT, 'index.js') // child 内部自己 pathToFileURL，这里必须传普通路径
const CHILD = join(HERE, 'c1a1a2-child.mjs')
const sandboxes = []
const baseEnv = (over) => {
  const env = { ...process.env }
  for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME']) delete env[k]
  return { ...env, ...over }
}

function mkRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), 'bw-c489-' + tag + '-'))
  const home = join(root, 'home'); mkdirSync(home, { recursive: true })
  const deps = join(root, 'deps'); mkdirSync(deps, { recursive: true })
  const cache = join(root, 'cache'); mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, '.bili-watch-root'), '')
  const bv = join(cache, 'BV1aaaaaaaaa'); mkdirSync(bv, { recursive: true })
  writeFileSync(join(bv, 'meta.json'), JSON.stringify({ files: ['BV1aaaaaaaaa-01.jpg'], at: Date.now() }))
  const jpg = join(bv, 'BV1aaaaaaaaa-01.jpg')
  writeFileSync(jpg, 'x')
  // 8 天前：默认开时按天清理必然删它；被 bad-delete-mode 停手时留得住。
  const old = (Date.now() - 8 * 86400000) / 1000
  utimesSync(jpg, old, old)
  sandboxes.push(root)
  return { root, home, deps, cache, jpg, cfg: join(deps, 'cache-config.json') }
}

// 真起新进程打一次 /status。返回 { rc, state, fileExists, raw }。
function status(s) {
  const plan = { calls: [{ method: 'GET', path: '/api/bili-watch/status' }], watchPaths: [s.jpg] }
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify(plan), IDX], {
    env: baseEnv({ DSH_HOME: s.home, BILI_WATCH_CACHE: s.cache, BILI_WATCH_DEPS: s.deps }),
    encoding: 'utf8', timeout: 90000, cwd: ROOT, maxBuffer: 8 * 1024 * 1024,
  })
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean)
  let parsed = null
  try { parsed = JSON.parse(lines[lines.length - 1]) } catch {}
  const call0 = parsed && parsed.calls && parsed.calls[0]
  const cache = call0 && call0.payload && call0.payload.data && call0.payload.data.cache
  const la = cache && cache.lastAutoClean
  return {
    rc: r.status,
    code: call0 ? call0.code : null,
    state: la && la.skipReason ? la.skipReason.state : undefined,
    fileExists: call0 && call0.files ? !!call0.files[0].exists : existsSync(s.jpg),
    rawTail: String(r.stderr || '').slice(-200),
  }
}

const out = {}
try {
  // ① 坏 JSON 两次（两个独立进程）——验证「第二次不再被移走」。
  {
    const s = mkRoot('badjson')
    writeFileSync(s.cfg, '{bad json')
    out.bad1 = status(s)
    out.bad2 = status(s) // 新进程
    out.badBytes = readFileSync(s.cfg, 'utf8')
    out.badCfgKept = out.badBytes === '{bad json'
  }
  // ①b 修好后恢复清理（同一 root，改好配置再起新进程）。
  {
    const s = mkRoot('recover')
    writeFileSync(s.cfg, '{bad json')
    out.recoverBad = status(s)
    writeFileSync(s.cfg, JSON.stringify({ deleteMode: 'permanent', autoClean: true, days: 1, maxMb: 100 }))
    out.recoverGood = status(s)
  }
  // ② 顶层非法形状：[] / "hello" / 42 / null —— 一律 bad-delete-mode 零删。
  for (const [tag, txt] of [['arr', '[]'], ['str', '"hello"'], ['num', '42'], ['null', 'null']]) {
    const s = mkRoot('shape-' + tag)
    writeFileSync(s.cfg, txt)
    out['shape_' + tag] = status(s)
  }
  // ③ 缺省对照：不建配置文件 → 照常清理。
  {
    const s = mkRoot('default')
    out.default = status(s)
  }
  out.fatal = null
} catch (e) {
  out.fatal = String(e && e.stack || e)
} finally {
  for (const root of sandboxes) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
}
console.log('AUTOCLEAN_JSON=' + JSON.stringify(out))
