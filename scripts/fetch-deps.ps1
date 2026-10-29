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
    · -Gpu ask|yes|no：要不要装 CUDA 运行库（cuBLAS + cuDNN，约 500 MB）。ask 会问一句：装了 ASR 能用 GPU 快 2-8 倍，不装就走 CPU。
    · ffmpeg 来源是 BtbN 的 latest 构建，版本随上游变化，不锁具体版本。
    · pip 包锁死四版本（本机实测能跑）：faster-whisper==1.2.1、av==15.1.0、
      ctranslate2==4.8.3（10-28 issue #2 P3-2：4.8.4 在部分机器加载模型即 0xC0000005 硬崩，
      自己没有显式依赖，是 faster-whisper 拖进来的，所以必须自己钉）、
      rapidocr-onnxruntime==1.2.3。yt-dlp 不锁版本，必须跟上游走。
    · 二进制不锁版本，但装完会把 ffmpeg -version 首行与 yt-dlp --version 记进
      deps\last-run.json（便于对账；该文件同时是运行时记录，下次跑 CLI 会被覆盖）。
    · -VerifyHash：可选开关。不传则跳过哈希校验；传了则在下载完成后打印每个二进制
      的 SHA256 摘要（仓库暂不内置期望摘要，仅打印供人工比对，不据此失败）。
    · curl.exe 强制 https（--proto =https --proto-redir =https），不允许明文 http 跳转。
#>
param(
  [ValidateSet('all', 'ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'cuda')]
  [string]$Target = 'all',
  [switch]$Force,
  # GPU 运行库（cuBLAS + cuDNN，约 500 MB）怎么处理：ask=问一句（默认，非交互时按 no）/ yes / no
  [ValidateSet('ask', 'yes', 'no')]
  [string]$Gpu = 'ask',
  [switch]$DryRun,
  [switch]$VerifyHash,
  [ValidateSet('auto', 'cn', 'global')]
  [string]$Mirror = 'auto',
  [string]$PythonPath = ''
)

$ErrorActionPreference = 'Stop'
# PS 5.1 默认 GBK 控制台会把中文/勾号显示成乱码；只影响显示，不影响逻辑
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# X-30（2026-10-29）：deps 默认装到包外（$DSH_HOME\bili-watch\deps），重装包不会连 venv/模型一起删。
#   解析顺序：BILI_WATCH_DEPS > $DSH_HOME\bili-watch\deps；插件还没搬家、包内 deps\ 有内容时仍装包内，
#   免得「装到空目录、看不到已有 venv」重复下 460 MB。与 index.js / tools/look.mjs 同一口径。
$DepsLocal = Join-Path $Root 'deps'
if ($env:BILI_WATCH_DEPS) {
  $Deps = $env:BILI_WATCH_DEPS
} else {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
  $DepsPreferred = Join-Path $dshHome 'bili-watch\deps'
  if ((Test-Path -LiteralPath $DepsPreferred) -or -not (Test-Path -LiteralPath $DepsLocal)) { $Deps = $DepsPreferred } else { $Deps = $DepsLocal }
}
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $Deps | Out-Null }

$UseCn = ($Mirror -eq 'cn') -or (($Mirror -eq 'auto') -and ($env:BILI_WATCH_MIRROR -eq 'cn'))
# C-01（2026-10-29）：-Mirror auto 以前什么都不探测——国内用户跑默认命令，ffmpeg/yt-dlp 从 github.com
#   直连、模型从 huggingface.co 直连，卡到超时。这里补一个 1.5 秒的 TCP 探测：
#   huggingface.co 不通而 hf-mirror.com 通 → 按国内网络处理，自动切镜像。
function Test-TcpReachable([string]$HostName, [int]$Port = 443) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($HostName, $Port, $null, $null)
    $done = $iar.AsyncWaitHandle.WaitOne(1500)
    if (-not $done) { $c.Close(); return $false }
    $c.EndConnect($iar)
    $c.Close()
    return $true
  } catch {
    try { $c.Close() } catch {}
    return $false
  }
}
if (-not $UseCn -and $Mirror -eq 'auto' -and -not $env:BILI_WATCH_MIRROR -and -not $DryRun) {
  if (-not (Test-TcpReachable 'huggingface.co') -and (Test-TcpReachable 'hf-mirror.com')) {
    $UseCn = $true
    Write-Host '    探测到 huggingface.co 不可达、hf-mirror.com 可达，自动切国内镜像（要直连请加 -Mirror global）' -ForegroundColor Yellow
  }
}
$GhProxy = if ($UseCn) { 'https://gh-proxy.com/' } else { '' }
$PyIndex = if ($UseCn) { 'https://pypi.tuna.tsinghua.edu.cn/simple' } else { 'https://pypi.org/simple' }
# C-02（2026-10-29）：模型镜像默认跟 tools/look.mjs 对齐——运行时首次自动下载写死 hf-mirror.com，
#   预下载却走 huggingface.co，同一份模型两条路径用不同镜像，国内等于「预下载这条路是摆设」。
#   现在只有显式 -Mirror global 才直连 huggingface.co。
$HfEndpoint = if ($Mirror -eq 'global') { 'https://huggingface.co' } else { 'https://hf-mirror.com' }

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Skip([string]$msg) { Write-Host "    $msg（已存在，跳过；-Force 重下）" -ForegroundColor DarkGray }

function Move-SemiVenv([string]$venv) {
  # 半成品 venv 不用递归批量删——会撞上用户的删除守卫（issue #3 实测）。
  # 改成改名留档，用户确认无用后自己删。
  if (-not (Test-Path -LiteralPath $venv)) { return }
  $leaf = Split-Path -Leaf $venv
  $parent = Split-Path -Parent $venv
  # M-03（2026-10-29）：以前只改名不清理，反复失败会攒出好几个 xxx.old-* 目录（每个 1–2 GB）。
  #   改名之前先把上一次留下的 .old-* 删掉——那是我们自己上一轮造的垃圾，不是用户的文件。
  #   只删「同一 leaf 前缀 + .old-时间戳」这种我们自己命名的目录，别的一律不碰。
  try {
    $old = @(Get-ChildItem -LiteralPath $parent -Directory -Filter "$leaf.old-*" -ErrorAction SilentlyContinue)
    if ($old.Count -gt 0) {
      $freed = 0
      foreach ($d in $old) {
        try {
          $sz = (Get-ChildItem -LiteralPath $d.FullName -Recurse -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
          Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
          if ($sz) { $freed += [int64]$sz }
        } catch {
          Write-Host "    ! 旧的半成品目录删不掉：$($d.Name)（$($_.Exception.Message)）" -ForegroundColor DarkGray
          Write-Host "      可手动删除：$($d.FullName)" -ForegroundColor DarkGray
        }
      }
      if ($freed -gt 0) {
        Write-Host "    已清掉上一次的半成品目录，回收 $([math]::Round($freed/1MB)) MB" -ForegroundColor DarkGray
      }
    }
  } catch {}
  $dst = "$leaf.old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  try {
    Rename-Item -LiteralPath $venv -NewName $dst
    Write-Host "    半成品 venv 已改名为 deps\\$dst（确认无用后可手动删）" -ForegroundColor Yellow
  } catch {
    Write-Host "    ! 半成品 venv 改名失败：$_" -ForegroundColor Yellow
    Write-Host "      可手动删除：$venv" -ForegroundColor DarkGray
  }
}

function Invoke-PipInstall {
  # 镜像失败自动回退官方 PyPI（issue #3 报过 mirror 晚于 PyPI 同步；2026-10-29 复核清华已有 1.2.1）
  param([string]$Py, [string[]]$PipArgs)
  & $Py -m pip @PipArgs -i $PyIndex
  if ($LASTEXITCODE -eq 0) { return }
  if ($PyIndex -eq 'https://pypi.org/simple') { return }
  Write-Host "    ! 镜像装不上（$PyIndex），改走官方 PyPI 重试" -ForegroundColor Yellow
  & $Py -m pip @PipArgs -i 'https://pypi.org/simple'
}

function Invoke-Download([string]$url, [string]$out, [string]$label) {
  if ($DryRun) {
    Write-Host "    [dry-run] curl.exe -L --fail --proto =https --proto-redir =https -C - -o `"$out.part`" `"$url`""
    return
  }
  $tmp = "$out.part"
  # E-06（2026-10-29）：以前开下之前先删 .part，ffmpeg 那 80 MB 断一次网就得从头再来。
  #   现在保留 .part 并用 curl -C - 续传；服务器不支持 Range（curl 非 0 退出）就删掉从头下一次。
  $base = @('-L', '--fail', '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '--connect-timeout', '20')
  if (Test-Path -LiteralPath $tmp) {
    $have = (Get-Item -LiteralPath $tmp).Length
    Write-Host "    发现上次没下完的 .part（$([math]::Round($have/1MB,1)) MB），续传 $label ..."
    & curl.exe @base -C - -o $tmp $url
    if ($LASTEXITCODE -ne 0) {
      Write-Host '    续传失败（服务器可能不支持 Range），删掉从头重下' -ForegroundColor Yellow
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      & curl.exe @base -o $tmp $url
    }
  } else {
    Write-Host "    下载 $label ..."
    & curl.exe @base -o $tmp $url
  }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmp)) {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    throw "下载失败：$url"
  }
  Move-Item -LiteralPath $tmp -Destination $out -Force
  if ($VerifyHash) {
    $h = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
    Write-Host "    SHA256($label) = $h"
  }
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
  # 版本必须「有上界」：onnxruntime 目前没有 3.13+ 的 wheel，
  # 只判 >=3.10 会让 py 启动器挑到最新的 3.15，pip 报 No matching distribution（issue #3 实测）。
  $sawStub = $false
  if ($PythonPath) {
    if (-not (Test-Path -LiteralPath $PythonPath)) { throw "指定的 Python 不存在：$PythonPath" }
    $v = & $PythonPath -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "指定的 Python 跑不起来：$PythonPath" }
    if ($v -notmatch '^3\.(1[0-4])$') { throw "指定的 Python 是 $v，需要 3.10–3.14（onnxruntime 尚无更高版本的 wheel）" }
    return $PythonPath
  }
  $pyLauncher = Get-Command 'py' -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    foreach ($v in @('3.14', '3.13', '3.12', '3.11', '3.10')) {
      $exe = & $pyLauncher.Source "-$v" -c "import sys;print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path -LiteralPath ($exe.Trim()))) { return $exe.Trim() }
    }
  }
  foreach ($c in @('python', 'python3')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    # E-05（2026-10-29）：Windows 的「应用执行别名」会在 PATH 里放一个 python.exe 存根
    #   （...\Microsoft\WindowsApps\python.exe）。它不报错也不给版本，跑起来要么弹商店、
    #   要么 9009 退出——用户最后看到的是「找不到 Python」，其实他装了真 Python 只是排在后面。
    if ($cmd.Source -match '\\WindowsApps\\') {
      $sawStub = $true
      Write-Host "    跳过应用商店的 python 存根：$($cmd.Source)" -ForegroundColor DarkGray
      continue
    }
    $v = & $cmd.Source -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    if ($v -notmatch '^3\.(1[0-4])$') { continue }
    $exe = & $cmd.Source -c "import sys;print(sys.executable)" 2>$null
    if ($exe -and (Test-Path -LiteralPath ($exe.Trim()))) { return $exe.Trim() }
  }
  if ($sawStub) {
    throw '只找到 Windows 应用商店的 Python 存根（WindowsApps\python.exe），它不是真的解释器。请装一个 3.12，或用 -PythonPath 指定解释器路径。'
  }
  throw '找不到 Python 3.10–3.14（更高版本 onnxruntime 还没有 wheel）。请装一个 3.12，或用 -PythonPath 指定解释器路径。'
}

# 第十条（2026-10-29）：GPU 运行库单独一个 target，供 -Target cuda 与 Ensure-Asr 的询问分支共用。
#   装三个 wheel：cuBLAS + cuDNN + nvrtc（ctranslate2 在部分版本上会去要 nvrtc）。
#   装完必须真试一次 DLL——pip 装成功不代表能加载（缺 VC++ Redist 时 pip 也成功、import 才崩）。
function Install-CudaLibs {
  param([string]$Py = '')
  Write-Step 'GPU 运行库（cuBLAS + cuDNN + nvrtc，约 500 MB）'
  if (-not $Py) { $Py = Join-Path (Join-Path $Deps '.venv-asr') 'Scripts\python.exe' }
  if (-not (Test-Path -LiteralPath $Py)) {
    Write-Host '    ! 还没装 ASR 环境：GPU 运行库要装进 .venv-asr，先跑 -Target asr' -ForegroundColor Yellow
    return
  }
  if ($DryRun) {
    Write-Host "    [dry-run] `"$Py`" -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-nvrtc-cu12 -i $PyIndex"
    return
  }
  Invoke-PipInstall $Py @('install', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12', 'nvidia-cuda-nvrtc-cu12')
  # 与面板 /status 的 ok 判据同一口径：不看 pip 包名，真加载一次 DLL。
  # 2026-10-29 修两处：① 原来用裸 ctypes.WinDLL("cublas64_12.dll") 判可用，但 pip 装的 cublas 在
  #   site-packages/nvidia/*/bin、不在默认 DLL 搜索路径，装好了也报「加载不了」；
  #   ② $ErrorActionPreference='Stop' 下原生命令写 stderr 会抛 NativeCommandError（日志里只剩空 Traceback）。
  #   统一走 _bili-asr.py --probe-gpu（它内部先加 DLL 目录），并临时放宽错误策略。
  $probe = Join-Path $Deps '_bili-asr.py'
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $Py $probe '--probe-gpu' 2>$null | Out-Null
  $probeRc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($probeRc -eq 0) {
    Write-Host '    ✓ cublas64_12.dll 能加载：ASR 会走 GPU（显存不足自动回落 CPU）'
  } else {
    Write-Host '    ! DLL 加载不了（可能缺 VC++ Redist 或显卡驱动太旧）；ASR 继续用 CPU，功能不受影响' -ForegroundColor Yellow
  }
}

# M-06（2026-10-29）：找 nvidia-smi，**只返回路径字符串**（找不到返回 ''）。
#   为什么不直接返回对象：Get-Command 给的是 ApplicationInfo（有 .Source、**没有** .FullName），
#   Get-Item 给的是 FileInfo（有 .FullName、**没有** .Source）。两种对象没有一个共同的可执行属性，
#   谁按单一属性取值，都会在另一条分支上拿到 $null，然后 `& $null --query-gpu=...` 抛
#   误导性的「nvidia-smi 查询异常」——比改前更糟（豆包 11:40 验收抓到，本机实测确认：
#   ApplicationInfo.Source=路径 / .FullName=空；FileInfo 正好相反）。
#   所以这里把两条来源都归一到 $smiPath，取值只取一次。
function Resolve-NvidiaSmi {
  $c = Get-Command 'nvidia-smi' -ErrorAction SilentlyContinue
  if ($c -and $c.Source) { return [string]$c.Source }
  foreach ($p in @("$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe", "$env:SystemRoot\System32\nvidia-smi.exe")) {
    if ($p -and (Test-Path -LiteralPath $p)) { return [string]$p }
  }
  return ''
}

function Ensure-Asr {
  $venv = Join-Path $Deps '.venv-asr'
  $py = Join-Path $venv 'Scripts\python.exe'
  if ((Test-Path -LiteralPath $py) -and -not $Force) {
    # 半成品陷阱：venv 建好、pip 装包失败时目录仍在，只看 python.exe 会永远跳过
    & $py -c 'import faster_whisper' 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Skip 'deps\.venv-asr'; return }
    Write-Host '    venv 存在但 faster_whisper 不可用，重建' -ForegroundColor Yellow
    Move-SemiVenv $venv
  }
  Write-Step 'ASR 环境（deps\.venv-asr + faster-whisper==1.2.1）'
  if ($DryRun) {
    Write-Host "    [dry-run] <系统 Python> -m venv `"$venv`""
    Write-Host "    [dry-run] `"$py`" -m pip install `"faster-whisper==1.2.1`" `"av==15.1.0`" `"ctranslate2==4.8.3`" -i $PyIndex"
    Write-Host '    [dry-run] 检测到 NVIDIA 显卡时会问一句「装 GPU 运行库吗（约 500 MB）」，选是才装 nvidia-cublas-cu12 / nvidia-cudnn-cu12（非交互或 -Gpu no 则跳过）'
    return
  }
  $sysPy = Get-SystemPython
  & $sysPy -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw '创建 venv 失败' }
  Invoke-PipInstall $py @('install', '--upgrade', 'pip')
  Invoke-PipInstall $py @('install', 'faster-whisper==1.2.1', 'av==15.1.0', 'ctranslate2==4.8.3')
  if ($LASTEXITCODE -ne 0) {
    # 本次失败把半成品改名留档（不递归删，避免撞用户的删除守卫）
    Move-SemiVenv $venv
    throw '安装 faster-whisper 失败（半成品 venv 已改名留档，重跑即可重试）'
  }
  # issue #3 第 4 条（2026-10-29）实测：不装 CUDA 12 的 cuBLAS + cuDNN 时，
  #   --device auto 能探到 GPU、模型也能加载，但一转写就报 Library cublas64_12.dll is not found。
  #   有 N 卡就顺手装上（pip 包，约 500 MB，不用装整套 CUDA Toolkit），没有就跳过、继续用 CPU。
  # M-06（2026-10-29）：以前只看 `nvidia-smi -L` 的退出码，三种误判：
  #   ① 驱动装了但 nvidia-smi 不在 PATH（NVIDIA App 新装 / 非默认路径）→ 明明有卡却说没有；
  #   ② 驱动 <525（CUDA 12 最低要求）→ 白下 500 MB，装了也用不了；
  #   ③ 显存 <2 GB（small 模型 float16 约需 1 GB）→ 装了加载即 OOM。
  #   改成查 driver_version + memory.total，不满足就把原因说清楚，别让用户白下。
  $nv = $false
  $nvWhy = ''
  $smiPath = Resolve-NvidiaSmi
  if ($smiPath) {
    try {
      $info = & $smiPath --query-gpu=driver_version,memory.total --format=csv,noheader 2>$null
      if ($LASTEXITCODE -eq 0 -and $info) {
        $first = [string](@($info)[0])
        $parts = $first -split ',\s*'
        $drv = [string]$parts[0]
        $memMb = 0
        if ($parts.Count -gt 1 -and ($parts[1] -match '(\d+)')) { $memMb = [int]$matches[1] }
        $drvNum = 0
        if ($drv -match '^(\d+)\.') { $drvNum = [int]$matches[1] }
        if ($drvNum -gt 0 -and $drvNum -lt 525) {
          $nvWhy = "驱动 $drv 太旧（CUDA 12 要 525+），装了运行库也用不了"
        } elseif ($memMb -gt 0 -and $memMb -lt 2048) {
          $nvWhy = "显存 $memMb MB 太小（small 模型约需 1 GB），装了容易 OOM"
        } else {
          $nv = $true
        }
      } else {
        $nvWhy = 'nvidia-smi 查询失败（驱动异常）'
      }
    } catch {
      $nvWhy = "nvidia-smi 查询异常：$($_.Exception.Message)"
    }
  } else {
    $nvWhy = '没找到 nvidia-smi（未装 NVIDIA 驱动，或不是 NVIDIA 卡）'
  }
  if (-not $nv -and $nvWhy) { Write-Host "    不装 GPU 运行库：$nvWhy" -ForegroundColor DarkGray }
  $wantGpu = $false
  if ($nv) {
    if ($Gpu -eq 'yes') {
      $wantGpu = $true
    } elseif ($Gpu -eq 'no') {
      $wantGpu = $false
    } elseif ($script:InAll) {
      # 第十条：all 不问、不装（要装请 -Target cuda / -Gpu yes）
      $wantGpu = $false
      Write-Host '    (all) 跳过 GPU 运行库（约 500 MB）；要装请单独跑 -Target cuda' -ForegroundColor DarkGray
    } elseif ([Console]::IsInputRedirected) {
      # 无人值守（脚本里被调）时不要卡在 Read-Host 上，按「不装」处理
      $wantGpu = $false
      Write-Host '    检测到 NVIDIA 显卡；非交互环境跳过 GPU 运行库（要装请传 -Gpu yes）' -ForegroundColor DarkGray
    } else {
      Write-Host '    检测到 NVIDIA 显卡。要不要装 CUDA 运行库（cuBLAS + cuDNN，约 500 MB）？' -ForegroundColor Cyan
      Write-Host '      装了：ASR 用 GPU 转写，比 CPU 快 2-8 倍；不装：ASR 走 CPU，功能一样但慢些。' -ForegroundColor DarkGray
      $ans = Read-Host '    装 GPU 运行库？[y/N]'
      $wantGpu = ($ans -match '^(y|yes|是)$')
    }
  }
  if ($wantGpu) {
    Write-Host '    检测到 NVIDIA 显卡，补装 CUDA 12 运行库（cuBLAS + cuDNN，约 500 MB）…'
    Install-CudaLibs -Py $py
  } elseif ($nv) {
    Write-Host '    按你的选择不装 GPU 运行库，ASR 走 CPU' -ForegroundColor DarkGray
  } else {
    Write-Host '    未检测到 NVIDIA 显卡，跳过 GPU 运行库（ASR 用 CPU）' -ForegroundColor DarkGray
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
    Move-SemiVenv $venv
  }
  Write-Step 'OCR 环境（deps\.venv-ocr + rapidocr-onnxruntime==1.2.3）'
  if ($DryRun) {
    Write-Host "    [dry-run] <系统 Python> -m venv `"$venv`""
    Write-Host "    [dry-run] `"$py`" -m pip install `"rapidocr-onnxruntime==1.2.3`" -i $PyIndex"
    return
  }
  $sysPy = Get-SystemPython
  & $sysPy -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw '创建 venv 失败' }
  Invoke-PipInstall $py @('install', '--upgrade', 'pip')
  Invoke-PipInstall $py @('install', 'rapidocr-onnxruntime==1.2.3')
  if ($LASTEXITCODE -ne 0) {
    Move-SemiVenv $venv
    throw '安装 rapidocr-onnxruntime 失败（半成品 venv 已改名留档，重跑即可重试）'
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

# 二进制不锁版本，但记录实际装到的版本：ffmpeg -version 首行 + yt-dlp --version。
# 2026-10-26 收口（DSH 拍板拆文件）：只写 deps\last-bin.json（装包版本快照），不碰 deps\last-run.json
# （运行排障记录，只由 index.js 写）。两个文件互不 read-modify-write 对方。
function Record-BinaryVersions {
  if ($DryRun) {
    Write-Host "    [dry-run] 记录 ffmpeg -version 首行 与 yt-dlp --version 到 deps\last-bin.json"
    return
  }
  $record = [ordered]@{
    ffmpeg    = '<未获取>'
    ytDlp     = '<未获取>'
    at        = (Get-Date).ToString('o')
  }
  $ff = Join-Path $Deps 'ffmpeg.exe'
  if (Test-Path -LiteralPath $ff) {
    try { $v = (& $ff -version 2>&1 | Select-Object -First 1) } catch { $v = '<获取失败>' }
    $record['ffmpeg'] = "$v"
  }
  $yt = Join-Path $Deps 'yt-dlp.exe'
  if (Test-Path -LiteralPath $yt) {
    try { $v = (& $yt --version 2>&1 | Select-Object -First 1) } catch { $v = '<获取失败>' }
    $record['ytDlp'] = "$v"
  }
  $out = Join-Path $Deps 'last-bin.json'
  $json = $record | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding($false)))
  Write-Host "    ✓ 二进制版本记录 -> $out"
}

# 第十条：all 模式下不弹「装 GPU 运行库吗」——批量安装不该卡在交互上，也不该悄悄拉 500 MB。
#   要装 GPU 运行库请显式 -Target cuda（或 -Gpu yes）。
$script:InAll = ($Target -eq 'all')

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
  'cuda' { @('cuda') }
  # 第十条：all 不自动带 cuda——保持「不问、不装 500 MB」的语义，要装请 -Target cuda
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
    'cuda' { Run-One 'cuda' { Install-CudaLibs } }
  }
}

Write-Host ''
if ($failed -gt 0) {
  Write-Warning "有 $failed 项失败，看上面每项的原因；已完成的项不受影响。"
  exit 1
}
Record-BinaryVersions
Write-Host '完成。验证：node --check tools/look.mjs 与 node tools/look.mjs view <BV号>' -ForegroundColor Green
