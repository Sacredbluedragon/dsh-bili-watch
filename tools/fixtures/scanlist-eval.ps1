# C193 fixture: evaluate the ORIGINAL scan-list construction segment from sync-release.ps1.
# Pure ASCII on purpose: PS 5.1 reads BOM-less .ps1 as GBK, so Chinese literals break.
# Paths come from env vars (set by the caller) to keep this file ASCII-only.
# Only computes lists. Does not copy, does not touch the release tree, does not run release.ps1.
# The segment is sliced out of the source file at runtime, so changing sync-release.ps1
# changes what this evaluates -- it is not a re-implementation of the list logic.
$SyncPath = $env:C193_SYNC
$Source   = $env:C193_SOURCE

$src = [IO.File]::ReadAllText($SyncPath, [Text.Encoding]::UTF8)
$a = $src.IndexOf('$srcPkg = ReadJsonUtf8')
$b = $src.IndexOf('$repoOnly = @(', $a)
if ($a -lt 0 -or $b -le $a) { Write-Output '{"fatal":"CUT_FAIL"}'; exit 2 }
$seg = $src.Substring($a, $b - $a)

function ReadJsonUtf8($path) { [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
function Fail($msg) { throw "Fail: $msg" }

$body = $seg + @'

[PSCustomObject]@{
  copyCount       = @($copyList).Count
  scanCount       = @($scanList).Count
  hasPackageJson  = (@($scanList) -contains 'package.json')
  hasReadme       = (@($scanList) -contains 'README.md')
  hasAutoTrigger  = (@($scanList) -contains 'auto-trigger.js')
  scanList        = @($scanList)
} | ConvertTo-Json -Compress -Depth 4
'@

$tmp = Join-Path $env:TEMP ("c193-" + [guid]::NewGuid().ToString('N') + ".ps1")
try {
  [IO.File]::WriteAllText($tmp, $body, (New-Object Text.UTF8Encoding($true)))
  & $tmp
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
}
