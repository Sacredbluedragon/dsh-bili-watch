/**
 * 凭证：文件在哪、什么算「一份完整凭证」、旧位置那一次迁移。
 *
 * 2026-10-31 切片 5：这三件事原来在 index.js（resolveCredPath）与 tools/look.mjs（credFor 的
 *   迁移分支）各写一份，四字段清单更是散在三个地方（index 的迁移判据、index 的 credState、
 *   look 的 loadCred）。两份实现的差别只有「怎么告诉用户」——index 要静默（面板靠 /status 展示
 *   凭证状态），look 要往 stderr 打一行提示——所以照 lib 的规矩拆开：
 *   **lib 只做行为并返回结构化结果，文案归调用方。**
 *
 * 位置规则（2026-10-30 B 方案，用户拍板，别再改回去）：
 *   只认自己这一份 $DSH_HOME/bili-watch/credential.json；没有就从 <deps>/credential.json
 *   迁一次；都没有就是未登录（匿名请求）。以前那套「跟随同机另一个 B 站工具写的凭证」的
 *   mtime 仲裁已经整套拿掉——那个目录只在特定机器上存在，用户侧是死分支，却把本机概念写进了公开源码。
 *
 * 迁移规则（2026-10-26 收口，DSH 拍板）：迁移前先解析 JSON 并校验必填字段，
 *   残缺该拒就拒（继续用旧路径），不把坏凭证原样搬到新路径；只有真写成功才返回新路径。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一份「能拿去请求」的凭证必须齐的字段。少任何一个都算残缺：残缺凭证会让部分接口静默返回空数据，
 *  比匿名更难排查（A-4 / W-28 的由来）。 */
export const CRED_FIELDS = ['sessdata', 'bili_jct', 'buvid3', 'buvid4']

/** 缺哪些字段（空数组 = 齐全）。不判断文件、不读盘，纯判据。 */
export function missingCredFields(obj) {
  return CRED_FIELDS.filter((k) => !obj?.[k])
}

/**
 * 两份凭证的位置。`deps` 由调用方给——两个入口的 DEPS 解析（包外/环境变量/包内）各自不同，
 * 属于它们自己的知识，不属于凭证。
 * @param {string} deps
 * @returns {{ shared: string, legacy: string }}
 */
export function credPaths(deps) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    shared: join(home, 'bili-watch', 'credential.json'),
    legacy: join(deps, 'credential.json'),
  }
}

/**
 * 读一份凭证并校验。**不打印任何东西**——文案由调用方决定（见文件头）。
 * @param {string} path
 * @returns {{ ok: true, value: any } | { ok: false, why: 'enoent'|'unreadable'|'bad-json'|'incomplete', missing?: string[], message?: string, value?: any }}
 */
export function readCred(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return { ok: false, why: e?.code === 'ENOENT' ? 'enoent' : 'unreadable', message: String(e?.message || e) }
  }
  let j
  try {
    j = JSON.parse(raw)
  } catch (e) {
    return { ok: false, why: 'bad-json', message: String(e?.message || e) }
  }
  const missing = missingCredFields(j)
  if (missing.length) return { ok: false, why: 'incomplete', missing, value: j }
  return { ok: true, value: j }
}

/**
 * 取「这次该用哪份凭证」，顺带做一次旧路径迁移。
 *
 * 返回值里 `path` 是**调用方该去读/写的路径**，`cred` 是迁移时顺手读出来的那份（没有就是 null）：
 *
 *   - shared 已存在        → { path: shared, cred: null, moved: false, sharedExists: true }
 *                            （不在这里读它：index 侧一直只看存在性，读内容的是它自己的 credState）
 *   - legacy 有一份好凭证  → 复制到 shared（0600），path=shared、moved=true
 *   - legacy 残缺/坏 JSON  → { path: legacy, cred: null, problem }（继续用旧的，不搬坏数据）
 *   - legacy 写 shared 失败 → { path: legacy, cred: <旧那份>, problem:'write-failed' }
 *                            （凭证本身是好的，照旧能用；只是这次没搬成，两个入口都不该因此变成未登录）
 *   - 两份都没有           → { path: shared, cred: null, sharedExists: false }
 *
 * @param {{ shared: string, legacy: string }} paths
 */
export function adoptLegacyCred({ shared, legacy }) {
  if (existsSync(shared)) return { path: shared, cred: null, moved: false, sharedExists: true }
  if (!existsSync(legacy)) return { path: shared, cred: null, moved: false, sharedExists: false }
  const r = readCred(legacy)
  if (!r.ok) {
    return { path: legacy, cred: null, moved: false, sharedExists: false, problem: r.why, missing: r.missing, message: r.message }
  }
  try {
    mkdirSync(dirname(shared), { recursive: true })
    // index 侧原来用 mode 建、look 侧原来靠建完 chmod。合并后两件都做：
    //   创建时就是 0600（不留一个按 umask 可读的短暂窗口），chmod 兜住「文件已存在但权限被改宽」。
    //   POSIX 上结果与两种旧写法都不弱，Windows 上 chmod 本就是空操作。
    writeFileSync(shared, JSON.stringify(r.value, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(shared, 0o600) } catch {}
    return { path: shared, cred: r.value, moved: true, sharedExists: false }
  } catch (e) {
    return { path: legacy, cred: r.value, moved: false, sharedExists: false, problem: 'write-failed', message: String(e?.message || e) }
  }
}

/**
 * 从 poll 响应的 Set-Cookie 里挑登录需要的几个 cookie。
 * 两个入口（面板内扫码 / CLI 的 --poll）逐字相同，2026-10-31 切片 5 收进来。
 * @param {string[]} list Set-Cookie 头（每条可能带 Path/Expires 等后缀）
 */
export function pickLoginCookies(list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3', buvid4: 'buvid4' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const k = first.slice(0, i).trim()
    const v = first.slice(i + 1).trim()
    if (want[k] && v) jar[want[k]] = v
  }
  return jar
}

/**
 * poll 往往只给 buvid3，buvid4 走 finger/spi 补。
 *
 * 两个入口的实现逐字相同，只有超时值不同——而超时值本身是**各侧自己的知识**：
 * 面板侧要与同文件的 QR_GEN / QR_POLL 保持一致（8 秒，超过 8 秒前端已经在转圈）；
 * CLI 侧是 --poll 循环里每轮一次，统一 15 秒（M-04 的由来）。所以收函数、收参数，不收默认值。
 *
 * @param {Record<string, string>} jar
 * @param {{ timeoutMs: number, ua: string, spi: string }} opts
 */
export async function fillBuvids(jar, { timeoutMs, ua, spi }) {
  if (jar.buvid3 && jar.buvid4) return jar
  try {
    const r = await fetch(spi, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(timeoutMs) })
    const j = await r.json()
    if (!jar.buvid3 && j?.data?.b_3) jar.buvid3 = j.data.b_3
    if (!jar.buvid4 && j?.data?.b_4) jar.buvid4 = j.data.b_4
  } catch {}
  return jar
}
