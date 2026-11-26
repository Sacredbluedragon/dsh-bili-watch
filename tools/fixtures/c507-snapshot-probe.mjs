/**
 * c507-snapshot-probe.mjs —— 2128 续派单请求单次枚举取证。
 * 真起 index.js 路由，在子进程 import 前给 node:fs.openSync 加计数器，
 * 分别打 /cache/preview 与 /cache/clear(all=1,confirmed=0)，只数目标大文件的打开次数。
 * 同一夹具另跑未标记根，核对两个入口仍回原零结构。
 * 输出一行 SNAPSHOT_JSON=<json>。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const IDX = path.join(ROOT, 'index.js')
const SELF = fileURLToPath(import.meta.url)

function dirname(p) { return path.dirname(p) }

function mkSandbox(tag, marked) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c507-' + tag + '-'))
  const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true })
  const deps = path.join(base, 'deps'); fs.mkdirSync(deps, { recursive: true })
  const cache = path.join(base, 'cache'); fs.mkdirSync(cache, { recursive: true })
  let target = null
  if (marked) {
    fs.writeFileSync(path.join(cache, '.bili-watch-root'), '')
    const d = path.join(cache, 'httpsb23.tvC5070001')
    fs.mkdirSync(d, { recursive: true })
    target = path.join(d, 'a.mwxyz123.tool.txt')
    fs.writeFileSync(target, Buffer.alloc(2097169, 0x61))
    fs.writeFileSync(path.join(cache, 'user.txt'), 'foreign')
  }
  return { base, home, deps, cache, target, marked }
}

async function child(s) {
  const counts = { preview: 0, clear: 0 }
  const original = fs.openSync
  fs.openSync = function (p, ...rest) {
    if (s.target && path.resolve(String(p)) === path.resolve(s.target)) {
      const key = counts.current || 'preview'
      counts[key]++
    }
    return original.call(this, p, ...rest)
  }
  // cache-own.mjs 用的是 node:fs 的命名导入；同步一次让命名绑定指向计数器。
  syncBuiltinESMExports()

  const regs = []
  const mod = await import(pathToFileURL(IDX).href)
  mod.apply({
    logger: { warn() {}, info() {}, error() {} },
    commands: { register() {} }, on() {},
    get() { return { register() {} } },
    effect(fn) { return fn() },
    webServer: { register(rt) { regs.push(rt); return () => {} } },
  })
  const route = regs[0]
  if (!route) throw new Error('NO_ROUTE')
  const call = async (url, body) => {
    const req = {
      method: 'POST', url,
      headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, cb) { if (ev === 'data') setTimeout(() => cb(JSON.stringify(body)), 0); if (ev === 'end') setTimeout(cb, 0); return this },
    }
    const res = {
      code: null, body: null,
      writeHead(c) { this.code = c; return this },
      setHeader() { return this },
      end(b) { this.body = String(b); return this },
      write() { return this },
    }
    await route.handler(req, res)
    return { code: res.code, json: JSON.parse(res.body) }
  }
  // 先让 index.js 完成缓存根初始化；未标记场景随后把标记临时改名，确保真测到「未标记根」。
  await call('/api/bili-watch/cache/preview', {})
  if (!s.marked) {
    const mark = path.join(s.cache, '.bili-watch-root')
    if (fs.existsSync(mark)) fs.renameSync(mark, mark + '.saved')
  }
  counts.preview = 0
  counts.clear = 0
  counts.current = 'preview'
  const preview = await call('/api/bili-watch/cache/preview', {})
  counts.current = 'clear'
  const clear = await call('/api/bili-watch/cache/clear', { all: 1, confirmed: 0 })
  return {
    counts: { preview: counts.preview, clear: counts.clear },
    preview: { code: preview.code, data: preview.json?.data },
    clear: { code: clear.code, data: clear.json?.data },
  }
}

if (process.argv[2] === '--child') {
  const s = JSON.parse(process.argv[3])
  try { console.log('C507_CHILD=' + JSON.stringify(await child(s))) }
  catch (e) { console.log('C507_CHILD=' + JSON.stringify({ fatal: String(e?.stack || e) })) }
  process.exit(0)
}

const sandboxes = []
const run = (s) => {
  const env = { ...process.env }
  for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME']) delete env[k]
  Object.assign(env, { DSH_HOME: s.home, BILI_WATCH_CACHE: s.cache, BILI_WATCH_DEPS: s.deps })
  const r = spawnSync(process.execPath, [SELF, '--child', JSON.stringify(s)], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  })
  const line = String(r.stdout || '').split('\n').find(x => x.startsWith('C507_CHILD='))
  let parsed = null; try { parsed = JSON.parse(line.slice('C507_CHILD='.length)) } catch {}
  return { rc: r.status, stderr: String(r.stderr || '').slice(-500), ...(parsed || { fatal: 'child json missing' }) }
}

const out = {}
try {
  const marked = mkSandbox('marked', true); sandboxes.push(marked)
  out.marked = run(marked)
  const unmarked = mkSandbox('unmarked', false); sandboxes.push(unmarked)
  out.unmarked = run(unmarked)
} catch (e) { out.fatal = String(e?.stack || e) }
finally { for (const s of sandboxes) { try { fs.rmSync(s.base, { recursive: true, force: true }) } catch {} } }
console.log('SNAPSHOT_JSON=' + JSON.stringify(out))
