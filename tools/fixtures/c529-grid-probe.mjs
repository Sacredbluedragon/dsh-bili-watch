/**
 * C529 取证夹具：--grid 严格校验真跑，stdout 只吐一行 JSON。
 * 四组对照（Astra 0843 第 1 条）：
 *   ① CLI 合法 3x3 → rc=0 出计划
 *   ② CLI 畸形 3x3x2 / 3x3abc / xx / 0x3 / -1x3 → rc≠0，错误行在计划之前
 *   ③ 宿主 execute（真 index.js apply(ctx) 分发）→ 畸形 ok:false 且 text 含错误，合法 ok:true
 *   ④ sheetPlan / parseGrid 纯函数直调 → 畸形抛错、合法 n=9
 *
 * 2026-11-27 1344 落实 F1（裁定 20261127-1334-Astra）：本夹具改为 hermetic。
 *   改前：宿主合法分支 `tool.execute({command:'sheet', bv:BV1xx411c7mD, grid, full:false})`
 *   没传 step、没隔离缓存，合法 3x3 会真抽帧真下载，写进用户真实缓存
 *   （D:/DeepSeek-Harness/.dsh/bili-watch/cache/），与文件头「全部 --dry-run，不写产物」矛盾。
 *   改后：
 *     · 缓存根 / DSH_HOME / 工作目录全指 mkdtempSync 临时树，跑完 rmSync；
 *     · 起本地 mock B 站，合法宿主分支预填 9 帧 + manifest 走缓存命中，不下载视频；
 *     · 给所有 look.mjs 子进程装 fetch 看守（NODE_OPTIONS --import guard）：
 *         B 站四域名改写到 mock；其它外部域名记逃逸日志并抛错；127.0.0.1 原样放行；
 *     · 自检一次「外部请求被拦下」证据，逃逸日志非空或看守失效 → rc≠0；
 *     · 合法 / 畸形输入仍从真 index.js 的 tool.execute 入口走，不退化成纯函数。
 *   本版不改 index.js 工具 schema（宿主 dryRun 记为待评估能力，候选池）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startMockBili } from './bili-mock.mjs'
import { findFfmpeg } from '../../lib/media.mjs'
import { framesDir, framesDirName } from '../../lib/frames.mjs'

const HERE = fileURLToPath(import.meta.url)
const ROOT = join(dirname(HERE), '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const INDEX = join(ROOT, 'index.js')
const SHEETPLAN = join(ROOT, 'lib', 'sheet-plan.mjs')
const BAD = ['3x3x2', '3x3abc', 'xx', '0x3', '-1x3']
const ERR = '格子格式应是 NxM'
const MOCK_BV = 'BV1mock00001'

const out = {
  cli: { legal: null, bad: {} },
  host: { registered: 0, legal: null, bad: {} },
  pure: { legal: null, bad: {} },
  hermetic: {
    cacheUnderTmp: false, escapeLines: 0, guardFired: false,
    playurlHits: 0, mockHits: 0, tempCleaned: false, frames: 0, ffmpegUsed: false,
  },
  fatal: null,
}

// 独立临时树：缓存 / home / 工作目录 / 看守日志 / guard 脚本全在这里，跑完清理。
const temp = mkdtempSync(join(tmpdir(), 'bw-c529-'))
const cache = join(temp, 'cache')
const home = join(temp, 'home')
const work = join(temp, 'work')
const escapeLog = join(temp, 'escape.jsonl')
const selftestLog = join(temp, 'selftest-escape.jsonl')
const guardFile = join(temp, 'guard-preload.mjs')
mkdirSync(cache, { recursive: true })
writeFileSync(join(cache, '.bili-watch-root'), '') // 让 pickCacheDir 不拼子目录
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(escapeLog, '')
writeFileSync(selftestLog, '')
out.hermetic.cacheUnderTmp = cache.startsWith(tmpdir())

// 看守 preload：B 站四域名 → mock；127.0.0.1 → 原样；其它外部 → 记日志 + 抛错。
// 用数组 join 而非模板字符串，避免外层把 guard 内的 ${} 当插值。
const guardSrc = [
  "import { appendFileSync } from 'node:fs'",
  "const PORT = process.env.BW_MOCK_PORT || ''",
  "const ESC = process.env.BW_ESCAPE_LOG || ''",
  "const HOSTS = new Set(['api.bilibili.com','passport.bilibili.com','comment.bilibili.com','i0.hdslb.com'])",
  "const real = globalThis.fetch",
  "function esc(url) { try { if (ESC) appendFileSync(ESC, url + '\\n') } catch {} }",
  "globalThis.fetch = function(input, init) {",
  "  const raw = typeof input === 'string' ? input : String(input && input.url ? input.url : input)",
  "  let u; try { u = new URL(raw) } catch { esc(raw); throw new Error('C529 guard: url unparsable ' + raw) }",
  "  if (HOSTS.has(u.hostname)) {",
  "    if (!PORT) { esc(raw); throw new Error('C529 guard: BW_MOCK_PORT missing ' + raw) }",
  "    return real('http://127.0.0.1:' + PORT + '/' + u.hostname + u.pathname + u.search, init)",
  "  }",
  "  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') return real(input, init)",
  "  esc(raw); throw new Error('C529 guard: external request blocked ' + u.hostname + u.pathname)",
  "}",
].join('\n') + '\n'
writeFileSync(guardFile, guardSrc)
const guardUrl = pathToFileURL(guardFile).href

let mock = null
try {
  mock = await startMockBili()
  // 必须在 import index.js / 起任何子进程之前设好：index.js 的 cacheWant 读 BILI_WATCH_CACHE，
  // trimForModel 落盘 / runsFile 日志分别跟着缓存根与 DSH_HOME 走。
  Object.assign(process.env, {
    BW_MOCK_PORT: String(mock.port),
    NODE_OPTIONS: '--import=' + guardUrl,
    BW_ESCAPE_LOG: escapeLog,
    BILI_WATCH_CACHE: cache,
    DSH_HOME: home,
  })

  // 预填 9 帧 + manifest，让合法宿主分支的 sheet 命中缓存、不下载视频。
  const FF = findFfmpeg(process.env.BILI_WATCH_FFMPEG || '')
  out.hermetic.ffmpegUsed = !!FF
  const seed = join(work, 'seed.jpg')
  if (FF) {
    const g = spawnSync(FF, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1', '-frames:v', '1', seed],
      { encoding: 'utf8', timeout: 60000 })
    if (g.status !== 0) throw new Error('造夹具 jpg 失败：' + String(g.stderr || '').slice(-200))
  }
  const dir = framesDir(cache, framesDirName(MOCK_BV, 1, '5s'))
  mkdirSync(dir, { recursive: true })
  const files = []
  for (let i = 1; i <= 9; i++) {
    const f = `${MOCK_BV}-${String(i).padStart(2, '0')}.jpg`
    if (FF) copyFileSync(seed, join(dir, f))
    else writeFileSync(join(dir, f), 'x')
    files.push(f)
  }
  out.hermetic.frames = files.length
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    ok: true, bv: MOCK_BV, p: 1, step: 5, scene: false, sceneTh: null,
    frames: files.length, files, times: null, at: Date.now(),
  }))

  /** ① ② CLI 真跑（--dry-run 只出计划，继承上面的 hermetic env） */
  const cliCall = (grid) => {
    const r = spawnSync(process.execPath, [LOOK, 'sheet', MOCK_BV, '--grid', grid, '--dry-run', '--quiet'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    })
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
    const first = text.split('\n')[0] || ''
    return { rc: r.status, firstLine: first.slice(0, 160), hasErr: text.includes(ERR), hasPlan: text.includes('每格') }
  }
  try {
    out.cli.legal = cliCall('3x3')
    for (const g of BAD) out.cli.bad[g] = cliCall(g)
  } catch (e) { out.fatal = 'cli: ' + String(e && e.message ? e.message : e) }

  /** ③ 宿主 execute：真 import index.js 的 apply(ctx) 分发，合法分支预填帧命中缓存 */
  const captured = []
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    commands: { register() {} },
    on() {},
    get(name) { return name === 'tools' ? { register(t) { captured.push(t) } } : { register() {} } },
    effect(fn) { return fn() },
    webServer: { register() { return () => {} } },
  }
  try {
    const mod = await import(pathToFileURL(INDEX).href)
    mod.apply(ctx)
    out.host.registered = captured.length
    const tool = captured.find((t) => t && t.name === 'bili_watch')
    if (!tool) throw new Error('未捕获 bili_watch 工具')
    const call = async (grid) => {
      try {
        const args = { command: 'sheet', bv: MOCK_BV, grid, step: 5, full: false }
        if (FF) args.ffmpeg = FF
        const r = await tool.execute(args, {})
        return { ok: !!(r && r.ok), text: String((r && r.text) || '').slice(0, 200) }
      } catch (e) { return { threw: String(e && e.message ? e.message : e) } }
    }
    out.host.legal = await call('3x3')
    for (const g of BAD) out.host.bad[g] = await call(g)
  } catch (e) { out.fatal = (out.fatal ? out.fatal + ' | ' : '') + 'host: ' + String(e && e.message ? e.message : e) }

  /** 看守自检：外部请求必须被拦下（子进程单独日志，不污染主 escapeLog） */
  try {
    const se = { ...process.env, BW_ESCAPE_LOG: selftestLog }
    delete se.NODE_OPTIONS
    const g = spawnSync(process.execPath, ['--import', guardUrl, '-e',
      'fetch("https://example.invalid/c529-guard").catch(()=>{})'],
      { env: se, encoding: 'utf8', timeout: 30000 })
    const line = readFileSync(selftestLog, 'utf8').trim()
    out.hermetic.guardFired = line.length > 0 && g.status !== 0
  } catch { out.hermetic.guardFired = false }

  /** hermetic 汇总：逃逸日志、mock 命中、playurl 是否真下载 */
  try { out.hermetic.escapeLines = readFileSync(escapeLog, 'utf8').split('\n').filter(Boolean).length } catch {}
  try {
    const hits = mock.hits()
    out.hermetic.mockHits = hits.length
    out.hermetic.playurlHits = hits.filter((h) => String(h.path).includes('/x/player/playurl')).length
  } catch {}
} catch (e) {
  out.fatal = (out.fatal ? out.fatal + ' | ' : '') + 'setup: ' + String(e && e.message ? e.message : e)
} finally {
  try { if (mock) await mock.close() } catch {}
  try { rmSync(temp, { recursive: true, force: true }) } catch {}
  out.hermetic.tempCleaned = !existsSync(temp)
}

// ④ 纯函数直调
try {
  const m = await import(pathToFileURL(SHEETPLAN).href)
  const ok = m.sheetPlan({ grid: '3x3' })
  out.pure.legal = { n: ok && ok.n }
  for (const g of BAD) {
    const parsed = m.parseGrid(g)
    try {
      m.sheetPlan({ grid: g })
      out.pure.bad[g] = { parsed, threw: false }
    } catch (e) { out.pure.bad[g] = { parsed, threw: true, msg: String(e && e.message ? e.message : e).slice(0, 120) } }
  }
} catch (e) { out.fatal = (out.fatal ? out.fatal + ' | ' : '') + 'pure: ' + String(e && e.message ? e.message : e) }

console.log('C529_JSON=' + JSON.stringify(out))
