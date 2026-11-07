/**
 * lib/plugin-paths.mjs —— 「插件装在哪 / 依赖在哪 / 这是第几版」，两个进程同一份判据
 *
 * 2026-11-01（0.4.1 第 8 条）：这里原来有三样东西在 index.js 与 tools/look.mjs 各写一份。
 *   两份代码都不是「一模一样」，而是「长得像、判据差一截」—— 那比两份相同的更危险：
 *
 *   · deps 目录：index.js 判「包内有**内容**」才用包内（`readdirSync(local).length > 0`），
 *     look.mjs 只判「包内目录**存在**」。包内 deps 是空目录（正常的干净安装）时，
 *     面板用包外、CLI 用包内空目录 —— 装到哪、读哪个 venv，两边各说各话。
 *   · 版本号：两处 IIFE 逻辑相同，只是路径一个 `HERE`、一个 `HERE/..`。重复本身是隐患
 *     （改了取值方式忘了另一处，runs.jsonl 里的 version 就会一半新一半空）。
 *
 * 现在判据只有一份。**判据以 index.js 的为准**（那是运行时真实读的那个目录），
 * 所以 CLI 侧有一处行为变化：包内 deps 是空目录时改判包外 —— 这正是两边该对齐的方向。
 * 2026-11-02：一键装依赖的脚本（原 fetch-deps.ps1 / .sh，现 scripts/fetch-deps.mjs）
 * 也直接 import 这里的 resolveDepsDir，「装到哪」不再有第二份判据。那两份 shell 实现
 * 以前各写一遍，还真的写错过一次（一个判「存在」、一个判「有内容」）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * deps 跨进程锁的文件名（issue #11）。
 *
 * `scripts/fetch-deps.mjs` 下载时要写它，`index.js` 的后台迁移要抢它。名字只在这里
 * 定义一次 —— 宿主侧手写第二份字面量就是「同一目的两条路径」的老坑，必须避免。
 */
export const DEPS_LOCK_NAME = '.fetch-deps.lock'

/**
 * deps 跨进程锁的过期窗口（C48-P2-1）：宿主侧迁移/面板与 CLI 下载脚本共用这一份。
 * 6 小时只兜「pid 被复用」这一个极端，下载再慢也不该跑满；pid 活着且没过线就是活锁。
 * 原来 index.js 与 scripts/fetch-deps.mjs 各写一份 6 * 60 * 60 * 1000，改一处忘另一处
 * 就会出现「面板判活、CLI 判残留」。值只在这里定义一次，两侧都从这里 import。
 */
export const DEPS_LOCK_STALE_MS = 6 * 60 * 60 * 1000

/**
 * deps 跨进程锁的**绝对路径**。
 *
 * 为什么不能从 resolveDepsDir() 推：那个函数的返回值会随迁移进度变——
 *   pref 还没建出来 → 包内；acquireDepsLock 建出 pref / 写完 .deps-moved → 包外。
 * 同一个进程的两个时刻算出两个答案，于是宿主侧迁移锁落包外、下载侧锁落包内，
 * 互斥形同虚设（端到端实跑证实）。
 *
 * 这里只依赖 env 与 home，且固定落在 deps 的**父级**，与 depsPaths() 的 pref 同级语义：
 *   BILI_WATCH_DEPS 设了 → dirname(resolve(它))；
 *   没设 → $DSH_HOME/bili-watch（DSH_HOME 未设则 ~/.dsh/bili-watch）。
 * 宿主、CLI、下载子进程、迁移前 / 中 / 后，算出的都是同一串绝对路径。
 * 刻意不接受 pluginRoot：锁路径不许跟插件包位置有任何关系（升级会换包目录）。
 */
export function depsLockFile({ env = process.env, home = homedir() } = {}) {
  const root = env.BILI_WATCH_DEPS
    ? dirname(resolve(env.BILI_WATCH_DEPS))
    : join(env.DSH_HOME || join(home, '.dsh'), 'bili-watch')
  return join(root, DEPS_LOCK_NAME)
}

/**
 * deps 的三个候选路径（不判存在，纯算）。
 *
 * @param {{pluginRoot: string, env?: object, home?: string}} opts
 *   pluginRoot：插件包根目录（index.js 的 HERE；tools/look.mjs 要传 `join(HERE, '..')`）
 */
export function depsPaths({ pluginRoot, env = process.env, home = homedir() }) {
  const pref = env.BILI_WATCH_DEPS || join(env.DSH_HOME || join(home, '.dsh'), 'bili-watch', 'deps')
  const local = join(pluginRoot, 'deps')
  return { pref, local, movedMark: join(pref, '.deps-moved') }
}

/**
 * 这次该用哪份 deps。**同步决定、不搬东西**（搬家是 index.js 的 scheduleDepsMigration）。
 *
 * 判据顺序（与运行时口径逐条相同）：
 *   ① 两个路径指同一处 → 就是它（用户把 BILI_WATCH_DEPS 指到包内）
 *   ② 上次搬完的标记在 → 用包外
 *   ③ 包外已存在（用户手动放的 / 以前搬过但没标记）→ 用包外，不覆盖用户数据
 *   ④ 包内**有内容** → 本次先用包内（功能立刻能用，搬家排后台）
 *   ⑤ 都没有 → 用包外；`mkdirPref` 为真时顺手建出来（面板会建，CLI 不建）
 *
 * @param {{pluginRoot: string, env?: object, home?: string, mkdirPref?: boolean}} opts
 */
export function resolveDepsDir({ pluginRoot, env = process.env, home = homedir(), mkdirPref = false } = {}) {
  const { pref, local, movedMark } = depsPaths({ pluginRoot, env, home })
  if (resolve(pref) === resolve(local)) return pref
  if (existsSync(movedMark)) return pref
  if (existsSync(pref)) return pref
  let srcHas = false
  try {
    srcHas = existsSync(local) && readdirSync(local).length > 0
  } catch {}
  if (!srcHas) {
    if (mkdirPref) {
      try {
        mkdirSync(pref, { recursive: true })
      } catch {}
    }
    return pref
  }
  return local
}

/**
 * 插件版本号（package.json 的 version）。读不到就给空串 —— 调用方是写 runs.jsonl 的
 * 失败现场记录，宁可少一个字段，也不能因为打包方式变了就把日志整条吞掉。
 */
export function readPluginVersion(pluginRoot) {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}
