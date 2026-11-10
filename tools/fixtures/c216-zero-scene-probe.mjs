// C216 夹具：复刻 frames --scene 的**真实消费链**（B8 回归）。
// DSH 1650 段硬要求：不许只测 pickEvenly([]) 的返回值，要看这个返回值被消费时会发生什么。
// 所以这里从 tools/look.mjs 原样切出「scene 循环 + 没找到变化点的闸门 + 两个抽帧分支」，
// 只桩宿主本来就提供的外部函数（sceneTimes / pickEvenly / track / ffExec / join），
// 不给被测代码补任何它自己定义的符号。ffExec 记录 -ss 值，用来数抽帧调用次数。
//
// 抽取起止标记只依赖被抽对象自身：起点是这段链的初始化，终点用花括号平衡数到
// scene 抽帧分支的闭合，不拿邻居的 const 当收尾标记（C158 踩过）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickEvenly } from '../../lib/media.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const src = readFileSync(join(ROOT, 'tools/look.mjs'), 'utf8')

const bodyStart = src.indexOf('    let frameTimes = []')
// 从 scene 抽帧分支自己那个 `{` 起数（不能从上一分支的 `}` 起，否则深度从 -1 开始）。
// 模板字符串里的 ${...} 花括号成对，净深度为 0，不影响平衡。
const elseAt = src.indexOf('else if (scene && frameTimes.length)', bodyStart)
const braceAt = elseAt < 0 ? -1 : src.indexOf('{', elseAt)
let depth = 0
let bodyEnd = -1
for (let i = braceAt; i >= 0 && i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i + 1; break } }
}
const anchorOk = bodyStart >= 0 && elseAt > bodyStart && braceAt > elseAt && bodyEnd > braceAt
const body = anchorOk ? src.slice(bodyStart, bodyEnd) : ''

const drawCalls = []
const ffExec = (_bin, argv) => {
  const i = argv.indexOf('-ss')
  drawCalls.push(i >= 0 ? String(argv[i + 1]) : '<no-ss>')
}
const track = () => {}
const sceneTimes = () => ({ times: [], ok: true, why: '' })

let threw = false
let msg = ''
let frameTimesLen = -1
let hasUndefined = false

if (anchorOk) {
  const names = ['sceneTimes', 'pickEvenly', 'track', 'ffExec', 'join', 'dir', 'bv', 'mp4', 'bin', 'v', 'safeStep', 'ffTimeoutMs', 'atTimes', 'scene', 'drawCalls']
  const vals = [sceneTimes, pickEvenly, track, ffExec, join, '<TMP>', 'BV-C216', '<TMP>/in.mp4', 'ffmpeg-unused', { dur: 60 }, 20, () => 1000, null, true, drawCalls]
  const fn = new Function(...names, `${body}\nreturn { frameTimes, sceneTh, drawCalls, hasUndefined: frameTimes.some((t) => t === undefined) }`)
  try {
    const out = fn(...vals)
    frameTimesLen = out.frameTimes.length
    hasUndefined = out.hasUndefined
  } catch (e) {
    threw = true
    msg = String((e && e.message) || e)
  }
}

console.log(JSON.stringify({
  anchorOk,
  srcHasContinue: /if \(pts\.length === 0\) continue/.test(body),
  threw,
  msg,
  frameTimesLen,
  drawCalls: drawCalls.length,
  ssValues: drawCalls.slice(0, 3),
  hasUndefined,
}))
