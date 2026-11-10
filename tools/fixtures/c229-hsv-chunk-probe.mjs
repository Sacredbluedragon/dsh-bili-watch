#!/usr/bin/env node
/**
 * C229 / HSV 分段扫描取证夹具。stdout 只吐一个 JSON，判据不采信自述。
 *
 * 旧实现一次 execFileSync 收全片 rawvideo：160x90x3=43,200 B/帧 × 2 fps，
 * 64 MB maxBuffer 只够 1553 帧 ≈ 777 秒。DSH 在 800 秒纯色片上复现 ENOBUFS。
 * 本夹具造四组真实合成片（lavfi 纯色 concat，mpeg4、极短 GOP，生成 < 1 秒），
 * 全部用 method:'hsv' 真跑，逐组回传时间点列表与**实现自报的驻留统计**。
 *
 * 取证要点：
 *   · 30 分钟与 2 小时必须 ok:true 且切点数/位置与预期一致（旧实现会 ENOBUFS）
 *   · 800s / 30min / 2h 三组的同时驻留帧数与字节数不许随时长增长
 *   · chunks / totalFrames 用来交叉核对「自报的驻留峰值」不是恒 1 的假数
 *   · 静态守卫放最后，且刻意让行为断言先红
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sceneTimes, findFfmpeg } from '../../lib/media.mjs'
import { HSV_CHUNK_SEC } from '../../lib/scene-hsv.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const W = 160, H = 90, R = 2
const COLORS = ['red', 'green', 'blue']
const TH = 0.3

/** lavfi 纯色段 concat：不生成大 rawvideo，2 小时片实测 < 1 秒。相邻段颜色必不同。 */
function makeVideo(bin, out, segSec, segs) {
  const args = []
  for (let i = 0; i < segs; i++) {
    args.push('-f', 'lavfi', '-i', `color=c=${COLORS[i % 3]}:s=${W}x${H}:r=${R}:d=${segSec}`)
  }
  const labels = Array.from({ length: segs }, (_, i) => `[${i}:v]`).join('')
  args.push('-filter_complex', `${labels}concat=n=${segs}:v=1:a=0[out]`, '-map', '[out]',
    '-c:v', 'mpeg4', '-q:v', '2', '-g', '2', '-y', out)
  const t0 = Date.now()
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 180000 })
  return { rc: r.status, ms: Date.now() - t0, err: String(r.stderr || '').slice(-160) }
}

const expectedTimes = (segSec, segs) => Array.from({ length: segs - 1 }, (_, i) => (i + 1) * segSec)

const result = { videos: {}, runs: {}, expected: {}, stat: {} }
const tmp = mkdtempSync(join(tmpdir(), 'c229-hsv-'))
try {
  const cands = [process.env.BILI_WATCH_FFMPEG, join(ROOT, 'deps', 'ffmpeg.exe')].filter(Boolean)
  const bin = findFfmpeg(null, cands)
  if (!bin) {
    result.error = '本机找不到 ffmpeg（BILI_WATCH_FFMPEG / deps / PATH 三处都看了）'
  } else {
    // 段长 × 段数 = 总时长；换色点全落在段边界
    const specs = [
      { key: 'short', file: 'v6.mp4', segSec: 1, segs: 6 },
      { key: 's800', file: 'v800.mp4', segSec: 100, segs: 8 },
      { key: 's1800', file: 'v1800.mp4', segSec: 300, segs: 6 },
      { key: 's7200', file: 'v7200.mp4', segSec: 300, segs: 24 },
    ]
    for (const s of specs) {
      result.expected[s.key] = expectedTimes(s.segSec, s.segs)
      result.videos[s.key] = makeVideo(bin, join(tmp, s.file), s.segSec, s.segs)
    }
    for (const s of specs) {
      const stats = []
      const t0 = Date.now()
      const r = sceneTimes(join(tmp, s.file), TH, bin, { method: 'hsv', onStats: (x) => stats.push(x) })
      result.runs[s.key] = {
        ok: r.ok, why: r.why, times: r.times, count: r.times.length,
        ms: Date.now() - t0, stats: stats[0] || null,
      }
    }
    // 静态守卫放最后：扰动 A 会同时打红「旧 maxBuffer 回来」，但行为断言必须先红。
    const lib = read('lib/scene-hsv.mjs')
    const media = read('lib/media.mjs')
    result.stat = {
      chunkSecValue: HSV_CHUNK_SEC,
      chunkConst: /export const HSV_CHUNK_SEC = \d+/.test(lib),
      hasSeekAndLimit: lib.includes("'-ss'") && lib.includes("'-t'"),
      maxBufferFromChunk: lib.includes('maxBuffer: maxChunkBytes'),
      noOldMaxBuffer: !lib.includes('64 * 1024 * 1024'),
      onStatsPassthrough: media.includes('onStats, chunkSec'),
    }
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify(result, null, 2))
