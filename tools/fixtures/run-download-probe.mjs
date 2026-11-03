// runDownload 探针：函数体在桩环境里能否**求值成功并真的拉起进程**。
//
// 为什么要有它（PR #8 的活标本）：
//   e889822「fetch-deps 合一」删掉了 `const detached = process.platform !== 'win32'`，
//   但 spawn 的选项对象（`detached,`）与 download.log 的模板（`detached=${detached}`）
//   两处还在引用它 → 对象字面量求值时就抛 ReferenceError → 被函数自己的 try/catch 收成
//   `{started:false, why:"detached is not defined"}` → 路由回 HTTP 400，用户点「一键下载」没反应。
//   0.4.4 把 0.4.3 修好的东西又弄坏了，而 154 条断言一条都没红 ——
//   因为它们只验「函数存在」，没验「函数体能不能跑完」。
//
// 为什么只能看返回值、不能看 throw：
//   这个错**不会抛到调用方**（runDownload 自己 catch 了，就是为了「拉起失败也别带崩宿主」）。
//   所以判据落在 `ret.started === true` 上。第一版探针写成「捕获 ReferenceError」，
//   在坏代码上输出 OK、rc=0 —— 一条彻底没牙的判据。改看返回值后才红。
//
// 为什么切文本而不是 AST：仓库没有 JS parser 依赖（不想为一条断言引新包）。
//   切法依赖两个不变式，任一破了就 PROBE-BROKEN 退 2（不是静默 PASS）：
//     ① 源码里有 `function runDownload(target) {`；
//     ② 函数以行首 `}` 收尾，且函数体内没有别的行首 `}`（内部块都是缩进两格的 `  }`）。
//
// 用法：node tools/fixtures/run-download-probe.mjs [index.js 路径]
// 退出码：0 = PASS；1 = 红（函数体跑不通 / detached 没落成 false）；2 = 探针自身失效
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] || join(here, '..', '..', 'index.js')
const src = readFileSync(file, 'utf8')

const start = src.indexOf('function runDownload(target) {')
if (start < 0) { console.error('PROBE-BROKEN: 没找到 runDownload 定义'); process.exit(2) }
const end = src.indexOf('\n}\n', start)
if (end < 0 || end < start) { console.error('PROBE-BROKEN: 没找到函数结尾（行首 } 不存在？）'); process.exit(2) }
const body = src.slice(start, end + 3)
if (!body.includes('function runDownload')) { console.error('PROBE-BROKEN: 切出来的函数体不对'); process.exit(2) }

// 2026-11-03（issue #10 问题 3）：runDownload 新增了进程内互斥 downloadConflict(target, DOWNLOADING)。
//   桩里必须把这两个名字一起带进来，否则本探针会因为「引用未声明变量」而红 ——
//   那是探针没跟上函数的新依赖，不是被测代码坏了。切片方式与上面同一套。
const cStart = src.indexOf('function downloadConflict(target, running) {')
if (cStart < 0) { console.error('PROBE-BROKEN: 没找到 downloadConflict 定义'); process.exit(2) }
const cEnd = src.indexOf('\n}\n', cStart)
if (cEnd < 0) { console.error('PROBE-BROKEN: downloadConflict 没有行首 } 收尾'); process.exit(2) }
const conflictBody = src.slice(cStart, cEnd + 3)
if (!conflictBody.includes('function downloadConflict')) { console.error('PROBE-BROKEN: 切出来的 downloadConflict 不对'); process.exit(2) }

// 桩只做一件事：让函数一路走到 spawn。existsSync 恒 true（跳过「脚本缺失」早退），
// target 传 'asr'（在 allowed 白名单里，跳过「不支持」早退）。
const stub = `
  const DOWNLOADING = new Set()
  ${conflictBody}
  const SCRIPTS = '/stub/scripts'
  const DEPS = '/stub/deps'
  const DOWNLOAD_LOG = '/stub/download.log'
  const join = (...a) => a.join('/')
  const existsSync = () => true
  const appendFileSync = () => {}
  const openSync = () => 3
  const closeSync = () => {}
  let __spawnOpt = null
  const spawn = (cmd, args, opt) => { __spawnOpt = opt; return { pid: 4242, on(){}, once(){}, unref(){} } }
  ${body}
  globalThis.__result = (() => {
    let ret = null
    try { ret = runDownload('asr') } catch (e) { return { threw: String(e && e.message) } }
    return {
      ret,
      hasDetached: __spawnOpt ? Object.prototype.hasOwnProperty.call(__spawnOpt, 'detached') : null,
      detachedValue: __spawnOpt ? __spawnOpt.detached : null,
    }
  })()
`

const ctx = { process, console, Date, String, Array, Object, JSON, setTimeout, clearTimeout, globalThis: null }
ctx.globalThis = ctx
try {
  vm.runInNewContext(stub, ctx, { timeout: 5000 })
} catch (e) {
  console.error('PROBE-BROKEN: 沙箱自身抛了 ' + e.message)
  process.exit(2)
}

const r = ctx.__result
if (!r) { console.error('PROBE-BROKEN: 没拿到结果'); process.exit(2) }
if (r.threw) { console.log('FAIL: 函数抛到调用方了 —— ' + r.threw); process.exit(1) }

if (!(r.ret && r.ret.started === true)) {
  const why = (r.ret && r.ret.why) || JSON.stringify(r.ret)
  console.log('FAIL: runDownload 没拉起进程 —— ' + why)
  if (/is not defined/.test(why)) {
    console.log('       ↑ 典型症状：函数体引用了未声明的变量（PR #8 就是 detached 的声明被删）')
  }
  process.exit(1)
}
if (r.hasDetached !== true) { console.log('FAIL: spawn 选项里没有 detached 键'); process.exit(1) }
if (r.detachedValue !== false) {
  console.log('FAIL: win32 下 detached 必须是 false，实际 ' + JSON.stringify(r.detachedValue))
  process.exit(1)
}
console.log('PASS: runDownload 求值通过，started=true，spawn 收到 detached=false')
process.exit(0)
