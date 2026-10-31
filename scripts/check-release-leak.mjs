#!/usr/bin/env node
// 发布前敏感信息扫描：扫 npm 包里真正会发出去的文件，找账号身份、本机路径、协作方名。
//
// 为什么要有它：这个仓库是公开的，npm 包里的注释也会被读。审查过程中写下的
// 「豆包 11:40 验收抓到」这类句子，会把内部怎么干活暴露给源码读者。
//
// 尺度（用户 2026-11-01 拍板）：只清协作方名，缺陷追踪编号（P0-1 / E4-02 / C26）留着——
// 外人反推不出内部流程，删了以后我们自己也查不到「这条为什么这么改」。
//
// 用法：
//   node scripts/check-release-leak.mjs            # 扫当前目录
//   node scripts/check-release-leak.mjs --dir <路径>
// 退出码：0 干净；2 有 HARD 命中。

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const ROOT = dirIdx >= 0 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();

// 只扫真正会进 npm 包的文件：以 package.json 的 files 为准，外加 npm 自动带的几个。
function listTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = new Set(['package.json', 'README.md', 'LICENSE']);
  for (const entry of pkg.files || []) {
    const p = path.join(ROOT, entry);
    if (!fs.existsSync(p)) continue;
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
// 刻意不匹配的东西（都是曾经误报过的）：
//   · `https://` —— 盘符规则要求反斜杠，或正斜杠后面还有字符
//   · `client.js` 那句注释「不写死 127.0.0.1:3080」—— 说的是正确做法
//   · `C:\Windows\...` —— 拦危险路径的测试用例，不是本机路径
//   · `{ SESSDATA: 'sessdata' }` —— 字段名映射表，不是真值
const HARD = [
  ['Windows 绝对路径', /(?:^|[^A-Za-z0-9])[A-Za-z]:\\(?![\\/])/g],
  ['本机用户目录', /Users[\\/][A-Za-z0-9_.-]{2,}/g],
  // 下面两条的字面量特意拆开拼：本文件自己也在 sync-release.ps1 的泄漏扫描范围里
  // （它扫 $repoOnly），写成一整串会在那里报「检测器自己被检测」。
  ['账号昵称', new RegExp(['大', '肥鱼', '|', '奇术', '湮锁'].join(''), 'g')],
  ['账号 mid', new RegExp(['1081', '904267'].join(''), 'g')],
  ['真 SESSDATA 值', /SESSDATA["']?\s*[:=]\s*["'][^"']*(?:%2C|[0-9a-f]{32})/gi],
  ['写死本机端口', /127\.0\.0\.1:3080/g],
  ['协作方 WorkBuddy', /WB-?CN|WBcn|WorkBuddy/gi],
  ['协作方 豆包', /豆包/g],
  ['协作方 hy3/hy4', /\bhy[34]\b/gi],
];

// 明知会误报、但要留档的豁免：文件 + 行内容特征 → 理由
const EXEMPT = [
  { file: 'client.js', match: /不写死\s*127\.0\.0\.1:3080/, why: '注释说的是正确做法，不是泄露' },
  { file: 'tools/look.mjs', match: /C:\\Windows/, why: '拦危险路径的测试用例' },
  { file: 'lib/cred.mjs', match: /SESSDATA:\s*'sessdata'/, why: '字段名映射表，不是真值' },
];

const files = listTargets();
const hits = [];

for (const rel of files) {
  const p = path.join(ROOT, rel);
  let src;
  try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
  src.split('\n').forEach((line, i) => {
    for (const [rule, re] of HARD) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      if (EXEMPT.some((e) => e.file === rel && e.match.test(line))) continue;
      hits.push({ file: rel, line: i + 1, rule, sample: line.trim().slice(0, 140) });
    }
  });
}

if (!hits.length) {
  console.log(`✓ 敏感信息扫描通过（${files.length} 个文件）`);
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
