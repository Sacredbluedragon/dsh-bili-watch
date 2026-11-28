/**
 * 1740-DSH 任务 B：sub 最小试做取证。
 * 复用任务 A 的凭证隔离（BILI_WATCH_DEPS 指临时 deps + 合成凭证 + guard + mock），
 * 只测 sub；CLI 截断与宿主处理各自沿用现行行为，不搬公共层。
 *
 * 覆盖：B-1 范围/B-2 指路文案实取全文/B-3 --out 四样/B-4 结构化字节标记对照/
 *       B-5 empty:true 可达性/B-6 search 消费者盘点/B-7 退役路径复跑。
 * 出口字段白名单；跑完 rmSync；只读产品代码、不碰真凭证、不 push/tag/publish。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const INDEX = join(ROOT, 'index.js')
const MOCK_BV = 'BV1mock00001'
const SYNTH = 'a'.repeat(32)
const SYNTH_CRED = JSON.stringify({ sessdata: SYNTH, bili_jct: 'b'.repeat(32), buvid3: 'cccc', buvid4: 'dddd' })
const sha256 = (s) => createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(String(s ?? ''), 'utf8')).digest('hex')
const digest = (p) => { try { return { bytes: statSync(p).size, sha256: sha256(readFileSync(p)) } } catch (e) { return { error: String(e.message || e) } } }
const clip = (s, n = 600) => { const t = String(s ?? ''); return t.length <= n ? t : t.slice(0, n) + `…[总长${t.length}字]` }

const { startMockBili } = await import(pathToFileURL(join(HERE, 'bili-mock.mjs')).href)

const temp = mkdtempSync(join(tmpdir(), 'bw-submin-'))
const cache = join(temp, 'cache'), home = join(temp, 'home'), deps = join(temp, 'deps')
const outDir = join(temp, 'out'), escapeLog = join(temp, 'escape.jsonl'), guardFile = join(temp, 'guard.mjs')
for (const d of [cache, home, deps, outDir]) mkdirSync(d, { recursive: true })
writeFileSync(join(cache, '.bili-watch-root'), '')
writeFileSync(escapeLog, '')
writeFileSync(join(deps, 'credential.json'), SYNTH_CRED, 'utf8') // 合成凭证

const guardSrc = [
  "import { appendFileSync } from 'node:fs'",
  "const PORT = process.env.BW_MOCK_PORT || ''",
  "const ESC = process.env.BW_ESCAPE_LOG || ''",
  "const HOSTS = new Set(['api.bilibili.com','passport.bilibili.com','comment.bilibili.com','i0.hdslb.com'])",
  "const real = globalThis.fetch",
  "function esc(url) { try { if (ESC) appendFileSync(ESC, url + '\\n') } catch {} }",
  "globalThis.fetch = function(input, init) {",
  "  const raw = typeof input === 'string' ? input : String(input && input.url ? input.url : input)",
  "  let u; try { u = new URL(raw) } catch { esc(raw); throw new Error('guard: url unparsable') }",
  "  if (HOSTS.has(u.hostname)) { if (!PORT) { esc(raw); throw new Error('guard: no port') } return real('http://127.0.0.1:' + PORT + '/' + u.hostname + u.pathname + u.search, init) }",
  "  if (['127.0.0.1','localhost','::1'].includes(u.hostname)) return real(input, init)",
  "  esc(raw); throw new Error('guard: external blocked ' + u.hostname)",
  "}",
].join('\n') + '\n'
writeFileSync(guardFile, guardSrc)

const baseEnv = { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(guardFile).href, BW_ESCAPE_LOG: escapeLog,
  BILI_WATCH_CACHE: cache, DSH_HOME: home, BILI_WATCH_DEPS: deps }
for (const k of ['BILI_WATCH_PROJ']) delete baseEnv[k]
// 宿主 execute 在当前进程跑、其内部 lookup 又 spawnSync 子进程，二者都读 process.env →
// 把隔离环境 assign 到主进程（与 1602 probe.mjs 同款），否则 index.js 顶层 DEPS 与 host 子进程拿不到 mock。
Object.assign(process.env, baseEnv)
const setPort = (mock) => { process.env.BW_MOCK_PORT = String(mock.port) }
const clearPort = () => { delete process.env.BW_MOCK_PORT }

const runCLI = (args, env) => {
  // 批次传入的 mock 端口同步到主进程 env：宿主 execute 在当前进程跑、其内部 look 子进程也读 process.env
  if (env && env.BW_MOCK_PORT) process.env.BW_MOCK_PORT = env.BW_MOCK_PORT
  const r = spawnSync(process.execPath, [LOOK, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env },
  })
  return { rc: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
let tool = null
async function ensureTool() {
  if (tool) return tool
  const captured = []
  const ctx = { logger: { warn() {}, info() {}, error() {} }, commands: { register() {} }, on() {},
    get(n) { return n === 'tools' ? { register(t) { captured.push(t) } } : { register() {} } },
    effect(fn) { return fn() }, webServer: { register() { return () => {} } } }
  const mod = await import(pathToFileURL(INDEX).href + '?submin=' + Date.now())
  mod.apply(ctx)
  tool = captured.find((t) => t && t.name === 'bili_watch')
  if (!tool) throw new Error('未捕获 bili_watch')
  return tool
}
const runHost = async (args) => {
  const t = await ensureTool()
  try {
    const r = await t.execute({ command: 'sub', bv: MOCK_BV, ...args }, {})
    const txt = String((r && r.text) || '')
    return { ok: !!(r && r.ok), textLen: txt.length, text: clip(txt),
      hasSourceTag: txt.includes('[source:'), hasFence: txt.includes('```'),
      hasTailOf: /只回了前|已整体落盘|全文已存/.test(txt),
      sha256: sha256(txt) }
  } catch (e) { return { threw: String(e.message || e) } }
}
const whitelistHits = (hits) => hits.map(({ host, path, query }) => ({ host, path, query }))

const R = { meta: { task: '1740-DSH sub 最小试做', at: new Date().toISOString(), head: 'WORKTREE@4149f91', version: '0.4.19' }, B1: {}, B2: {}, B3: {}, B4: {}, B6: {}, B7: {} }
let mock = null
try {
  // ===== B-1/B-4：短字幕，CLI 五格式 + 宿主三形态（B-1 范围/B-4 结构化字节标记对照）=====
  mock = await startMockBili()
  const env = { BW_MOCK_PORT: String(mock.port) }
  R.B1.cli = {}
  for (const fmt of ['text', 'json', 'srt', 'md', 'txt']) {
    const args = fmt === 'text' ? ['sub', MOCK_BV] : ['sub', MOCK_BV, '--format', fmt]
    const r = runCLI(args, env)
    R.B1.cli[fmt] = { rc: r.rc, stdoutSha: sha256(r.stdout), stdout: clip(r.stdout), stderr: clip(r.stderr, 300) }
  }
  R.B4.host = {}
  for (const k of ['无format', 'json', 'srt']) {
    const args = k === '无format' ? {} : { format: k }
    R.B4.host[k] = await runHost(args)
  }
  R.B1.hits = whitelistHits(mock.hits())
  await mock.close(); mock = null

  // ===== B-3：--out 四格式，验 rc=0/正文写入/确认走stderr/stdout空 =====
  mock = await startMockBili()
  const env2 = { BW_MOCK_PORT: String(mock.port) }
  R.B3 = {}
  for (const fmt of ['srt', 'json', 'md', 'txt']) {
    const f = join(outDir, `sub-out.${fmt}`)
    const r = runCLI(['sub', MOCK_BV, '--format', fmt, '--out', f], env2)
    R.B3[fmt] = { rc: r.rc, stdoutEmpty: r.stdout === '', stdoutSha: sha256(r.stdout),
      confirmInStderr: /✓ 已写入/.test(r.stderr), stderr: clip(r.stderr, 300),
      landed: existsSync(f) ? { path: f.replace(temp, '<TEMP>'), ...digest(f) } : { missing: true } }
  }
  await mock.close(); mock = null

  // ===== B-2：长字幕 → 截断指路 → 真按指引 read wrapped 拿全文 =====
  mock = await startMockBili({ subtitleText: '这是一段可复放的离线字幕测试文案' })
  const env3 = { BW_MOCK_PORT: String(mock.port) }
  const trunc = runCLI(['sub', MOCK_BV], env3)
  const readHint = (trunc.stdout.match(/read (.+?) 拿全文/) || [])[1] || ''
  const fullRun = runCLI(['sub', MOCK_BV, '--full'], env3)
  const LAST = '这是一段可复放的离线字幕测试文案（第 30 段）'
  let wrapped = { hint: readHint.replace(temp, '<TEMP>'), referenced: !!readHint, exists: false }
  if (readHint) {
    const p = readHint.trim()
    wrapped.exists = existsSync(p)
    if (wrapped.exists) {
      const body = readFileSync(p, 'utf8')
      wrapped.bytes = Buffer.byteLength(body)
      wrapped.containsLast = body.includes(LAST)
      wrapped.segmentCount = (body.match(/这是一段可复放的离线字幕测试文案（第 \d+ 段）/g) || []).length
      wrapped.sha256 = sha256(body)
    }
  }
  // 1814-DSH 任务 B：sameFullByRead 从「段数+末段」加强到逐段逐字比较。
  // 剥法：正文行形如 `[mm:ss] <文案>`，两端都只取带时间戳的正文行（外层 source tag/围栏/
  //   「视频:」「字幕取到了」「全文已存」「read 指引」「[sub] 全文 N 字」等标头全部剥掉）。
  const TIME_CUE = /^\[\d{2}:\d{2}\]\s/
  const bodySegments = (s) => s.split('\n').filter((l) => TIME_CUE.test(l)).map((l) => l.trim())
  const wrappedBody = wrapped.exists ? bodySegments(readFileSync(readHint.trim(), 'utf8')) : []
  const fullBody = bodySegments(fullRun.stdout)
  const perIndexDiff = []
  const n = Math.max(wrappedBody.length, fullBody.length)
  for (let i = 0; i < n; i++) {
    if (wrappedBody[i] !== fullBody[i]) perIndexDiff.push({ i, wrapped: wrappedBody[i] ?? null, full: fullBody[i] ?? null })
  }
  R.B2 = { cliTruncated: trunc.stdout.includes('只给开头'), cliHasHint: !!readHint,
    fullHasLast: fullRun.stdout.includes(LAST),
    fullSegmentCount: fullBody.length,
    wrapped,
    compare: { stripRule: '只取 ^[mm:ss] 正文行，剥 source tag/围栏/标头/指引/全文行',
      wrappedSegments: wrappedBody.length, fullSegments: fullBody.length,
      wrappedBodySha: sha256(wrappedBody.join('\n')), fullBodySha: sha256(fullBody.join('\n')),
      perIndexDiffCount: perIndexDiff.length, perIndexDiff: perIndexDiff.slice(0, 5) },
    // 逐段逐字全等才算签收指路：段数相同、每一段字节相同、含末段
    sameFullByRead: wrapped.exists && wrappedBody.length === 30 && fullBody.length === 30 &&
      perIndexDiff.length === 0 && wrappedBody[29] === fullBody[29] && wrappedBody[29] === `[01:56] ${LAST}` }
  await mock.close(); mock = null

  // ===== B-5：empty:true 可达性已由 C536 覆盖（1849-DSH 清理）=====
  // 旧段用两种 variant 都只调 startMockBili() 不传参、跑同一命令，冒充不同输入（空 body / 空白 content）
  // 实际都是默认两句正常字幕，emptyTrue:false，属空转取证，已删。
  // 两种真对照统一引用 C536（tools/fixtures/sub-empty-probe.mjs）：
  //   纯空白轨 → rc=0 / empty:true / reason='subtitle-track-empty' / cues:[]；无轨 → rc=1。

  // ===== B-6：search 消费者盘点——静态 grep + 真跑 search 输出形态 =====
  const lookSrc = readFileSync(LOOK, 'utf8')
  const cmdSearchBody = lookSrc.slice(lookSrc.indexOf('async function cmdSearch'), lookSrc.indexOf('async function cmdSearch') + 2500)
  R.B6 = {
    cmdSearch: 'tools/look.mjs:2063',
    searchUsesPrintText: /printText\s*\(/.test(cmdSearchBody),
    searchUsesFmtSec: /fmtSec\s*\(/.test(cmdSearchBody),
    searchUsesFmtSearchDuration: /fmtSearchDuration\s*\(/.test(cmdSearchBody),
    searchUsesCuesToTxt: /cuesToTxt\s*\(/.test(cmdSearchBody),
    usesDecorateData: /decorateData\s*\(/.test(cmdSearchBody),
  }
  mock = await startMockBili()
  const rs = runCLI(['search', '夹具关键词'], { BW_MOCK_PORT: String(mock.port) })
  R.B6.live = { rc: rs.rc, stdout: clip(rs.stdout, 500), stdoutSha: sha256(rs.stdout), stderr: clip(rs.stderr, 300) }
  await mock.close(); mock = null

  R.escapeLogText = readFileSync(escapeLog, 'utf8')
  R.ok = true
} catch (e) {
  R.fatal = String(e && e.stack ? e.stack : e)
} finally {
  if (mock) await mock.close().catch(() => {})
  rmSync(temp, { recursive: true, force: true })
}

console.log('SUBMIN_JSON=' + JSON.stringify(R))
