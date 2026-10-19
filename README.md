# dsh-bili-watch

把一条 B 站视频变成模型能读的内容：元数据、评论、弹幕、AI 字幕、本地转写、抽帧 OCR。可以装在 DSH 里当插件，也能直接跑命令行。

取内容的顺序是先用文字（字幕或转写），文字不够再抽帧看画面。只读元数据、评论、弹幕、搜索、热榜不需要任何额外依赖；抽帧相关命令要 ffmpeg，没装会明确报错并指出装法，不会假装成功。

## 安装

### 装进 DSH 当插件

```bash
dsh plugin --profile web add dsh-bili-watch
```

**第二步容易漏**：打开 profile 的 `package.json`，在 `dsh.profile.bundles` 数组里加一行 `"dsh-bili-watch"`。`dsh plugin add` 只写 `dependencies`，不写 bundles。漏了这步插件装了但不生效，也不报错。改完重启 DSH。

也可以把本仓库直接放进 `profiles/<名字>/node_modules/dsh-bili-watch`。

插件依赖 DSH 自带的 `@deepseek-ai/dsh-tools`（peer，optional）。profile 里缺这个包时 `index.js` 会报 `ERR_MODULE_NOT_FOUND`，先补装再重启。

### 只当命令行工具

```bash
npm i -g dsh-bili-watch
bili-watch view BV1EPnG6DEJC
```

不装全局也行：clone 仓库后在目录里跑 `node tools/look.mjs view BV1EPnG6DEJC`。命令行的依赖和插件完全一样，`scripts/fetch-deps` 同样可用。

## 依赖

| 能力 | 需要 | 没有时 |
|---|---|---|
| 元数据 / 评论 / 弹幕 / 搜索 / 热榜 | 无（匿名 HTTP） | — |
| 抽帧 / 九宫格 / 字幕带 | `ffmpeg` | 报错并提示装法（`text` 会降级到读图） |
| AI 字幕 | 一次扫码登录（SESSDATA） | 返回「无字幕轨」，自动降级 |
| 本地转写 | Python 3.10+ 与 faster-whisper（`deps/.venv-asr`） | 跳过，自动降级 |
| 画面 OCR | Python 3.10+ 与 rapidocr_onnxruntime（`deps/.venv-ocr`） | 跳过，只剩基础抽帧 |
| 通用视频 URL | yt-dlp | 只支持 B 站 |

环境：Node.js ≥ 22。装在 DSH 里时 DSH 自带 node，命令行跑也一样。

`ffmpeg` 查找顺序：`--ffmpeg` 参数 → `BILI_LOOK_FFMPEG` → 插件 `deps/` → PATH。

`deps/` 用来放运行期文件：Python venv、模型、yt-dlp、凭证，默认不进 git（见 `.gitignore`）。ASR 和 OCR 的 Python 环境是可选的，不装也能用，只是少这两档。

`deps/_bili-asr.py` 默认从 `hf-mirror.com` 下模型，国内快。海外网络可以先设 `HF_ENDPOINT=https://huggingface.co` 再跑 `fetch-deps`。

### 可选依赖（一键安装）

```powershell
# Windows（powershell.exe 或 pwsh 都行）
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target all
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target all -Mirror cn   # 国内网络：gh-proxy + 清华 PyPI + hf-mirror

# 单项：ffmpeg / ytdlp / asr / ocr / model
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target ytdlp
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1 -Target model
```

```bash
# macOS / Linux
bash scripts/fetch-deps.sh all
BILI_LOOK_MIRROR=cn bash scripts/fetch-deps.sh all
```

脚本可以重复跑：目标已存在就跳过，`-Force` 重下（Windows），`-DryRun` 只打印命令。装 venv 时会验证包能不能 import，上次装到一半的会被重建。`-Target model` 需要 ASR 环境先装好，脚本会提示。

**从 GitHub 下载很慢或断**：ffmpeg 要从 GitHub 拉约 80 MB 的压缩包，国内直连经常断。三条替代路径：

1. 加 `-Mirror cn` 重试（走 gh-proxy）；
2. 手动下载 `ffmpeg.exe` 放进 `deps\` 再重跑（会被跳过）；
3. 已经有 ffmpeg 就设 `BILI_LOOK_FFMPEG` 指向它。

macOS/Linux 的 ffmpeg 用系统包管理器装，脚本只给提示。其余目标和 Windows 一样；sh 版本单项失败会跑完再汇总。

## 凭证

匿名也有内容：元数据、评论、抽帧、弹幕都不需要登录。

只有拿 AI 字幕需要登录，二选一：

1. `login`：插件出二维码，手机 B 站扫码。凭证存在插件 `deps/credential.json`，不出本机。
2. `--cred <文件路径>`：读一份现成的 `{sessdata, bili_jct, buvid3, buvid4}` JSON。

凭证顺序：给了 `--cred` 就只用它，读不到就按匿名跑；没给 `--cred` 才用 `deps/credential.json`；两者都没有就匿名。

这份文件等同账号登录态。别分享、别提交、别上传。

## 命令

| 命令 | 做什么 |
|---|---|
| `view <BV或链接或URL>` | 元数据 + 简介 + 热评 |
| `peek <BV或链接>` | 元数据 + 热评 + 5 张均匀帧（最便宜；仅 B 站） |
| `sub <BV>` | AI 字幕 + 三判据（字/秒、关键词命中、时长） |
| `comments <BV> [N]` | 评论区，默认按时间倒序 |
| `asr <BV或URL>` | 本地转写音频 |
| `frames <BV或URL> [--step 秒] [--ocr]` | 抽帧；`--ocr` 顺带识别画面文字 |
| `ocr <BV>` | 抽帧并 OCR |
| `text <BV或URL>` | 四级链：字幕 → 转写 → 抽帧 OCR |
| `sheet <BV> [--grid 3x3]` | 均匀挑 9/16 帧拼成一张图 |
| `substrip <BV> [--step 秒]` | 底部字幕竖拼成一张图 |
| `danmaku <BV>` | 弹幕热区（按时间桶统计峰值） |
| `search <关键词> [--days 3]` | 搜视频 |
| `hot [--limit 10]` | 综合热门榜 |
| `login [--check] [--poll]` | 扫码登录 |
| `clean` | 清空系统临时目录下的 `bili-watch`（Windows 是 `%TEMP%\bili-watch`） |

工具侧的等价入口：`bili_watch` 工具（参数 `command` + `bv`），或 `/bili` 命令。

表里只列常用参数。完整参数（`--out`、`--fresh`、`--scene`、`--ffmpeg`、`--cred`、`--fast`、`--mark-seen`、`--p` 等）跑 `bili-watch help` 看。

## 通用视频 URL

`view` / `text` / `asr` / `frames` 接受非 B 站 URL（YouTube、X、直链 mp4 等），走 yt-dlp：

- `yt-dlp.exe` 放进 `deps/`，或设 `BILI_LOOK_YTDLP`，或让它出现在 PATH 里。
- 下载按 URL 哈希隔离在 `%TEMP%\bili-watch\`，不会串目录。
- `peek` / `sub` / `comments` / `danmaku` / `sheet` / `substrip` / `ocr` 只支持 B 站。

## 降级链

```
AI 字幕（需登录）
   ↓ 没有字幕轨
本地转写（可选依赖）
   ↓ 没装 / 转写质量差（< 2 字/秒）
抽帧 + OCR（可选依赖）
   ↓ 没装
读图（模型自己看帧）
```

降级时会说明原因，不会静默跳过。

## 环境变量

| 变量 | 作用 |
|---|---|
| `BILI_LOOK_PROJ` | ASR/OCR 环境目录（默认插件 `deps/`） |
| `BILI_LOOK_FFMPEG` | ffmpeg 可执行文件路径 |
| `BILI_LOOK_YTDLP` | yt-dlp 可执行文件路径 |
| `BILI_LOOK_SEEN` | `seen.md` 去重文件路径（默认 `deps/seen.md`） |

## 成本

- 字幕一次请求，最省。
- 抽帧会下载视频（360p）并跑 ffmpeg。`--step` 调低抽帧频率，脚本另外限了 `-threads 2`。
- 九宫格和字幕带把多帧压成一张图，省 token。

## 风险

- **凭证**：等同账号登录态，泄露即被盗。只存本机，不进日志。
- **频率**：正常看几条没问题；批量扫几百条会触发风控。
- **只读**：插件只读，不点赞、不评论、不留观看历史。

## 许可

MIT
