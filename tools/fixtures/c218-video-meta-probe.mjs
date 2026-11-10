// C218 / A5：验证六处 video 元信息出口真的共用同一个纯函数、键集合逐处一致。
// 不 import look.mjs（它会起命令层与网络），只读它的源码核调用点；
// 纯函数本身直接 import 真跑，六组不同形状的 v 各跑一次。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { videoMeta } from '../../lib/video-meta.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'tools', 'look.mjs'), 'utf8')

const LITERAL = 'p: v.p, pages: v.pages'
const lines = src.split(/\r?\n/)
const callLines = []
lines.forEach((l, i) => { if (l.includes('videoMeta(bv, v)')) callLines.push(i + 1) })

const out = {
  callCount: callLines.length,
  callLines,
  literalLeft: lines.filter((l) => l.includes(LITERAL)).length,
  importOk: /import \{ videoMeta \} from '\.\.\/lib\/video-meta\.mjs'/.test(src),
  // 两处形状不同的不许被收进 videoMeta
  cuesUntouched: src.includes("cuesToMd(cues, { bv, title: v.title, up: v.owner, dur: v.dur, lan: s.lan ?? '' })"),
  // C217 给这个 payload 末尾加了 video 键（加法，不是收编）。这里只锁「原六个键还在、
  // 没有把整个 payload 换成 videoMeta(...)」—— 写死完整旧串会被合法加法打红。
  commentsUntouched: src.includes("const payload = { ok: true, source: 'comments', bv, title: v.title, count: items.length, items"),
  cases: [],
}

// 六处分别造一份不同的 v（模拟各自上下文：不同 UP、时长、分 P、pages 形态）
const samples = [
  { title: 'T1', owner: 'U1', dur: 10, p: 1, pages: [] },
  { title: 'T2', owner: 'U2', dur: 123.5, p: 2, pages: [{ part: 1 }, { part: 2 }] },
  { title: 'T3', owner: 'U3', dur: 0, p: 0, pages: null },
  { title: 'T4', owner: 'U4', dur: 3600, p: 12, pages: [{ part: 12 }] },
  { title: 'T5', owner: 'U5', dur: 59, p: 3, pages: undefined },
  { title: 'T6', owner: 'U6', dur: 999, p: 7, pages: [] },
]

samples.forEach((v, i) => {
  const bv = `BV-C218-${i + 1}`
  const m = videoMeta(bv, v)
  out.cases.push({
    i: i + 1,
    keys: Object.keys(m).sort().join(','),
    bv: m.bv,
    title: m.title,
    up: m.up,
    dur: m.dur,
    p: m.p,
    pagesIsSame: m.pages === v.pages,
    hasOwnP: Object.prototype.hasOwnProperty.call(m, 'p'),
    hasOwnPages: Object.prototype.hasOwnProperty.call(m, 'pages'),
  })
})

console.log(JSON.stringify(out))
