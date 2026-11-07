// C167 / C168 / C174 的真跑子探针：假 ctx + 真调 index.js 的 route.handler。
//
// 为什么必须独立进程：cacheDir() / CACHE_CFG / lastCleanAt / lastRealClean 全是模块级可变状态，
// 且 DSH_HOME、BILI_WATCH_CACHE、cache-config.json 都在 import 那一刻定死。一个用例一个进程，
// 才能真造出「启动时有活锁」「启动前开关已关」这些时序，而不是靠注入伪造。
//
// argv[2] = JSON plan { calls: [{method, path, body}], watchPaths: [绝对路径] }
// argv[3] = index.js 绝对路径
// stdout 只打一行 JSON（父夹具 spawnSync 读），不能有别的输出。
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const plan = JSON.parse(process.argv[2])
const idxUrl = pathToFileURL(process.argv[3]).href
const watchPaths = plan.watchPaths || []

let route = null
const logs = []
const ctx = {
  logger: {
    warn: (s) => logs.push(String(s)),
    info: (s) => logs.push(String(s)),
    error: (s) => logs.push(String(s)),
  },
  commands: { register() {} },
  on() {},
  get() { return { register() {} } },
  effect(fn) { return fn() },
  webServer: { register(rt) { route = rt; return () => {} } },
}

let fatal = null
try {
  const mod = await import(idxUrl)
  mod.apply(ctx)
} catch (e) {
  fatal = String(e?.message || e)
}
if (!route && !fatal) fatal = 'NO_ROUTE'

const calls = []
for (const c of (fatal ? [] : plan.calls)) {
  const bodyStr = c.body === undefined ? '' : JSON.stringify(c.body)
  const req = Readable.from(bodyStr ? [bodyStr] : [])
  req.method = c.method
  req.url = c.path
  // 写闸要求 content-type 是 application/json；Host 必须是回环。
  req.headers = { host: '127.0.0.1:1', 'content-type': 'application/json' }
  req.socket = { remoteAddress: '127.0.0.1' }
  let code = 0
  let payload = null
  const res = {
    writeHead(n) { code = n; return this },
    setHeader() { return this },
    write() { return this },
    end(b) { try { payload = JSON.parse(String(b)) } catch { payload = { raw: String(b) } } },
  }
  try { await route.handler(req, res) } catch (e) { payload = { thrown: String(e?.message || e) } }
  calls.push({
    path: c.path,
    code,
    payload,
    files: watchPaths.map((p) => ({ p, exists: existsSync(p) })),
  })
}
console.log(JSON.stringify({ ok: !fatal, fatal, calls, logs }))
process.exit(0)
