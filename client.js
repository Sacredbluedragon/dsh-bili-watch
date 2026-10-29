/**
 * dsh-bili-watch —— 浏览器半端：插件详情页里的「依赖与状态」面板。
 *
 * 面板回答三件事（不碰业务流程）：
 *   ① 这个插件依赖的 ffmpeg / yt-dlp / ASR / OCR / 模型 / 登录凭证，现在配好了没有；
 *   ② 缺的可以一键下载（后台跑插件自带的 fetch-deps 脚本，带预估体积）；
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

MODULE_LOADER.load({
  id: 'dsh-bili-watch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // 包名 = 插件详情页挂点的 key：生产与发布树同名 dsh-bili-watch
    const PKG = 'dsh-bili-watch'
    const API = '/api/bili-watch'
    const jget = async (p) => (await fetch(API + p, { credentials: 'same-origin' })).json()
    const jpost = async (p, body) =>
      (await fetch(API + p, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })).json()

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

    function DepRow({ d, busy, onDownload, onDelete }) {
      const canDownload = !d.ok && d.id !== 'credential'
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
            fails = 0
            if (j.state === 'ok') {
              stop = true
              setQr(null)
              setQrState('ok')
              setMsg('登录成功，凭证已保存。')
              await load()
              return
            }
            if (j.state === 'expired' || j.state === 'error') {
              stop = true
              setQrState(j.state)
              setMsg(j.why || (j.state === 'expired' ? '二维码已过期，请点击「重新扫码」重试。' : '轮询失败'))
              return
            }
            setQrState(j.state)
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
          // 后端回的是 { ok, data: { results: [{started, log} | {started:false, why}], started } }，
          // 扁平读 j.data.log / j.data.why 永远是 undefined——成功时显示「日志 undefined」，
          // 失败时把后端写明的具体原因全丢掉，只剩兜底的「启动失败」。
          const results = Array.isArray(j?.data?.results) ? j.data.results : []
          const good = results.filter((r) => r && r.started)
          const bad = results.filter((r) => r && !r.started)
          const log = good[0]?.log || j?.data?.log || ''
          const why = bad.map((r) => r.why).filter(Boolean).join('；') || j?.data?.why || j?.why || ''
          if (good.length && !bad.length) {
            setMsg(`已开始下载（后台执行，日志 ${log || 'deps/download.log'}）。下载完成后点击刷新查看状态。`)
          } else if (good.length && bad.length) {
            setMsg(`部分已开始（${good.length} 项）；失败 ${bad.length} 项：${why || '原因未知'}`)
          } else if (!results.length && (j?.ok || log)) {
            // 老形状 / 空 results 但整体成功：别退化成「启动失败」
            setMsg(`已开始下载（后台执行，日志 ${log || 'deps/download.log'}）。下载完成后点击刷新查看状态。`)
          } else {
            setMsg(why || '启动失败')
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
          setMsg(j.ok ? `缓存已清理（${j.data.removed} 个文件 / ${fmtBytes(j.data.bytes)}）；此后按 ${days} 天、${maxMb} MB 自动清理` : (j.why || '清理缓存失败'))
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
        if (kind === 'download') setPicked(rows.filter((d) => d.id !== 'credential' && !d.ok).map((d) => d.id))
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
          for (const t of picked) {
            try {
              await jpost('/download', { target: t })
            } catch {}
          }
          setMsg(`已启动 ${picked.length} 个下载（后台执行，稍后点击刷新查看状态）。`)
          return
        }
        if (!picked.length) {
          setMsg('没有勾选可清理的项。')
          return
        }
        try {
          const j = await jpost('/delete', { targets: picked })
          const d = j.data || {}
          const skipped = (d.skipped || []).map((s) => `${s.id}（${s.why}）`).join('、')
          setMsg(`已删除：${(d.deleted || []).join('、') || '无'}` + (skipped ? `；跳过：${skipped}` : ''))
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
          const skipped = (d.skipped || []).map((s) => s.why).join('、')
          setMsg(d.deleted?.length ? `已删除 ${target}` : `未删除：${skipped || '未知原因'}`)
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
            '下载在后台执行，使用内置 fetch-deps 脚本；体积为预估值，实际以完成后为准。')),
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
        h('div', { 'data-bl-sec': '' },
          h('span', { 'data-bl-sec-title': '' }, '抽帧缓存'),
          h('div', { 'data-bl-row': '' },
            h('span', { 'data-bl-name': '' }, '当前占用'),
            h('span', { 'data-bl-detail': '' }, `${fmtBytes(cache.bytes)} / ${cache.files} 个文件`),
            h('button', { 'data-bl-btn': '', onClick: saveCache }, '立即清除')),
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
                  : '有卡且运行库就绪时比 CPU 快 2-8 倍。'))),
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
          const missing = (j.data.deps || []).filter((d) => !d.ok)
          if (missing.length > 0 && j.data.ui?.hintDismissed !== true) {
            setVisible(true)
          }
        }).catch(() => {})
      }, [])

      if (!visible || dismissed) return null
      const missing = (st?.deps || []).filter((d) => !d.ok)
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
