/**
 * lib/frames.mjs —— 「这批帧放在哪、有没有做完、别人是不是正在做」
 *
 * 2026-10-31 切片 10。三处抽帧入口（peekFrames / grabFrames / grabFramesLocal）
 *   各自抄了同一套骨架，逐字重复：
 *     mkdir → jpgs() → readManifest → tryLock → 抢不到锁就每秒重读 manifest 等 → 等不到就抛错
 *   实测（对 tools/look.mjs 逐行统计）：三处共有的结构行 8 条逐字相同，
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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
