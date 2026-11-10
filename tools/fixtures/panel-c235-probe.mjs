// C235 夹具：整份 client.js 进受控宿主**真渲染**，逐行抽 `data-bl-row` 的纯文本，
//   数 `deps[].path` 在每一行出现几次。C198 验的是 depPathNote 这个零件，
//   重复显示发生在 DepRow 把 note 与 detail 同时渲染进同一行的那一刻 —— 只有整机看得见。
//
// 纪律（接 C195 / C208）：
//   ① 不替被测函数造环境。整份源码原样在宿主里跑，client.js 自己定义的符号一个都不
//      从外部注入；跨作用域引用会自然抛 ReferenceError。外部只给宿主本该给的 React /
//      window / document / fetch。
//   ② 不抽函数、不用邻居当锚点。扰动锚点只用 depPathNote 自身那条提前 return 与
//      DepRow 自己的渲染行，命中与否单独取证（没命中的「跳过」和通过一样绿）。
//
// 只输出一行 JSON，判与不判交给 tools/verify.mjs 的 C235 / C198。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SRC = readFileSync(join(ROOT, 'client.js'), 'utf8')

const TUNING = {
  asrMaxSec: 1800, maxFrames: 500, asrTimeoutSec: 900, ffmpegTimeoutSec: 300,
  cmdTimeoutSec: 180, asrMemMB: 1536, lockTtlMin: 30, unitLimit: 5000,
  textLimit: 800, toolTextCap: 2000, toolHead: 800, dmBucketSec: 30, dmTop: 5,
  downloadMaxMB: 512, subRateMin10: 20, subRateMax10: 85, textBrief: 400,
  asrDevice: 'auto',
}

// 与 C208 同一份脱敏样本：七行 deps，路径一律仓库相对占位，不含本机绝对路径。
// ffmpeg/ytdlp/asr/ocr/model 的 detail 与 path 同源（会重复）；cuda 与 credential
// 的 detail 是状态说明（depPathNote 是这两行唯一的路径来源）。
function baseStatus() {
  return {
    ok: true,
    data: {
      version: '0.4.8',
      credential: { exists: true, state: 'ok', updatedAt: '2026-10-28T05:37:32.636Z', ageDays: 10 },
      deps: [
        { id: 'ffmpeg', name: 'ffmpeg（抽帧 / 取音轨）', ok: true, detail: 'deps/ffmpeg.exe', path: 'deps/ffmpeg.exe', removable: false, removableWhy: '在插件目录外，这里不删', size: 98730496, estimate: '约 94 MB' },
        { id: 'ytdlp', name: 'yt-dlp（通用 URL）', ok: true, detail: 'deps/yt-dlp.exe', path: 'deps/yt-dlp.exe', removable: true, size: 17840399, estimate: '约 17 MB' },
        { id: 'asr', name: 'ASR 环境', ok: true, detail: 'deps/venv-asr/python.exe', path: 'deps/venv-asr/python.exe', removable: false, removableWhy: '环境目录不从这里删', size: 2416903948, estimate: '约 294 MB' },
        { id: 'ocr', name: 'OCR 环境', ok: true, detail: 'deps/venv-ocr/python.exe', path: 'deps/venv-ocr/python.exe', removable: false, removableWhy: '环境目录不从这里删', size: 275556777, estimate: '约 263 MB' },
        { id: 'model', name: '转写模型', ok: true, detail: 'deps/hf-home', path: 'deps/hf-home', removable: true, size: 486213474, estimate: '约 464 MB' },
        { id: 'cuda', name: 'GPU 运行库', ok: true, na: false, detail: '已就绪', path: 'cublas64_12.dll', installable: true, removable: true, removableWhy: '', size: 2108269847, estimate: '约 1.4 GB' },
        { id: 'credential', name: 'B 站登录凭证', ok: true, detail: '更新于 2026-10-28T05:37:32.636Z（10 天前）', path: 'deps/credential.json', removable: true, size: 0, estimate: '扫码登录' },
      ],
      downloading: [],
      download: null,
      gpu: { deviceCount: 1, dllReady: true, cudaLibs: true, noCard: false, unknown: false, note: '' },
      cache: { bytes: 120130255, files: 811, days: 7, maxMb: 1024, autoClean: true, dir: 'deps/cache', lastAutoClean: { removed: 0, bytes: 0, failed: [], staleLocks: [], truncated: false, truncatedDirs: 0 } },
      tuning: { ...TUNING },
      tuningDefaults: { ...TUNING },
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

// normal 是派单点名的「七行」主体。其余形态覆盖 detail 不含 path 的失败态与
//   系统 PATH 那种短通用词 path，数字一并输出给报告，不参与主体计数断言。
const CASES = [
  ['normal', (s) => s],
  ['ffmpegOnPath', (s) => {
    s.data.deps[0].detail = '在系统 PATH 里（ffmpeg -version 可执行）'
    s.data.deps[0].path = 'ffmpeg'
    return s
  }],
  ['modelPartial', (s) => { s.data.deps[4].detail = '目录存在但转写模型不完整（缺 2 个文件）'; return s }],
  ['probesFailed', (s) => {
    s.data.deps[1].detail = '没找到，非 B 站 URL 不可用'
    s.data.deps[2].detail = 'python 在，但 import faster_whisper 失败：未知原因'
    s.data.deps[3].detail = 'python 在，但 import rapidocr 失败：未知原因'
    return s
  }],
  ['cudaNoPath', (s) => { s.data.deps[5].path = ''; return s }],
  ['credNotLogin', (s) => { s.data.deps[6].detail = '没登录，AI 字幕与部分接口不可用'; return s }],
]

function textOf(n) {
  if (n == null || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (typeof n !== 'object') return ''
  let s = ''
  for (const c of (n.children || [])) s += textOf(c)
  return s
}

/** 用一份源码 + 一份 status 跑一次完整注册与渲染，全程不注入 client.js 内部符号 */
function runCase(src, status, label) {
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
    querySelector: () => null,
    body: { appendChild() {} },
  }
  const stubFetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => status })

  let nodes = 0
  let errors = 0
  let fnNodes = 0
  const throws = []
  const captured = {}
  const rowTexts = []
  const slots = {
    inject(_n, f) { return f() },
    register(s, c) { captured[s.name] = c; return () => {} },
  }

  try {
    const fn = new Function(
      'window', 'document', 'React', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController',
      `${src}\n;return true`,
    )
    fn(windowStub, documentStub, React, stubFetch, globalThis.setTimeout, globalThis.clearTimeout, globalThis.AbortController)
    if (!registered || typeof registered.factory !== 'function') throw new Error('MODULE_LOADER.load 没拿到 factory')
    const mod = registered.factory((n) => { if (n === 'react') return React; throw new Error('req ' + n) })
    if (!mod || typeof mod.apply !== 'function') throw new Error('factory 没返回 apply')
    mod.apply({
      effect(f) { try { return f() } catch (e) { errors++; throws.push(`effect: ${e.message}`); return () => {} } },
      get(n) { return n === 'slots' ? slots : undefined },
      on() {},
    })
  } catch (e) {
    errors++
    throws.push(`bootstrap: ${e.message}`)
  }

  const panel = captured['plugins.bundle.config']
  const realOk = typeof panel === 'function'

  const noteLog = []
  let loadedNotes = []
  function render(comp, props, tag) {
    const start = rowTexts.length
    const noteStart = noteLog.length
    hookIdx = 0
    let tree
    try { tree = comp(props) } catch (e) { errors++; throws.push(`${tag}: ${e.message}`); return [] }
    const walk = (n, d) => {
      if (!n || typeof n !== 'object' || d > 60) return
      nodes++
      if (n.props && Object.prototype.hasOwnProperty.call(n.props, 'data-bl-row')) rowTexts.push(textOf(n))
      // C241：记下每个 note 节点的属性集合与文本，判据据此区分「依赖行 note」与「参数行 note」。
      if (n.props && Object.prototype.hasOwnProperty.call(n.props, 'data-bl-note')) {
        noteLog.push({ keys: Object.keys(n.props), text: textOf(n).slice(0, 80) })
      }
      if (typeof n.type === 'function' && n.type !== comp) {
        hookIdx = 0
        let sub
        try { sub = n.type(n.props) } catch (e) { errors++; throws.push(`${tag}>${n.type.name || 'anon'}: ${e.message}`); return }
        walk(sub, d + 1)
      }
      for (const c of (n.children || [])) {
        if (c && typeof c === 'object' && typeof c.type === 'function') fnNodes++
        walk(c, d + 1)
      }
    }
    walk({ type: comp, props: props || {}, children: [tree] }, 0)
    if (tag.endsWith(':loaded')) loadedNotes = noteLog.slice(noteStart)
    return rowTexts.slice(start)
  }

  let loadedRows = []
  if (realOk) {
    hookIdx = 0
    render(panel, {}, `${label}:init`)
    if (setSt) setSt(status.data)
    hookIdx = 0
    loadedRows = render(panel, {}, `${label}:loaded`)
    for (const k of ['plugins.bundle.activation', 'shell.overlay']) {
      if (captured[k]) { hookIdx = 0; render(captured[k], {}, `${label}:${k}`) }
    }
  } else {
    errors++
    throws.push('plugins.bundle.config 槽位没注册到组件')
  }

  // 只认 loaded 那一次渲染收集到的 data-bl-row：init 时 deps 还没到位，
  //   activation / shell.overlay 也可能渲染同名属性，混进来会把计数全冲成 0。
  const deps = status.data.deps
  const texts = loadedRows
  const rows = deps.map((d, i) => {
    const text = texts[i] || ''
    const path = typeof d.path === 'string' ? d.path : ''
    const countOf = (s) => (s ? text.split(s).length - 1 : 0)
    return {
      id: d.id,
      path,
      rawCount: path ? countOf(path) : 0,
      noteCount: path ? countOf('路径：' + path) + countOf('文件：' + path) : 0,
      fileCount: path ? countOf('文件：' + path) : 0,
      pathCount: path ? countOf('路径：' + path) : 0,
      text: text.slice(0, 240),
    }
  })
  return { label, rows, notes: loadedNotes, nodes, errors, fnNodes, realOk, throws: throws.slice(0, 6), rowsSeen: rowTexts.length }
}

// 反向能力（夹具自述，真源码双向扰动另在 verify 外做）：
//   A 删掉 depPathNote 里那条「detail 已含 path」的提前 return → 同源行叠两次；
//   B 删掉 DepRow 的 note 渲染行 → cuda / credential 永久丢路径。
const POISON_A = /^[ \t]*if \(typeof d\.detail === 'string' && d\.detail\.includes\(d\.path\)\) return ''\n/m
const POISON_B = /^[ \t]*depPathNote\(d\) \? h\('span', \{ 'data-bl-note': '', 'data-bl-dep-note': '' \}, depPathNote\(d\)\) : null,\n/m
const poisonInjectedA = POISON_A.test(SRC)
const poisonInjectedB = POISON_B.test(SRC)
const srcA = SRC.replace(POISON_A, '')
const srcB = SRC.replace(POISON_B, '')
const normal = baseStatus()
const poisonA = runCase(srcA, baseStatus(), 'poisonA')
const poisonB = runCase(srcB, baseStatus(), 'poisonB')

const cases = CASES.map(([label, mutate]) => {
  const st = mutate(baseStatus())
  return runCase(SRC, st, label)
})

console.log(JSON.stringify({
  cases,
  poisonInjectedA,
  poisonInjectedB,
  poisonA: { rows: poisonA.rows, errors: poisonA.errors },
  poisonB: { rows: poisonB.rows, errors: poisonB.errors },
}))
