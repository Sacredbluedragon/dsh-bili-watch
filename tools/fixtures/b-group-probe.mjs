#!/usr/bin/env node
/**
 * B 组守卫假绿：真跑夹具（dev-only，不进 package.json.files）。
 *
 * 一律真跑生产脚本本身，不复刻规则：
 *   · B1：把 scripts/release.ps1 的 4b-2 段落原样切出来，配桩在 PS 5.1 里真执行，
 *         看它到底把什么 argv 交给 check-public-text.mjs、有没有真算 sha256；
 *         再用真 node 进程验「位置参数确实被当成 release body 扫了」。
 *   · B2/B3/B4/B5：造最小隔离仓库（README / package.json / tools/look.mjs / 干净 index.js），
 *         真跑 scripts/check-public-text.mjs --repo <沙箱>，读 rc 与命中 label。
 *
 * stdout 只输出一个 JSON；任何 fatal 都进 notes.fatal，让 verify 红而不是静默绿。
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const PUB = join(ROOT, 'scripts', 'check-public-text.mjs')
const REL = join(ROOT, 'scripts', 'release.ps1')
const SRC = readFileSync(PUB, 'utf8')

const defect = {}
const capability = {}
const notes = { probes: {}, b5: {}, ps: {} }
let fatal = ''

const out = (o) => JSON.stringify(o, null, 1)

/** 造一个最小但形态真实的仓库：files 只有干净的 index.js，look.mjs 不在包内面里 */
function mkBox({ description = '把视频读成文本给 AI 用', keywords = ['video', 'asr'], help = null, brokenHelp = false } = {}) {
  const box = mkdtempSync(join(tmpdir(), 'bw-bgroup-'))
  mkdirSync(join(box, 'tools'), { recursive: true })
  writeFileSync(join(box, 'README.md'), '# 最小测试包\n\n一个只用来跑文案闸的仓库。\n', 'utf8')
  writeFileSync(join(box, 'index.js'), 'module.exports = 1\n', 'utf8')
  writeFileSync(join(box, 'package.json'), JSON.stringify({
    name: 'bw-bgroup-box', version: '0.0.0', description, keywords, files: ['index.js'],
  }, null, 1), 'utf8')
  if (brokenHelp) {
    writeFileSync(join(box, 'tools', 'look.mjs'), 'console.log(\n', 'utf8')
  } else {
    const body = help === null ? '用法:\n  look <命令> [参数]\n' : help
    writeFileSync(join(box, 'tools', 'look.mjs'), `console.log(${JSON.stringify(body)})\n`, 'utf8')
  }
  return box
}

function runPub(box, bodies = []) {
  const args = [PUB, '--repo', box, ...bodies]
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 })
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

function probe(box, name, text) {
  const p = join(box, `${name}.md`)
  writeFileSync(p, text, 'utf8')
  return p
}

try {
  // ── B1：release.ps1 的 4b-2 原样段落 + 桩，在 PS 5.1 里真跑 ──────────────────
  const relSrc = readFileSync(REL, 'utf8')
  const a = relSrc.indexOf('  # 4b-2. 对外文案')
  const b = relSrc.indexOf('  # 4c. 包内自洽', a)
  if (a < 0 || b < 0) throw new Error(`release.ps1 的 4b-2 段落锚点找不到（a=${a} b=${b}）`)
  const block = relSrc.slice(a, b)
  notes.ps.blockLines = block.split('\n').length

  const psBox = mkdtempSync(join(tmpdir(), 'bw-b1ps-'))
  const psScripts = join(psBox, 'scripts')
  mkdirSync(psScripts, { recursive: true })
  copyFileSync(PUB, join(psScripts, 'check-public-text.mjs'))
  const notesFile = join(psBox, 'notes.md')
  writeFileSync(notesFile, '# 0.4.7\n\n- 修好了依赖锁竞争\n', 'utf8')

  const psText = [
    'param([string]$Dev, [string]$RelDir, [string]$Want, [string]$Notes)',
    '$ErrorActionPreference = "Stop"',
    '$global:OUT = @()',
    '$global:CALLS = @()',
    'function Say($m, [string]$ForegroundColor) { $global:OUT += [string]$m }',
    // Fail 保持「抛异常终止」的真实语义；外面用 try/catch 收住，才能把桩记录完整带出来
    'function Fail($msg, $code = 2) { $global:OUT += ("[FAIL] " + $msg); throw $msg }',
    'function Invoke-NodeUtf8($scriptPath, $argTail) { $global:CALLS += [string]$argTail; return @{ Out = "OK"; Rc = 0 } }',
    '$Source = $Dev',
    '$Release = $RelDir',
    '$want = $Want',
    '$NotesFile = $Notes',
    'try {',
    block,
    '} catch { $global:OUT += ("[THROWN] " + $_.Exception.Message) }',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Write-Output (ConvertTo-Json -Compress -InputObject @{ calls = @($global:CALLS); out = @($global:OUT) })',
  ].join('\n')
  const ps1 = join(psScripts, 'b1-probe.ps1')
  writeFileSync(ps1, '\uFEFF' + psText, 'utf8')

  const runPs = (notesPath) => spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-Dev', ROOT, '-RelDir', join(psBox, 'rel'), '-Want', '0.4.7', '-Notes', notesPath,
  ], { encoding: 'utf8', timeout: 120000 })

  const r1 = runPs(notesFile)
  let psJson = null
  try { psJson = JSON.parse(`${r1.stdout || ''}`.trim()) } catch {}
  notes.ps.rc = r1.status
  notes.ps.stderr = (r1.stderr || '').slice(0, 300)
  notes.ps.calls = psJson?.calls || []
  notes.ps.out = psJson?.out || []
  const argTail = psJson?.calls?.[0] || ''
  defect.B1_notesPassedAsPositional = r1.status === 0
    && /--repo\s+"[^"]+"\s+"[^"]*notes\.md"/.test(argTail)
  defect.B1_sha256Logged = (psJson?.out || []).some((l) => /sha256=[0-9a-f]{64}/.test(l))
  // notes 只能被读，不许被复制/移动/删除；路径由 dev 侧拼出，不挂在发布树下
  defect.B1_notesReadOnly = !/Copy-Item|Move-Item|Remove-Item/.test(block)
    && /Join-Path \$Source/.test(block)

  const r2 = runPs(join(psBox, 'does-not-exist.md'))
  let psJson2 = null
  try { psJson2 = JSON.parse(`${r2.stdout || ''}`.trim()) } catch {}
  const out2 = (psJson2?.out || []).join('\n')
  notes.ps.missingRc = r2.status
  notes.ps.missingOut = out2.slice(0, 400)
  notes.ps.missingCalls = psJson2?.calls || []
  // 缺失时必须真走 Fail 分支：既有 [FAIL] 点名，也真的没把 body 传给 node
  defect.B1_missingNotesFails = /\[FAIL\][^\n]*发布说明不存在/.test(out2)
    && (psJson2?.calls || []).length === 0

  // 默认路径分支必须真跑一次，不能只测 -NotesFile 覆盖点。
  // 不传 -Notes 时 $NotesFile 为空，release.ps1 自己按 $Source 拼出 发布说明/<version>.md。
  const r3 = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-Dev', ROOT, '-RelDir', join(psBox, 'rel'), '-Want', '0.4.7',
  ], { encoding: 'utf8', timeout: 120000 })
  let psJson3 = null
  try { psJson3 = JSON.parse(`${r3.stdout || ''}`.trim()) } catch {}
  const argTail3 = psJson3?.calls?.[0] || ''
  notes.ps.defaultCalls = psJson3?.calls || []
  notes.ps.defaultOut = (psJson3?.out || []).slice(0, 6)
  notes.ps.defaultRc = r3.status
  capability.B1_defaultNotesPathWorks = r3.status === 0
    && /--repo\s+"[^"]+"\s+"[^"]*0\.4\.7\.md"/.test(argTail3)
    && (psJson3?.out || []).some((l) => /sha256=[0-9a-f]{64}/.test(l))

  // B1 的 argv 契约：干净 notes 作为位置参数，body 面真的多一份且 rc=0
  const b1box = mkBox()
  const b1clean = probe(b1box, 'clean-notes', '# 0.4.7\n\n- 修好了依赖锁竞争\n')
  const b1r = runPub(b1box, [b1clean])
  notes.probes.b1 = { rc: b1r.rc, out: b1r.out.slice(0, 500) }
  defect.B1_argTailFeedsBody = b1r.rc === 0 && /body 1 份/.test(b1r.out)
  capability.B1_cleanBodyGreen = b1r.rc === 0

  // ── B2：--help 跳过要显式记账，并按「未扫全」处理 ──────────────────────────
  const skipBox = mkBox({ brokenHelp: true })
  const skipR = runPub(skipBox)
  notes.probes.b2Skip = { rc: skipR.rc, out: skipR.out.slice(0, 1400) }
  defect.B2_helpSkipCounted = /--help 跳过：rc=/.test(skipR.out)
  defect.B2_helpSkipInSummary = /对外文案面：README ✓ \/ --help 跳过（/.test(skipR.out)
  // 跳过必须 rc≠0，且措辞是「未扫全」不是「命中泄漏」。
  // 「未扫全」那行必须在正文（✗ 开头），不能只躺在 [warn] 里。
  defect.B2_helpSkipWarnsIncomplete = skipR.rc !== 0
    && /✗ 对外文案面未扫全/.test(skipR.out)
    && /--help/.test(skipR.out)
    && !/✗ 硬闸命中/.test(skipR.out)
  capability.B2_skipDoesNotClaimFull = skipR.rc !== 0
    && !/✓ 硬闸全过/.test(skipR.out)
    && !/对外文案面：README ✓ \/ --help ✓/.test(skipR.out)
  // D2 该活时活：正常 --help + 三面扫全，必须 rc=0 且打「✓ 硬闸全过」（真跑，不是读代码）
  const okBox = mkBox()
  const okR = runPub(okBox)
  notes.probes.b2AllScanned = { rc: okR.rc, out: okR.out.slice(0, 500) }
  capability.B2_cleanAllGreen = okR.rc === 0 && /✓ 硬闸全过/.test(okR.out)
  // meta 面读不到时同样按未扫全拦住（裁定 1 把 metaScanned === 0 一并点名）
  const metaEmptyBox = mkBox({ description: '', keywords: [] })
  const metaEmptyR = runPub(metaEmptyBox)
  notes.probes.b2MetaEmpty = { rc: metaEmptyR.rc, out: metaEmptyR.out.slice(0, 500) }
  defect.B2_metaUnscannedRed = metaEmptyR.rc !== 0 && /✗ 对外文案面未扫全/.test(metaEmptyR.out)

  // ── B3：三面全接 collab，命中必须 rc≠0 且 label 属于那一面 ────────────────
  const bodyBox = mkBox()
  const pWork = probe(bodyBox, 'probe-workbuddy', 'x\nthis mentions workbuddy in body\n')
  const rWork = runPub(bodyBox, [pWork])
  notes.probes.b3BodyWorkbuddy = { rc: rWork.rc, out: rWork.out.slice(0, 700) }
  defect.B3_bodyCollabRed = rWork.rc !== 0
  defect.B3_bodyHitLabelIsBody = /\[内部协作标记\][^\n]*probe-workbuddy\.md:2/.test(rWork.out)

  const pFull = probe(bodyBox, 'probe-fullwidth', 'x\nthis mentions ＷＢＣＮ fullwidth\n')
  const rFull = runPub(bodyBox, [pFull])
  notes.probes.b3BodyFullwidth = { rc: rFull.rc, out: rFull.out.slice(0, 700) }
  defect.B3_bodyFullwidthRed = rFull.rc !== 0

  // --help 面：look.mjs 故意不在 files 里，词只出现在 HELP 输出中，
  // 这样 rc≠0 只可能来自 --help 面，排除「包内面命中而 --help 被 skip」的假绿。
  const helpBox = mkBox({ help: '用法:\nthis mentions workbuddy in help\n' })
  const rHelp = runPub(helpBox)
  notes.probes.b3Help = { rc: rHelp.rc, out: rHelp.out.slice(0, 900) }
  defect.B3_helpCollabRed = rHelp.rc !== 0
  defect.B3_helpHitLabelIsHelp = /\[内部协作标记\] --help:/.test(rHelp.out)
  defect.B3_helpNotSkipped = !/--help 跳过/.test(rHelp.out)
  capability.B3_cleanHelpGreen = (() => {
    const r = runPub(mkBox())
    notes.probes.b3CleanHelp = { rc: r.rc, out: r.out.slice(0, 400) }
    return r.rc === 0 && /--help ✓/.test(r.out)
  })()

  // 源码接线：三处 HARD_PUBLIC 的 scan 都必须带第 5 参 true
  const withCollab = [...SRC.matchAll(/scan\([^\n]*HARD_PUBLIC,\s*true,\s*true\)/g)].length
  notes.b3WiredCalls = withCollab
  defect.B3_threeFacesWired = withCollab === 3

  // ── B4：HARD_PUBLIC 删协作词、保留编号规则 ────────────────────────────────
  const hardBlock = SRC.slice(SRC.indexOf('const HARD_PUBLIC'), SRC.indexOf('const HARD_PACKAGE'))
  defect.B4_collabWordsRemoved = !/WBcn\|WBin\|WB-CN\|WB-Intl\|豆包/.test(hardBlock)
  defect.B4_numberRulesKept = /E\[1-8\]-\\d\+/.test(hardBlock) && /C\\d\{2,3\}/.test(hardBlock) && /P\[0-2\]/.test(hardBlock)
  const numBox = mkBox()
  const pNum = probe(numBox, 'probe-number', 'x\n内部索引 P0-1 不该出现在对外文案\n')
  const rNum = runPub(numBox, [pNum])
  notes.probes.b4Number = { rc: rNum.rc, out: rNum.out.slice(0, 700) }
  defect.B4_numberProbeRed = rNum.rc !== 0 && /\[内部编号\]/.test(rNum.out)
  // 协作词命中必须来自 scanCollab 的唯一词表，不是旧的平行清单
  defect.B4_collabHitFromScanCollab = /\[内部协作标记\]/.test(rWork.out)
    && !/\[协作方代称\/内部编号\]/.test(rWork.out)
  capability.B4_normalReadmeGreen = (() => {
    const r = runPub(mkBox())
    return r.rc === 0
  })()

  // ── B5：description/keywords 逐词验，五个词都要 rc≠0 ──────────────────────
  const fiveWords = ['自检', '断言', '审查报告', '台账', '切片']
  for (const w of fiveWords) {
    const box = mkBox({ description: `一个${w}用的小工具` })
    const r = runPub(box)
    notes.b5[w] = { rc: r.rc, hitMeta: /package\.json:description\/keywords/.test(r.out) }
  }
  defect.B5_fiveWordsEachRed = fiveWords.every((w) => notes.b5[w].rc !== 0)
    && fiveWords.every((w) => notes.b5[w].hitMeta)
  // 同一面还要过 scanCollab：workbuddy 只在唯一词表里，HARD_PUBLIC 不收它，
  // 所以这条红只可能来自 collab 那一层，去掉第 5 参就会漏。
  const collabMetaBox = mkBox({ description: '一个 workbuddy 小工具' })
  const rCollabMeta = runPub(collabMetaBox)
  notes.probes.b5MetaCollab = { rc: rCollabMeta.rc, out: rCollabMeta.out.slice(0, 500) }
  defect.B5_metaCollabRed = rCollabMeta.rc !== 0
    && /\[内部协作标记\][^\n]*package\.json:description\/keywords/.test(rCollabMeta.out)
  const metaBox = mkBox()
  const rMeta = runPub(metaBox)
  notes.probes.b5MetaLine = rMeta.out.slice(0, 500)
  defect.B5_metaScannedLine = /description\+keywords ✓/.test(rMeta.out)
  capability.B5_cleanMetaGreen = rMeta.rc === 0

  // 全绿基线（防止所有「红」其实是脚本崩了）
  const baseBox = mkBox()
  const rBase = runPub(baseBox)
  notes.probes.baseline = { rc: rBase.rc, out: rBase.out.slice(0, 600) }
  capability.B0_baselineGreen = rBase.rc === 0 && /✓ 硬闸全过/.test(rBase.out)
} catch (e) {
  fatal = String(e?.stack || e)
}

process.stdout.write(out({ fatal, defect, capability, notes }))
