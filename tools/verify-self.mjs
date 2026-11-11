/**
 * tools/verify-self.mjs —— 元判据独立入口（3a：A-2 元判据搬出主闸）
 *
 * C271/C272/C274/C275/C277/C284/C286/C294/C295 九条从 tools/verify.mjs 整条搬来。
 * 它们验的是主闸自己（--only / 输出瘦身 / --fast 分档 / 汇总守恒），放在主闸里
 * 会让主闸每次全量重跑自己，实测把约 141 秒拖到 490 秒。
 *
 * 独立跑：node tools/verify-self.mjs
 * 不进发布五闸、不进 --fast 分档；`--only` 仍可用（扰动取证用）。
 * 被测对象**永远是主闸 tools/verify.mjs**，绝不能指向本文件（那会全绿但什么也没验）。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  makeChecker, must, parseOnlySpecs, matchOnly, onlyNoticeLine, renderResults,
  SLOW_CHECKS, fastNoticeLine,
} from './check-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VERIFY_MAIN = 'tools/verify.mjs'   // 被测对象：主闸（C312 守着，不许改成自己）
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const PROBE_CHILD = process.env.BW_VERIFY_PROBE_CHILD === '1'
// 独立入口不做取证子进程：下面六条搬来的判据里保留了轻量分支（原文未改），
// 正常调用路径不设这两个环境变量，它们恒不触发；C312 另有静态守卫盯着被测对象。
const LIGHT_SKIP_DETAIL = '本次未真跑，真跑只在父进程'

const results = []
const ARGV = process.argv.slice(2)

// 2026-11-11（22:50 DSH 裁定 1）：发版链 -DryRun 专用烟测。
// 完整九条会 spawn 主闸默认全量取证（本机 428 秒、DryRun 实测 14m18s），拿它当
// 干跑闸等于把闸变成没人敢按的摆设。干跑的用途是查写盘面，不是查判据。
// 烟测只验「入口在 / 主闸语法过 / 主闸能启动」，在任何 check() 注册之前就退出；
// 真跑（不带 --smoke）走下面的完整九条，语义一字未动。
if (ARGV.includes('--smoke')) {
  const t0 = Date.now()
  const die = (msg) => { console.error(`[smoke] FAIL ${msg}`); process.exit(1) }
  let mainSrc
  try { mainSrc = read(VERIFY_MAIN) } catch (e) { die(`主闸读不出来：${e.message}`) }
  if (mainSrc.length < 100000) die(`主闸只有 ${mainSrc.length} 字符，疑似被截断`)
  const chk = spawnSync(process.execPath, ['--check', join(ROOT, VERIFY_MAIN)], {
    cwd: ROOT, encoding: 'utf8', timeout: 2000,
  })
  if (chk.error || chk.status !== 0) {
    die(`node --check 没过：${chk.error ? chk.error.message : (chk.stderr || '').trim()}`)
  }
  // 「能启动」用不存在的编号：主闸完整加载、走到汇总才退出，一条判据体都不执行。
  // 这里 rc=1 是**预期**（没匹配到判据按设计 exit 1），不是失败；实测约 0.6 秒。
  const boot = spawnSync(process.execPath, [VERIFY_MAIN, '--only', '=C999999'], {
    cwd: ROOT, encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024,
  })
  const bootOut = `${boot.stdout || ''}${boot.stderr || ''}`
  if (boot.error || boot.status !== 1 || !bootOut.includes('没匹配到任何判据')) {
    die(`主闸启动探针没走到预期汇总：${boot.error ? boot.error.message : `rc=${boot.status} ${bootOut.slice(-160)}`}`)
  }
  console.log(`[smoke] OK 主闸 ${mainSrc.length} 字符 / --check 过 / 启动探针 rc=1（无匹配，设计如此）/ ${Date.now() - t0}ms`)
  process.exit(0)
}

const specs = parseOnlySpecs(ARGV)
const onlySpec = specs !== null
const RENDER_VERBOSE = ARGV.includes('--verbose') || onlySpec
const selfNames = []
let ranChecks = 0
const select = (name) => {
  selfNames.push(name)
  const hit = matchOnly(name, specs)
  if (hit) ranChecks++
  return hit
}
const check = makeChecker(results, select)
// 搬来的块统一用 check( 注册；本入口不进 --fast，不需要 makeSlowChecker 的登记。
const slowCheck = check
const skip = (name, why) => {
  if (!matchOnly(name, specs)) return
  results.push({ name, ok: false, skip: true, detail: why })
}
const lightSkip = (id) => skip(id, LIGHT_SKIP_DETAIL)

// 两个主闸局部状态：从主闸源码真求值重建，不是写死的常量。
// allNames 供 C271 的「默认路径输出条数 ≥ 主闸 check 数」下界；
// extraUnits 供 C275/C286 的判据单元守恒式。
const mainLines = read(VERIFY_MAIN).split('\n')
const allNames = mainLines.filter((l) => /^(?:check|slowCheck)\(\s*'/.test(l))
const extraUnits = mainLines.filter((l) => /^\s*unitSkip\(/.test(l))

// 元判据取证链：照搬主闸原定义，语义不变；子进程一律指向主闸。
const verifyRuns = new Map()
function runVerify(args = []) {
  const key = JSON.stringify(args)
  if (!verifyRuns.has(key)) {
    verifyRuns.set(key, spawnSync(process.execPath, [VERIFY_MAIN, ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, BW_VERIFY_PROBE_CHILD: '1', BW_VERIFY_C271_CHILD: '1' },
    }))
  }
  return verifyRuns.get(key)
}
// 2026-11-11（22:50 DSH 裁定 1）：400000 是既有超时 bug。主闸全量实测 428 秒，
// DSH 带 PROBE_CHILD 复现实测 346 秒 —— 400 秒余量只有 54 秒，负载一抖就 rc=null。
// 元判据接进发版链后才第一次暴露；900000 给足一倍余量，C345 静态守着不许改回去。
function runVerifyEnv(args, on) {
  return spawnSync(process.execPath, [VERIFY_MAIN, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      BW_VERIFY_PROBE_CHILD: on ? '1' : '0',
      BW_VERIFY_C271_CHILD: on ? '1' : '0',
    },
  })
}

// ── 以下九条判据从 tools/verify.mjs 整条搬来（3a）；断言逻辑一字未改，
//    仅把 slowCheck( 注册改回 check(，并按 11:30 §二 2 把 C295 的写死 9 换成真跑恒等式。──

check('C271【主判据】--only 只跑匹配判据、未跑提示必在、默认路径一行不多打', () => {
  const CHILD = process.env.BW_VERIFY_C271_CHILD === '1'
  if (PROBE_CHILD) { lightSkip('C271'); return }

  // ① 真求值执行器：过滤必须发生在**断言体调用之前**，不是「跑了再过滤输出」
  const probeResults = []
  const called = []
  const c = makeChecker(probeResults, (n) => n === 'C1')
  c('C1', () => { called.push('C1'); return 'ok' })
  c('C2', () => { called.push('C2'); return 'ok' })
  must(called.length === 1 && called[0] === 'C1',
    `C271：不匹配的断言体被调用了（${called.join(',')}）—— 过滤只在输出层，省不了上下文`)
  must(probeResults.length === 1,
    'C271：不匹配的判据被记进了 results —— 没跑的判据会污染退出码与汇总')

  // ② 真求值三个纯函数（默认路径必须是「不过滤 / 不提示」）
  must(parseOnlySpecs(['a', 'b']) === null, 'C271：无 --only 时不该解析出过滤条件')
  must(JSON.stringify(parseOnlySpecs(['--only', 'C258,C259'])) === JSON.stringify(['C258', 'C259']),
    'C271：逗号分隔没拆开')
  must(JSON.stringify(parseOnlySpecs(['--only=c24'])) === JSON.stringify(['C24']),
    'C271：--only= 形式 / 大小写归一没生效')
  must(JSON.stringify(parseOnlySpecs(['--only'])) === JSON.stringify([]),
    'C271：--only 没给值时应返回空数组（由调用方报错），不能悄悄全选')
  must(matchOnly('C268【主判据】…', null) === true, 'C271：默认路径必须全选')
  must(matchOnly('C268【主判据】…', ['C268']) === true &&
    matchOnly('C269【主判据】…', ['C268']) === false, 'C271：精确编号匹配口径不对')
  must(matchOnly('C240 a', ['C24']) === true && matchOnly('C241 x', ['C24']) === true &&
    matchOnly('C250 x', ['C24']) === false, 'C271：编号前缀匹配口径不对')
  must(matchOnly('版本号不是 0.2.22（P0：…）', ['C1']) === false,
    'C271：名字不带 C 编号的判据不该被 C 前缀选中')
  must(onlyNoticeLine(270, 3, false) === null, 'C271：默认路径冒出了未跑提示')
  must(onlyNoticeLine(270, 3, true) === '[--only] 本 run 只跑了 3 / 270 条，其余 267 条未执行',
    'C271：未跑提示的分子 / 分母 / 余数不守恒')

  // ③ 真跑 CLI：只跑一条 / 逗号分隔 / 不存在的编号必须明确报错并 exit 1
  const runOnly = (...args) => spawnSync(process.execPath, ['tools/verify.mjs', ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  const one = runOnly('--only', 'C258')
  const o1 = `${one.stdout || ''}${one.stderr || ''}`
  must(one.status === 0, `C271：--only C258 自己失败 rc=${one.status}：${o1.slice(0, 200)}`)
  // 提示行只认 stdout：16:15 段明写「不许只写在 stderr」，拼 stdout+stderr 会放过这种退化。
  const n1 = (one.stdout || '').match(/只跑了 (\d+) \/ (\d+) 条，其余 (\d+) 条未执行/)
  must(n1 && Number(n1[1]) === 1 && Number(n1[1]) + Number(n1[3]) === Number(n1[2]),
    'C271：--only C258 的提示行分子 / 分母 / 余数不守恒（或没打在 stdout）')
  must((o1.match(/^PASS  /gm) || []).length === 1,
    'C271：--only C258 实际跑了不止一条 —— 提示行的「1」是假的')
  must(((one.stdout || '').match(/^\[--only\]/gm) || []).length === 1,
    'C271：--only 路径的未跑提示没打在 stdout、或打了不止一次')
  const m1 = o1.match(/(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/)
  must(m1 && Number(m1[1]) === 1 && Number(m1[2]) === 0 && Number(m1[3]) === 0,
    'C271：--only 的汇总行没反映「实际只跑了 1 条」')

  const two = runOnly('--only', 'C258,C259')
  const o2 = `${two.stdout || ''}${two.stderr || ''}`
  must(two.status === 0 && /只跑了 2 \//.test(o2) &&
    (o2.match(/^PASS  /gm) || []).length === 2,
    'C271：逗号分隔没跑满两条，或计数与实际不一致')

  const none = runOnly('--only', 'C999999')
  const on = `${none.stdout || ''}${none.stderr || ''}`
  must(none.status === 1, `C271：不存在的编号必须 exit 1，实际 rc=${none.status}`)
  must(/没匹配到任何判据/.test(on), 'C271：不存在的编号没明确报「没匹配到任何判据」')
  must(((none.stdout || '').match(/^\[--only\]/gm) || []).length === 1,
    'C271：连一条都没跑时未跑提示也要打在 stdout、且只打一次')
  must((on.match(/^PASS  /gm) || []).length === 0, 'C271：没匹配到却仍跑了判据')

  // ④ 默认路径：真跑一次无参数主闸。子进程里本判据走轻量分支，防自举递归；
  //    它仍记一笔 PASS，所以子进程汇总条数应与父进程完全一致。
  //    C272 把默认路径的 PASS 明细换成「[N 条 PASS 未列明细]」一行后，「汇总 === 逐条
  //    PASS 行数」不再成立（分母被折叠了），改成「汇总 === 逐条 PASS + 计数行里的 N」。
  //    守的仍是同一件事：汇总行不许撒谎。牙没松 —— 计数行写错数照样红。
  if (!CHILD) {
    const full = runVerify([])
    const o = full.stdout || ''
    const childFail = (o.match(/^FAIL  .*$/m) || [''])[0]
    must(full.status === 0,
      `C271：默认路径子进程 rc=${full.status}：${childFail.slice(0, 200)} / ${(full.stderr || '').slice(0, 120)}`)
    must(!o.includes('[--only]'), 'C271：默认路径冒出了未跑提示 —— 加参数改变了默认行为')
    const m = o.match(/(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/)
    const passLines = (o.match(/^PASS  /gm) || []).length
    const failLines = (o.match(/^FAIL  /gm) || []).length
    const folded = /^\[(\d+) 条 PASS 未列明细，加 --verbose 看\]$/m.exec(o)
    must(m && Number(m[2]) === 0, 'C271：默认路径出现失败')
    must(m && Number(m[1]) === passLines + (folded ? Number(folded[1]) : 0) && Number(m[2]) === failLines,
      'C271：默认路径的汇总数字与逐条输出 + 折叠计数不一致（汇总行撒谎）')
    // 1650 段必修 3：子进程里轻量分支改成 SKIP 后，只数 PASS 行会把它们数丢。
    //   元判据必须三向都记：逐行 PASS（含折叠计数）、SKIP、FAIL 各自与汇总对齐且合计守恒。
    //   这不是「把 SKIP 排除在证据外」——排除掉之后输出看起来少了几条，同样是假的。
    const skipLines = (o.match(/^SKIP  /gm) || []).length
    must(m && Number(m[3]) === skipLines,
      `C271：子进程 SKIP 明细 ${skipLines} 行 ≠ 汇总跳过数 ${m && m[3]}（轻量分支改 SKIP 后元判据数少了）`)
    must(m && Number(m[1]) + Number(m[2]) + Number(m[3]) ===
      passLines + (folded ? Number(folded[1]) : 0) + failLines + skipLines,
      'C271：子进程 PASS/SKIP/FAIL 三向逐行数与汇总合计不守恒')
    // 确定性下界，不是概率阈值：每条 check 至少产出一行；个别判据在 check() 内部
    //   调 skip() 只会让行数更多，不会更少。少跑任何一条都会把总数压到这个界以下。
    must(m && Number(m[1]) + Number(m[3]) >= allNames.length,
      `C271：默认路径输出条数少于 check 数 ${allNames.length} —— 有判据根本没跑`)
  }

  // 不读 verify.mjs 源码切块做静态守卫：锚点字符串会落在判据自己的字面量里，
  //   indexOf 切进判据内部就自伤（实测连踩两次）。「默认路径一行不多打」由 ④ 真跑
  //   无参数子进程守住（无提示行 + 汇总条数 + PASS 行数），比抠源码文本硬得多。

  return `执行器只调匹配断言体；3 纯函数真求值；--only C258 跑 1 条 / 逗号 2 条 / C999999 exit 1；默认路径真跑无提示且条数自洽`
})

check('C272【主判据】默认全量 stdout ≤ 2 KB（硬数 2048），PASS 折叠成一行计数', () => {
  // ① 真求值被测对象：喂 271 条带长 detail 的 PASS，看渲染函数返回的字节数。
  //    把 renderResults 改回「逐条打 PASS」时这一条立刻红，不看实现脸色。
  const fake = Array.from({ length: 271 }, (_, i) => ({
    name: `C${i} 判据名字`, ok: true, detail: '这是一段很长的说明串'.repeat(20),
  }))
  const rendered = renderResults(fake, { verbose: false })
  const fakeBytes = Buffer.byteLength(rendered.lines.join('\n') + '\n', 'utf8')
  must(fakeBytes <= 2048,
    `C272：271 条长 PASS 渲染出 ${fakeBytes} B > 2048 B —— PASS 又被逐条打出来了`)
  must(!rendered.lines.some((l) => l.startsWith('PASS  ')), 'C272：瘦身后仍出现逐条 PASS 明细')
  must(rendered.lines.some((l) => l === '[271 条 PASS 未列明细，加 --verbose 看]'),
    'C272：折叠计数行缺失或数字不对')

  // ② 真跑：默认路径的 stdout 才是「全绿时」那句话指的 stdout。
  if (!PROBE_CHILD) {
    const r = runVerify([])
    const out = r.stdout || ''
    const bytes = Buffer.byteLength(out, 'utf8')
    must(r.status === 0, `C272：默认路径真跑 rc=${r.status}`)
    must(bytes <= 2048, `C272：默认全量 stdout ${bytes} B > 2048 B（硬数，不许改阈值）`)
    const m = /(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/.exec(out)
    must(m && Number(m[2]) === 0, 'C272：默认路径不是全绿，量字节数没意义')
    const folded = /^\[(\d+) 条 PASS 未列明细/m.exec(out)
    const passLines = (out.match(/^PASS  /gm) || []).length
    must(folded && Number(folded[1]) === Number(m[1]) - passLines,
      'C272：折叠数与汇总通过数不守恒')
    must(!/^\[--only\]|^\[--fast\]/m.test(out), 'C272：默认路径冒出了分档提示')
  }
  return `真求值 271 条长 PASS → ${fakeBytes} B；默认路径真跑 stdout ≤2048 B`
})

check('C274【主判据】--verbose 逐条全明细，与默认路径只差 PASS 折叠且其余行归一后逐字节一致', () => {
  // 归一的是「本来就每次不同」的动态字段，与 C247 的默认路径比对同一套规则。
  const norm = (s) => s.split(/\r?\n/).map((l) => l
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp\\[^\s，；)"']*/g, '<TMP>')
    .replace(/\bbw-[a-z0-9-]+-[A-Za-z0-9]+/gi, '<RAND>')
    .replace(/\d+(?:\.\d+)?\s*ms/g, '<MS>')
    .replace(/回收站 \d+→\d+/g, '回收站 <N>→<N>')
    .replace(/recycle \d+→\d+/g, 'recycle <N>→<N>')
    .replace(/修前态 \d+→\d+/g, '修前态 <N>→<N>')
    .replace(/^\d+ 通过 \/ \d+ 失败 \/ \d+ 跳过$/, '<SUMMARY>')
    .trimEnd())
  if (PROBE_CHILD) { lightSkip('C274'); return }
  const lean = runVerify([])
  const full = runVerify(['--verbose'])
  must(lean.status === 0 && full.status === 0, 'C274：双路径真跑有非 0 退出')
  const a = lean.stdout || '', b = full.stdout || ''
  // ① 全明细形态：每条 PASS 独立一行，行数 === 汇总通过数；不许有折叠行。
  const m = /(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/.exec(b)
  const passLinesB = (b.match(/^PASS  /gm) || []).length
  must(m && passLinesB === Number(m[1]),
    `C274：--verbose 的 PASS 明细 ${passLinesB} 行 ≠ 汇总通过 ${m && m[1]}`)
  must(!/条 PASS 未列明细/.test(b), 'C274：--verbose 出现折叠计数行 —— 全明细没生效')
  must((a.match(/^PASS  /gm) || []).length === 0, 'C274：默认路径仍有逐条 PASS 行')
  must(/条 PASS 未列明细/.test(a), 'C274：默认路径缺折叠计数行')
  // ② 去掉 PASS 明细与折叠行后，两条路径其余行归一后逐字节一致。
  const strip = (s) => norm(s).filter((l) => l && !/^PASS  /.test(l) && !/条 PASS 未列明细/.test(l))
  const la = strip(a), lb = strip(b)
  const diffs = []
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) diffs.push(`L${i + 1}: ${JSON.stringify(la[i])} vs ${JSON.stringify(lb[i])}`)
  }
  must(diffs.length === 0,
    `C274：两条路径的非 PASS 行有 ${diffs.length} 处差异：${diffs.slice(0, 3).join(' | ')}`)
  return `--verbose ${passLinesB} 行全明细；默认 0 行；其余 ${la.length} 行归一后逐字节一致`
})

check('C275【主判据】--fast 有跳过提示，两个数字都是运行时计数且守恒', () => {
  // ① 纯函数真求值：默认路径不许冒提示，active 时格式与数字同源。
  must(fastNoticeLine(93, 181, false) === null, 'C275：默认路径冒出了 --fast 提示')
  const line = fastNoticeLine(7, 11, true)
  must(line === '[--fast] 本次跳过 7 条含子进程判据，其余 11 条已跑',
    'C275：提示行格式或数字不对')
  if (PROBE_CHILD) { lightSkip('C275'); return }
  // ② 真跑 --fast：一条提示、无 --only、跳过数 + 已跑数 === 总 check 数。
  //    总数不写常量，从「--only 一个不存在的编号」的分母里拿，与提示行同源口径。
  const fast = runVerify(['--fast'])
  must(fast.status === 0,
    `C275：--fast 真跑 rc=${fast.status}：${(fast.stdout || '').slice(0, 200)}`)
  const fo = fast.stdout || ''
  const fl = /^\[--fast\] 本次跳过 (\d+) 条含子进程判据，其余 (\d+) 条已跑$/m.exec(fo)
  must(fl, 'C275：--fast 没有跳过提示行，或格式不符')
  must((fo.match(/^\[--fast\]/gm) || []).length === 1, 'C275：--fast 提示行不止一条')
  must(!fo.includes('[--only]'), 'C275：--fast 路径冒出了 --only 提示')
  const skipped = Number(fl[1]), ran = Number(fl[2])
  must(skipped > 0 && ran > 0, `C275：跳过 ${skipped} / 已跑 ${ran} —— 数字像写死的常量`)
  const none = runVerify(['--only', 'C999999'])
  must(none.status === 1, 'C275：不存在的编号没 exit 1')
  const totalM = /共 (\d+) 条判据/.exec((none.stdout || '') + (none.stderr || ''))
  must(totalM, 'C275：拿不到判据单元总数，无法核守恒')
  const total = Number(totalM[1])
  // C286 把分母统一成「判据单元数」后，total 含 extraUnits 条顶层独立 skip；
  //   它们不走 check()/select、不参与 --fast 计数，守恒式要扣掉这几种单元。
  must(skipped + ran + extraUnits.length === total,
    `C275：跳过 ${skipped} + 已跑 ${ran} + 顶层独立 skip ${extraUnits.length} ≠ 判据单元总数 ${total}（提示行数字不是真实计数）`)
  // ③ 清单必须真被用上：跳过数不能少于过渡清单长度。
  must(skipped >= SLOW_CHECKS.length,
    `C275：只跳过 ${skipped} 条，比过渡清单 ${SLOW_CHECKS.length} 条还少 —— 清单没接进 --fast`)
  return `--fast 跳过 ${skipped} / 已跑 ${ran} / 总 ${total} 守恒；清单 ${SLOW_CHECKS.length} 条全在`
})

check('C277【主判据】不加 --fast 时仍是全量：默认路径无分档提示、一条不跳', () => {
  // ① 真求值：默认路径的提示行必须是 null。
  must(fastNoticeLine(0, 0, false) === null, 'C277：默认路径的提示行不是 null')
  must(fastNoticeLine(3, 4, true) === '[--fast] 本次跳过 3 条含子进程判据，其余 4 条已跑',
    'C277：active 提示行形态不对')
  if (PROBE_CHILD) { lightSkip('C277'); return }
  // ② 真跑双路径：默认无分档提示，且汇总通过数 === --verbose 逐条 PASS 行数（一条没跳）。
  const lean = runVerify([])
  const full = runVerify(['--verbose'])
  must(lean.status === 0 && full.status === 0,
    `C277：双路径真跑有非 0 退出（lean=${lean.status}, full=${full.status}）`)
  const a = lean.stdout || '', b = full.stdout || ''
  must(!a.includes('[--fast]') && !a.includes('[--only]'),
    'C277：默认路径冒出了分档 / 过滤提示 —— 默认不再是全量')
  const m = /(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/.exec(a)
  const passLinesB = (b.match(/^PASS  /gm) || []).length
  must(m && Number(m[1]) === passLinesB,
    `C277：默认汇总通过 ${m && m[1]} ≠ --verbose 逐条 PASS ${passLinesB} —— 有判据被悄悄跳了`)
  // ③ --fast 与默认确实不同：分档没生效时这条红。
  const fast = runVerify(['--fast'])
  must(fast.status === 0, 'C277：--fast 真跑非 0 退出')
  const fm = /(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/.exec(fast.stdout || '')
  must(fm && Number(fm[1]) < Number(m[1]),
    'C277：--fast 与默认跑的条数一样 —— 分档没生效，或默认被跳过了')
  return `默认 ${m[1]} 通过（全量、无分档提示）；--fast ${fm[1]} 通过，确实少跑`
})

check('C284【主判据】--only C124b 能选中、C124 前缀不退化、W-07 也能选', () => {
  if (PROBE_CHILD) { lightSkip('C284'); return }
  const b = runVerify(['--only', 'C124b'])
  must(b.status === 0,
    `C284：--only C124b rc=${b.status}：${String(b.stderr || '').slice(0, 200)}`)
  const ob = b.stdout || ''
  must(/C124b/.test(ob), 'C284：--only C124b 输出里没点名 C124b')
  const nb = /只跑了 (\d+) \/ (\d+) 条/.exec(ob)
  must(nb && Number(nb[1]) >= 1, 'C284：--only C124b 一条都没跑')
  const a = runVerify(['--only', 'C124'])
  must(a.status === 0, `C284：--only C124 rc=${a.status}`)
  const na = /只跑了 (\d+) \/ (\d+) 条/.exec(a.stdout || '')
  must(na && Number(na[1]) >= Number(nb[1]),
    `C284：--only C124 跑了 ${na && na[1]} 条，比 C124b 的 ${nb[1]} 还少（前缀语义退化）`)
  const w = runVerify(['--only', 'W-07'])
  must(w.status === 0,
    `C284：--only W-07 rc=${w.status}：${String(w.stderr || '').slice(0, 200)}`)
  must(/只跑了 1 \//.test(w.stdout || ''), 'C284：--only W-07 没精确选中那一条')
  return `C124b ${nb[1]} 条 / C124 ${na[1]} 条（≥）/ W-07 1 条`
})

check('C286【主判据】--only 提示行分母与默认全量汇总行合计同源', () => {
  if (PROBE_CHILD) { lightSkip('C286'); return }
  const lean = runVerify([])
  must(lean.status === 0, `C286：默认路径真跑 rc=${lean.status}`)
  const m = /(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/.exec(lean.stdout || '')
  must(m, 'C286：默认路径没有汇总行')
  const sum = Number(m[1]) + Number(m[2]) + Number(m[3])
  const none = runVerify(['--only', 'C999999'])
  must(none.status === 1, 'C286：不存在的编号没 exit 1')
  const d = /只跑了 (\d+) \/ (\d+) 条，其余 (\d+) 条未执行/.exec(none.stdout || '')
  must(d, 'C286：--only 路径没有提示行')
  must(Number(d[2]) === sum,
    `C286：提示行分母 ${d[2]} ≠ 默认全量汇总合计 ${sum}（两处数字不同源）`)
  must(Number(d[1]) + Number(d[3]) === Number(d[2]), 'C286：提示行自身不守恒')
  const em = /共 (\d+) 条判据/.exec(none.stderr || '')
  must(em && Number(em[1]) === sum,
    `C286：报错行的「共 N 条」${em && em[1]} 与汇总合计 ${sum} 不同源`)
  // 不写「extraUnits.length > 0」：VERIFY_ONLINE=1 时那两条顶层 skip 会换成
  //   if (online) check(...)，extraUnits 本来就该是 0，写 >0 会让联网场景必然红
  //   （条件性的必然红比永远绿更坏，下一个人会去调阈值或删掉它）。
  //   上面「三处同源」这条真跑恒等式已经能抓住「登记断了」—— 扰动 P2 实证：
  //   去掉 extraUnits.push 后分母 283 ≠ 汇总 285，第一条断言就红，不需要再叠一条。
  return `提示行分母 = 报错行 = 默认汇总合计 = ${sum}（顶层独立 skip ${extraUnits.length} 条已登记）`
})

check('C294【主判据】轻量分支双向：PROBE_CHILD 记 SKIP / 不设时真跑记 PASS', () => {
  const child = runVerifyEnv(['--only', 'C287'], true)
  const father = runVerifyEnv(['--only', 'C287'], false)
  const co = `${child.stdout || ''}${child.stderr || ''}`
  const fo = `${father.stdout || ''}${father.stderr || ''}`
  must(child.status === 0, `C294 设 env 的子进程 rc=${child.status}：${co.slice(-300)}`)
  must(/^SKIP  C287/m.test(co), `C294 设 env 后 C287 没记 SKIP：${co.slice(0, 300)}`)
  must(co.includes(LIGHT_SKIP_DETAIL), 'C294 设 env 后 SKIP 的 detail 没写「本次未真跑」')
  must(!/^PASS  C287/m.test(co), 'C294 设 env 后 C287 仍记了 PASS（假绿没修掉）')
  must(father.status === 0, `C294 不设 env 的子进程 rc=${father.status}：${fo.slice(-300)}`)
  must(/^PASS  C287/m.test(fo), 'C294 不设 env 时 C287 没真跑记 PASS')
  must(/前后快照/.test(fo), 'C294 不设 env 时 C287 的取证 detail 没出来（可能没真跑夹具）')
  must(!/^SKIP  C287/m.test(fo), 'C294 不设 env 时 C287 混进了 SKIP')
  return '设 env → SKIP 且点名未真跑；不设 env → PASS 且带前后快照，双向都成立'
})

check('C295【主判据】元判据解析子进程输出时 SKIP/PASS/FAIL 三向守恒', () => {
  // 11:30 §二 2：不许硬编码 3。N 从主闸源码里真数轻量分支调用点，
  //   以后谁加一条 lightSkip 而汇总没跟着变，这条判据会自动红。
  const mainForN = read(VERIFY_MAIN).split('\n')
  const N = mainForN.filter((l) => /if \(PROBE_CHILD\) \{ lightSkip\(/.test(l)).length
  must(N > 0, `C295：主闸里数不到轻量分支调用点（N=${N}），恒等式锚点被删`)
  // 方向二（任何路径都跑，且不会自举递归）：不设 env 跑三条重夹具判据。
  //   两条路都要守恒；「SKIP 数里不许混进这 N 条」由「不出现轻量 detail + 汇总 SKIP=0」守着。
  const plain = runVerifyEnv(['--only', 'C287,C288,C289'], false)
  const po = `${plain.stdout || ''}${plain.stderr || ''}`
  must(plain.status === 0, `C295 方向二 rc=${plain.status}：${po.slice(-300)}`)
  const pm = /(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/.exec(po)
  must(pm && Number(pm[1]) === 3 && Number(pm[2]) === 0 && Number(pm[3]) === 0,
    `C295 方向二：不设 env 的三条没全真跑（汇总 ${pm && pm.slice(1).join('/')}）`)
  must(!po.includes(LIGHT_SKIP_DETAIL), 'C295 方向二：不设 env 却出现轻量分支 SKIP 明细')
  const pPass = (po.match(/^PASS  /gm) || []).length
  const pSkip = (po.match(/^SKIP  /gm) || []).length
  const pFail = (po.match(/^FAIL  /gm) || []).length
  must(pPass + pSkip + pFail === 3,
    `C295 方向二：逐行三向 PASS/FAIL/SKIP ${pPass}/${pFail}/${pSkip} 合计 ≠ 3（不守恒）`)

  // 方向一（只在父进程做）：runVerify([]) 是元判据的取证子进程，一律带 PROBE_CHILD=1。
  //   在取证子进程里再调它会自举递归 —— 这不是「把 SKIP 排除在证据外」，是取证链的层次。
  if (PROBE_CHILD || process.env.BW_VERIFY_C271_CHILD === '1') {
    return '方向二 3 条全真跑且三向守恒；方向一在父进程取证（本进程是取证子进程，跳过防自举）'
  }
  const probe = runVerify([])
  const o = `${probe.stdout || ''}${probe.stderr || ''}`
  must(probe.status === 0, `C295 方向一 rc=${probe.status}：${o.slice(-300)}`)
  const m = /(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/.exec(o)
  must(m, 'C295 方向一：取证子进程没有汇总行')
  const P = Number(m[1]), F = Number(m[2]), S = Number(m[3])
  const folded = /^\[(\d+) 条 PASS 未列明细，加 --verbose 看\]$/m.exec(o)
  const passLines = (o.match(/^PASS  /gm) || []).length
  const skipLines = (o.match(/^SKIP  /gm) || []).length
  const failLines = (o.match(/^FAIL  /gm) || []).length
  const passTotal = passLines + (folded ? Number(folded[1]) : 0)
  must(passTotal === P, `C295 方向一：逐行 PASS ${passLines} + 折叠 ${folded ? folded[1] : 0} ≠ 汇总 ${P}`)
  must(skipLines === S && failLines === F,
    `C295 方向一：逐行 SKIP/FAIL ${skipLines}/${failLines} ≠ 汇总 ${S}/${F}`)
  // 汇总后的「跳过明细」块会把同一句 detail 再打一遍，裸文本数会得到 18 条。
  //   只认逐条结果行（行首 SKIP/PASS）：既数得准，也保住「不许记成 PASS」这一半。
  const allLight = o.split('\n').filter((l) => l.includes(LIGHT_SKIP_DETAIL))
  const lightLines = allLight.filter((l) => /^SKIP  /.test(l))
  const lightOnPass = allLight.filter((l) => /^PASS  /.test(l))
  must(lightLines.length === N,
    `C295 方向一：轻量分支 SKIP 行 ${lightLines.length} 条 ≠ ${N}（跳过明细块的重复行不算）`)
  must(lightOnPass.length === 0, 'C295 方向一：轻量分支里混进了 PASS 行（又记成通过）')
  // 判据单元总数不许取「本条执行到这一行时」的 allNames.length：check() 是边注册边跑，
  //   本条之后再新增的判据（1905 轮 C296/C297）此刻还没登记，1905 全量实测 296 ≠ 294 就是这个坑。
  //   与 C275/C286 同源：另起一个 --only 不存在编号的子进程，从它的报错分母取全集；
  //   它数的是「注册单元数」，与取证子进程汇总的「执行结果合计 P+F+S」两次独立采集，不自证。
  const none = runVerify(['--only', 'C999999'])
  must(none.status === 1, `C295 方向一：全集分母取证 rc=${none.status}（应为 1）`)
  const no = `${none.stdout || ''}${none.stderr || ''}`
  const totalM = /共 (\d+) 条判据/.exec(no)
  must(totalM, `C295 方向一：拿不到判据单元总数：${no.slice(-300)}`)
  const total = Number(totalM[1])
  must(P + F + S === total, `C295 方向一：汇总合计 ${P + F + S} ≠ 判据单元总数 ${total}`)
  // 把「子进程 PASS 数」与「父进程判据单元数」分开记：差值必须正好是那 N 条 SKIP。
  const baselineSkip = S - lightLines.length
  const diff = total - P - F - baselineSkip
  must(diff === N,
    `C295：父进程判据单元 ${total} − 子进程 PASS ${P} − FAIL ${F} − 基线 SKIP ${baselineSkip} = ${diff} ≠ ${N} 条 SKIP`)
  return `方向一 P/F/S ${P}/${F}/${S} 三向守恒、${N} 条轻量全记 SKIP、差值 ${diff}；方向二 3 条全 PASS 且守恒`
})

// —— 汇总 ——（与 check-run.mjs 的 renderResults 同源；PASS 折叠口径与主闸一致）
if (onlySpec) {
  console.log(onlyNoticeLine(selfNames.length, ranChecks, true))
  const matched = specs.some((s) => selfNames.some((n) => matchOnly(n, [s])))
  if (specs.length === 0 || !matched) {
    console.error(`✗ --only 没匹配到任何判据：${specs.join(', ') || '（--only 后面没给编号或前缀）'}（共 ${selfNames.length} 条判据）`)
    process.exit(1)
  }
}
const { lines, pass, fail, skipN } = renderResults(results, { verbose: RENDER_VERBOSE })
for (const line of lines) console.log(line)
if (skipN > 0) {
  console.log(`\n跳过明细（${skipN} 条，不计入通过数、也不致红）：`)
  for (const r of results) {
    if (!r.skip) continue
    console.log(`  · ${r.name}`)
    console.log(`    ${r.detail || '（没写原因 —— 这条要补）'}`)
  }
}
process.exit(fail ? 1 : 0)
