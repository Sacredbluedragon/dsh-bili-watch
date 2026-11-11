/**
 * C298–C300 取证夹具。stdout 只吐 JSON，不设轻量分支，任何路径都真跑。
 *
 * C298：在真源码上用 ParseFile 抠 Remove-PathRobust 函数体（不按行号、不按正则），
 *       真造 Windows 保留设备名文件 + 正常文件名控制组，真删并用 [IO.File]::Exists 核。
 * C299：抠 Get-PushFailureAdvice / Resolve-GitCredentialHelper 原样函数体，
 *       喂 DSH 20:45 段的三类现场输出，真求值分类；在隔离 git 仓库里真跑 helper 决策两向。
 *       刻意不连任何远端：push 用 --dry-run 对本地 bare remote，边界禁止真 push / 真连 GitHub。
 * C300：beta 那一步只验脚本形态（AST 字面量），夹具自身绝不调 npm。
 *
 * PS 5.1 的两个坑（仓库里 C122 实测过）：-File 按 GBK 解码含中文路径会碎 → 用 -EncodedCommand；
 *   progress 以 CLIXML 写 stderr 会把输出劈开 → 只解析 stdout。中文串一律 base64 出 PS。
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const HERE = fileURLToPath(import.meta.url)
const ROOT = join(dirname(HERE), '..', '..')
const SYNC = join(ROOT, 'scripts', 'sync-release.ps1').replace(/\//g, '\\')
const REL = join(ROOT, 'scripts', 'release.ps1').replace(/\//g, '\\')
const q = (s) => String(s).replace(/'/g, "''")

const tmp = mkdtempSync(join(tmpdir(), 'c298-'))
// 隔离全局 ~/.gitconfig：否则 git config --get credential.helper 会读到全局的 "manager"，
// 「把 helper 配成空」这一向根本没造出来。GIT_CONFIG_NOSYSTEM + 空 global 才是真空配置。
const emptyCfg = join(tmp, 'empty.gitconfig')
writeFileSync(emptyCfg, '')
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_SYSTEM: emptyCfg, GIT_CONFIG_NOSYSTEM: '1' }
const work = join(tmp, 'files')
mkdirSync(work, { recursive: true })
const NAMES = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'normal.txt']
const created = {}
for (const n of NAMES) {
  const long = '\\\\?\\' + join(work, n).replace(/\//g, '\\')
  try { writeFileSync(long, `sentinel ${n}\n`); created[n] = true } catch { created[n] = false }
}

// 隔离 git 仓库 + 本地 bare remote（全程不联网）
const repo = join(tmp, 'repo')
const bare = join(tmp, 'remote.git')
mkdirSync(repo)
const git = (args, cwd) => spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 30000 })
git(['init', '-q', '-b', 'main', repo])
git(['config', 'user.email', 'probe@example.com'], repo)
git(['config', 'user.name', 'probe'], repo)
writeFileSync(join(repo, 'a.txt'), 'probe\n')
git(['add', '-A'], repo)
git(['commit', '-q', '-m', 'probe'], repo)
git(['init', '-q', '--bare', bare])
git(['remote', 'add', 'origin', bare], repo)

const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const probe = [
  '$ErrorActionPreference = "Continue"',
  'function B64($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s)) }',
  '$t=$null;$e=$null',
  `$astSync=[System.Management.Automation.Language.Parser]::ParseFile('${q(SYNC)}',[ref]$t,[ref]$e)`,
  'if($e.Count -gt 0){ throw ("parse sync: " + $e[0].Message) }',
  '$t2=$null;$e2=$null',
  `$astRel=[System.Management.Automation.Language.Parser]::ParseFile('${q(REL)}',[ref]$t2,[ref]$e2)`,
  'if($e2.Count -gt 0){ throw ("parse release: " + $e2[0].Message) }',
  'function GetFn($a,$n){ $f=@($a.FindAll({param($x) ($x -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($x.Name -eq $n)},$true)); if($f.Count -ne 1){throw ("fn "+$n+" count="+$f.Count)}; return $f[0].Extent.Text }',
  '$bSync = GetFn $astSync "Remove-PathRobust"',
  '$bRel  = GetFn $astRel  "Remove-PathRobust"',
  'Invoke-Expression $bSync',
  'Invoke-Expression (GetFn $astRel "Get-PushFailureAdvice")',
  'Invoke-Expression (GetFn $astRel "Resolve-GitCredentialHelper")',
  // ---- C298：真删 + Exists 核 ----
  `$names = @(${NAMES.map((n) => `'${q(n)}'`).join(',')})`,
  `$workDir = '${q(work.replace(/\//g, '\\'))}'`,
  '$del = @()',
  'foreach($n in $names){',
  '  $p = Join-Path $workDir $n',
  "  $long = '\\\\?\\' + $p",
  '  $was = [System.IO.File]::Exists($long)',
  "  $sent = ''",
  '  if($was){ try { $sent = [System.IO.File]::ReadAllText($long) } catch { $sent = "" } }',
  "  $sentOk = ($sent -like ('sentinel ' + $n + '*'))",
  '  $Error.Clear()',
  '  if($was -and $sentOk){ Remove-PathRobust $p }',
  '  $errs = ($Error | ForEach-Object { [string]$_ }) -join " | "',
  '  $del += [ordered]@{ name=$n; created=$was; sentinelOk=$sentOk; existsAfter=[System.IO.File]::Exists($long); err=B64 $errs }',
  '}',
  // ---- C299：三类现场输出真求值 ----
  '$cases = @(',
  '  [ordered]@{ id="cred"; out="error: failed to execute prompt script (exit code 1)`nfatal: could not read Username for https://github.com: No such file or directory"; url="https://github.com/x/y.git" },',
  '  [ordered]@{ id="wrong-url"; out="fatal: unable to access https://github.com/"; url="mirror-readonly DISABLED-do-not-push-from-dev" },',
  '  [ordered]@{ id="network"; out="fatal: unable to access: Could not resolve host: github.com"; url="https://github.com/x/y.git" }',
  ')',
  '$adv = @()',
  'foreach($c in $cases){ $a = Get-PushFailureAdvice $c.out $c.url; $adv += [ordered]@{ id=$c.id; kind=[string]$a.kind; retry=[bool]$a.retry; title=B64 $a.title; fix=B64 $a.fix } }',
  // ---- C299：隔离仓库里 helper 决策两向 + 带 -c 的 dry-run 命令形态 ----
  `$repoDir = '${q(repo.replace(/\//g, '\\'))}'`,
  'Push-Location $repoDir',
  '& git config --unset-all credential.helper 2>$null | Out-Null',
  '$hEmpty = [string](Resolve-GitCredentialHelper)',
  "& git config credential.helper 'probe-helper-value' 2>$null | Out-Null",
  '$hSet = [string](Resolve-GitCredentialHelper)',
  '$dry = ((& git -c "credential.helper=$hSet" push --dry-run origin main 2>&1) | Out-String)',
  '$dryRc = $LASTEXITCODE',
  '& git config --unset-all credential.helper 2>$null | Out-Null',
  'Pop-Location',
  // ---- C300：AST 找 dist-tag 字面量与 want 来源 ----
  '$strs = @($astRel.FindAll({param($x) ($x -is [System.Management.Automation.Language.StringConstantExpressionAst]) -or ($x -is [System.Management.Automation.Language.ExpandableStringExpressionAst])},$true) | ForEach-Object { $_.Value })',
  '$betaStr = @($strs | Where-Object { "$_" -match "npm dist-tag add" -and "$_" -match "beta" })',
  '$okBeta  = @($strs | Where-Object { "$_" -match "beta" -and "$_" -match "ok" })',
  '$rmSync = @($astSync.FindAll({param($x) ($x -is [System.Management.Automation.Language.CommandAst]) -and ($x.GetCommandName() -eq "Remove-Item")},$true)).Count',
  '$rmRel = @($astRel.FindAll({param($x) ($x -is [System.Management.Automation.Language.CommandAst]) -and ($x.GetCommandName() -eq "Remove-Item")},$true)).Count',
  '$r = [ordered]@{',
  '  bodiesIdentical = ($bSync -eq $bRel)',
  '  rmSync = $rmSync',
  '  rmRel = $rmRel',
  '  bSync = B64 $bSync',
  '  del = $del',
  '  adv = $adv',
  '  helperEmpty = $hEmpty',
  '  helperSet = $hSet',
  '  dryRc = $dryRc',
  '  betaStrCount = $betaStr.Count',
  '  okBetaCount = $okBeta.Count',
  '  betaStrB64 = B64 ($betaStr -join " || ")',
  '}',
  '$r | ConvertTo-Json -Compress -Depth 8',
].join('\n')

const enc = Buffer.from(probe, 'utf16le').toString('base64')
const r = spawnSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
  encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, env: gitEnv,
})
let ps = null
try { ps = JSON.parse((r.stdout || '').trim()) } catch {}
const syncSrc = readFileSync(SYNC, 'utf8')
const relSrc = readFileSync(REL, 'utf8')
const body = ps && ps.bSync ? Buffer.from(ps.bSync, 'base64').toString('utf8') : ''
const out = {
  psStatus: r.status,
  psStderrTail: (r.stderr || '').slice(-400),
  psRawTail: (r.stdout || '').slice(-400),
  ps,
  created,
  static: {
    syncRemoveItem: (syncSrc.match(/Remove-Item/g) || []).length,
    relRemoveItem: (relSrc.match(/Remove-Item/g) || []).length,
    syncRobustCalls: (syncSrc.match(/Remove-PathRobust \$full/g) || []).length,
    relRobustCalls: (relSrc.match(/Remove-PathRobust /g) || []).length,
    wantFromPkg: /\$want\s*=\s*if \(\$Version\) \{ \$Version \} else \{ \$srcPkg\.version \}/.test(relSrc),
    pushOutNull: (relSrc.match(/git @credArgs push[^\n]*Out-Null/g) || []).length,
    credArgsOnTag: /\$tagPushOut = \(\(& git @credArgs push origin "v\$want"/.test(relSrc),
    hardcodedGcm: /D:\/Git\/ucrt64|D:\\Git\\ucrt64/.test(relSrc),
    bodyHasLongPrefix: body.includes('\\\\?\\'),
    bodyHasExists: /File\]::Exists|Directory\]::Exists/.test(body),
    // 排除本行自身，否则正则会匹配到自己的字面量（第一次现核就是这个假阳性）。
    fixtureCallsNpm: /(?:execSync|spawnSync|execFileSync)\(\s*['"`]npm\b/.test(
      readFileSync(HERE, 'utf8').split('\n').filter((l) => !l.includes('fixtureCallsNpm')).join('\n')),
  },
}
try { rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(JSON.stringify(out))
