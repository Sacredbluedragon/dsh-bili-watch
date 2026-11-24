#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ocr.py —— 用 RapidOCR 把抽帧图片里的文字识别成文本。

为什么要它：抽帧后如果每张图都丢给模型读，一次视频要烧好几次视觉调用；
OCR 先出逐字文本，模型只读文本就够了，画面类信息（榜单、图表、代码）不丢。

用法（用 .venv-ocr 里的 python）：
  python ocr.py <图片目录 | 单张图片> [--json]
输出：逐张「=== 文件名 ===」+ 识别到的行；--json 输出机器可读数组。

0.4.16 汇总口径（stderr，json/text 两模式同源）：
  [ocr] summary chars=N loadFail=N empty=N total=N
  · total    本次尝试的图片张数
  · loadFail 图片打不开 / 识别抛异常（解码失败）
  · empty    解码成功但识别不出任何文字（纯色帧、无字幕画面等）
  · chars    所有识别行的字符数之和（权威值，Node 侧反推只作交叉校验）
退出码契约不变：进程跑完即 0；识别不出文字不是非零退出。
"""
import json
import os
import sys

# 路 A（宿主可见性）：逐张失败明细在 stderr 只保留前 3 条，其余按同因折叠，
#   避免几十张坏帧把宿主结果窗口（head 800）全挤掉。汇总行永远完整给出。
MAX_RAW_FAIL_LINES = 3


def build_engine():
    """兼容两条产品线：rapidocr_onnxruntime(1.x) 与 rapidocr(2.x)。"""
    try:
        from rapidocr_onnxruntime import RapidOCR  # 1.x

        return ("1.x", RapidOCR())
    except Exception:
        pass
    try:
        from rapidocr import RapidOCR  # 2.x

        return ("2.x", RapidOCR())
    except Exception as e:  # noqa: BLE001
        print("[ocr] 导入 RapidOCR 失败：%s" % e, file=sys.stderr)
        print("[ocr] 先在 .venv-ocr 里装：python -m pip install rapidocr-onnxruntime -i https://pypi.org/simple", file=sys.stderr)
        return (None, None)


def recognize(engine, kind, path):
    """返回识别到的行（list[str]）。两条产品线的返回结构不同，这里抹平。"""
    if kind == "2.x":
        out = engine(path)
        # 2.x: RapidOCROutput(txts=..., boxes=..., scores=...)
        return [str(t) for t in (getattr(out, "txts", None) or []) if str(t).strip()]
    res, _elapse = engine(path)
    lines = []
    for item in res or []:
        # 1.x: 每项 [box, text, score]
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            t = str(item[1]).strip()
            if t:
                lines.append(t)
    return lines


def main():
    if len(sys.argv) < 2:
        print("usage: ocr.py <dir-or-image> [--json]", file=sys.stderr)
        return 2
    src = sys.argv[1]
    as_json = "--json" in sys.argv
    kind, engine = build_engine()
    if engine is None:
        return 3

    if os.path.isdir(src):
        files = sorted(
            os.path.join(src, f)
            for f in os.listdir(src)
            if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp"))
        )
    elif os.path.isfile(src):
        files = [src]
    else:
        print("[ocr] 找不到：%s" % src, file=sys.stderr)
        return 2
    if not files:
        print("[ocr] 目录里没有图片：%s" % src, file=sys.stderr)
        return 2

    result = []
    load_fail = 0   # 解码 / 识别抛异常
    empty = 0       # 解码成功但无文字
    chars = 0
    fail_reasons = []  # (文件名, 原因)，用于同因折叠

    for f in files:
        item_failed = False
        try:
            lines = recognize(engine, kind, f)
            if not lines:
                empty += 1
        except Exception as e:  # noqa: BLE001
            lines = []
            load_fail += 1
            item_failed = True
            reason = str(e).strip() or type(e).__name__
            fail_reasons.append((os.path.basename(f), reason))
        item_chars = sum(len(t) for t in lines)
        chars += item_chars
        result.append({
            "file": os.path.basename(f),
            "lines": lines,
            "chars": item_chars,
            "loadFail": item_failed,
        })

    # 路 A：前 3 条失败原样打，其余折叠成一行同因汇总。
    for name, reason in fail_reasons[:MAX_RAW_FAIL_LINES]:
        print("[ocr] %s 识别失败：%s" % (name, reason), file=sys.stderr)
    if len(fail_reasons) > MAX_RAW_FAIL_LINES:
        extra = len(fail_reasons) - MAX_RAW_FAIL_LINES
        first_reason = fail_reasons[MAX_RAW_FAIL_LINES][1]
        print("[ocr] 另有 %d 张同因失败（首因：%s）" % (extra, first_reason), file=sys.stderr)

    # 汇总信号走 stderr，不进模型正文；json/text 两模式同源同格式。
    print(
        "[ocr] summary chars=%d loadFail=%d empty=%d total=%d"
        % (chars, load_fail, empty, len(files)),
        file=sys.stderr,
    )

    if as_json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        for item in result:
            print("=== %s ===" % item["file"])
            for line in item["lines"]:
                print(line)
            print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
