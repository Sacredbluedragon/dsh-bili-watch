/**
 * lib/bili-api.mjs —— B 站接口层：网络原语 / wbi 签名 / 四个读端点
 *
 * 2026-10-31 切片 8（api）：DSH 18:48 定下的依赖链是
 *   cli-io → api → media → asr-ocr → text-out → 15 个 commands → 剩薄分发
 * 这一片搬的是「所有会发 HTTP 请求的东西」。搬完以后 media / asr-ocr 只依赖它，
 * 命令层只依赖它们，依赖方向单向。
 *
 * 规矩（与 lib 其他文件一致）：
 *   1. **不打印任何东西**。所有面向人的话留在 tools/look.mjs —— 那边要用 say()/warn()，
 *      quiet 状态下还得改道 stderr，这是输出策略，不是接口行为。
 *   2. **不 import tools/ 下的模块**。否则 lib → tools 的边会让「lib 是被两者共用的」这个
 *      前提失效（index.js 在 DSH 进程里，没有 tools/ 的 CLI 输出层）。
 *   3. 于是三样「只有入口才知道」的东西走参数注入：
 *      · get(url, headers, timeoutMs)：真正发请求的函数。look.mjs 传的那份带 recordDiag，
 *        把风控页的 URL/状态码/响应体前 1000 字留给 last-error.json；面板那边可以传裸 fetch 包装。
 *      · headers：UA / Referer / 匿名 Cookie 由入口拼（匿名 buvid3 落盘在哪、DSH_HOME 怎么解析，
 *        都是入口的知识，见 lib/cred.mjs 的同样处理）。
 *      · clip(s)：超长截断。上限来自 tuning()，属于输出策略，由调用方给。
 *
 * 搬运纪律：函数体逐字照搬 tools/look.mjs（切片 7 那批 5 个函数的位置见行号注释），
 *   改动只有「形参从模块级常量改成注入」。输出基线 19 条命令逐字节比对，diff 只应出现
 *   函数头与调用行。
 */

import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (base, spread) => base + Math.floor(Math.random() * spread)

// ── 9-1：网络错误友好化——把 fetch failed / ENOTFOUND / ECONNREFUSED 翻成中文 ──
export function netCauseCode(e) {
  const c = e?.cause
  return c?.code || c?.errno || (c ? String(c.message || c).slice(0, 80) : '')
}

export function friendlyNetError(e, url) {
  const code = netCauseCode(e)
  const msg = String(code || e?.message || e)
  let kind = 'network'
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) kind = 'dns'
  else if (/ECONNREFUSED/i.test(msg)) kind = 'refused'
  else if (/ETIMEDOUT|UND_ERR_TIMEOUT|timeout|timed out/i.test(msg)) kind = 'timeout'
  const zh = kind === 'dns'
    ? '域名解析失败（DNS 不通）：检查网络连接后重试'
    : kind === 'refused'
      ? '连接被拒绝：检查网络连接，或稍后重试'
      : kind === 'timeout'
        ? '连接超时：检查网络连接，或稍后重试'
        : '网络不通（fetch 失败）：检查网络连接后重试'
  const err = new Error(`网络错误：${zh}${url ? `（请求：${String(url).slice(0, 140)}）` : ''}`)
  err.cause = e
  err.netKind = kind
  return err
}

// ── 9-4：B 站错误码翻译——删除/私密/会员/转码中四种状态各有中文说明 ──
export function biliCodeReason(code, message) {
  const c = Number(code)
  const m = String(message || '')
  if (c === -404) return `视频不存在或已被 UP 删除（-404）：${m || '该视频已下架或 BV 号不对'}`
  if (c === -403) return `视频无访问权限（-403）：可能已设为私密/仅自己可见/仅好友可见${m ? `（${m}）` : ''}`
  if (c === -10403 || /会员|大会员/.test(m)) return `仅大会员可见（-10403）：该视频需要 B 站大会员才能播放${m ? `（${m}）` : ''}`
  if (c === -22007 || /转码|审核|处理中|上传中/.test(m)) return `视频正在转码/审核中，请稍后再试${m ? `（${m}）` : ''}`
  return `B 站返回错误码 ${c}：${m || '无 message'}`
}

/**
 * 发一次 GET 并把「B 站的各种非正常响应」翻成统一形状。
 *
 * @param {string} url
 * @param {{headers?: object, timeoutMs?: number, onDiag?: (url: string, status: number, body: string) => void}} [opts]
 *   onDiag：6-10 的失败现场记录。入口传 recordDiag 进来；不传就是纯请求，不落盘。
 */
export async function jget(url, { headers = {}, timeoutMs = 30000, onDiag } = {}) {
  // T36-P1-2：只对网络层抖动重试一次（B 站偶发 ECONNRESET）；业务 code（-352/-404）不重试
  let r
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!(r.status >= 500) || attempt >= 1) break
    } catch (e) {
      if (attempt >= 1) throw friendlyNetError(e, url)
    }
    await sleep(300 + Math.floor(Math.random() * 400))
  }
  const t = await r.text()
  // 6-10：风控/错误响应把 URL 与响应体前 1000 字记下来，事后能靠 last-error.json 复现
  if (onDiag) onDiag(url, r.status, t)
  // B14：412 是风控（匿名频繁拉 playurl / view 被拦）。直接抛中文错误，中断 cmdText 的 ASR 分支，别再降级转写
  if (r.status === 412) throw new Error(`触发风控（HTTP 412）：B 站拦了当前请求，请稍后重试或加 --cred 登录后再跑。响应前 200 字：${t.slice(0, 200)}`)
  if (!r.ok) return { code: -r.status, message: `HTTP ${r.status}` }
  // W-36（2026-10-28 全量检查）：200 也可能是风控页（HTML 验证页 /「请求过于频繁」页）。
  //   原来只有 412 被认成风控，200 的 HTML 落到下面 JSON.parse 失败分支，被当成「不是 JSON」的普通业务错误；
  //   调用方（search/hot/text）按普通失败处理，cmdText 还会继续降级到 ASR——用户干等十几分钟，
  //   最后拿回一份没有字幕的转写。这里对 200 + HTML 走与 412 同一条处置路径（抛中文风控）。
  const ctype = String(r.headers.get('content-type') || '').toLowerCase()
  if (ctype.includes('text/html')) {
    throw new Error(`触发风控（HTTP ${r.status} 返回 HTML 页面，不是接口 JSON）：B 站拦了当前请求，请稍后重试或加 --cred 登录后再跑。响应前 200 字：${t.slice(0, 200)}`)
  }
  try {
    const j = JSON.parse(t)
    // W-36：-352 是 B 站的风控码。保留 code 让调用方原有的「非 0 就降级」逻辑不变，
    //   只把 message 翻成人话，否则日志里只有「热榜读取失败 code=-352」，用户不知道是被拦了。
    if (j && j.code === -352) {
      j.message = `触发风控（code=-352）${j.message ? '：' + j.message : ''}，请稍后重试或加 --cred`
    }
    return j
  } catch {
    // -999 现在只表示「200、不是 HTML、也不是 JSON」；文案带上 content-type 与开头，方便事后定位
    return { code: -999, message: `响应不是 JSON（content-type=${ctype || '无'}），前 120 字：${t.slice(0, 120)}` }
  }
}

/**
 * 有凭证就带 Cookie，没有就原样返回匿名头。
 * @param {object|null} cred
 * @param {{ua: string, ref: string, anon: object}} base 入口那边的匿名头对象
 */
export function headersFor(cred, base) {
  if (!cred) return base.anon
  const parts = [`SESSDATA=${cred.sessdata}`]
  if (cred.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`)
  if (cred.buvid3) parts.push(`buvid3=${cred.buvid3}`)
  if (cred.buvid4) parts.push(`buvid4=${cred.buvid4}`)
  return { 'User-Agent': base.ua, Referer: base.ref, Cookie: parts.join('; ') }
}

// ── wbi 签名（字幕主通道 x/player/wbi/v2 必需）──────────────────────────
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]
const getMixinKey = (orig) =>
  MIXIN_KEY_ENC_TAB.map((n) => orig[n])
    .join('')
    .slice(0, 32)

/** 拿 wbi 签名用的 imgKey/subKey。401/未登录也有 key，只是 isLogin=false——调用方自己决定要不要降级。 */
export async function wbiKeys({ get }, headers) {
  const j = await get('https://api.bilibili.com/x/web-interface/nav', headers)
  const imgUrl = j?.data?.wbi_img?.img_url ?? ''
  const subUrl = j?.data?.wbi_img?.sub_url ?? ''
  const err = j?.code === 0 ? '' : `nav code=${j?.code} ${j?.message ?? ''}`
  return {
    imgKey: imgUrl.split('/').pop().split('.')[0],
    subKey: subUrl.split('/').pop().split('.')[0],
    err,
    isLogin: Boolean(j?.data?.isLogin),
  }
}

export function wbiSign(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey)
  const p = { ...params, wts: Math.round(Date.now() / 1000) }
  const query = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  // md5 只为了 w_rid，与安全无关；node:crypto 的 createHash 是同步的
  const w_rid = createHash('md5').update(query + mixinKey).digest('hex')
  return query + '&w_rid=' + w_rid
}

// ── 元数据 ─────────────────────────────────────────────────────────────
// p = 第几个分P（从 1 起）。多 P 视频的 duration 是全部 P 的总和，必须按 pages[p-1] 取单 P 时长。
export async function viewOf({ get }, bv, p = 1) {
  const j = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`)
  // 9-4：错误码翻译——删除(-404)/私密(-403)/会员(-10403)/转码中(-22007)各有中文说明
  if (j.code !== 0) throw new Error(biliCodeReason(j.code, j.message))
  const d = j.data
  const pages = d.pages ?? []
  if (pages.length && (p < 1 || p > pages.length)) {
    throw new Error(`分P 超出范围：共 ${pages.length} 个，p=${p}`)
  }
  const page = pages[p - 1] ?? pages[0]
  return {
    aid: d.aid,
    cid: page?.cid,
    p,
    pages: pages.length || 1,
    title: d.title,
    dur: page?.duration ?? d.duration,
    owner: d.owner?.name ?? '',
    ownerMid: d.owner?.mid,
    view: d.stat?.view,
    reply: d.stat?.reply,
    desc: d.desc ?? '',
  }
}

export async function topComments({ get, clip }, aid, want = 10) {
  const out = []
  const push = (r, tag) => {
    // 7-7：单条评论 5000 字上限，超长截断并标注，防一条长话术淹没上下文
    const t = clip(String(r?.content?.message ?? '').replace(/\s+/g, ' ').trim())
    if (!t) return
    out.push({
      tag,
      name: r?.member?.uname ?? '',
      like: r?.like ?? 0,
      text: t,
      rpid: Number(r?.rpid ?? 0),
      mid: Number(r?.member?.mid ?? 0),
      ctime: Number(r?.ctime ?? 0),
      state: Number(r?.state ?? 0),
    })
  }
  const j = await get(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&next=0&ps=${want}`)
  if (j?.code !== 0) return { ok: false, why: `reply/main code=${j.code} ${j.message}`, list: [] }
  push(j.data?.top?.upper, 'UP置顶')
  push(j.data?.top?.admin, '置顶')
  for (const r of j.data?.replies || []) {
    if (out.length >= want) break
    push(r, '')
  }
  return { ok: true, list: out }
}

// ── 字幕 + 三判据 ──────────────────────────────────────────────────────
export async function fetchSubtitle({ get, ua }, aid, cid, headers) {
  const notes = []
  let navErr = ''
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(jitter(400, 300))
    const k = await wbiKeys({ get }, headers)
    // nav 失败时 wbi key 是空的：把原因记下来，别让它伪装成「无字幕轨」
    if (!k.imgKey || !k.subKey) {
      navErr = k.err || 'nav 没给 wbi 签名 key'
      notes.push(`第 ${i + 1} 次：${navErr}`)
      break
    }
    if (k.err && !k.isLogin) notes.push(`${k.err}（未登录）`)
    const q = wbiSign({ aid, cid }, k.imgKey, k.subKey)
    const j = await get(`https://api.bilibili.com/x/player/wbi/v2?${q}`, headers)
    if (j?.code !== 0) {
      const hint = j?.code === -101 ? '（凭证可能过期，重新 login 或换 --cred）' : ''
      notes.push(`第 ${i + 1} 次：wbi/v2 code=${j?.code} ${j?.message ?? ''}${hint}`)
      break
    }
    const subs = j?.data?.subtitle?.subtitles ?? []
    const track = subs.find((s) => s.subtitle_url)
    if (!track) {
      // 「无字幕轨」是确定结果，重试不会变；只有请求本身出错才值得再来一次
      notes.push(`第 ${i + 1} 次：无字幕轨`)
      break
    }
    const url = track.subtitle_url.startsWith('//') ? 'https:' + track.subtitle_url : track.subtitle_url
    const sj = await get(url, { 'User-Agent': ua })
    const text = (sj.body ?? []).map((x) => x.content).join('')
    if (!text) {
      notes.push(`第 ${i + 1} 次：内容为空`)
      continue
    }
    return { ok: true, text, cues: sj.body ?? [], lan: track.lan, tries: i + 1, notes }
  }
  return { ok: false, text: '', notes, why: `试了 2 次都没拿到（${notes.join('；')}）` }
}

/**
 * 弹幕 XML（comment.bilibili.com/{cid}.xml）。
 * 这个接口返回不带 content-encoding 头的 deflate 流，fetch 不会自动解——所以下面有四种解压兜底。
 * @param {{ua: string}} base
 * @param {number|string} cid
 */
export async function fetchDanmakuXml({ ua }, cid) {
  const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, {
    headers: { 'user-agent': ua, referer: `https://www.bilibili.com/video/BV1/` },
  })
  if (!r.ok) throw new Error(`弹幕接口 HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  let xml = buf.toString('utf8')
  // 该接口返回不带 content-encoding 头的 deflate 流，fetch 不自动解
  if (!xml.includes('<d ') && !xml.includes('<i>')) {
    for (const fn of ['inflateRawSync', 'inflateSync', 'gunzipSync', 'brotliDecompressSync']) {
      try {
        const out = zlib[fn](buf).toString('utf8')
        if (out.includes('<d ') || out.includes('<i>')) { xml = out; break }
      } catch { /* 试下一种 */ }
    }
  }
  return xml
}
