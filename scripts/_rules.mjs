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
 *   · 「开发日期」—— 缺陷追踪索引（E4-02（2026-10-30，P0）形态）按既定尺度保留；
 *   · 裸「报告」「第N批」「版本」—— 单独出现是合理产品措辞，只有带会话坐标才算残留；
 *   · Cxxx 编号 —— 2026-11-01 拍板保留，第三类规则只吃紧跟其后的批次名，不吃编号本身。
 *
 * 第三类「会话坐标 / 内部批次」（C237）：包内注释里带「哪一批 / 哪一段 / 本版 /
 * 写进报告」这类内部会话坐标，读者据此能还原开发过程，不属于发布内容。
 * 与 tools/fixtures/c237-scan.mjs 的 RESIDUE_KINDS 是「实现 ↔ 缺陷定义」两端：
 * 不抄同一份正则，改由 C259/C260 真跑要求「定义抽到的每一行两道闸都必须点名」。
 */

/** 三类：协作标记 + 内部时刻 + 会话坐标。数组形态 [规则名, 正则]，供两个守卫直接展开。 */
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
  [
    '会话坐标 / 内部批次',
    // 版本号 + 字母桶 + 可选批次：0.4.9 B 桶第一批 / 0.4.10 C 桶第 2 批 / 0.5.0 A 桶第三批，
    // 也认只写到桶名的 0.4.9 B 桶。内部段号 2350 段 / 2410 段 §三 / 1720 段 §二。
    // 不带 \b：CJK 紧贴时 \b 在三种正则引擎下结论不一致；NFKC 已把全角数字字母折成半角。
    // 「写[进到入]…报告」中间允许插词（写进交付报告），另留「交付报告」兜底。
    /0\.\d+(?:\.\d+)?\s*[A-Za-z]\s*桶(?:\s*第?\s*[一二三四五六七八九十\d]+\s*批?)?|\d{4}\s*段|本版|报告里|写[进到入][^，。；]{0,6}报告|交付报告|面板设置页排后/gi,
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

/**
 * 凭据与通用本机路径：`check-public-text.mjs` 的对外文案面与
 * `check-release-leak.mjs` 的包内容面共用唯一一份，不许各抄一遍。
 *
 * 对外文案面里 release notes 是发版那一刻手写、会公开发布、原先唯一不过凭据扫描的面；
 * README / --help 在仓库里另有闸扫，漏的正是 body 这一面。
 *
 * 「通用本机路径」刻意只认盘符 + `Users` 的绝对路径与 `/Users/`：
 * 不写「拦所有盘符路径」——`C:\Windows` 这类系统默认值有正面理由留在文案里（讲 tar 陷阱、
 * 讲路径归一化），一刀切会误伤。规则不带 g：两个守卫按行 test，带 g 会让 lastIndex 跨行串味。
 */
// 单独导出：包内容面只要凭据那一条（它另有更严的盘符 / 用户目录规则 + 按规则豁免），
// 对外文案面要两条全上。两边拿到的是**同一个数组元素、同一个正则对象**，不是抄的第二份。
export const SESSDATA_RULE = ['真 SESSDATA 值', /SESSDATA["']?\s*[:=]\s*["'][^"']*(?:%2C|[0-9a-f]{32})/i]
export const CRED_RULES = [
  ['通用本机路径', /[A-Za-z]:\\Users\\|\/Users\//i],
  SESSDATA_RULE,
]

/**
 * 明知会误报、要留档的豁免：文件 + 行内容特征 + **只对哪条规则生效** → 理由。
 * `rule` 字段不能省：旧写法「命中任一 EXEMPT 就 continue 整行」会把该行所有规则一起放过，
 * 于是 `GNU tar` 那行塞进真 SESSDATA 也能溜过两道发布闸。
 *
 * 表放这里而不是两个守卫各存一份：加一条规则时若只改一侧的豁免，就会变成
 * 「同一个词一个守卫拦、另一个放」，与 COLLAB_RULES 收拢是同一件事。
 */
export const EXEMPT_RULES = [
  { file: 'client.js', match: /不写死\s*127\.0\.0\.1:3080/, rule: '写死本机端口', why: '注释说的是正确做法，不是泄露' },
  { file: 'tools/look.mjs', match: /C:\\Windows/, rule: 'Windows 绝对路径', why: '拦危险路径的测试用例' },
  { file: 'tools/cli-io.mjs', match: /C:\\Windows|任一盘符根|全是 c:\\ 开头/, rule: 'Windows 绝对路径', why: '讲路径归一化绕过的注释示例，不是本机路径' },
  { file: 'lib/cred.mjs', match: /SESSDATA:\s*'sessdata'/, rule: '真 SESSDATA 值', why: '字段名映射表，不是真值' },
  { file: 'scripts/fetch-deps.mjs', match: /GNU tar/, rule: 'Windows 绝对路径', why: '讲 Windows 裸 tar 把盘符当远程主机的注释示例，不是本机路径' },
]

/** 按规则名豁免：只放过被点名那条规则，同一行里其它规则照常命中。 */
export function exemptFor(exempts, file, line, rule) {
  return exempts.some((e) => e.file === file && e.match.test(line) && e.rule === rule)
}
