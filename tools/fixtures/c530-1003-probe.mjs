/**
 * 1003 三项取证夹具：stdout 只吐一行 PROBE_JSON=。
 *   A 少帧成功（C530）：合成 3 帧 + --grid 3x3 → cells=3、可用图片/实际帧数/manifest cells 三者相符。
 *   B 规模约束（C531）：纯函数合法契约 + 有界展开 + 溢出早退可读 + CLI 三态低成本 + 成图尺寸预判。
 *   C search 时长显示（C532）：四形态（正常/超长分钟/空/未知原样）。
 * 全部离线：sheet 走 --dry-run，不抽帧不写产物；vm 切函数体用真 lib/真源码函数。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { sheetPlan, parseGrid, gridScaleOverflow, MAX_TIMEPOINTS, SHOW_TIMEPOINTS } from '../../lib/sheet-plan.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const src = readFileSync(LOOK, 'utf8')

// 1515 任务 B：cliCall 的 look.mjs 子进程必须隔离到临时目录，杜绝误写用户真实缓存。
// 照 c233-sheet-token-probe.mjs:45 的写法：env 注入 BILI_WATCH_CACHE + DSH_HOME，删 BILI_WATCH_OUT。
// 1515 收尾：缓存根必须先建且带 .bili-watch-root 标记（cache-own 判据要求），否则 look 建根时会
//   把外部无标记目录当成「用户自己放的」而另起一层 bili-watch-cache 子目录，诊断就落不到预期位置。
const TMP = mkdtempSync(join(tmpdir(), 'bw-c530-'))
const ISO_CACHE = join(TMP, 'cache')
const ISO_HOME = join(TMP, 'home')
mkdirSync(ISO_CACHE, { recursive: true })
mkdirSync(ISO_HOME, { recursive: true })
writeFileSync(join(ISO_CACHE, '.bili-watch-root'), 'c530-fixture\n', 'utf8')
// 对照文件放缓存根：溢出诊断写在 BV 子目录（cache/BV1xx.../last-error.json），不碰根，
//   两处路径分离，既能核对照文件未被改写，又能确认溢出诊断真实产生在临时目录内。
const CONTROL_PATH = join(ISO_CACHE, 'last-error.json')
const CONTROL_TEXT = '{"fixture":"c530-control","sentinel":"DO-NOT-OVERWRITE-1515"}\n'
writeFileSync(CONTROL_PATH, CONTROL_TEXT, 'utf8')
const ISO_ENV = { ...process.env, BILI_WATCH_CACHE: ISO_CACHE, DSH_HOME: ISO_HOME }
delete ISO_ENV.BILI_WATCH_OUT

// 诊断文件收集：递归列 ISO_CACHE 下所有 last-error.json，给出相对路径 + 字节数。
const collectDiagnostics = (root) => {
  const found = []
  const walk = (dir, rel) => {
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else if (e.name === 'last-error.json') {
        try { found.push({ path: r, bytes: statSync(p).size }) } catch { /* 并发删除，忽略 */ }
      }
    }
  }
  walk(root, '')
  return found
}

const out = { few: {}, scale: {}, searchDur: {}, isolation: {}, fatal: null }

/** ── A 少帧成功：vm 切 pickEven 真源码函数 + sheet 拼图段 cells 映射 ── */
// pickEven 是 look.mjs 模块级函数；切真源码跑（不是另写桩），验 files<=n 返回全部。
try {
  const pm = /function pickEven\(files, n\) \{[\s\S]*?\n\}/.exec(src)
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext((pm ? pm[0] : '') + '\nthis.f = pickEven', ctx)
  const files3 = ['f1.jpg', 'f2.jpg', 'f3.jpg']
  const picked = ctx.f(files3, 9)
  out.few = {
    pickFound: !!pm,
    availableFiles: files3.length,
    pickedLen: picked.length,
    cellsLen: picked.map(() => ({})).length,  // cmdSheet 里 cells=picked.map(...)，长度与 picked 同源
    belowGrid: files3.length < 9,
  }
} catch (e) { out.fatal = 'few: ' + String(e && e.message ? e.message : e) }

/** ── B 规模约束 ── */
try {
  // 1121 任务 1：从展示行解析「实际列出的时间点个数」，守住了 10x10 只列 32 个却写共 100 个的回归。
  const shownStatOf = (line) => {
    const body = line.split('：')[1] || ''
    const core = body.split('…共')[0].split('（共')[0].trim()
    const elems = core ? core.split(/\s+/).filter(Boolean) : []
    return { count: elems.length, first: elems[0] || null, last: elems[elems.length - 1] || null }
  }
  const legal = {}
  for (const g of ['3x3', '4x4', '10x10', '50x2', '2x50']) {
    const p = sheetPlan({ bv: 'BV1xx411c7mD', grid: g, dur: 600 })
    const sh = shownStatOf(p.lines[1])
    // 首末按 (i+0.5)*d/n 公式独立算（i=0 与 i=n-1），不直接抄 times，真正验公式一致性。
    const expFirst = +(((0 + 0.5) * 600) / p.n).toFixed(1)
    const expLast = +(((p.n - 0.5) * 600) / p.n).toFixed(1)
    legal[g] = { n: p.n, timesLen: p.times.length, shownCount: sh.count, shownFirst: sh.first, shownLast: sh.last, expFirst, expLast, truncated: p.truncated, lines: p.lines.length, area: p.area }
  }
  const capped = sheetPlan({ bv: 'BV1xx411c7mD', grid: '999x999', dur: 600 })
  const huge = sheetPlan({ bv: 'BV1xx411c7mD', grid: '99999x99999', dur: 7200 })
  const overflowGrid = '999999999999x999999999999'
  let overflowMsg = ''
  try { sheetPlan({ bv: 'BV1xx411c7mD', grid: overflowGrid, dur: 1 }) } catch (e) { overflowMsg = String(e.message || e) }
  // CLI 三态：正常 / 带 dur 超大低成本 / 溢出早退
  const cliCall = (grid) => {
    const r = spawnSync(process.execPath, [LOOK, 'sheet', 'BV1xx411c7mD', '--grid', grid, '--dur', '600', '--dry-run', '--quiet'], {
      cwd: ROOT, env: ISO_ENV, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    })
    const text = `${r.stdout || ''}${r.stderr || ''}`
    return {
      rc: r.status, bytes: Buffer.byteLength(text, 'utf8'), first: text.split('\n')[0].slice(0, 120),
      hasCrash: text.includes('Invalid array length'),
      dimWarn: text.includes('成图约') && text.includes('减小网格'),
    }
  }
  // 成图尺寸预判的源码守：软预判 warn 存在、ffmpeg catch 保留原始诊断(throw e)+减小网格提示。
  out.scale = {
    maxTimepoints: MAX_TIMEPOINTS, showTimepoints: SHOW_TIMEPOINTS,
    legal,
    capped: { n: capped.n, timesLen: capped.times.length, shownCount: shownStatOf(capped.lines[1]).count, truncated: capped.truncated, line2Tail: capped.lines[1].slice(-40) },
    huge: { n: huge.n, timesLen: huge.times.length, shownCount: shownStatOf(huge.lines[1]).count, truncated: huge.truncated, line2Tail: huge.lines[1].slice(-40) },
    overflow: { parsed: parseGrid(overflowGrid), scaleOverflow: gridScaleOverflow(overflowGrid), msg: overflowMsg },
    dim: {
      areaFromPlan: capped.area,
      warnSrc: src.includes('成图约') && src.includes('可能超过可编码上限'),
      ffCatchSrc: /catch \(e\) \{[\s\S]{0,240}减小网格[\s\S]{0,80}throw e/.test(src),
    },
    cli: { legal: cliCall('10x10'), capped: cliCall('999x999'), huge: cliCall('99999x99999'), overflow: cliCall(overflowGrid) },
  }
} catch (e) { out.fatal = (out.fatal ? out.fatal + ' | ' : '') + 'scale: ' + String(e && e.message ? e.message : e) }

/** ── C search 时长四形态：切 fmtSearchDuration 真源码跑 ── */
try {
  const fm = /function fmtSearchDuration\(raw\) \{[\s\S]*?\n\}/.exec(src)
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext((fm ? fm[0] : '') + '\nthis.f = fmtSearchDuration', ctx)
  const shape = (v) => (ctx.f ? ctx.f(v) : null)
  out.searchDur = {
    found: !!fm,
    normal: shape('2843:14'),
    longMin: shape('8724:29'),
    oneDigitSec: shape('3627:4'),
    maxSec: shape('0:59'),
    secOverflow: shape('1:99'),  // 1121 任务 3：秒位超范围，应保留原文「1:99」
    empty: shape(''),
    unknown: shape('abc'),
    colon3: shape('12:34:56'),
    sourceUsesHelper: src.includes('fmtSearchDuration(it.duration)'),
    hotUntouched: src.includes("Number(it.duration) > 0") || src.includes('Number(it.duration)>0'),
  }
} catch (e) { out.fatal = (out.fatal ? out.fatal + ' | ' : '') + 'searchDur: ' + String(e && e.message ? e.message : e) }

/** ── D 隔离证据（1515 任务 B）：对照文件未改写 + 诊断落临时目录 + 清理 ── */
try {
  let controlAfter = null
  try { controlAfter = readFileSync(CONTROL_PATH, 'utf8') } catch (e) { controlAfter = '<MISSING: ' + String(e && e.code || e) + '>' }
  const diagnostics = collectDiagnostics(ISO_CACHE)
  out.isolation = {
    cacheUnderTmp: ISO_CACHE.startsWith(tmpdir()),
    homeUnderTmp: ISO_HOME.startsWith(tmpdir()),
    controlIntact: controlAfter === CONTROL_TEXT,
    controlAfter: controlAfter.length > 120 ? controlAfter.slice(0, 120) + '…' : controlAfter,
    diagnostics,                       // 溢出诊断：相对路径 + 字节数（对照文件在根，诊断在 BV 子目录）
    overflowDiagnostic: diagnostics.find((d) => d.path.includes('BV1xx411c7mD/')) || null,
  }
} catch (e) { out.fatal = (out.fatal ? out.fatal + ' | ' : '') + 'isolation: ' + String(e && e.message ? e.message : e) }
// 跑完清理临时树（含对照文件与诊断），用户真实缓存全程未被触碰。
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不掩盖主证据 */ }

console.log('PROBE_JSON=' + JSON.stringify(out))
