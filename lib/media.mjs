/**
 * lib/media.mjs —— 外部进程层：调 ffmpeg 的两个原语
 *
 * 2026-10-31 切片 9 第一步。DSH 18:48 / 20:05 排的依赖链：
 *   cli-io → api → media → asr-ocr → text-out → 15 个 commands → 剩薄分发
 * media 这一片最终要装的是 downloadTo / cachedMp4 / sceneTimes / peekFrames / grabFrames；
 * 先把「怎么起一个外部进程、怎么找 ffmpeg」这两件最底层的事搬出来，因为上面五个全靠它们。
 *
 * 为什么先搬这两个、并且先补断言：`ffExec` 的第三参数**两种形状都收**（数字=超时 / 对象=options），
 *   这是 N-04 批量替换时留下的兼容口。它坏掉的样子不是报错，是**静默错**：
 *   只按数字处理 → 调用方传的 encoding 丢了 → sceneTimes 拿到 Buffer → matchAll 抛错被 catch 成 []
 *   → 「场景检测永远没结果」，不红、不报、只是空。所以断言必须打在真实进程上，不能只断源码里有这行。
 *
 * 规矩（与 lib 其他文件一致）：
 *   1. 不打印任何东西——用户看到的那句「ffmpeg 失败：…」由调用方 say/warn，lib 只负责抛。
 *   2. 不 import tools/ 下的模块。
 *   3. 只有入口才知道的东西走参数：`findFfmpeg(arg, extra)` 的 extra 是候选列表
 *      （环境变量 BILI_WATCH_FFMPEG、deps 目录、--ffmpeg 由谁先谁后，是入口的知识）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * N-04（2026-10-29）：ffmpeg 调用统一走这里。
 * 以前抽帧那几处是 stdio:'ignore'——ffmpeg 失败时 stdout/stderr 全丢，用户只看到「抽帧失败」或空错误，
 * 分不清是源流坏了、参数不对还是磁盘满。现在把 stderr 尾部三行拼进 Error。
 *
 * 第三参数**两种都收**（这条必须保留）：
 *   · 数字 = 超时毫秒（抽帧那几处就这么传）
 *   · 对象 = 原样透传给 execFileSync 的 options
 * 为什么：N-04 是把 7 处 execFileSync 批量换成 ffExec 的，其中 4 处第三参数本来就是
 *   options 对象（sceneTimes / 取音轨 ×2 / fetchGenericMeta）。只按数字处理会把
 *   encoding、maxBuffer、调用方指定的 stdio 全部丢掉——后果不是报错而是**静默错**：
 *   sceneTimes 拿到 Buffer 后 matchAll 抛错被 catch 成 []（场景检测永远没结果）、
 *   fetchGenericMeta 的 16 MB maxBuffer 退回默认 1 MB（大 JSON 直接 ENOBUFS）。
 */
export function ffExec(bin, args, timeoutOrOpts) {
  const isOpts = timeoutOrOpts && typeof timeoutOrOpts === 'object'
  const opts = isOpts ? { ...timeoutOrOpts } : { timeout: timeoutOrOpts || 0, encoding: 'utf8' }
  if (!opts.stdio) opts.stdio = ['ignore', 'pipe', 'pipe']
  try {
    return execFileSync(bin, args, opts)
  } catch (e) {
    const tail = String(e?.stderr || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' / ')
    const err = new Error('ffmpeg 失败：' + (tail || String(e?.message || e)).slice(0, 300))
    err.code = e?.code
    throw err
  }
}

/**
 * 找 ffmpeg：按 arg（--ffmpeg）→ extra（环境变量 / deps 目录）→ PATH 里的 'ffmpeg' 依次试。
 * 判据是**能跑通 `-version`**，不是「文件存在」——存在但跑不起来的路径（少了 dll、权限不对）
 * 如果被当成可用，后面每一次抽帧都会失败，而且错在抽帧那一层，不在探测这一层。
 * 顺带把「探测」和「使用」绑成同一个二进制：探测过的路径就是返回的路径。
 *
 * 第三参数 probeArgs 是「拿什么命令判它活着」。ffmpeg 的事实是 `-version`，所以默认值就是它；
 * 摆成参数是因为**这条判据要能被断言**，而跑断言的机器上一定有 node、不一定有 ffmpeg
 * （node 不认 `-version`，实测 rc=9；要拿它当被测二进制就必须换探测参数）。
 */
export function findFfmpeg(arg, extra = [], probeArgs = ['-version']) {
  const cands = [arg, ...extra, 'ffmpeg'].filter(Boolean)
  for (const c of cands) {
    if (c !== 'ffmpeg' && !existsSync(c)) continue
    try {
      execFileSync(c, probeArgs, { stdio: 'ignore', timeout: 300000 })
      return c
    } catch { /* 试下一个 */ }
  }
  return null
}

// ── 切片 9 第二步：抽帧/下载的原语（原 look.mjs 420/433/648/639/591/551/560 行）──────
// 这一批全是「纯逻辑 + 文件/网络」的东西，没有任何一处要打印，也没有一处需要知道
// 「缓存根在哪、上限多少、UA 是什么」——那三样各自走参数，入口保持不变。

/**
 * 画面变化点检测：空跑一次 ffmpeg，抓 pts_time。返回秒数列表。
 * 失败返回 []（调用方据此回落等间隔），不抛——这是探测，不是主流程。
 * 注意 ffExec 的第三参数必须是**对象**：这里要 encoding:'utf8' 与 16 MB maxBuffer，
 *   只按数字处理会让它拿到 Buffer → matchAll 抛错被这里的 catch 吃掉 → 恒返回 []。
 */
export function sceneTimes(file, th, bin) {
  try {
    const out = ffExec(bin, ['-hide_banner', '-threads', '2', '-i', file, '-vf',
      `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
    return [...new Set(ts)].filter((t) => t > 0.2)
  } catch { return [] }
}

export const pickEvenly = (list, n) =>
  n <= 1 ? [list[0]] : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))])

/**
 * 下载先写 .part 再原子改名：中断/并发都不会留下「看起来像完整的半截文件」。
 *
 * 入口知识三样走参数（lib 不读配置、不带 UA）：
 *   headers   调用方给的请求头（UA / Referer / Cookie 全是入口的事）
 *   maxBytes  体积上限（来自 tuning().downloadMaxMB）——**上限与文案必须同一个来源**：
 *             原来文案里写死「512 MB」，用户把上限改成 100 MB 后报错仍说 512 MB，
 *             人会以为设置没生效。这里由 maxBytes 算出 capLabel，改配置文案跟着变。
 *   onNetError 网络层错误翻译（lib/bili-api 的 friendlyNetError），保持错误链不变。
 */
export async function downloadTo(url, dest, { headers = {}, maxBytes = 512 * 1024 * 1024, onNetError = (e) => e, timeoutMs = 120000 } = {}) {
  const part = `${dest}.part`
  const mb = 1024 * 1024
  const capLabel = maxBytes % mb === 0 ? `${maxBytes / mb} MB` : `${maxBytes} B`
  let r
  try {
    r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw onNetError(e, url)
  }
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
  // B13：风控会返 HTTP 200 + 登录页/验证页 HTML，content-length 也像模像样——按类型拦，别把网页存成 mp4
  const ct = String(r.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/plain')) {
    throw new Error(`触发风控：返回的不是视频流而是「${ct || '未知类型'}」，多半被 B 站拦成网页/验证页`)
  }
  const len = Number(r.headers.get('content-length') || 0)
  if (len > maxBytes) throw new Error(`下载太大（Content-Length ${len} B，上限 ${capLabel}）`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > maxBytes) throw new Error(`下载太大（${buf.length} B，上限 ${capLabel}）`)
  if (buf.length < 1024) throw new Error(`下载内容太小（${buf.length} B），多半被拒`)
  writeFileSync(part, buf)
  renameSync(part, dest)
}

/**
 * 便宜的预判：从缓存里找本 P 已经下过的 mp4。
 * base 由入口给（缓存根的 frames 子目录），lib 不读环境变量。
 * 只认本 P 的目录（多 P 视频抽帧目录名是 `${bv}-p${page}-...`），别把 P1 的画面当成 P2；
 * 小于 1 KB 的不算（半截文件/占位）。
 */
export function cachedMp4(base, bv, page = 1) {
  if (!existsSync(base)) return null
  for (const d of readdirSync(base)) {
    if (!d.startsWith(`${bv}-p${page}-`)) continue
    const f = join(base, d, `${bv}.mp4`)
    if (existsSync(f) && statSync(f).size > 1024) return f
  }
  return null
}

// 抽帧间隔按视频时长自适应：短频密一点，长频疏一点（帧越多 OCR 越吃 CPU）
export function autoStep(dur) {
  if (!dur || dur <= 0) return 2
  if (dur > 900) return 20
  if (dur > 300) return 10
  if (dur > 120) return 5
  return 2
}

// A3：--at 参数解析。支持两种形状：
//   750,760,830   多个时间点（秒，逗号分隔）
//   12:30-13:10   区间（端点都含，按 step 密度走）
// 时间格式容错：12:30 / 12:3 都当 12 分 30 秒；abc 直接报错
export function parseAtTimes(atStr, dur, step) {
  if (!atStr) return null
  const result = []
  const parts = String(atStr).split(',')
  for (const part of parts) {
    const s = part.trim()
    if (!s) continue
    // 区间：12:30-13:10
    const rangeMatch = s.match(/^(\d+):(\d+(?:\.\d+)?)-(\d+):(\d+(?:\.\d+)?)$/)
      || s.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      let startSec, endSec
      if (rangeMatch[3] !== undefined) {
        // mm:ss-mm:ss
        startSec = parseInt(rangeMatch[1]) * 60 + parseFloat(rangeMatch[2])
        endSec = parseInt(rangeMatch[3]) * 60 + parseFloat(rangeMatch[4])
      } else {
        // sec-sec
        startSec = parseFloat(rangeMatch[1])
        endSec = parseFloat(rangeMatch[2])
      }
      if (startSec > endSec) throw new Error(`--at 区间起点大于终点：${s}`)
      if (startSec < 0) startSec = 0
      if (endSec > dur) endSec = dur
      // 按 step 密度走
      const useStep = step > 0 ? step : 5
      for (let t = startSec; t <= endSec + 0.001; t += useStep) {
        result.push(Math.round(t))
      }
      continue
    }
    // 单时间点：12:30 或 750
    const timeMatch = s.match(/^(\d+):(\d+(?:\.\d+)?)$/)
    const secMatch = s.match(/^(\d+(?:\.\d+)?)$/)
    if (timeMatch) {
      result.push(Math.round(parseInt(timeMatch[1]) * 60 + parseFloat(timeMatch[2])))
    } else if (secMatch) {
      result.push(Math.round(parseFloat(secMatch[1])))
    } else {
      throw new Error(`--at 时间格式错：${s}（支持 750 / 12:30 / 12:30-13:10）`)
    }
  }
  // 去重 + 排序
  const uniq = [...new Set(result)].sort((a, b) => a - b)
  return uniq.length ? uniq : null
}

// P0（2026-10-30）：--at 模式的目录名。原来只带「点数」（at-1p），--at 460 与 --at 750 撞同一目录，
//   第二次直接复用第一次的帧且 rc=0（用户要 12:30，给的是 07:40）。
//   现在带时刻集合的 sha1 前 8 位：目录名长度可控（50 个点也不会炸 Windows 路径长度），不同时刻必然不同目录。
export function atDirTag(atTimes) {
  if (!atTimes) return null
  return `at-${atTimes.length}p-${createHash('sha1').update(atTimes.join(',')).digest('hex').slice(0, 8)}`
}

// P0（2026-10-30）：帧缓存是否可复用。抽成顶层函数是为了能被 verify.mjs 真跑（造 manifest 喂进去看结果），
//   而不是 grep 字符串——①② 能在 60 条全绿下溜进来，根因就是断言没牙。
//   at 模式下 step/scene 恒定，唯一能区分两次请求的就是 times；非 at 模式 atTimes=null，
//   老 manifest（没 times 字段）也要照样命中，不然升级后所有老缓存都白抽。
export function framesCacheHit(m0, safeStep, scene, atTimes, nJpg) {
  if (!m0?.ok) return false
  if (m0.step !== safeStep || m0.scene !== scene) return false
  if (JSON.stringify(m0.times ?? null) !== JSON.stringify(atTimes ?? null)) return false
  return nJpg > 0
}
