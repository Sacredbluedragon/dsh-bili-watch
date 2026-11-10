// 0.4.9 C223：ASR 转写覆盖不足时给模型的一句解释。
// rate < 2 字/秒多半是背景音乐 / 纯画面，转写出来的字只是把杂音听成字；
// 原来这里只打一条不带 ⚠ 的「质量低」，工具层 filter(⚠) 会把它丢掉，
// 模型只看到后面 OCR / 兜底那一步的输出，于是把「不知道」当成「视频没内容」。
export function asrCoverageNotice(chars, dur) {
  if (!(dur > 0)) return ''
  const rate = Number(chars) / Number(dur)
  if (!(rate < 2)) return ''
  return `⚠ 转写覆盖不足：${chars} 字 / ${dur} 秒 = ${rate.toFixed(1)} 字/秒（阈值 2），多半是背景音乐或纯画面，改用画面分析`
}
