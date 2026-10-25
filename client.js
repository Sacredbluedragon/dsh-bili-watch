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
window.__ModuleLoader__.load({
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
[data-bl-detail]{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;word-break:break-all;}
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

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [saveErr, setSaveErr] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [days, setDays] = React.useState('7')
      const [maxMb, setMaxMb] = React.useState('2048')
      const [qr, setQr] = React.useState(null)
      const [qrState, setQrState] = React.useState('')
      const [dlg, setDlg] = React.useState(null) // 'download' | 'clean'
      const [picked, setPicked] = React.useState([])

      const load = React.useCallback(async () => {
        try {
          const j = await jget('/status')
          if (j.ok) {
            setSt(j.data)
            setErr('')
            setDays(String(j.data.cache?.days ?? 7))
            setMaxMb(String(j.data.cache?.maxMb ?? 2048))
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
        const tick = async () => {
          if (stop) return
          try {
            const j = await jpost('/login/poll', { key: qr.key })
            if (stop) return
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
              setMsg(j.why || (j.state === 'expired' ? '二维码已过期，点「重新扫码」再试。' : '轮询失败'))
              return
            }
            setQrState(j.state)
            setTimeout(tick, 2500)
          } catch (e) {
            if (!stop) setTimeout(tick, 4000)
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
          setMsg(j.ok ? `已开始下载（后台跑，日志 ${j.data.log}）。下载较久，过一会儿点刷新看状态。` : (j.data?.why || j.why || '启动失败'))
        } catch (e) {
          setMsg(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const saveCache = async () => {
        try {
          const j = await jpost('/cache/clear', { days: Number(days), maxMb: Number(maxMb) })
          setMsg(j.ok ? `缓存已清（${j.data.removed} 个文件 / ${fmtBytes(j.data.bytes)}）；之后按 ${days} 天、${maxMb} MB 自动清` : (j.why || '清缓存失败'))
          await load()
        } catch (e) {
          setMsg(String(e?.message || e))
        }
      }

      const saveRule = async () => {
        try {
          await jpost('/cache/clear', { days: Number(days), maxMb: Number(maxMb) })
        } catch {}
      }

      const rows = st?.deps || []
      // 打开批量弹层：默认全勾选（可下载 = 缺的且不是凭证；可清理 = 插件目录内且已存在）
      const openDlg = (kind) => {
        if (kind === 'download') setPicked(rows.filter((d) => d.id !== 'credential' && !d.ok).map((d) => d.id))
        else setPicked(rows.filter((d) => d.removable && d.ok).map((d) => d.id))
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
          setMsg(`已启动 ${picked.length} 个下载（后台跑，过一会儿刷新看状态）。`)
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
        const label = target === 'credential' ? '登录凭证（删了要重新扫码）' : (row?.name || target)
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(`确定删除 ${label}？`)) return
        }
        try {
          const j = await jpost('/delete', { targets: [target] })
          const d = j.data || {}
          const skipped = (d.skipped || []).map((s) => s.why).join('、')
          setMsg(d.deleted?.length ? `已删除 ${target}` : `没删：${skipped || '未知原因'}`)
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
          h('span', { 'data-bl-sub': '' }, '缺什么点下载，装好后这里会变绿。')),
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-sechead': '' },
            h('span', { 'data-bl-sec-title': '' }, '运行依赖'),
            h('button', { 'data-bl-btn': '', onClick: () => openDlg('download') }, '批量下载'),
            h('button', { 'data-bl-btn': '', onClick: () => openDlg('clean') }, '批量清理')),
          ...deps.map((d) => h(DepRow, { key: d.id, d, busy: busy === d.id, onDownload: download, onDelete: delOne })),
          h('div', { 'data-bl-note': '' },
            '下载在后台跑，用插件自带的 fetch-deps 脚本；体积是预估，实际以跑完为准。')),
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
                          : h('span', { 'data-bl-note': '' }, '没有可删的')
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
                      ? '已扫码，请在手机 B 上点确认。'
                      : qrState === 'loading'
                        ? '正在生成二维码…'
                        : '用手机 B 站「扫一扫」扫左边这张；扫完这里会自动变绿。'),
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
            h('span', { 'data-bl-detail': '' }, cache.dir || '(系统临时目录)'),
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
              h('input', { 'data-bl-input': '', value: days, onChange: (e) => setDays(e.target.value), inputMode: 'numeric' }),
              ' 天；总量超过 ',
              h('input', { 'data-bl-input': '', value: maxMb, onChange: (e) => setMaxMb(e.target.value), inputMode: 'numeric' }),
              ' MB 时从最旧的删。'),
            h('button', { 'data-bl-btn': '', onClick: saveRule }, '保存规则')),
          h('div', { 'data-bl-note': '' },
            '不点也会按上面的规则自动清（每次打开面板与插件启动时检查一次）。')),
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
