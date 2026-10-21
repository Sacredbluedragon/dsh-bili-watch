<#
  fetch-deps.ps1 —— dsh-bili-watch 可选依赖一键下载（Windows）

  用法（Windows 自带的 powershell.exe 就能跑；装了 pwsh 7 的也可以）：
    powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target all
    powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target ytdlp -Force
    powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target all -DryRun
    powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target all -Mirror cn
    pwsh scripts/fetch-deps.ps1 -Target all

  目标（可单独装，也可 all 全装）：
    ffmpeg  Windows 静态构建（BtbN，GPL）→ deps\ffmpeg.exe、deps\ffprobe.exe
    ytdlp   yt-dlp.exe → deps\yt-dlp.exe
    asr     建 deps\.venv-asr 并装 faster-whisper（需系统 Python 3.10+）
    ocr     建 deps\.venv-ocr 并装 rapidocr-onnxruntime
    model   预下载 faster-whisper-small 到 deps\.hf-home（约 464 MB；不装也能跑，首次转写会自动下）
    all     依次执行以上全部

  说明：
    · 幂等：目标已存在默认跳过，-Force 重下。
    · -DryRun 只打印将执行的命令，不下载不写盘。
    · 国内网络用 -Mirror cn：GitHub 走 gh-proxy、PyPI 走清华、模型走 hf-mirror。
    · ffmpeg 来源是 BtbN 的 latest 构建，版本随上游变化，不锁具体版本。
#>
param(
  [ValidateSet('all', 'ffmpeg', 'ytdlp', 'asr', 'ocr', 'model')]
  [string]$Target = 'all',
  [switch]$Force,
  [switch]$DryRun,
  [ValidateSet('auto', 'cn', 'global')]
  [string]$Mirror = 'auto'
)

$ErrorActionPreference = 'Stop'
# PS 5.1 默认 GBK 控制台会把中文/勾号显示成乱码；只影响显示，不影响逻辑
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Deps = Join-Path $Root 'deps'
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $Deps | Out-Null }

$UseCn = ($Mirror -eq 'cn') -or (($Mirror -eq 'auto') -and ($env:BILI_WATCH_MIRROR -eq 'cn'))
$GhProxy = if ($UseCn) { 'https://gh-proxy.com/' } else { '' }
$PyIndex = if ($UseCn) { 'https://pypi.tuna.tsinghua.edu.cn/simple' } else { 'https://pypi.org/simple' }
$HfEndpoint = if ($UseCn) { 'https://hf-mirror.com' } else { 'https://huggingface.co' }

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Skip([string]$msg) { Write-Host "    $msg（已存在，跳过；-Force 重下）" -ForegroundColor DarkGray }

function Invoke-Download([string]$url, [string]$out, [string]$label) {
  if ($DryRun) {
    Write-Host "    [dry-run] curl.exe -L --fail -o `"$out`" `"$url`""
    return
  }
  $tmp = "$out.part"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  Write-Host "    下载 $label ..."
  & curl.exe -L --fail --retry 3 --connect-timeout 20 -o $tmp $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmp)) {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    throw "下载失败：$url"
  }
  Move-Item -LiteralPath $tmp -Destination $out -Force
}

function Ensure-Ffmpeg {
  $exe = Join-Path $Deps 'ffmpeg.exe'
  if ((Test-Path -LiteralPath $exe) -and -not $Force) { Write-Skip 'deps\ffmpeg.exe'; return }
  Write-Step 'ffmpeg（Windows 静态构建，BtbN GPL）'
  $url = $GhProxy + 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'
  $zip = Join-Path $env:TEMP 'bili-watch-ffmpeg.zip'
  try {
    Invoke-Download $url $zip 'ffmpeg-master-latest-win64-gpl.zip'
  } catch {
    # 80 MB 的 BtbN zip 在 GitHub 直连不稳时大概率断流；给替代路径，别让安装卡死在这
    Write-Warning 'ffmpeg 下载失败。可选替代路径：'
    Write-Host '  1) 手动下载 ffmpeg.exe 放进 deps\ 后重跑本脚本（会自动跳过）'
    Write-Host '  2) 已有 ffmpeg 时设 $env:BILI_WATCH_FFMPEG = <ffmpeg.exe 路径>'
    Write-Host '  3) 换镜像重试：-Mirror cn（走 gh-proxy）'
    throw 'ffmpeg 未安装（见上面的替代路径）'
  }
  if ($DryRun) { return }
  $tmpDir = Join-Path $env:TEMP 'bili-watch-ffmpeg-bin'
  if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $tmpDir -Force
  $bin = Get-ChildItem -LiteralPath $tmpDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  if (-not $bin) { throw '解压后没找到 ffmpeg.exe' }
  Copy-Item -LiteralPath $bin.FullName -Destination $exe -Force
  $probe = Get-ChildItem -LiteralPath $tmpDir -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1  # ffprobe：预留（look.mjs 暂不引用），解压顺手带上
  if ($probe) { Copy-Item -LiteralPath $probe.FullName -Destination (Join-Path $Deps 'ffprobe.exe') -Force }
  Remove-Item -LiteralPath $tmpDir -Recurse -Force
  Remove-Item -LiteralPath $zip -Force
  Write-Host "    ✓ $exe"
}

function Ensure-Ytdlp {
  $exe = Join-Path $Deps 'yt-dlp.exe'
  if ((Test-Path -LiteralPath $exe) -and -not $Force) { Write-Skip 'deps\yt-dlp.exe'; return }
  Write-Step 'yt-dlp.exe'
  $url = $GhProxy + 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  Invoke-Download $url $exe 'yt-dlp.exe'
  if (-not $DryRun) { Write-Host "    ✓ $exe" }
}

function Get-SystemPython {
  foreach ($c in @('py', 'python', 'python3')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    & $c -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return $c }
  }
  throw '找不到可用的 Python 3.10+。请先安装 Python 并加入 PATH，或用 -Target 单独装其它项。'
}

function Ensure-Asr {
  $venv = Join-Path $Deps '.venv-asr'
  $py = Join-Path $venv 'Scripts\python.exe'
  if ((Test-Path -LiteralPath $py) -and -not $Force) {
    # 半成品陷阱：venv 建好、pip 装包失败时目录仍在，只看 python.exe 会永远跳过
    & $py -c 'import faster_whisper' 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Skip 'deps\.venv-asr'; return }
    Write-Host '    venv 存在但 faster_whisper 不可用，重建' -ForegroundColor Yellow
    Remove-Item -LiteralPath $venv -Recurse -Force
  }
  Write-Step 'ASR 环境（deps\.venv-asr + faster-whisper）'
  if ($DryRun) {
    Write-Host "    [dry-run] <系统 Python> -m venv `"$venv`""
    Write-Host "    [dry-run] `"$py`" -m pip install faster-whisper -i $PyIndex"
    return
  }
  $sysPy = Get-SystemPython
  & $sysPy -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw '创建 venv 失败' }
  & $py -m pip install --upgrade pip -i $PyIndex
  & $py -m pip install faster-whisper -i $PyIndex
  if ($LASTEXITCODE -ne 0) {
    # 本次失败立刻清掉半成品，别留给下次 Skip 继续踩
    Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue
    throw '安装 faster-whisper 失败（已删除半成品 venv，重跑即可重试）'
  }
  Write-Host "    ✓ $py"
}

function Ensure-Ocr {
  $venv = Join-Path $Deps '.venv-ocr'
  $py = Join-Path $venv 'Scripts\python.exe'
  if ((Test-Path -LiteralPath $py) -and -not $Force) {
    & $py -c 'import rapidocr_onnxruntime' 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Skip 'deps\.venv-ocr'; return }
    Write-Host '    venv 存在但 rapidocr_onnxruntime 不可用，重建' -ForegroundColor Yellow
    Remove-Item -LiteralPath $venv -Recurse -Force
  }
  Write-Step 'OCR 环境（deps\.venv-ocr + rapidocr-onnxruntime）'
  if ($DryRun) {
    Write-Host "    [dry-run] <系统 Python> -m venv `"$venv`""
    Write-Host "    [dry-run] `"$py`" -m pip install rapidocr-onnxruntime -i $PyIndex"
    return
  }
  $sysPy = Get-SystemPython
  & $sysPy -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw '创建 venv 失败' }
  & $py -m pip install --upgrade pip -i $PyIndex
  & $py -m pip install rapidocr-onnxruntime -i $PyIndex
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue
    throw '安装 rapidocr-onnxruntime 失败（已删除半成品 venv，重跑即可重试）'
  }
  Write-Host "    ✓ $py"
}

function Ensure-Model {
  $asrPy = Join-Path $Deps '.venv-asr\Scripts\python.exe'
  $hfHome = Join-Path $Deps '.hf-home'
  if ((Test-Path -LiteralPath (Join-Path $hfHome 'hub')) -and -not $Force) { Write-Skip 'deps\.hf-home'; return }
  if (-not $DryRun -and -not (Test-Path -LiteralPath $asrPy)) {
    throw '模型要用 ASR 环境里的 huggingface_hub。先跑 -Target asr。'
  }
  Write-Step 'faster-whisper-small 模型（约 464 MB）'
  if ($DryRun) {
    Write-Host "    [dry-run] HF_HOME=`"$hfHome`" HF_ENDPOINT=$HfEndpoint HF_HUB_DISABLE_XET=1 `"$asrPy`" -c `"snapshot_download('Systran/faster-whisper-small')`""
    return
  }
  $env:HF_HOME = $hfHome
  if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = $HfEndpoint }
  $env:HF_HUB_DISABLE_XET = '1'
  & $asrPy -c "from huggingface_hub import snapshot_download; print(snapshot_download('Systran/faster-whisper-small'))"
  if ($LASTEXITCODE -ne 0) { throw '模型下载失败' }
  Write-Host "    ✓ $hfHome"
}

$failed = 0
function Run-One([string]$name, [scriptblock]$action) {
  try { & $action } catch { $script:failed++; Write-Warning "「$name」失败：$($_.Exception.Message)" }
}

$steps = switch ($Target) {
  'ffmpeg' { @('ffmpeg') }
  'ytdlp' { @('ytdlp') }
  'asr' { @('asr') }
  'ocr' { @('ocr') }
  'model' { @('model') }
  default { @('ffmpeg', 'ytdlp', 'asr', 'ocr', 'model') }
}

if ($DryRun) { Write-Host '[DryRun] 只打印命令，不下载、不写盘。' -ForegroundColor Yellow }

foreach ($s in $steps) {
  switch ($s) {
    'ffmpeg' { Run-One 'ffmpeg' { Ensure-Ffmpeg } }
    'ytdlp' { Run-One 'ytdlp' { Ensure-Ytdlp } }
    'asr' { Run-One 'asr' { Ensure-Asr } }
    'ocr' { Run-One 'ocr' { Ensure-Ocr } }
    'model' { Run-One 'model' { Ensure-Model } }
  }
}

Write-Host ''
if ($failed -gt 0) {
  Write-Warning "有 $failed 项失败，看上面每项的原因；已完成的项不受影响。"
  exit 1
}
Write-Host '完成。验证：node --check tools/look.mjs 与 node tools/look.mjs view <BV号>' -ForegroundColor Green
