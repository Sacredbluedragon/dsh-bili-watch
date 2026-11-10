/**
 * issue #14 探针（给 tools/verify.mjs 的 C281–C283 用）。
 *
 * 只量事实、不下结论、永远 exit 0、只吐一行 JSON；判定全在 verify.mjs。
 *
 * 为什么抠「原样函数体」：client.js 是浏览器插件里的闭包，端到端起不来 DOM，
 * 而 DSH 派单明确说「静态断言『CSS 里写了变量』不算证据」——必须断最终值。
 * 所以这里从 client.js 源码文本里切出五个具名函数的**原文**，用 new Function
 * 在桩环境里编译执行：测的是真代码，不是照着实现复刻一份。
 * 锚点被删/改名时 cut 会缺项，判据侧会红，不会静默放行。
 */
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const src = fs.readFileSync(join(ROOT, 'client.js'), 'utf8')

const SIGNATURES = [
  'function bannerTopStart(doc, win) {',
  'function relayoutBanners() {',
  'async function dismissHintForever(post, onGone, onFail) {',
  'async function showHintAgain(get, setters) {',
  'async function setHintEnabled(post, enabled, win, onDone) {',
]

/** 从签名处切到花括号配平的那个 }，返回源码原文。 */
function cutFn(sig) {
  const i = src.indexOf(sig)
  if (i < 0) return null
  const open = src.indexOf('{', i)
  let depth = 0
  for (let k = open; k < src.length; k++) {
    const c = src[k]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  return null
}

const cut = {}
for (const sig of SIGNATURES) cut[sig] = cutFn(sig)
const missing = Object.keys(cut).filter((k) => !cut[k])
const out = { cut: { signatures: SIGNATURES, missing } }

if (missing.length === 0) {
  const body = SIGNATURES.map((s) => cut[s]).join('\n')
    + '\nreturn { bannerTopStart, relayoutBanners, dismissHintForever, showHintAgain, setHintEnabled }'
  const missingDeps = (deps) => (Array.isArray(deps) ? deps.filter((d) => d && d.missing) : [])
  const factory = new Function('document', 'window', 'missingDeps', body)

  /** 造一层横幅：两个 30px 高的兄弟，getComputedStyle 只认 vars 里给的变量。 */
  function makeEnv(vars) {
    const children = [
      { offsetHeight: 30, style: {} },
      { offsetHeight: 30, style: {} },
    ]
    const layer = { children }
    const doc = {
      documentElement: { style: {} },
      querySelector: (s) => (s === '[data-shell-overlay]' ? layer : null),
      querySelectorAll: () => [],
    }
    const win = { getComputedStyle: () => ({ getPropertyValue: (n) => vars[n] ?? '' }) }
    const api = factory(doc, win, missingDeps)
    return { api, children }
  }

  // ① 位置：断 relayoutBanners() 写进内联 style.top 的**最终值**，不断 CSS 字面量。
  out.tops = [
    { name: 'titlebar32', vars: { '--dsh-windows-titlebar-height': '32px' }, want: '52px' },
    { name: 'clearance40', vars: { '--dsh-frame-top-clearance': '40px' }, want: '60px' },
    { name: 'browser', vars: {}, want: '20px' },
  ].map((c) => {
    const { api, children } = makeEnv(c.vars)
    const start = api.bannerTopStart({ documentElement: {} }, { getComputedStyle: () => ({ getPropertyValue: (n) => c.vars[n] ?? '' }) })
    api.relayoutBanners()
    return { name: c.name, want: c.want, start, top: children[0].style.top, second: children[1].style.top }
  })

  // ② 「不再提示」：非 2xx 返回 {ok:false} 不抛、ok:true、网络抛错、返回 null 四种。
  const dismissCases = [
    { mode: 'okFalse', post: async () => ({ ok: false, why: 'HTTP 500' }) },
    { mode: 'okTrue', post: async () => ({ ok: true }) },
    { mode: 'throw', post: async () => { throw new Error('连不上插件服务') } },
    { mode: 'null', post: async () => null },
  ]
  out.dismiss = []
  for (const c of dismissCases) {
    const { api } = makeEnv({})
    let gone = 0, fail = 0, failMsg = ''
    const result = await api.dismissHintForever(c.post, () => { gone++ }, (m) => { fail++; failMsg = m })
    const posts = []
    out.dismiss.push({ mode: c.mode, result, gone, fail, failMsg })
  }

  // ③ 写回 false 后横幅重新可见：走 jget（不碰 statusOnce 缓存），确认仍有缺依赖。
  const { api } = makeEnv({})
  const runShow = async (get) => {
    const calls = []
    const setters = {
      setSt: (v) => calls.push(['st', v]),
      setDismissed: (v) => calls.push(['dismissed', v]),
      setVisible: (v) => calls.push(['visible', v]),
      setHintErr: (v) => calls.push(['hintErr', v]),
    }
    const ret = await api.showHintAgain(get, setters)
    return { ret, calls: calls.map((x) => x.join('=')) }
  }
  out.showAgain = {
    missing: await runShow(async () => ({ ok: true, data: { deps: [{ name: 'ffmpeg', missing: true }] } })),
    none: await runShow(async () => ({ ok: true, data: { deps: [] } })),
    bad: await runShow(async () => ({ ok: false })),
    threw: await runShow(async () => { throw new Error('network') }),
  }

  // ④ 设置页开关：写回 false / 写 true / 服务端不确认三向。
  const toggle = async (enabled, reply) => {
    const posts = []
    let shown = 0, done = 0
    const win = { __biliWatchShowHint: () => { shown++ } }
    const post = async (p, body) => { posts.push({ p, body }); return reply }
    let err = ''
    try {
      await api.setHintEnabled(post, enabled, win, async () => { done++ })
    } catch (e) { err = String(e?.message || e) }
    return { posts, shown, done, err }
  }
  out.toggle = {
    enable: await toggle(true, { ok: true }),
    disable: await toggle(false, { ok: true }),
    rejected: await toggle(true, { ok: false, why: 'HTTP 500' }),
  }
}

process.stdout.write(JSON.stringify(out))
