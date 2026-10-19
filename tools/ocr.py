#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ocr.py —— 用 RapidOCR 把抽帧图片里的文字识别成文本。

为什么要它：抽帧后如果每张图都丢给模型读，一次视频要烧好几次视觉调用；
OCR 先出逐字文本，模型只读文本就够了，画面类信息（榜单、图表、代码）不丢。

用法（用 .venv-ocr 里的 python）：
  python ocr.py <图片目录 | 单张图片> [--json]
输出：逐张「=== 文件名 ===」+ 识别到的行；--json 输出机器可读数组。
"""
import json
import os
import sys


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
    for f in files:
        try:
            lines = recognize(engine, kind, f)
        except Exception as e:  # noqa: BLE001
            print("[ocr] %s 识别失败：%s" % (os.path.basename(f), e), file=sys.stderr)
            lines = []
        result.append({"file": os.path.basename(f), "lines": lines})

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
