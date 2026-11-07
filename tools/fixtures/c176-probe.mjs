/**
 * C176 夹具：模型残片判据（C3a / C3b / C3c）。
 *
 * 真造目录树，不是源码正则。本机实测的真实落盘形态是：
 *   .hf-home/hub/models--Systran--faster-whisper-small/
 *     blobs/                 （空目录，Windows 上 hf_hub 建不了符号链接）
 *     snapshots/<hash>/{ model.bin, config.json, tokenizer.json, ... }（真文件）
 * 所以「blobs 空」是正常的，「snapshots 里有半个 model.bin」才是残片。
 *
 * defect     = 当前实现必须成立的事实（改坏了要红）
 * capability = 修的时候最容易顺手弄坏的反向能力
 *
 * 注意：完整场景的 model.bin 用本机实测真值 483,546,902 B 造，是「被判定的对象」，
 * 不是体积下限；下限只从 lib/model-integrity.mjs 单点导入，夹具不抄第二份。
 */
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const REAL_MODEL_BYTES = 483_546_902
const PARTIAL_BYTES = 1024

const defect = {}
const capability = {}
const notes = {}
const sandbox = mkdtempSync(join(tmpdir(), 'bw-c176-'))

const bigFile = (p, size) => {
  const fd = openSync(p, 'w')
  try { ftruncateSync(fd, size) } finally { closeSync(fd) }
}
const mkHome = (name, { bytes = null, hubAsFile = false, missingFiles = [] } = {}) => {
  // 与 fetch-deps 的 `join(DEPS, '.hf-home')` 对齐：整棵树挂在 .hf-home 下。
  const home = join(sandbox, name, '.hf-home')
  mkdirSync(join(home, 'hub'), { recursive: true })
  if (hubAsFile) {
    rmSync(join(home, 'hub'), { recursive: true, force: true })
    writeFileSync(join(home, 'hub'), 'not a dir', 'utf8')
    return home
  }
  if (bytes === null) {
    mkdirSync(join(home, 'hub', '.locks'), { recursive: true })
    return home
  }
  const modelDir = join(home, 'hub', 'models--Systran--faster-whisper-small')
  const snap = join(modelDir, 'snapshots', '536b0662742c02347bc0e980a01041f333bce120')
  mkdirSync(join(modelDir, 'blobs'), { recursive: true })
  mkdirSync(join(modelDir, 'refs'), { recursive: true })
  mkdirSync(snap, { recursive: true })
  writeFileSync(join(modelDir, 'refs', 'main'), '536b0662742c02347bc0e980a01041f333bce120', 'utf8')
  bigFile(join(snap, 'model.bin'), bytes)
  if (!missingFiles.includes('config.json')) writeFileSync(join(snap, 'config.json'), '{}', 'utf8')
  if (!missingFiles.includes('tokenizer.json')) writeFileSync(join(snap, 'tokenizer.json'), '{}', 'utf8')
  return home
}
// 按大括号计数切出原样函数体（含签名行），不做正则近似。
const sliceFn = (src, header) => {
  const a = src.indexOf(header)
  if (a < 0) throw new Error('找不到函数头：' + header)
  const open = src.indexOf('{', a)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1)
  }
  throw new Error('函数体大括号不闭合：' + header)
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'model-integrity.mjs')).href)
  const { modelRow, inspectModelHomes, MODEL_MIN_BYTES, MODEL_EXPECTED_MB, MODEL_FORCE_CMD } = mod
  notes.minBytes = MODEL_MIN_BYTES

  // ── 三种目录树（外加：读不出来 / 两个落点 / 目录不存在）────────────────────
  const complete = mkHome('complete', { bytes: REAL_MODEL_BYTES })
  const partial = mkHome('partial', { bytes: PARTIAL_BYTES })
  const empty = mkHome('empty')
  const unreadable = mkHome('unreadable', { hubAsFile: true })
  const missing = join(sandbox, 'does-not-exist')

  const rows = {
    complete: modelRow([complete]),
    partial: modelRow([partial]),
    empty: modelRow([empty]),
    unreadable: modelRow([unreadable]),
    missing: modelRow([missing]),
    twoHomes: modelRow([empty, complete]),
  }
  notes.rows = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { ok: v.ok, detail: v.detail, state: v.state }]))
  notes.blobsEmpty = modelRow([complete]).ok === true && statSync(join(complete, 'hub', 'models--Systran--faster-whisper-small', 'blobs')).isDirectory()

  defect.C176_completeOk = rows.complete.ok === true && rows.complete.state === 'complete'
    && rows.complete.detail.includes('complete')
  defect.C176_partialNotOk = rows.partial.ok === false && rows.partial.state === 'partial'
    && /模型不完整/.test(rows.partial.detail)
    && /\d+\.\d+ MB/.test(rows.partial.detail)
    && rows.partial.detail.includes(String(MODEL_EXPECTED_MB))
    && rows.partial.detail.includes(MODEL_FORCE_CMD)
  defect.C176_emptyNotOk = rows.empty.ok === false && rows.empty.state === 'empty'
    && /没有可用的快照/.test(rows.empty.detail) && rows.empty.detail.includes(MODEL_FORCE_CMD)
  defect.C176_unreadableSaysWhy = rows.unreadable.ok === false && rows.unreadable.state === 'unreadable'
    && /读不出来/.test(rows.unreadable.detail) && /[A-Z]{3,}/.test(rows.unreadable.detail)
  defect.C176_twoHomesScanned = rows.twoHomes.ok === true && rows.twoHomes.state === 'complete'
  capability.C176_missingStillNotOk = rows.missing.ok === false
    && /没找到模型目录/.test(rows.missing.detail)
  capability.C176_blobsEmptyIsFine = notes.blobsEmpty === true

  // ── C3c：原样 ensureModel 函数体 + 最小桩，真跑 --force 与干跑 ──────────────
  const fdSrc = readFileSync(join(ROOT, 'scripts', 'fetch-deps.mjs'), 'utf8')
  const ensureBody = sliceFn(fdSrc, 'function ensureModel() {')
  const runEnsure = ({ force, dry, home }) => {
    const rmCalls = []
    const logs = []
    const fakePy = join(sandbox, 'fake-python')
    writeFileSync(fakePy, '', 'utf8')
    const ctx = {
      DEPS: dirname(home), FORCE: force, DRY: dry,
      IS_WIN: process.platform === 'win32',
      HF_ENDPOINT: 'https://example.invalid', PROXY: '',
      venvPy: () => fakePy,
      join, existsSync,
      rmSync: (p, opts) => { rmCalls.push(String(p)); return rmSync(p, opts) },
      step: (s) => logs.push('STEP ' + String(s)),
      log: (s) => logs.push(String(s)), skip: () => {},
      run: () => { logs.push('RUN'); return { code: 0, out: '', err: '' } },
      console: { log: (s) => logs.push(String(s)) },
      inspectModelHomes,
      process: { env: {} },
    }
    vm.runInNewContext(ensureBody + '\nensureModel()', ctx, { timeout: 10000 })
    return { rmCalls, logs }
  }

  const forceHome = mkHome('force-partial', { bytes: PARTIAL_BYTES })
  const forceSnap = join(forceHome, 'hub', 'models--Systran--faster-whisper-small', 'snapshots', '536b0662742c02347bc0e980a01041f333bce120')
  const f1 = runEnsure({ force: true, dry: false, home: forceHome })
  notes.force = { rmCalls: f1.rmCalls, logs: f1.logs, snapExistsAfter: existsSync(forceSnap) }
  defect.C176_forceRemovesPartial = f1.rmCalls.some((p) => p.includes('536b0662'))
    && f1.rmCalls.some((p) => p.includes('snapshots'))
    && existsSync(forceSnap) === false
  const iClean = f1.logs.findIndex((l) => l.includes('清掉半截快照'))
  const iRun = f1.logs.indexOf('RUN')
  defect.C176_forceCleanBeforeDownload = iClean >= 0 && iRun > iClean

  const dryHome = mkHome('force-dry', { bytes: PARTIAL_BYTES })
  const drySnap = join(dryHome, 'hub', 'models--Systran--faster-whisper-small', 'snapshots', '536b0662742c02347bc0e980a01041f333bce120')
  const f2 = runEnsure({ force: true, dry: true, home: dryHome })
  notes.forceDry = { rmCalls: f2.rmCalls, logs: f2.logs, snapExistsAfter: existsSync(drySnap) }
  defect.C176_dryRunNoDelete = f2.rmCalls.length === 0 && existsSync(drySnap) === true
    && f2.logs.some((l) => l.includes('[dry-run]') && l.includes('半截快照'))

  const keepHome = mkHome('force-complete', { bytes: REAL_MODEL_BYTES })
  const keepSnap = join(keepHome, 'hub', 'models--Systran--faster-whisper-small', 'snapshots', '536b0662742c02347bc0e980a01041f333bce120')
  const f3 = runEnsure({ force: true, dry: false, home: keepHome })
  capability.C176_forceKeepsComplete = f3.rmCalls.length === 0 && existsSync(keepSnap) === true

  // 只有体积不足才删：缺关键文件的半截由下载器自己补齐，不该被整目录删掉。
  const lackHome = mkHome('force-lack-file', { bytes: REAL_MODEL_BYTES, missingFiles: ['config.json'] })
  const lackSnap = join(lackHome, 'hub', 'models--Systran--faster-whisper-small', 'snapshots', '536b0662742c02347bc0e980a01041f333bce120')
  const f4 = runEnsure({ force: true, dry: false, home: lackHome })
  capability.C176_forceKeepsMissingFile = f4.rmCalls.length === 0 && existsSync(lackSnap) === true
  notes.forceLackFile = { rmCalls: f4.rmCalls, state: inspectModelHomes([lackHome]).state }

  // ── 单点常量 + /status 接线（词法断言，防「夹具真跑但面板没接上」）──────────
  const libSrc = readFileSync(join(ROOT, 'lib', 'model-integrity.mjs'), 'utf8')
  const otherFiles = ['index.js', 'scripts/fetch-deps.mjs', 'tools/verify.mjs', 'tools/fixtures/c176-probe.mjs']
  const leaked = otherFiles.filter((f) => /400_?000_?000/.test(readFileSync(join(ROOT, f), 'utf8')))
  notes.constantLeakedTo = leaked
  defect.C176_singleSourceConstant = leaked.length === 0
    && (libSrc.match(/export const MODEL_MIN_BYTES\s*=/g) || []).length === 1

  const idx = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const a = idx.indexOf("id: 'model'")
  const b = idx.indexOf('estimate: ESTIMATES.model', a)
  const modelLine = a > 0 && b > a ? idx.slice(a, b) : ''
  notes.modelLine = modelLine
  defect.C176_indexWired = /const modelStatus = modelRow\(hfHomes\(\), \{ mask: maskAbs, dirStat \}\)/.test(idx)
    && /ok:\s*modelStatus\.ok/.test(modelLine)
    && /detail:\s*modelStatus\.detail/.test(modelLine)
    && /path:\s*modelStatus\.path/.test(modelLine)
    && /size:\s*modelStatus\.size/.test(modelLine)
  capability.C176_noOkWithWarning = !/ok:\s*true/.test(modelLine) && !/warning/i.test(modelLine)
} catch (e) {
  notes.fatal = String(e && e.stack ? e.stack : e).slice(0, 900)
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch {}
}

process.stdout.write(JSON.stringify({ defect, capability, notes }))
