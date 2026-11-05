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
// 退出码：0 干净；2 有 HARD 命中，或**有文件读不出来**（2026-11-02 起读不出来也算未通过）。

import fs from 'node:fs';
import path from 'node:path';
import { readIdentity, escapeRe } from './_identity.mjs';
import { scanCollab } from './_rules.mjs';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const ROOT = dirIdx >= 0 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();

// 本机身份（昵称 / mid / 用户名）的唯一读取处是 scripts/_identity.mjs：
//   --dir 指向哪棵树，就读哪棵树的 .leak-ids；环境变量与 USERNAME 三源合并。
//   取不到时整条身份规则不启用（空正则会匹配任何文本，等于把闸门关掉），并明说没扫什么。
const { LOCAL_USER, IDENTITY_IDS, IDENTITY_WORDS } = readIdentity(ROOT);

// 只扫真正会进 npm 包的文件：以 package.json 的 files 为准，外加 npm 自动带的几个。
const ABSENT = []; // 清单里有、盘上没有 —— 记下来，最后点名（2026-11-01 第三轮）
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
    const p = path.join(ROOT, entry);
    // 原来这里是 `continue` —— 静默把整个目录项跳过。清单与实物不符时，
    // 扫描面悄悄变小、脚本照样说「扫描通过」。现在记下来点名，与 sync-release.ps1 的
    // AssertNoPaths 同口径（那边是「清单里有、盘上没有 ⇒ 红」；这里 4b 的职责是扫内容、
    // 不负责判清单完整性，所以只点名不红，但**不许静默**）。
    if (!fs.existsSync(p)) { ABSENT.push(entry); continue; }
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        const rel = `${entry.replace(/\/$/, '')}/${f}`;
        if (fs.statSync(path.join(ROOT, rel)).isFile()) out.add(rel);
      }
    } else {
      out.add(entry);
    }
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
  ['真 SESSDATA 值', /SESSDATA["']?\s*[:=]\s*["'][^"']*(?:%2C|[0-9a-f]{32})/gi],
  ['写死本机端口', /127\.0\.0\.1:3080/g],
  // 「协作方 WorkBuddy / 豆包 / hy3-hy4」三类形态已并入 _rules.mjs 的「内部协作标记」，
  // 不再本地重复；下面只剩「路径 / 身份 / 凭据 / 端口」四类。
  // 「内部协作标记 / 派单编号」两类已抽到 scripts/_rules.mjs，由 scanCollab 统一跑
  // （含 NFKC 归一化与 5 个变体缺口），这里不再存第二份平行清单。
  // 四类之一「内部路径」：本机工作区与同机其它项目名（盘符 / 用户目录两条已在上面）。
  ['内部工作区 / 同机项目名', /D:\\+007|Dsh工作区|DeepSeek-Harness|GPT-SoVITS|bili-duty|bili-panel|刷B站|surf CORE/g],
];

// 明知会误报、但要留档的豁免：文件 + 行内容特征 + **只对哪条规则生效** → 理由。
// rule 不能省：旧写法「命中任一 EXEMPT 就 continue 整行」会把该行所有规则一起放过，
// 于是 GNU tar 那行塞进真 SESSDATA 也能溜过两道发布闸。
const EXEMPT = [
  { file: 'client.js', match: /不写死\s*127\.0\.0\.1:3080/, rule: '写死本机端口', why: '注释说的是正确做法，不是泄露' },
  { file: 'tools/look.mjs', match: /C:\\Windows/, rule: 'Windows 绝对路径', why: '拦危险路径的测试用例' },
  { file: 'tools/cli-io.mjs', match: /C:\\Windows|任一盘符根|全是 c:\\ 开头/, rule: 'Windows 绝对路径', why: '讲路径归一化绕过的注释示例，不是本机路径' },
  { file: 'lib/cred.mjs', match: /SESSDATA:\s*'sessdata'/, rule: '真 SESSDATA 值', why: '字段名映射表，不是真值' },
  // 2026-11-02（发版前审查）：这文件里的 `C:\...` / `` `C:\` `` 是**讲 Windows tar 陷阱**的
  //   命令示例——GNU tar 会把 `-C C:\...` 里的 `C:\` 当成远程主机名。它不是本机路径，
  //   改成别的写法那句注释就失真了（失真后读者反而会去试裸 tar）。
  //   match 收窄到 `GNU tar` 这个只在讲这个坑的行上出现的词，不是整文件豁免。
  { file: 'scripts/fetch-deps.mjs', match: /GNU tar/, rule: 'Windows 绝对路径', why: '讲 Windows 裸 tar 把盘符当远程主机的注释示例，不是本机路径' },
];

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
    const exemptFor = (rule) => EXEMPT.some(
      (e) => e.file === rel && e.match.test(line) && e.rule === rule);
    // 协作两类走唯一那份（含 NFKC 归一化），不在本地存正则。
    for (const rule of scanCollab(line)) {
      if (exemptFor(rule)) continue;
      hits.push({ file: rel, line: i + 1, rule, sample: line.trim().slice(0, 140) });
    }
    for (const [rule, re] of HARD) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      // 按规则豁免：只放过被点名那条规则，同一行里其它规则照常 hits.push。
      if (exemptFor(rule)) continue;
      hits.push({ file: rel, line: i + 1, rule, sample: line.trim().slice(0, 140) });
    }
  });
}

// 身份项一个都没取到时不能静默通过 —— 与 check-public-text.mjs 同口径，明说没扫什么。
const idNote = IDENTITY_WORDS.length
  ? `身份项 ${IDENTITY_WORDS.length} 个（用户名${LOCAL_USER ? '已查' : '不可用'}、.leak-ids ${IDENTITY_IDS.length} 条已查）`
  : '身份项 0 个（用户名取不到、也没有 .leak-ids → 昵称/mid 两类没扫）';
console.log(`[info] ${idNote}；HARD 四类：内部协作标记 / 派单编号·内部时刻 / 内部路径 / 本机身份项`);
if (skipped.length) {
  console.log(`[skip] ${skipped.length} 个二进制文件没做文本扫描：${skipped.join(', ')}`);
}
if (ABSENT.length) {
  console.log(`[warn] ${ABSENT.length} 个 files 清单项在盘上不存在、没扫：${ABSENT.join(', ')}`);
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
