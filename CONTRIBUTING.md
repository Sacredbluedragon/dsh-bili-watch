# 参与开发

## 环境

- Node.js >= 22（见 `package.json` 的 `engines`）
- Windows 上跑发版脚本需要 PowerShell 5.1。`scripts/` 下的 `.ps1` 都带 UTF-8 BOM，改动时不要去掉——没有 BOM 时 PS 5.1 会按 GBK 读中文，整个脚本报语法错误

## 本地准备

```
npm install
```

首次使用还要下载 ffmpeg / yt-dlp / 转写与 OCR 依赖。想先看清将要执行哪些命令再决定，用 dry-run（只打印，不下载、不写盘）：

```
node scripts/fetch-deps.mjs all --dry-run
```

`all` 可换成 `ffmpeg` / `ytdlp` / `asr` / `ocr` / `model` / `cuda` 单项。

另有 `where`：只打印 deps 目录装在哪，不下载、不建目录（`DEPS="$(node scripts/fetch-deps.mjs where)"` 能直接拿到纯路径）。

## 提交前必须全过

```
node tools/verify.mjs
node tools/verify-params.mjs
node tools/verify-todo.mjs
node scripts/check-release-leak.mjs --dir .
node scripts/check-public-text.mjs
```

前三条是断言集，任何一条出现失败都不要提交；后两条检查对外发布的文本里有没有不该出现的本机信息。

前三条会打印「通过 / 失败 / 跳过」汇总。**判断成败看汇总或退出码，不要用管道后的 `$?`**——`node tools/verify.mjs | tail -3` 里的 `$?` 是 `tail` 的退出码，不是 node 的，真实失败会被显示成 0。要截断输出先重定向：

```
node tools/verify.mjs > verify.out 2>&1; echo rc=$?; tail -3 verify.out
```

## 代码约定

- 行尾由 `.gitattributes` 统一：`.mjs` / `.js` / `.json` / `.md` / `.txt` 用 LF，`.ps1` 用 CRLF。不要手工改行尾
- 注释写「为什么这么做」和「踩过什么坑」，不写「第几次改动」「哪个批次」这类开发分期编号
- 改行为的地方要能在 `tools/verify.mjs` 找到对应断言；改不动行为（纯注释、纯文案）时不必新增断言

## 发布

发布走 `scripts/release.ps1`（Windows PowerShell 5.1）。发布树路径**必须**显式给出：设 `BILI_WATCH_RELEASE_DIR` 环境变量，或传 `-Release <路径>`；两者都没有时脚本直接报错退出，不会去猜默认位置。它会先按 md5 比对开发树与发布树、不一致直接中止，然后同步、跑发布校验、打包发布。用法见脚本头部的 `.EXAMPLE`；不确定时先加 `-DryRun` 演练一遍。

不要在本地手工 `npm publish`。
