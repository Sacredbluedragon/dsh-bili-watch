// E6：从 CLI 的 stderr「✓ 已写入 <path>（注记）」里取出干净的落盘路径。
// 原来 index.js 用 /✓\s*已写入\s*(.+)/ 直接取到行尾，把 CLI 的全角括号注记
//   （source=text / N 条，官方时间戳 …）一起吞进路径，模型拿去 read 必然失败。
//
// 只剥**已知形态的尾部注记**，不按「第一个全角左括号」切：文件名里可能带全角括号，
// 半角 () 更是常见（fix (1).json）。宁可少剥一种注记，也不能把路径截断。
// 单独成模块是为了让 verify 直接 import 真跑，不靠复刻正则自证。
export function extractWrittenPath(err) {
  const m = String(err == null ? '' : err).match(/✓\s*已写入\s*([^\r\n]+)/)
  if (!m) return null
  const raw = m[1].trim()
  const path = raw
    .replace(/（(?:source=[^（）]*|\d+\s*(?:条|行)[^（）]*)）\s*$/, '')
    .trim()
  return path || null
}
