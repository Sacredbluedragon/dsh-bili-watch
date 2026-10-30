# 第三方组件许可声明（THIRD_PARTY_NOTICES）

本插件随 npm 包分发的内容，以及由 `scripts/fetch-deps.ps1` 在本机按需安装、**不随本包分发**的第三方组件，其版本与许可如下。

版本号均在本机实测对过：随包依赖来自 `node_modules/qrcode/package.json`；本机 venv 依赖来自
`deps/.venv-asr/Lib/site-packages/*.dist-info/METADATA` 与
`deps/.venv-ocr/Lib/site-packages/*.dist-info/METADATA` 的 `Name`/`Version`/`License` 字段；
二进制来自 `ffmpeg -version` 与 `yt-dlp --version`。

---

## 一、随 npm 包分发的组件

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| qrcode | 1.5.4 | MIT |

- **qrcode** 1.5.4 — MIT License。随本包 `dependencies` 一起分发。

---

## 二、由 fetch-deps 安装、不随本包分发的组件

以下组件由用户运行 `scripts/fetch-deps.ps1` 时按需下载/安装到 `deps\` 下，**不**打包进 npm 发布物。
其中三个 pip 包在脚本里锁死版本（本机实测能跑）：`faster-whisper==1.2.1`、`av==15.1.0`、
`rapidocr-onnxruntime==1.2.3`；其余 pip 包为其传递依赖，版本以本机实测为准。
ffmpeg 与 yt-dlp 不锁版本（跟上游走），装完的实际版本记录在 `deps\last-run.json`。

### ASR 虚拟环境（deps\.venv-asr）

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| faster-whisper | 1.2.1 | MIT |
| ctranslate2 | 4.8.3 | MIT |
| av | 15.1.0 | BSD-3-Clause |
| onnxruntime | 1.31.0 | MIT |
| numpy | 2.5.4 | BSD-3-Clause（含 0BSD / MIT / Zlib / CC0-1.0 等宽松组件） |

- **faster-whisper** 1.2.1 — MIT License。
- **ctranslate2** 4.8.3 — MIT License（faster-whisper 的推理后端）。
- **av** 15.1.0（PyAV）— BSD-3-Clause。
- **onnxruntime** 1.31.0 — MIT License。
- **numpy** 2.5.4 — 以 BSD-3-Clause 为主，另含 0BSD / MIT / Zlib / CC0-1.0 等宽松许可组件。

### OCR 虚拟环境（deps\.venv-ocr）

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| rapidocr-onnxruntime | 1.2.3 | Apache-2.0 |
| opencv-python | 5.0.0.93 | Apache-2.0 |
| pillow | 13.0.0 | HPND / Pillow License（MIT-CMU） |
| numpy | 2.5.4 | BSD-3-Clause（含其他宽松组件） |
| shapely | 2.2.0 | BSD-3-Clause |
| pyclipper | 1.4.0 | MIT |
| onnxruntime | 1.31.0 | MIT |

- **rapidocr-onnxruntime** 1.2.3 — Apache License 2.0。
  （注：本插件用的是 rapidocr-onnxruntime，**不是** paddleocr；模型与运行时均为 onnxruntime。）
- **opencv-python** 5.0.0.93 — Apache License 2.0。
- **pillow** 13.0.0 — HPND（Pillow License，元数据记为 MIT-CMU）。
- **shapely** 2.2.0 — BSD-3-Clause。
- **pyclipper** 1.4.0 — MIT License。

### 二进制（deps\ffmpeg.exe、deps\ffprobe.exe、deps\yt-dlp.exe）

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| ffmpeg（含 ffprobe） | 8.0（BtbN Windows GPL 构建，随上游 latest 不锁版） | GPL v3 |
| yt-dlp | 随上游 latest 不锁版 | TODO：许可证待确认 |

- **ffmpeg / ffprobe** 8.0 — 取自 BtbN/FFmpeg-Builds 的 `win64-gpl` 静态构建，
  构建选项含 `--enable-gpl --enable-version3 --enable-libx264 --enable-libx265`，
  因此该二进制按 **GPL v3** 分发。随本插件使用时须遵守 GPL v3 条款（本插件本体为 MIT，
  与 GPL 二进制的组合按 GPL 条款理解；不随 npm 包分发，仅在用户本机 `deps\` 下存在）。
- **yt-dlp** — 二进制来自 yt-dlp 官方 release，版本不锁、跟上游走。
  > TODO：本机未能取到 yt-dlp 随包 LICENSE 文本，其许可证（据传为 Unlicense / Public Domain）
  > **待确认**，此处不臆造。下次运行 fetch-deps 后请核对 `yt-dlp --version` 对应的上游 LICENSE。

---

本文件由 dsh-bili-watch 维护；如更新依赖版本，请同步刷新上表与 `scripts/fetch-deps.ps1` 中的锁版号。
