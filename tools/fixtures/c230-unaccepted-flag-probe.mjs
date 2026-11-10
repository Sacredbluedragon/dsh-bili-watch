// C230 / B3 缩小版取证夹具：stdout 只吐 JSON。
// 全用真 CLI 跑（spawnSync 起真的 look.mjs），不抽函数体、不替被测函数造环境。
// 隔离一棵临时树给 DSH_HOME / BILI_WATCH_CACHE，避免碰生产缓存与凭证。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unacceptedFlags } from '../../lib/params.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c230-'))
const env = { ...process.env, DSH_HOME: join(tmp, 'home'), BILI_WATCH_CACHE: join(tmp, 'cache') }

const WARN = '本命令不接受'
function run(args) {
  const r = spawnSync(process.execPath, [LOOK, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 })
  const out = String(r.stdout || '')
  const err = String(r.stderr || '')
  let jsonOk = null
  try { JSON.parse(out); jsonOk = true } catch { jsonOk = false }
  return {
    rc: r.status,
    out,
    err,
    hasWarn: err.includes(WARN),
    warnLine: err.split(/\r?\n/).find((l) => l.includes(WARN)) || '',
    jsonOk,
  }
}

const result = { runs: {}, pure: {}, stat: {} }
try {
  // A / B 是一对逐字节对照：加了「本命令不接受的参数」之后，stdout 与 rc 都不许变。
  result.runs.A = run(['doctor', '--format', 'json', '--scene'])
  result.runs.B = run(['doctor', '--format', 'json'])
  // C：运行时全局读的 flag 全给上，不该被打成「不接受」（不误伤面板下发路径）。
  result.runs.C = run(['doctor', '--format', 'json', '--quiet', '--p', '2', '--step', '5', '--asr-max', '1000'])
  // D / E：缺目标命令（rc=2）也该打，且全局参数仍不误伤。
  result.runs.D = run(['view', '--scene'])
  result.runs.E = run(['view', '--p', '2'])
  // F：多个不接受参数要合在一行、按名字排序。
  result.runs.F = run(['doctor', '--format', 'json', '--grid', '4x4', '--cues'])
  // G：--help 只打帮助，不叠这一行。
  result.runs.G = run(['doctor', '--help', '--scene'])

  // 纯函数真调用（不是造环境）：期望值写死在夹具里，不拿被测函数读的那张表当答案。
  result.pure = {
    doctorScene: unacceptedFlags('doctor', ['doctor', '--scene']),
    doctorAccepted: unacceptedFlags('doctor', ['doctor', '--format', 'json']),
    sheetAccepted: unacceptedFlags('sheet', ['sheet', '--grid', '4x4', '--dry-run', '--dur', '60']),
    globalOk: unacceptedFlags('doctor', ['doctor', '--quiet', '--p', '2', '--step', '5', '--asr-max', '1000', '--cred', 'x', '--help']),
    unknownCmd: unacceptedFlags('--help', ['--help']),
    unknownFlag: unacceptedFlags('doctor', ['doctor', '--notaflag']),
    multiSorted: unacceptedFlags('doctor', ['doctor', '--grid', '4x4', '--cues']),
    eqForm: unacceptedFlags('doctor', ['doctor', '--grid=4x4']),
  }

  result.stat = {
    aStdoutSame: result.runs.A.out === result.runs.B.out,
    aRcSame: result.runs.A.rc === result.runs.B.rc,
    aStdoutLength: result.runs.A.out.length,
    warnOnlyLine: result.runs.A.err.replace(result.runs.A.warnLine, '').trim() === result.runs.B.err.trim(),
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
