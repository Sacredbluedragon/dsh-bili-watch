/**
 * 转写模型完整性判定（issue #11 问题 2）。
 *
 * 背景：HF 缓存目录存在 ≠ 模型可用。Windows 上 hf_hub 建不了符号链接，会直接把
 * 真文件写进 snapshots/<hash>/，而 blobs/ 是空的。所以：
 *   · 只查 blobs/*.incomplete → 本机正常安装会被误判成残片；
 *   · 只查快照子目录里有没有 model.bin → 下了一半的文件会被误判成完整。
 *
 * 体积下限只有这一份定义。运行时（index.js 的 /status）、下载脚本
 * （scripts/fetch-deps.mjs 的 --force 清残片）与自检夹具都从这里取值，
 * 不在别处再抄一个数字。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** model.bin 的最小可用体积（字节）。真值 483,546,902 B，留约 17% 余量。 */
export const MODEL_MIN_BYTES = 400_000_000
/** 面板文案里的「应为」体积，按 MiB 口径显示（真值约 461 MiB）。只用于显示，不参与判定。 */
export const MODEL_EXPECTED_MB = 461
/** 不完整时统一给用户的重跑命令。 */
export const MODEL_FORCE_CMD = 'fetch-deps model --force'

const REQUIRED_FILES = ['model.bin', 'config.json', 'tokenizer.json']
const RANK = { complete: 5, partial: 4, unreadable: 3, empty: 2, missing: 1 }

const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(1)

/**
 * 扫一个 HF_HOME。返回的状态里带着「为什么」，读不出来时不许压成「没有」。
 * @param {string} home
 * @returns {{state:string, home:string, snapshotDir:string, bytes:number, missing:string[], reason:string}}
 */
function inspectHome(home) {
  const base = { state: 'missing', home, snapshotDir: '', bytes: 0, missing: [], reason: '', tooSmall: false }
  if (!home || !existsSync(home)) return base

  const hub = join(home, 'hub')
  if (!existsSync(hub)) return { ...base, state: 'empty' }

  let modelDirs
  try {
    modelDirs = readdirSync(hub, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('models--'))
      .map((d) => join(hub, d.name, 'snapshots'))
  } catch (e) {
    // 「不知道」必须说原因：权限不足 / 目录被占等都算不完整，不能当「没有快照」。
    return { ...base, state: 'unreadable', reason: String(e?.code || e?.name || 'UNKNOWN') }
  }

  let best = null
  for (const snapshots of modelDirs) {
    if (!existsSync(snapshots)) continue
    let revs
    try {
      revs = readdirSync(snapshots, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(snapshots, d.name))
    } catch (e) {
      const cur = { ...base, state: 'unreadable', reason: String(e?.code || e?.name || 'UNKNOWN') }
      if (!best || RANK[cur.state] > RANK[best.state]) best = cur
      continue
    }
    for (const rev of revs) {
      let cur
      try {
        const present = readdirSync(rev)
        const missing = REQUIRED_FILES.filter((f) => !present.includes(f))
        if (missing.length) {
          cur = { ...base, state: 'partial', snapshotDir: rev, missing, reason: `缺 ${missing.join(' / ')}` }
        } else {
          const bytes = statSync(join(rev, 'model.bin')).size
          cur = bytes >= MODEL_MIN_BYTES
            ? { ...base, state: 'complete', snapshotDir: rev, bytes }
            : { ...base, state: 'partial', snapshotDir: rev, bytes, reason: '体积不足', tooSmall: true }
        }
      } catch (e) {
        cur = { ...base, state: 'unreadable', snapshotDir: rev, reason: String(e?.code || e?.name || 'UNKNOWN') }
      }
      if (!best || RANK[cur.state] > RANK[best.state]) best = cur
      if (best.state === 'complete') return best
    }
  }
  // 走到这里说明 hub 在、但一个合格快照都没有。
  return best || { ...base, state: 'empty' }
}

/**
 * 扫全部候选落点（deps/.hf-home 与项目目录下的 .hf-home），任一完整即完整；
 * 否则挑「信息最具体」的那个原因说给用户。
 * @param {string[]} homes
 */
export function inspectModelHomes(homes) {
  const perHome = (Array.isArray(homes) ? homes : []).map((h) => inspectHome(h))
  let best = perHome[0] || inspectHome('')
  for (const s of perHome.slice(1)) {
    if (RANK[s.state] > RANK[best.state]) best = s
    if (best.state === 'complete') break
  }
  return { ...best, perHome }
}

/**
 * /status 里 model 这一行的全部字段。面板文案也在这里生成，
 * 保证「下限」与「应为 X MB」与判定用的是同一份常量。
 * @param {string[]} homes
 * @param {{mask?: (p:string)=>string, dirStat?: (p:string)=>{bytes:number}}} [deps]
 */
export function modelRow(homes, deps = {}) {
  const mask = deps.mask || ((p) => String(p || ''))
  const dirStat = deps.dirStat || (() => ({ bytes: 0 }))
  const s = inspectModelHomes(homes)
  const home = s.home || ''
  let detail
  switch (s.state) {
    case 'complete':
      detail = mask(home)
      break
    case 'partial':
      detail = s.reason === '体积不足'
        ? `模型不完整：\`model.bin\` 只有 ${toMB(s.bytes)} MB（应为 ${MODEL_EXPECTED_MB} MB），重跑 \`${MODEL_FORCE_CMD}\``
        : `模型不完整：快照里${s.reason}，重跑 \`${MODEL_FORCE_CMD}\``
      break
    case 'empty':
      detail = `模型目录在但没有可用的快照，重跑 \`${MODEL_FORCE_CMD}\``
      break
    case 'unreadable':
      detail = `模型目录读不出来（${s.reason}），无法确认完整性，重跑 \`${MODEL_FORCE_CMD}\``
      break
    default:
      detail = '没找到模型目录，本地转写不可用'
  }
  let size = 0
  if (home && existsSync(home)) {
    try { size = dirStat(home).bytes } catch {}
  }
  return {
    ok: s.state === 'complete',
    detail,
    path: mask(home),
    size,
    state: s.state,
    snapshotDir: s.snapshotDir,
  }
}
