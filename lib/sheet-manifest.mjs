// 0.4.9 C219 / A6：拼图的格位索引写了却不说在哪。
// 抽成纯函数，判据能直接 import 真跑（真写盘 + existsSync），不必为了验证去真起 ffmpeg 拼图。
import { writeFileSync } from 'node:fs'

export function manifestPathOf(out) {
  return String(out).replace(/\.jpg$/, '.manifest.json')
}

export function writeSheetManifest(out, data) {
  const p = manifestPathOf(out)
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return p
}

export function manifestLine(p) {
  return `格位索引: ${p}`
}
