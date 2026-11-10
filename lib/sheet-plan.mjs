// 0.4.9 C224：sheet --dry-run 的「出计划不出图」纯函数。
// 不碰 ffmpeg、不下载、不写盘；只按格子数与时长算出将要做什么。
// token 一行必须带「估」并写明估算依据（按 1600x900 单图 700 token、成图面积折算），
// 不许给一个看起来精确的实测数。
export function sheetPlan({ bv, grid = '3x3', dur = null, out = '<未指定>', manifestPath = null } = {}) {
  const [cols, rows] = String(grid).toLowerCase().split('x').map(Number)
  const n = (cols || 0) * (rows || 0)
  const d = Number(dur) > 0 ? Number(dur) : null
  const cellSec = d ? +(d / n).toFixed(1) : null
  // 时间点取每格中心，均匀铺满整条时长
  const times = d ? Array.from({ length: n }, (_, i) => +(((i + 0.5) * d) / n).toFixed(1)) : []
  // C240：成图是**一张**（tools/look.mjs 拼图用 scale=640:-1,tile=colsxrows），
  //   按 16:9 源视频每格 640×360 → 3×3 成图 1920×1080、4×4 成图 2560×1440。
  //   以「1600×900 单图约 700 token」为基准按**面积**折算，不再按格子数线性外推：
  //   旧式 (n*700)/3 在 9 格时报 2100，面积口径约 1000，高估 2.08 倍。
  //   这是估算不是测量，所以取整到百位、带「约」、并在行尾写明依据。
  const area = (cols * 640) * (rows * 360)
  const token = Math.round((700 * area) / (1600 * 900) / 100) * 100
  const lines = [
    `[dry-run] 视频 ${bv} 时长 ${d ? `${d}s` : '未知（离线，未取元数据）'} → ${n} 格 / ${grid} / 每格 ${cellSec == null ? '未知' : `${cellSec}s`}`,
    d
      ? `[dry-run] 将抽帧时间点：${times.map((t) => `${t.toFixed(1)}s`).join(' ')}（共 ${n} 个）`
      : `[dry-run] 将抽帧时间点：按 ${n} 等分（时长未知，给 --dur 秒数可看绝对时刻）`,
    // C219：dry-run 也点名格位索引路径，但必须说清「不落盘」—— 否则指向一个不存在的文件，
    // 正是 C219 要修的「写了却不说」反过来变成「说了却没有」。
    `[dry-run] 将拼成：${cols}×${rows} 格（tile 每格宽 640，成图尺寸按源视频比例估） → 输出 ${out}${manifestPath ? `；格位索引将写 ${manifestPath}（dry-run 不落盘）` : ''}`,
    `[dry-run] 预计 token：约 ${token}（按 1600x900 单图 700 token、成图面积折算估）`,
  ]
  return { lines, n, cols, rows, times, cellSec, token, dur: d }
}
