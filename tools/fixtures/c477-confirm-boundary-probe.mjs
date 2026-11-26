/**
 * c477-confirm-boundary-probe.mjs —— N-F2 确认边界取证（2026-11-25，1252 派单 B 块）
 *
 * 真起 index.js 的路由 handler，走「两次真实 HTTP 请求 + 中间插文件」：
 *   ① POST /cache/preview 拿 tokens 清单
 *   ② 中途造一个确认时没有的文件（新增可删 / 新增外来 / 同数量同字节替换）
 *   ③ POST /cache/clear 带确认时的 tokens
 * 断言：中途插入/被换掉的对象不删，确认过的对象照删。
 *
 * 子进程独立跑（环境变量由调用方给）：BILI_WATCH_CACHE 指向临时缓存根。
 * 输出一行 CONFIRM_JSON=<json>。
 */
import { pathToFileURL } from 'node:url'

const idxUrl = process.argv[2]
const mod = await import(idxUrl)
const regs = []
const logs = []
const mkCtx = () => ({
  logger: { warn() {}, info(m) { logs.push(String(m)) }, error() {} },
  commands: { register() {} },
  on() {},
  get() { return { register() {} } },
  effect(fn) { return fn() },
  webServer: { register(rt) { regs.push(rt); return () => {} } },
})
const dispose = mod.apply(mkCtx())
const route = regs[0]
if (!route) { console.log('NO_ROUTE'); process.exit(3) }

const fs = await import('node:fs')
const path = await import('node:path')
const root = process.env.BILI_WATCH_CACHE

const mkRes = () => ({
  code: null, headers: null, body: null,
  writeHead(c, h) { this.code = c; this.headers = h; return this },
  setHeader() { return this },
  end(b) { this.body = String(b); return this },
  write() { return this },
})
const mkReq = (url, body) => ({
  method: 'POST', url,
  headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
  socket: { remoteAddress: '127.0.0.1' },
  on(ev, cb) { if (ev === 'data') setTimeout(() => cb(JSON.stringify(body)), 0); if (ev === 'end') setTimeout(cb, 0); return this },
})
const call = async (url, body) => {
  const res = mkRes()
  await route.handler(mkReq(url, body), res)
  let j = null
  try { j = JSON.parse(res.body) } catch {}
  return { code: res.code, json: j }
}

const reset = () => {
  for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n), { recursive: true, force: true })
  fs.writeFileSync(path.join(root, '.bili-watch-root'), '')
}
const mkBv = (name) => {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'meta.json'), '{}')
  return d
}
const exists = (p) => fs.existsSync(p)

const out = {}

try {
  // 现场 1：预览 → 中途新增一个可删的 BV 产物 → clear（带旧 tokens）→ 新 BV 不该删。
  reset()
  const bvA = mkBv('BV1aaaaaaaaa')
  const prev1 = await call('/api/bili-watch/cache/preview', {})
  const tokens1 = prev1.json?.data?.tokens || []
  const bvB = mkBv('BV1bbbbbbbbb') // 确认之后新增
  const clear1 = await call('/api/bili-watch/cache/clear', { all: true, confirmed: true, tokens: tokens1 })
  out.s1 = {
    tokensIncludedA: tokens1.length > 0,
    aGone: !exists(bvA),
    bKept: exists(bvB),
    skipped: Array.isArray(clear1.json?.data?.skipped) ? clear1.json.data.skipped.map((s) => s.name) : [],
    code: clear1.code,
  }

  // 现场 2：勾 includeUnknown 预览 → 中途新增未展示的外来文件 → clear（带 tokens）→ 外来文件不删。
  //   preview 不带 includeUnknown（外来文件只进 unknownFiles/tokens，不进 entries），
  //   clear 勾 includeUnknown（才会删外来文件）——中间插入的新外来文件不在 tokens 里应跳过。
  reset()
  mkBv('BV1ccccccccc')
  fs.writeFileSync(path.join(root, '外部文档.pdf'), 'foreign-original')
  const prev2 = await call('/api/bili-watch/cache/preview', {})
  const tokens2 = prev2.json?.data?.tokens || []
  const foreignNew = path.join(root, '中途新增.txt')
  fs.writeFileSync(foreignNew, 'inserted-after-confirm')
  const clear2 = await call('/api/bili-watch/cache/clear', { all: true, confirmed: true, includeUnknown: true, tokens: tokens2 })
  out.s2 = {
    tokensCount: tokens2.length,
    newForeignKept: exists(foreignNew),
    code: clear2.code,
    skipped: Array.isArray(clear2.json?.data?.skipped) ? clear2.json.data.skipped.map((s) => s.name) : [],
  }

  // 现场 3：同数量同字节替换——预览后删掉旧 BV、放一个同名同结构但内容不同的 meta.json。
  //   mtime 变化（即便 size 一样）必须让 token 失配 → 跳过不删（该文件是确认后被换过的）。
  reset()
  const bvC = mkBv('BV1ddddddddd')
  const metaC = path.join(bvC, 'meta.json')
  fs.writeFileSync(metaC, '{}')
  const prev3 = await call('/api/bili-watch/cache/preview', {})
  const tokens3 = prev3.json?.data?.tokens || []
  // 同 byte 数替换（'{}' 两个字节换成 '[]' 两个字节），mtime 人为后退以确保变化。
  fs.writeFileSync(metaC, '[]')
  const old = new Date(Date.now() - 100000)
  fs.utimesSync(metaC, old, old)
  // entry 的 mtimeMs 取的是目录本身的 mtime，所以要把目录 mtime 改掉才模拟「同大小但被换过」。
  fs.utimesSync(bvC, old, old)
  const clear3 = await call('/api/bili-watch/cache/clear', { all: true, confirmed: true, tokens: tokens3 })
  out.s3 = {
    tokensCount: tokens3.length,
    replacedDirKept: exists(bvC),
    metaContent: exists(metaC) ? fs.readFileSync(metaC, 'utf8') : null,
    code: clear3.code,
    skipped: Array.isArray(clear3.json?.data?.skipped) ? clear3.json.data.skipped.map((s) => s.name) : [],
  }
  // 4-F1 核对（B-3）：勾 includeUnknown 时「预览 N 项 / M 文件」与「实删 N' 项 / M' 文件」的口径差。
  //   判断是「预览漏项致多删」还是「显示口径不同（预览按当前未勾选、foreign 需单独勾选）」。
  reset()
  mkBv('BV1eeeeeeeee')
  fs.writeFileSync(path.join(root, '用户的读书笔记.txt'), 'foreign-data')
  const prev4 = await call('/api/bili-watch/cache/preview', {}) // 面板预览不带 includeUnknown
  const tokens4 = prev4.json?.data?.tokens || []
  const clear4 = await call('/api/bili-watch/cache/clear', { all: true, confirmed: true, includeUnknown: true, tokens: tokens4 })
  out.s4 = {
    previewCount: prev4.json?.data?.count,
    previewFiles: prev4.json?.data?.files,
    previewUnknown: Array.isArray(prev4.json?.data?.unknownFiles) ? prev4.json.data.unknownFiles.length : 0,
    clearItems: clear4.json?.data?.items,
    clearRemoved: clear4.json?.data?.removed,
    clearPlannedFiles: clear4.json?.data?.plannedFiles,
    foreignGone: !exists(path.join(root, '用户的读书笔记.txt')),
    bvGone: !exists(path.join(root, 'BV1eeeeeeeee')),
  }
} catch (e) {
  out.error = String(e?.stack || e)
}

dispose()
console.log('CONFIRM_JSON=' + JSON.stringify(out))
process.exit(0)
