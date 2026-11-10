#!/usr/bin/env node
/**
 * 对外文案过闸：README / --help / release body，外加 package.json.files 展开的全部待发布文本。
 *
 * 判据分两面（同一份文件不套同一套规则，否则会误伤源码注释里的技术理由）：
 *   · 对外文案面（README / --help / release body）：只写「用户能观察到什么变化」，
 *     不写「我们内部怎么验证的」，连缺陷追踪编号都不留。
 *   · 包内容面（package.json.files 全部文本）：只查四类泄漏 ——
 *     内部协作标记 / 派单编号 / 内部路径 / 本机身份项。
 *     缺陷追踪编号（E4-02 / C26 / P0-1）按既定尺度保留：拿它们当 HARD 会把随包源码里
 *     「为什么这么写」的索引一起判红，等于逼人删技术理由。
 *
 * 硬闸命中 → rc=1（必须删或改写）；「没扫全」→ rc=1，其中由深度超限引起的 → rc=2
 *   （与 check-release-leak.mjs 的目录展开异常同源，release.ps1 只判 Rc -ne 0）；软闸只提示，不拦。
 *
 * 用法：
 *   node scripts/check-public-text.mjs                      # 扫 README + --help + files 全部文本
 *   node scripts/check-public-text.mjs body.md              # 再扫一个 release body 文件
 *   node scripts/check-public-text.mjs --repo <插件目录>     # 指定插件目录（默认自动找）
 */
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readIdentity, escapeRe } from './_identity.mjs'
import { scanCollab, CRED_RULES, EXEMPT_RULES, exemptFor } from './_rules.mjs'

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
 * 唯一读取处是 scripts/_identity.mjs：本文件与 scripts/check-release-leak.mjs 都 import 它，
 * 不许再抄第二份清单。三个来源合并、取值门槛（纯 ASCII ≥4 / 中文 ≥2）、
 * 「都取不到时放行但必须明说没扫什么」的语义都在那里实现。
 */
const { LOCAL_USER, IDENTITY_IDS, IDENTITY_WORDS } = readIdentity(repo)

/** 硬闸 · 对外文案面：命中即停 */
const HARD_PUBLIC = [
  { name: '内部指标/工作流', re: /verify\.mjs|断言|自检|反向测试|审查报告|台账|派单|切片|全绿|通过\s*\/\s*\d+\s*失败/ },
  // 注意：不能写成裸 \bP[0-2]\b——bilibili 的「分P」（--p N 默认 P1）会被误伤。
  // 内部优先级标记的形态是 P0：/ P0-1 / **P0**，都带冒号、连字符或加粗。
  // 协作方代称不再在这里存平行清单：scanCollab 用唯一那份词表（含 i 标志 + NFKC 归一化），
  // 能认全角、大小写与中间插空格的变体，也免得补一个词要改两处、漏改一处就一面放一面拦。
  // 编号类必须留在这里：词表不收编号，跟着一起删就等于真漏。
  { name: '内部编号', re: /\bE[1-8]-\d+\b|\bC\d{2,3}\b|\bP[0-2](?:-\d+|[:：])|\*\*P[0-2]\*\*/ },
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
  // 凭据与通用本机路径：与 check-release-leak.mjs 共用 scripts/_rules.mjs 的唯一一份。
  // body（release notes）是发版那一刻手写、会公开发布、原先唯一不过凭据扫描的面；
  // 这两条补上后，「没扫到的面」与「扫到脏东西」在退出码上都是失败，但措辞仍分开。
  ...CRED_RULES.map(([name, re]) => ({ name, re })),
]

/**
 * 硬闸 · 包内容面：四类判据，只查「谁 / 哪一轮 / 哪台机器」，不碰技术理由。
 *
 * 刻意不列的裸词（列了就会把「为什么这么写」一起删掉）：
 *   · 「老大」—— tools/look.mjs 的注入检测正则里有「自称老大 / 转述老大授权」，是功能代码；
 *   · 「实测」—— 技术依据的措辞，外部审单也明确要求保留这类句子；
 *   · 「复验 / 收口」—— 「装完复验 import」「就地收口」讲的是运行行为；
 *   · 「第N轮」—— 「面板 8 秒一轮」是轮询周期，只有跟外审/审查/复核连着才算协作轮次；
 *   · 「开发日期」—— 缺陷追踪索引（E4-02（2026-10-30，P0））按既定尺度保留。
 * 身份项同样不写死：取不到时整条不启用，并在汇总里明说没扫什么。
 */
const HARD_PACKAGE = [
  // 「内部协作标记 / 派单编号」两类已抽到 scripts/_rules.mjs，由 scanCollab 统一跑
  // （含 NFKC 归一化与 5 个变体缺口），这里不再存第二份平行清单。
  {
    name: '内部路径',
    re: /D:\\+007|Dsh工作区|[A-Za-z]:\\Users\\|\/Users\/|DeepSeek-Harness|GPT-SoVITS|bili-duty|bili-panel|刷B站|surf CORE/,
  },
  ...(IDENTITY_WORDS.length ? [{
    name: '本机身份项',
    re: new RegExp(IDENTITY_WORDS.map(escapeRe).join('|')),
  }] : []),
]

/** 软闸：只提示。这些是真实技术事实，删了反而降低可信度 */
const SOFT = [
  { name: '技术事实（保留）', re: /detached|DETACHED_PROCESS|internet 选项|Internet 选项|cp314|proxy|代理/ },
]

/** 展开 package.json.files 成实际待发布文本；与 check-release-leak.mjs 的 listTargets 同口径 */
const MAX_PACKAGE_DEPTH = 8
function listPackageTexts(root) {
  const out = { texts: [], binary: [], absent: [], complain: [], noFiles: false }
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) { out.noFiles = true; return out }
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { out.noFiles = true; return out }
  const entries = Array.isArray(pkg.files) ? pkg.files : []
  if (!entries.length) { out.noFiles = true; return out }

  const rels = new Set()
  for (const d of ['package.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(root, d))) rels.add(d)
  }
  // C293：目录项递归展开（npm 会递归打包）。两条硬规矩与 check-release-leak.mjs 同源：
  //   lstatSync 判符号链接并跳过（statSync 会跟进去，junction 把扫描面带出仓库）；
  //   深度上限 8，超了记 complain 并点名、进 incomplete，绝不静默截断。
  // 改前平铺分支没有 basename 排除，这里沿用同一个 isFile()，不另写一份。
  const walk = (rel, depth) => {
    if (depth > MAX_PACKAGE_DEPTH) {
      out.complain.push(`${rel}：目录层数超过 ${MAX_PACKAGE_DEPTH}，可能不是 package layout，已停止向下展开`)
      return
    }
    const full = join(root, rel)
    let st
    try { st = lstatSync(full) } catch { out.absent.push(`${rel}(读不出来)`); return }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      let names
      try { names = readdirSync(full) } catch { out.absent.push(`${rel}(读不出来)`); return }
      for (const name of names) walk(`${rel}/${name}`, depth + 1)
      return
    }
    if (st.isFile()) rels.add(rel)
  }
  for (const entry of entries) {
    const rel = entry.replace(/\/$/, '')
    const p = join(root, rel)
    // files 里写了但目录没建：进 absent，不抛异常。
    if (!existsSync(p)) { out.absent.push(entry); continue }
    walk(rel, 1)
  }
  for (const rel of [...rels].sort()) {
    let buf
    try { buf = readFileSync(join(root, rel)) } catch { out.absent.push(`${rel}(读不出来)`); continue }
    // 二进制不参与文本扫描：与 sync-release.ps1 的 Test-IsBinaryFile 同口径（前 8 KB 出现 NUL）
    if (buf.subarray(0, 8192).includes(0)) { out.binary.push(rel); continue }
    out.texts.push({ rel, text: buf.toString('utf8') })
  }
  return out
}

const hits = []
let scanned = 0
let publicScanned = 0
// 跳过不是「扫过了没问题」：--help 面没扫到就是对外面缺一面，必须单独记账并在摘要点名。
let helpSkipped = 0
let helpSkipReason = ''
let metaScanned = 0

function scan(label, text, rules, withSoft = false, collab = false) {
  scanned += 1
  // 豁免按「文件 + 行特征 + 规则名」三元组，不是整行：一行里有 GNU tar 不能把
  // 同一行的真 SESSDATA 一起放过。EXEMPT_RULES 与另一守卫共用唯一一份。
  const exemptFile = label.startsWith('包内:') ? label.slice(3) : label
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    let hit = false
    const isExempt = (rule) => exemptFor(EXEMPT_RULES, exemptFile, line, rule)
    // 包内容面：协作三类走唯一那份（含 NFKC 归一化），不在本地存正则。
    if (collab) {
      const cr = scanCollab(line).filter((name) => !isExempt(name))
      if (cr.length) {
        hits.push({ level: 'HARD', label, line: i + 1, rule: cr[0], text: line.trim() })
        hit = true
      }
    }
    if (!hit) {
      for (const rule of rules) {
        if (rule.re.test(line) && !isExempt(rule.name)) {
          hits.push({ level: 'HARD', label, line: i + 1, rule: rule.name, text: line.trim() })
          hit = true
          break
        }
      }
    }
    if (!withSoft || hit) continue
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

// 1) README（对外文案面）
const readme = join(repo, 'README.md')
if (!existsSync(readme)) {
  console.error(`✗ 找不到 ${readme}`)
  process.exit(2)
}
scan('README.md', readFileSync(readme, 'utf8'), HARD_PUBLIC, true, true)
publicScanned += 1

// 2) --help（帮助必须走 stdout）
const look = join(repo, 'tools', 'look.mjs')
if (existsSync(look)) {
  const r = spawnSync(process.execPath, [look, '--help'], { encoding: 'utf8', timeout: 60000 })
  const help = `${r.stdout || ''}\n${r.stderr || ''}`
  if (r.status === 0 && (r.stdout || '').trim()) {
    scan('--help', r.stdout, HARD_PUBLIC, true, true)
    publicScanned += 1
  } else {
    helpSkipped += 1
    helpSkipReason = `rc=${r.status}，stdout ${(r.stdout || '').length} B`
    console.log(`（--help 跳过：${helpSkipReason}）${help.trim() ? ` ${help.trim().slice(0, 120)}` : ''}`)
  }
} else {
  // 文件不存在也是「这一面没扫到」，不许显示成 `--help ✓`。
  // 不直接 exit 2：包内可以没有 look.mjs（只装 npm 包跑 CLI 的场景），该走「未扫全」而非硬失败。
  helpSkipped += 1
  helpSkipReason = 'tools/look.mjs 不存在'
  console.log(`（--help 跳过：${helpSkipReason}）`)
}

// 3) 附加文件（release body）
for (const f of bodyFiles) {
  const p = resolve(f)
  if (!existsSync(p)) { console.error(`✗ 找不到 ${p}`); process.exit(2) }
  scan(p, readFileSync(p, 'utf8'), HARD_PUBLIC, true, true)
  publicScanned += 1
}

// 3b) package.json 的 description / keywords 也是对外文案（npm 搜索页直接展示）。
//     它们原先只跟着 package.json 全文走 HARD_PACKAGE（内部路径 + 本机身份项），
//     从没过 HARD_PUBLIC 的「内部指标/工作流」，也没过 scanCollab —— 两面对外词全漏。
const pkgMeta = (() => {
  try {
    const j = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    return [String(j.description || ''), ...(Array.isArray(j.keywords) ? j.keywords : []).map(String)].join('\n')
  } catch { return '' }
})()
scan('package.json:description/keywords', pkgMeta, HARD_PUBLIC, false, true)
publicScanned += 1
// 读到空值等于这一面没扫（不是「扫过没问题」）：metaScanned 必须如实反映，退出码才有的判。
metaScanned = pkgMeta.trim() ? 1 : 0

// 4) package.json.files 展开的全部待发布文本（包内容面）
const pkg = listPackageTexts(repo)
for (const { rel, text } of pkg.texts) scan(`包内:${rel}`, text, HARD_PACKAGE, false, true)

// 汇总
const hard = hits.filter((h) => h.level === 'HARD')
const soft = hits.filter((h) => h.level === 'soft')

console.log(`\n扫描 ${scanned} 份文本（${repo}${bodyFiles.length ? ` + ${bodyFiles.length} 个附加文件` : ''}）`)
console.log(`  对外文案面 ${publicScanned} 份；包内容面 ${pkg.texts.length} 个文本（package.json.files 展开）`)
console.log(`  对外文案面：README ✓ / --help ${helpSkipped ? `跳过（${helpSkipReason}）` : '✓'} / body ${bodyFiles.length} 份 / description+keywords ${metaScanned ? '✓' : '未扫'}`)
if (helpSkipped) console.log(`  [warn] 对外文案面未扫全：--help 那一面没扫到（${helpSkipReason}），本次结果不等于三面全过`)
if (!pkgMeta.trim()) console.log('  [warn] package.json 的 description/keywords 没读到 —— 这一面没扫，不许当成扫过没问题')
console.log('')
if (pkg.binary.length) console.log(`  [skip] ${pkg.binary.length} 个二进制文件没做文本扫描：${pkg.binary.join(', ')}`)
if (pkg.absent.length) console.log(`  [warn] ${pkg.absent.length} 个 files 清单项不在盘上/读不出来、没扫：${pkg.absent.join(', ')}`)
if (pkg.complain.length) console.log(`  [warn] ${pkg.complain.length} 处目录展开异常：${pkg.complain.join('；')}`)
if (pkg.noFiles) console.log('  [warn] package.json 的 files 没解析出任何条目 —— 包内容这一面没扫，不许当成「扫过没问题」')

// 身份扫描覆盖度（2026-11-01 定的）：三个来源全空时**放行但必须明说少扫了什么**。
// 不许静默通过 —— 静默就等于「看起来扫过了」，而实际上昵称/mid 那两类根本没覆盖。
const idNote = IDENTITY_WORDS.length
  ? `身份项 ${IDENTITY_WORDS.length} 个（用户名${LOCAL_USER ? '已查' : '不可用'}、.leak-ids ${IDENTITY_IDS.length} 条已查）`
  : '身份项 0 个（用户名取不到、也没有 .leak-ids → 昵称/mid 两类**没扫**；' +
    '要扫就把身份写进仓库根 .leak-ids 或环境变量 BILI_WATCH_LEAK_IDS）'
console.log(`  ${idNote}\n`)

// 没扫到的面 = 不知道有没有泄漏，在退出码上只能是失败。
// 只打 [warn] 不够 —— release.ps1 只判 Rc，机器读不到 warn，没人看时这道闸仍是永真的。
// 措辞必须与「命中泄漏」分开，别让操作员把「没扫到」误读成「扫到脏东西」。
const incomplete = []
if (helpSkipped) incomplete.push(`--help ${helpSkipReason}`)
if (metaScanned === 0) incomplete.push('description/keywords 没读到')
// files 解析出 0 条时包内容面一份都没扫，与「扫过没问题」不能同码。
// 措辞沿用 :249 那句 warn，且只进 incomplete 不进 hard：语义是「没扫到」，不是「扫到脏东西」。
if (pkg.noFiles) incomplete.push('package.json 的 files 没解析出任何条目')
// 深度超限是「这一面没扫全」，不是「扫到脏东西」：进 incomplete 让 rc=1，措辞与命中分开。
if (pkg.complain.length) incomplete.push(`目录展开异常 ${pkg.complain.length} 处（${pkg.complain[0]}）`)
if (hard.length > 0) {
  console.log(`✗ 硬闸命中 ${hard.length} 行（必须删或改写）：\n`)
  for (const h of hard) {
    console.log(`  [${h.rule}] ${h.label}:${h.line}`)
    console.log(`    ${h.text.slice(0, 160)}`)
  }
} else if (incomplete.length) {
  console.log(`✗ 对外文案面未扫全（${incomplete.join('；')}） —— 没扫到的面等于不知道有没有泄漏，不许放行`)
} else {
  console.log('✓ 硬闸全过')
}

if (soft.length > 0) {
  console.log(`\n软闸提示 ${soft.length} 行（技术事实，人工看一眼该不该留）：\n`)
  for (const s of soft.slice(0, 12)) {
    console.log(`  ${s.label}:${s.line}  ${s.text.slice(0, 110)}`)
  }
  if (soft.length > 12) console.log(`  …还有 ${soft.length - 12} 行`)
}

// C296：深度超限（pkg.complain）进 incomplete，与 scripts/check-release-leak.mjs 的
//   COMPLAIN 同属「没扫到的面」。**这一类**两道闸统一判 rc=2，注释互相引用。
//   其余「未扫全」（--help 跳过 / description 没读到 / files 空）仍是原来的 rc=1：
//   C191 钉死了「tools/look.mjs 缺失不是 exit 2 硬失败」，不能因为修深度超限一起改掉。
//   硬闸命中（扫到脏东西）也是 rc=1，措辞与「没扫全」分开。
//   release.ps1 只判 Rc -ne 0，所以 1/2 的细分不改变发版链判定；
//   不许用改 MAX_PACKAGE_DEPTH 阈值糊弄 —— 洞还在，只是藏得更深。
if (hard.length > 0) process.exit(1)
if (incomplete.length > 0) process.exit(pkg.complain.length > 0 ? 2 : 1)
process.exit(0)
