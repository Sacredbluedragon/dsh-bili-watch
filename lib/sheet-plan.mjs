// 0.4.9 C224：sheet --dry-run 的「出计划不出图」纯函数。
// 不碰 ffmpeg、不下载、不写盘；只按格子数与时长算出将要做什么。
// token 一行必须带「估」并写明估算依据（按 1600x900 单图 700 token、成图面积折算），
// 不许给一个看起来精确的实测数。
// 0844 任务 A：--grid 严格校验，抽成单一函数供 CLI 与纯函数共用，避免 dry-run/真跑分叉。
// 只接受 NxM 恰好两段、两段都是正整数且为安全整数。3x3x2 / 3x3abc / xx / 0x3 / 空 / 负数 全拒。
// 1121 任务 4：三档上限各管一件事，别混说成「格数由 maxFrames 夹住」——
//   ① 抽帧预算：lib/tuning.mjs:15 maxFrames（def 500 / max 1000）只夹真抽帧的帧数（tools/look.mjs `estFrames=dur/step`）；
//   ② 计划时间点上限：本文件 MAX_TIMEPOINTS=4096，只管 dry-run 展开，防失控分配；
//   ③ 成图软提醒：2.5 亿像素按 16:9 估算，只 warn 不拒绝，实际编码结果与原始错误由 ffmpeg 给出。
// 1003 任务 B：dry-run 也要防规模失控。两条独立约束——
//   ① 乘积必须是安全整数（防 cols*rows 溢出丢精度）；
//   ② 时间点展开有界（防 999x999 真建 998001 个数组元素 / 输出 6.8MB、99999x99999 崩在 Invalid array length）。
// 上界 4096 依据：合法网格明确到 10×10=100；成图实测 33×33=1089 可过、34×34=1156 失败，
//   4096 高于所有实测可成图网格（不误伤合法请求），又远低于 V8 数组上限 2^32-1（避 Invalid array length）。
//   4096 个时间点约 30KB，dry-run 有界可接受。
// 取舍：超限不整单拒绝（rc 语义保留），只把时间点数组与展示行截断为前 32 个 + "…共 N 个"；
//   真抽帧另受 maxFrames 闸夹住，成图能否成功由 ffmpeg 决定（成图尺寸另在 cmdSheet 做软预判）。
export const MAX_TIMEPOINTS = 4096
export const SHOW_TIMEPOINTS = 32

export function parseGrid(grid) {
  const g = String(grid ?? '').toLowerCase().trim()
  const m = /^(\d+)x(\d+)$/.exec(g)
  if (!m) return null
  const cols = Number(m[1])
  const rows = Number(m[2])
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) return null
  const n = cols * rows
  // 1003 任务 B：乘积也要是安全整数，否则 n 精度丢失、后续一切计算都不可信。
  if (!Number.isSafeInteger(n)) return null
  return { cols, rows, n }
}

// 1003 任务 B：区分「格式合法但乘积溢出」与「格式非法」——只有前者报规模错误，后者仍是格式错误。
//   0x3 / -1x3 这类因子非法的畸形 grid 必须继续报「格子格式」，不能被规模错误盖过去（C529 守）。
export function gridScaleOverflow(grid) {
  const g = String(grid ?? '').toLowerCase().trim()
  const m = /^(\d+)x(\d+)$/.exec(g)
  if (!m) return false
  const cols = Number(m[1])
  const rows = Number(m[2])
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) return false
  return !Number.isSafeInteger(cols * rows)
}

export function sheetPlan({ bv, grid = '3x3', dur = null, out = '<未指定>', manifestPath = null } = {}) {
  const parsed = parseGrid(grid)
  if (!parsed) {
    // 1003 任务 B：格式合法但乘积溢出 → 规模错误可读；否则才是格式错误。
    throw new Error(gridScaleOverflow(grid)
      ? '✗ 网格规模过大：格子数超出安全整数上限，请减小网格'
      : '✗ 格子格式应是 NxM（例如 3x3 / 4x4，两段都要正整数）')
  }
  const { cols, rows, n } = parsed
  const d = Number(dur) > 0 ? Number(dur) : null
  const cellSec = d ? +(d / n).toFixed(1) : null
  // 时间点取每格中心，均匀铺满整条时长。
  // 1003 任务 B：展开有界——合法网格（n≤4096）全量展开、契约不变；超大网格只建前 4096 个，
  //   避免 Invalid array length 与几 MB 输出；时间点按真实 n 计算，只截断个数不改分布口径。
  // 1121 任务 1：展示行必须跟 truncated 同步——合法网格展示全部 times，只有真截断才 slice 到前 32。
  //   旧版无条件 slice(0,32) 导致 10x10 只列 32 个却写「共 100 个」；C531 加展示行元素数断言守住。
  const showN = Math.min(n, MAX_TIMEPOINTS)
  const truncated = n > MAX_TIMEPOINTS
  const times = d ? Array.from({ length: showN }, (_, i) => +(((i + 0.5) * d) / n).toFixed(1)) : []
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
      ? `[dry-run] 将抽帧时间点：${(truncated ? times.slice(0, SHOW_TIMEPOINTS) : times).map((t) => `${t.toFixed(1)}s`).join(' ')}${truncated ? ` …共 ${n} 个（规模过大，仅列前 ${SHOW_TIMEPOINTS}）` : `（共 ${n} 个）`}`
      : `[dry-run] 将抽帧时间点：按 ${n} 等分${truncated ? '（规模过大，时间点不展开）' : ''}（时长未知，给 --dur 秒数可看绝对时刻）`,
    // C219：dry-run 也点名格位索引路径，但必须说清「不落盘」—— 否则指向一个不存在的文件，
    // 正是 C219 要修的「写了却不说」反过来变成「说了却没有」。
    `[dry-run] 将拼成：${cols}×${rows} 格（tile 每格宽 640，成图尺寸按源视频比例估） → 输出 ${out}${manifestPath ? `；格位索引将写 ${manifestPath}（dry-run 不落盘）` : ''}`,
    `[dry-run] 预计 token：约 ${token}（按 1600x900 单图 700 token、成图面积折算估）`,
  ]
  return { lines, n, cols, rows, times, cellSec, token, dur: d, truncated, area }
}
