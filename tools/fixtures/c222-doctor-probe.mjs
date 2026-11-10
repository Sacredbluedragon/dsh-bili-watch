#!/usr/bin/env node
/**
 * C222 / doctor 取证夹具。stdout 只吐一个 JSON，判据不采信这里的自述。
 *
 * 五层证据，按「行为在前、静态在后」：
 *   ① 真 CLI 基线：--format json 可解析、六项齐、每项 detail/fix 齐、本机至少五项 ok
 *   ② 真 CLI 人读：每项一行结论 + 一行修复命令 + 合计行
 *   ③ 真 CLI 只读：隔离临时树，跑前后逐项快照；注入假文件验快照自己抓得到新增
 *   ④ 六项逐一造坏（真 CLI 换环境）+ 恢复后回绿；另用真 lib 模块注入 probe 桩验探测链咬合
 *   ⑤ 静态守卫：分派链 / 参数表 / HELP / 不进 CACHE_COMMANDS / lib 无网络与写入 API
 *
 * 不联网不写盘的承诺，靠 ③ 的快照验，不靠读代码找 return —— 「一进来就 return」
 * 同样是零写盘，所以 ③ 还要求 json 里真的有六项结果。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctorReport, DOCTOR_IDS } from '../../lib/doctor.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 起真进程跑 doctor。env 覆盖只加不改，造坏项彼此隔离。 */
function cli(args, envPatch = {}) {
  const r = spawnSync(process.execPath, [LOOK, 'doctor', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ...envPatch },
  })
  let j = null
  try { j = JSON.parse(r.stdout || '') } catch { /* 人读模式本来就不是 JSON */ }
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', j }
}
const okMap = (j) => Object.fromEntries((j?.items || []).map((i) => [i.id, i.ok]))

/** 递归快照：相对路径 + 类型 + 大小 + mtimeMs。目录 mtime 也记，建目录同样算写盘。 */
function snap(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, ent.name)
      const r = rel ? `${rel}/${ent.name}` : ent.name
      let st = null
      try { st = statSync(p) } catch { /* 读不出来也记一笔，别静默略过 */ }
      out.push(`${r}|${ent.isDirectory() ? 'd' : 'f'}|${st ? st.size : '?'}|${st ? st.mtimeMs : '?'}`)
      if (ent.isDirectory()) walk(p, r)
    }
  }
  try { walk(root, '') } catch (e) { out.push(`SNAP-ERROR|${e?.code || e?.message}`) }
  return out
}

const tmp = mkdtempSync(join(tmpdir(), 'c222-doctor-'))
const emptyHome = join(tmp, 'empty-home')
const emptyDeps = join(tmp, 'empty-deps')
const cacheDir = join(tmp, 'cache')
const lockHome = join(tmp, 'lock-home')
for (const d of [emptyHome, emptyDeps, cacheDir, join(lockHome, 'bili-watch')]) mkdirSync(d, { recursive: true })
writeFileSync(join(lockHome, 'bili-watch', '.fetch-deps.lock'), JSON.stringify({ pid: 999999, startedAt: 1, target: 'stale' }), 'utf8')
writeFileSync(join(tmp, '__c222_sentinel'), 'sentinel\n', 'utf8')

const result = { baseline: {}, prose: {}, readonly: {}, libProbe: {}, breaks: {}, stat: {} }

try {
  // ① 真 CLI 基线 ----------------------------------------------------------
  const base = cli(['--format', 'json'])
  const j = base.j
  const fixes = Object.fromEntries((j?.items || []).map((i) => [i.id, i.fix]))
  result.baseline = {
    rc: base.status,
    parseOk: Boolean(j),
    ids: (j?.items || []).map((i) => i.id),
    total: j?.total ?? null,
    available: j?.available ?? null,
    okMap: okMap(j),
    fixes,
    shapeOk: (j?.items || []).every((i) => typeof i.ok === 'boolean' && i.detail.length > 0 && i.fix.length > 0),
    copyableFix: Object.values(fixes).every((f) => /^(node |BILI_WATCH_CACHE=)/.test(f)),
  }

  // ② 人读输出 ------------------------------------------------------------
  const prose = cli([])
  const lines = prose.out.split('\n').filter(Boolean)
  result.prose = {
    rc: prose.status,
    lines: lines.length,
    verdicts: lines.filter((l) => /^[✓✗] (ffmpeg|ffprobe|asr|credential|cache|deps)：/.test(l)).length,
    fixLines: lines.filter((l) => l.startsWith('    修复：')).length,
    summary: lines.find((l) => l.startsWith('合计 ')) || '',
    noJsonBrace: !lines.some((l) => l.trimStart().startsWith('{')),
  }

  // ③ 只读：隔离树跑一次，前后快照；再注入假文件验快照函数本身有牙 ------------
  const before = snap(tmp)
  const isolated = cli(['--format', 'json'], {
    DSH_HOME: emptyHome, BILI_WATCH_DEPS: emptyDeps, BILI_WATCH_CACHE: cacheDir,
  })
  const after = snap(tmp)
  const injection = join(tmp, '__c222_injection.tmp')
  writeFileSync(injection, 'x', 'utf8')
  const withInjection = snap(tmp)
  rmSync(injection, { force: true })
  const afterCleanup = snap(tmp)
  result.readonly = {
    rc: isolated.status,
    items: isolated.j?.items?.length ?? 0,
    snapCount: before.length,
    equal: JSON.stringify(before) === JSON.stringify(after),
    injectionCaught: withInjection.some((x) => x.startsWith('__c222_injection.tmp')),
    cleanupEqual: JSON.stringify(before) === JSON.stringify(afterCleanup),
    noRunLog: !after.some((x) => x.includes('runs.jsonl') || x.includes('.write-test-')),
  }

  // ④ 六项逐一造坏（真 CLI 换环境）+ 恢复 -----------------------------------
  const patches = {
    ffmpeg: { PATH: '', BILI_WATCH_FFMPEG: join(tmp, 'nope-ffmpeg.exe') },
    // 显式指定一份跑不通的 ffprobe：doctor 不回落，单独把这一项打红，其余五项仍绿。
    ffprobe: { BILI_WATCH_FFPROBE: join(tmp, 'nope-ffprobe.exe') },
    asr: { BILI_WATCH_DEPS: emptyDeps, BILI_WATCH_PROJ: emptyDeps },
    credential: { DSH_HOME: emptyHome, BILI_WATCH_DEPS: emptyDeps, BILI_WATCH_PROJ: emptyDeps },
    cache: { BILI_WATCH_CACHE: join(tmp, 'no-such-cache') },
    deps: { DSH_HOME: lockHome },
  }
  const restored = cli(['--format', 'json'])
  for (const [id, patch] of Object.entries(patches)) {
    const bad = cli(['--format', 'json'], patch)
    result.breaks[id] = {
      before: result.baseline.okMap?.[id] ?? null,
      bad: okMap(bad.j)[id] ?? null,
      restored: okMap(restored.j)[id] ?? null,
      badRc: bad.status,
      items: bad.j?.items?.length ?? 0,
    }
  }

  // ④b 真 lib 模块注入 probe 桩：证明「探测」不是硬编码的 ✓ 表 ----------------
  const lib = (probe) => {
    const r = doctorReport({ env: process.env, pluginRoot: ROOT, cfg: {}, probe })
    return Object.fromEntries(r.items.map((i) => [i.id, i.ok]))
  }
  result.libProbe = {
    ids: DOCTOR_IDS,
    normal: lib(() => true),
    noFfprobe: lib((bin) => !String(bin).includes('ffprobe')),
    noPython: lib((bin) => !String(bin).toLowerCase().includes('python')),
    allFalse: lib(() => false),
  }

  // ⑤ 静态守卫（放最后）---------------------------------------------------
  const look = read('tools/look.mjs')
  const params = read('lib/params.mjs')
  const doctorSrc = read('lib/doctor.mjs')
  const helpBody = look.slice(look.indexOf('const HELP = `'), look.indexOf('`', look.indexOf('const HELP = `') + 14))
  const cacheCmdLine = look.split('\n').find((l) => l.includes('const CACHE_COMMANDS'))
  result.stat = {
    dispatch: /\} else if \(cmd === 'doctor'\) \{/.test(look),
    formatRead: /const fmt = opt\('format'\)/.test(look),
    commands: /doctor: \{/.test(params) && /accepts: \['format'\]/.test(params),
    help: helpBody.includes('node look.mjs doctor'),
    notCacheCmd: Boolean(cacheCmdLine) && !cacheCmdLine.includes("'doctor'"),
    noNetwork: !/\b(fetch|axios|jget|httpGet|https?\.request)\s*\(/.test(doctorSrc),
    // 缓存初始化入口在文件头注释里被点名过（「不调 initCachePath()」），
    // 它是解释性文字不是调用；写盘 API 只看真会落盘的那几个，缓存那半另由快照 + notCacheCmd 守。
    noWrite: !/\b(writeFileSync|mkdirSync|appendFileSync|createWriteStream)\s*\(/.test(doctorSrc),
    usageOnlyGuard: look.includes('if (USAGE_ONLY) return'),
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify(result, null, 2))
