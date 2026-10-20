# dsh-bili-watch

将一条 B 站视频变成模型能读的内容：元数据、评论、弹幕、AI 字幕、本地转写、抽帧 OCR。可作为 DSH 插件运行，也可直接当命令行工具。

取内容的顺序是先用文字（字幕或转写），文字不够则抽帧看画面。只读元数据、评论、弹幕、搜索、热榜不需要任何额外依赖；抽帧相关命令需要 ffmpeg，未安装会明确报错并指出装法。

> [!IMPORTANT]
> 面板要重启 DSH 后才出现，插件只在启动时加载。
> 抽帧类命令（`frames` / `ocr` / `sheet` / `substrip` / `text` 的兜底档）需要 ffmpeg，没有会直接报错，不会静默降级。
> 登录只影响 AI 字幕；其余命令匿名可用。

## 安装

### 装进 DSH 当插件

```bash
dsh plugin --profile web add dsh-bili-watch
```

**第二步易漏**：打开 profile 的 `package.json`，在 `dsh.profile.bundles` 数组里加一行 `"dsh-bili-watch"`。`dsh plugin add` 只写 `dependencies`，不写 bundles。漏了这步插件装了但不生效，也不报错。改完重启 DSH。

装完可以验证：`dsh --profile web --dump-config` 里能搜到 `dsh-bili-watch` 才算进了装配。

也可以把本仓库直接放进 `profiles/<名字>/node_modules/dsh-bili-watch`。

插件依赖 DSH 自带的 `@deepseek-ai/dsh-tools`（peer，optional）。profile 里缺这个包时 `index.js` 会报 `ERR_MODULE_NOT_FOUND`，先补装再重启。

插件尚未收录到插件市场，目前只能按上面的命令装。

### 只当命令行工具

```bash
npm i -g dsh-bili-watch
bili-watch view BV1EPnG6DEJC
```

不装全局也行：clone 仓库后在目录里跑 `node tools/look.mjs view BV1EPnG6DEJC`。命令行的依赖和插件完全一样，`scripts/fetch-deps` 同样可用。

### 更新与卸载

```bash
dsh plugin --profile web add dsh-bili-watch@latest
dsh plugin --profile web remove dsh-bili-watch
```

升级后重启 DSH。卸载不会删除 `deps/` 里的模型、环境与凭证；要清理就在面板里逐项删，或手动删目录。

## 插件面板

装进 DSH 后，设置 → 插件 → `dsh-bili-watch` 的详情页有一块面板，常规操作无需去对话里敲命令：

- **依赖状态**：ffmpeg、yt-dlp、ASR 环境、OCR 环境、转写模型、登录凭证逐项列出是否就绪、实际路径、占用体积。缺的点击行末「下载」，后台跑 `scripts/fetch-deps`（体积是估算值，实际以跑完为准）。
- **扫码登录**：凭证未登录时点「重新扫码」，面板里弹出二维码，手机 B 站扫完自动刷新。凭证保存在本机 `deps/credential.json`。
- **删除**：面板按实际路径判断——装在插件目录里的（yt-dlp、转写模型、登录凭证）可直接删；装在插件目录外的（比如复用系统 ffmpeg 或已有的 Python 环境）按钮置灰，旁边标出它实际在哪。
- **批量**：标题行的「批量下载 / 批量清理」打开勾选清单，默认勾上所有可操作的项，删除前会再确认一次。
- **抽帧缓存**：显示当前占用与文件数，「立即清除」一键清空；不点则会按规则自动清理——保留天数（默认 7 天）与总量上限（默认 2048 MB），超过则从最旧的删起。规则存在 `deps/cache-config.json`，插件启动和打开面板时各检查一次。
- **最近一次调用**：显示命令、时间、成败，用来判断上一次看视频是否卡住。

装完第一次重启 DSH，面板才会出现。

## 依赖

| 能力 | 需要 | 没有时 |
|---|---|---|
| 元数据 / 评论 / 弹幕 / 搜索 / 热榜 | 无（匿名 HTTP） | — |
| 抽帧 / 九宫格 / 字幕带 | `ffmpeg` | 报错并提示装法（`text` 的兜底档就是抽帧，所以同样要 ffmpeg） |
| AI 字幕 | 一次扫码登录（SESSDATA） | 返回「无字幕轨」，自动降级 |
| 本地转写 | Python 3.10+ 与 faster-whisper（`deps/.venv-asr`） | 跳过，自动降级 |
| 画面 OCR | Python 3.10+ 与 rapidocr_onnxruntime（`deps/.venv-ocr`） | 跳过，只剩基础抽帧 |
| 通用视频 URL | yt-dlp | 只支持 B 站 |

环境：Node.js ≥ 22。装在 DSH 里时 DSH 自带 node，命令行跑也一样。

`ffmpeg` 查找顺序：`--ffmpeg` 参数 → `BILI_WATCH_FFMPEG` → 插件 `deps/` → PATH。

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
BILI_WATCH_MIRROR=cn bash scripts/fetch-deps.sh all
```

脚本可以重复跑：目标已存在就跳过；Windows 用 `-Force` 重下、`-DryRun` 只打印命令（sh 版没有这两个参数，要重装就删掉目标目录）。装 venv 时会验证包能不能 import，上次装到一半的会被重建。`-Target model` 需要 ASR 环境先装好，脚本会提示。

**从 GitHub 下载很慢或断**：ffmpeg 要从 GitHub 拉约 80 MB 的压缩包，国内直连经常断。三条替代路径：

1. 加 `-Mirror cn` 重试（走 gh-proxy）；
2. 手动下载 `ffmpeg.exe` 放进 `deps\` 再重跑（会被跳过）；
3. 已经有 ffmpeg 就设 `BILI_WATCH_FFMPEG` 指向它。

macOS/Linux 的 ffmpeg 用系统包管理器装，脚本只给提示。其余目标和 Windows 一样；sh 版本单项失败会跑完再汇总。

## 凭证

匿名也有内容：元数据、评论、抽帧、弹幕都不需要登录。

只有拿 AI 字幕需要登录，二选一：

1. `login`：插件出二维码，手机 B 站扫码。凭证存在插件 `deps/credential.json`，不出本机。
2. `--cred <文件路径>`：读一份现成的 `{sessdata, bili_jct, buvid3, buvid4}` JSON。

凭证顺序：给了 `--cred` 就只用它，读不到就按匿名跑；没给 `--cred` 才用 `deps/credential.json`；两者都没有就匿名。

这份文件等同账号登录态。请勿分享、提交、上传。

## 命令

| 命令 | 做什么 |
|---|---|
| `view <BV或链接或URL>` | 元数据 + 简介 + 热评 |
| `peek <BV或链接>` | 元数据 + 热评 + 5 张均匀帧（最便宜；仅 B 站） |
| `sub <BV或链接>` | AI 字幕 + 三判据（字/秒、关键词命中、时长） |
| `comments <BV> [N]` | 评论区，默认按热度排序 |
| `asr <BV或URL>` | 本地转写音频 |
| `frames <BV或URL> [--step 秒] [--ocr]` | 抽帧；`--ocr` 顺带识别画面文字 |
| `ocr <BV>` | 抽帧并 OCR |
| `text <BV或URL>` | 四级链：字幕 → 转写 → 抽帧 OCR |
| `sheet <BV> [--grid 3x3]` | 均匀挑帧拼成一张图（只支持 `3x3` / `4x4`，默认 9 帧） |
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

- `yt-dlp.exe` 放进 `deps/`，或设 `BILI_WATCH_YTDLP`，或让它出现在 PATH 里。
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
| `BILI_WATCH_PROJ` | ASR/OCR 环境目录（默认插件 `deps/`） |
| `BILI_WATCH_FFMPEG` | ffmpeg 可执行文件路径 |
| `BILI_WATCH_YTDLP` | yt-dlp 可执行文件路径 |
| `BILI_WATCH_SEEN` | `seen.md` 去重文件路径（默认 `deps/seen.md`）。文件不存在时 `--mark-seen` 记不了，先建一个空文件即可 |

## 成本

- 字幕接口带一次重试；`text` 最多次试两次（先匿名、有凭证再试一次）。
- 抽帧会下载视频（360p）并跑 ffmpeg。`--step` 调低抽帧频率，脚本另外限了 `-threads 2`。
- 拼图和字幕带把多帧压成一张图，省 token。

## 限制与风险

- **不支持**：点赞、评论、发弹幕、留观看历史；B 站侧只读。本机会写登录凭证、抽帧缓存与 `seen.md` 去重文件。
- **只支持 B 站与 yt-dlp 能下的站点**；`peek` / `sub` / `comments` / `danmaku` / `sheet` / `substrip` / `ocr` 仅限 B 站。
- **凭证**：等同账号登录态，泄露即被盗。只存本机，不进日志。
- **频率**：脚本没有硬限速（只在字幕重试时随机等几百毫秒）；批量跑请自己加 sleep，别连着扫。
- **任意 http(s) 地址都会被请求**：通用 URL 走 yt-dlp 时不做内网地址过滤，别拿它请求内网服务。

## 许可

MIT
