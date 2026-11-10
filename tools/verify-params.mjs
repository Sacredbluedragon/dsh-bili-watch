#!/usr/bin/env node
/**
 * 参数契约组（2026-11-02）
 *
 * 为什么单开一个文件，而不是往 verify.mjs 里再加几条：
 *   这 7 条验的不是「某个函数的返回值」，是**参数层的契约**——
 *   HELP 文本 × 分派链 cmd === × KNOWN_FLAGS × README 四方对账，加 3 条真跑语义。
 *   塞进 6560 行的 verify.mjs，下一个改 HELP 的人不知道哪条该跟着改。
 *
 * 7 条靶子是怎么来的（别改成「抄台账」）：
 *   2026-11-02 在干净 worktree 上对 look.mjs:3373-3482 逐处扰动 11 组，
 *   观察到 7 个改动全绿的分支——这 7 条就是那 7 个分支。
 *   证据：_临时/20261102-dispatch/{mutate,mutate2}.js + result{,2}.json
 *
 * 现在的期望状态：**全部 11 条都应绿**。
 *   2026-11-02 第二步之后 ④⑦ 也满足了（--step 走域校验、--quiet 三处都认），
 *   原来「2 条靶子常红」的说法已失效——写在这里会让人把真回归当成「预期的靶子红」。
 *   看到红就是退化，别解释成靶子。
 *
 * 用法：node tools/verify-params.mjs
 * 不进 npm 包（files 白名单里没有它，与 verify.mjs / verify-todo.mjs 同理）；
 * 但要进 sync-release.ps1 的 $repoOnly —— 发布树就是 GitHub 仓库形态，clone 下来的人得能跑自检。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 执行器与失败信号只有一份（tools/check-run.mjs）。自己再写一份 = 又成了「验的和用的不是一个东西」，
// 那正是 C77 当初把 makeChecker 搬出去要解决的毛病。
import { makeChecker, must } from './check-run.mjs'
// 参数表本体（第一步）。它没有任何 IO、没有副作用，只导出声明与 audit()。
import { audit, KNOWN_FLAG_NAMES, VALUE_FLAG_NAMES } from '../lib/params.mjs'
// positional() 是纯函数（收一个数组、返一个数组），可以直接 import 来单测；
//   cli-io.mjs 顶层虽然会读本进程的 process.argv，但那只影响它导出的 cmd/pos 常量，与本文件无关。
import { positional } from './cli-io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const LOOK = join(HERE, 'look.mjs')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const results = []
const check = makeChecker(results)
const skip = (name, why) => results.push({ name, ok: false, skip: true, detail: why })

/** 起真进程跑 CLI。退出码与 stdout/stderr 分流只有真跑才验得到，读源码是猜。 */
function run(args) {
  const r = spawnSync(process.execPath, [LOOK, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  })
  if (r.error) throw new Error(`起子进程失败（${args.join(' ') || '(无参数)'}）：${r.error.message}`)
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' }
}

/** HELP 模板字面量的正文。锚点用「const HELP = 反引号」，不靠行号（行号一直在漂）。 */
function helpText(src) {
  const at = src.indexOf('const HELP = `')
  must(at >= 0, '找不到 HELP 模板（look.mjs 里 const HELP = 反引号）——锚点失效，先修断言再谈契约')
  const body = src.slice(at + 'const HELP = `'.length)
  const end = body.indexOf('`')
  must(end > 0, 'HELP 模板没有闭合反引号')
  return body.slice(0, end)
}

/** 分派链里的命令。只认 `} else if (cmd === 'xxx')` 这种形态，不去抓别处同名比较。 */
function dispatchCmds(src) {
  return [...new Set([...src.matchAll(/\} else if \(cmd === '([a-z0-9-]+)'/g)].map((m) => m[1]))]
}

/**
 * 分派链里「每个命令把哪些 flag 传下去了」。
 *
 * 为什么要按段切、而不是全文件 grep：同一个 flag 在不同命令下的去向不一样
 *   （`--out` 在 sub 是落盘、在 frames 是落目录），全文件 grep 只能得到「有人用过」，
 *   得不到「哪个命令认它」——而后者才是参数表要钉的东西。
 *
 * 段边界：从 `if (flag('help') && cmd !== 'help'` 起（那是分派前拦截，不属于任何命令），
 *   到顶层 `} catch (e) {` 止。段内出现 `} else if (cmd === 'x')` 就换段。
 * `src.type === 'generic'` 与 `'empty'` 两段**不是命令**（它们是源类型分支，
 *   generic 里确实传了 step/format/out/ffmpeg，但那属于「任意命令遇到通用 URL」，
 *   不是某一条命令的参数），所以遇到就把 cur 置空、不归属任何命令。
 */
/**
 * 分派前被统一读掉的全局常量：常量名 → 它代表的 flag。
 *
 * 第二步补（2026-11-02）：抽取器原来只认 `opt('x')` / `flag('x')` 字面形态，于是
 *   `step: STEP` / `p: P`（STEP / P 是 look.mjs 里预解析的两个常量）抽不到；
 *   「抽不到」在契约-8 的双向对账里被当成「没传」，第一步照现状抄就把 step / p
 *   从**所有命令**的 accepts 里删掉了 —— 判据看不清，改的却是被测对象。
 *   现在让判据认得这两个常量。以后新增全局常量，这里加一行即可。
 */
const GLOBAL_CONST = { STEP: 'step', P: 'p' }

function dispatchParams(src) {
  const lines = src.split('\n')
  const st = lines.findIndex((l) => l.includes("if (flag('help') && cmd !== 'help'"))
  must(st >= 0, "找不到分派前的 --help 拦截（锚点 `if (flag('help') && cmd !== 'help'`）——分派链结构变了，先修抽取器")
  const en = lines.findIndex((l, i) => i > st && /^\} catch \(e\) \{/.test(l))
  must(en > st, '找不到分派链末尾的顶层 } catch (e) { —— 分派链结构变了')

  // 映射自己也要有牙：常量名在源码里必须真有定义，否则这份映射就是死代码，
  //   而「映射失效」会静默退化成第一步那个错误（抽不到 → 当成没传）。
  for (const cn of Object.keys(GLOBAL_CONST)) {
    must(
      new RegExp(`\\bconst ${cn} =`).test(src),
      `抽取器认的全局常量 ${cn} 在源码里找不到 const ${cn} = —— 常量改名了，GLOBAL_CONST 该同步`,
    )
  }

  const out = {}
  let cur = null
  for (let i = st; i < en; i++) {
    const l = lines[i]
    if (/^\s*\/\//.test(l)) continue // 注释里写 opt('x') 不等于真传了，跳过
    if (/\} else if \(src\.type === '(?:generic|empty)'/.test(l)) {
      cur = null
      continue
    }
    const m = l.match(/\} else if \(cmd === '([a-z0-9-]+)'/)
    if (m) {
      cur = m[1]
      out[cur] = out[cur] || []
    }
    if (!cur) continue
    for (const q of l.matchAll(/\b(?:opt|flag)\('([a-z0-9-]+)'\)/g)) out[cur].push(q[1])
    // 常量形态一（对象键）：`step: STEP` —— 键名与常量对得上才算传了这个 flag
    for (const [cn, fn] of Object.entries(GLOBAL_CONST)) {
      if (new RegExp(`\\b${fn}:\\s*${cn}\\b`).test(l)) out[cur].push(fn)
    }
    // 常量形态二（位置参数）：`cmdView(BV, P)` / `cmdDanmaku(BV, P, {...})`
    if (/\bcmd\w+\(.*\bP\b/.test(l)) out[cur].push(GLOBAL_CONST.P)
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort()
  return out
}

/**
 * 真正被读过的 flag。
 *
 * 第二步修了第一步的一个扫描缺陷：原来只认 `opt('x')` / `flag('x')`，于是
 *   `tools/cli-io.mjs:88` 的 `if (argv.includes('--quiet')) setQuiet(true)` 扫不到，
 *   把 --quiet 误判成「死 flag」。它其实有效，B33 还有整条判据守着。
 * 三种形态都要认：opt() / flag() / argv.includes('--x')。
 */
function consumedFlags(src, cliSrc) {
  const a = [...src.matchAll(/\b(?:opt|flag)\('([a-z0-9-]+)'\)/g)].map((m) => m[1])
  const b = [...cliSrc.matchAll(/argv\.includes\(['"]--([a-z0-9-]+)['"]\)/g)].map((m) => m[1])
  return uniq([...a, ...b])
}

const uniq = (a) => [...new Set(a)]
const dash = (a) => a.map((x) => '--' + x).join(' ')

// 元命令白名单：跑 `node look.mjs help` 就是看这份文本本身，不列进命令清单。
// 白名单是**显式**的，且下面有一条断言钉住它不许腐烂（白名单里的名字必须真在分派链里）。
const META_CMDS = ['help']
// 参数白名单：--help 的行为由 C53 管（`<命令> --help` 只打帮助不执行），HELP 正文不重复解释它。
const META_FLAGS = ['help']

// ── ① 退出码语义 ───────────────────────────────────────────────
check('参数契约-1【真跑】缺参数的退出码：有命令名没给目标 rc=2 且提示走 stderr；一个参数都不给 rc=0 打全文', () => {
  const withCmd = run(['view'])
  must(withCmd.status === 2, `有命令名没给目标属用法错误，应 rc=2，实际 rc=${withCmd.status}`)
  must(withCmd.out.trim() === '', `用法错误时 stdout 必须为空（否则管道里拿到的是提示文本），实际 ${withCmd.out.length} 字节`)
  must(/需要 BV 号|缺少 BV|需要.{0,6}链接/.test(withCmd.err), `stderr 要说清缺什么，实际：${withCmd.err.slice(0, 160)}`)

  const bare = run([])
  must(bare.status === 0, `一个参数都不给是「想看用法」不是错误，应 rc=0，实际 rc=${bare.status}`)
  must(bare.out.includes('用法:'), '裸跑要打全文 HELP（stdout）')
})

// ── ② 失败时的 json 出口 ───────────────────────────────────────
check('参数契约-2【真跑】失败时的 json 出口：--format json 下 stdout 必须是能 parse 的 ok:false，不许 0 字节', () => {
  const r = run(['view', 'not-a-bv-xyz', '--format', 'json'])
  must(r.status !== 0, `认不出的输入必须 rc≠0，实际 rc=${r.status}`)
  must(r.out.trim().length > 0, 'stdout 不许 0 字节 —— 调用方 JSON.parse 会直接崩（X-18 修的就是这个）')
  let j
  try {
    j = JSON.parse(r.out)
  } catch (e) {
    throw new Error(`stdout 不是纯 JSON（${e.message}）：前 160 字 ${JSON.stringify(r.out.slice(0, 160))}`)
  }
  must(j && j.ok === false, `失败时 json 里必须 ok:false，实际 ok=${JSON.stringify(j && j.ok)}`)
})

// ── ③ 失败细节的分流 ───────────────────────────────────────────
check('参数契约-3【真跑】失败细节打 stderr、且不污染 stdout（json 模式下 ✗ 落进 stdout 会让它不可解析）', () => {
  const r = run(['view', 'not-a-bv-xyz', '--format', 'json'])
  must(r.err.includes('✗'), `失败细节要在 stderr 留一行 ✗，实际 stderr：${r.err.slice(0, 160)}`)
  must(!r.out.includes('✗'), '✗ 不许出现在 stdout（json 模式下会让整段不可解析）')
})

// ── ④ --step 的域（靶子，第二步修）────────────────────────────
check('参数契约-4【真跑·靶子】--step 的域：非数字/负数必须在做任何实际工作之前拒绝，不许等读到文件才报', () => {
  const bad = run(['local', '__no_such_file__.mp4', '--step', 'abc'])
  must(bad.status !== 0, `--step abc 应拒绝，实际 rc=${bad.status}`)
  must(/--step|步长|step 参数/.test(bad.err), `拒绝时要指名是 --step 的问题，实际 stderr：${bad.err.slice(0, 180)}`)
  must(
    !bad.err.includes('文件不存在'),
    '--step 非法时不该走到读文件那一步（现在报的是「文件不存在」，说明 --step 被静默当成合法值）',
  )

  const neg = run(['local', '__no_such_file__.mp4', '--step', '-5'])
  must(/--step|步长|step 参数/.test(neg.err), `--step -5 也要指名 --step 无效，实际 stderr：${neg.err.slice(0, 180)}`)
})

// ── ⑤ HELP 命令清单 × 分派链（静态）────────────────────────────
check('参数契约-5【静态】HELP 的命令清单 × 分派链 cmd === 双向一致，元命令白名单必须显式且不许腐烂', () => {
  const src = read('tools/look.mjs')
  const helpCmds = uniq([...helpText(src).matchAll(/node look\.mjs ([a-z][a-z0-9-]*)/g)].map((m) => m[1]))
  const dispCmds = dispatchCmds(src)
  must(dispCmds.length >= 10, `分派链只抽到 ${dispCmds.length} 个命令，抽取规则可能失效了（正常是 17 个左右）`)

  const missingInHelp = dispCmds.filter((c) => !helpCmds.includes(c) && !META_CMDS.includes(c))
  must(missingInHelp.length === 0, `分派链有、HELP 没列：${missingInHelp.join(' ')} —— 加命令忘了写 HELP 会红在这`)

  const missingInDisp = helpCmds.filter((c) => !dispCmds.includes(c))
  must(missingInDisp.length === 0, `HELP 列了、分派链里没有：${missingInDisp.join(' ')} —— HELP 在承诺一个不存在的命令`)

  // 白名单不许腐烂：META_CMDS 里的名字必须真在分派链里，否则白名单在替一个死命令放行
  const dead = META_CMDS.filter((c) => !dispCmds.includes(c))
  must(dead.length === 0, `元命令白名单里有分派链中不存在的命令：${dead.join(' ')}`)
})

// ── ⑥ 未知参数提示 ─────────────────────────────────────────────
check('参数契约-6【真跑】未知参数必须提示，近似拼错的要给建议（静默忽略等于让用户以为参数生效了）', () => {
  const typo = run(['help', '--stpe'])
  must(typo.err.includes('未知参数'), `拼错的参数要报「未知参数」，实际 stderr：${typo.err.slice(0, 160)}`)
  must(typo.err.includes('--step'), `近似的要给出建议（--stpe → --step），实际：${typo.err.slice(0, 160)}`)

  const far = run(['help', '--zzzzzz'])
  must(far.err.includes('未知参数'), `完全不像的参数也要提示，实际 stderr：${far.err.slice(0, 160)}`)
})

// ── ⑦ 参数的文档覆盖（静态，靶子，第二步修）──────────────────
check('参数契约-7【静态·靶子】参数表里的每个 flag 至少要在 HELP 或 README 有一处说明（不许「接受但没人知道」）', () => {
  const src = read('tools/look.mjs')
  const doc = helpText(src) + '\n' + read('README.md')
  const inDoc = uniq([...doc.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]))
  // 第二步：KNOWN_FLAGS 已从表生成，这里直接读表。**不是自指** ——
  //   判的是「表里的名字在 HELP/README 里有没有出现」，文档是被测对象之外的东西。
  //   表被打空的话下面的条数护栏会先红。
  const kf = KNOWN_FLAG_NAMES
  must(kf.length >= 20, `参数表只有 ${kf.length} 项，抽取规则可能失效了`)

  const undocumented = kf.filter((f) => !inDoc.includes(f) && !META_FLAGS.includes(f))
  must(
    undocumented.length === 0,
    `这些 flag 被接受（不报未知参数）、但 HELP 与 README 都没写，用户查不到：${dash(undocumented)}`,
  )
})

// ── 参数表对账（第一步，2026-11-02）──────────────────────────────
// 表在 lib/params.mjs。这三条只做两件事：从 look.mjs 抽出「现状」，让表去和它比。
// 为什么表要和现状比、而不是直接当新标准：第一步的约束是**行为零变化**，
//   表是照现状抄的（差异登记在 GAPS 里），所以这三条现在必须全绿。
//   它们绿着的意思是「此刻表和代码一致」；下一次谁改了分派链没改表，这里就红。
// 第二步把分派链改用这张表之后，这三条的作用会变成「锁住新写法」，判据不用改。
let _facts = null
function facts() {
  if (_facts) return _facts
  const src = read('tools/look.mjs')
  const cli = read('tools/cli-io.mjs')
  const dp = dispatchParams(src)
  _facts = {
    helpCmds: uniq([...helpText(src).matchAll(/node look\.mjs ([a-z][a-z0-9-]*)/g)].map((m) => m[1])),
    dispCmds: dispatchCmds(src),
    // 第二步：KNOWN_FLAGS 改为从 lib/params.mjs 生成，两侧恒等 —— 再比「表 vs 手写清单」
    //   就成了自指判据（表被打空它也绿）。改成验「文档覆盖」与「运行时是否真接受」，
    //   见下面的契约-7（文档）与契约-9（真跑）。
    docFlags: uniq([...(helpText(src) + '\n' + read('README.md')).matchAll(/--([a-z][a-z0-9-]+)/g)].map((m) => m[1])),
    consumed: consumedFlags(src, cli),
    dispatchParams: dp,
    dispatchParamsAny: uniq(Object.values(dp).flat()),
    unknownCmdSaysMissing: /缺少 BV|需要.{0,6}BV|需要.{0,6}链接/.test(run(['nosuchcmd']).err),
    // 真跑（给 GAPS 用）：view 不需要 --step，这里也不给 BV —— 正常的输出是「需要 BV 号」rc=2。
    //   只要 stderr 里没有「未知参数」，就说明**命令层面没有过滤参数的出口**：
    //   --step 在分派前被全局读掉，任何命令都不会因为「我不认它」而拒收。
    //   这条真跑比读源码硬：源码里看不出「不拒收」，只有喂一个不属于它的参数才知道。
    stepAcceptedByNonUser: !/未知参数/.test(run(['view', '--step', '5']).err),
  }
  return _facts
}

// ── ⑧ 命令层 ───────────────────────────────────────────────────
check('参数契约-8【静态】参数表 × 分派链 × HELP：命令三方一致，且每个命令声明的参数与分派链真传的一致', () => {
  const r = audit(facts())
  must(r.cmds.length === 0, `命令层对不上 ${r.cmds.length} 处：\n      - ${r.cmds.join('\n      - ')}`)
  // 抽取器自己也要防失效：抽不到命令时两边都是空，上面必然全绿，那是假绿
  must(facts().dispCmds.length >= 10, `分派链只抽到 ${facts().dispCmds.length} 个命令，抽取器可能失效了`)
})

// ── ⑨ flag 层 ──────────────────────────────────────────────────
// 第二步：KNOWN_FLAGS 已从参数表生成，「表 vs 手写清单」这条对账失去意义（两侧恒等，自指）。
//   换成**真跑**：表里每个 flag 必须真的被接受（不报未知参数），表外的一个必须被拒。
//   这条同时锁住「表 → KNOWN_FLAGS 的生成确实生效」和「未知参数警告确实在工作」——
//   两者都只有真跑才验得到，读源码只能验「字面量里有没有这个词」。
check('参数契约-9【真跑】参数表里的每个 flag 运行时都必须被接受；表外的一个必须被拒并给建议', () => {
  // 带值的 flag 要给一个合法值，否则校验会先把它当「缺值」拒掉，测的就不是「认不认得」了
  const SAMPLE = { step: '2', p: '1', limit: '5', days: '0', head: '10', 'asr-max': '30000', grid: '3x3' }
  const rejected = []
  for (const f of KNOWN_FLAG_NAMES) {
    const val = SAMPLE[f]
    // 用 help 命令：它只打 HELP、不做任何实际工作，是测「认不认这个 flag」最便宜的方式
    const r = run(['help', `--${f}`, ...(val ? [val] : [])])
    if (/未知参数/.test(r.err)) rejected.push(`--${f}`)
  }
  must(rejected.length === 0, `表里有、运行时却报未知参数：${rejected.join(' ')} —— 表与 KNOWN_FLAGS 的生成链断了`)

  const outside = run(['help', '--totallynotaflag'])
  must(/未知参数/.test(outside.err), '表外的 flag 没被拒 —— 未知参数警告失效了（这条判据没有牙了）')

  // 另一半：表里的每个 flag 必须有消费点（第一步的 dead 分类删掉了，改成「没人读就红」）
  const r = audit(facts())
  must(r.flags.length === 0, `flag 层对不上 ${r.flags.length} 处：\n      - ${r.flags.join('\n      - ')}`)
  return `${KNOWN_FLAG_NAMES.length} 个 flag 逐个真跑都被接受；表外的被拒；每个都有消费点`
})

// ── ⑩ GAPS 闭环 ────────────────────────────────────────────────
check('参数契约-10【静态】GAPS 两端咬：该在的差异还在，修好了必须撤登记（只咬一边的清单会腐烂）', () => {
  const r = audit(facts())
  must(r.gaps.length === 0, `GAPS 自身有问题 ${r.gaps.length} 处：\n      - ${r.gaps.join('\n      - ')}`)
  must(
    r.stale.length === 0,
    `这 ${r.stale.length} 条登记已经过期、代码里不复现了，请删掉对应 GAPS 条目：\n      - ${r.stale.join('\n      - ')}`,
  )
})

// ── ⑪ 带值 flag 的值不许被当成位置参数 ────────────────────────
// 这条是第二步修的真 bug 的直接判据：`at` 原来只在 KNOWN_FLAGS、不在 VALUE_OPTS，
//   于是 `frames --at 12:30 BV1xx` 里的 12:30 被 positional 当成第一个位置参数，
//   BV 落到 pos[2]，整个命令拿不到目标。两张表合成一张之后这类漏项不该再有，所以立一条盯着。
check('参数契约-11【单元】每个带值 flag 的值，都不许被 positional 当成位置参数', () => {
  const bad = []
  for (const f of VALUE_FLAG_NAMES) {
    const got = positional([`--${f}`, 'VAL', 'TARGET'])
    if (JSON.stringify(got) !== '["TARGET"]') bad.push(`--${f} → ${JSON.stringify(got)}`)
  }
  must(bad.length === 0, `这些带值 flag 的值被当成了位置参数：\n      - ${bad.join('\n      - ')}`)

  // 反向：布尔 flag 后面那个词**应该**被当成位置参数（它不带值）
  const b = positional(['--full', 'BV1xx411c7mD'])
  must(JSON.stringify(b) === '["BV1xx411c7mD"]', `布尔 flag 后面那个词被误吞了：${JSON.stringify(b)}`)

  // VALUE_OPTS 必须覆盖表里所有非 bool 的 flag —— 这条钉住「从表生成」这件事本身
  must(
    VALUE_FLAG_NAMES.length >= 12,
    `带值 flag 只认出 ${VALUE_FLAG_NAMES.length} 个，表可能被改坏了`,
  )
  return `${VALUE_FLAG_NAMES.length} 个带值 flag 的值都不进位置参数；布尔 flag 后面的词仍进`
})

// ── ⑫ 生效中的参数不许被 C230 判成「不接受」 ────────────────────
// 起因（C242 收口）：--keep-source 在分派链之前的 runGeneric() 里被 flag() 读，
//   dispatchParams 扫不到它，所以它不能写进 asr/frames/text 的 accepts（那是 BV 路径，
//   分派链没传，写了就是假声明，契约-8 会红）。正确归属是 RUNTIME_GLOBAL_PARAMS。
// 但如果只把 accepts 里的假声明删掉、忘了往 RUNTIME_GLOBAL_PARAMS 补，
//   契约-8 会变绿、GAPS check 仍为 true、C256 五形态也仍绿 —— 三条全绿，
//   而 `frames <URL> --keep-source` 会被 C230 打成「本命令不接受（不会生效）」，
//   参数其实正在生效。这比静默忽略更坏：是**说反了**。
// 所以这条不看表、只看真跑的 stderr：三条命令各跑一次，不许出现那句 warn。
// 修前红证据：把 RUNTIME_GLOBAL_PARAMS 里的 'keep-source' 摘掉，本条立刻红。
check('参数契约-12【真跑】生效中的 --keep-source 不许被 C230 判成「本命令不接受」', () => {
  // ① 行为断言在前：真跑三命令，stderr 不许出现「本命令不接受 --keep-source」
  const bad = []
  for (const c of ['frames', 'asr', 'text']) {
    const r = run([c, '--keep-source']) // run() 起子进程失败会自己抛，不需要恒真断言兜底
    if (/本命令不接受[^\n]*keep-source/.test(r.err)) bad.push(`${c}: ${r.err.trim().slice(0, 140)}`)
  }
  must(bad.length === 0, `这些命令把生效中的 --keep-source 判成了「不接受」：\n      - ${bad.join('\n      - ')}`)

  // ② 静态守卫在后：豁免与两端咬登记都要在，accepts 里不许回潮假声明
  const params = read('lib/params.mjs')
  const rgLine = params.match(/export const RUNTIME_GLOBAL_PARAMS[^\n]*/)?.[0] || ''
  must(rgLine.includes("'keep-source'"), 'RUNTIME_GLOBAL_PARAMS 没豁免 keep-source')
  must(params.includes("id: 'keep-source-off-dispatch'"), '消费点不在分派链这件事没登记，位置偏差会腐烂')
  const cmdsBlock = params.slice(params.indexOf('export const COMMANDS'), params.indexOf('// ── 现状偏差登记'))
  must(!/accepts:[^\n]*'keep-source'/.test(cmdsBlock),
    'keep-source 被写回命令 accepts —— 三段都是 BV 路径，分派链没传，属于假声明')
  return '三条命令真跑零误伤；豁免 + GAPS 登记在位；accepts 无假声明'
})

// ── 汇总 ──────────────────────────────────────────────────────
// 与 verify.mjs 同一套口径：跳过不进通过数、也不算失败；失败才 exit 1。
let pass = 0, fail = 0, skipN = 0
for (const r of results) {
  if (r.skip) skipN++
  else if (r.ok) pass++
  else fail++
  const tag = r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`)
}
console.log(`\n${pass} 通过 / ${fail} 失败 / ${skipN} 跳过`)

if (skipN > 0) {
  console.log(`\n跳过明细（${skipN} 条，不计入通过数、也不致红）：`)
  for (const r of results) if (r.skip) console.log(`  · ${r.name}\n    ${r.detail || '（没写原因 —— 这条要补）'}`)
}

// 红的分两类：预期中的靶子 / 意外回归。只看汇总行的人分不出这两者，所以这里点名。
// 判前缀而不是比截断后的短名 —— 中文字符串按码元截会切歪（slice(0,9) 拿到的是「参数契约-4【真跑」，
// 跟白名单里的「参数契约-4」对不上，于是 2 条预期红被误报成意外红）。
// 2026-11-02：原有两个靶子（④--step 域、⑦--quiet）第二步已修，这里清空。
//   留空意味着「任何红都是意外」，不再是「预期中的靶子红」。
const TARGETS = []
const reds = results.filter((r) => !r.ok && !r.skip)
const short = (r) => r.name.split('【')[0]
const redTargets = reds.filter((r) => TARGETS.some((t) => r.name.startsWith(t)))
const redUnexpected = reds.filter((r) => !TARGETS.some((t) => r.name.startsWith(t)))
if (reds.length) {
  if (redTargets.length) {
    console.log(`\n预期中的靶子红 ${redTargets.length} 条（${redTargets.map(short).join('、')}）：第二步修完才会绿，不是回归。`)
  }
  if (redUnexpected.length) {
    console.log(`\n意外红 ${redUnexpected.length} 条（${redUnexpected.map(short).join('、')}）：这几条本该是绿的，先查是不是真退化了。`)
  }
}

process.exit(fail ? 1 : 0)
