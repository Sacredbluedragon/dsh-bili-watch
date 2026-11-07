// 面板首屏性能夹具的「一次冷态测量」：一个进程 = 一次全新的模块加载 = 全空缓存。
//
// 为什么要独立进程：ffmpegProbeCache / ytdlpVerCache / importCache / _gpuCache 全是模块级状态，
//   同一个进程里先测单发再测 4 并发，后者会吃前者的缓存 —— 那就测不出「4 个并发同时未命中」。
//   verify.mjs 的 check() 也是同步的，起服务器 + await 必须落在子进程（C77）。
//
// 真起 HTTP：http.createServer + fetch 打 /api/bili-watch/status，转发给 index.js 注册出来的
//   route.handler（假 ctx，同 c1a1a2-child.mjs）。不是把 depRows 抠出来复刻一遍。
//
// argv[2] = JSON plan { mode, n, depsDir, cacheDir, indexPath }
// stdout 只打一行 JSON；父夹具用 spawnSync 读。
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const plan = JSON.parse(process.argv[2])
process.env.BILI_WATCH_DEPS = plan.depsDir
process.env.BILI_WATCH_PROJ = plan.depsDir
process.env.BILI_WATCH_CACHE = plan.cacheDir

let fatal = null
let route = null
const logs = []
const ctx = {
  logger: { warn: (s) => logs.push(String(s)), info: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)) },
  commands: { register() {} },
  on() {},
  get() { return { register() {} } },
  effect(fn) { return fn() },
  webServer: { register(rt) { route = rt; return () => {} } },
}

const out = {
  mode: plan.mode, n: plan.n, wallMs: -1, maxTickMs: -1,
  spawns: [], codes: [], oks: [], ytdlpRow: null, fatal: null, logs,
}

try {
  const mod = await import(pathToFileURL(plan.indexPath).href)
  mod.apply(ctx)
  if (!route) throw new Error('NO_ROUTE：假 ctx 没拿到 webServer.register')
} catch (e) {
  fatal = String(e?.message || e)
}

if (!fatal) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      const acc = { code: 200, body: '' }
      const fakeRes = {
        writeHead(n) { acc.code = n; return this },
        setHeader() { return this },
        write() { return this },
        end(b) { acc.body = String(b) },
      }
      try {
        await route.handler(req, fakeRes)
      } catch (e) {
        acc.code = 500
        acc.body = JSON.stringify({ ok: false, why: String(e?.message || e) })
      }
      res.writeHead(acc.code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(acc.body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/api/bili-watch/status`

  // 事件循环心跳：5ms 一跳。execFileSync 堵住主线程时这一跳会被推迟，
  //   这是「同步阻塞」的直接证据，不依赖缓存有没有共享（见 perf-probe 头注释）。
  let last = performance.now()
  let maxTickMs = 0
  const tick = setInterval(() => {
    const now = performance.now()
    maxTickMs = Math.max(maxTickMs, now - last)
    last = now
  }, 5)

  const t0 = performance.now()
  const rs = await Promise.all(Array.from({ length: plan.n }, () =>
    fetch(url).then(async (r) => ({ code: r.status, json: await r.json().catch(() => null) }))))
  out.wallMs = Math.round((performance.now() - t0) * 100) / 100
  clearInterval(tick)
  out.maxTickMs = Math.round(maxTickMs * 100) / 100
  out.codes = rs.map((r) => r.code)
  out.oks = rs.map((r) => r.json?.ok === true)
  out.ytdlpRow = rs[0]?.json?.data?.deps?.find((d) => d.id === 'ytdlp') || null
  server.close()
}

out.spawns = globalThis.__BW_SPAWNS__ || []
out.fatal = fatal
console.log(JSON.stringify(out))
process.exit(0)
