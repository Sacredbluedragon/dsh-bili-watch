// 并发读写探针：一个进程密集读、另一个进程持续原子写，数「读到半截 JSON」的次数。
//
// 为什么必须是独立进程：这条要测的是**跨进程**的可见性。同进程内 Node 是单线程，
//   同步读写天然互斥，永远测不出窗口。
//
// 为什么读方用裸 JSON.parse 而不是 readJsonOrBackup：后者在 parse 失败时会把文件
//   改名留档（.broken-<ts>），第一次坏之后目标文件就没了，后续全变成 ENOENT，
//   统计会立刻失真。这里只想知道「读到的字节是不是完整 JSON」。
//
// 读的节奏按真实场景（SPARSE）：一次「命令」读 15 次配置（tools/look.mjs 的 tuning()
//   在一次 CLI 调用里被调用十几次），然后去干别的 8ms。用紧凑循环会把 IO 占满 100%，
//   那不是真实负载，会把「重试够不够」测成「重试不可能够」。
//
// 用法：node atomic-race.mjs <目标文件> [writeN] [readN] [padKB]
// 输出：一行 JSON { writer: { hardFail }, reader: { bad, ok, weird, sawMax }, tmpLeft }
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

const target = process.argv[2]
const WN = Number(process.argv[3] || 200)
const RN = Number(process.argv[4] || 2000)
const KB = Number(process.argv[5] || 200)
if (!target) {
  console.error('用法：node atomic-race.mjs <目标文件> [writeN] [readN] [padKB]')
  process.exit(2)
}

const cfgUrl = new URL('../../lib/config.mjs', import.meta.url).href

// 写子进程：调**真的** writeJsonAtomic（不是复刻）。数「重试用完仍然没写成」的次数。
//   hardFail **不作为 PASS/FAIL 的判据**：它有概率成分（退避共 78ms，机器忙时偶尔漏一次）。
//   调用方只把它当信息报出来；「重试逻辑在不在、上限对不对」由 verify 的 C135 用确定性桩判。
const writerSrc = `
import { writeJsonAtomic } from ${JSON.stringify(cfgUrl)}
const pad = 'x'.repeat(${KB} * 1024)
let hardFail = 0
for (let i = 0; i < ${WN}; i++) {
  try { writeJsonAtomic(${JSON.stringify(target)}, { seq: i, pad }) } catch { hardFail++ }
}
console.log(JSON.stringify({ hardFail }))
`

// 读子进程：只数三种状态——parse 失败 / 结构不完整（能被 parse 但字段缺，理论上不该出现，
//   留着是为了区分「半截」和「别的坏法」）/ 正常。
const readerSrc = `
import { readFileSync } from 'node:fs'
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
let bad = 0, ok = 0, weird = 0, sawMax = -1
let i = 0
while (i < ${RN}) {
  for (let k = 0; k < 15 && i < ${RN}; k++, i++) {
    let raw = ''
    try { raw = readFileSync(${JSON.stringify(target)}, 'utf8') } catch { continue }
    let o
    try { o = JSON.parse(raw) } catch { bad++; continue }
    if (!o || typeof o !== 'object' || typeof o.seq !== 'number' || typeof o.pad !== 'string' || o.pad.length !== ${KB * 1024}) { weird++; continue }
    ok++
    if (o.seq > sawMax) sawMax = o.seq
  }
  sleepSync(8)
}
console.log(JSON.stringify({ bad, ok, weird, sawMax }))
`

const run = (code) =>
  new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (rc) => res({ rc, out: out.trim(), err: err.trim() }))
  })

// 先起读、再起写：保证写开始之前读已经在跑，窗口从第一次写就存在。
const reading = run(readerSrc)
await new Promise((r) => setTimeout(r, 60))
const writing = run(writerSrc)
const [rd, wr] = await Promise.all([reading, writing])

const pick = (r) => {
  try { return JSON.parse(r.out) } catch { return { parseFail: true, rc: r.rc, out: r.out.slice(0, 200), err: r.err.slice(0, 200) } }
}
let tmpLeft = -1
try {
  const dir = target.slice(0, Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')))
  tmpLeft = readdirSync(dir).filter((n) => n.endsWith('.tmp')).length
} catch {}

console.log(JSON.stringify({ writer: pick(wr), reader: pick(rd), tmpLeft }))
