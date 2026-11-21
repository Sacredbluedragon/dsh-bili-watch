// C423 探针：隔离根里造 all / ffmpeg 两条下载失败记录，真调 index.js 注册出来的
// GET /api/bili-watch/status handler，回读 data.allFail 与 data.deps[].fail。
//
// 为什么只能子进程：verify 的 check 回调必须同步（C77），而 import index.js +
//   await route.handler 是异步链；与 c302-c307-panel-probe.mjs 同一套假 ctx 范式，
//   不复刻写盘逻辑、不桩被测端点。缓存根 / deps 目录 / 家目录全在临时树，不碰生产。
//
// 失败记录直写隔离副本里的 .download-fail.json（任务口径允许的第二条路：真写盘函数
//   setDownloadFail 由 verify.mjs 内编译链半边覆盖）。stdout 只吐一行 JSON。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const INDEX = join(ROOT, 'index.js')

const tmp = mkdtempSync(join(tmpdir(), 'c423-allfail-'))
const depsDir = join(tmp, 'deps')
mkdirSync(depsDir, { recursive: true })
process.env.BILI_WATCH_DEPS = depsDir
process.env.BILI_WATCH_PROJ = depsDir
process.env.BILI_WATCH_CACHE = join(tmp, 'cache')
process.env.DSH_HOME = join(tmp, 'home')

const ALL_NOTE = '退出码 1（一键装全部）'
const ALL_TAIL = [
  'Traceback (most recent call last):',
  '  File "fetch-deps.mjs", line 1, in <module>',
  'RuntimeError: 模拟一键装全部失败的 traceback 末行',
].join('\n')
const FF_NOTE = '退出码 1（ffmpeg 单项）'
const FF_TAIL = 'ffmpeg 单项失败的 traceback 末行：curl exit 22'

writeFileSync(join(depsDir, '.download-fail.json'), JSON.stringify({
  all: { tail: ALL_TAIL, note: ALL_NOTE, at: 1700000000000 },
  ffmpeg: { tail: FF_TAIL, note: FF_NOTE, at: 1700000000001 },
}), 'utf8')

let route = null
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  commands: { register() {} },
  on() {}, get() { return { register() {} } },
  effect(fn) { return fn() },
  webServer: { register(rt) { route = rt; return () => {} } },
}

function call(method, path) {
  const req = Object.assign(Readable.from([]), {
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
  return Promise.resolve(route.handler(req, res)).then(() => {
    let j = null
    try { j = JSON.parse(acc.body) } catch {}
    return { code: acc.code, json: j }
  })
}

const out = { fatal: null, allFail: null, ffmpegFail: null, rowFail: [], depIds: [] }
try {
  const mod = await import(pathToFileURL(INDEX).href)
  mod.apply(ctx)
  if (!route) throw new Error('NO_ROUTE：假 ctx 没拿到 webServer.register')
  const st = await call('GET', '/api/bili-watch/status')
  const data = (st.json && st.json.data) || {}
  out.allFail = Object.prototype.hasOwnProperty.call(data, 'allFail') ? data.allFail : undefined
  const deps = Array.isArray(data.deps) ? data.deps : []
  out.depIds = deps.map((d) => d.id)
  const ff = deps.find((d) => d.id === 'ffmpeg')
  out.ffmpegFail = ff && ff.fail ? ff.fail : null
  out.rowFail = deps.map((d) => ({ id: d.id, hasFail: Boolean(d.fail), note: (d.fail && d.fail.note) || null }))
} catch (e) {
  out.fatal = String(e && e.message ? e.message : e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(out))
