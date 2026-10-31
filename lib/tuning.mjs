/**
 * 参数分层（2026-10-28 阶段B）：面板可调的数值全部并进 deps\deps-config.json，
 * 不新开第四份配置文件。优先级 CLI flag > deps-config.json > 这里的常量默认。
 *
 * 2026-10-31 切片 3：这份表原来在 index.js 与 tools/look.mjs 各写一遍，靠 `C17` 断言逐键比对
 *   绑在一起。两份表 + 一条「必须一致」的断言，等于用守卫替代单一来源——真有人只改一边，
 *   C17 会红，但红的时候已经有人改错了一版。现在物理上只有一份，两个进程各自 import。
 *
 * 本模块是**纯**的：不读盘、不碰 CACHE、不写模块级状态。读盘由调用方做（index.js 的 depsCfg()、
 * tools/look.mjs 的 readDepsCfg()），传进来的 cfg 对象就是全部输入。
 */

export const TUNING_DEFS = {
  asrMaxSec: { def: 1800, min: 300, max: 3600 },
  maxFrames: { def: 500, min: 100, max: 1000 },
  asrTimeoutSec: { def: 900, min: 300, max: 3600 },
  ffmpegTimeoutSec: { def: 300, min: 60, max: 1800 },
  cmdTimeoutSec: { def: 180, min: 60, max: 900 },
  // 2026-10-28 老大要求「高级设置放开，能调的都给调」：下面 8 项原来是硬编码。
  // 全部整数（tuneOne 会 Math.floor，别写小数）。
  asrMemMB: { def: 1536, min: 512, max: 16384 },   // 跑本地转写要多少可用内存（MB），不够就跳
  lockTtlMin: { def: 30, min: 5, max: 240 },       // 残留锁多久算过期（分钟）
  unitLimit: { def: 5000, min: 1000, max: 20000 }, // 单个内容单元（字幕段/评论）字符上限
  textLimit: { def: 800, min: 200, max: 5000 },    // 文本层默认给多少字
  toolTextCap: { def: 2000, min: 500, max: 12000 },// 工具层单次回给模型的总字数（调大会挤占对话上下文）
  toolHead: { def: 800, min: 200, max: 5000 },     // 工具层默认 head 字数
  dmBucketSec: { def: 30, min: 5, max: 120 },      // 弹幕热区按多少秒一桶
  dmTop: { def: 5, min: 1, max: 20 },              // 弹幕热区取前几桶
  // 2026-10-28 第二批 3 项：都是「撞上了只能报 bug、自己没法自救」的。
  // 语速用 ×10 整数存（20 = 2.0 字/秒），因为 tuneOne 会 Math.floor，不能写小数。
  downloadMaxMB: { def: 512, min: 64, max: 4096 }, // 单个视频/音频下载上限（4K 素材会撞）
  subRateMin10: { def: 20, min: 5, max: 60 },      // 字幕语速下限×10，低于判「可疑」
  subRateMax10: { def: 85, min: 30, max: 200 },    // 字幕语速上限×10，高于判「可疑」
  textBrief: { def: 400, min: 100, max: 3000 },    // 超长文本只给开头多少字（其余落盘）
  // 第十条（2026-10-29）：ASR 推理设备。枚举项不走数值钳制（tuneOne 先看 kind）。
  //   只有 auto / cpu 两态：auto = 有可用 CUDA 就用、失败回落 CPU（_bili-asr.py 里实现）。
  //   不暴露 cuda 是因为「强制 cuda」在没有 GPU 的机器上只会多一次失败日志，没有收益。
  asrDevice: { def: 'auto', kind: 'enum', values: ['auto', 'cpu'] },
}

export const TUNING_KEYS = Object.keys(TUNING_DEFS)

export const tuningDefaults = () => Object.fromEntries(TUNING_KEYS.map((k) => [k, TUNING_DEFS[k].def]))

// 第十条（2026-10-29）：枚举项（asrDevice）的「范围」是可选值数组，不是 [min, max]
export const tuningRanges = () =>
  Object.fromEntries(TUNING_KEYS.map((k) => [k, TUNING_DEFS[k].kind === 'enum' ? TUNING_DEFS[k].values : [TUNING_DEFS[k].min, TUNING_DEFS[k].max]]))

/**
 * 单个键的钳制：非法 / 超界 / 非数字一律静默回落默认值，不抛错、不中断命令。
 * 原来叫 tuneOne（index.js）和 clampTuning（tools/look.mjs），两份实现逐字同义——
 * 现在只留这一个名字，两个入口都走它。
 */
export function tuneOne(key, raw) {
  const d = TUNING_DEFS[key]
  // 第十条（2026-10-29）：枚举项不走数值钳制，否则 Math.floor('auto') = NaN
  if (d.kind === 'enum') {
    const s = String(raw ?? '').trim().toLowerCase()
    return d.values.includes(s) ? s : d.def
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return d.def
  if (n < d.min || n > d.max) return d.def
  return Math.floor(n)
}

/** cfg（deps-config.json 的对象）→ 全量调优值。缺键/坏值都回落到 TUNING_DEFS 的默认值。 */
export function normalizeTuning(cfg) {
  const out = {}
  for (const k of TUNING_KEYS) out[k] = tuneOne(k, cfg?.[k])
  return out
}

/**
 * 锁过期时长（毫秒）。放在这里而不是 lib/locks.mjs：它读的是配置语义，不是锁判据。
 *
 * X-14（2026-10-29）：TTL 还必须覆盖一次最长转写——asrTimeoutSec 上限 60 分钟 >
 *   默认 TTL 30 分钟，转写跑满时锁先被判过期、别的进程抢进来 → 双持。所以取两者较大值。
 *
 * 切片 2 时它被留在两个入口文件里（因为两边读盘函数名不同：readTuning / tuning），
 * 于是 lib/locks.mjs 只能收一个 ttlMs 参数——参数洞就是这么来的。切片 3 把算式收到这里，
 * 两个入口只负责「把配置读出来」这一件事，算式不再有第二份。
 */
export const lockTtlMsOf = (t) =>
  Math.max(t.lockTtlMin * 60 * 1000, (t.asrTimeoutSec + 120) * 1000)
