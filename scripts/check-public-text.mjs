#!/usr/bin/env node
/**
 * 对外文案过闸：README / --help / release body
 *
 * 判据：只写「用户能观察到什么变化」，不写「我们内部怎么验证的」。
 * 硬闸命中 → rc=1（必须删或改写）；软闸只提示，不拦。
 *
 * 用法：
 *   node scripts/check-public-text.mjs                      # 扫 README + --help
 *   node scripts/check-public-text.mjs body.md              # 再扫一个 release body 文件
 *   node scripts/check-public-text.mjs --repo <插件目录>     # 指定插件目录（默认自动找）
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO = resolve(HERE, '..')

const argv = process.argv.slice(2)
let repo = DEFAULT_REPO
const bodyFiles = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--repo') { repo = argv[i + 1]; i += 1; continue }
  bodyFiles.push(argv[i])
}

/**
 * 身份类字面量**不写死在源码里**，运行时从三个来源合并读（同 tools/verify.mjs 的 C33 口径）。
 *
 * 为什么必须动态读（2026-11-01 实测踩出来的）：
 *   ① 本文件会进公开仓库（发布树的 origin 是公开 GitHub 仓库）——
 *      把「防泄漏清单」本身写死在源码里，等于拿清单去泄漏真实身份。
 *   ② 它同时在 sync-release.ps1 的 $repoOnly 清单里（只进仓库、不进包），
 *      而 sync 的「仅仓库」那遍扫描用 $hardRules（本机身份）扫 repoOnly 文件。
 *      写死身份 = **闸门自己撞自己的闸门**：真跑 release.ps1 必然在 sync 阶段 exit 2。
 *      实测就是这条把 0.4.2 之后的所有发版全堵住了（闸门从那以后一次没真跑过）。
 *
 * 三个来源，**合并**（不是三选一 —— 少一个来源就少扫一类身份）：
 *   ① 环境变量 BILI_WATCH_LEAK_IDS（逗号/空白分隔）
 *   ② 仓库根 .leak-ids（一行一个，# 开头是注释，已 gitignore）
 *   ③ 环境里的用户名（USERNAME / USER）
 *
 * 三个来源都取不到时的口径（DSH 2026-11-01 明确要求）：
 *   **放行，但必须明说少扫了什么** —— 不许静默通过。
 *   输出里会打「身份项 0 个（…没扫）」，让人一眼看出昵称/mid 那两类没被覆盖。
 *
 * 取值门槛与 C33 一致：纯 ASCII 短名（<4）几乎必然误报（\busr\b 之类），
 * 中文昵称按 ≥2 字放宽。宁可少扫一项，也不要在别的机器上一跑就假红。
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LOCAL_USER = (process.env.USERNAME || process.env.USER || '').trim()
const okId = (s) => s.length >= 4 || (/[^\x00-\x7F]/.test(s) && s.length >= 2)
const IDENTITY_IDS = (() => {
  const fromEnv = String(process.env.BILI_WATCH_LEAK_IDS || '').split(/[,，\s]+/).filter(Boolean)
  let fromFile = []
  try {
    fromFile = readFileSync(join(DEFAULT_REPO, '.leak-ids'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  } catch { /* 没有这个文件是正常情况（发布树、别人的机器） */ }
  return [...new Set([...fromEnv, ...fromFile].map((s) => s.trim()).filter(okId))]
})()
const IDENTITY_WORDS = [...new Set([LOCAL_USER, ...IDENTITY_IDS].filter(okId))]

/** 硬闸：命中即停 */
const HARD = [
  { name: '内部指标/工作流', re: /verify\.mjs|断言|自检|反向测试|审查报告|台账|派单|切片|全绿|通过\s*\/\s*\d+\s*失败/ },
  // 注意：不能写成裸 \bP[0-2]\b——bilibili 的「分P」（--p N 默认 P1）会被误伤。
  // 内部优先级标记的形态是 P0：/ P0-1 / **P0**，都带冒号、连字符或加粗。
  { name: '协作方代称/内部编号', re: /WBcn|WBin|WB-CN|WB-Intl|豆包|\bE[1-8]-\d+\b|\bC\d{2}\b|\bP[0-2](?:-\d+|[:：])|\*\*P[0-2]\*\*/ },
  // 本机标识分两半：
  //   · 项目名 / 路径 —— 写死。它们不是个人身份（公开仓库里本来就有），
  //     而且要能挡住**别人**写进 README 的路径。
  //   · 身份（用户名 / 昵称 / mid）—— 动态读，见上面的说明。
  //     一个都没取到时，身份那半整条不启用（不能退化成空正则 —— 那会匹配任何文本）。
  ...(IDENTITY_WORDS.length ? [{
    name: '本机标识',
    re: new RegExp(`D:\\\\+007|Dsh工作区|DeepSeek-Harness|GPT-SoVITS|bili-duty|bili-panel|刷B站|surf CORE|${IDENTITY_WORDS.map(escapeRe).join('|')}`),
  }] : [{
    name: '本机标识',
    re: /D:\\+007|Dsh工作区|DeepSeek-Harness|GPT-SoVITS|bili-duty|bili-panel|刷B站|surf CORE/,
  }]),
  { name: '本机验证过程', re: /本机侧|作者侧|作者机器|我这台|我的机器|隔离目录.{0,10}真跑|download\.log\s*写出完整链路|rebase\s*到\s*\d\.\d\.\d+\s*后重跑/ },
]

/** 软闸：只提示。这些是真实技术事实，删了反而降低可信度 */
const SOFT = [
  { name: '技术事实（保留）', re: /detached|DETACHED_PROCESS|internet 选项|Internet 选项|cp314|proxy|代理/ },
]

const hits = []
let scanned = 0

function scan(label, text) {
  scanned += 1
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    for (const rule of HARD) {
      if (rule.re.test(line)) {
        hits.push({ level: 'HARD', label, line: i + 1, rule: rule.name, text: line.trim() })
        break
      }
    }
    for (const rule of SOFT) {
      if (rule.re.test(line)) {
        // 只报没有被硬闸命中的行，减少噪音
        if (!hits.some((h) => h.label === label && h.line === i + 1)) {
          hits.push({ level: 'soft', label, line: i + 1, rule: rule.name, text: line.trim() })
        }
        break
      }
    }
  }
}

// 1) README
const readme = join(repo, 'README.md')
if (!existsSync(readme)) {
  console.error(`✗ 找不到 ${readme}`)
  process.exit(2)
}
scan('README.md', readFileSync(readme, 'utf8'))

// 2) --help（帮助必须走 stdout）
const look = join(repo, 'tools', 'look.mjs')
if (existsSync(look)) {
  const r = spawnSync(process.execPath, [look, '--help'], { encoding: 'utf8', timeout: 60000 })
  const help = `${r.stdout || ''}\n${r.stderr || ''}`
  if (r.status === 0 && (r.stdout || '').trim()) scan('--help', r.stdout)
  else console.log(`（--help 跳过：rc=${r.status}，stdout ${(r.stdout || '').length} B）`)
}

// 3) 附加文件（release body）
for (const f of bodyFiles) {
  const p = resolve(f)
  if (!existsSync(p)) { console.error(`✗ 找不到 ${p}`); process.exit(2) }
  scan(p, readFileSync(p, 'utf8'))
}

// 汇总
const hard = hits.filter((h) => h.level === 'HARD')
const soft = hits.filter((h) => h.level === 'soft')

console.log(`\n扫描 ${scanned} 份文本（${repo}${bodyFiles.length ? ` + ${bodyFiles.length} 个附加文件` : ''}）\n`)

// 身份扫描覆盖度（DSH 2026-11-01 要求）：三个来源全空时**放行但必须明说少扫了什么**。
// 不许静默通过 —— 静默就等于「看起来扫过了」，而实际上昵称/mid 那两类根本没覆盖。
const idNote = IDENTITY_WORDS.length
  ? `身份项 ${IDENTITY_WORDS.length} 个（用户名${LOCAL_USER ? '已查' : '不可用'}、.leak-ids ${IDENTITY_IDS.length} 条已查）`
  : '身份项 0 个（用户名取不到、也没有 .leak-ids → 昵称/mid 两类**没扫**；' +
    '要扫就把身份写进仓库根 .leak-ids 或环境变量 BILI_WATCH_LEAK_IDS）'
console.log(`  ${idNote}\n`)

if (hard.length === 0) {
  console.log('✓ 硬闸全过')
} else {
  console.log(`✗ 硬闸命中 ${hard.length} 行（必须删或改写）：\n`)
  for (const h of hard) {
    console.log(`  [${h.rule}] ${h.label}:${h.line}`)
    console.log(`    ${h.text.slice(0, 160)}`)
  }
}

if (soft.length > 0) {
  console.log(`\n软闸提示 ${soft.length} 行（技术事实，人工看一眼该不该留）：\n`)
  for (const s of soft.slice(0, 12)) {
    console.log(`  ${s.label}:${s.line}  ${s.text.slice(0, 110)}`)
  }
  if (soft.length > 12) console.log(`  …还有 ${soft.length - 12} 行`)
}

process.exit(hard.length === 0 ? 0 : 1)
