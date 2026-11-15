/**
 * C383/C384/C385 取证：工具层 schema / execute 透传 / 三档截断。
 *   纪律同 c341-five-probes：被测的是**原样源码**（真抠函数体在桩环境真跑、真起 CLI），
 *   不是把源码当字符串找子串。结论交给 tools/verify.mjs 的三条判据。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const IDX = join(ROOT, 'index.js')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const PRELOAD = pathToFileURL(join(HERE, 'bili-mock-preload.mjs')).href
const BV = 'BV1c38200001'
const src = readFileSync(IDX, 'utf8')

// ── F：schema description / CLI 警告 / accepts ───────────────────────────
const schemaText = src.slice(src.indexOf('    parameters: {'), src.indexOf('    output: {'))
const descOf = (key) => (new RegExp(`${key}:\\s*\\{[\\s\\S]*?description:\\s*'([^']*)'`).exec(schemaText) || [])[1] || ''
const numInSchema = /\bnum:\s*\{/.test(schemaText)
const paramsSrc = readFileSync(join(ROOT, 'lib', 'params.mjs'), 'utf8')
const acceptsM = /comments:\s*\{[\s\S]*?accepts:\s*\[([^\]]*)\]/.exec(paramsSrc)
const accepts = acceptsM ? acceptsM[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : []
const lookSrc = readFileSync(LOOK, 'utf8')
const warnText = lookSrc.slice(lookSrc.indexOf('const UNACCEPTED = unacceptedFlags'), lookSrc.indexOf('const HELP ='))

// ── G：execute 的 extra / positionals 与 lookup 的 argv 拼接，全是源码原样段 ──
const extraA = src.indexOf('      const extra = []')
const extraB = src.indexOf("      if (args.command === 'hot')", extraA)
const posA = src.indexOf('      // 0.4.12 G：')
const posB = src.indexOf('      const r = await lookup(', posA)
if ([extraA, extraB, posA, posB].some((x) => x < 0)) throw new Error('index.js 的 execute 抽取点变了')
const extraFor = (args) => new Function('args', src.slice(extraA, extraB) + '\nreturn extra')(args)
const positionalsFor = (args) => new Function('args', src.slice(posA, posB) + '\nreturn positionals')(args)
const lookupFn = src.indexOf('async function lookup(')
const lookupA = src.indexOf('  const args =', lookupFn < 0 ? 0 : lookupFn)
const lookupB = src.indexOf('  const r = await runLook(args', lookupA)
if (lookupA < 0 || lookupB < 0) throw new Error('index.js 的 lookup 抽取点变了')
const argsFor = (command, bv, positionals, extra) =>
  new Function('command', 'bv', 'positionals', 'extra', src.slice(lookupA, lookupB) + '\nreturn args')(command, bv, positionals, extra)
const buildArgv = (args) => {
  const extra = extraFor(args)
  const positionals = positionalsFor(args)
  return argsFor('comments', args.bv, positionals, extra)
}
const withNum = buildArgv({ command: 'comments', bv: BV, num: 3, format: 'json' })
const withoutNum = buildArgv({ command: 'comments', bv: BV, format: 'json' })

// ── G：用工具层拼出来的 argv 真跑 CLI（many 桩给 12 条顶层）────────────────
const tmp = mkdtempSync(join(tmpdir(), 'bw-c383-'))
const home = join(tmp, 'home'); const deps = join(tmp, 'deps'); const cache = join(tmp, 'cache')
for (const d of [home, deps, cache]) mkdirSync(d, { recursive: true })
const worker = new Worker(new URL('./c382-render-worker.mjs', import.meta.url), { workerData: { variant: 'many' } })
const port = await new Promise((resolve, reject) => { worker.once('message', (m) => resolve(m.port)); worker.once('error', reject) })
const env = { ...process.env }
for (const k of ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME', 'BILI_WATCH_FFMPEG']) delete env[k]
Object.assign(env, { BW_MOCK_PORT: String(port), DSH_HOME: home, BILI_WATCH_DEPS: deps, BILI_WATCH_CACHE: cache })
const runArgv = (argv) => {
  const r = spawnSync(process.execPath, ['--import', PRELOAD, LOOK, ...argv], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  })
  let payload = null
  try { payload = JSON.parse((r.stdout || '').trim()) } catch {}
  return { status: r.status, items: Array.isArray(payload?.items) ? payload.items.length : -1, stdout: (r.stdout || '').slice(0, 200), stderr: (r.stderr || '').slice(0, 200) }
}
const numRun = runArgv(withNum)
const defaultRun = runArgv(withoutNum)
await worker.terminate()

// ── C385：trimForModel 三档，原样函数体在桩环境真跑 ──────────────────────
function fnBody(s, name) {
  const lines = s.split('\n')
  const re = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const start = lines.findIndex((l) => re.test(l) && !/^\s*(?:\/\/|\*)/.test(l))
  if (start < 0) throw new Error(`找不到 function ${name}`)
  let end = -1
  for (let i = start + 1; i < lines.length; i++) if (/^\}/.test(lines[i])) { end = i; break }
  if (end < 0) throw new Error(`${name} 没有行首闭合括号`)
  const body = lines.slice(start, end + 1).join('\n')
  new Function(`return (${body})`)
  return body
}
function runOriginal(names, overrides, prelude = '') {
  const keys = Object.keys(overrides)
  const body = `${prelude}\n${names.map((n) => fnBody(src, n)).join('\n')}\nreturn { ${names.join(', ')} }`
  return new Function(...keys, body)(...keys.map((k) => overrides[k]))
}
const tierDir = join(tmp, 'tiers')
mkdirSync(tierDir, { recursive: true })
const { trimForModel } = runOriginal(['trimForModel'], {
  videoDir: () => tierDir,
  join, writeFileSync,
  readTuning: () => ({ toolTextCap: 100, toolHead: 50 }),
  toolTextCap: () => 100,
  toolTextHead: () => 50,
  cutCp: (s, n) => String(s).slice(0, n),
  TOOL_FILE_SEQ: 0,
})
const short = String(trimForModel('A'.repeat(50), 'out', BV, false, {}))
const textLong = String(trimForModel('B'.repeat(500), 'out', BV, false, {}))
const jsonLong = String(trimForModel('{"k":"' + 'C'.repeat(500) + '"}', 'out', BV, true, {}))
const fullLong = String(trimForModel('D'.repeat(500), 'out', BV, false, { full: true }))
const files = readdirSync(tierDir)
const capLine = /const cap = full \? 20000 : toolTextCap\(\)/.test(src)
const helpAt = lookSrc.indexOf('const HELP = `')
const helpText = helpAt < 0 ? '' : lookSrc.slice(helpAt, helpAt + 9000)
const hasFullLine = /comments <BV或链接> \[条数\] \[--full\]/.test(helpText)
const twoLayer = /comments 的 --full/.test(helpText) && /命令行不截断/.test(helpText)
try { rmSync(tmp, { recursive: true, force: true }) } catch {}

process.stdout.write(JSON.stringify({
  schema: { numInSchema, headDesc: descOf('head'), fullDesc: descOf('full') },
  argv: { withNum, withoutNum, numRun, defaultRun },
  params: { accepts, hasFull: accepts.includes('full') },
  warnText,
  help: { hasFullLine, twoLayer },
  tiers: { short, textLong, jsonLong, fullLong, files, capLine },
}))
