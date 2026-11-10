/**
 * C225 / HSV 网格分：补 scdet 对「同亮度换色」失明的那一类切点（PPT 翻页）。
 *
 * 做法：低分辨率 2 fps 抽帧 → 每帧切 4x4 网格 → 每格算 H/S/V 各 8 bin
 * 的直方图 → 相邻帧逐格算归一化 L1 距离 → 超过阈值的格数够多就判变化。
 *
 * 与 lib/media.mjs 的边界：**这里不带执行器**。抽帧用的 ffmpeg 调用由调用方注入 run
 * （就是 media.mjs 的 ffExec），免得又多一处进程调用点，也方便判据把 run 打坏。
 * 纯计算部分（rgbToHsv / hsvGridHistogram / hsvFrameDistance）全部导出，可脱离 ffmpeg 单测。
 *
 * 阈值映射：scdet 的 th 是场景分（0..1），这里把它乘 0.5 当「逐格直方图距离」的门槛。
 * 这不是物理等价，是经验刻度：th=0.08 时 0.04、th=0.3 时 0.15、th=0.99 时 0.495。
 * 纯色换色的每格距离是 1/3（只有 H 通道变，S/V 都同 bin），所以 0.99 这条门槛
 * 与旧路一样「一个点都不留」，阈值传导没有断。真跑对照在 c225-scene-hsv-probe.mjs。
 */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** RGB(0..255) → HSV(h:0..360, s/v:0..1)。纯函数，没依赖，判据直接调。 */
export function rgbToHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
  let h = 0
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max]
}

/**
 * 一帧 RGB24 → grid² 格 × 3 通道 × bins 个直方柱，逐通道按格内像素数归一化。
 * 返回 Float32Array(grid*grid*3*bins)。格子边界用 floor 切，宽高不整除也不重叠不漏。
 */
export function hsvGridHistogram(rgb, width, height, grid = 4, bins = 8) {
  const cells = grid * grid
  const per = 3 * bins
  const out = new Float32Array(cells * per)
  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor((gy * height) / grid), y1 = Math.floor(((gy + 1) * height) / grid)
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * width) / grid), x1 = Math.floor(((gx + 1) * width) / grid)
      const base = (gy * grid + gx) * per
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * 3
          const [h, s, v] = rgbToHsv(rgb[p], rgb[p + 1], rgb[p + 2])
          out[base + clamp(Math.floor(h / (360 / bins)), 0, bins - 1)] += 1
          out[base + bins + clamp(Math.floor(s * bins), 0, bins - 1)] += 1
          out[base + 2 * bins + clamp(Math.floor(v * bins), 0, bins - 1)] += 1
          n++
        }
      }
      if (n) for (let k = 0; k < per; k++) out[base + k] /= n
    }
  }
  return out
}

/** 相邻两帧逐格距离。每通道用 0.5*L1（归一化后 0..1），三通道取平均；返回均值与超阈格数。 */
export function hsvFrameDistance(a, b, cut, grid = 4, bins = 8) {
  const cells = grid * grid, per = 3 * bins
  let sum = 0, changed = 0
  for (let c = 0; c < cells; c++) {
    let d = 0
    for (let k = 0; k < per; k++) d += Math.abs(a[c * per + k] - b[c * per + k])
    d = (d * 0.5) / 3
    sum += d
    if (d > cut) changed++
  }
  return { mean: sum / cells, changed, cells }
}

/** 每段扫描的时长（秒）。内存上界 = chunkSec * fps * frameSize，与视频总长无关。 */
export const HSV_CHUNK_SEC = 60

/**
 * 真抽帧 + 逐帧比对。失败不抛，返回与 sceneTimes 同形状的 { times, ok, why }。
 *
 * C229：改成按时间**分段**扫，不再把整段视频的 rawvideo 一次性读进内存。
 * 旧实现一次收全片 stdout：160x90x3 = 43,200 B/帧 × 2 fps，64 MB maxBuffer 只够
 * 1553 帧 ≈ 777 秒；13 分钟以上必然 ENOBUFS → ok:false → auto 静默回落 scdet，
 * 用户以为走了 HSV，实际是旧路（只有一行 ⚠，还没人看得见）。
 *
 * 三条候选里选「分段」而不是流式 / 临时文件，理由写清：
 *   · sceneTimes / grabFrames 整条消费链是同步的，改流式异步要动 4 处调用点，还要把
 *     C86 / C215 / C225 三条判据的同步 check() 拆成子进程 —— 那是顺手改行为，不是修 bug。
 *   · 流式要在 lib/scene-hsv.mjs 引入异步子进程调用（C227 刚把那类调用收进 lib/exec.mjs），
 *     还得处理 ffmpeg 提前退出、partial frame、背压；这些坑比 60 行分段循环贵得多。
 *   · 临时文件方案对 2 小时视频要落 622 MB 顺序写再读，换来的驻留上界与分段相同。
 *   · 分段的代价是 N 次 ffmpeg 进程（2 小时 / 60 秒 = 120 次），每次只吐 5.18 MB，
 *     且 -ss 前 + -t 的单段输出是确定的，不需要异步 IO。
 *
 * 切点跨段怎么合：prev 直方图跨段保留，段首帧拿上一段最后一帧当比较对象；
 * 时间戳用 start + i/fps 全局计时，不按段内重置。-ss 放 -i 前是快速 seek，
 * ffmpeg 默认 accurate_seek 会解码到精确位置；落点误差由判据在 30 分钟真片上限 < 1 秒验，
 * 不靠推断。onStats 只为判据取证（运行时不传），返回形状仍是 { times, ok, why }。
 *
 * @param {string} file 视频路径
 * @param {string} bin ffmpeg 路径
 * @param {{run:(bin:string,args:string[],opts:object)=>Buffer, fps?:number, width?:number, height?:number,
 *          grid?:number, bins?:number, th?:number, cellFactor?:number, minChangedRatio?:number,
 *          chunkSec?:number, onStats?:(s:object)=>void}} opts
 */
export function hsvSceneTimes(file, bin, opts = {}) {
  const {
    run, fps = 2, width = 160, height = 90, grid = 4, bins = 8,
    th = 0.3, cellFactor = 0.5, minChangedRatio = 0.25,
    chunkSec = HSV_CHUNK_SEC, onStats = null,
  } = opts
  if (typeof run !== 'function') throw new Error('hsvSceneTimes 需要 run(bin,args,opts)：本 lib 不自带执行器')
  const cut = th * cellFactor
  const frameSize = width * height * 3
  const chunkFrames = Math.ceil(chunkSec * fps)
  // fps 滤镜取整可能多吐 1 帧，留 2 帧余量；这是单段 maxBuffer 的**唯一**来源。
  const maxChunkBytes = (chunkFrames + 2) * frameSize
  const runOpts = { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: maxChunkBytes }
  const needChanged = Math.ceil(grid * grid * minChangedRatio)
  const times = []
  let prev = null
  let chunks = 0, totalFrames = 0, maxResidentFrames = 0, maxResidentBytes = 0

  for (let start = 0; ; start += chunkSec) {
    const args = ['-hide_banner', '-threads', '2']
    if (start > 0) args.push('-ss', String(start))
    args.push('-i', file, '-t', String(chunkSec), '-vf',
      `fps=${fps},scale=${width}:${height}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-')
    let raw
    try {
      raw = run(bin, args, runOpts)
    } catch (e) {
      // why 只带错误码：ffmpeg 的 message 里常带本机绝对路径，不能顺着日志出门。
      return { times: [], ok: false, why: `HSV 网格分抽帧失败（${e?.code || 'FFMPEG'}）` }
    }
    if (!Buffer.isBuffer(raw) || raw.length < frameSize) {
      if (chunks === 0) return { times: [], ok: false, why: 'HSV 网格分没拿到一帧完整的 rawvideo' }
      break // 扫过至少一段后拿到空段 = EOF
    }
    const frames = Math.floor(raw.length / frameSize)
    chunks++
    totalFrames += frames
    maxResidentFrames = Math.max(maxResidentFrames, frames)
    maxResidentBytes = Math.max(maxResidentBytes, raw.length)
    for (let i = 0; i < frames; i++) {
      const cur = hsvGridHistogram(raw.subarray(i * frameSize, (i + 1) * frameSize), width, height, grid, bins)
      if (prev) {
        const d = hsvFrameDistance(prev, cur, cut, grid, bins)
        const t = start + i / fps
        if (d.changed >= needChanged && t > 0.2) times.push(Number(t.toFixed(3)))
      }
      prev = cur
    }
    // 明显不足一整段 = 末段，省掉一次必然为空的 seek（容差 1 帧防 fps 取整误判）
    if (frames < chunkFrames - 1) break
  }
  if (typeof onStats === 'function') {
    onStats({ chunks, totalFrames, maxResidentFrames, maxResidentBytes, maxChunkBytes, chunkSec, fps })
  }
  return { times: [...new Set(times)], ok: true, why: '' }
}
