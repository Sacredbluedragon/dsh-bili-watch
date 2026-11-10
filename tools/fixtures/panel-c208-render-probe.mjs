// C208 夹具：把整份 client.js 放进受控宿主里**真渲染**，喂多种异常 status 形态。
//
// 判据来源（2026-11-08 P0 白屏）：C1 把 lastRunDetail 抽成顶层函数，却引用了 factory 内的
//   fmtTime。C195 把函数抠出来单跑、自己注入假 fmtTime，于是六条断言全绿，真机 Panel 一渲染
//   就 ReferenceError，整块面板空白。C207 补的是静态作用域对比，挡不住「数据形态不同才炸」。
//
// 这个夹具守 13:45 段的两条硬要求：
//   ① 不替被测函数造环境。整份源码原样在宿主里跑，client.js 自己定义的符号一个都不从外部
//      注入；跨作用域引用会自然抛 ReferenceError，那正是要抓的东西。外部只提供宿主本该
//      提供的 React / window / document / fetch。
//   ② 不抽函数、不用邻居当锚点。没有抽取起止标记；下面的扰动锚点只用 Panel 自身声明。
//
// 五种形态各自**独立环境**（hookStore、模块状态、registered 全新建），避免串味。
// 只输出一行 JSON，判与不判交给 tools/verify.mjs 的 C208。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SRC = readFileSync(join(ROOT, 'client.js'), 'utf8')

// 内置脱敏状态样本：字段与真 /status 一致，路径一律仓库相对占位，不含本机绝对路径。
const TUNING = {
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

// C240 b 批（1430 段 §五 C240 第 3 条）：补五个**非渲染路径**函数。
// 现有夹具只走「注册 → 渲染 Panel → 渲染 activation/overlay」，不触发任何交互回调，
// 所以 fmtDelMsg / fmtSkippedNote / missingDeps / pollStep / readDownloadResp 里的
// 悬空符号注入后，五种形态照样 errors=0。
// 做法不是「把函数抠出来单跑」（那正是 C195 假绿的成因），也不从外部注入 client.js
// 内部符号：整份源码原样在同一个 new Function 里求值，末尾只**导出这五个真实引用**，
// 再逐个真调用。函数就是 client.js 里那一个，没有替它造环境。
const INTERACT_FNS = ['fmtDelMsg', 'fmtSkippedNote', 'missingDeps', 'pollStep', 'readDownloadResp']
const POISON_TAG = '__c208Miss_'
const INTERACT_SAMPLES = {
  fmtDelMsg: { deleted: ['ffmpeg'], skipped: [{ id: 'asr', why: '被占用' }] },
  fmtSkippedNote: { skipped: [{ name: 'user.mov', why: '不是本插件的文件' }] },
  missingDeps: [
    { id: 'ffmpeg', ok: false, installable: true },
    { id: 'cuda', ok: false, na: true },
    { id: 'ytdlp', ok: true },
  ],
  pollStep: { state: 'ok' },
  readDownloadResp: { ok: true, data: { results: [{ started: true, log: 'deps/download.log' }] } },
}

// 13:45 段点名的四种异常形态 + 一份完整基线
const CASES = [
  ['normal', (s) => s],
  ['depsEmpty', (s) => { s.data.deps = []; return s }],
  ['lastRunNoCodeMs', (s) => { delete s.data.lastRun.code; delete s.data.lastRun.ms; return s }],
  ['credentialNull', (s) => { s.data.credential = null; return s }],
  ['versionMissing', (s) => { delete s.data.version; return s }],
]

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
  const throws = []
  const captured = {}
  let exported = null
  const slots = {
    inject(_n, f) { return f() },
    register(s, c) { captured[s.name] = c; return () => {} },
  }

  try {
    const fn = new Function(
      'window', 'document', 'React', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController',
      `${src}\n;return { ${INTERACT_FNS.join(', ')} }`,
    )
    exported = fn(windowStub, documentStub, React, stubFetch, globalThis.setTimeout, globalThis.clearTimeout, globalThis.AbortController)
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

  function render(comp, props, tag) {
    hookIdx = 0
    let tree
    try { tree = comp(props) } catch (e) { errors++; throws.push(`${tag}: ${e.message}`); return }
    const walk = (n, d) => {
      if (!n || typeof n !== 'object' || d > 60) return
      nodes++
      if (typeof n.type === 'function' && n.type !== comp) {
        hookIdx = 0
        let sub
        try { sub = n.type(n.props) } catch (e) { errors++; throws.push(`${tag}>${n.type.name || 'anon'}: ${e.message}`); return }
        walk(sub, d + 1)
      }
      for (const c of (n.children || [])) walk(c, d + 1)
    }
    walk({ type: comp, props: props || {}, children: [tree] }, 0)
  }

  if (realOk) {
    hookIdx = 0
    render(panel, {}, `${label}:init`)
    if (setSt) setSt(status.data)
    hookIdx = 0
    render(panel, {}, `${label}:loaded`)
    for (const k of ['plugins.bundle.activation', 'shell.overlay']) {
      if (captured[k]) { hookIdx = 0; render(captured[k], {}, `${label}:${k}`) }
    }
  } else {
    errors++
    throws.push('plugins.bundle.config 槽位没注册到组件')
  }

  // 五个非渲染函数逐个**真调用**：拿到的是原样源码求值后导出的真实引用，不是复刻。
  // 被注入悬空符号的那个函数会在调用时抛 ReferenceError，errors 随之变红。
  const interact = {}
  for (const name of INTERACT_FNS) {
    const f = exported && exported[name]
    if (typeof f !== 'function') {
      interact[name] = { called: false, ok: false, result: null, error: '源码没导出这个函数引用' }
      errors++
      throws.push(`interact:${name} 没拿到真函数引用`)
      continue
    }
    try {
      const out = f(INTERACT_SAMPLES[name])
      interact[name] = { called: true, ok: true, result: JSON.stringify(out) }
    } catch (e) {
      interact[name] = { called: true, ok: false, result: null, error: String((e && e.message) || e) }
      errors++
      throws.push(`interact:${name}: ${(e && e.message) || e}`)
    }
  }

  return { name: label, nodes, errors, realOk, throws: throws.slice(0, 6), interact }
}

// 形态指纹：证明五种 status 真的被改成不同形状，而不是「夹具跑了五遍同一份数据」。
// 节点数相同不等于形态没生效（code/ms、credential 只改文本不改节点数），所以单独取证。
function shapeOf(s) {
  const d = s.data
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k)
  return {
    deps: Array.isArray(d.deps) ? d.deps.length : 'non-array',
    lastRunCode: has(d.lastRun, 'code'),
    lastRunMs: has(d.lastRun, 'ms'),
    credentialNull: d.credential === null,
    versionMissing: !has(d, 'version'),
  }
}

const cases = CASES.map(([label, mutate]) => {
  const st = mutate(baseStatus())
  return { ...runCase(SRC, st, label), shape: shapeOf(st) }
})

// 反证：往 Panel 自身声明后插一个未定义符号，真渲染必须抛 ReferenceError。
// 锚点只用被扰动对象自身（function Panel() {），不依赖任何邻居。
const POISON_ANCHOR = /function Panel\(\) \{/
const poisonInjected = POISON_ANCHOR.test(SRC)
const poisoned = SRC.replace(POISON_ANCHOR, (m) => `${m} void __c208Missing()`)
const poisonRun = runCase(poisoned, baseStatus(), 'poison')

// 单点污染：五个函数**各自**注一个不同名的悬空符号，各自跑一遍完整流程。
// 「不同名」是有意为之：若五份 poison 复用同一份源码，或夹具把结果写死，
// marker 与 throws 对不上就会在 C269 被抓到。
const interactPoisons = {}
for (const name of INTERACT_FNS) {
  const marker = `${POISON_TAG}${name}`
  const anchor = new RegExp(`^(function ${name}\\([^)]*\\) \\{)`, 'm')
  const injected = anchor.test(SRC)
  const mutated = SRC.replace(anchor, `$1\n  void ${marker}()`)
  const run = runCase(mutated, baseStatus(), `poison:${name}`)
  interactPoisons[name] = {
    marker,
    injected: injected && mutated !== SRC && mutated.includes(marker),
    caught: injected && run.errors > 0,
    errors: run.errors,
    throws: run.throws,
    interactOk: run.interact[name] ? run.interact[name].ok : null,
    interactError: run.interact[name] ? run.interact[name].error : null,
  }
}

console.log(JSON.stringify({
  cases,
  normalNodes: cases[0].nodes,
  normalRealOk: cases[0].realOk,
  poisonInjected,
  poisonCaught: poisoned !== SRC && poisonRun.errors > 0,
  poisonErrors: poisonRun.errors,
  poisonThrows: poisonRun.throws,
  interactFns: INTERACT_FNS,
  interact: cases[0].interact,
  interactPoisons,
}))
