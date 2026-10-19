# dsh-bili-watch

给 AI「看」B 站视频的 DSH 插件：元数据、AI 字幕、评论区、本地转写、抽帧 OCR、九宫格拼图、弹幕热区。

一句话：模型能直接看一条 B 站视频——先用最便宜的方式拿到文字，文字不够再看画面。

## 安装

```bash
dsh plugin --profile web add dsh-bili-watch
```

**第二步不能省**：打开 profile 的 `package.json`，在 `dsh.profile.bundles` 数组里加一行 `"dsh-bili-watch"`。`dsh plugin add` 只写 `dependencies`，不写 bundles——漏了这一步插件装了但完全不生效（不报错、无入口）。装完重启 DSH。

也可以把本仓库直接放到 `profiles/<名字>/node_modules/dsh-bili-watch`。

> 插件依赖 DSH 自带的 `@deepseek-ai/dsh-tools`（peer，optional）。若 profile 缺这个内核工具包，`index.js` 会报 `ERR_MODULE_NOT_FOUND`，先补装再重启。

## 依赖

| 能力 | 需要 | 没有时 |
|---|---|---|
| 元数据 / 评论 / 弹幕 / 搜索 / 热榜 | 无（匿名 HTTP） | — |
| 抽帧 / 九宫格 / 字幕带 | `ffmpeg` | 跳过，文字档仍可用 |
| AI 字幕 | 一次扫码登录（SESSDATA） | 返回「无字幕轨」，自动降级 |
| 本地转写 | Python 3.10+ 与 faster-whisper（`deps/.venv-asr`） | 跳过，自动降级 |
| 画面 OCR | Python 3.10+ 与 rapidocr_onnxruntime（`deps/.venv-ocr`） | 跳过，只剩基础抽帧 |
| 通用视频 URL | yt-dlp | 只支持 B 站 |

前置：Node.js ≥ 22（插件运行环境本身就有 node，命令行跑也一样）。

`ffmpeg` 查找顺序：`--ffmpeg` 参数 → `BILI_LOOK_FFMPEG` → 插件 `deps/` → PATH。

`deps/` 是运行期目录：Python venv、模型缓存、yt-dlp、凭证都放这里，默认不进 git（见 `.gitignore`）。ASR/OCR 的 Python 环境是**可选依赖**，不配也能用，只是会少两档。

`deps/_bili-asr.py` 默认从 `hf-mirror.com` 下载模型（国内快）；海外网络可先设 `HF_ENDPOINT=https://huggingface.co` 再跑 `fetch-deps`。

### 可选依赖（一键安装）

```powershell
# Windows（powershell.exe 或 pwsh 都可以）
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

脚本是幂等的：目标已存在就跳过，`-Force` 重下（Windows）；`-DryRun` 只打印命令、不下载。装 venv 时会验证包能不能 import，上次装到一半的半成品会被自动重建。`-Target model` 依赖 ASR 环境先装好（脚本会提示）。

**GitHub 下载不动怎么办**：ffmpeg 目标要从 GitHub 拉约 80 MB 的 BtbN 压缩包，国内直连经常断。三条替代路径：

1. 加 `-Mirror cn` 重试（走 gh-proxy）；
2. 手动下载 `ffmpeg.exe` 放进 `deps\` 后重跑（会被跳过）；
3. 已有 ffmpeg 就设 `BILI_LOOK_FFMPEG` 指向它。

macOS/Linux 的 ffmpeg 由系统包管理器安装（脚本只给提示），其余目标与 Windows 一致；sh 版本单项失败会继续跑完再汇总。

## 凭证

**匿名也能用**：元数据、评论、抽帧、弹幕都不需要登录。

只有「拿 AI 字幕」需要登录，二选一：

1. `login`：插件出二维码，手机 B 站扫码。凭证存插件 `deps/credential.json`，不出本机。
2. `--cred <文件路径>`：读一份现成的 `{sessdata, bili_jct, buvid3, buvid4}` JSON。

凭证取值：给了 `--cred` 就只用它（读不到就按匿名跑，不会偷偷换回 `deps/credential.json`）；没给才用 `deps/credential.json`；都没有就匿名。

> 这份文件等于你的账号登录态。别分享、别提交、别上传。

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
| `clean` | 清空临时目录 `%TEMP%\bili-watch` |

工具侧等价入口：`bili_watch` 工具（参数 `command` + `bv`），或 `/bili` 命令。

## 通用视频 URL

`view` / `text` / `asr` / `frames` 接受非 B 站 URL（YouTube、X、直链 mp4 等），走 yt-dlp：

- 把 `yt-dlp.exe` 放进 `deps/`，或设 `BILI_LOOK_YTDLP`，或让它在 PATH 里。
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

每一步都会打印「为什么降级」，不会静默跳过。

## 环境变量

| 变量 | 作用 |
|---|---|
| `BILI_LOOK_PROJ` | ASR/OCR 环境目录（默认插件 `deps/`） |
| `BILI_LOOK_FFMPEG` | ffmpeg 可执行文件路径 |
| `BILI_LOOK_YTDLP` | yt-dlp 可执行文件路径 |
| `BILI_LOOK_SEEN` | `seen.md` 去重文件路径（默认 `deps/seen.md`） |

## 成本

- 字幕一次请求，最便宜。
- 抽帧会下载视频（360p）并跑 ffmpeg，CPU 占用可以用 `--step` 调低频率；脚本已限 `-threads 2`。
- 九宫格/字幕带是把多帧压成一张图，省 token。

## 风险

- **凭证**：等同账号登录态，泄露即被盗。只存本机、不进日志。
- **频率**：正常看几条没问题；批量扫几百条会触发风控。
- **只读**：插件只读，不点赞、不评论、不留观看历史。

## 许可

MIT
