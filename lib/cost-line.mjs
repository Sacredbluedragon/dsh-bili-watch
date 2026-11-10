// 0.4.9 C232：成本回报一行（耗时 · 帧数 · 字节 · 缓存命中）。
//
// 兼容口径（加字段＝兼容）：只**新增**一个 cost 字段与一行散文，不改任何既有字段的含义。
// 分母不可信时一律标估算：帧数是本次产出的张数，字节是文本字节数或产物字节数，
// 都不是「这次任务总消耗」，所以 estimated 恒为 true，除非调用方有硬数据。
//
// 纯函数：不读环境、不碰 IO、不自带时钟源以外的状态。
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0)

/**
 * @param {{t0?:number, frames?:number, bytes?:number, cached?:boolean, estimated?:boolean, now?:number}} o
 * @returns {{ms:number, frames:number, bytes:number, cached:boolean, estimated:boolean}}
 */
export function costOf(o = {}) {
  // t0 没传时 ms=0（不是「耗时为零」的假证据，而是「这次没记起点」）；
  //   刻意不在被测函数体里调 Date.now()，vm 切片夹具不必为此补环境。
  const now = o.now != null && Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now()
  const t0 = o.t0 != null && Number.isFinite(Number(o.t0)) ? Number(o.t0) : now
  return {
    ms: Math.max(0, Math.round(now - t0)),
    frames: num(o.frames ?? 0),
    bytes: num(o.bytes ?? 0),
    // 没拿到硬证据就留 null（人读写「未知」），不许把「不知道」写成「否」。
    cached: o.cached == null ? null : Boolean(o.cached),
    estimated: o.estimated == null ? true : Boolean(o.estimated),
  }
}

/** 人读的一行。估算必须出现在行内，不能只在 json 里标。 */
export function costProse(c) {
  if (!c || typeof c !== 'object') return ''
  const kb = c.bytes >= 1024 ? `${(c.bytes / 1024).toFixed(1)} KiB` : `${num(c.bytes)} B`
  const hit = c.cached == null ? '未知' : c.cached ? '是' : '否'
  return `成本：${(num(c.ms) / 1000).toFixed(1)}s · 帧 ${num(c.frames)} · ${kb} · 缓存命中 ${hit}${c.estimated ? '（估算）' : ''}`
}

/** 加字段专用的浅合并：绝不覆盖 payload 里已有的 cost。 */
export function withCost(payload, cost) {
  if (!cost || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  if ('cost' in payload) return payload
  return { ...payload, cost }
}
