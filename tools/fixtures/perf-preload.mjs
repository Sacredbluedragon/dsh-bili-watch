// 面板首屏性能夹具的子进程桩：把 node:child_process 的两个 exec 换成可控延迟的假进程。
//
// 为什么用 --import + syncBuiltinESMExports：index.js 是 `import { execFile, execFileSync }`
// 静态绑定，直接改 require('node:child_process') 的属性对 ESM 命名导出无效；
// syncBuiltinESMExports() 会把 CJS 侧的替换同步进 builtin 的 ESM 包装（已实测 STUBBED 生效）。
//
// 计数落在被测对象之外：夹具数的是「桩被调用了几次」，不是让生产代码自己报数 ——
// 自己数自己会让「在飞去重没生效」这种缺陷永远绿。
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const cfg = JSON.parse(process.env.BW_PERF_CFG || '{}')
const delayMs = Number(cfg.delayMs || 80)
const ytdlpFail = cfg.ytdlpFail === true
const spawns = []
globalThis.__BW_SPAWNS__ = spawns

const isYt = (f, a) => /yt-dlp/i.test(String(f)) && String((a || [])[0] || '') === '--version'
const isFfmpeg = (f, a) => String(f) === 'ffmpeg' && String((a || [])[0] || '') === '-version'
const isPy = (f, a) => String((a || [])[0] || '') === '-c'
const note = (f, a, kind) => spawns.push({ kind, file: String(f), args: (a || []).map(String) })
// 真阻塞事件循环：Atomics.wait 在 Node 主线程可用，不是 busy loop（不烧 CPU）。
const sleepSync = (ms) => {
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

cp.execFileSync = (f, a = [], opts) => {
  note(f, a, 'sync')
  if (isYt(f, a)) {
    sleepSync(delayMs)
    if (ytdlpFail) { const e = new Error('stub: yt-dlp 启动失败'); e.code = 'ENOENT'; throw e }
    return '2026.11.06\n'
  }
  if (isFfmpeg(f, a)) { sleepSync(delayMs); return 'ffmpeg version stub\n' }
  if (isPy(f, a)) { sleepSync(delayMs); return '' }
  const e = new Error('stub: /status 路径不该同步起这个进程：' + String(f)); e.code = 'ENOENT'
  throw e
}

cp.execFile = (f, a = [], opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  if (typeof a === 'function') { cb = a; a = [] }
  const yt = isYt(f, a)
  note(f, a, yt ? 'ytdlp' : 'async')
  const done = () => {
    if (yt) {
      if (ytdlpFail) {
        const e = new Error('stub: yt-dlp 启动失败'); e.code = 'ENOENT'; e.stderr = 'ENOENT'
        return cb(e, '', '')
      }
      return cb(null, '2026.11.06\n', '')
    }
    if (isFfmpeg(f, a)) return cb(null, 'ffmpeg version stub\n', '')
    if (isPy(f, a)) return cb(null, '', '')
    // GPU 探测（nvidia-smi / --probe-gpu）：给确定的失败，别真去跑本机命令
    const e = new Error('stub: no gpu'); e.code = 'ENOENT'; e.stderr = 'no gpu'
    return cb(e, '', '')
  }
  const slow = yt || isFfmpeg(f, a) || isPy(f, a)
  setTimeout(done, slow ? delayMs : 0)
  return { pid: 4242, kill() {}, on() {}, once() {}, unref() {} }
}

syncBuiltinESMExports()
