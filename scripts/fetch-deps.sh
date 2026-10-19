#!/usr/bin/env bash
# fetch-deps.sh —— dsh-bili-watch 可选依赖一键下载（Linux / macOS）
#
# 用法：
#   bash scripts/fetch-deps.sh all
#   bash scripts/fetch-deps.sh ytdlp
#   BILI_LOOK_MIRROR=cn bash scripts/fetch-deps.sh all   # 国内网络
#
# 目标：
#   ffmpeg  只提示用系统包管理器安装（脚本不下载）
#   ytdlp   → deps/yt-dlp（macOS 用 yt-dlp_macos）
#   asr     建 deps/.venv-asr 并装 faster-whisper（需 python3.10+）
#   ocr     建 deps/.venv-ocr 并装 rapidocr-onnxruntime
#   model   预下载 faster-whisper-small 到 deps/.hf-home（约 464 MB）
#   all     依次执行以上
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/deps"
mkdir -p "$DEPS"
TARGET="${1:-all}"
MIRROR="${BILI_LOOK_MIRROR:-}"

if [ "$MIRROR" = "cn" ]; then
  GH="https://gh-proxy.com/https://github.com"
  PY_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
  HF_ENDPOINT="https://hf-mirror.com"
else
  GH="https://github.com"
  PY_INDEX="https://pypi.org/simple"
  HF_ENDPOINT="https://huggingface.co"
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

fetch_ffmpeg() {
  echo "==> ffmpeg：请用系统包管理器安装"
  echo "    macOS: brew install ffmpeg ；Debian/Ubuntu: sudo apt install ffmpeg"
  echo "    装好后 look.mjs 会从 PATH 找到它。"
}

ensure_venv() {
  local dir="$1" pkg="$2" mod="$3"
  if [ -x "$dir/bin/python" ]; then
    # 半成品陷阱：venv 在、包没装成时只看目录会永远跳过
    if "$dir/bin/python" -c "import $mod" 2>/dev/null; then
      echo "==> $(basename "$dir")（已存在，跳过）"; return
    fi
    echo "    venv 存在但 $mod 不可用，重建"
    rm -rf "$dir"
  fi
  command -v python3 >/dev/null 2>&1 || { echo "✗ 找不到 python3：先装 Python 3.10+（macOS: brew install python）" >&2; return 1; }
  echo "==> $(basename "$dir")：python3 -m venv + pip install $pkg"
  python3 -m venv "$dir" || { rm -rf "$dir"; echo "✗ 创建 venv 失败" >&2; return 1; }
  "$dir/bin/python" -m pip install --upgrade pip -i "$PY_INDEX" >/dev/null
  if ! "$dir/bin/python" -m pip install "$pkg" -i "$PY_INDEX"; then
    rm -rf "$dir"
    echo "✗ 安装 $pkg 失败（已删除半成品 venv，重跑即可重试）" >&2
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
  asr)    ensure_venv "$DEPS/.venv-asr" faster-whisper faster_whisper ;;
  ocr)    ensure_venv "$DEPS/.venv-ocr" rapidocr-onnxruntime rapidocr_onnxruntime ;;
  model)  fetch_model ;;
  all)
    FAILED=0
    run() { "$@" || { echo "「$*」失败，继续下一项" >&2; FAILED=1; }; }
    run fetch_ffmpeg
    run fetch_ytdlp
    run ensure_venv "$DEPS/.venv-asr" faster-whisper faster_whisper
    run ensure_venv "$DEPS/.venv-ocr" rapidocr-onnxruntime rapidocr_onnxruntime
    run fetch_model
    [ "$FAILED" -eq 0 ] || exit 1
    ;;
  *)
    echo "用法：bash scripts/fetch-deps.sh <all|ffmpeg|ytdlp|asr|ocr|model>" >&2
    exit 2
    ;;
esac

echo "完成。验证：node tools/look.mjs view <BV号>"
