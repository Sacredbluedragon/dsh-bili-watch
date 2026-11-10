// C220/A·B6：frames / ocr / sheet / substrip 的 --format json 新出口。
// 四层取证：
//   ① 真 lib/command-json.mjs 对四个 source 各跑一次，验 json 形状与散文收集；
//   ② 四条 cmd 函数体原样切出在 vm 里跑（桩掉 IO/网络），验「命令真的自报了结果 + 散文照打」；
//   ③ 真 CLI `sheet --dry-run --format json` 与散文版逐字节对照（全程离线）；
//   ④ 静态守卫：分派链 / 参数表 / HELP 三处都接上了 format。
// 行为断言用的字段都在前三层产出，静态守卫放最后 —— 扰动时红在「没输出/没结果」，不是红在锚点。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { runCommandJson } from '../../lib/command-json.mjs'
// C231：cmd 函数体里新增的两个落点 helper 是模块级自由变量，vm 切片跑不到定义，
//   补的是**真 lib 实现**（无配置时与旧路径逐字节相同），不是恒值假桩、也不放宽任何断言。
import { pictureOutPath, textOutPath } from '../../lib/default-out.mjs'
// C232：cmdFrames / cmdOcr 函数体新增的两个成本 helper，同样补真 lib 实现。
import { costOf, costProse } from '../../lib/cost-line.mjs'
// C233：cmdSheet 新增的 token 预算 helper，同样补真 lib 实现。
import { budgetWarnLine, tokenEstimateLine } from '../../lib/sheet-token.mjs'
const norm = (p) => String(p).replace(/\\/g, '/')

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const look = join(root, 'tools', 'look.mjs')
const src = readFileSync(look, 'utf8')
const paramsSrc = readFileSync(join(root, 'lib', 'params.mjs'), 'utf8')
const BV = 'BV19dJQ6sE9F'
const SOURCES = ['frames', 'ocr', 'sheet', 'substrip']
const V = { title: '测试标题', owner: '测试UP', dur: 123, p: 1, pages: 2 }

// ── ① 真 lib：四个 source 各一次 ────────────────────────────────────────────
const lib = {}
const origWrite = process.stdout.write
const origLog = console.log
let captured = ''
// 非 json 模式：不许碰 stdout，也不许吞掉散文
const textProse = []
console.log = (...a) => textProse.push(a.map(String).join(' '))
const textModeReturn = await runCommandJson({
  opts: { format: 'text' }, source: 'frames', bv: BV,
  fn: async () => { console.log('散文 A'); console.log('散文 B', 2) },
})
console.log = origLog
process.stdout.write = (s) => { captured += String(s); return true }
try {
  for (const source of SOURCES) {
    captured = ''
    const opts = { format: 'json', result: { marker: `from-${source}` } }
    await runCommandJson({
      opts, source, bv: BV, getVideo: async () => V,
      fn: async () => { console.log(`散文 1 · ${source}`); console.log('散文 2', source, 3) },
    })
    let j = null
    try { j = JSON.parse(captured) } catch {}
    lib[source] = {
      parseOk: !!j,
      ok: j?.ok,
      source: j?.source,
      videoKeys: j?.video ? Object.keys(j.video).sort().join(',') : '',
      videoBv: j?.video?.bv,
      prose: j?.prose || [],
      marker: j?.marker || '',
      stdoutOnlyJson: captured.trimStart().startsWith('{') && captured.trimEnd().endsWith('}'),
    }
  }
} finally {
  process.stdout.write = origWrite
}
const textMode = { returned: textModeReturn, prose: textProse }

// ── ② 四条 cmd 函数体原样切出，在 vm 里真跑 ──────────────────────────────────
/** 顶层函数的闭合是行首的 `}`，用这个锚点切整段函数（不吃函数体内的缩进行）。 */
const extractFn = (name) => {
  const mark = `async function ${name}(bv, opts = {}) {`
  const st = src.indexOf(mark)
  if (st < 0) return { code: '', length: 0, found: false }
  const en = src.indexOf('\n}\n', st)
  if (en < st) return { code: '', length: 0, found: false }
  const body = src.slice(st, en + 2)
  return { code: `${body}\n;(async () => { await ${name}(bv, opts); return opts })()`, length: body.length, found: true }
}

const makeSandbox = (opts, logs) => ({
  console: { log: (...a) => logs.push(a.map(String).join(' ')), error: () => {} },
  process: { exitCode: 0 },
  opts, bv: BV,
  join: (...a) => a.join('/'),
  basename: (p) => String(p).split('/').pop(),
  dirname: (p) => String(p).split('/').slice(0, -1).join('/'),
  cacheDir: () => '<TMP>',
  costOf: (o) => costOf(o), costProse: (c) => costProse(c),
  budgetWarnLine: (t, b) => budgetWarnLine(t, b), tokenEstimateLine: (t) => tokenEstimateLine(t),
  artifactOut: (filename, explicitOut) => norm(pictureOutPath({ cfg: {}, env: {}, cacheDir: '<TMP>', filename, explicitOut })),
  textArtifactOut: (filename, explicitOut) => norm(textOutPath({ cfg: {}, env: {}, filename, explicitOut })),
  existsSync: (p) => /-0[12]\.jpg$/.test(String(p)),
  readdirSync: () => ['x-01.jpg', 'x-02.jpg'],
  statSync: () => ({ size: 2048 }),
  mkdirSync: () => {}, rmSync: () => {}, copyFileSync: () => {}, writeFileSync: () => {},
  checkOutDir: () => {},
  grabFrames: async () => ({ dir: '<TMP>/frames', mp4: '<TMP>/frames/v.mp4', frames: 2, cached: true, times: [], sceneTh: 0 }),
  framesToShow: () => [],
  fmtIdxLine: () => 'r1c1 00:00-00:05 @00:02',
  fmtSec: (s) => String(s),
  frameSecOf: () => 5,
  ocrReady: () => true,
  runOcr: async () => ({ ok: true, text: '画面文字' }),
  printText: () => {},
  sheetFrameFiles: () => ['<TMP>/frames/x-01.jpg', '<TMP>/frames/x-02.jpg'],
  frameList: () => ['<TMP>/frames/x-01.jpg', '<TMP>/frames/x-02.jpg'],
  pickEven: (a) => a,
  tryLock: async () => ({}), unlock: () => {},
  findFfmpeg: () => 'ffmpeg', ffExec: () => {}, ffTimeoutMs: () => 1000,
  writeSheetManifest: () => '<TMP>/out.manifest.json',
  manifestLine: (p) => `格位索引: ${p}`,
  manifestPathOf: (p) => String(p).replace(/\.jpg$/, '.manifest.json'),
  sheetPlan: () => ({ lines: [] }),
  atTagOf: (s) => String(s),
  warn: () => {},
  fetchSheetCues: async () => ({ ok: false, why: '' }),
  cuesTextInRange: () => [],
  FFMPEG_HINT: 'hint', OCR_PY: '', OCR_SCRIPT: '',
})

const vmOut = {}
for (const [source, name] of [['frames', 'cmdFrames'], ['ocr', 'cmdOcr'], ['sheet', 'cmdSheet'], ['substrip', 'cmdSubstrip']]) {
  const { code, length, found } = extractFn(name)
  const logs = []
  const opts = { p: 1, step: 2, grid: '3x3', at: '' }
  let error = ''
  if (found) {
    try { await vm.runInNewContext(code, makeSandbox(opts, logs), { timeout: 3000 }) } catch (e) { error = String(e.message || e) }
  }
  vmOut[source] = {
    found, length, error,
    hasResult: !!opts.result && typeof opts.result === 'object',
    resultKeys: opts.result ? Object.keys(opts.result).sort().join(',') : '',
    logs: logs.length,
    firstLog: logs[0] || '',
  }
}

// ── ③ 真 CLI：sheet --dry-run 的 json 版 vs 散文版 ───────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'c220-'))
const env = { ...process.env, BILI_WATCH_CACHE: tmp }
const runCli = (extra) => spawnSync(process.execPath, [look, 'sheet', BV, '--dry-run', '--dur', '60', ...extra],
  { encoding: 'utf8', env, timeout: 30000 })
const plain = runCli([])
const jsonRun = runCli(['--format', 'json'])
let cli = { plainRc: plain.status, jsonRc: jsonRun.status, parseOk: false, proseEqual: false }
try {
  const j = JSON.parse(jsonRun.stdout)
  const proseLines = plain.stdout.replace(/\n$/, '').split('\n')
  cli = {
    plainRc: plain.status, jsonRc: jsonRun.status,
    parseOk: true,
    ok: j.ok, source: j.source, video: j.video, offline: j.offline, dryRun: j.dryRun,
    proseEqual: JSON.stringify(j.prose) === JSON.stringify(proseLines),
    proseLines: j.prose?.length || 0,
    plainLines: proseLines.length,
    plainText: proseLines[0] || '',
  }
} catch { /* parseOk=false 交给判据红 */ }
rmSync(tmp, { recursive: true, force: true })

// ── ④ 静态守卫（放最后） ────────────────────────────────────────────────────
const lines = src.split('\n')
const segmentOf = (cmd) => {
  const st = lines.findIndex((l) => l.includes(`} else if (cmd === '${cmd}')`))
  if (st < 0) return ''
  const en = lines.findIndex((l, i) => i > st && /^\s*\} else if \(cmd ===/.test(l))
  return lines.slice(st, en > st ? en : st + 12).join('\n')
}
const helpAt = src.indexOf('const HELP = `')
const helpEnd = src.indexOf('`', helpAt + 'const HELP = `'.length)
const help = helpAt >= 0 ? src.slice(helpAt, helpEnd) : ''
const stat = {}
for (const c of SOURCES) {
  const seg = segmentOf(c)
  const fnName = 'cmd' + c[0].toUpperCase() + c.slice(1)
  stat[c] = {
    passesFormat: /format:\s*opt\('format'\)/.test(seg),
    usesWrapper: seg.includes('runCommandJson({') && seg.includes(`source: '${c}'`),
    fnReportsResult: src.includes(`opts.result = {`) && new RegExp(`async function ${fnName}\\(`).test(src),
    acceptsFormat: new RegExp(`${c}:\\s*\\{[\\s\\S]{0,300}?accepts:[^\\n]*'format'`).test(paramsSrc),
    overridesJson: new RegExp(`${c}:\\s*\\{[\\s\\S]{0,300}?overrides:[^\\n]*\\['text', 'json'\\]`).test(paramsSrc),
    helpHasFormat: new RegExp(`node look\\.mjs ${c} [^\\n]*--format json`).test(help),
  }
}
// 四条 cmd 函数体里「自报结果」的行数（每条至少一处）
const resultLines = {}
for (const [c, name] of [['frames', 'cmdFrames'], ['ocr', 'cmdOcr'], ['sheet', 'cmdSheet'], ['substrip', 'cmdSubstrip']]) {
  const f = extractFn(name)
  resultLines[c] = (f.code.match(/opts\.result\s*=/g) || []).length
}

origWrite.call(process.stdout, JSON.stringify({ lib, textMode, vmOut, cli, stat, resultLines }) + '\n')
