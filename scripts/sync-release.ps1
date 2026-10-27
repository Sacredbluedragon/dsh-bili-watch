<#
.SYNOPSIS
  把开发态（插件目录）同步到发布树，并断言发布线干净。

.DESCRIPTION
  为什么要有这个脚本：发布树是「开发态脱敏后的副本」，不是开发态的旧版本。
  以前靠记忆手工复制，0.2.16 就漏了脱敏、files 白名单与凭证目录。
  这个脚本只做三件事：复制代码、改发布态元数据、断言零本机路径 + pack 清单。

  不做的事（故意的）：
  - 不覆盖 auto-trigger.js（发布树版本对 ?bvid= 要求 bilibili 域名，比开发态严）
  - 不覆盖 README.md（发布树是完整版，开发态是精简版）
  这两件如需同步，手工合并后自己 commit。

.EXAMPLE
  powershell -File scripts\sync-release.ps1
  powershell -File scripts\sync-release.ps1 -Version 0.2.17 -Release "D:\tmp\release"
#>
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$Release = "D:\007 Dsh工作区\_候选\bili-watch-github\发布",
  [string]$Version = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
function ReadJsonUtf8($path) { [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }
# B2（2026-10-27 批次8）：扫描清单不再硬编码，由调用方传入（默认从 files 数组展开）。
function AssertNoPaths($dir, $label, $files) {
  $hits = @()
  foreach ($f in $files) {
    $p = Join-Path $dir $f
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $m = Select-String -LiteralPath $p -Pattern 'D:\\007 Dsh|GPT-SoVITS' -AllMatches
    if ($m) { $hits += $m }
  }
  if ($hits.Count -gt 0) {
    $hits | ForEach-Object { Write-Host ("  " + $_.Path + ":" + $_.LineNumber + " " + $_.Line.Trim()) }
    Fail "$label 里还有本机路径（$($hits.Count) 处）"
  }
  Write-Host "[ok] $label 零本机路径"
}

Write-Host "源=$Source"
Write-Host "发布树=$Release"
if (-not (Test-Path -LiteralPath $Release)) { Fail "发布树不存在：$Release" }

# B2：复制/扫描清单统一从源 package.json 的 files 数组展开（目录项递归枚举成相对路径）。
#   auto-trigger.js（发布树对 ?bvid= 更严）与 README.md（发布树更全）按文档「不覆盖」排除，
#   但仍纳入本机路径扫描——它们在包里，发布态也必须脱敏。
$srcPkg = ReadJsonUtf8 (Join-Path $Source "package.json")
$excludeCopy = @("auto-trigger.js", "README.md")
$copyList = @()
foreach ($entry in $srcPkg.files) {
  $rel = ([string]$entry).TrimEnd('/', '\') -replace '\\', '/'
  $srcPath = Join-Path $Source ($rel -replace '/', '\')
  if (Test-Path -LiteralPath $srcPath -PathType Container) {
    foreach ($f in (Get-ChildItem -LiteralPath $srcPath -Recurse -File)) {
      $copyList += $f.FullName.Substring($Source.Length).TrimStart('\', '/') -replace '\\', '/'
    }
  } else {
    $copyList += $rel
  }
}
$copyList = @($copyList | Select-Object -Unique)
# 扫描清单：排除「自己就是检测器/构建脚本」的文件——它们合法地含有 GPT-SoVITS 字面量正则或本机默认路径，
#   扫它们是误报（原来硬编码 5 文件时本就没扫 verify*.mjs / scripts/）。
$scanList = @(($copyList + $excludeCopy) | Where-Object {
  $_ -notmatch '^(scripts/|tools/verify\.mjs$|tools/verify-todo\.mjs$)'
} | Select-Object -Unique)

# ① 源必须已经脱敏，否则复制过去等于泄漏
AssertNoPaths $Source "开发态" $scanList

# ② 复制代码主体（清单来自 files 数组展开；排除项跳过 Copy）
if ($DryRun) {
  Write-Host "[DryRun] 解析出的发布文件清单（每行相对路径）："
  $copyList | Sort-Object | ForEach-Object { Write-Host ("  " + $_) }
  Write-Host "[DryRun] 共 $($copyList.Count) 个文件；未执行复制。"
  exit 0
}
foreach ($rel in $copyList) {
  if ($excludeCopy -contains $rel) { Write-Host ("[skip] " + $rel + "（发布树版本更严/更全，不覆盖）"); continue }
  $dst = Join-Path $Release ($rel -replace '/', '\')
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
  Copy-Item -LiteralPath (Join-Path $Source ($rel -replace '/', '\')) -Destination $dst -Force
  Write-Host ("[copy] " + $rel + " " + (Get-Item -LiteralPath $dst).Length + " B")
}

# ③ 发布态元数据：以**源** package.json 为底（2026-10-27 修：原先读发布树自己的旧包、
#    只改 version/private，导致 files / peerDependencies / scripts 的改动永远传不到发布树——
#    实测 THIRD_PARTY_NOTICES.md 进不了包、peer 还停在 rc.1、scripts 整段丢失）。
#    现在只把 version 跟源走、private 强制 false，其余字段一律以源为准。
$srcPkg = ReadJsonUtf8 (Join-Path $Source "package.json")
$relPkgPath = Join-Path $Release "package.json"
$want = if ($Version) { $Version } else { $srcPkg.version }
# 经 JSON 往返拿一份独立副本，避免污染 $srcPkg
$relPkg = ($srcPkg | ConvertTo-Json -Depth 10) | ConvertFrom-Json
$relPkg.version = $want
$relPkg.private = $false
$json = ($relPkg | ConvertTo-Json -Depth 10) + "`n"
[IO.File]::WriteAllText($relPkgPath, $json, (New-Object Text.UTF8Encoding($false)))
Write-Host ("[meta] version=" + $want + " private=false（元数据源=源 package.json）")

# ④ 发布树必须干净 + 元数据齐全
AssertNoPaths $Release "发布树" $scanList
$check = ReadJsonUtf8 $relPkgPath
foreach ($k in @("name", "version", "private", "files", "bin", "license", "repository", "homepage", "bugs", "keywords", "author", "peerDependencies")) {
  if ($null -eq $check.$k) { Fail "package.json 缺 $k" }
}
if ($check.private -ne $false) { Fail "private 必须为 false" }
if (-not $check.files -or $check.files.Count -eq 0) { Fail "files 为空，会把 deps 与凭证打进包" }
Write-Host ("[ok] files=" + ($check.files -join ", "))

# ⑤ pack 预演：清单与体积必须像样；deps 与凭证不得出现
Push-Location $Release
try {
  $pack = (cmd /c "npm pack --dry-run 2>&1") -join "`n"
  $bad = $pack | Select-String -Pattern 'credential\.json|\.venv-|yt-dlp\.exe|\.hf-home'
  if ($bad) { Fail ("pack 清单里出现敏感件：`n" + ($bad -join "`n")) }
  $size = ($pack | Select-String -Pattern 'package size:\s*([\d.]+ \w+)').Matches
  $count = ($pack | Select-String -Pattern 'total files:\s*(\d+)').Matches
  Write-Host ("[ok] pack " + $count + " / " + $size)
} finally { Pop-Location }

Write-Host ""
Write-Host "完成。记住两件没同步的：auto-trigger.js（发布树更严）、README.md（发布树更全）。" -ForegroundColor Yellow
