/**
 * dsh-bili-watch —— 「用户只贴了一条视频链接」的识别器。
 *
 * 只做判定，不做 IO：不请求接口、不抽帧、不写盘。
 * 判定口径见设计文档 T08 第一节：剥壳 → 命中恰好 1 条 → 残余为空。
 */

// 完整视频页：允许 ?p=2&t=30 与尾斜杠
const RE_FULL = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})(?:[/?#][^\s<>"'）)]*)?/gi
// 短链：能识别，但 look.mjs 不能展开（tools/look.mjs:1249-1251），调用方要单独处理
const RE_SHORT = /https?:\/\/b23\.tv\/[0-9A-Za-z]{5,12}(?:[/?#][^\s<>"'）)]*)?/gi
// ?bvid=BV… 形态（tools/look.mjs:1254 支持）；必须挂在 bilibili.com 域名下，避免任意站点的同名参数被当成视频
const RE_BVID_Q = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/[^\s<>"'）)]*?[?&]bvid=(BV[0-9A-Za-z]{10})[^\s<>"'）)]*/gi
// 裸 BV 号：前后不许粘字母数字
const RE_BARE = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/g

// 客户端包在用户文本外的壳；剥掉后剩下的才是用户真打的字
const WRAPPERS = [
  /<system-reminder[\s\S]*?<\/system-reminder>/gi,
  /<attached_files>[\s\S]*?<\/attached_files>/gi,
  /<user_query>/gi,
  /<\/user_query>/gi,
]
const LINK_ANY = /bilibili\.com\/video\/|b23\.tv\/|BV[0-9A-Za-z]{10}/

/** 剥壳；壳里若出现链接，记「引用」（引用不自动触发）。 */
function stripWrappers(raw) {
  let text = String(raw ?? '')
  let quoted = false
  for (const re of WRAPPERS) {
    text = text.replace(re, (m) => {
      if (LINK_ANY.test(m)) quoted = true
      return ' '
    })
  }
  // `<https://…>` 是常见自动链接写法；标签块已整段删掉之后，再剥掉包着单个
  // 无空格 token 的尖括号，避免把 <system-reminder> 这类壳提前破坏。
  text = text.replace(/<([^<>\s]{8,})>/g, '$1')
  const kept = []
  for (const ln of text.split('\n')) {
    if (/^\s*>/.test(ln)) {
      if (LINK_ANY.test(ln)) quoted = true
      continue
    }
    kept.push(ln)
  }
  return { text: kept.join('\n'), quoted }
}

/**
 * 判定一条用户文本是否「只有一条视频链接」。
 * @returns {{hit: false, why: string} | {hit: true, kind: 'full'|'short'|'bare', bv: string}}
 */
export function matchSingleVideoLink(raw) {
  const { text, quoted } = stripWrappers(raw)
  if (quoted) return { hit: false, why: '链接出现在引用/附件里' }
  if (!text.trim()) return { hit: false, why: '空消息' }
  if (/^\s*\//.test(text)) return { hit: false, why: '斜杠命令' }

  const hits = []
  let m
  RE_FULL.lastIndex = 0
  while ((m = RE_FULL.exec(text))) hits.push({ kind: 'full', bv: m[1], start: m.index, end: m.index + m[0].length })
  RE_SHORT.lastIndex = 0
  while ((m = RE_SHORT.exec(text))) hits.push({ kind: 'short', bv: '', start: m.index, end: m.index + m[0].length })
  RE_BVID_Q.lastIndex = 0
  while ((m = RE_BVID_Q.exec(text))) hits.push({ kind: 'full', bv: m[1], start: m.index, end: m.index + m[0].length })
  RE_BARE.lastIndex = 0
  while ((m = RE_BARE.exec(text))) hits.push({ kind: 'bare', bv: m[0], start: m.index, end: m.index + m[0].length })

  // 区间去重：整条 URL 覆盖它内部的 BV 号，只算一个
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const uniq = []
  for (const x of hits) {
    const last = uniq[uniq.length - 1]
    if (last && x.start < last.end) continue
    uniq.push(x)
  }
  if (uniq.length === 0) return { hit: false, why: '没有视频链接' }
  if (uniq.length > 1) return { hit: false, why: `有 ${uniq.length} 个链接` }

  const one = uniq[0]
  // 承重墙：链接之外还剩字，就说明用户在说别的事
  const residual = (text.slice(0, one.start) + text.slice(one.end))
    .replace(/\s+/g, '')
    .replace(/[。，、！？!?,.;；:：·…~～—\-"'“”‘’（）()【】\[\]]/g, '')
  if (residual) return { hit: false, why: `链接外还有字：「${residual.slice(0, 20)}」` }

  return { hit: true, kind: one.kind, bv: one.bv }
}

/** 从一条 UserMessage 里取纯文本（只认 text 块；有图片/文件块就不算「只贴了链接」）。 */
export function textOfUserMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  if (blocks.some((b) => b && b.type !== 'text')) return { ok: false, text: '' }
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
  return { ok: true, text }
}
