// C199 夹具：把 client.js 的 lockNote 原样抠出来真跑。
// 0.4.11 扩到六条：跨进程锁样本 / 缺字段兜底 / 两处判定同源 / 回包字段存在 / 原有四条不许丢。
// 夹具只给原始返回值，结论由 verify.mjs 的判据自己算。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
const idx = readFileSync(join(ROOT, 'index.js'), 'utf8')

const fnOf = (s, name) => {
  const re = new RegExp(`(?:^|\\n)[ \\t]*function[ \\t]+${name}[ \\t]*\\(`, 'g')
  let hit = null
  for (let m; (m = re.exec(s));) hit = m
  if (!hit) throw new Error(`找不到 function ${name}`)
  const i = hit.index + hit[0].indexOf('function')
  const j = s.indexOf('\n}', i)
  if (j < 0) throw new Error(`${name} 没有行首闭合括号`)
  return s.slice(i, j + 2)
}

const good = new Function(`return (${fnOf(src, 'lockNote')})`)()
const legacy = new Function(`return (function lockNote(st) { return '' })`)()

const one = { downloading: ['ffmpeg'], download: {} }
const two = { downloading: ['ffmpeg', 'asr'], download: { why: '拿不到 .part 文件' } }
const AT = 1799750000000

console.log(JSON.stringify({
  // 原有四条（不许丢）
  empty: good({}),
  emptyArr: good({ downloading: [] }),
  nullSt: good(null),
  one: good(one),
  two: good(two),
  noDownloadObj: good({ downloading: ['model'] }),
  legacyTwo: legacy(two),
  srcUsesFn: src.includes('lockNote(st) ? h('),
  srcNoteAttr: src.includes("lockNote(st) ? h('div', { 'data-bl-note': '' }"),

  // ① 跨进程锁样本：面板要能看见「谁占着」
  cross: good({ lock: { pid: 4242, target: 'deps-migration', startedAt: AT } }),
  // ② 缺字段兜底：target 空 → 目标未知、startedAt 0 → 未知时间、整把锁缺字段也不许编
  crossNoTarget: good({ lock: { pid: 4242, target: '', startedAt: AT } }),
  crossNoTime: good({ lock: { pid: 4242, target: 'deps-migration', startedAt: 0 } }),
  crossMinimal: good({ lock: { pid: 4242 } }),
  // 锁优先于本进程 downloading（不给锁让位就是又看不见跨进程）
  crossPriority: good({ lock: { pid: 4242, target: 'deps-migration', startedAt: AT }, downloading: ['ffmpeg'] }),
  crossNull: good({ lock: null, downloading: ['ffmpeg'] }),

  // ③ 同源静态：前端优先读 st.lock；后端 /status 复用 downloadLockBusy()（不另写一套判定）
  srcClientReadsLock: /st\s*&&\s*st\.lock/.test(src) && /另一个进程正在装依赖/.test(src),
  srcStatusLockField: /lock:\s*\(\(\)\s*=>/.test(idx),
  srcStatusUsesBusy: (() => {
    const at = idx.indexOf("url.pathname === '/api/bili-watch/status'")
    if (at < 0) return false
    const seg = idx.slice(at, at + 6000)
    return seg.includes('downloadLockBusy()') && seg.includes('lock:')
  })(),
  // 两处判定同源：downloadLockBusy 的函数体里只有 depsLockVerdict 这一条三态判定
  srcBusySameVerdict: (() => {
    const at = idx.indexOf('function downloadLockBusy()')
    if (at < 0) return false
    const seg = idx.slice(at, at + 700)
    return seg.includes('depsLockVerdict(cur)') && seg.includes("v.state === 'live'")
  })(),
}))
