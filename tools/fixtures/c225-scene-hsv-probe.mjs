#!/usr/bin/env node
/**
 * C225 / HSV 网格分取证夹具。stdout 只吐一个 JSON，判据不采信自述。
 *
 * 真跑对照（1720 段 §二最严格那条）：
 *   A 纯色切换（黑↔白，5 个切点）：HSV 与 scdet 都要中
 *   B 同亮度不同色（#C00000 ↔ #0000C0，5 个切点）：HSV 中、scdet 不中
 * 两边各自的时间点列表原样回传，不许只报一句「HSV 更好」。
 * 另验：纯函数逐格距离、auto 成功不回落、HSV 失败回落 scdet 并通知调用方、
 *       坏 ffmpeg 路径两种路都失败但通知仍到、静态接线。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sceneTimes, findFfmpeg } from '../../lib/media.mjs'
import { rgbToHsv, hsvGridHistogram, hsvFrameDistance } from '../../lib/scene-hsv.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const W = 160, H = 90, FPS = 25, SEC = 1

/** 用 rawvideo stdin 造一段纯色切换片；不依赖 lavfi 的 geq / concat / 特定编码器特性。 */
function makeVideo(bin, out, colors) {
  const FS = W * H * 3
  const perSeg = SEC * FPS
  const buf = Buffer.alloc(FS * perSeg * colors.length)
  for (let s = 0; s < colors.length; s++) {
    const [r, g, b] = colors[s]
    for (let f = 0; f < perSeg; f++) {
      const off = (s * perSeg + f) * FS
      for (let p = 0; p < W * H; p++) {
        buf[off + p * 3] = r; buf[off + p * 3 + 1] = g; buf[off + p * 3 + 2] = b
      }
    }
  }
  const r = spawnSync(bin, [
    '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'mpeg4', '-q:v', '2', '-y', out,
  ], { input: buf, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
  return { rc: r.status, err: String(r.stderr || '').slice(0, 200) }
}

const fill = (r, g, b, w, h) => {
  const buf = Buffer.alloc(w * h * 3)
  for (let p = 0; p < w * h; p++) { buf[p * 3] = r; buf[p * 3 + 1] = g; buf[p * 3 + 2] = b }
  return buf
}

const result = { videos: {}, runs: {}, pure: {}, fallback: {}, stat: {} }
const tmp = mkdtempSync(join(tmpdir(), 'c225-hsv-'))
try {
  const cands = [process.env.BILI_WATCH_FFMPEG, join(ROOT, 'deps', 'ffmpeg.exe')].filter(Boolean)
  const bin = findFfmpeg(null, cands)
  if (!bin) {
    result.error = '本机找不到 ffmpeg（BILI_WATCH_FFMPEG / deps / PATH 三处都看了）'
  } else {
    const A = join(tmp, 'plain.mp4')
    const B = join(tmp, 'hue.mp4')
    const C = join(tmp, 'spec-red-blue.mp4')
    // 6 段 × 1 秒 = 5 个切点（t=1..5）
    const plain = [[0, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255]]
    // 规格举例 #C00000 ↔ #0000C0 的 Y 差是 35.5/255，scdet 在 th=0.3 下照样 5/5 全中
    // （见 spec 组实测），所以它不算「同亮度」。B 组改用 Y 差 0.1/255 的红 ↔ 绿 #006200。
    const hue = [[192, 0, 0], [0, 98, 0], [192, 0, 0], [0, 98, 0], [192, 0, 0], [0, 98, 0]]
    const spec = [[192, 0, 0], [0, 0, 192], [192, 0, 0], [0, 0, 192], [192, 0, 0], [0, 0, 192]]
    result.videos = { a: makeVideo(bin, A, plain), b: makeVideo(bin, B, hue), c: makeVideo(bin, C, spec) }

    const th = 0.3
    const run = (file, opts) => {
      const r = sceneTimes(file, th, bin, opts)
      return { times: r.times, ok: r.ok, why: r.why, count: r.times.length }
    }
    // 两边各自的时间点列表，四组全给，不许只给命中数
    result.runs = {
      th,
      plainScdet: run(A, { method: 'scdet' }),
      plainHsv: run(A, { method: 'hsv' }),
      plainAuto: run(A),
      hueScdet: run(B, { method: 'scdet' }),
      hueHsv: run(B, { method: 'hsv' }),
      hueAuto: run(B),
      // 阈值传导：0.99 这条门槛下旧路与新路都必须一个点都不留
      plainHighScdet: (() => { const r = sceneTimes(A, 0.99, bin, { method: 'scdet' }); return { times: r.times, count: r.times.length } })(),
      plainHighHsv: (() => { const r = sceneTimes(A, 0.99, bin, { method: 'hsv' }); return { times: r.times, count: r.times.length } })(),
    }
    // 规格原例红↔蓝单独留一组：th=0.3 两边都中（这就是它不能当「同亮度」基准的原因），
    // th=0.5 时 scdet 归零而 HSV 仍全中。如实记，不为了凑绿去改颜色后假装没这回事。
    const specAt = (th2, method) => {
      const r = sceneTimes(C, th2, bin, { method })
      return { times: r.times, count: r.times.length }
    }
    result.spec = {
      th03Scdet: specAt(0.3, 'scdet'), th03Hsv: specAt(0.3, 'hsv'),
      th05Scdet: specAt(0.5, 'scdet'), th05Hsv: specAt(0.5, 'hsv'),
      yGap: 35.5,
    }
    // auto 成功时不该回落：结果应与强制 hsv 逐字一致（赋值后比，别在字面量里自指）
    result.runs.autoEqualsHsv = JSON.stringify(result.runs.plainAuto.times) === JSON.stringify(result.runs.plainHsv.times)
    result.runs.hueAutoEqualsHsv = JSON.stringify(result.runs.hueAuto.times) === JSON.stringify(result.runs.hueHsv.times)

    // 纯函数：同色零距离、换色 16 格全超阈；RGB→HSV 的基本值也对得上
    const w = 16, h = 12
    const red = fill(192, 0, 0, w, h)
    const green = fill(0, 98, 0, w, h)
    const redAgain = fill(192, 0, 0, w, h)
    const dChange = hsvFrameDistance(hsvGridHistogram(red, w, h), hsvGridHistogram(green, w, h), 0.15)
    const dSame = hsvFrameDistance(hsvGridHistogram(red, w, h), hsvGridHistogram(redAgain, w, h), 0.15)
    const [h0, s0, v0] = rgbToHsv(192, 0, 0)
    result.pure = {
      change: dChange, same: dSame,
      h0: Math.round(h0), s0: Number(s0.toFixed(3)), v0: Number(v0.toFixed(3)),
    }

    // 回落：把 HSV 打坏（注入桩），auto 必须拿出与旧路逐字一致的 times，并通知调用方
    const notes = []
    const stubbed = sceneTimes(A, th, bin, {
      hsv: () => ({ times: [], ok: false, why: '桩：HSV 抽帧失败' }),
      onFallback: (why) => notes.push(why),
    })
    // 坏 ffmpeg 路径：两路都失败，但回落通知仍要发出来
    const hardFail = sceneTimes(A, th, join(tmp, 'no-such-ffmpeg'), {
      onFallback: (why) => notes.push(why),
    })
    result.fallback = {
      stubTimes: stubbed.times,
      scdetTimes: result.runs.plainScdet.times,
      stubEqualsScdet: JSON.stringify(stubbed.times) === JSON.stringify(result.runs.plainScdet.times),
      stubOk: stubbed.ok,
      notes,
      hardFailOk: hardFail.ok,
      hardFailTimes: hardFail.times,
      hardFailWhy: hardFail.why,
    }

    // 静态接线（判据放最后）
    const media = read('lib/media.mjs')
    const look = read('tools/look.mjs')
    const lib = read('lib/scene-hsv.mjs')
    result.stat = {
      autoDefault: media.includes("method = 'auto'"),
      scdetBranch: media.includes("if (method === 'scdet') return scdetTimes(file, th, bin)"),
      hsvBranch: media.includes("method === 'hsv'"),
      onFallback: media.includes('onFallback(h.why'),
      warnTrack: /⚠ HSV 网格分失败，回落 scdet/.test(look),
      libPure: lib.includes('export function hsvGridHistogram') && lib.includes('export function hsvFrameDistance'),
      noExecutorInLib: !/\bexecFileSync\s*\(/.test(lib),
    }
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify(result, null, 2))
