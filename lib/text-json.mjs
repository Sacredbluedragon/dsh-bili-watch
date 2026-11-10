// C221/A·B7：printText 的散文落盘旁边，另落一份结构化副本。
// 纪律：只加文件，不改 `${kind}.txt` / `${kind}.wrapped.txt` 的任何写入内容。
import { writeFileSync, renameSync } from 'node:fs'

let seq = 0

/** `<kind>.txt` → `<kind>.json`；非 .txt 结尾不猜名字，直接报错。 */
export function textJsonPath(txtPath) {
  const p = String(txtPath)
  if (!p.endsWith('.txt')) throw new Error(`结构化副本只跟 .txt 同名：${p}`)
  return `${p.slice(0, -4)}.json`
}

/**
 * 键集合固定 { video, source, timeline, text, chars }，cues 有才加。
 * · video 只标归属（BV 号或本地文件 tag），不联网取元数据；
 * · timeline 留 null：散文正文没有机器可读时间轴，宁可留空也不编一个 exact。
 */
export function textJsonPayload({ bv, kind, text, cues = null }) {
  const payload = {
    video: bv,
    source: kind,
    timeline: null,
    text: String(text ?? ''),
    chars: String(text ?? '').length,
  }
  if (Array.isArray(cues) && cues.length) payload.cues = cues
  return payload
}

/** 与 printText 同款 tmp+rename：两个进程同时写也只会留下完整的一份。 */
export function writeTextJson(txtPath, payload) {
  const p = textJsonPath(txtPath)
  const tmp = `${p}.${process.pid}-${++seq}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
  return p
}

export function textJsonLine(p) {
  return `结构化: ${p}`
}
