// C302–C307（0.4.10 面板五件 + 布局）共用取证夹具。stdout 只吐一行 JSON。
//
// 为什么不是只读源码：派单硬要求 2 要「隔离根里真造出缺依赖 / 有缓存 / 三档各选一次」。
//   这里复用 perf-child.mjs 已验证的假 ctx 范式拿到 index.js export 的 apply() 注册出来的
//   route.handler，用假 req/res **真调被测端点**（不是复刻写盘逻辑），再把同一个隔离根
//   喂给 tools/look.mjs 真跑 clean / sheet --dry-run，端到端看输出有没有跟着配置变。
//   缓存根、deps 目录、家目录全在临时树；不碰生产缓存、不连网、不删真文件。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const INDEX = join(ROOT, 'index.js')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const CLIENT = join(ROOT, 'client.js')

const tmp = mkdtempSync(join(tmpdir(), 'c302-panel-'))
const depsDir = join(tmp, 'deps')
const cacheDir = join(tmp, 'cache')
const outDir = join(tmp, 'out')
for (const d of [depsDir, cacheDir, outDir]) mkdirSync(d, { recursive: true })

// DEPS 是 index.js 的模块级常量，必须在 import 之前设好（perf-child.mjs 同款）。
process.env.BILI_WATCH_DEPS = depsDir
process.env.BILI_WATCH_PROJ = depsDir
process.env.BILI_WATCH_CACHE = cacheDir
process.env.DSH_HOME = join(tmp, 'home')

const out = { fatal: null, status: {}, config: {}, clean: {}, sheet: {}, files: {}, ui: {}, paths: { depsDir, cacheDir, outDir } }
const BV = 'BV19dJQ6sE9F'
const MARK = '.bili-watch-root'

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const outPathOf = (stdout) => {
  const m = /→ 输出 (.+?)(?:；|\r?\n|$)/.exec(String(stdout || ''))
  return m ? m[1].trim() : ''
}
const modeOf = (stdout) => {
  const m = /（方式 ([^）]+)）/.exec(String(stdout || ''))
  return m ? m[1].trim() : ''
}

function runLook(args) {
  const r = spawnSync(process.execPath, [LOOK, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env },
  })
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '').slice(-300) }
}

function seed() {
  mkdirSync(join(cacheDir, BV), { recursive: true })
  writeFileSync(join(cacheDir, BV, 'meta.json'), JSON.stringify({ bv: BV }) + '\n')
  writeFileSync(join(cacheDir, BV, 'text.txt'), 'A'.repeat(111))
  mkdirSync(join(cacheDir, 'frames'), { recursive: true })
  writeFileSync(join(cacheDir, 'frames', 'manifest.json'), '{"files":[]}\n')
  writeFileSync(join(cacheDir, 'frames', `${BV}-01.jpg`), 'D'.repeat(444))
  writeFileSync(join(cacheDir, MARK), 'bili-watch cache root\n')
}

let route = null
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  commands: { register() {} },
  on() {}, get() { return { register() {} } },
  effect(fn) { return fn() },
  webServer: { register(rt) { route = rt; return () => {} } },
}

const withTimeout = (p, ms, tag) => {
  let t
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${tag} 超时 ${ms}ms`)), ms) })
  return Promise.race([p, guard]).finally(() => clearTimeout(t))
}

function call(method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req = Object.assign(Readable.from(raw ? [raw] : []), {
    method, url: `http://127.0.0.1${path}`,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  })
  const acc = { code: 200, body: '' }
  const res = {
    writeHead(n) { acc.code = n; return this },
    setHeader() { return this },
    write(s) { acc.body += String(s); return this },
    end(b) { if (b !== undefined) acc.body += String(b); return this },
  }
  return withTimeout(Promise.resolve(route.handler(req, res)), 40000, `${method} ${path}`).then(() => {
    let j = null
    try { j = JSON.parse(acc.body) } catch {}
    return { code: acc.code, json: j, raw: acc.body.slice(0, 400) }
  })
}

// 从 client.js 抠原样函数体真求值：只有 clearAllConfirmNode 是本次新增的展示层函数，
//   其余三个（dismissHintForever / showHintAgain / setHintEnabled）由 C282/C283 的
//   issue14-probe.mjs 覆盖，本夹具不重复造。
function evalClearAllConfirm() {
  const src = readFileSync(CLIENT, 'utf8')
  const sig = 'function clearAllConfirmNode(h, o) {'
  const i = src.indexOf(sig)
  if (i < 0) return { error: '抠不到 clearAllConfirmNode 签名' }
  const open = src.indexOf('{', i)
  let depth = 0, end = -1
  for (let k = open; k < src.length; k++) {
    const c = src[k]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = k + 1; break } }
  }
  if (end < 0) return { error: 'clearAllConfirmNode 花括号不配平' }
  const body = src.slice(i, end) + '\nreturn clearAllConfirmNode'
  let F
  try { F = new Function(body)() } catch (e) { return { error: 'new Function 失败：' + String(e?.message || e) } }
  const nodes = []
  const h = (tag, props, ...kids) => { const n = { tag, props: props || {}, kids }; nodes.push(n); return n }
  const texts = (n) => {
    const acc = []
    const walk = (x) => {
      if (x == null || typeof x === 'boolean') return
      if (typeof x === 'string' || typeof x === 'number') { acc.push(String(x)); return }
      if (Array.isArray(x)) { x.forEach(walk); return }
      if (x && typeof x === 'object' && x.tag) { x.kids.forEach(walk); return }
    }
    walk(n)
    return acc
  }
  try {
    const o = { preview: { count: 12, bytes: 3 * 1048576, force: true }, fmt: (b) => (b / 1048576).toFixed(1) + ' MB', confirm() {}, cancel() {} }
    const root = F(h, o)
    return {
      hasDanger: Object.prototype.hasOwnProperty.call(root.props || {}, 'data-bl-danger'),
      hasDlg: Object.prototype.hasOwnProperty.call(root.props || {}, 'data-bl-dlg'),
      texts: texts(root),
      nodeCount: nodes.length,
    }
  } catch (e) { return { error: '真求值失败：' + String(e?.message || e) } }
}

try {
  const mod = await import(pathToFileURL(INDEX).href)
  mod.apply(ctx)
  if (!route) throw new Error('NO_ROUTE：假 ctx 没拿到 webServer.register')

  // ① 缺依赖现场：deps 空目录，/status 的 deps 行应有 ok:false
  const st0 = await call('GET', '/api/bili-watch/status')
  out.status.missingDeps = {
    code: st0.code, ok: st0.json?.ok,
    deps: (st0.json?.data?.deps || []).map((d) => ({ id: d.id, ok: d.ok })),
    defaultOutInCache: st0.json?.data?.cache?.defaultOut,
  }

  // ② 有缓存现场：seed 一棵带正面凭证的缓存根。
  //    /status 的 cache.files 有 TTL（cacheStatVal），第二次请求会回第一次空缓存的 0，
  //    那是有意的性能缓存、不是缺陷；「有缓存」的证据用真数文件数 + clean --dry-run 的枚举。
  seed()
  let seeded = 0
  const countFiles = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) countFiles(p)
      else seeded++
    }
  }
  countFiles(cacheDir)
  const st1 = await call('GET', '/api/bili-watch/status')
  out.status.withCache = {
    code: st1.code, ok: st1.json?.ok, seededFiles: seeded,
    files: st1.json?.data?.cache?.files, items: st1.json?.data?.cache?.items,
  }

  // ③ 三档各选一次：POST /config → 真写 cache-config.json → 真跑 clean --dry-run
  for (const m of ['permanent', 'recycle', 'smart']) {
    const r = await call('POST', '/api/bili-watch/config', { deleteMode: m })
    const cfg = readJson(join(depsDir, 'cache-config.json'))
    const dry = runLook(['clean', '--all', '--dry-run'])
    out.config[m] = { code: r.code, respMode: r.json?.data?.deleteMode, fileMode: cfg?.deleteMode, why: r.json?.why }
    out.clean[m] = { rc: dry.rc, mode: modeOf(dry.out), tail: dry.out.slice(-160), err: dry.err }
  }
  // ④ 非法值必须 400，且不许静默回落
  const bad = await call('POST', '/api/bili-watch/config', { deleteMode: 'bogus' })
  out.config.invalid = { code: bad.code, why: bad.json?.why }
  // ⑤ 刷新保持：重选 recycle 后重读文件（不重跑 /config 回包）
  await call('POST', '/api/bili-watch/config', { deleteMode: 'recycle' })
  out.files.cacheCfg = readJson(join(depsDir, 'cache-config.json'))

  // ⑥ defaultOut：POST /config → 真写 deps-config.json → 真跑 sheet --dry-run 看落点
  const d = await call('POST', '/api/bili-watch/config', { defaultOut: outDir })
  const sheet1 = runLook(['sheet', BV, '--dry-run', '--dur', '60', '--grid', '3x3'])
  out.config.defaultOut = { code: d.code, resp: d.json?.data?.defaultOut }
  out.sheet.withCfg = { rc: sheet1.rc, path: outPathOf(sheet1.out), tail: sheet1.out.slice(-160), err: sheet1.err }
  out.files.depsCfg = readJson(join(depsDir, 'deps-config.json'))
  // ⑦ 清空 defaultOut 后回落（同一个 sheet 命令，输出路径应回到 cacheDir/sheets）
  await call('POST', '/api/bili-watch/config', { defaultOut: '' })
  const sheet2 = runLook(['sheet', BV, '--dry-run', '--dur', '60', '--grid', '3x3'])
  out.sheet.noCfg = { rc: sheet2.rc, path: outPathOf(sheet2.out) }
  // ⑧ 超长 defaultOut 必须 400
  const long = await call('POST', '/api/bili-watch/config', { defaultOut: 'x'.repeat(501) })
  out.config.tooLong = { code: long.code, why: long.json?.why }

  // ⑨ 展示层：抠原样函数体真求值
  out.ui.clearAll = evalClearAllConfirm()
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 700)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify(out))
