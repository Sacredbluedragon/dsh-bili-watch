#!/usr/bin/env node
/**
 * C190–C193 真跑夹具：在隔离副本上把 four 条必修逐个「改坏 / 复原」，读 rc 与原始输出。
 *
 * 纪律：判据的牙只能靠「被测代码改坏后它红不红」来验。这里造的是**真仓库副本**
 * （package.json / README.md / tools/look.mjs / scripts/*.mjs 全拷），真起 node 进程跑
 * scripts/check-public-text.mjs，不读源码猜正则。
 *
 * 输出 JSON 到 stdout；fatal 非空表示夹具自身失效（不是被测代码的问题）。
 * 只写 _临时 下的副本，不动生产树、不动发布树、不跑 release.ps1。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const report = { fatal: null, defect: {}, capability: {}, notes: { runs: {}, samples: {} } }

function say(k, v) { report.notes[k] = v }

/** 造一个最小但**真能跑**的假仓库：package.json.files 展开全链必须可用。 */
function mkBox({ files = ['scripts/_leak.mjs'], withLook = true, leakInPkg = false, notes = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'c19x-'))
  const w = (rel, text) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text, 'utf8')
  }
  w('package.json', JSON.stringify({
    name: 'fixture', version: '0.0.1', description: 'a plain plugin', keywords: ['bili', 'watch'],
    files,
  }, null, 2))
  w('README.md', '# fixture\n\nA plain readme with no internal words.\n')
  // 守卫本体与依赖：整份复制，保证跑的是生产实现而不是复刻。
  for (const rel of ['scripts/check-public-text.mjs', 'scripts/_rules.mjs', 'scripts/_identity.mjs']) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, readFileSync(join(REPO, rel)))
  }
  if (withLook) w('tools/look.mjs', '#!/usr/bin/env node\nconsole.log("fixture help")\n')
  if (files.length) {
    w('scripts/_leak.mjs', leakInPkg ? "// 泄漏样本 D:\\007 Dsh工作区\n" : '// clean\n')
  }
  let notesPath = null
  if (notes !== null) {
    notesPath = join(root, 'notes.md')
    writeFileSync(notesPath, notes, 'utf8')
  }
  return { root, w, notesPath }
}

/** 真起 node 跑 check-public-text.mjs，返回 rc 与合并输出。 */
function runPub(box, extraArgs = []) {
  const argv = [join(box.root, 'scripts/check-public-text.mjs'), '--repo', box.root, ...extraArgs]
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 60000 })
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const run = (box, args = []) => {
  const x = runPub(box, args)
  return x
}

try {
  // ── C190：files 空 → 包内容面 0 份却不许 rc=0 ──────────────────────────────
  {
    const empty = mkBox({ files: [], leakInPkg: true })
    // 造一份真泄漏在盘上，但 files=[] 时守卫扫不到它：正是 DSH 复现的假绿。
    empty.w('scripts/_leak.mjs', "// 泄漏样本 D:\\007 Dsh工作区\n")
    const rEmpty = run(empty)
    report.notes.runs.c190Empty = { rc: rEmpty.rc, out: rEmpty.out.slice(0, 900) }
    report.defect.C190_noFilesRed = rEmpty.rc !== 0
    report.defect.C190_noFilesWordingIncomplete = /未扫全/.test(rEmpty.out) && !/硬闸命中/.test(rEmpty.out)
    report.defect.C190_noFilesNamesReason = /files 没解析出任何条目/.test(rEmpty.out)
    // D2：files 正常 + 干净 → rc=0；files 正常 + 有泄漏 → rc≠0 且措辞「命中」
    const clean = mkBox({ files: ['scripts/_leak.mjs'] })
    const rClean = run(clean)
    const dirty = mkBox({ files: ['scripts/_leak.mjs'], leakInPkg: true })
    const rDirty = run(dirty)
    report.notes.runs.c190Clean = { rc: rClean.rc }
    report.notes.runs.c190Dirty = { rc: rDirty.rc, out: rDirty.out.slice(0, 600) }
    report.capability.C190_normalCleanGreen = rClean.rc === 0
    report.capability.C190_normalLeakRedAsHit = rDirty.rc !== 0 && /硬闸命中/.test(rDirty.out)
    report.capability.C190_noAlwaysRed = rClean.rc === 0
    rmSync(empty.root, { recursive: true, force: true })
    rmSync(clean.root, { recursive: true, force: true })
    rmSync(dirty.root, { recursive: true, force: true })
  }

  // ── C191：look.mjs 缺失 → 不许仍报 --help ✓ 且 rc=0 ────────────────────────
  {
    const missing = mkBox({ withLook: false })
    const rMissing = run(missing)
    report.notes.runs.c191Missing = { rc: rMissing.rc, out: rMissing.out.slice(0, 900) }
    report.defect.C191_lookMissingRed = rMissing.rc !== 0
    report.defect.C191_lookMissingNotClaimScanned = /--help 跳过/.test(rMissing.out) && !/--help ✓/.test(rMissing.out)
    report.defect.C191_lookMissingWordingIncomplete = /未扫全/.test(rMissing.out)
    report.defect.C191_lookMissingNamesReason = /tools\/look\.mjs 不存在/.test(rMissing.out)
    const present = mkBox({ withLook: true })
    const rPresent = run(present)
    report.notes.runs.c191Present = { rc: rPresent.rc }
    report.capability.C191_lookBackGreen = rPresent.rc === 0 && /--help ✓/.test(rPresent.out)
    report.capability.C191_notHardExit2 = rMissing.rc !== 2
    rmSync(missing.root, { recursive: true, force: true })
    rmSync(present.root, { recursive: true, force: true })
  }

  // ── C192：body 面三条样本各自 rc≠0 并点名规则；三面 D2 全绿 ─────────────────
  {
    const SAMPLES = {
      cred: 'SESSDATA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n',
      path: '路径在 E:\\Users\\someone\\work 下\n',
      number: '内部编号 C190 已修\n',
      sysPath: '示例：C:\\Windows\\System32 是系统默认路径，不该被误伤\n',
    }
    const RULE_OF = { cred: '真 SESSDATA 值', path: '通用本机路径', number: '内部编号' }
    const results = {}
    let allRed = true, allNamed = true
    for (const [k, text] of Object.entries(SAMPLES)) {
      if (k === 'sysPath') continue
      const box = mkBox({ notes: text })
      const r = run(box, [box.notesPath])
      results[k] = { rc: r.rc, out: r.out.slice(0, 700) }
      if (r.rc === 0) allRed = false
      if (!r.out.includes(`[${RULE_OF[k]}]`)) allNamed = false
      rmSync(box.root, { recursive: true, force: true })
    }
    report.notes.runs.c192Samples = results
    report.defect.C192_threeSamplesRed = allRed
    report.defect.C192_threeSamplesNamed = allNamed
    // D2：系统路径不误伤 + 真实 README / --help / 干净 notes 三面绿
    const sysBox = mkBox({ notes: SAMPLES.sysPath })
    const rSys = run(sysBox, [sysBox.notesPath])
    const cleanNotes = mkBox({ notes: '本次更新修复了若干问题。\n' })
    const rCleanNotes = run(cleanNotes, [cleanNotes.notesPath])
    const realR = spawnSync(process.execPath, [join(REPO, 'scripts/check-public-text.mjs')], {
      encoding: 'utf8', timeout: 60000, cwd: REPO,
    })
    report.notes.runs.c192SysPath = { rc: rSys.rc }
    report.notes.runs.c192CleanNotes = { rc: rCleanNotes.rc }
    report.notes.runs.c192RealRepo = { rc: realR.status }
    report.capability.C192_systemPathNotHurt = rSys.rc === 0
    report.capability.C192_cleanNotesGreen = rCleanNotes.rc === 0
    report.capability.C192_realRepoStillGreen = realR.status === 0
    report.capability.C192_noAlwaysRed = rCleanNotes.rc === 0
    // 同源：两边 import 同一份 CRED_RULES / SESSDATA_RULE，不是各写一份
    const pubSrc = readFileSync(join(REPO, 'scripts/check-public-text.mjs'), 'utf8')
    const leakSrc = readFileSync(join(REPO, 'scripts/check-release-leak.mjs'), 'utf8')
    const rulesSrc = readFileSync(join(REPO, 'scripts/_rules.mjs'), 'utf8')
    report.capability.C192_sharedRuleTable = /export const SESSDATA_RULE/.test(rulesSrc)
      && /CRED_RULES/.test(pubSrc) && /SESSDATA_RULE/.test(leakSrc)
      && !/\['真 SESSDATA 值',\s*\//.test(pubSrc + leakSrc)   // 两边都不许本地再写一份
    // EXEMPT 按规则名：GNU tar 同一行里塞真 SESSDATA，仍必须被凭据规则抓住
    const exemptBox = mkBox({ notes: 'GNU tar 示例 SESSDATA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n' })
    const rExempt = run(exemptBox, [exemptBox.notesPath])
    report.notes.runs.c192ExemptLine = { rc: rExempt.rc, out: rExempt.out.slice(0, 500) }
    report.capability.C192_exemptByRuleNotWholeLine = rExempt.rc !== 0 && /\[真 SESSDATA 值\]/.test(rExempt.out)
    report.capability.C192_exemptTableHasRuleField = /rule:/.test(rulesSrc) && /function exemptFor/.test(rulesSrc)
    rmSync(sysBox.root, { recursive: true, force: true })
    rmSync(cleanNotes.root, { recursive: true, force: true })
    rmSync(exemptBox.root, { recursive: true, force: true })
  }

  // ── C193：$scanList 含 package.json，且两守卫扫描份数口径对齐 ────────────────
  {
    const ps = readFileSync(join(REPO, 'scripts/sync-release.ps1'), 'utf8')
    const pub = readFileSync(join(REPO, 'scripts/check-public-text.mjs'), 'utf8')
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    report.defect.C193_scanListHasPkg = /\$scanList\s*=\s*@\(\(\$scanList\s*\+\s*"package\.json"\)/.test(ps)
    report.defect.C193_notInExcludeCopy = !/\$excludeCopy\s*=\s*@\([^)]*package\.json/.test(ps)
    // 两守卫份数对齐：check-public-text 的默认三件必须以同样形态出现在 sync 的扫描清单里
    const pubDefaults = ['package.json', 'README.md', 'LICENSE']
    report.capability.C193_bothGuardsSameDefaults =
      pubDefaults.every((d) => pub.includes(`'${d}'`) || pub.includes(`"${d}"`))
      && /"package\.json"/.test(ps)
    // 两个守卫口径对齐（本条真正的判据）：分别**真展开**两侧清单，逐项比对集合。
    // ① pub 侧：按 check-public-text.mjs:119-121 的口径展开（默认三件 ∩ 存在 + files 展开）。
    const pubRels = new Set()
    for (const d of ['package.json', 'README.md', 'LICENSE']) {
      if (existsSync(join(REPO, d))) pubRels.add(d)
    }
    for (const entry of pkg.files || []) {
      const p = join(REPO, entry)
      if (!existsSync(p)) continue
      if (statSync(p).isDirectory()) {
        for (const f of readdirSync(p)) {
          const rel = `${entry.replace(/\/$/, '')}/${f}`
          if (existsSync(join(REPO, rel)) && statSync(join(REPO, rel)).isFile()) pubRels.add(rel)
        }
      } else pubRels.add(entry)
    }
    // ② sync 侧：从 sync-release.ps1 原文切出清单构造段，交给 PS 5.1 原样求值。
    //    不跑整个脚本、不复制、不写发布树；切段来自源文件本身，改源脚本结果就跟着变。
    const psScript = join(REPO, 'tools/fixtures/scanlist-eval.ps1')
    report.capability.C193_evalScriptPresent = existsSync(psScript)
    let syncList = []
    let psErr = ''
    if (existsSync(psScript)) {
      const psBin = ['powershell', 'pwsh'].find((c) => {
        const q = spawnSync(c, ['-NoProfile', '-Command', 'Write-Output pwok'], { encoding: 'utf8', timeout: 20000 })
        return q.status === 0 && /pwok/.test(q.stdout || '')
      })
      if (psBin) {
        const r = spawnSync(psBin, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript], {
          encoding: 'utf8', timeout: 60000,
          env: { ...process.env, C193_SYNC: join(REPO, 'scripts/sync-release.ps1'), C193_SOURCE: REPO },
        })
        const raw = `${r.stdout || ''}`.trim()
        try { syncList = JSON.parse(raw).scanList || [] } catch { psErr = `PS 输出解析失败：${raw.slice(0, 200)} ${r.stderr || ''}` }
      } else psErr = '找不到 PowerShell 可执行文件'
    } else psErr = 'scanlist-eval.ps1 不存在'
    const pubArr = [...pubRels].sort()
    const syncArr = [...new Set(syncList)].sort()
    const onlyPub = pubArr.filter((x) => !syncArr.includes(x))
    const onlySync = syncArr.filter((x) => !pubArr.includes(x))
    report.notes.runs.c193Sets = {
      pubCount: pubArr.length, syncCount: syncArr.length,
      onlyPub, onlySync, psErr: psErr || '(无)',
    }
    report.defect.C193_twoGuardsSameSet = psErr === '' && pubArr.length > 0
      && onlyPub.length === 0 && onlySync.length === 0
    report.capability.C193_pubCountReadable = pubArr.length > 0
    report.capability.C193_syncListTrulyEvaluated = syncArr.length > 0
    const nScan = (ps.match(/AssertNoPaths\s+\$\w+\s+"[^"]*"\s+\$scanList/g) || []).length
    report.defect.C193_bothAssertUseScanList = nScan === 2
    say('c193ScanListAsserts', nScan)
  }
} catch (e) {
  report.fatal = `${e?.message ?? e}\n${e?.stack ?? ''}`.slice(0, 800)
}

console.log(JSON.stringify(report, null, 1))
