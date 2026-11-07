#!/usr/bin/env node
/**
 * C188：半成品 venv 改名不许生成以点结尾的目录名（2026-11-07 0.4.8 收口）。
 *
 * 一律真跑生产源码，不复刻判据：
 *   · 从 scripts/fetch-deps.mjs 原样抠出 `const dst = `...`` 那一行；
 *   · 在 VM 里用固定时钟求值，拿到这次真正会生成的目录名；
 *   · 在临时 ASCII 目录里真做一次「建目录 → rename 成该名 → 删掉」。
 *     Win32 上尾点目录删不掉，这一步会把 slice(0, 15) 的回归直接暴露出来。
 *
 * stdout 只输出一个 JSON；任何 fatal 都进顶层 fatal，让 verify 红而不是静默绿。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SRC = readFileSync(join(ROOT, 'scripts', 'fetch-deps.mjs'), 'utf8')

const defect = {}
const capability = {}
const notes = {}
let fatal = ''

try {
  const m = /const dst = `([^`]+)`/.exec(SRC)
  if (!m) throw new Error('fetch-deps.mjs 里找不到 const dst = `...` 那一行')
  const expr = m[1]
  notes.expr = expr
  const sm = /slice\(0,\s*(\d+)\)/.exec(expr)
  notes.sliceArg = sm ? Number(sm[1]) : null

  // 固定时钟：夹具结果不能随墙钟漂，否则扰动验证没法复现。
  class FixedDate extends Date {
    constructor() { super('2026-11-06T17:23:16.701Z') }
  }
  const dst = vm.runInNewContext('`' + expr + '`', { Date: FixedDate, leaf: '.venv-asr' }, { timeout: 2000 })
  notes.dst = dst

  // 结果面：名字形状。尾点的旧形态 `.venv-asr.old-20261106172316.` 在这里必须 false。
  defect.notTailDot = typeof dst === 'string' && !dst.endsWith('.')
  defect.shape14 = typeof dst === 'string' && /^\.venv-asr\.old-\d{14}$/.test(dst)

  // 能力面：不许靠「把时间戳整段删掉 / 写死一个名字」来骗绿。
  capability.keepsOldPrefix = typeof dst === 'string' && dst.startsWith('.venv-asr.old-')
  capability.keepsTimestamp = typeof dst === 'string' && /\d{14}$/.test(dst)

  // 真造一次改名路径，并真删。任何一步抛错都记成断言 false，不让夹具自己崩掉。
  const box = mkdtempSync(join(tmpdir(), 'bw-c188-'))
  try {
    const src = join(box, '.venv-asr')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'pyvenv.cfg'), 'home = C:\\Python\n', 'utf8')
    const target = join(box, dst)
    let renamed = false
    try { renameSync(src, target); renamed = true } catch (e) { notes.renameErr = String(e && e.message || e) }
    notes.renamed = renamed
    let removed = false
    if (renamed) {
      try { rmSync(target, { recursive: true, force: true }); removed = true } catch (e) { notes.rmErr = String(e && e.message || e) }
    }
    notes.removed = removed
    capability.nameDeletable = removed && renamed && !existsSync(target)
  } finally {
    try { rmSync(box, { recursive: true, force: true }) } catch {}
  }
} catch (e) {
  fatal = String(e && e.message || e)
}

process.stdout.write(JSON.stringify({ defect, capability, notes, fatal: fatal || undefined }))
