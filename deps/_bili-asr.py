#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
_bili-asr.py —— 把本地音频/视频文件转成文字（faster-whisper，CPU int8）

为什么单独有这个文件：
  B 站很多新视频没有 AI 字幕轨（刚发布几小时还没转写完，或者 UP 没开），
  只靠 B 站字幕会把一大半候选判成「不可信」。本地转写能补上这一块。

口径：
  · 默认 CPU + int8；有可用 GPU 时可以 --device cuda（自动探测，失败回落 CPU，不会炸）。
    GPU 要真跑起来还得有 CUDA 12 的 cuBLAS + cuDNN：要么系统装了 CUDA 12 运行时，
    要么在虚拟环境里 pip install nvidia-cublas-cu12 nvidia-cudnn-cu12（本脚本会自动把它们的 bin 加进 DLL 搜索路径）。
  · 模型默认 small（约 250 MB，一个 3 分钟视频约 30–45 秒）；可 --model 换 base/tiny。
  · 模型与缓存落 D 盘项目目录（HF_HOME），不碰用户主目录。
  · 音频由调用方先转成 16 kHz 单声道 wav 再传进来——这里不碰网络、不碰 B 站接口。

用法：
  .venv-asr\\Scripts\\python.exe _bili-asr.py <音频或视频文件> [-o 输出.txt] [--model small] [--lang zh]
  不给 -o 就往 stdout 打正文（调用方直接取 stdout 更省事）。
"""
import argparse
import json
import os
import sys

# ⭐ 必须在 import faster_whisper 之前设好，否则它会先按默认去连 HuggingFace
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("HF_HOME", os.path.join(_HERE, ".hf-home"))
# 国内直连 huggingface.co 基本下不动，默认走镜像；已经能直连的可以自己改回
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# ⭐ 必须关掉 Xet：新版本 huggingface_hub 默认走 cas-server.xethub.hf.co，
#   镜像站不代理那条重建接口，会报 CAS Client Error: 401 Unauthorized（2026-10-17 实测）。
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# 避免 OpenMP 在多核上抢线程把机器拖死
os.environ.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 4) // 2)))


def _add_nvidia_dll_dirs() -> None:
    """Windows 上把 pip 装的 nvidia-*-cu12 的 bin 目录加进 DLL 搜索路径。

    为什么要这一步：ctranslate2 在 Windows 上靠系统 PATH 找 cublas64_12.dll / cudnn64_9.dll。
    用户按 issue #3 的做法 pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 之后，
    DLL 躺在本环境的 site-packages/nvidia/<lib>/bin 里，不主动加路径就还是找不到。
    """
    if os.name != "nt":
        return
    try:
        import sysconfig
        site = sysconfig.get_paths().get("purelib") or ""
    except Exception:  # noqa: BLE001
        return
    if not site:
        return
    import glob
    for d in sorted(glob.glob(os.path.join(site, "nvidia", "*", "bin"))):
        if not os.path.isdir(d):
            continue
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
        try:
            os.add_dll_directory(d)  # Python 3.8+：显式 DLL 目录，比只改 PATH 可靠
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="音频或视频文件路径")
    ap.add_argument("-o", "--out", help="输出文本文件；不给就打印到 stdout")
    ap.add_argument("--model", default=os.environ.get("BILI_ASR_MODEL", "small"),
                    help="Whisper 模型：tiny / base / small / medium（默认 small）")
    ap.add_argument("--lang", default="zh", help="语言，默认 zh（自动识别可传 auto）")
    ap.add_argument("--json", action="store_true",
                    help="输出 JSON（正文 + 分段 + VAD 统计），供调用方做转写可信度判定")
    ap.add_argument("--device", default=os.environ.get("BILI_ASR_DEVICE", "auto"),
                    help="推理设备：auto / cpu / cuda（默认 auto：有可用 CUDA 就用，失败回落 CPU）")
    args = ap.parse_args()

    _add_nvidia_dll_dirs()

    if not os.path.isfile(args.src):
        print("[asr] 找不到文件：" + args.src, file=sys.stderr)
        return 2

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        print("[asr] 导入 faster_whisper 失败：%s" % e, file=sys.stderr)
        return 3

    # 设备：auto 时探 CUDA（ctranslate2 自带探测，不额外依赖 torch）
    want = (args.device or "auto").strip().lower()
    if want not in ("auto", "cpu", "cuda"):
        want = "auto"
    if want == "auto":
        try:
            import ctranslate2  # noqa: F401
            want = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # noqa: BLE001
            want = "cpu"

    print("[asr] 加载模型 %s（设备 %s，首次会下载，之后本地读）…" % (args.model, want), file=sys.stderr)
    model = None
    if want == "cuda":
        try:
            model = WhisperModel(args.model, device="cuda", compute_type="float16")
            print("[asr] 已启用 GPU（float16）", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            # 显存不足 / cuDNN 缺失 / 驱动太旧，都可能在这里炸——回落 CPU 继续跑，别让整条链断掉
            print("[asr] GPU 初始化失败，回落 CPU：%s" % e, file=sys.stderr)
            want = "cpu"
    if model is None:
        try:
            model = WhisperModel(args.model, device="cpu", compute_type="int8")
        except Exception as e:  # noqa: BLE001
            print("[asr] 加载模型失败：%s" % e, file=sys.stderr)
            return 4

    print("[asr] 开始转写…", file=sys.stderr)

    # ⭐ 先自己解码一次 + 量 VAD 语音时长，用来区分两种「空转写」（2026-10-17 实测踩到）：
    #   · 纯 BGM 骑车视频，音频很响（mean -14.4 dB）但没人说话 → 语音时长≈0，空是内容结果；
    #   · 转写环境坏了（模型没加载/依赖缺/静音检测误杀）→ 明明有语音段却零字。
    # 只看「有没有音频/时长多少」判不出来，必须看 VAD 到底找到了多少「像人说话」的片段。
    speech_sec = 0.0
    audio = None
    vad_ok = False
    try:
        import numpy as np  # noqa: F401
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        audio = decode_audio(args.src, sampling_rate=16000)
        stamps = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=400))
        speech_sec = sum(float(s["end"]) - float(s["start"]) for s in stamps) / 16000.0
        vad_ok = True
        print("[asr] VAD 语音段 %d 个，共 %.1f 秒" % (len(stamps), speech_sec), file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        # 量不出来不影响转写本身，但调用方会少一条判据，必须显式标出来（不能静默）
        print("[asr] VAD 不可用：预检失败（不影响转写，但空文本将无法归因）：%s" % e, file=sys.stderr)

    def do_transcribe(m):
        segments, info = m.transcribe(
            args.src,
            language=None if args.lang == "auto" else args.lang,
            # issue #2 P3-1（2026-10-28）：原来硬编码 True。VAD 预检失败（vad_ok=False）时，
            #   同一个 vad 模块会在 transcribe 里再炸一次、整段转写直接失败；所以预检失败就关掉过滤。
            vad_filter=vad_ok,
            vad_parameters={"min_silence_duration_ms": 400},
            beam_size=5,
            condition_on_previous_text=False,
        )
        parts, segs = [], []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                parts.append(t)
                segs.append({
                    "start": round(float(seg.start), 2),
                    "end": round(float(seg.end), 2),
                    "text": t,
                    "no_speech_prob": round(float(getattr(seg, "no_speech_prob", 0.0) or 0.0), 3),
                    "avg_logprob": round(float(getattr(seg, "avg_logprob", 0.0) or 0.0), 3),
                })
        return parts, segs, info

    # issue #3 第 4 条（2026-10-29）：模型能在 CUDA 上「加载成功」不代表能转写——
    #   实测本机 WhisperModel(device="cuda") 初始化没报错、VAD 也跑完了，
    #   真正调 cuBLAS 时才炸：Library cublas64_12.dll is not found or cannot be loaded。
    #   普通用户装了 ctranslate2 但没装 CUDA 12 运行时，就是这个下场。
    #   所以回落必须包住「转写本身」，不能只包「加载模型」。
    try:
        parts, segs, info = do_transcribe(model)
    except Exception as e:  # noqa: BLE001
        if want == "cuda":
            print("[asr] GPU 转写失败，回落 CPU 重试：%s" % e, file=sys.stderr)
            try:
                model = WhisperModel(args.model, device="cpu", compute_type="int8")
                parts, segs, info = do_transcribe(model)
                want = "cpu"
                print("[asr] 已回落 CPU 完成（要彻底避开这个开销请用 --device cpu）", file=sys.stderr)
            except Exception as e2:  # noqa: BLE001
                print("[asr] CPU 回落也失败：%s" % e2, file=sys.stderr)
                return 5
        else:
            print("[asr] 转写失败：%s" % e, file=sys.stderr)
            return 5
    print("[asr] device=%s" % want, file=sys.stderr)

    text = "".join(parts).strip()
    print("[asr] 完成：%d 段，%d 字，语种 %s" % (len(parts), len(text), info.language), file=sys.stderr)
    # 给调用方的机器可读标记：转写为空时靠它判「没人说话」还是「环境坏了」
    # vad_ok 单独标出来：取不到语音秒数时调用方要报「VAD 不可用」，不能当成 0 秒
    print("[asr] vad_ok=%d" % (1 if vad_ok else 0), file=sys.stderr)
    print("[asr] speech_seconds=%.2f" % speech_sec, file=sys.stderr)
    # ⭐ 段数给调用方做辅助判据：
    #   总时长短不代表是噪声——「说了两句短话」每句 1 秒、两段，和「咳嗽一声」一段，
    #   总时长都是 2 秒。段数 ≥2 说明有过多次发声，更可能是短话而非噪声。
    print("[asr] speech_segments=%d" % (len(stamps) if vad_ok else -1), file=sys.stderr)
    print("[asr] chars=%d" % len(text), file=sys.stderr)
    if args.json:
        # 给调用方判「听到了」还是「编出来的」：正文 + 分段 + VAD 统计
        payload = {
            "text": text,
            "segments": segs,
            "vad": {
                "ok": bool(vad_ok),
                "sec": round(speech_sec, 2),
                "n": len(stamps) if vad_ok else -1,
            },
            "language": info.language,
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        print("[asr] 已写入：" + args.out, file=sys.stderr)
    else:
        sys.stdout.write(text + "\n")
    # 空文本是结果不是错误：纯音乐 / 纯录屏 / 无声演示的视频就该是空的
    return 0


if __name__ == "__main__":
    sys.exit(main())
