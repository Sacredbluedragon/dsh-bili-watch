/**
 * dsh-bili-watch —— 浏览器半端：插件详情页里的「依赖与状态」面板。
 *
 * 面板回答三件事（不碰业务流程）：
 *   ① 这个插件依赖的 ffmpeg / yt-dlp / ASR / OCR / 模型 / 登录凭证，现在配好了没有；
 *   ② 缺的可以一键下载（异步跑插件自带的 fetch-deps 脚本，带预估体积）；
 *   ③ 抽帧缓存占了多少、可以一键清，平时按「天数 + 总量阈值」自动清。
 *
 * 后端只走 host 的 /api/bili-watch（读盘 + 清缓存 + 起下载），面板不存任何凭证。
 * 挂载点：plugins.bundle.config（key = 包名），因此设置页里看不到它，只在插件详情页出现。
 */
// DSH < 0.2.0-rc.2 的宿主没有 window.__ModuleLoader__，直接调用会抛 TypeError：面板白屏，且面板之外
// 没有任何提示（普通用户不会开 F12）。这里补一个空实现让本文件正常加载完——面板不注册，但宿主不白屏，
// 控制台留一行能看懂的警告。
const MODULE_LOADER =
  typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function'
    ? window.__ModuleLoader__
    : { load() { console.warn('[dsh-bili-watch] 需要 DSH ≥ 0.2.0-rc.2（当前宿主缺 window.__ModuleLoader__），插件面板不会显示。请升级 DSH 后重试。') } }

// E4-02（2026-10-30，P0）：删除结果的消息拼装抽成一处，两处调用点共用。
//   原来单条删除（delOne）写的是 `d.deleted?.length ? 已删除 : 未删除`，而后端删 credential 时
//   两份凭证文件可能一份删掉、一份 rm 失败——deleted 与 skipped 同时非空，
//   于是界面只报「已删除 credential」，skipped 里的原因被整条丢掉，用户以为退出干净了。
//   批量删除那条早就是对的（deleted 与 skipped 都报），这里统一成同一口径，别让两条路各说各话。
function fmtDelMsg(d) {
  const deleted = ((d && d.deleted) || []).join('、')
  const skipped = ((d && d.skipped) || [])
    .map((s) => (s && s.id && s.why ? `${s.id}（${s.why}）` : (s && s.why) || String(s)))
    .join('、')
  if (deleted && skipped) return `已删除：${deleted}；跳过：${skipped}`
  if (deleted) return `已删除：${deleted}`
  return `未删除：${skipped || '未知原因'}`
}

// issue #5 同族（2026-10-31，深入审查）：哪些行该显示「一键下载」。
//   原来写死在 DepRow 里 `!d.ok && d.id !== 'credential'`，于是「GPU 运行库」这行
//   在**没有 NVIDIA 卡**的机器上也有按钮 —— 点下去会装 2.2 GB 运行库，装完照样走 CPU。
//   后端给行带 installable:false 时不显示按钮（没这个字段的行照旧显示，向后兼容）。
//   抽成顶层纯函数是为了能被 verify 真跑断言（C62），而不是「源码里有这句话」。
function canDownloadRow(d) {
  if (!d || d.ok) return false
  if (d.id === 'credential') return false // 凭证走「去扫码登录」，不是下载
  return d.installable !== false
}

// 顶部「缺 N 个依赖」的口径，必须与 canDownloadRow 一致：
//   不可安装的行（没有 NVIDIA 卡时的 GPU 运行库）不算缺，否则「去安装」永远清不掉这个计数
//   —— 用户点完还是那句「缺 1 个依赖」，只能去点「不再提示」。
//   注意：凭证行**仍然计入**（它确实「没配好」），这是原有行为，这一轮没动它。
function missingDeps(deps) {
  return (deps || []).filter((d) => d && !d.ok && d.installable !== false)
}

// #10（2026-10-30，P1）：轮询回包 → 下一步动作。抽成纯函数，便于真跑断言（C36）。
//   原来这段判断写在 tick 里，且无条件 `fails = 0` 之后再 `setQrState(j.state)`：
//   request() 对非 2xx 是「返回结构化错误」而不是抛异常，所以后端 500 时 j.state 是 undefined，
//   既不是 ok 也不是 expired/error，于是落到「等待中」分支每 2.5 秒再问一次——5 次兜底永远不触发，
//   界面永远「等待中」。现在认不出的状态一律算失败，攒够 5 次就停。
function pollStep(j) {
  const known = ['ok', 'expired', 'error', 'waiting', 'scanned'].includes(j && j.state)
  if (j && j.state === 'ok') return { act: 'ok', state: 'ok', why: '' }
  if (j && (j.state === 'expired' || j.state === 'error')) {
    return { act: 'stop', state: j.state, why: (j && j.why) || '' }
  }
  if (!known) return { act: 'retry', state: 'unknown', why: (j && j.why) || '后端没有返回状态' }
  return { act: 'wait', state: j.state, why: '' }
}

// #9（2026-10-30，P1）：/download 的回包是 { ok, data: { results: [{started, log} | {started:false, why}], started } }。
//   单条路径 2026-10-29 已经改成按 results 读，批量路径还在读扁平的 j.why——后端 ok:true 但目标没启动时，
//   批量会把「没启动」算成成功，报的原因还是 request() 补的「HTTP 400」，与真实原因完全无关（E4-01）。
//   两处共用这一份解读，别再各读各的。
function readDownloadResp(j) {
  const results = Array.isArray(j?.data?.results) ? j.data.results : []
  const good = results.filter((r) => r && r.started)
  const bad = results.filter((r) => r && !r.started)
  const log = good[0]?.log || j?.data?.log || ''
  const why = bad.map((r) => r.why).filter(Boolean).join('；') || j?.data?.why || j?.why || ''
  // results 为空（老宿主 / 只回 started 的形状）时退回整体 ok 判，别把成功退化成「启动失败」
  const allStarted = results.length ? good.length === results.length : !!(j?.ok || log)
  return { results, good, bad, log, why, allStarted }
}

MODULE_LOADER.load({
  id: 'dsh-bili-watch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // 包名 = 插件详情页挂点的 key：生产与发布树同名 dsh-bili-watch
    const PKG = 'dsh-bili-watch'
    const API = '/api/bili-watch'
    // D40（2026-10-29）：原来两行就是 `(await fetch(...)).json()`，两个坑一起踩：
    //   ① 不看 res.ok —— 后端 500 时宿主回的是 HTML 错误页，`.json()` 抛 SyntaxError，
    //      面板把 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` 原样弹给用户；
    //   ② 没有超时 —— 后端卡住（比如 /cache/pick 弹着系统对话框）面板就一直转圈，永远不返回。
    //   现在统一走 request()：10 秒超时 + 非 2xx 判据 + 非 JSON 兜底。
    const REQ_TIMEOUT_MS = 10000
    const reqTimeout = (ms) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), ms)
      return { signal: ctrl.signal, done: () => clearTimeout(t) }
    }
    const request = async (p, init = {}) => {
      const guard = reqTimeout(REQ_TIMEOUT_MS)
      let r
      try {
        r = await fetch(API + p, { credentials: 'same-origin', signal: guard.signal, ...init })
      } catch (e) {
        // AbortError 在浏览器里名字可能被包装，两种都判；文案给人看，不给英文异常名
        const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''))
        throw new Error(aborted ? `请求超时（${REQ_TIMEOUT_MS / 1000} 秒无响应）：${p}` : `连不上插件服务（${p}）：${String(e?.message || e)}`)
      } finally {
        guard.done()
      }
      // 先取文本再自己 parse：非 JSON 的响应体（HTML 错误页 / 空体）只会落到下面那条分支，
      //   不会像以前那样把 SyntaxError 弹给用户。
      const text = await r.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      if (!r.ok) {
        // 非 JSON 的 4xx/5xx（宿主 HTML 错误页、反代 502 页）：没有 why 可透传，
        //   至少把状态码与「这不是 JSON」说清楚，别再把 SyntaxError 弹给用户。
        if (data === null) {
          return { ok: false, why: `服务端返回了非 JSON 内容（HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}）` }
        }
        // 后端的结构化错误（{ok:false, why}）要原样交给调用方，但把状态码补进 why：
        //   否则「清理规则保存失败」这种话看不出是 500 还是 403。
        const body = typeof data === 'object' && !Array.isArray(data) ? data : { ok: false }
        if (!('ok' in body)) body.ok = false
        const code = `HTTP ${r.status}`
        body.why = body.why ? `${code}：${body.why}` : code
        return body
      }
      if (data === null) throw new Error(`服务端返回了非 JSON 内容（HTTP ${r.status}）`)
      return data
    }
    const jget = (p) => request(p)
    const jpost = (p, body) =>
      request(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    const CSS = `
[data-bl-page]{display:flex;flex-direction:column;gap:12px;padding:4px 2px 10px;max-width:720px;font-size:13px;}
[data-bl-head]{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
[data-bl-title]{font-size:14px;font-weight:600;}
[data-bl-sub]{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9099);}
[data-bl-sec]{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));padding-top:10px;}
[data-bl-sec-title]{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);}
[data-bl-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:28px;}
[data-bl-dot]{width:8px;height:8px;border-radius:50%;flex:none;}
[data-bl-dot="ok"]{background:#3c9a5f;}
[data-bl-dot="bad"]{background:#d9534f;}
[data-bl-name]{min-width:150px;flex:none;}
[data-bl-detail]{flex:1;min-width:140px;color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;word-break:break-all;}
[data-bl-size]{flex:none;color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;min-width:64px;text-align:right;}
[data-bl-overlay-icon]{font-size:14px;line-height:1;color:#d97706}
[data-bl-overlay-text]{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;overflow:hidden}[data-bl-overlay-line]{display:flex;align-items:baseline;gap:8px;overflow:hidden}[data-bl-overlay-hint]{font-size:11.5px;color:#a16207;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-bl-overlay-text b]{font-weight:600;white-space:nowrap}
[data-bl-overlay-sub]{color:#9a6a1e;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-bl-overlay-actions]{display:flex;gap:8px;align-items:center;flex-shrink:0}
[data-bl-btn]{font-size:12px;min-height:26px;padding:2px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:transparent;color:inherit;flex:none;}
[data-bl-btn:disabled]{opacity:.45;cursor:default;}
[data-bl-input]{width:64px;font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:transparent;color:inherit;}
[data-bl-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a9099);}
/* 2026-10-28：凭证行的「文件：<长路径>」原来挤在同一 flex 行里，把更新时间那一列压到几十像素、
   中文被逐字换行成竖排。让 note 在 flex 行里独占一行（flex-basis:100%），并允许长路径整词断开。 */
[data-bl-row] [data-bl-note]{flex-basis:100%;min-width:0;word-break:break-all;}
[data-bl-bad]{color:#d9534f;}
[data-bl-good]{color:#3c9a5f;}
[data-bl-qrbox]{display:flex;gap:16px;align-items:center;flex-wrap:wrap;}
[data-bl-qr]{flex:none;width:220px;height:220px;background:#fff;padding:6px;border-radius:8px;}
[data-bl-qr svg]{width:100%;height:100%;display:block;}
[data-bl-qrside]{display:flex;flex-direction:column;gap:10px;max-width:320px;}
[data-bl-sechead]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-bl-sechead] [data-bl-sec-title]{margin-right:auto;}
[data-bl-dlg]{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:8px;padding:10px;gap:8px;}
[data-bl-dlgrow]{display:flex;align-items:center;gap:8px;font-size:12px;min-height:24px;}
[data-bl-dlgrow] input{accent-color:#3c9a5f;}
`

    const fmtBytes = (b) => {
      const n = Number(b) || 0
      if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
      return (n / 1024).toFixed(1) + ' KB'
    }
    const fmtTime = (t) => {
      if (!t) return '—'
      const d = new Date(t)
      return Number.isNaN(d.getTime()) ? String(t) : d.toLocaleString('zh-CN', { hour12: false })
    }

    // ORIGIN：面板自己的地址。**不写死 127.0.0.1:3080** —— 用户改过端口时写死的地址会指向错的地方。
    const ORIGIN = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : ''

    // COPY_DEPS：与 审查/20261031-复制提示词三稿.md 里的代码块逐字节一致（verify 有断言盯着）。
    //   String.raw 是必须的——正文里有 .venv-asr\Scripts\python.exe，普通模板字符串会把 \S 吃掉。
    const COPY_DEPS = String.raw`我在用 DSH 的 bili-watch 插件（B 站看内容），现在依赖装不上：面板「运行依赖」里有一行永远是红的，或者我点了「下载」一直没反应。

请只做只读排查：不要改任何配置、不要删文件、不要装任何东西、不要重启任何东西。需要改动的地方，先列出来问我。

只读排查要做的事：

1) 先确定这台机器的 DSH 主目录：环境变量 DSH_HOME 有值就用它，否则 Windows 用 %USERPROFILE%\.dsh、macOS/Linux 用 ~/.dsh。下面所有路径都按它拼，不要写死盘符。

2) 读插件自己报的依赖状态：GET ${ORIGIN}/api/bili-watch/status（面板地址用浏览器地址栏里那个，端口可能被人改过）。只要 data.deps 这一段：它有七行 —— 六项运行依赖（id 分别是 ffmpeg / ytdlp / asr / ocr / model / cuda）加一行 B 站登录凭证（id 是 credential），每行有 ok、detail、path。把七行的 id、ok、detail、path 原样列给我，并指出哪一行 ok=false、它的 detail 原文是什么。
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
`

    // COPY_ASR：与 审查/20261031-复制提示词三稿.md 里的代码块逐字节一致（verify 有断言盯着）。
    //   String.raw 是必须的——正文里有 .venv-asr\Scripts\python.exe，普通模板字符串会把 \S 吃掉。
    const COPY_ASR = String.raw`我在用 DSH 的 bili-watch 插件（B 站看内容），转写（ASR）或画面文字识别（OCR）一直失败：跑转写时报错，或者每次都悄悄回落到 CPU 速度。

请只做只读排查：不要改配置、不要删文件、不要装东西、不要重跑长时间的任务、不要重启任何东西。需要改动的地方，先列出来问我。

1) 确定 DSH 主目录：环境变量 DSH_HOME 有值就用它，否则 Windows 用 %USERPROFILE%\.dsh、macOS/Linux 用 ~/.dsh。依赖目录默认在 <DSH 主目录>/bili-watch/deps/，插件实际在用的目录以 GET ${ORIGIN}/api/bili-watch/status 返回的 deps[].path 为准。

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
`

    // COPY_PANEL：与 审查/20261031-复制提示词三稿.md 里的代码块逐字节一致（verify 有断言盯着）。
    //   String.raw 是必须的——正文里有 .venv-asr\Scripts\python.exe，普通模板字符串会把 \S 吃掉。
    const COPY_PANEL = String.raw`我在用 DSH 的 bili-watch 插件（B 站看内容），面板打不开或者点了没反应：插件列表里报错、面板一直转圈、或点了某个按钮没有任何反应。

请只做只读排查：不要改配置、不要删文件、不要重启宿主、不要装东西。需要改动的地方，先列出来问我。

1) 先确定面板地址：用浏览器地址栏里 DSH 面板的实际地址（端口可能被改过，不要假设默认端口），记作 ${ORIGIN}。

2) 读插件自己的状态接口：GET ${ORIGIN}/api/bili-watch/status
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
`
    // 一键复制：把一段**纯文本**写进剪贴板。做法抄 dsh-memory-shield：
    //   navigator.clipboard 不可用时要说「复制失败」，不能静默。
    //   根节点用 span + inline-flex —— 用 div 会把 sechead 的 flex 行撑开。
    function CopyButton({ text, label }) {
      const [status, setStatus] = React.useState('idle') // idle | ok | fail
      const timerRef = React.useRef(null)
      React.useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
      }, [])
      const onClick = async () => {
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('当前环境不支持 navigator.clipboard.writeText')
          }
          await navigator.clipboard.writeText(text)
          setStatus('ok')
        } catch (e) {
          console.warn('[dsh-bili-watch] 复制失败：' + (e && e.message ? e.message : e))
          setStatus('fail')
        }
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setStatus('idle'), 2000)
      }
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('button', { 'data-bl-btn': '', onClick }, label),
        status === 'ok' ? h('span', { 'data-bl-good': '' }, '已复制') : null,
        status === 'fail' ? h('span', { 'data-bl-bad': '' }, '复制失败') : null)
    }

    function DepRow({ d, busy, onDownload, onDelete }) {
      const canDownload = canDownloadRow(d)
      return h('div', { 'data-bl-row': '' },
        h('span', { 'data-bl-dot': d.ok ? 'ok' : 'bad' }),
        h('span', { 'data-bl-name': '' }, d.name),
        h('span', { 'data-bl-detail': '' }, d.ok ? d.detail : h('span', { 'data-bl-bad': '' }, d.detail)),
        h('span', { 'data-bl-size': '' }, d.ok ? fmtBytes(d.size) : d.estimate),
        d.id === 'credential'
          ? h('button', { 'data-bl-btn': '', onClick: () => onDownload('login') }, d.ok ? '重新扫码' : '去扫码登录')
          : canDownload
            ? h('button', { 'data-bl-btn': '', disabled: busy, onClick: () => onDownload(d.id) }, busy ? '下载中…' : '一键下载')
            : null,
        d.id === 'credential'
          ? h('button', { 'data-bl-btn': '', disabled: !d.ok, onClick: () => onDelete(d.id) }, '清除凭证')
          : d.removable
            ? h('button', { 'data-bl-btn': '', onClick: () => onDelete(d.id) }, '删除')
            : h('button', { 'data-bl-btn': '', disabled: true, title: d.removableWhy || '不在插件目录内' }, '删除'),
        d.id === 'credential' && d.path ? h('span', { 'data-bl-note': '' }, '文件：' + d.path) : null,
      )
    }

    // 参数分层（2026-10-28 阶段B）：一项 = 输入框 + 默认值提示 + 范围 + 一句话后果 + 恢复默认。
    // 只写 h()，不引新依赖；保存/恢复都由外面传进来的回调走 /config。
    // 2026-10-28 老大要求「高级设置放开」：这 8 项原来是代码里的硬编码，现在都能在面板里调。
    // 元数据跟后端 TUNING_DEFS 一一对应（键名、默认值、上下界都从 /status 的 tuningDefaults/tuningRanges 取，
    // 这里只放文案），加项时后端 TUNING_DEFS 与这张表各加一行即可。
    const ADV_TUNING = [
      { key: 'asrMemMB', label: '转写内存门槛', unit: 'MB', def: '1536', hint: '该值用于控制本地转写的内存门槛。可用内存低于此值时跳过转写、降级至字幕或抽帧；增大后更早放弃转写，减小后内存紧张时仍强制执行可能崩溃。默认 1536 MB。' },
      { key: 'lockTtlMin', label: '残留锁过期', unit: '分钟', def: '30', hint: '该值用于控制残留锁的过期时长。进程异常退出后锁文件超过此时长视为过期，新任务可接管；缩短后运行中的长转写可能被误判过期，延长后残留锁阻塞更久。默认 30 分钟。' },
      { key: 'unitLimit', label: '单条内容上限', unit: '字', def: '5000', hint: '该值用于控制单条评论或弹幕的截断阈值。超出时截断并标注省略字数；增大后内容更完整但占用更多上下文，减小后省上下文但长评论截断更短。默认 5000 字。' },
      { key: 'textLimit', label: '文本层默认字数', unit: '字', def: '800', hint: '该值用于控制文本层单次返回正文上限。超出时仅返回开头摘要与落盘路径；增大后对话内正文更长但占用更多上下文，减小后更早落盘。默认 800 字。' },
      { key: 'toolTextCap', label: '工具层总字数', unit: '字', def: '2000', hint: '该值用于控制工具层单次返回正文总上限。增大后每次工具返回的正文更长，占用更多对话上下文；减小后更早落盘。默认 2000 字。' },
      { key: 'toolHead', label: '工具层默认头部', unit: '字', def: '800', hint: '该值用于控制工具层默认返回的正文头部字数，超出部分写入落盘文件。增大后对话内暴露更多开头内容，减小后更早切换至落盘路径。默认 800 字。' },
      { key: 'dmBucketSec', label: '弹幕分桶宽度', unit: '秒', def: '30', hint: '该值用于控制弹幕热区的分桶时长。增大后热区粒度更粗、覆盖更长时段；减小后定位更精确但可能分散。默认 30 秒。' },
      { key: 'dmTop', label: '弹幕热区条数', unit: '桶', def: '5', hint: '该值用于控制弹幕热区输出的桶数。增大后列出更多时段但输出更长；减小后仅保留最突出时段。默认 5 桶。' },
      { key: 'downloadMaxMB', label: '单文件下载上限', unit: 'MB', def: '512', hint: '该值用于控制单个媒体文件的下载体积上限。超出时下载中止，需增大后重试；增大后允许更大文件但增加磁盘与带宽占用，减小后拒绝大文件。默认 512 MB。' },
      { key: 'subRateMin10', label: '字幕语速下限 ×10', unit: '（20=2.0 字/秒）', def: '20', hint: '该值用于控制字幕语速下限（×10，即 2.0 字/秒），低于此值判定为「字幕可疑」。减小后慢口播更不易误判但可能漏检诱饵，增大后慢口播更易误判。默认 2.0 字/秒。' },
      { key: 'subRateMax10', label: '字幕语速上限 ×10', unit: '（85=8.5 字/秒）', def: '85', hint: '该值用于控制字幕语速上限（×10，即 8.5 字/秒），高于此值判定为「字幕可疑」。增大后快语速更不易误判但可能漏检，减小后快语速更易误判。默认 8.5 字/秒。' },
      { key: 'textBrief', label: '超长文本摘要字数', unit: '字', def: '400', hint: '该值用于控制超长文本的摘要长度。正文超过「文本层默认字数」时，对话内仅返回开头这么多字，全文落盘；增大后摘要更完整但增加上下文占用，减小后摘要更短。默认 400 字。' },
    ]
    function TuneRow({ label, value, unit, onChange, onSave, onRestore, def, range, hint }) {
      return h('div', { 'data-bl-row': '' },
        h('span', { 'data-bl-name': '' }, label),
        h('span', { 'data-bl-detail': '' },
          h('input', { 'data-bl-input': '', value, onChange: (e) => onChange(e.target.value), inputMode: 'numeric' }),
          unit ? h('span', {}, ' ' + unit) : null,
          h('span', { 'data-bl-note': '' }, `默认 ${def}，范围 ${range}。${hint}`)),
        h('button', { 'data-bl-btn': '', onClick: onSave }, '保存'),
        h('button', { 'data-bl-btn': '', onClick: onRestore }, '恢复默认'))
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [saveErr, setSaveErr] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [days, setDays] = React.useState('7')
      const [maxMb, setMaxMb] = React.useState('2048')
      // 参数分层：转写闸门在面板按分钟编辑，deps-config 里存的是秒（asrMaxSec）
      const [asrMin, setAsrMin] = React.useState('30')
      // 第十条（2026-10-29）：ASR 推理设备。面板上是「转写时用 GPU」一个开关（开=auto / 关=cpu），
      //   后端存的是枚举字符串，不是布尔——所以这里单独一个 state，不走 TuneRow 的数值通道。
      const [asrDev, setAsrDev] = React.useState('auto')
      const [frames, setFrames] = React.useState('500')
      const [asrTmo, setAsrTmo] = React.useState('900')
      const [ffTmo, setFfTmo] = React.useState('300')
      const [cmdTmo, setCmdTmo] = React.useState('180')
      const [advOpen, setAdvOpen] = React.useState(false)
      // 高级设置那 8 项统一放在一个对象里，避免再加 8 个 useState
      const [advVals, setAdvVals] = React.useState({})
      const [tuneMeta, setTuneMeta] = React.useState(null)
      const [qr, setQr] = React.useState(null)
      const [qrState, setQrState] = React.useState('')
      const [dlg, setDlg] = React.useState(null) // 'download' | 'clean'
      const [picked, setPicked] = React.useState([])
      // BLK-03（2026-10-28）：8 秒轮询原来无条件把输入框重置成服务端值，用户改完天数还没点保存
      //   就被改回 7。用 ref 记「用户动过输入框」，轮询见到就跳过覆盖，保存成功后复位。
      const dirtyRef = React.useRef(false)
      const markDirty = () => { dirtyRef.current = true }

      const load = React.useCallback(async () => {
        try {
          const j = await jget('/status')
          if (j.ok) {
            setSt(j.data)
            setErr('')
            // 参数分层：初值取 /status 的 tuning / tuningDefaults / tuningRanges
            const tv = j.data.tuning || {}
            const td = j.data.tuningDefaults || {}
            const tr = j.data.tuningRanges || {}
            setTuneMeta({ defaults: td, ranges: tr })
            if (!dirtyRef.current) {
              setDays(String(j.data.cache?.days ?? 7))
              setMaxMb(String(j.data.cache?.maxMb ?? 2048))
              const sec = Number(tv.asrMaxSec ?? td.asrMaxSec ?? 1800)
              setAsrMin(String(Math.round(sec / 60)))
              setAsrDev(String(tv.asrDevice ?? td.asrDevice ?? 'auto'))
              setFrames(String(tv.maxFrames ?? td.maxFrames ?? 500))
              setAsrTmo(String(tv.asrTimeoutSec ?? td.asrTimeoutSec ?? 900))
              setFfTmo(String(tv.ffmpegTimeoutSec ?? td.ffmpegTimeoutSec ?? 300))
              setCmdTmo(String(tv.cmdTimeoutSec ?? td.cmdTimeoutSec ?? 180))
              setAdvVals(Object.fromEntries(ADV_TUNING.map((x) => [x.key, String(tv[x.key] ?? td[x.key] ?? x.def)])))
            }
          } else {
            setErr(j.why || '状态读取失败')
          }
        } catch (e) {
          setErr(String(e?.message || e))
        }
      }, [])

      React.useEffect(() => {
        load()
        const t = setInterval(load, 8000)
        return () => clearInterval(t)
      }, [load])

      // 二维码出现后每 2.5 秒问一次扫码结果；成功就刷新依赖状态（凭证会变绿）
      React.useEffect(() => {
        if (!qr?.key) return undefined
        let stop = false
        // B-04/B-05（2026-10-29）：以前只靠 B 站自己回 86038 才停，手机端点取消后 B 站仍回 86101，
        //   用户要干等 180 秒；断网时 catch 里每 4 秒无限重试、没有上限。这里加两道硬闸：
        //   ① 从二维码生成起算 180 秒总超时，到点自己停；② 连续失败 5 次（≈20 秒）就停。
        const deadline = Date.now() + 180 * 1000
        let fails = 0
        const stopWith = (state, msg) => {
          stop = true
          setQr(null)
          setQrState(state)
          setMsg(msg)
        }
        const tick = async () => {
          if (stop) return
          if (Date.now() > deadline) {
            stopWith('expired', '二维码已过期（超过 3 分钟），请点击「重新扫码」重试。')
            return
          }
          try {
            const j = await jpost('/login/poll', { key: qr.key })
            if (stop) return
            // E4-03 / #10（2026-10-30，P1）：状态判断统一走 pollStep，认不出的状态不算「等待中」。
            const step = pollStep(j)
            if (step.act !== 'retry') fails = 0
            if (step.act === 'ok') {
              stop = true
              setQr(null)
              setQrState('ok')
              setMsg('登录成功，凭证已保存。')
              await load()
              return
            }
            if (step.act === 'stop') {
              stop = true
              setQrState(step.state)
              setMsg(step.why || (step.state === 'expired' ? '二维码已过期，请点击「重新扫码」重试。' : '轮询失败'))
              return
            }
            if (step.act === 'retry') {
              fails += 1
              if (fails >= 5) {
                stopWith('error', `登录轮询失败：${step.why}。请重新扫码。`)
                return
              }
              setTimeout(tick, 4000)
              return
            }
            setQrState(step.state)
            setTimeout(tick, 2500)
          } catch (e) {
            if (stop) return
            fails += 1
            if (fails >= 5) {
              stopWith('error', '网络中断，登录已暂停，请检查网络后重新扫码。')
              return
            }
            setTimeout(tick, 4000)
          }
        }
        const t = setTimeout(tick, 1500)
        return () => {
          stop = true
          clearTimeout(t)
        }
      }, [qr, load])

      const startLogin = async () => {
        setMsg('')
        setQr(null)
        setQrState('loading')
        try {
          const j = await jpost('/login/qr', {})
          if (j.ok) {
            setQr(j.data)
            setQrState('waiting')
          } else {
            setQrState('error')
            setMsg('生成二维码失败：' + (j.why || '未知错误'))
          }
        } catch (e) {
          setQrState('error')
          setMsg(String(e?.message || e))
        }
      }

      const download = async (target) => {
        if (target === 'login') {
          await startLogin()
          return
        }
        setBusy(target)
        setMsg('')
        try {
          const j = await jpost('/download', { target })
          const r = readDownloadResp(j)
          if (r.good.length && !r.bad.length) {
            setMsg(`已开始下载（日志 ${r.log || 'deps/download.log'}）。下载期间请保持面板打开——宿主退出会中断下载，重进面板可重新下；完成后点击刷新查看状态。`)
          } else if (r.good.length && r.bad.length) {
            setMsg(`部分已开始（${r.good.length} 项）；失败 ${r.bad.length} 项：${r.why || '原因未知'}`)
          } else if (!r.results.length && (j?.ok || r.log)) {
            // 老形状 / 空 results 但整体成功：别退化成「启动失败」
            setMsg(`已开始下载（日志 ${r.log || 'deps/download.log'}）。下载期间请保持面板打开——宿主退出会中断下载，重进面板可重新下；完成后点击刷新查看状态。`)
          } else {
            setMsg(r.why || '启动失败')
          }
        } catch (e) {
          setMsg(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const saveCache = async () => {
        try {
          const j = await jpost('/cache/clear', { days: Number(days), maxMb: Number(maxMb) })
          // D07（2026-10-29）：后端从 767528f 起就会把「本插件的数据但没删掉」收进 data.failed
          //   （removeOwned / autoCleanCache 两处同口径），路由层因此回 ok:false + why「部分失败：N 项」。
          //   但面板原来只显示 why 那半句：成功删了几个、失败的是哪几个文件、为什么删不掉，全丢了，
          //   用户看到的是一句「部分失败：3 项」，既不知道成没成，也不知道该关哪个程序。
          //   这里按「成功数 / 失败清单 / 处置建议」三段拼，失败项带文件名与系统原因（最多列 5 个）。
          const d = j?.data || {}
          const removed = Number(d.removed || 0)
          const failed = Array.isArray(d.failed) ? d.failed : []
          if (j?.ok === false && failed.length) {
            const list = failed.slice(0, 5).map((f) => `${f.name}（${f.why}）`).join('、')
            setMsg(
              `缓存清理完成：成功 ${removed} 个 / ${fmtBytes(Number(d.bytes || 0))}，` +
              `失败 ${failed.length} 项 —— ${list}${failed.length > 5 ? ` 等 ${failed.length} 项` : ''}。` +
              '删不掉通常是文件正被 ffmpeg / 转写进程占用、目录只读，或路径过长；关掉占用后重试即可。',
            )
          } else if (j?.ok === false) {
            setMsg(j.why || '清理缓存失败')
          } else {
            setMsg(`缓存已清理（${removed} 个文件 / ${fmtBytes(Number(d.bytes || 0))}）；此后按 ${days} 天、${maxMb} MB 自动清理`)
          }
          dirtyRef.current = false
          await load()
        } catch (e) {
          setMsg(String(e?.message || e))
        }
      }

      const saveRule = async () => {
        // D-09（2026-10-29）：保留天数/总量上限填了非数字时，以前照样发、照样弹「已保存」，
        //   服务端 Number.isFinite(null)=false 直接跳过，规则其实没变。
        const d = Number(days)
        const m = Number(maxMb)
        if (!Number.isFinite(d) || !Number.isFinite(m)) {
          setMsg('保留天数与总量上限都要填数字，未保存。')
          return
        }
        try {
          const j = await jpost('/config', { days: d, maxMb: m })
          setMsg(j?.ok === false ? ('保存失败：' + (j.why || '未知错误')) : '自动清理规则已保存。')
          if (j?.ok !== false) { dirtyRef.current = false; await load() }
        } catch (e) {
          // A2（2026-10-27 批次8）：原来 catch{} 静默吞，保存失败用户完全无感——现在显式提示
          setMsg('保存失败：' + String(e?.message || e))
        }
      }

      // D-01/D-02（2026-10-29）：填了非数字（Number('abc')=NaN）或超出范围的数字时，以前照样发请求、
      //   照样弹「已保存」——服务端把 NaN 序列化成 null 当成「恢复默认」把键删了，用户下次打开才发现值变回默认。
      //   这里在发请求前先拦，返回非空字符串就是拦下的原因。
      const tuneBad = (patch, label) => {
        const ranges = tuneMeta?.ranges || {}
        for (const [k, v] of Object.entries(patch || {})) {
          if (v === null) continue // 恢复默认，合法
          if (typeof v !== 'number') continue // 枚举项（asrDevice）走字符串，交给服务端白名单
          const name = label || k
          if (!Number.isFinite(v)) return `${name}需填数字，未保存。`
          const r = ranges[k]
          if (Array.isArray(r) && (v < r[0] || v > r[1])) return `${name}需在 ${r[0]}–${r[1]} 之间，未保存。`
        }
        return ''
      }
      // 参数分层：保存一项（patch 里只带一个键）；恢复默认 = POST 该键为 null
      const saveTune = async (patch, okText, label) => {
        const bad = tuneBad(patch, label)
        if (bad) {
          setMsg(bad)
          return
        }
        try {
          const j = await jpost('/config', patch)
          if (j?.ok === false) {
            setMsg('保存失败：' + (j.why || '未知错误'))
            return
          }
          setMsg(okText)
          dirtyRef.current = false
          await load()
        } catch (e) {
          setMsg('保存失败：' + String(e?.message || e))
        }
      }
      const saveAsrMax = () => {
        const m = Number(asrMin)
        const sec = Math.round(m * 60)
        // 服务端 asrMaxSec 范围 300–3600 秒；超界会被静默回落默认值，这里先拦一下免得用户以为存上了
        if (!Number.isFinite(m) || sec < 300 || sec > 3600) {
          setMsg('转写闸门需在 5–60 分钟之间（服务端上限 3600 秒），未保存。')
          return
        }
        saveTune({ asrMaxSec: sec }, `转写闸门已保存（${m} 分钟）。`)
      }

      const rows = st?.deps || []
      // ADD-1（2026-10-29）：批量清理默认只勾「删了能一分钟重下」的行。
      //   原来 `d.removable && d.ok` 把凭证行也勾上了——用户点「确定」顺手把登录态删了，
      //   而恢复要重新扫码。模型（460 MB 重下）同理。venv 本来就 removable:false，不在候选里。
      const CHEAP_TO_REMOVE = new Set(['ytdlp'])
      // 打开批量弹层：默认全勾选（可下载 = 缺的且不是凭证；可清理 = 插件目录内且已存在）
      const openDlg = (kind) => {
        if (kind === 'download') setPicked(rows.filter(canDownloadRow).map((d) => d.id))
        else setPicked(rows.filter((d) => d.removable && d.ok && CHEAP_TO_REMOVE.has(d.id)).map((d) => d.id))
        setDlg(kind)
      }
      const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

      const confirmDlg = async () => {
        const kind = dlg
        setDlg(null)
        if (kind === 'download') {
          if (!picked.length) {
            setMsg('没有勾选可下载的项。')
            return
          }
          // 下一批（2026-10-29）：原来这里是 `try { await jpost(...) } catch {}` 逐项吞错——
          //   N 个目标全部失败，照样弹「已启动 N 个下载」。request() 已经把超时/非 2xx 变成人话，
          //   这里再一吞就全白改。按 saveCache 同款口径收失败清单：全失败说「一个都没启动」，
          //   部分失败报成功数 + 失败清单（带目标名与原因）。
          const bad = []
          for (const t of picked) {
            try {
              const j = await jpost('/download', { target: t })
              // #9（2026-10-30，P1）：原来这里只看 j.ok / j.why——后端 ok:true 但这一项没启动时
              //   （宿主 Job Object 被杀、脚本不存在、目标名不认识），批量会把失败算成成功。
              const r = readDownloadResp(j)
              if (!r.allStarted) bad.push(`${t}（${r.why || '后端未受理'}）`)
            } catch (e) {
              bad.push(`${t}（${String(e?.message || e)}）`)
            }
          }
          const okN = picked.length - bad.length
          const badTail = `${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 项` : ''}`
          if (!okN) setMsg(`下载没有启动：${picked.length} 个目标全部失败 —— ${badTail}。`)
          else if (bad.length) setMsg(`已启动 ${okN} 个下载，${bad.length} 个失败 —— ${badTail}。稍后点击刷新查看状态。`)
          else setMsg(`已启动 ${okN} 个下载（下载期间请保持面板打开，宿主退出会中断）。`)
          return
        }
        if (!picked.length) {
          setMsg('没有勾选可清理的项。')
          return
        }
        try {
          const j = await jpost('/delete', { targets: picked })
          const d = j.data || {}
          setMsg(fmtDelMsg(d))
          await load()
        } catch (e) {
          setMsg('删除失败：' + String(e?.message || e))
        }
      }

      const delOne = async (target) => {
        const row = rows.find((d) => d.id === target)
        const label = target === 'credential' ? '登录凭证（删除后需重新扫码）' : (row?.name || target)
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(`确定删除 ${label}？`)) return
        }
        try {
          const j = await jpost('/delete', { targets: [target] })
          const d = j.data || {}
          // E4-02：不能只看 deleted 非空就报成功——credential 会同时出现在 deleted 与 skipped 里
          setMsg(fmtDelMsg(d))
          await load()
        } catch (e) {
          setMsg('删除失败：' + String(e?.message || e))
        }
      }

      if (err) return h('div', { 'data-bl-page': '' }, h('div', { 'data-bl-bad': '' }, '状态读取失败：' + err))
      if (!st) return h('div', { 'data-bl-page': '' }, h('div', { 'data-bl-note': '' }, '读取中…'))

      const deps = st.deps || []
      const cache = st.cache || { bytes: 0, files: 0 }
      const lastRun = st.lastRun || {}

      return h('div', { 'data-bl-page': '' },
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-sechead': '' },
            h('span', { 'data-bl-sec-title': '' }, '显示'),
            h('label', { 'data-bl-dlgrow': '' },
              h('input', {
                type: 'checkbox',
                checked: st.ui?.showInSettings !== false,
                onChange: async (e) => {
                  const v = e.target.checked
                  try {
                    await jpost('/config', { showInSettings: v })
                    setSaveErr('')
                    try { window.__biliWatchSyncSettings && window.__biliWatchSyncSettings(v) } catch {}
                    await load()
                  } catch (e) {
                    // 用独立状态：load() 成功后会把 err 清空，写进 err 等于这条提示活不过一帧。
                    setSaveErr(`保存失败：服务端未确认，刷新后可能回滚（${String(e?.message || e)}）`)
                    await load()
                  }
                },
              }),
              h('span', { 'data-bl-name': '' }, '在设置页也显示'),
            ),
          ),
          h('div', { 'data-bl-note': '' }, '关掉只隐藏设置页入口；插件详情页这块面板一直保留。'),
          saveErr ? h('div', { 'data-bl-note': '', style: { color: '#c0392b' } }, saveErr) : null,
          (st.warnings || []).length
            ? h('div', { 'data-bl-note': '', style: { color: '#b36b00' } }, st.warnings.join('；'))
            : null,
        ),
        h('div', { 'data-bl-head': '' },
          h('span', { 'data-bl-title': '' }, '依赖与状态'),
          h('span', { 'data-bl-sub': '' }, '缺失项点击行末按钮安装，完成后状态显示为已就绪。')),
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-sechead': '' },
            h('span', { 'data-bl-sec-title': '' }, '运行依赖'),
            h('button', { 'data-bl-btn': '', onClick: () => openDlg('download') }, '批量下载'),
            h('button', { 'data-bl-btn': '', onClick: () => openDlg('clean') }, '批量清理')),
          ...deps.map((d) => h(DepRow, { key: d.id, d, busy: busy === d.id, onDownload: download, onDelete: delOne })),
          h('div', { 'data-bl-note': '' },
            '下载由内置 fetch-deps 脚本执行，需保持面板打开（宿主退出会中断）；体积为预估值，实际以完成后为准。')),
        dlg
          ? h('div', { 'data-bl-sec': '', 'data-bl-dlg': '' },
              h('span', { 'data-bl-sec-title': '' }, dlg === 'download' ? '批量下载（默认全勾选，可取消）' : '批量清理（默认全勾选，可取消）'),
              ...(dlg === 'download'
                ? deps
                    .filter((d) => d.id !== 'credential')
                    .map((d) =>
                      h('label', { 'data-bl-dlgrow': '' },
                        h('input', { type: 'checkbox', checked: picked.includes(d.id), disabled: d.ok, onChange: () => toggle(d.id) }),
                        h('span', { 'data-bl-name': '' }, d.name),
                        h('span', { 'data-bl-size': '' }, d.estimate),
                        d.ok ? h('span', { 'data-bl-good': '' }, '已就绪，跳过') : null),
                    )
                : deps.map((d) =>
                    h('label', { 'data-bl-dlgrow': '' },
                      h('input', {
                        type: 'checkbox',
                        checked: picked.includes(d.id),
                        disabled: !d.removable || !d.ok,
                        onChange: () => toggle(d.id),
                      }),
                      h('span', { 'data-bl-name': '' }, d.name),
                      h('span', { 'data-bl-size': '' }, d.path || ''),
                      d.removable
                        ? d.ok
                          ? h('span', { 'data-bl-good': '' }, '可清理')
                          : h('span', { 'data-bl-note': '' }, '无可清理项')
                        : h('span', { 'data-bl-note': '' }, d.removableWhy || '不在插件目录内'),
                    ),
                  )),
              h('div', { 'data-bl-row': '' },
                h('button', { 'data-bl-btn': '', onClick: confirmDlg }, dlg === 'download' ? '开始下载' : '确认删除'),
                h('button', { 'data-bl-btn': '', onClick: () => setDlg(null) }, '取消')))
          : null,
        qr
          ? h('div', { 'data-bl-sec': '' },
              h('span', { 'data-bl-sec-title': '' }, '扫码登录'),
              h('div', { 'data-bl-qrbox': '' },
                h('span', { 'data-bl-qr': '', dangerouslySetInnerHTML: { __html: qr.svg } }),
                h('div', { 'data-bl-qrside': '' },
                  h('div', { 'data-bl-note': '' },
                    qrState === 'scanned'
                      ? '请在 B 站手机客户端中确认登录。'
                      : qrState === 'loading'
                        ? '正在生成二维码…'
                        : '请使用 B 站手机 App 扫描二维码，确认后自动刷新登录状态。'),
                  h('button', { 'data-bl-btn': '', onClick: () => { setQr(null); setQrState('') } }, '取消'))))
          : null,
        // 「遇到问题」区：稿一（依赖装不上 / 有一行永远红）与稿二（转写或 OCR 失败）。
        //   两稿动作相同——读文件 + 跑一条只读命令——所以可以放同一节，但**按钮标签必须是症状本身**：
        //   统一叫「复制排查提示词」等于把三稿当一份用，是参考实现踩过的坑。
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-sechead': '' },
            h('span', { 'data-bl-sec-title': '' }, '遇到问题'),
            h(CopyButton, { text: COPY_DEPS, label: '依赖装不上' }),
            h(CopyButton, { text: COPY_ASR, label: '转写/OCR 失败' })),
          h('div', { 'data-bl-note': '' },
            '复制对应症状的那一段，发给你自己机器上的 agent：它会按稿里的步骤只读排查，不会改你的配置。')),
        // 「面板打不开」区：稿三单独一节。理由是动作不同——稿一稿二读文件跑命令，
        //   稿三要开 Console 看 Network，混在一节里 agent 会以为三个都要做。
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-sechead': '' },
            h('span', { 'data-bl-sec-title': '' }, '面板打不开'),
            h(CopyButton, { text: COPY_PANEL, label: '面板打不开 / 点了没反应' })),
          h('div', { 'data-bl-note': '' },
            '这一份会要求你打开浏览器的开发者工具（Console 和 Network 两个标签页）。')),
        h('div', { 'data-bl-sec': '' },
          h('span', { 'data-bl-sec-title': '' }, '抽帧缓存'),
          h('div', { 'data-bl-row': '' },
            h('span', { 'data-bl-name': '' }, '当前占用'),
            h('span', { 'data-bl-detail': '' }, `${fmtBytes(cache.bytes)} / ${cache.files} 个文件`),
            h('button', { 'data-bl-btn': '', onClick: saveCache }, '立即清除')),
          // D07：自动清理（开机一次 + 每次轮询按天数/总量阈值跑）删不掉的文件，后端早就放在
          //   /status 的 cache.lastAutoClean.failed 里了，面板原来一句都不显示——于是「自动清理干净了」
          //   与「其实一个都没删掉」在界面上长得一模一样。这里只在有失败时多说一行，成功时不加噪音。
          Array.isArray(cache.lastAutoClean?.failed) && cache.lastAutoClean.failed.length
            ? h('div', { 'data-bl-row': '' },
              h('span', { 'data-bl-name': '' }, '上次自动清理'),
              h('span', { 'data-bl-detail': '', style: { color: '#b36b00' } },
                `${cache.lastAutoClean.failed.length} 项没删掉：` +
                cache.lastAutoClean.failed.slice(0, 5).map((f) => `${f.name}（${f.why}）`).join('、') +
                (cache.lastAutoClean.failed.length > 5 ? ` 等 ${cache.lastAutoClean.failed.length} 项` : '')))
            : null,
          h('div', { 'data-bl-row': '' },
            h('span', { 'data-bl-name': '' }, '位置'),
            h('span', { 'data-bl-detail': '' }, cache.dir || '(未设置)'),
            h('button', {
              'data-bl-btn': '',
              onClick: async () => {
                setSaveErr('')
                try {
                  const r = await jpost('/cache/pick', {})
                  if (r.ok && r.data?.dir) setMsg(`已选择：${r.data.dir}（重启 DSH 生效）`)
                  else if (r.ok === false) setMsg(r.why || '已取消')
                  else setMsg('选择失败')
                } catch (e) { setSaveErr(`选择目录失败：${String(e?.message || e)}`) }
              },
            }, '选择目录…')),
          h('div', { 'data-bl-row': '' },
            h('span', { 'data-bl-name': '' }, '改位置'),
            h('span', { 'data-bl-detail': '' }, '或用环境变量 BILI_WATCH_CACHE / deps/deps-config.json 的 "cache"；改完重启 DSH 生效。'),
            null),
          msg ? h('div', { 'data-bl-note': '' }, msg) : null,
          h('div', { 'data-bl-row': '' },
            h('span', { 'data-bl-name': '' }, '自动清理规则'),
            h('span', { 'data-bl-detail': '' },
              '保留 ',
              h('input', { 'data-bl-input': '', value: days, onChange: (e) => { markDirty(); setDays(e.target.value) }, inputMode: 'numeric' }),
              ' 天；总量超过 ',
              h('input', { 'data-bl-input': '', value: maxMb, onChange: (e) => { markDirty(); setMaxMb(e.target.value) }, inputMode: 'numeric' }),
              ' MB 时从最旧的删。'),
            h('button', { 'data-bl-btn': '', onClick: saveRule }, '保存规则')),
          h('div', { 'data-bl-note': '' },
            '即使不手动清理，也会按上述规则自动执行（每次打开面板与插件启动时检查一次）。')),
        // 参数分层（阶段B）常规组：不折叠。转写闸门按分钟显示，存的是秒。
        h('div', { 'data-bl-sec': '' },
          h('span', { 'data-bl-sec-title': '' }, '转写与抽帧'),
          // 第十条（2026-10-29）：转写设备开关。开=auto（有卡走 GPU，显存不足自动回落 CPU）/ 关=cpu。
          //   没有 NVIDIA 卡时也能切，但切到 auto 实际还是走 CPU——所以下面按 gpu 三态补一句说明。
          h('div', { 'data-bl-row': '' },
            h('label', { 'data-bl-dlgrow': '' },
              h('input', {
                type: 'checkbox',
                checked: asrDev === 'auto',
                onChange: async (e) => {
                  const v = e.target.checked ? 'auto' : 'cpu'
                  setAsrDev(v)
                  await saveTune({ asrDevice: v }, v === 'auto'
                    ? '转写已改为「用 GPU」（有卡就用，显存不足自动回落 CPU）。'
                    : '转写已改为「只用 CPU」。')
                },
              }),
              h('span', { 'data-bl-name': '' }, '转写时用 GPU'),
            ),
            h('span', { 'data-bl-note': '' },
              st.gpu && !st.gpu.deviceCount
                ? '本机没检测到 NVIDIA 卡，开了也走 CPU。'
                : (st.gpu && !st.gpu.dllReady
                  ? '有卡，但 GPU 运行库没装好——见上方「GPU 运行库」那一行。'
                  : '有卡且运行库就绪时比 CPU 约快 2 倍。'))),
          h(TuneRow, {
            label: '转写闸门',
            value: asrMin,
            unit: '分钟',
            onChange: (v) => { markDirty(); setAsrMin(v) },
            onSave: saveAsrMax,
            onRestore: () => saveTune({ asrMaxSec: null }, '转写闸门已恢复默认（30 分钟）。'),
            def: '30 分钟',
            range: `${Math.round((tuneMeta?.ranges?.asrMaxSec?.[0] ?? 300) / 60)}–${Math.round((tuneMeta?.ranges?.asrMaxSec?.[1] ?? 3600) / 60)} 分钟`,
            hint: '低于视频长度时，超长视频只出画面描述、不出字幕。',
          }),
          h(TuneRow, {
            label: '抽帧张数上限',
            value: frames,
            unit: '张',
            onChange: (v) => { markDirty(); setFrames(v) },
            onSave: () => saveTune({ maxFrames: Number(frames) }, '抽帧张数上限已保存。', '抽帧张数上限'),
            onRestore: () => saveTune({ maxFrames: null }, '抽帧张数上限已恢复默认（500 张）。'),
            def: '500 张',
            range: `${tuneMeta?.ranges?.maxFrames?.[0] ?? 100}–${tuneMeta?.ranges?.maxFrames?.[1] ?? 1000} 张`,
            hint: '抽得越多越费时间和磁盘，但关键画面更不容易漏。',
          }),
          h('div', { 'data-bl-row': '' },
            h('button', { 'data-bl-btn': '', onClick: () => setAdvOpen((v) => !v) },
              (advOpen ? '▾ ' : '▸ ') + '高级设置（一般保持默认）'))),
        // 高级设置：折叠，默认收起。改错会让长视频静默降级，所以放在折叠区里。
        advOpen
          ? h('div', { 'data-bl-sec': '' },
              h('span', { 'data-bl-sec-title': '' }, '高级设置（一般保持默认）'),
              h(TuneRow, {
                label: 'ASR 超时',
                value: asrTmo,
                unit: '秒',
                onChange: (v) => { markDirty(); setAsrTmo(v) },
                onSave: () => saveTune({ asrTimeoutSec: Number(asrTmo) }, 'ASR 超时已保存。', 'ASR 超时'),
                onRestore: () => saveTune({ asrTimeoutSec: null }, 'ASR 超时已恢复默认（900 秒）。'),
                def: '900 秒',
                range: `${tuneMeta?.ranges?.asrTimeoutSec?.[0] ?? 300}–${tuneMeta?.ranges?.asrTimeoutSec?.[1] ?? 3600} 秒`,
                hint: '太短会把长音频判成转写失败。',
              }),
              h(TuneRow, {
                label: 'ffmpeg 超时',
                value: ffTmo,
                unit: '秒',
                onChange: (v) => { markDirty(); setFfTmo(v) },
                onSave: () => saveTune({ ffmpegTimeoutSec: Number(ffTmo) }, 'ffmpeg 超时已保存。', 'ffmpeg 超时'),
                onRestore: () => saveTune({ ffmpegTimeoutSec: null }, 'ffmpeg 超时已恢复默认（300 秒）。'),
                def: '300 秒',
                range: `${tuneMeta?.ranges?.ffmpegTimeoutSec?.[0] ?? 60}–${tuneMeta?.ranges?.ffmpegTimeoutSec?.[1] ?? 1800} 秒`,
                hint: '太短会让大视频截帧失败。',
              }),
              h(TuneRow, {
                label: '命令超时',
                value: cmdTmo,
                unit: '秒',
                onChange: (v) => { markDirty(); setCmdTmo(v) },
                onSave: () => saveTune({ cmdTimeoutSec: Number(cmdTmo) }, '命令超时已保存。', '命令超时'),
                onRestore: () => saveTune({ cmdTimeoutSec: null }, '命令超时已恢复默认（180 秒）。'),
                def: '180 秒',
                range: `${tuneMeta?.ranges?.cmdTimeoutSec?.[0] ?? 60}–${tuneMeta?.ranges?.cmdTimeoutSec?.[1] ?? 900} 秒`,
                hint: '太短会让长视频的 text 命令超时。',
              }),
              // 2026-10-28 新增的 8 项：全部由 ADV_TUNING 驱动，加项只改那张表 + 后端 TUNING_DEFS
              ...ADV_TUNING.map((x) => h(TuneRow, {
                key: x.key,
                label: x.label,
                value: advVals[x.key] ?? x.def,
                unit: x.unit,
                onChange: (v) => { markDirty(); setAdvVals((s) => ({ ...s, [x.key]: v })) },
                onSave: () => saveTune({ [x.key]: Number(advVals[x.key] ?? x.def) }, `${x.label}已保存。`, x.label),
                onRestore: () => saveTune({ [x.key]: null }, `${x.label}已恢复默认（${x.def} ${x.unit}）。`),
                def: `${x.def} ${x.unit}`,
                range: (() => {
                  const r = tuneMeta?.ranges?.[x.key]
                  return r ? `${r[0]}–${r[1]} ${x.unit}` : `默认 ${x.def} ${x.unit}`
                })(),
                hint: x.hint,
              })),
              h('div', { 'data-bl-note': '' },
                '这几项会写进 deps/deps-config.json，改完立即生效，不用重启。「恢复默认」= 把这个键从配置里删掉。'))
          : null,
        h('div', { 'data-bl-sec': '' },
          h('span', { 'data-bl-sec-title': '' }, '最近一次调用'),
          h('div', { 'data-bl-row': '' },
            h('span', { 'data-bl-name': '' }, lastRun.command || '—'),
            h('span', { 'data-bl-detail': '' }, lastRun.time ? `${fmtTime(lastRun.time)}（${lastRun.ok ? '成功' : '失败'}）` : '还没有记录'),
            h('button', { 'data-bl-btn': '', onClick: load }, '刷新'))),
        msg ? h('div', { 'data-bl-note': '' }, msg) : null,
      )
    }

    // 内核的 shell.overlay 是 position:absolute;inset:0 的一层，子元素各自定位、不会自动堆叠，
    // 所以几个插件的顶部横幅都写 top:0 时会互相盖住，需要有东西统一往下排。
    //
    // 2026-10-25 改（P2-66）：原来每 2 秒全量重排一次，既白白占 CPU，也会把别人在两次重排之间
    // 自己调的 top 覆盖掉。现在只在真的变化时排：子节点增删（插件挂载/卸载）+ 容器高度变化。
    // 写 top 前先比较，值相同就不写——否则会触发自己观察到的再次变化，形成回环。
    // 只动 top 一个属性，其余内联样式不碰。
    function relayoutBanners() {
      const layer = document.querySelector('[data-shell-overlay]');
      if (!layer) return;
      let top = 0;
      for (const el of layer.children) {
        const height = el.offsetHeight;
        if (!height) continue;
        const want = top + 'px';
        if (el.style.top !== want) el.style.top = want;
        top += height;
      }
    }
    if (typeof window !== 'undefined' && !window.__dshBannerRelayout) {
      let scheduled = false;
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; relayoutBanners(); });
      };
      const layer = document.querySelector('[data-shell-overlay]');
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
      const watchHeights = () => {
        if (!ro) return;
        for (const el of document.querySelectorAll('[data-pmc-banner],[data-ms-overlay],[data-bl-overlay]')) ro.observe(el);
      };
      if (layer) {
        new MutationObserver(() => { schedule(); watchHeights(); }).observe(layer, { childList: true });
      }
      setTimeout(() => { relayoutBanners(); watchHeights(); }, 300);
      window.__dshBannerRelayout = true;
    }

    // 缺依赖横幅（shell.overlay）
    function OverlayBanner() {
      const [st, setSt] = React.useState(null)
      const [visible, setVisible] = React.useState(false)
      const [dismissed, setDismissed] = React.useState(false)

      React.useEffect(() => {
        jget('/status').then((j) => {
          if (!j.ok) return
          setSt(j.data)
          const missing = missingDeps(j.data.deps)
          if (missing.length > 0 && j.data.ui?.hintDismissed !== true) {
            setVisible(true)
          }
        }).catch(() => {})
      }, [])

      if (!visible || dismissed) return null
      const missing = missingDeps(st?.deps)
      const names = missing.map((d) => d.name).join('、')

      return h('div', { 'data-bl-overlay': '' },
        h('span', { 'data-bl-overlay-icon': '' }, '⚠'),
        h('span', { 'data-bl-overlay-text': '' },
          h('span', { 'data-bl-overlay-line': '' },
            h('b', {}, 'bili-watch 缺 ' + missing.length + ' 个依赖'),
            h('span', { 'data-bl-overlay-sub': '' }, names + '　—　元数据、评论、弹幕、搜索照常可用')),
          h('span', { 'data-bl-overlay-hint': '' }, '也可以到「设置 → bili-watch」的依赖面板里逐个安装，能看到进度和体积')),
        h('span', { 'data-bl-overlay-actions': '' },
          h('button', { 'data-bl-btn': 'primary', onClick: async () => { await jpost('/download', { target: 'all' }) } }, '去安装'),
          h('button', { 'data-bl-btn': 'ghost', onClick: () => setDismissed(true) }, '关闭'),
          h('button', { 'data-bl-btn': 'ghost', onClick: async () => {
            await jpost('/config', { hintDismissed: true })
            setDismissed(true)
          } }, '不再提示')),
      )
    }

    // 启用指引（plugins.bundle.activation）
    function ActivationGuide() {
      const [seen, setSeen] = React.useState(false)
      React.useEffect(() => {
        jget('/status').then((j) => {
          if (j.ok && j.data.ui?.activationSeen === true) setSeen(true)
        }).catch(() => {})
      }, [])
      if (seen) return null
      return h('div', { 'data-bl-activation': '' },
        h('div', { 'data-bl-title': '' }, 'B站看视频插件已启用'),
        h('div', { 'data-bl-note': '' }, '用它之前建议先装依赖：ffmpeg（抽帧/取音轨）、转写模型（本地转写）。没装也能用：元数据、评论、弹幕、搜索、热榜。'),
        h('div', { 'data-bl-row': '' },
          h('button', { 'data-bl-btn': 'primary', onClick: async () => { await jpost('/download', { target: 'all' }) } }, '去安装'),
          h('button', { 'data-bl-btn': '', onClick: async () => {
            await jpost('/config', { activationSeen: true })
            setSeen(true)
          } }, '先不装')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-watch')
        style.textContent = CSS + `
[data-bl-overlay]{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:10px;padding:9px 16px;background:#fffbeb;color:#7c2d12;border-bottom:1px solid #fcd34d;border-left:4px solid #f59e0b;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.06);}[data-bl-btn='primary']{background:#f59e0b;border-color:#f59e0b;color:#fff;font-weight:600;}[data-bl-btn='primary']:hover{background:#d97706;}[data-bl-btn='ghost']{border-color:transparent;color:#92400e;}[data-bl-btn='ghost']:hover{background:rgba(146,64,14,.08);}
[data-bl-overlay-text]{flex:1;}
[data-bl-activation]{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:8px;background:var(--dsw-alias-bg2,rgba(255,255,255,.04));}
`
        document.head.appendChild(style)
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'dsh-bili-watch: 面板样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // ① 插件详情页配置区（原有）
        slots.inject('plugins.bundle.config', () => slots.register(
          { name: 'plugins.bundle.config', key: PKG },
          Panel,
        ))

        // ② 启用指引（用户从插件列表点「启用」后渲染）
        slots.inject('plugins.bundle.activation', () => slots.register(
          { name: 'plugins.bundle.activation', key: PKG },
          ActivationGuide,
        ))

        // ③ 缺依赖横幅（全页浮层）
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'bili-watch.overlay' },
          OverlayBanner,
        ))

        // ④ 设置页双面板：注册/注销跟着 showInSettings 走（组件返回 null 删不掉左侧 tab）
        let settingsReg = null
        const syncSettings = (on) => {
          if (on) {
            if (settingsReg) return
            slots.inject('settings.section', () => {
              settingsReg = slots.register(
                { name: 'settings.section', id: 'bili-watch', order: 32, label: 'bili-watch' },
                Panel,
              )
              return settingsReg
            })
          } else if (settingsReg) {
            try { settingsReg() } catch {}
            settingsReg = null
          }
        }
        try { window.__biliWatchSyncSettings = syncSettings } catch {}
        jget('/status')
          .then((j) => syncSettings(!!(j.ok && j.data.ui?.showInSettings !== false)))
          .catch(() => {})
      },
    }
  },
})
