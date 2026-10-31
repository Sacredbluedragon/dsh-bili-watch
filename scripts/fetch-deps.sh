#!/usr/bin/env bash
# fetch-deps.sh —— dsh-bili-watch 可选依赖一键下载（Linux / macOS）
#
# 用法：
#   bash scripts/fetch-deps.sh all
#   bash scripts/fetch-deps.sh ytdlp
#   BILI_WATCH_MIRROR=cn bash scripts/fetch-deps.sh all   # 国内网络
#
# 目标：
#   ffmpeg  Linux 下下静态包到 deps/（macOS 只提示 brew install）
#   ytdlp   → deps/yt-dlp（macOS 用 yt-dlp_macos）
#   asr     建 deps/.venv-asr 并装 faster-whisper（需 python3.10+）
#   ocr     建 deps/.venv-ocr 并装 rapidocr-onnxruntime
#   model   预下载 faster-whisper-small 到 deps/.hf-home（约 464 MB）
#   cuda    往 ASR 环境里装 GPU 运行库（可选，Linux 展开约 2.2 GB）
#   all     依次执行以上
#   where   只打印 deps 目录装在哪（不下载、不建目录）
#
# deps 目录装在哪：BILI_WATCH_DEPS > $DSH_HOME/bili-watch/deps > 插件包内 deps（与 .ps1 同一套）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# issue #6 坑 1（2026-10-31）：原来写死 DEPS="$ROOT/deps"（包内），而插件运行时读的是包外
#   （$DSH_HOME/bili-watch/deps，见 index.js 的 depsDir 解析）。插件启动过一次、包外目录已存在
#   之后，一键脚本就把 yt-dlp 下到包内，面板永远显示「不可用」。
#   这里对齐**运行时**（index.js:178-189）的同一套三级顺序，判据逐条相同：
#     BILI_WATCH_DEPS  >  包外（$DSH_HOME/bili-watch/deps）  >  包内（$ROOT/deps）
#   第二级带一个例外：包外不存在、包内**已有内容**时仍用包内，
#   免得「装到空目录、看不到已有 venv」重复下 460 MB 模型。
#   注意「有内容」不等于「存在」——空目录不算，见下面的注释。
DEPS_LOCAL="$ROOT/deps"
TARGET="${1:-all}"
if [ -n "${BILI_WATCH_DEPS:-}" ]; then
  DEPS="$BILI_WATCH_DEPS"
  DEPS_FROM="BILI_WATCH_DEPS"
else
  DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
  DEPS_OUTSIDE="$DSH_HOME_DIR/bili-watch/deps"
  # 判据必须与**运行时**逐条相同（index.js:178-189），不是「与 .ps1 相同」——
  #   .ps1 用 Test-Path 判「存在」，index.js 用 readdirSync().length > 0 判「有内容」。
  #   两者在「包内 deps 是空目录」时分叉：index.js 会用包外（还顺手 mkdir 出来），
  #   只看存在的话脚本会装进包内空目录 → 运行时读包外 → 面板「不可用」，坑 1 原样复发。
  if [ -d "$DEPS_OUTSIDE" ]; then
    DEPS="$DEPS_OUTSIDE"
    DEPS_FROM="包外（\$DSH_HOME/bili-watch/deps，已存在）"
  elif [ -d "$DEPS_LOCAL" ] && [ -n "$(ls -A "$DEPS_LOCAL" 2>/dev/null || true)" ]; then
    DEPS="$DEPS_LOCAL"
    DEPS_FROM="包内（插件目录下的 deps 已有内容，包外还没有）"
  else
    DEPS="$DEPS_OUTSIDE"
    DEPS_FROM="包外（\$DSH_HOME/bili-watch/deps，新建）"
  fi
fi
# 用户排障时要能看出装到哪去了，所以这一行固定打 stderr（stdout 留给进度，JSON 调用方不受影响）
echo "==> deps 目录：$DEPS（来源：$DEPS_FROM）" >&2
# where：只回答「装到哪」，不建目录、不下载。
#   必须在 mkdir 之前返回 —— 顺手建一个空的包外目录，会让「包内 deps 已有内容」的机器
#   下次改用那个空目录（第 41 行判的是「存在」），等于把已有 venv 和模型丢掉。
if [ "$TARGET" = "where" ]; then
  printf '%s\n' "$DEPS"
  exit 0
fi
mkdir -p "$DEPS"
MIRROR="${BILI_WATCH_MIRROR:-}"

if [ "$MIRROR" = "cn" ]; then
  GH="https://gh-proxy.com/https://github.com"
  PY_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
  HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
else
  GH="https://github.com"
  PY_INDEX="https://pypi.org/simple"
  HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"
fi

fetch_ytdlp() {
  if [ -x "$DEPS/yt-dlp" ]; then echo "==> yt-dlp（已存在，跳过）"; return; fi
  echo "==> yt-dlp"
  case "$(uname -s)" in
    Darwin) url="$GH/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" ;;
    *)      url="$GH/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" ;;
  esac
  curl -L --fail --retry 3 --connect-timeout 20 -o "$DEPS/yt-dlp" "$url"
  chmod +x "$DEPS/yt-dlp"
  echo "    ✓ $DEPS/yt-dlp"
}

# issue #6 坑 2（2026-10-31）：原来这里只打印「请用系统包管理器安装」，WSL / 容器 / 无 sudo
#   场景直接死路，面板 ffmpeg 那行永远不可用。现在 Linux 下真下静态包（johnvansickle，
#   约 40 MB，解出 ffmpeg + ffprobe 落到 DEPS，与 Windows 分支行为对齐）。
#   两条硬要求：
#     · 解压前必须 `tar -t` 预校验 —— 镜像/代理返回 HTML 错误页时 curl 可能照样 exit 0，
#       直接解压会得到一堆垃圾或半截目录；
#     · 校验失败要说清「拿到了什么」（前 200 字节），别只说「下载失败」。
fetch_ffmpeg() {
  if [ -x "$DEPS/ffmpeg" ] && [ -x "$DEPS/ffprobe" ]; then
    echo "==> ffmpeg（已存在，跳过）"
    return 0
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "==> ffmpeg：macOS 请用系统包管理器安装"
    echo "    brew install ffmpeg"
    echo "    装好后 look.mjs 会从 PATH 找到它（也可以自己放到 $DEPS/ffmpeg）。"
    return 0
  fi
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *)
      echo "✗ 静态包只提供 amd64 / arm64，本机是 $(uname -m)" >&2
      echo "  请用系统包管理器装：Debian/Ubuntu: sudo apt install ffmpeg" >&2
      return 1
      ;;
  esac
  local url="${BILI_WATCH_FFMPEG_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$arch-static.tar.xz}"
  local tmp
  tmp="$(mktemp -d)"
  local tgz="$tmp/ffmpeg.tar.xz"
  echo "==> ffmpeg（静态包，约 40 MB）：$url"
  if ! curl -L --fail --retry 3 --connect-timeout 20 -o "$tgz" "$url"; then
    rm -rf "$tmp"
    echo "✗ 下载 ffmpeg 失败：$url" >&2
    echo "  离线/被墙可换源：BILI_WATCH_FFMPEG_URL=<镜像地址> bash scripts/fetch-deps.sh ffmpeg" >&2
    echo "  或直接用系统包管理器：sudo apt install ffmpeg（Debian/Ubuntu）" >&2
    return 1
  fi
  # tar -t 预校验：镜像/代理返回 HTML 错误页时 curl 可能照样 exit 0，
  #   直接解压会得到一堆垃圾。这里把 stderr 分开收，好区分两种失败：
  #     · 归档本身不对（HTML / 截断）→ 打印前 200 字节，让人看出拿到了什么
  #     · 系统 tar 根本解不了 xz（缺 xz-utils）→ 那是环境问题，不该诬赖下载物
  local list listerr
  listerr="$(tar -tJf "$tgz" 2>&1 >"$tmp/list.txt" || true)"
  list="$(cat "$tmp/list.txt" 2>/dev/null || true)"
  if [ -z "$list" ]; then
    case "$listerr" in
      *"xz"*"not found"*|*"Cannot exec"*|*"xz: "*)
        echo "✗ 本机 tar 解不了 .tar.xz（缺 xz 解压器），不是下载的问题" >&2
        echo "  先装：sudo apt install xz-utils（Debian/Ubuntu） / sudo dnf install xz（Fedora）" >&2
        ;;
      *)
        echo "✗ 下载到的不是有效的 .tar.xz（xz 解不开或不是 tar 归档）。前 200 字节：" >&2
        head -c 200 "$tgz" | tr -c '[:print:]\n' '.' >&2
        echo >&2
        ;;
    esac
    rm -rf "$tmp"
    return 1
  fi
  local need miss=""
  # 2026-11-01 P2：原来写 `printf '%s\n' "$list" | grep -Eq "(^|/)$need$" || miss=…`。
  #   `grep -q` 一命中就退出，而上游 printf 还在往管道里灌（静态包清单有几千行）→
  #   printf 吃 SIGPIPE，pipefail 把整条管道判成 141，`||` 于是把 miss 写上 ——
  #   明明是官方静态包，脚本却报「归档里没有 ffmpeg ffprobe」并 exit 1。
  #   本机实测（6000 项清单、ffmpeg/ffprobe 在前两行）：命中时老写法 rc=141、新写法 rc=0。
  #   改成 here-string：grep 直接从字符串读，没有上游进程，就不存在 SIGPIPE；
  #   `$?` 只反映 grep 自己的 0/1，判据（逐行匹配 `(^|/)name$`）与原来完全一致。
  for need in ffmpeg ffprobe; do
    if ! grep -qE "(^|/)$need$" <<< "$list"; then
      miss="$miss $need"
    fi
  done
  if [ -n "$miss" ]; then
    echo "✗ 归档里没有$miss（下到的可能不是官方静态包）。归档前 10 项：" >&2
    # 别写 `| head -10`：head 读够 10 行就退出，printf 收到 SIGPIPE（141），
    #   而本脚本开着 `set -o pipefail` —— 于是在「正要解释失败原因」的这一刻
    #   整个脚本静默中止，用户只看到一个 141，连这句提示都看不到。
    #   sed 会读完整条流，不会提前退出，也就不会 SIGPIPE。
    printf '%s\n' "$list" | sed -n '1,10p' >&2
    rm -rf "$tmp"
    return 1
  fi
  if ! tar -xJf "$tgz" -C "$tmp"; then
    echo "✗ 解压失败（磁盘满？）" >&2
    rm -rf "$tmp"
    return 1
  fi
  local found src all
  # 躲开 `| head -1`：正常归档里 `-name ffmpeg` 只命中一个，但归档若带了多个版本目录
  #   就会有多个命中，find 写满管道缓冲后收到 SIGPIPE（141），pipefail 下直接静默中止。
  #   先整份收进变量再取第一行，find 不会被提前关管道（这条是结构性预防，未真复现过）。
  all="$(find "$tmp" -maxdepth 3 -type f -name ffmpeg 2>/dev/null || true)"
  found="${all%%$'\n'*}"
  if [ -z "$found" ]; then
    echo "✗ 解压后没找到 ffmpeg 可执行文件（归档结构变了？）" >&2
    rm -rf "$tmp"
    return 1
  fi
  src="$(dirname "$found")"
  if ! cp -f "$src/ffmpeg" "$DEPS/ffmpeg" || ! cp -f "$src/ffprobe" "$DEPS/ffprobe"; then
    echo "✗ 从 $src 复制失败（ffmpeg 与 ffprobe 可能不在同一层目录）" >&2
    rm -rf "$tmp"
    return 1
  fi
  chmod +x "$DEPS/ffmpeg" "$DEPS/ffprobe"
  rm -rf "$tmp"
  # E1-01 同族：脚本说「成功」必须由产物证明，不能由 cp 的退出码推导。
  #   静态包理论上能跑，但被安全策略拦、架构不对、或解出半截文件时，文件在、跑不起来——
  #   这时脚本打「✓ 已安装」，而运行时（look.mjs 的 resolveFfmpeg 会真试跑 -version）
  #   判定「没装 ffmpeg」，两边又对不上。所以这里真跑一次，跑不起来就当失败。
  #   别用 `| head -1`：pipefail 下 head 提前退出会让 ffmpeg 收到 SIGPIPE（141）。
  # 2026-11-01 P2：原来写 `ver="$("$DEPS/ffmpeg" -version 2>&1 | sed -n '1p' || true)"`，
  #   两个漏洞叠在一起，等于把「真跑验证」整个击穿：
  #     ① `2>&1` 把 stderr 并进 stdout —— 跑不起来的 ffmpeg 往 stderr 打一句
  #        "error while loading shared libraries" 也算「有输出」，于是被判成成功；
  #     ② `|| true` 把 ffmpeg 的退出码彻底抹掉，`$?` 只剩 sed 的。
  #   本机实测（假 ffmpeg：往 stderr 打一行错误 + exit 127）：老写法打印 ✓ 成功。
  #   现在退出码只认 ffmpeg 自己的（不套管道、不吞 rc），stderr 一律丢弃 ——
  #   stderr 上说什么都不能证明「跑得起来」，唯一证据是 rc=0。
  local out rc=0
  out="$("$DEPS/ffmpeg" -version 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "✗ 文件已放到 $DEPS/ffmpeg，但 ffmpeg -version 跑不起来（rc=$rc：被安全策略拦 / 架构不对 / 文件不完整）" >&2
    # 「装上了但跑不起来」和「没装上」是两件事：后者重跑本脚本即可，前者重跑一万次也一样。
    echo "  这不是「没装上」：文件在，但系统不让它执行。查 mount 的 noexec、SELinux、架构是否对得上。" >&2
    echo "  改用系统包管理器：sudo apt install ffmpeg（Debian/Ubuntu）" >&2
    return 1
  fi
  local ver="${out%%$'\n'*}"
  # rc=0 才算成功；横幅为空只是展示信息不全，不再当失败判据（原来「输出为空=失败」正是被
  #   stderr 混入反向利用的地方）。
  [ -n "$ver" ] || ver="（未打出横幅，但退出码为 0）"
  echo "    ✓ $DEPS/ffmpeg（$ver）"
}

# issue #5（2026-10-31）：面板「GPU 运行库」那行有个「一键下载」按钮，它把行 id 直接当
#   target 传给后端，而这里原来没有 cuda 分支 —— 于是 Linux 上点按钮得到
#   「不支持的依赖：cuda」，README 又说「点那一行的下载」，等于给了条死路。
#   这里补齐，与 ps1 的 -Target cuda 对齐：装三个 wheel，装完真跑一次探测。
#   Linux 版比 Windows 大得多（展开约 2.2 GB），装之前先看磁盘。
fetch_cuda() {
  local asr="$DEPS/.venv-asr/bin/python"
  if [ ! -x "$asr" ]; then
    echo "✗ 还没装 ASR 环境：GPU 运行库要装进 .venv-asr，先跑 bash scripts/fetch-deps.sh asr" >&2
    return 1
  fi
  echo "==> GPU 运行库（cuBLAS + cuDNN + nvrtc，Linux 展开约 2.2 GB）"
  if ! "$asr" -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-nvrtc-cu12 -i "$PY_INDEX"; then
    echo "✗ 装 GPU 运行库失败。ASR 仍可走 CPU，功能不受影响" >&2
    return 1
  fi
  # 与面板 /status 同一口径：不看 pip 包名，真跑一次 --probe-gpu（它内部先预载 nvidia/*/lib）。
  #   脚本本身不在时要单独说 —— 否则会打成「运行库装了但探测没通过」，把「缺文件」
  #   误导成「驱动/CUDA 不匹配」，用户照着去查驱动，查不出东西。
  if [ ! -f "$DEPS/_bili-asr.py" ]; then
    echo "    ! 找不到 $DEPS/_bili-asr.py，没法自检运行库。ASR 转写时会自己加载，跑一次就知道" >&2
    return 0
  fi
  if "$asr" "$DEPS/_bili-asr.py" --probe-gpu; then
    echo "    ✓ libcublas.so.12 能加载且看得到 CUDA 卡：ASR 会走 GPU（显存不足自动回落 CPU）"
  else
    echo "    ! 运行库装了但探测没通过（缺驱动 / 卡不可见 / CUDA 版本不匹配）；ASR 继续用 CPU" >&2
  fi
}

# 用法：ensure_venv <venv 目录> <用来探活的模块名> <包1> [包2 ...]
#   包必须带版本约束。2026-10-31（issue #6 坑 4）：faster-whisper 1.2.1 的 audio.py:46
#   无条件传 av.open(metadata_errors=...)，而 PyAV 19 删了这个参数（TypeError），
#   所以裸 `pip install faster-whisper` 拉到 av 19 就必炸。Windows 侧 fetch-deps.ps1
#   早就钉死了这三个版本，这里原来只传包名不锁版本，是两条脚本不一致。
# issue #6 坑 3（2026-10-31）：Ubuntu 26.04 的 python3.14 不带 ensurepip，`python3 -m venv`
#   直接失败（"ensurepip is not available"），asr / ocr / 模型三项连带全挂。
#   做法：先按常规建（有 ensurepip 的系统走原路，不多一次网络请求）；失败再
#   `--without-pip` 建环境 + get-pip.py 引导。
#   引导也失败时**不留半成品 venv**，并且直接说清该手工装什么 —— 留一个没 pip 的 venv
#   只会让人以为装好了，下一步 look.mjs 报「模块不可用」又看不出根因。
bootstrap_pip() {
  local py="$1"
  if "$py" -m pip --version >/dev/null 2>&1; then return 0; fi
  # venv 没带 pip、但 ensurepip 模块在的系统（部分发行版把它拆成单独包）
  if "$py" -m ensurepip --upgrade >/dev/null 2>&1 && "$py" -m pip --version >/dev/null 2>&1; then
    return 0
  fi
  local gp="$DEPS/.get-pip.py"
  if ! curl -L --fail --retry 3 --connect-timeout 20 -o "$gp" https://bootstrap.pypa.io/get-pip.py; then
    rm -f "$gp"
    echo "✗ 取不到 get-pip.py（离线/被墙，或 $DEPS 不可写），而本机 python3 没有 ensurepip，装不上 pip" >&2
    echo "  手工装好后重跑本脚本：" >&2
    echo "    Debian/Ubuntu: sudo apt install python3-pip python3-venv" >&2
    echo "    Fedora/RHEL:   sudo dnf install python3-pip" >&2
    echo "    macOS:         brew install python" >&2
    # 别写成「设 BILI_WATCH_MIRROR=cn 重试」——那个镜像只作用于 pip install，
    #   get-pip.py 本身必须能访问 bootstrap.pypa.io，写出来等于给一个没用的建议。
    echo "  公司网络/代理下：先 export HTTPS_PROXY=http://host:port 再重跑" >&2
    return 1
  fi
  local out
  if ! out="$("$py" "$gp" 2>&1)"; then
    printf '%s\n' "$out" | tail -5 | sed 's/^/    /' >&2
    rm -f "$gp"
    echo "✗ get-pip.py 执行失败（上面是最后 5 行）" >&2
    return 1
  fi
  rm -f "$gp"
  "$py" -m pip --version >/dev/null 2>&1
}

ensure_venv() {
  local dir="$1" mod="$2"; shift 2
  local pkgs=("$@")
  if [ -x "$dir/bin/python" ]; then
    # 半成品陷阱：venv 在、包没装成时只看目录会永远跳过
    if "$dir/bin/python" -c "import $mod" 2>/dev/null; then
      echo "==> $(basename "$dir")（已存在，跳过）"; return
    fi
    echo "    venv 存在但 $mod 不可用，重建"
    rm -rf "$dir"
  fi
  command -v python3 >/dev/null 2>&1 || { echo "✗ 找不到 python3：先装 Python 3.10+（macOS: brew install python）" >&2; return 1; }
  echo "==> $(basename "$dir")：python3 -m venv + pip install ${pkgs[*]}"
  local venvout
  if ! venvout="$(python3 -m venv "$dir" 2>&1)"; then
    rm -rf "$dir"
    echo "    python3 -m venv 失败，改用 --without-pip + get-pip 引导"
    printf '%s\n' "$venvout" | tail -3 | sed 's/^/    /' >&2
    if ! python3 -m venv --without-pip "$dir"; then
      rm -rf "$dir"
      echo "✗ 连 --without-pip 也建不起来。先装 venv 支持：" >&2
      echo "    Debian/Ubuntu: sudo apt install python3-venv" >&2
      return 1
    fi
  fi
  if ! bootstrap_pip "$dir/bin/python"; then
    rm -rf "$dir"
    echo "✗ 环境建好了但装不上 pip，已删除半成品（重跑本脚本即可重试）" >&2
    return 1
  fi
  "$dir/bin/python" -m pip install --upgrade pip -i "$PY_INDEX" >/dev/null
  if ! "$dir/bin/python" -m pip install "${pkgs[@]}" -i "$PY_INDEX"; then
    rm -rf "$dir"
    echo "✗ 安装 ${pkgs[*]} 失败（已删除半成品 venv，重跑即可重试）" >&2
    return 1
  fi
  echo "    ✓ $dir/bin/python"
}

fetch_model() {
  local asr="$DEPS/.venv-asr/bin/python"
  if [ -d "$DEPS/.hf-home/hub" ]; then echo "==> 模型（已存在，跳过）"; return; fi
  if [ ! -x "$asr" ]; then echo "==> 模型：先跑 asr" >&2; return 1; fi
  echo "==> faster-whisper-small（约 464 MB）"
  HF_HOME="$DEPS/.hf-home" HF_ENDPOINT="$HF_ENDPOINT" HF_HUB_DISABLE_XET=1 \
    "$asr" -c "from huggingface_hub import snapshot_download; print(snapshot_download('Systran/faster-whisper-small'))"
}

case "$TARGET" in
  ffmpeg) fetch_ffmpeg ;;
  ytdlp)  fetch_ytdlp ;;
  asr)    ensure_venv "$DEPS/.venv-asr" faster_whisper "faster-whisper==1.2.1" "av==15.1.0" "ctranslate2==4.8.3" ;;
  ocr)    ensure_venv "$DEPS/.venv-ocr" rapidocr_onnxruntime "rapidocr-onnxruntime==1.2.3" ;;
  model)  fetch_model ;;
  cuda)   fetch_cuda ;;
  all)
    FAILED=0
    run() { "$@" || { echo "「$*」失败，继续下一项" >&2; FAILED=1; }; }
    run fetch_ffmpeg
    run fetch_ytdlp
    run ensure_venv "$DEPS/.venv-asr" faster_whisper "faster-whisper==1.2.1" "av==15.1.0" "ctranslate2==4.8.3"
    run ensure_venv "$DEPS/.venv-ocr" rapidocr_onnxruntime "rapidocr-onnxruntime==1.2.3"
    run fetch_model
    [ "$FAILED" -eq 0 ] || exit 1
    ;;
  *)
    echo "用法：bash scripts/fetch-deps.sh <all|ffmpeg|ytdlp|asr|ocr|model|cuda|where>" >&2
    echo "      where：只打印 deps 目录装在哪（不下载、不建目录）" >&2
    exit 2
    ;;
esac

echo "完成。验证：node tools/look.mjs view <BV号>"
