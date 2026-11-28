/**
 * 1814-DSH 任务 A：保住纯空白轨现行行为（empty:true）离线端到端判据。
 *
 * 现行入口可构造输入：lib/bili-api.mjs:408-413 的 fetchSubtitle 对 join 后 text 判真值，
 * 纯空白串（'   '）非假值→放行；tools/look.mjs:1683 再按 trim 判可用正文→usable=0→
 * cmdSub:1684-1695 返回 rc=0、payload {empty:true, reason:'subtitle-track-empty', cues:[]}。
 *
 * 本夹具走真实 fetchSubtitle + 真实 `sub --format json` 子进程断言四样；
 * 用无轨（subtitleOff）rc=1 做对照；沿用合成凭证 + BILI_WATCH_DEPS 临时 deps 隔离；
 * 出口白名单只留 host/path/query；跑完 rmSync。标题写「保住现行行为」不写「修复」。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const MOCK_BV = 'BV1mock00001'
const SYNTH = 'a'.repeat(32)
const SYNTH_CRED = JSON.stringify({ sessdata: SYNTH, bili_jct: 'b'.repeat(32), buvid3: 'cccc', buvid4: 'dddd' })
const sha256 = (s) => createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(String(s ?? ''), 'utf8')).digest('hex')
const clip = (s, n = 500) => { const t = String(s ?? ''); return t.length <= n ? t : t.slice(0, n) + `…[总长${t.length}字]` }

const { startMockBili } = await import(pathToFileURL(join(HERE, 'bili-mock.mjs')).href)

const temp = mkdtempSync(join(tmpdir(), 'bw-subempty-'))
const cache = join(temp, 'cache'), home = join(temp, 'home'), deps = join(temp, 'deps')
const escapeLog = join(temp, 'escape.jsonl'), guardFile = join(temp, 'guard.mjs')
for (const d of [cache, home, deps]) mkdirSync(d, { recursive: true })
writeFileSync(join(cache, '.bili-watch-root'), '')
writeFileSync(escapeLog, '')
writeFileSync(join(deps, 'credential.json'), SYNTH_CRED, 'utf8')

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

// 纯空白 cue：join('') 得非空串（fetchSubtitle:409 放行），trim 后全空（cmdSub:1683 usable=0）。
const BLANK_CUES = [
  { from: 0, to: 2.5, content: '   ' },
  { from: 2.5, to: 5, content: '\t' },
  { from: 5, to: 7.5, content: '　' }, // 全角空格，仍 trim 为空
]

const runCLI = (args, extraEnv) => {
  const r = spawnSync(process.execPath, [LOOK, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: { ...baseEnv, ...extraEnv },
  })
  return { rc: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

const R = { meta: { task: '1814-DSH 保住纯空白轨现行行为 empty:true', at: new Date().toISOString(), version: '0.4.19' } }
let mock = null
try {
  // ===== 纯空白 cue → empty:true 四样断言 =====
  mock = await startMockBili({ subtitleRawCues: BLANK_CUES })
  const r = runCLI(['sub', MOCK_BV, '--format', 'json'], { BW_MOCK_PORT: String(mock.port) })
  const stdout = String(r.stdout || '')
  let payload = null
  try { payload = JSON.parse(stdout) } catch { /* 留空 */ }
  R.blank = {
    rc: r.rc,
    hasEmptyTrue: payload ? payload.empty === true : false,
    reason: payload ? payload.reason : null,
    cuesIsEmptyArray: payload ? Array.isArray(payload.cues) && payload.cues.length === 0 : false,
    stdoutSha: sha256(stdout),
    stdout: clip(stdout),
    stderr: clip(r.stderr, 300),
  }
  // 出口白名单：只留 host/path/query，不漏合成凭证值 / cookie 字段
  R.blank.hits = mock.hits().map(({ host, path, query }) => ({ host, path, query }))
  R.blank.noSynthValueInOutput = !stdout.includes(SYNTH)
  R.blank.noCookieFieldInOutput = !/cookie/i.test(stdout)
  await mock.close(); mock = null

  // ===== 无轨对照：subtitleOff → fetchSubtitle ok:false → cmdSub:1669 失败 rc=1 =====
  mock = await startMockBili({ subtitleOff: true })
  const rOff = runCLI(['sub', MOCK_BV, '--format', 'json'], { BW_MOCK_PORT: String(mock.port) })
  R.offTrack = {
    rc: rOff.rc,
    whyNoTrack: /字幕取不到/.test(String(rOff.stdout || '') + String(rOff.stderr || '')),
    notEmptyTrue: !/"empty"\s*:\s*true/.test(String(rOff.stdout || '')),
    stdout: clip(rOff.stdout, 300),
    stderr: clip(rOff.stderr, 300),
  }
  await mock.close(); mock = null

  R.escapeLogText = readFileSync(escapeLog, 'utf8')
  R.fatal = null
  R.ok = true
} catch (e) {
  R.fatal = String(e && e.stack ? e.stack : e)
} finally {
  if (mock) await mock.close().catch(() => {})
  rmSync(temp, { recursive: true, force: true })
}

console.log('SUBEMPTY_JSON=' + JSON.stringify(R))
