#!/usr/bin/env node
/**
 * C189：release.ps1 的手工维护件（auto-trigger.js）两边不一致必须 Fail（2026-11-07 0.4.8 收口）。
 *
 * 一律真跑生产源码，不复刻规则：把 scripts/release.ps1 的第 3 段原样切出来，
 * 配最小桩在 PowerShell 5.1 里执行。三态：
 *   · 两边一致        -> rc=0 且打 [note]
 *   · 改坏发布树那侧  -> rc!=0、[FAIL] 点名 auto-trigger.js 与 dev/rel 两侧 hash
 *   · 恢复成一致      -> rc=0（只测「该红时红」会造出永远红的闸）
 *
 * 冻结令下不执行 release.ps1 本体；这里跑的只是抽出的比对片段加最小桩。
 * stdout 只输出一个 JSON；任何 fatal 都进顶层 fatal，让 verify 红而不是静默绿。
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const REL = join(ROOT, 'scripts', 'release.ps1')

const defect = {}
const capability = {}
const notes = { runs: {} }
let fatal = ''

try {
  const src = readFileSync(REL, 'utf8').replace(/^\uFEFF/, '')
  const a = src.search(/^# ---- 3\./m)
  const b = src.search(/^# ---- 4\./m)
  if (a < 0 || b < 0 || b <= a) throw new Error(`release.ps1 第 3 段锚点找不到（a=${a} b=${b}）`)
  const block = src.slice(a, b)
  notes.blockLines = block.split('\n').length

  // 静态面：不一致分支不许再只打 warn；必须 Fail，且消息点名文件与两侧 hash。
  defect.noWarnOnly = !/Say\s+"\[warn\]/.test(block)
  defect.hasFail = /\bFail\s+"/.test(block)
  defect.namesBothSides = /\$rel/.test(block) && /dev=/.test(block) && /rel=/.test(block)

  const box = mkdtempSync(join(tmpdir(), 'bw-c189-'))
  try {
    const dev = join(box, 'dev')
    const rel = join(box, 'rel')
    mkdirSync(dev, { recursive: true })
    mkdirSync(rel, { recursive: true })
    const good = '// auto-trigger baseline\nmodule.exports = 1\n'
    const devFile = join(dev, 'auto-trigger.js')
    const relFile = join(rel, 'auto-trigger.js')
    writeFileSync(devFile, good, 'utf8')
    writeFileSync(relFile, good, 'utf8')

    const psText = [
      'param([string]$Dev, [string]$RelDir)',
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'function Say($m, [string]$ForegroundColor) { Write-Output ([string]$m) }',
      'function Fail($msg, $code = 2) { Write-Output ("[FAIL] " + [string]$msg); exit $code }',
      'function Md5Of($p) { (Get-FileHash -LiteralPath $p -Algorithm MD5).Hash.ToLower() }',
      '$excludeCopy = @("auto-trigger.js")',
      '$Source = $Dev',
      '$Release = $RelDir',
      block,
      'Write-Output "[DONE]"',
    ].join('\n')
    const ps1 = join(box, 'drift-probe.ps1')
    writeFileSync(ps1, '\uFEFF' + psText, 'utf8')

    const run = (tag) => {
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-Dev', dev, '-RelDir', rel,
      ], { encoding: 'utf8', timeout: 120000 })
      const text = `${r.stdout || ''}${r.stderr || ''}`
      notes.runs[tag] = {
        rc: r.status,
        out: text.slice(0, 700),
        stderr: (r.stderr || '').slice(0, 300),
        spawnErr: r.error ? r.error.message : null,
      }
      return { rc: r.status, text }
    }

    const r1 = run('consistent')
    capability.consistentGreen = r1.rc === 0 && /\[note\]/.test(r1.text)

    writeFileSync(relFile, '// drifted on release side\nmodule.exports = 2\n', 'utf8')
    const r2 = run('drift')
    capability.driftRed = r2.rc !== 0 && /\[FAIL\]/.test(r2.text)
      && /auto-trigger\.js/.test(r2.text)
      && /dev=[0-9a-f]{8}/.test(r2.text) && /rel=[0-9a-f]{8}/.test(r2.text)
      && !/Exception|CommandNotFoundException|ParserError/.test(r2.text)

    writeFileSync(relFile, good, 'utf8')
    const r3 = run('restored')
    capability.restoredGreen = r3.rc === 0 && /\[note\]/.test(r3.text)
  } finally {
    try { rmSync(box, { recursive: true, force: true }) } catch {}
  }
} catch (e) {
  fatal = String(e && e.message || e)
}

process.stdout.write(JSON.stringify({ defect, capability, notes, fatal: fatal || undefined }))
