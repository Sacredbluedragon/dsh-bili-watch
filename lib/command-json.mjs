// C220/A·B6：frames / ocr / sheet / substrip 的 --format json 新出口。
//
// 纪律：这是「加出口」，不是「改出口」。四条命令的既有散文一行都不动；
// json 模式下只把 console.log 临时收进内存，命令照常跑完，最后往 stdout
// 打一份结构化。散文原样收进 prose 字段，下游要人读的文本也不用另跑一次。
import { videoMeta } from './video-meta.mjs'

/** 大小写不敏感（与 T37a-C 的 --format JSON 口径一致）；其他值一律保持既有散文。 */
export function wantsCommandJson(opts) {
  return String(opts?.format ?? '').toLowerCase() === 'json'
}

/** 画面类命令共用的 json 形状：ok / source 必带，video 由 videoMeta 单点产出。 */
export function commandJsonPayload({ source, bv, v = null, detail = {}, prose = [] }) {
  const { ok = true, v: _dropV, offline = false, ...rest } = detail
  return { ok: Boolean(ok), source, video: v ? videoMeta(bv, v) : null, ...rest, offline, prose }
}

/**
 * 非 json 模式原样执行 fn；json 模式收集散文 + 输出结构化。
 * getVideo 只在需要视频元数据且命令没自报 offline 时才调，避免 dry-run 联网。
 */
export async function runCommandJson({ opts, source, bv, getVideo, fn }) {
  if (!wantsCommandJson(opts)) { await fn(); return false }
  const prose = []
  const origLog = console.log
  console.log = (...a) => { prose.push(a.map(String).join(' ')) }
  let thrown
  try { await fn() } catch (e) { thrown = e } finally { console.log = origLog }
  if (thrown) throw thrown
  const detail = { ...(opts?.result || {}) }
  const offline = detail.offline === true
  let v = detail.v ?? null
  delete detail.v
  delete detail.offline
  if (!v && !offline && typeof getVideo === 'function') {
    try { v = await getVideo() } catch { v = null }
  }
  // 失败路径（命令里设了 process.exitCode）不许还报 ok:true
  const ok = detail.ok !== false && !process.exitCode
  const payload = commandJsonPayload({ source, bv, v, detail: { ...detail, ok, offline }, prose })
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  return true
}
