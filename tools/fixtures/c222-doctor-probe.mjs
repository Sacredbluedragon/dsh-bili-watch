#!/usr/bin/env node
/**
 * C222 / doctor 取证夹具。stdout 只吐一个 JSON，判据不采信这里的自述。
 *
 * 五层证据，按「行为在前、静态在后」：
 *   ① 真 CLI 本机基线：--format json 可解析、七项齐、每项 detail/fix 齐；
 *      available/ok/rc 取真实输出，判据验它们彼此自洽（不要求本机必须全绿）。
 *   ② 真 CLI 人读：每项一行结论 + 一行修复命令 + 合计行；合计里的分子分母与退出码自洽。
 *   ③ 真 CLI 只读：隔离临时树，跑前后逐项快照；注入假文件验快照自己抓得到新增。
 *   ④ 受控现场（7/7 与 6/7）：合成凭证 + 隔离两处真实凭证路径 + 真实其余六项，
 *      各经真 CLI 验证 7/7→rc0、6/7→rc1；六项造坏都从受控 7/7 出发，口径一致。
 *   ⑤ 静态守卫：分派链 / 参数表 / HELP / 不进 CACHE_COMMANDS / lib 无网络与写入 API。
 *
 * 不联网不写盘的承诺，靠 ③ 的快照验，不靠读代码找 return —— 「一进来就 return」
 * 同样是零写盘，所以 ③ 还要求 json 里真的有七项结果。
 *
 * 1432：拆掉「测试把运行机器的凭证年龄写成产品契约」。本机共享凭证与 legacy
 *   一律不读、不改、不 touch；受控现场用合成字段，只验结构与退出码契约。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, openSync, ftruncateSync, closeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctorReport, DOCTOR_IDS } from '../../lib/doctor.mjs'
import { MODEL_MIN_BYTES } from '../../lib/model-integrity.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// 1645：受控组不再依赖 REAL_DEPS 是否存在——空 DSH_HOME 时也必须能造出 7/7。
// 替身 / 模型快照 / 合成凭证 / 合成件全部自建在临时树里，PATH 只指向自建替身目录。

/** 本机真实环境起真进程跑 doctor（① ② ③ 用）。env 覆盖只加不改。 */
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

// ── 受控现场基础设施（1645：全部自建，不依赖 REAL_DEPS / 本机 PATH 工具）──
// 两处真实凭证路径一律不读。替身、模型快照、合成件全在 tmp 下；字段值明显是假的。
const ctrlHome = join(tmp, 'ctrl-home')
const ctrlDeps = join(tmp, 'ctrl-deps')
const ctrlCache = join(tmp, 'ctrl-cache')
const stubDir = join(tmp, 'stubs')            // 替身 exe 独立目录，只它进 PATH
mkdirSync(join(ctrlHome, 'bili-watch'), { recursive: true })
mkdirSync(ctrlDeps, { recursive: true })
mkdirSync(ctrlCache, { recursive: true })
mkdirSync(stubDir, { recursive: true })

// 替身：attrib.exe 的 -version 与 --version 都 rc=0，且体积极小（不借本机 ffmpeg/python）。
//   ffmpeg/ffprobe 靠显式 BILI_WATCH_FFMPEG/FFPROBE 指向 stubDir 里的副本；
//   python 替身落在 ctrlDeps/.venv-asr/Scripts/python.exe（doctor 的 firstExisting 第一候选）。
const STUB_SRC = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe')
const linkReport = []
if (!existsSync(STUB_SRC)) throw new Error(`替身源文件不存在：${STUB_SRC}`)
copyFileSync(STUB_SRC, join(stubDir, 'ffmpeg.exe'))
copyFileSync(STUB_SRC, join(stubDir, 'ffprobe.exe'))
mkdirSync(join(ctrlDeps, '.venv-asr', 'Scripts'), { recursive: true })
copyFileSync(STUB_SRC, join(ctrlDeps, '.venv-asr', 'Scripts', 'python.exe'))
writeFileSync(join(ctrlDeps, '_bili-asr.py'), '', 'utf8')
writeFileSync(join(ctrlDeps, 'download.out.log'), 'probe\n', 'utf8')
linkReport.push('ffmpeg:stub', 'ffprobe:stub', 'python:stub', '_bili-asr.py:created', 'download.out.log:created')

// 模型快照：三件齐 + model.bin 稀疏到 MODEL_MIN_BYTES（真值从 lib 导入，不抄字面量）。
const modelSnap = join(ctrlDeps, '.hf-home', 'hub', 'models--Systran--faster-whisper-small', 'snapshots', 'rev')
mkdirSync(modelSnap, { recursive: true })
writeFileSync(join(modelSnap, 'config.json'), '{}', 'utf8')
writeFileSync(join(modelSnap, 'tokenizer.json'), '{}', 'utf8')
const mfd = openSync(join(modelSnap, 'model.bin'), 'w')
ftruncateSync(mfd, MODEL_MIN_BYTES)
closeSync(mfd)
linkReport.push(`model.bin:sparse@${MODEL_MIN_BYTES}`)

const SYNTH_FIELDS = { sessdata: 'SYNTH_SESSDATA_NOT_A_REAL_COOKIE', bili_jct: 'SYNTH_BILI_JCT', buvid3: 'SYNTH_BUVID3', buvid4: 'SYNTH_BUVID4' }
/** credState: 'valid'=updatedAt 当下；'stale'=推到 40 天前（>30 天口径）。只写合成字段。 */
function writeSynthCred(credState) {
  const c = {
    ...SYNTH_FIELDS,
    updatedAt: credState === 'stale' ? new Date(Date.now() - 40 * 86400000).toISOString() : new Date().toISOString(),
  }
  writeFileSync(join(ctrlHome, 'bili-watch', 'credential.json'), JSON.stringify(c, null, 2), 'utf8')
}

/** 受控 env：完整给全，不用 ...process.env 打底。PATH 只放自建替身目录，不借本机任何工具。 */
function controlledEnv() {
  return {
    PATH: stubDir,
    SystemRoot: process.env.SystemRoot || '',
    ComSpec: process.env.ComSpec || '',
    LOCALAPPDATA: process.env.LOCALAPPDATA || '',
    TEMP: tmp, TMP: tmp,
    DSH_HOME: ctrlHome,
    BILI_WATCH_DEPS: ctrlDeps,
    BILI_WATCH_CACHE: ctrlCache,
    BILI_WATCH_FFMPEG: join(stubDir, 'ffmpeg.exe'),
    BILI_WATCH_FFPROBE: join(stubDir, 'ffprobe.exe'),
  }
}
/** 受控真 CLI 调用：走真入口 spawnSync，不调 lib。 */
function cliControlled(args, credState, envPatch = {}) {
  writeSynthCred(credState)
  const r = spawnSync(process.execPath, [LOOK, 'doctor', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...controlledEnv(), ...envPatch },
  })
  let j = null
  try { j = JSON.parse(r.stdout || '') } catch { /* 人读模式本来就不是 JSON */ }
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', j }
}

const result = { baseline: {}, prose: {}, readonly: {}, controlled: {}, breaks: {}, libProbe: {}, stat: {} }

try {
  // ① 真 CLI 本机基线 ------------------------------------------------------
  const base = cli(['--format', 'json'])
  const j = base.j
  const fixes = Object.fromEntries((j?.items || []).map((i) => [i.id, i.fix]))
  result.baseline = {
    rc: base.status,
    parseOk: Boolean(j),
    ids: (j?.items || []).map((i) => i.id),
    total: j?.total ?? null,
    available: j?.available ?? null,
    ok: j?.ok ?? null,
    okMap: okMap(j),
    fixes,
    shapeOk: (j?.items || []).every((i) => typeof i.ok === 'boolean' && i.detail.length > 0 && i.fix.length > 0),
    copyableFix: Object.values(fixes).every((f) => /^(node |BILI_WATCH_CACHE=)/.test(f)),
  }

  // ② 人读输出：合计行抠出 available/total，与 rc 自洽 ---------------------------
  const prose = cli([])
  const lines = prose.out.split('\n').filter(Boolean)
  const summary = lines.find((l) => l.startsWith('合计 ')) || ''
  const sm = summary.match(/^合计 (\d+)\/(\d+) 项环境检查通过/)
  result.prose = {
    rc: prose.status,
    lines: lines.length,
    available: sm ? Number(sm[1]) : null,
    total: sm ? Number(sm[2]) : null,
    verdicts: lines.filter((l) => /^[✓✗] (ffmpeg|ffprobe|asr|credential|cache|deps|model)：/.test(l)).length,
    fixLines: lines.filter((l) => l.startsWith('    修复：')).length,
    summary,
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

  // ④ 受控现场：7/7 与 6/7，各走真入口 ---------------------------------------
  const valid = cliControlled(['--format', 'json'], 'valid')
  const stale = cliControlled(['--format', 'json'], 'stale')
  const summarize = (r) => ({
    rc: r.status,
    available: r.j?.available ?? null,
    total: r.j?.total ?? null,
    ok: r.j?.ok ?? null,
    okMap: okMap(r.j),
    items: r.j?.items?.length ?? 0,
  })
  result.controlled = {
    valid: summarize(valid),
    stale: summarize(stale),
    linkReport,
    // 合成凭证隔离证据：受控现场两处凭证路径都在 tmp 下，不指向真实共享/legacy
    credPathsIsolated: controlledEnv().DSH_HOME === ctrlHome && controlledEnv().BILI_WATCH_DEPS === ctrlDeps,
  }

  // ④-a 六项造坏：全部从受控 7/7 出发（口径一致，不一半读本机一半读受控）---------
  const built = cliControlled(['--format', 'json'], 'valid')
  const builtMap = okMap(built.j)
  const patches = {
    ffmpeg: { PATH: '', BILI_WATCH_FFMPEG: join(tmp, 'nope-ffmpeg.exe') },
    ffprobe: { BILI_WATCH_FFPROBE: join(tmp, 'nope-ffprobe.exe') },
    asr: { BILI_WATCH_DEPS: emptyDeps, BILI_WATCH_PROJ: emptyDeps },
    // credential 要把 shared 也挪走：仅挪 legacy 时受控 shared 仍有效，造不坏。
    credential: { DSH_HOME: emptyHome, BILI_WATCH_DEPS: emptyDeps, BILI_WATCH_PROJ: emptyDeps },
    cache: { BILI_WATCH_CACHE: join(tmp, 'no-such-cache') },
    // deps 要清掉 BILI_WATCH_DEPS（否则锁落受控 deps 父级，坏锁不生效）。
    deps: { DSH_HOME: lockHome, BILI_WATCH_DEPS: '' },
  }
  const restored = cliControlled(['--format', 'json'], 'valid')
  for (const id of Object.keys(patches)) {
    const bad = cliControlled(['--format', 'json'], 'valid', patches[id])
    result.breaks[id] = {
      before: builtMap[id] ?? null,
      bad: okMap(bad.j)[id] ?? null,
      restored: okMap(restored.j)[id] ?? null,
      badRc: bad.status,
      items: bad.j?.items?.length ?? 0,
    }
  }

  // ④b 真 lib 模块注入 probe 桩：探测链不是硬编码的 ✓ 表；用受控 env 隔离凭证 ----
  // lib/cred.mjs 的 credPaths() 读的是 process.env.DSH_HOME（不是传给 doctorReport 的 env），
  // 同进程调用时必须在调用期间临时把 process.env.DSH_HOME 指向受控 home，用完恢复。
  // 受控 home 里放一份 updatedAt 当下的合成凭证，让「探测全废时 credential 该照常绿」成立。
  writeSynthCred('valid')
  const libEnv = controlledEnv()
  const realHome = process.env.DSH_HOME
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME')
  const lib = (probe) => {
    process.env.DSH_HOME = ctrlHome
    try {
      const r = doctorReport({ env: libEnv, pluginRoot: ROOT, cfg: {}, probe })
      return Object.fromEntries(r.items.map((i) => [i.id, i.ok]))
    } finally {
      if (hadHome) process.env.DSH_HOME = realHome
      else delete process.env.DSH_HOME
    }
  }
  // 1645：normal 组（lib(() => true)）此前无消费者（verify.mjs grep `lp.normal` 0 命中），
  //   按派单删掉；保留 noFfprobe/noPython/allFalse 三个有断言的探测组。
  result.libProbe = {
    ids: DOCTOR_IDS,
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
    noWrite: !/\b(writeFileSync|mkdirSync|appendFileSync|createWriteStream)\s*\(/.test(doctorSrc),
    usageOnlyGuard: look.includes('if (USAGE_ONLY) return'),
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify(result, null, 2))
