# 三稿复制提示词的**基准**（C89 的期望值）

这个文件是「面板上三个复制按钮该复制出什么」的规格，不是实现。
C89 把 `client.js` 里 `const COPY_XXX = String.raw`...`` 求值出来，与下面三段**逐字节**比。

**为什么基准要单独存一份**：断言的价值在于「期望值独立于被测代码」。如果基准从
`client.js` 自己生成，那实现改错、基准跟着错，断言永远绿——那就是纸老虎。

**改文案的正确流程**：先改这里，再改 `client.js`，然后跑 `node tools/verify.mjs`。
只改一边会红，红就是提醒；两边都改对了才绿。

**为什么不进 npm 包**：`tools/` 不在 `package.json` 的 `files` 里，这里只进 Git 仓库，
供本机与 CI 跑断言用。发布出去的是 `client.js` 里那份正身。

顺序固定：第一段 = `COPY_DEPS`（依赖装不上），第二段 = `COPY_ASR`（转写/OCR 失败），
第三段 = `COPY_PANEL`（面板打不开）。块内文字与按钮实际复制的文本**逐字节相同**，
所以不要在块里加任何注释或标题。

```
我在用 DSH 的 bili-watch 插件（B 站看内容），现在依赖装不上：面板「运行依赖」里有一行永远是红的，或者我点了「下载」一直没反应。

请只做只读排查：不要改任何配置、不要删文件、不要装任何东西、不要重启任何东西。需要改动的地方，先列出来问我。

只读排查要做的事：

1) 先确定这台机器的 DSH 主目录：环境变量 DSH_HOME 有值就用它，否则 Windows 用 %USERPROFILE%\.dsh、macOS/Linux 用 ~/.dsh。下面所有路径都按它拼，不要写死盘符。

2) 读插件自己报的依赖状态：GET {{ORIGIN}}/api/bili-watch/status（面板地址用浏览器地址栏里那个，端口可能被人改过）。只要 data.deps 这一段：它有七行 —— 六项运行依赖（id 分别是 ffmpeg / ytdlp / asr / ocr / model / cuda）加一行 B 站登录凭证（id 是 credential），每行有 ok、detail、path。把七行的 id、ok、detail、path 原样列给我，并指出哪一行 ok=false、它的 detail 原文是什么。
   - credential 那行的 detail 有三种形态：「没登录，AI 字幕与部分接口不可用」、「凭证残缺（缺 xxx），实际走匿名；点登录重新扫码」、「更新于 <时间>（N 天前）」。ok=false 说明登录凭证失效或残缺，要重新扫码 —— 这是「有一行永远红」最常见的原因之一，别跳过这行。
   - cuda 那行的 path 不是路径，是一个库文件名（Windows 下是 cublas64_12.dll，macOS/Linux 下是 libcublas.so.12），别按路径去它的父目录里找东西。

3) 读这两个日志（默认在 <DSH 主目录>/bili-watch/deps/ 下；第 2 步返回的 deps[].path 是插件实际在用的解释器/二进制路径，它们的父目录就是依赖目录，路径不一致就以那里为准）：
   - download.log：宿主侧的结构化事件（开始下载 / 拉起进程 / 退出码 / 失败原因），每行以 [时间戳] 开头
   - download.out.log：安装脚本自己的逐行输出
   把这两个文件**从末尾往前**各贴最后 50 行（原样，不要改写、不要翻译），并指出最后一条事件是什么、有没有非零退出码。
   这两个文件可能压根不存在（点了下载没跑起来的时候就是这样）：哪个不存在就明确说「该文件不存在」，并说明依赖目录本身在不在（<DSH 主目录>/bili-watch/deps/ 这个目录有没有）。**文件不存在就说文件不存在**，不要写成「日志为空」，也不要顺手猜一个原因。

4) 列出依赖目录里实际有什么：对那个目录列目录（含文件大小），并分别检查这几个东西在不在：
   - ffmpeg（Windows 是 ffmpeg.exe，macOS/Linux 是 ffmpeg）
   - yt-dlp（yt-dlp.exe / yt-dlp）
   - 转写用的 Python：.venv-asr\Scripts\python.exe（Windows）或 .venv-asr/bin/python（macOS/Linux）
   - OCR 用的 Python：.venv-ocr\Scripts\python.exe 或 .venv-ocr/bin/python
   - 模型缓存目录：.hf-home（在依赖目录里，或在插件安装目录下同名目录）
   每个都告诉我「在 / 不在 / 在但大小异常」，并写大小。

5) 如果 download.out.log 里有明确报错，把**那几行原文**贴给我；如果报错提到某个 Python，把提到 Python 的那几行原文贴出来。

最后按这个格式整理（后面我要拿它去问人或反馈问题，条目清楚一点更省事）：
现象：…
环境：操作系统、DSH 主目录路径、Python 是否存在及其版本（python --version）
日志片段：download.log 与 download.out.log 的尾部原文
已排查项：逐条列出你查过什么、结果是什么
怀疑点：按可能性排序，每条写清「因为看到 X，所以怀疑 Y」

报告整理完，如果看下来像是插件自己的毛病，你可以顺口问我一句：要不要我帮你整理一条 issue 提给作者？我不一定提，你问一句就行。

不要修改任何文件。查完如果有明显该修的地方，列出来问我，不要自己动手。
```

```
我在用 DSH 的 bili-watch 插件（B 站看内容），转写（ASR）或画面文字识别（OCR）一直失败：跑转写时报错，或者每次都悄悄回落到 CPU 速度。

请只做只读排查：不要改配置、不要删文件、不要装东西、不要重跑长时间的任务、不要重启任何东西。需要改动的地方，先列出来问我。

1) 确定 DSH 主目录：环境变量 DSH_HOME 有值就用它，否则 Windows 用 %USERPROFILE%\.dsh、macOS/Linux 用 ~/.dsh。依赖目录默认在 <DSH 主目录>/bili-watch/deps/，插件实际在用的目录以 GET {{ORIGIN}}/api/bili-watch/status 返回的 deps[].path 为准。

2) 读那个依赖目录下的 download.log，把带 [asr] 或 [ocr] 的行原样贴出来（安装过程的关键节点都写在这里）。

3) 找出转写与 OCR 实际用的 Python 并检查能不能用（Windows 是 .venv-asr\Scripts\python.exe、.venv-ocr\Scripts\python.exe；macOS/Linux 是 .venv-asr/bin/python、.venv-ocr/bin/python）。对找到的解释器各跑下面两条只读命令，把**完整输出**贴给我（包括报错原文）：
   - <转写 python> -c "import faster_whisper, sys; print('faster_whisper', faster_whisper.__version__); print(sys.version)"
   - <OCR python> -c "import importlib.util as u; print([m for m in ('rapidocr_onnxruntime','rapidocr') if u.find_spec(m)])"
   某个 Python 文件根本不存在就明确说「不存在」，不要跳过。

4) GPU 探测：在那个依赖目录（或插件安装目录）下找 _bili-asr.py，跑
   <转写 python> <该脚本路径> --probe-gpu
   把输出和退出码贴给我。

5) 内存：报出这台机器的物理内存总量与当前可用量（Windows: Get-CimInstance Win32_OperatingSystem 的 TotalVisibleMemorySize 与 FreePhysicalMemory；macOS/Linux: free -h 或 vm_stat）。

6) 找上一次转写留下的记录并贴出来（没有就说没有，不要编）：
   - <DSH 主目录>/bili-watch/cache/_logs/runs.jsonl 的最后 10 行
   - <DSH 主目录>/bili-watch/cache/ 下面各个视频目录里的 last-error.json（转写失败时留下的详细原因，一个视频目录一份；找到就原样贴出内容）

最后按这个格式整理（后面我要拿它去问人或反馈问题，条目清楚一点更省事）：
现象：…
环境：操作系统、Python 版本、内存总量与可用量、GPU 探测的输出与退出码
日志片段：download.log 里 [asr]/[ocr] 的行 + runs.jsonl 尾部 + last-error.json 原文
已排查项：逐条列出你查过什么、结果是什么
怀疑点：按可能性排序，每条写清「因为看到 X，所以怀疑 Y」

报告整理完，如果看下来像是插件自己的毛病，你可以顺口问我一句：要不要我帮你整理一条 issue 提给作者？我不一定提，你问一句就行。

不要修改任何文件。
```

```
我在用 DSH 的 bili-watch 插件（B 站看内容），面板打不开或者点了没反应：插件列表里报错、面板一直转圈、或点了某个按钮没有任何反应。

请只做只读排查：不要改配置、不要删文件、不要重启宿主、不要装东西。需要改动的地方，先列出来问我。

1) 先确定面板地址：用浏览器地址栏里 DSH 面板的实际地址（端口可能被改过，不要假设默认端口），记作 {{ORIGIN}}。

2) 读插件自己的状态接口：GET {{ORIGIN}}/api/bili-watch/status
   - 把 HTTP 状态码、响应头里的 content-type、以及响应体原文贴给我（是 JSON 就原样贴，不要改字段名、不要摘要）
   - 如果请求失败（连不上 / 403 / 404 / 500），把失败原因原样贴出来
   - 如果返回里带 data.warnings，把 warnings 数组每一条原文贴出来

3) 浏览器这一侧（能操作浏览器就做，做不了就说明做不了、不要猜）：
   - 打开开发者工具的 Console，把所有以 [dsh-bili-watch] 开头的行原样贴出来，把其它红色报错也一并贴上
   - 打开 Network，把 /api/bili-watch/ 开头的请求逐条列出（方法、URL、状态码、耗时），失败的把响应体贴出来
   - 说明面板是否根本没渲染出来（页面一片空白，或出现「需要 DSH ≥ …」这类提示）

4) 主机这一侧：告诉我 DSH 宿主进程是否在运行（Windows 用任务管理器或 Get-Process 找 dsh；macOS/Linux 用 ps aux | grep -i dsh），以及它占多少内存。如果面板页面上有直接能看到的报错（比如一行红字），把那行原文贴出来就够了 —— 不用去磁盘上搜日志。

5) 插件是否被加载：DSH 的插件列表里 dsh-bili-watch 是否显示为启用；如果面板已经渲染出来且有「运行依赖」区，把那七行的名字与状态原样贴出来（其中一行是 B 站登录凭证，它在面板上和别的不太一样）。

最后按这个格式整理（后面我要拿它去问人或反馈问题，条目清楚一点更省事）：
现象：…
环境：操作系统、浏览器与版本、面板地址、DSH 进程是否在跑
日志片段：status 接口的状态码与响应原文、Console 里 [dsh-bili-watch] 的行、Network 里失败的请求
已排查项：逐条列出你查过什么、结果是什么
怀疑点：按可能性排序，每条写清「因为看到 X，所以怀疑 Y」

报告整理完，如果看下来像是插件自己的毛病，你可以顺口问我一句：要不要我帮你整理一条 issue 提给作者？我不一定提，你问一句就行。

不要修改任何文件、不要重启宿主。
```
