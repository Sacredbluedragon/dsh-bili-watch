// C209–C211 夹具：凭证行三处显示（0.0 KB / ISO 时间串 / 路径与时间换序）。
//
// 与 C208 同一套纪律：整份 client.js 原样放进受控宿主真渲染，不抽函数、不补
// client.js 内部符号；不依赖外部 status 文件，样本内置且路径脱敏。
// 输出四组证据：real（现状）+ 三组**单点退回**扰动（每次只把一处改回旧实现），
// 让三条判据各自验「该红时红」，而不是靠一次组合扰动把三条一起弄崩。
// 锚点全部只用被扰动对象自身，不拿邻居当标记（13:45 段硬要求 ②）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SRC = readFileSync(join(ROOT, 'client.js'), 'utf8')
const BACKEND = readFileSync(join(ROOT, 'index.js'), 'utf8')

const T = {
  asrMaxSec: 1800, maxFrames: 500, asrTimeoutSec: 900, ffmpegTimeoutSec: 300,
  cmdTimeoutSec: 180, asrMemMB: 1536, lockTtlMin: 30, unitLimit: 5000,
  textLimit: 800, toolTextCap: 2000, toolHead: 800, dmBucketSec: 30, dmTop: 5,
  downloadMaxMB: 512, subRateMin10: 20, subRateMax10: 85, textBrief: 400,
  asrDevice: 'auto',
}
function baseStatus() {
  return {
    ok: true,
    data: {
      version: '0.4.8',
      credential: { exists: true, state: 'ok', updatedAt: '2026-10-28T05:37:32.636Z', ageDays: 10 },
      deps: [
        { id: 'ffmpeg', name: 'ffmpeg（抽帧 / 取音轨）', ok: true, detail: 'deps/ffmpeg.exe', path: 'deps/ffmpeg.exe', removable: false, size: 98730496, estimate: '约 94 MB' },
        { id: 'model', name: '转写模型', ok: true, detail: 'deps/hf-home', path: 'deps/hf-home', removable: true, size: 486213474, estimate: '约 464 MB' },
        { id: 'credential', name: 'B 站登录凭证', ok: true, detail: '更新于 2026-10-28T05:37:32.636Z（10 天前）', path: 'deps/credential.json', removable: true, size: 0, estimate: '扫码登录' },
      ],
      downloading: [], download: null,
      gpu: { deviceCount: 1, dllReady: true, cudaLibs: true, noCard: false, unknown: false, note: '' },
      cache: { bytes: 120130255, files: 811, days: 7, maxMb: 1024, autoClean: true, dir: 'deps/cache', lastAutoClean: { removed: 0, bytes: 0, failed: [], staleLocks: [], truncated: false, truncatedDirs: 0 } },
      tuning: { ...T }, tuningDefaults: { ...T },
      tuningRanges: {
        asrMaxSec: [300, 3600], maxFrames: [100, 1000], asrTimeoutSec: [300, 3600],
        ffmpegTimeoutSec: [60, 1800], cmdTimeoutSec: [60, 900], asrMemMB: [512, 16384],
        lockTtlMin: [5, 240], unitLimit: [1000, 20000], textLimit: [200, 5000],
        toolTextCap: [500, 12000], toolHead: [200, 5000], dmBucketSec: [5, 120],
        dmTop: [1, 20], downloadMaxMB: [64, 4096], subRateMin10: [5, 60],
        subRateMax10: [30, 200], textBrief: [100, 3000], asrDevice: ['auto', 'cpu'],
      },
      lastRun: { time: '2026-11-08T03:35:38.135Z', command: 'text', code: 0, ok: true, ms: 906 },
      ui: { hintDismissed: false, activationSeen: false, showInSettings: true, autoHint: true },
      warnings: [],
    },
  }
}

const flatText = (n) => {
  if (n == null || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (typeof n !== 'object') return ''
  let s = ''
  for (const c of (n.children || [])) s += flatText(c)
  return s
}

/** 真渲染一次，收集每个 data-bl-row 的直接子节点顺序（null 子节点已被 createElement 过滤） */
function inspect(src, label) {
  let hookIdx = 0
  const hookStore = []
  let setSt = null
  const React = {
    useState(init) {
      const i = hookIdx++
      if (!(i in hookStore)) hookStore[i] = typeof init === 'function' ? init() : init
      const set = (v) => { hookStore[i] = typeof v === 'function' ? v(hookStore[i]) : v }
      if (i === 0) setSt = set
      return [hookStore[i], set]
    },
    useRef(init) { const i = hookIdx++; if (!(i in hookStore)) hookStore[i] = { current: init }; return hookStore[i] },
    useMemo(fn) { hookIdx++; return fn() },
    useCallback(fn) { hookIdx++; return fn },
    useEffect() { hookIdx++ },
    useLayoutEffect() { hookIdx++ },
    createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat(Infinity).filter((x) => x != null && x !== false) }),
  }
  let registered = null
  const windowStub = {
    __ModuleLoader__: { load: (m) => { registered = m } },
    location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' },
    addEventListener() {}, removeEventListener() {},
  }
  const documentStub = {
    head: { appendChild() {} },
    createElement: () => ({ textContent: '', setAttribute() {}, appendChild() {}, remove() {} }),
    querySelector: () => null, body: { appendChild() {} },
  }
  const stubFetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => baseStatus() })
  const captured = {}
  const slots = { inject(_n, f) { return f() }, register(s, c) { captured[s.name] = c; return () => {} } }

  let bootstrapOk = false
  let errors = 0
  const throws = []
  try {
    const fn = new Function('window', 'document', 'React', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', `${src}\n;return true`)
    fn(windowStub, documentStub, React, stubFetch, globalThis.setTimeout, globalThis.clearTimeout, globalThis.AbortController)
    const mod = registered.factory((n) => { if (n === 'react') return React; throw new Error('req ' + n) })
    mod.apply({
      effect(f) { try { return f() } catch (e) { errors++; throws.push(`effect: ${e.message}`); return () => {} } },
      get(n) { return n === 'slots' ? slots : undefined }, on() {},
    })
    bootstrapOk = typeof captured['plugins.bundle.config'] === 'function'
  } catch (e) { errors++; throws.push(`bootstrap: ${e.message}`) }

  const rows = []
  const comp = captured['plugins.bundle.config']
  if (bootstrapOk) {
    // 先空跑一次让 useState 建立 hookStore 并捕获 setSt；之后灌数据再渲染才有依赖行。
    hookIdx = 0
    try { comp({}) } catch (e) { errors++; throws.push(`init: ${e.message}`) }
    if (setSt) setSt(baseStatus().data)
    hookIdx = 0
    let tree
    try { tree = comp({}) } catch (e) { errors++; throws.push(`render: ${e.message}`) }
    const walk = (n, d) => {
      if (!n || typeof n !== 'object' || d > 60) return
      if (typeof n.type === 'function' && n.type !== comp) {
        hookIdx = 0
        let sub
        try { sub = n.type(n.props) } catch (e) { errors++; throws.push(`sub: ${e.message}`); return }
        walk(sub, d + 1)
      }
      if (n.props && Object.prototype.hasOwnProperty.call(n.props, 'data-bl-row')) rows.push(n)
      for (const c of (n.children || [])) walk(c, d + 1)
    }
    if (tree) walk({ type: comp, props: {}, children: [tree] }, 0)
  }

  const shaped = rows.map((row) => ({
    text: flatText(row),
    parts: (row.children || []).map((c) => ({
      keys: c && typeof c === 'object' ? Object.keys(c.props || {}) : [],
      text: flatText(c),
    })),
  }))
  const cred = shaped.find((r) => r.text.includes('B 站登录凭证'))
  const other = shaped.find((r) => !r.text.includes('B 站登录凭证'))
  const idx = (parts, key) => parts.findIndex((p) => p.keys.includes(key))

  return {
    label,
    bootstrapOk,
    errors,
    throws: throws.slice(0, 4),
    credFound: !!cred,
    rowsCount: shaped.length,
    credSizeIndex: cred ? idx(cred.parts, 'data-bl-size') : -2,
    credNoteIndex: cred ? idx(cred.parts, 'data-bl-note') : -2,
    credDetailIndex: cred ? idx(cred.parts, 'data-bl-detail') : -2,
    credDetailText: cred ? (cred.parts.find((p) => p.keys.includes('data-bl-detail')) || {}).text || '' : '',
    otherHasSize: other ? idx(other.parts, 'data-bl-size') >= 0 : false,
  }
}

// 三组单点退回扰动：锚点都只用被扰动行自身。
const SIZE_OLD = "d.id === 'credential' ? null : h('span', { 'data-bl-size'"
const TIME_OLD = 'humanizeDetail(d.detail)'
const NOTE_LINE = "        depPathNote(d) ? h('span', { 'data-bl-note': '', 'data-bl-dep-note': '' }, depPathNote(d)) : null,\n"
const PROGRESS_LINE = "        progress ? h('span', { 'data-bl-progress': '' }, progressText(progress, d.estimate)) : null,\n"

let legacyOrderSrc = SRC
const noteAt = legacyOrderSrc.indexOf(NOTE_LINE)
if (noteAt >= 0) {
  legacyOrderSrc = legacyOrderSrc.slice(0, noteAt) + legacyOrderSrc.slice(noteAt + NOTE_LINE.length)
  legacyOrderSrc = legacyOrderSrc.replace(PROGRESS_LINE, PROGRESS_LINE + NOTE_LINE)
}

console.log(JSON.stringify({
  anchorOk: {
    size: SRC.includes(SIZE_OLD),
    time: SRC.includes(TIME_OLD),
    note: noteAt >= 0 && SRC.includes(PROGRESS_LINE),
  },
  // 后端值不许改：updatedAt 仍是原始 ISO 参与拼串，格式化只发生在前端。
  backendOk: BACKEND.includes('cred.updatedAt ??') && !BACKEND.includes('humanizeDetail'),
  real: inspect(SRC, 'real'),
  legacySize: inspect(SRC.replace(SIZE_OLD, "h('span', { 'data-bl-size'"), 'legacySize'),
  legacyTime: inspect(SRC.replace(TIME_OLD, 'd.detail'), 'legacyTime'),
  legacyOrder: inspect(legacyOrderSrc, 'legacyOrder'),
}))
