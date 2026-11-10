#!/usr/bin/env node
// 发布前敏感信息扫描：扫 npm 包里真正会发出去的文件，找账号身份、本机路径、协作方名。
//
// 为什么要有它：这个仓库是公开的，npm 包里的注释也会被读。审查过程中写下的
// 「豆包 11:40 验收抓到」这类句子，会把内部怎么干活暴露给源码读者。
//
// 尺度（用户 2026-11-01 拍板）：只清协作方名，缺陷追踪编号（P0-1 / E4-02 / C26）留着——
// 外人反推不出内部流程，删了以后我们自己也查不到「这条为什么这么改」。
//
// HARD 覆盖四类：内部协作标记 / 派单编号·内部时刻 / 内部路径 / 本机身份项。
// 本机身份项从 scripts/_identity.mjs 动态读，与 scripts/check-public-text.mjs 共用唯一一份，
// 不在这里再写死清单（写死 = 闸门自己撞自己的闸门，见 HARD 上方那段说明）。
//
// 用法：
//   node scripts/check-release-leak.mjs            # 扫当前目录
//   node scripts/check-release-leak.mjs --dir <路径>
// 退出码：0 干净；2 有 HARD 命中、有文件读不出来，或**目录展开异常**（这些面没扫到，不许放行）。

import fs from 'node:fs';
import path from 'node:path';
import { readIdentity, escapeRe } from './_identity.mjs';
import { scanCollab, SESSDATA_RULE, EXEMPT_RULES, exemptFor } from './_rules.mjs';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const ROOT = dirIdx >= 0 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();

// 本机身份（昵称 / mid / 用户名）的唯一读取处是 scripts/_identity.mjs：
//   --dir 指向哪棵树，就读哪棵树的 .leak-ids；环境变量与 USERNAME 三源合并。
//   取不到时整条身份规则不启用（空正则会匹配任何文本，等于把闸门关掉），并明说没扫什么。
const { LOCAL_USER, IDENTITY_IDS, IDENTITY_WORDS } = readIdentity(ROOT);

// 只扫真正会进 npm 包的文件：以 package.json 的 files 为准，外加 npm 自动带的几个。
const ABSENT = []; // 清单里有、盘上没有 —— 记下来，最后点名（2026-11-01 第三轮）
const COMPLAIN = []; // 递归展开的异常（深度超限等），必须点名并按未通过处理，不许静默截断
const MAX_DEPTH = 8;

// C293：package.json.files 写目录项时 npm 会递归打包，扫描面必须同样递归。
//   以前只 readdirSync 一层，lib/sub/leak.txt 这种子目录里的泄漏串两道闸都说通过。
//   · lstatSync 判符号链接并直接跳过 —— statSync 会跟进去，junction 会把扫描面带出仓库；
//   · 深度上限 8，超了记进 COMPLAIN 并在摘要点名，绝不静默截断。
// 「basename 排除口径」现核说明：改前的平铺分支**没有任何 basename 排除**，只判 isFile()。
//   本轮不新造一份排除逻辑，递归层沿用同一个 isFile()；files 本身就是白名单，
//   递归不会越出清单项。1650 段说的「既有排除口径」不存在，已在交卷段更正。
// 与 scripts/check-public-text.mjs 的 listPackageTexts 是同构的两份实现，改一边要改两边。
function walkTargets(rel, depth, out) {
  if (depth > MAX_DEPTH) {
    COMPLAIN.push(`${rel}：目录层数超过 ${MAX_DEPTH}，可能不是 package layout，已停止向下展开`);
    return;
  }
  const full = path.join(ROOT, rel);
  let st;
  try { st = fs.lstatSync(full); } catch { ABSENT.push(`${rel}(读不出来)`); return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    let names;
    try { names = fs.readdirSync(full); } catch { ABSENT.push(`${rel}(读不出来)`); return; }
    for (const name of names) walkTargets(`${rel}/${name}`, depth + 1, out);
    return;
  }
  if (st.isFile()) out.add(rel);
}

function listTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 三个默认项也先判存在再加（2026-11-01 第三轮）。
  //   原来是无条件塞进 out：文件不存在时 readFileSync 抛错、被 catch 记成「读不出来」——
  //   于是缺 LICENSE（很多包本来就没有）被报成「读不出来」，语义错位，还会让 [warn] 天天挂着。
  //   不存在就是不存在，不进扫描面；真读不出来（权限 / 独占锁）才叫读不出来。
  const out = new Set();
  for (const d of ['package.json', 'README.md', 'LICENSE']) {
    if (fs.existsSync(path.join(ROOT, d))) out.add(d);
  }
  for (const entry of pkg.files || []) {
    const rel = entry.replace(/\/$/, '');
    const p = path.join(ROOT, rel);
    // 原来这里是 `continue` —— 静默把整个目录项跳过。清单与实物不符时，
    // 扫描面悄悄变小、脚本照样说「扫描通过」。现在记下来点名，与 sync-release.ps1 的
    // AssertNoPaths 同口径（那边是「清单里有、盘上没有 ⇒ 红」；这里 4b 的职责是扫内容、
    // 不负责判清单完整性，所以只点名不红，但**不许静默**）。
    // 目录没建也走这条路：进 ABSENT，不抛异常。
    if (!fs.existsSync(p)) { ABSENT.push(entry); continue; }
    walkTargets(rel, 1, out);
  }
  return [...out].sort();
}

// HARD = 会让读者知道「谁在干这件事 / 这台机器长什么样」，一条即拒。
//
// **公开身份不在泄漏面**（用户 2026-11-01 拍板，2026-11-01 第三轮复核补记）：
//   GitHub handle `Sacredbluedragon` 出现在 package.json 的 author / repository.url /
//   bugs.url / homepage 四处。它是**仓库地址的一部分**，任何人从 npm 页面都能看到，
//   去掉反而让使用者找不到作者、也让 GitHub 的 issue 指路断掉。
//   它今天连扫三次零命中，但**没有一句话说清「为什么它不算」**——不写下来的后果是：
//   下次有人翻规则表，会发现「作者名在包里却没人管」，于是把它当成漏掉的规则补进去，
//   然后一发布就红。所以显式记在这里。
//   判据边界一句话：**泄漏面只认「本机身份 + 本机环境 + 协作方名」，
//   公开的 GitHub handle / 仓库 URL 不算。** 本机身份从 `.leak-ids` 读，不在源码里写死。
//
// 刻意不匹配的东西（都是曾经误报过的）：
//   · `https://` —— 盘符规则要求反斜杠，或正斜杠后面还有字符
//   · `client.js` 那句注释「不写死 127.0.0.1:3080」—— 说的是正确做法
//   · `C:\Windows\...` —— 拦危险路径的测试用例，不是本机路径
//   · `{ SESSDATA: 'sessdata' }` —— 字段名映射表，不是真值
//   · `Sacredbluedragon` —— 公开 GitHub handle，见上
const HARD = [
  ['Windows 绝对路径', /(?:^|[^A-Za-z0-9])[A-Za-z]:\\(?![\\/])/g],
  ['本机用户目录', /Users[\\/][A-Za-z0-9_.-]{2,}/g],
  // 本机身份项（昵称 / mid / 用户名）从 _identity.mjs 动态读，两个守卫共用唯一一份。
  // 旧版把昵称拆字拼在这里（「大」「肥鱼」…），清单本身就是一份真实身份，
  // 而本文件在 sync-release.ps1 的 $repoOnly 里会进公开仓库 —— 等于拿清单去泄漏身份。
  // 一个身份项都没取到时**整条不启用**：空正则会匹配任何文本，那等于把闸门关掉。
  ...(IDENTITY_WORDS.length
    ? [['本机身份项（昵称 / mid / 用户名）', new RegExp(IDENTITY_WORDS.map(escapeRe).join('|'), 'g')]]
    : []),
  // 与 check-public-text.mjs 的对外文案面共用唯一一份（scripts/_rules.mjs），不许本地再抄。
  SESSDATA_RULE,
  ['写死本机端口', /127\.0\.0\.1:3080/g],
  // 「协作方 WorkBuddy / 豆包 / hy3-hy4」三类形态已并入 _rules.mjs 的「内部协作标记」，
  // 不再本地重复；下面只剩「路径 / 身份 / 凭据 / 端口」四类。
  // 「内部协作标记 / 派单编号」两类已抽到 scripts/_rules.mjs，由 scanCollab 统一跑
  // （含 NFKC 归一化与 5 个变体缺口），这里不再存第二份平行清单。
  // 四类之一「内部路径」：本机工作区与同机其它项目名（盘符 / 用户目录两条已在上面）。
  ['内部工作区 / 同机项目名', /D:\\+007|Dsh工作区|DeepSeek-Harness|GPT-SoVITS|bili-duty|bili-panel|刷B站|surf CORE/g],
];

// 豁免表在 scripts/_rules.mjs 里只有一份，与对外文案面的守卫共用。
// 每项带 rule 字段：只放过被点名那条规则，同一行里其它规则照常命中。
// `scripts/fetch-deps.mjs` 那项的 match 收窄到 `GNU tar` 这个只在讲 tar 陷阱的行上出现的词，
// 不是整文件豁免；规则名豁免保证「GNU tar 行里塞真 SESSDATA」仍被 `真 SESSDATA 值` 抓住。
const EXEMPT = EXEMPT_RULES;

const files = listTargets();
const hits = [];
const skipped = [];
const unreadable = [];

for (const rel of files) {
  const p = path.join(ROOT, rel);
  let buf;
  // 读不出来（权限 / 独占锁 / IO 错）≠ 干净。原来这里 `catch { continue }` 静默跳过，
  // 与 sync-release.ps1 的 Test-IsBinaryFile 兜底方向相反（那边当文本扫、这边直接跳过），
  // 2026-11-01 两侧统一成「不当文本扫」，但**跳过必须点名**——否则「没查」和「查过没问题」长得一样。
  // 2026-11-02：点名升级为**红**（见下面 unreadable.length 那段）—— 点名只是让人看见，退出码才拦得住。
  try { buf = fs.readFileSync(p); } catch { unreadable.push(rel); continue; }
  // 二进制不参与文本扫描：与 sync-release.ps1 的 Test-IsBinaryFile 同口径（前 8 KB 出现 NUL）。
  // 不这么做的话，png 压缩字节里随机出现的 `p:\` 会被当成「Windows 绝对路径」。
  if (buf.subarray(0, 8192).includes(0)) { skipped.push(rel); continue; }
  const src = buf.toString('utf8');
  src.split('\n').forEach((line, i) => {
    // 豁免实现也只有一份（scripts/_rules.mjs）：按规则名放过，同一行其它规则照常命中。
    const isExempt = (rule) => exemptFor(EXEMPT, rel, line, rule);
    // 协作三类走唯一那份（含 NFKC 归一化），不在本地存正则。
    for (const rule of scanCollab(line)) {
      if (isExempt(rule)) continue;
      hits.push({ file: rel, line: i + 1, rule, sample: line.trim().slice(0, 140) });
    }
    for (const [rule, re] of HARD) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      if (isExempt(rule)) continue;
      hits.push({ file: rel, line: i + 1, rule, sample: line.trim().slice(0, 140) });
    }
  });
}

// 身份项一个都没取到时不能静默通过 —— 与 check-public-text.mjs 同口径，明说没扫什么。
const idNote = IDENTITY_WORDS.length
  ? `身份项 ${IDENTITY_WORDS.length} 个（用户名${LOCAL_USER ? '已查' : '不可用'}、.leak-ids ${IDENTITY_IDS.length} 条已查）`
  : '身份项 0 个（用户名取不到、也没有 .leak-ids → 昵称/mid 两类没扫）';
console.log(`[info] ${idNote}；HARD 五类：内部协作标记 / 派单编号·内部时刻 / 会话坐标·内部批次 / 内部路径 / 本机身份项`);
if (skipped.length) {
  console.log(`[skip] ${skipped.length} 个二进制文件没做文本扫描：${skipped.join(', ')}`);
}
if (ABSENT.length) {
  console.log(`[warn] ${ABSENT.length} 个 files 清单项在盘上不存在、没扫：${ABSENT.join(', ')}`);
}
if (COMPLAIN.length) {
  console.log(`[warn] ${COMPLAIN.length} 处目录展开异常：${COMPLAIN.join('；')}`);
}

// C296：COMPLAIN 非空 = 有子树根本没展开、没扫，与下面「读不出来」同属没扫到的面。
//   只打 [warn] 不够 —— 原来 warn 完照样输出「✓ 敏感信息扫描通过」+ exit(0)，
//   等于「没看过的东西算干净」。1905 段实测：9 层树 + 真泄漏串，rc=0 放行。
//   修法不新造机制，直接复用下面 unreadable 那段已经写透的理由：
//   warning 会被翻页跳过，退出码不会；没扫到的面等于不知道有没有泄漏，不许放行。
//   两道闸对「深度超限」统一判 rc=2：scripts/check-public-text.mjs 的 incomplete 也是 2，
//   release.ps1 只判 Rc -ne 0，不依赖具体数值；选 2 是因为本闸所有「未通过」历来是 2。
//   措辞与「扫到脏东西」分开：这里是没扫到，不是命中。
if (COMPLAIN.length) {
  console.error(`✗ 敏感信息扫描：${COMPLAIN.length} 处目录展开异常，这些子树没扫（按未通过处理）`);
  for (const c of COMPLAIN) console.error(`  ${c}`);
  console.error('  没扫到的面等于不知道有没有泄漏，不许放行。');
  process.exit(2);
}

// 读不出来 ⇒ **红**（2026-11-02 00:13 定的；原来只 warn、然后照样 `✓ 通过` + exit 0）。
//
//   为什么 warn 不够：这道闸是发布链上**唯一**看内容的一环。它说「我通过了」，
//   而实际上有一个文件它根本没看 —— 这句话不能说。warning 会被人翻页跳过，退出码不会。
//   与三态的关系：`Test-IsBinaryFile` 仍然返回 'unreadable'（读不出来 ≠ 是二进制，
//   文案不许合并），变的是**结论** —— 从「点名 + 放行」改成「点名 + 按未通过处理」。
//   反方向的顾虑（环境偶发读不出、把发版卡住）：那正是该卡的时候 —— 发布树刚复制出来就读不出来，
//   说明环境有问题；带这个状态发出去，用户拿到的是「没人看过内容」的包。
if (unreadable.length) {
  console.error(`✗ 敏感信息扫描：${unreadable.length} 个文件读不出来、没做文本扫描（按未通过处理）`);
  for (const f of unreadable) console.error(`  ${f}`);
  console.error('  读不出来 ≠ 干净：拿读不到的内容去正则只会造误报，所以不扫；但也不能因此说「扫过了」。');
  process.exit(2);
}

if (!hits.length) {
  // 单独跑 4b（不经过 sync）时，ABSENT 换来的是「通过」——而那个不在盘上的清单项
  //   正好可能就是要发的敏感文件。判定不改（清单完整性由 sync 负责），但这句得说出来。
  const absentNote = ABSENT.length
    ? `（其中 ${ABSENT.length} 个清单项不在盘上，未做扫描；清单完整性由 sync-release.ps1 负责）`
    : '';
  console.log(`✓ 敏感信息扫描通过（${files.length - skipped.length} 个文本文件）${absentNote}`);
  process.exit(0);
}

console.error(`✗ 敏感信息扫描：${hits.length} 处命中（${files.length} 个文件）\n`);
const byFile = {};
for (const h of hits) (byFile[h.file] ||= []).push(h);
for (const [f, list] of Object.entries(byFile)) {
  console.error(`  ${f}: ${list.length} 处`);
  for (const h of list) console.error(`    :${h.line} [${h.rule}] ${h.sample}`);
}
console.error('\n尺度：只清协作方名，缺陷追踪编号（P0-1 / E4-02 / C26）留着。');
process.exit(2);
