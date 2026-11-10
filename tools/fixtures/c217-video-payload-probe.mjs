// C217/A4：comments 与 danmaku 的 json payload 补 video 元信息。
// 把源码里三处 payload 字面量**原样切出**在 vm 里求值，验键集合与既有键；
// 基准 videoMeta 直接 import 真跑（与 sub/text 六处出口同一个函数）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { videoMeta } from '../../lib/video-meta.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'tools', 'look.mjs'), 'utf8')
const lines = src.split(/\r?\n/)

const candidates = []
lines.forEach((l, i) => {
  if (!/\{\s*ok:\s*(true|false),\s*source: '(comments|danmaku)'/.test(l)) return
  const expr = l.slice(l.indexOf('{')).trim()
  const sandbox = {
    bv: 'BV-C217-TEST',
    v: { title: 'T', owner: 'U', dur: 60, p: 1, pages: [], cid: 999 },
    items: [{ t: 1 }],
    videoMeta,
  }
  let obj = null
  let error = ''
  try { obj = vm.runInNewContext(`(${expr})`, sandbox, { timeout: 2000 }) } catch (e) { error = String(e.message) }
  candidates.push({
    line: i + 1,
    usesVideoMeta: expr.includes('videoMeta(bv, v)'),
    keys: obj ? Object.keys(obj).sort().join(',') : '',
    videoKeys: obj && obj.video ? Object.keys(obj.video).sort().join(',') : '',
    hasLegacy: obj ? ['ok', 'source', 'bv', 'count', 'items'].every((k) => Object.prototype.hasOwnProperty.call(obj, k)) : false,
    error,
    expr: expr.slice(0, 160),
  })
})

// sub/text 六处出口共用 videoMeta，基准键集合直接真跑一次
const baseline = Object.keys(videoMeta('BV-X', { title: 'T', owner: 'U', dur: 1, p: 1, pages: [] })).sort().join(',')
const videoMetaCalls = (src.match(/video: videoMeta\(bv, v\)/g) || []).length
console.log(JSON.stringify({ count: candidates.length, candidates, baseline, videoMetaCalls }))
