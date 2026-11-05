#!/usr/bin/env node
/**
 * 协作类敏感规则的**唯一**定义处：scripts/check-public-text.mjs 与
 * scripts/check-release-leak.mjs 都 import 它，不许再各存一份平行清单。
 *
 * 为什么抽出来：两份守卫原来各写一份几乎逐字相同的「内部协作标记 / 派单编号」
 * 正则，补一个变体要改两处，漏改一处就变成「同一个词一个守卫拦、另一个放」。
 * 这与 scripts/_identity.mjs 收拢身份清单是同一件事。
 *
 * scanCollab 先做 NFKC 归一化，再跑规则：全角 ＷＢＣＮ / ＤＳＨ　２３０８
 * 会先折成半角，所以规则表里不必再抄一份全角字面量。
 *
 * 刻意不列的裸词（列了会把「为什么这么写」的技术理由一起删掉）：
 *   · 「老大」—— tools/look.mjs 的注入检测正则里有「自称老大」，是功能代码；
 *   · 「实测」—— 技术依据措辞；
 *   · 「复验 / 收口」—— 「装完复验 import」「就地收口」讲的是运行行为；
 *   · 「第N轮」—— 「面板 8 秒一轮」是轮询周期，只有跟外审/审查/复核连着才算协作轮次；
 *   · 「开发日期」—— 缺陷追踪索引（E4-02（2026-10-30，P0）形态）按既定尺度保留。
 */

/** 两类：协作标记 + 派单编号。数组形态 [规则名, 正则]，供两个守卫直接展开。 */
export const COLLAB_RULES = [
  [
    '内部协作标记',
    // WB-?CN 带 i 且配合 NFKC，可覆盖 WB-CN / wbcn / ＷＢＣＮ；
    // Work[\s-]?Buddy 覆盖 Work Buddy / Work-Buddy；\bhy[\s-]?[34]\b 覆盖 Hy-4；
    // 派\s*单 覆盖「派 单」这类中间插空格的写法。
    /WB-?CN|WBcn|WBin|WB-Intl|Work[\s-]?Buddy|豆包|\bhy[\s-]?[34]\b|DSH\s*派\s*单|派\s*单编号|派\s*单|发前外审|对话流|用户拍板|老大要求|老大报|验收抓到|追认|补报|裁定|交卷|全绿|(?:外审|审查|复核|验收|审单)[第\s]*[一二三四五六七八九十\d]+轮|第[一二三四五六七八九十\d]+轮(?:外审|审查|复核|验收|审单)/gi,
  ],
  [
    '派单编号 / 内部时刻',
    // i 标志让 [A-Z]{2,5} 也认小写后缀（20261105-2308-dsh）；
    // 归一化后 \s 能吃全角空格（DSH　2308）。
    /20\d{6}-\d{4}-[A-Z]{2,5}|\bDSH\s+\d{4}\s*§|\b\d{4}\s*§[一二三四五六七八九十]|\bDSH\s+\d{4}\b/gi,
  ],
]

/**
 * @param {string} text 单行文本（守卫按行扫）
 * @returns {string[]} 命中的规则名；空数组 = 没命中
 */
export function scanCollab(text) {
  const norm = String(text ?? '').normalize('NFKC')
  const hits = []
  for (const [name, re] of COLLAB_RULES) {
    re.lastIndex = 0
    if (re.test(norm)) hits.push(name)
  }
  return hits
}
