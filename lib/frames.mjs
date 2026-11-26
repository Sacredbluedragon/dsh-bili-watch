/**
 * lib/frames.mjs —— 「这批帧放在哪、有没有做完、别人是不是正在做」
 *
 * 2026-10-31。三处抽帧入口（peekFrames / grabFrames / grabFramesLocal）
 *   各自抄了同一套骨架，逐字重复：
 *     mkdir → jpgs() → readManifest → tryLock → 抢不到锁就每秒重读 manifest 等 → 等不到就抛错
 *   三处共有的结构行 8 条逐字相同，
 *   grabFramesLocal 的 29 个非空行里有 20 行能在 grabFrames 里原样找到。
 *
 * 这个模块只管「帧任务的目录与记账」：
 *   · 目录在哪（frames/<BV>-pN-<tag>）
 *   · 有没有做完（manifest.json）
 *   · 别人是不是正在做（抢不到锁时，等他的 manifest）
 * 抽帧本身（ffmpeg 命令、场景检测）不在这里——那是 lib/media.mjs 的事。
 *
 * 不含入口知识：缓存根、等待节奏（次数/间隔/等待函数）都由调用方给。
 *   「等多久」是入口的事：peek 等 30 秒、frames 等 60 秒、通用 URL 抽帧等 60 秒，
 *   lib 不该替它们决定。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 缓存根下的 frames 目录。缓存根由调用方给（lib 不读环境变量）。 */
export function framesRoot(cacheRoot) {
  return join(cacheRoot, 'frames')
}

/** frames 下的某个子目录。name 是「<BV>-pN-<tag>」这类目录名。 */
export function framesDir(cacheRoot, name) {
  return join(framesRoot(cacheRoot), name)
}

/** peek 的目录名：B16 要求能被 cachedMp4 的 `<BV>-p<page>-` 前缀命中。 */
export function shotsDirName(bv, page = 1) {
  return `${bv}-p${page}-shots`
}

/** frames 的目录名：`<BV>-pN-<tag>`，tag 由调用方给（步长秒数 / at 指纹 / scene-Ns）。 */
export function framesDirName(bv, page = 1, tag = '') {
  return `${bv}-p${page}-${tag}`
}

/** 建目录。原实现是 `mkdirSync(dir, { recursive: true })` 不带 catch——建不出来就该报错。 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** 目录里的 jpg 列表（抽完帧数帧就是它）。 */
export function listJpgs(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.jpg'))
}

/**
 * 这一批里**属于本次抽帧产物**的那些文件名，写进 manifest.files（下一轮 --fresh 只按这份清单删）。
 *
 * 两种命名都要认：
 *   · `<bv>-NN.jpg`：等间隔 / scene 吸附的产物；
 *   · `f_<m>m<ss>s.jpg`：`--at` 逐点抽帧的产物。
 * P1（2026-10-30）：原来只认前一种，于是 at 模式的 files 恒为 `[]`，下次 `--fresh` 走
 *   「manifest 没有 files 清单 → 一律不碰」，同一个 `--out` 目录里的旧时刻帧永远删不掉
 *   （`--at 460` 与 `--at 750` 撞目录时尤其难看）。
 *
 * 从 grabFrames 里抽出来：抽之前在 verify 里只能 grep `const produced`
 * 那一行含不含 `f_`（等于问「源码里有没有这个字」），抽出来才能喂真文件名、看真输出。
 * 写成纯函数不损失忠实度——`jpgs()` 只是 `listJpgs(dir)`，这里本来就不碰 ffmpeg。
 */
export function frameFilesToKeep(bv, files) {
  const bvRe = new RegExp(`^${bv}-\\d+\\.jpg$`)
  return files.filter((f) => bvRe.test(f) || /^f_\d+m\d+s\.jpg$/.test(f))
}

/**
 * manifest 读。读不出来 / 不是合法 JSON → null（当作「没做完」）。
 * manifest 是「这批帧确实抽完了」的凭据，坏文件必须当没有，否则会把残帧当完整结果复用。
 */
export function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * manifest 写。带 at 时间戳（写入时刻），供事后判断这批帧是什么时候产出的。
 * 写失败不抛：manifest 只是记账，记账失败不该让已经抽好的帧白跑。
 */
export function writeManifest(dir, info, now = Date.now()) {
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...info, at: now }), 'utf8')
  } catch {}
}

/** 逐写盘点版本号。v2 起 meta.files 只认「刚写成功的产物」，不再做全目录快照。 */
export const LEDGER_VERSION = 2

/**
 * 0.4.13（§5.8.7 R0）：meta.json 顶层的六样凭证字段——形状与默认口径。
 * 三处「给不出不许编」：
 *   · dependsOn 在 V1 只留空数组 [] 占位（不做实依赖图）；
 *   · validity.state 默认一律 'unknown'，只有本次刚抓过、调用方明确给了 fresh=true 才写 'valid'；
 *   · reacquirable.kind='remote' 不等于真能重取——note 里写清依赖什么条件（视频在线 / 直链可取）。
 * 缺值的字段写空串 / null，不编造 cid、aid、版本。
 */
export function makeMetaFields(info = {}) {
  const fresh = info.fresh === true
  const s = info.source || {}
  const pb = info.producedBy || {}
  return {
    source: {
      cid: s.cid ?? null,
      p: s.p ?? null,
      aid: s.aid ?? null,
      quality: s.quality ?? null,
      fetchedAt: s.fetchedAt ?? null,
    },
    producedBy: {
      toolVersion: pb.toolVersion ?? '',
      command: pb.command ?? '',
      method: pb.method ?? '',
      methodVer: pb.methodVer ?? '',
    },
    dependsOn: [],
    reacquirable: {
      kind: info.reacquirable?.kind === 'local' || info.reacquirable?.kind === 'never'
        ? info.reacquirable.kind : 'remote',
      ref: info.reacquirable?.ref ?? '',
      note: info.reacquirable?.note ?? '依赖源视频在线且直链可取；不能保证永远能重取',
    },
    validity: {
      state: fresh ? 'valid' : 'unknown',
      checkedAt: fresh ? (info.now || new Date().toISOString()) : null,
      invalidatedBy: null,
    },
    pinned: false,
  }
}

/**
 * 逐写盘点、只认刚写成功的产物、不信目录快照。
 * 旧版（ledgerVersion !== 2）若已带着 files 数组，那是一份「全目录 readdir 快照」：
 *   全仓无读取方、且可能混入用户文件（上一轮取证已证），故整段搬到 meta.legacyFiles
 *   后把 meta.files 清空，再由 entries 重新登记——采用「整段丢弃重记」而非信任旧快照。
 * entries 每项 {name, bytes}，按 name 去重合并，跳过 meta.json 与 *.tool.txt
 * （这两个不参与归属判定）。最后 ledgerVersion 置 2，返回 meta。
 */
export function mergeLedger(meta, entries = [], r0 = null) {
  meta = meta || {}
  if (meta.ledgerVersion !== 2 && Array.isArray(meta.files)) {
    meta.legacyFiles = { version: 1, files: meta.files, note: '旧版全目录快照不可信，不参与归属判定' }
    meta.files = []
  }
  if (!Array.isArray(meta.files)) meta.files = []
  const seen = new Set()
  const out = []
  for (const f of meta.files) {
    if (!f || seen.has(f.name)) continue
    seen.add(f.name)
    out.push(f)
  }
  for (const e of entries) {
    if (!e) continue
    const name = e.name
    if (name === 'meta.json' || name.endsWith('.tool.txt')) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, bytes: typeof e.bytes === 'number' ? e.bytes : 0 })
  }
  meta.files = out
  meta.ledgerVersion = 2
  // 0.4.13（§5.8.7）：只有新建账本（调用方传 r0）才落六字段；且只填空缺、不覆盖已有值——
  //   存量 v2 账本读改写时不传 r0，六字段不会被补上，做到「存量一律不动」。
  //   读侧遇缺字段不抛异常（见 ledgerFilesOf——它只读 files[].name，根本不碰这六字段）。
  if (r0) {
    for (const [k, v] of Object.entries(r0)) {
      if (meta[k] === undefined) meta[k] = v
    }
  }
  return meta
}

/**
 * 逐写盘点、只认刚写成功的产物、不信目录快照。
 * 读该目录 meta.json，只在 ledgerVersion === 2 时把 files 里的 name 收成 Set 返回；
 * 旧版（含 legacyFiles 快照）一律返回空 Set——快照不可信，不能在归属判定里用它。
 *
 * 0.4.15 判定层收敛：本函数是唯一的台账**数据源**，不是判定入口，不计入「3 个判定入口」。
 * Set 里只有 files[].name，装不下 BV 目录身份、白名单身份、URL 形状这三层凭证；
 * 它只回答「这批写成功了哪些文件」，不回答「归不归我们」「删不删」。调用方（cache-own.mjs）
 * 直接取用，不再经过 `manifestFilesOf` 别名；派生的 Set 不另算一个入口。
 */
export function ledgerFilesOf(dir) {
  let meta
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  } catch {
    return new Set()
  }
  if (!meta || meta.ledgerVersion !== 2) return new Set()
  return new Set((meta.files || []).map((f) => f.name))
}

/**
 * 逐写盘点、只认刚写成功的产物、不信目录快照。
 * 读该目录 meta.json → mergeLedger(entries) → 先写 .tmp 再 rename 原子替换，
 * 返回合并后的 files。供非 writeMeta 的写盘点（如抽帧产物）用：记账失败不该影响主流程。
 */
export function appendLedger(dir, entries = []) {
  let meta = {}
  let isNew = false
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  } catch { isNew = true }
  // 0.4.13（§5.8.7）：新建账本落六字段；存量 v2 账本（读到 meta）一律不补——保持原样。
  //   抽帧子目录的 source/producedBy 在调用点给不出，makeMetaFields 写空值不编造。
  meta = mergeLedger(meta, entries, isNew ? makeMetaFields() : null)
  const p = join(dir, 'meta.json')
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
  return meta.files
}

/**
 * 抢不到锁时的等待：每隔 pollMs 重读一次 manifest，hit(m) 说「这份已经够用」就把它交回去。
 *
 * 存在的理由：三个入口原来各写一遍 for 循环（唯一差别是次数 30 / 60 / 60 与判据），
 * 而这段等待的语义很容易写歪——「等的是 manifest，不是目录里有多少文件」。
 * 命中判据由调用方给（peek 看 5 张、frames 看时刻集合、通用 URL 抽帧看 step）。
 *
 * 返回命中的 manifest，没等到返回 null（由调用方决定抛什么错）。
 */
export async function waitManifest(dir, hit, { tries = 60, pollMs = 1000, sleep = defaultSleep } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(pollMs)
    const m = readManifest(dir)
    if (hit(m)) return m
  }
  return null
}
