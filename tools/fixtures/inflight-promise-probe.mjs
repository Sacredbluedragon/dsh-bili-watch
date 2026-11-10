// 三处在飞 Promise 的 finally 自判：窄窗口竞态的真跑夹具。
//
// 不 import index.js（它要 qrcode / 真目录 / 真配置），也不靠文本正则判「代码写了什么」。
// 做法是把三个函数**原样**抠进 VM，桩掉外部依赖，用可控 deferred 造出这个顺序：
//   A 起（在飞） → 清缓存（在飞记录置 null + seq++） → B 起 → A 先完成 → 检查 B 的记录还在不在。
// 无条件 finally 会在 A 完成时把 B 的记录清掉，于是接下来的并发调用重复起第三个进程。
// 反向能力：正常运行（没有清缓存插进来）时，B 完成后记录必须被清掉，否则以后永远复用旧 promise。
//
// 输出一行 JSON：defect / capability / notes。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const src = readFileSync(join(ROOT, 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const report = { fatal: null, defect: {}, capability: {}, notes: {} }
const d = report.defect
const c = report.capability

// 按起止标记原样切函数体；切不到就 fatal，不许静默跳过。
const cut = (startMark, endMark) => {
  const a = src.indexOf(startMark)
  const b = a >= 0 ? src.indexOf(endMark, a) : -1
  return a >= 0 && b > a ? src.slice(a, b) : ''
}
const ffmpegFn = cut('async function resolveFfmpeg() {', 'function hfHomes()')
const ytdlpFn = cut('async function ytdlpVersion() {', '// 第十条')
const gpuFn = cut('function gpuStatus(fresh) {', '/** execFile 的 Promise 版')

// 每个 case 独立 VM，变量互不干扰。stub 用数组 join 拼，
//   避免外层模板字符串把 index.js 原样函数体里的 ${} 当成插值。
const CASES = [
  { key: 'ffmpeg', fn: 'resolveFfmpeg()', body: ffmpegFn, flight: '_ffmpegProbePromise',
    clear: '_ffmpegProbePromise = null\n  _ffmpegProbeSeq++',
    value: '{ ok: true, stdout: "2026.01.01" }' },
  { key: 'ytdlp', fn: 'ytdlpVersion()', body: ytdlpFn, flight: '_ytdlpVerPromise',
    clear: '_ytdlpVerPromise = null',
    value: '{ ok: true, stdout: "2026.01.01" }' },
  { key: 'gpu', fn: 'gpuStatus(false)', body: gpuFn, flight: '_probePromise',
    clear: '_probePromise = null\n  _gpuSeq++',
    value: '{ val: { deviceCount: 1 }, confident: true }' },
]

const runCase = (spec) => {
  const stub = [
    'globalThis.__now = 0',
    'globalThis.__stamp = 0',
    'globalThis.__defers = []',
    'const Date = { now: () => { globalThis.__now += 1000000000; return globalThis.__now } }',
    'const DEPS = "/stub"',
    'const join = (...a) => a.join("/")',
    'const process = { platform: "linux" }',
    'const existsSync = () => true',
    'const statSync = () => { globalThis.__stamp += 1; return { size: 1, mtimeMs: globalThis.__stamp } }',
    'const ffmpegCands = () => ["ffmpeg"]',
    'const gpuCacheHit = () => false',
    'const GPU_CACHE_MS = 300000',
    'const nextGpuCache = (cache, res) => (res && res.confident === true && res.val) ? { at: 1, val: res.val } : cache',
    'let ffmpegProbeCache = { at: 0, path: "" }',
    'let _ffmpegProbePromise = null',
    'let _ffmpegProbeSeq = 0',
    'let ytdlpVerCache = { key: "", ver: "" }',
    'let _ytdlpVerPromise = null',
    'let _gpuCache = { at: 0, val: null }',
    'let _probePromise = null',
    'let _gpuSeq = 0',
    'const __mk = () => {',
    '  let resolve',
    '  const promise = new Promise((r) => { resolve = r })',
    '  globalThis.__defers.push({ promise, resolve })',
    '  return promise',
    '}',
    'const execFileP = () => __mk()',
    'const probeGpu = () => __mk()',
    'globalThis.__resolve = (i, v) => globalThis.__defers[i].resolve(v)',
    spec.body,
    // 注意：resolveFfmpeg / ytdlpVersion 是 async 函数，调用返回值是**被 async 包装过一层**的
    //   promise，不等于模块内部的在飞记录。必须直接读记录变量来比，否则这两条永远假红。
    'globalThis.__go = async () => {',
    `  const a = ${spec.fn}`,
    `  const aRecord = ${spec.flight}`,
    '  const aActive = aRecord !== null',
    `  ${spec.clear}`,
    `  const b = ${spec.fn}`,
    `  const bRecord = ${spec.flight}`,
    '  const bIsNew = bRecord !== null && bRecord !== aRecord',
    `  globalThis.__resolve(0, ${spec.value})`,
    '  await a',
    `  const stillB = (${spec.flight} === bRecord)`,
    `  const third = ${spec.fn}`,
    '  const noExtraProbe = globalThis.__defers.length === 2',
    '  const thirdIsB = third === b',
    `  globalThis.__resolve(1, ${spec.value})`,
    '  await b',
    `  const cleared = (${spec.flight} === null)`,
    '  return { aActive, bIsNew, stillB, noExtraProbe, thirdIsB, cleared, calls: globalThis.__defers.length }',
    '}',
  ].join('\n')
  // C227-B：切出来的 index.js 函数体会调 isWin()；补真值，保持平台分支可测。
  const ctx = vm.createContext({ Promise, Error, String, Math, JSON, isWin: () => process.platform === 'win32', isMac: () => process.platform === 'darwin', hostPlatform: () => process.platform })
  vm.runInContext(stub, ctx, { timeout: 5000 })
  return ctx.__go()
}

try {
  report.notes.bodies = { ffmpeg: ffmpegFn.length, ytdlp: ytdlpFn.length, gpu: gpuFn.length }
  if (!ffmpegFn || !ytdlpFn || !gpuFn) {
    report.fatal = 'index.js 里三处函数体有切不到的：' + JSON.stringify(report.notes.bodies)
  }

  // 词法辅助：三处 finally 都必须带「判自身」。（主判据是下面的 VM 真跑）
  const selfChecks = ['_ffmpegProbePromise', '_ytdlpVerPromise', '_probePromise'].filter((v) =>
    new RegExp(`\\.finally\\(\\(\\) => \\{ if \\(${v} === p\\) ${v} = null \\}`).test(src)).length
  report.notes.selfChecks = selfChecks
  c.C187_lexicalSelfCheck = selfChecks === 3

  if (!report.fatal) {
    const rows = {}
    for (const spec of CASES) rows[spec.key] = await runCase(spec)
    report.notes.rows = rows
    for (const k of ['ffmpeg', 'ytdlp', 'gpu']) {
      const r = rows[k]
      const name = 'C187_' + k + 'OldFinallyNotClearNew'
      d[name] = Boolean(r.aActive && r.bIsNew && r.stillB && r.noExtraProbe)
    }
    c.C187_normalClearsAfterDone = CASES.every((s) => rows[s.key].cleared === true)
    c.C187_noExtraProbe = CASES.every((s) => rows[s.key].calls === 2)
  }
} catch (e) {
  report.fatal = String(e?.stack || e).slice(0, 600)
}

console.log(JSON.stringify(report))
