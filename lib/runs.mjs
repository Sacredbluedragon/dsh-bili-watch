/**
 * 追加一行 JSON 到 jsonl（带轮转）。两处调用（index.js 的面板侧、tools/look.mjs 的 CLI 侧）
 * 原来各写一份一模一样的 18 行，只有「文件在哪」不同——那部分留在调用方（runsFile()，
 * 因为 index.js 走 ensureCache()、look.mjs 走 CACHE，是切片 4 才合并的状态）。
 *
 * 2026-10-31 切片 3-C：逻辑收在这里，收路径参数，不碰任何模块级状态。
 *
 * 轮转规则（原注释保留）：超 5 MB 或 2000 行就换成 `.1`——诊断日志不能无限涨。
 * 全程 try 包住、失败不上抛：写日志失败不该让一次看视频的调用失败。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function appendJsonLine(file, entry) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      const st = statSync(file)
      const lines = Math.max(1, readFileSync(file, 'utf8').split('\n').length - 1)
      if (st.size > 5 * 1024 * 1024 || lines > 2000) {
        const bak = file + '.1'
        try { rmSync(bak, { force: true }) } catch {}
        try { renameSync(file, bak) } catch {}
      }
    } catch {}
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
  } catch {}
}

/**
 * 记一次运行：失败时先按视频写一份 last-error.json，再追加一行到 runs.jsonl。
 *
 * 2026-10-31 切片 5：两个入口的 logRun 逐字相同（18 行 × 2），切片 3 只搬了下面的
 *   appendJsonLine，因为「按视频写 last-error」要 videoDir——那部分切片 4 才进 lib。
 *   现在依赖齐了，整段收进来。两处真正的差异用参数表达，不收默认值：
 *
 *   - `extra`：CLI 侧在失败 entry 上额外挂 diag（风控页 URL/响应体）与 trackTail（走到哪一步），
 *     面板进程里没有这两个概念，传 null 就与原来逐字一致；
 *   - `videoDirOf`：缓存根在调用方手里（index 走 ensureCache、look 走 cacheDir），
 *     lib 不碰那个状态，只接收一个「BV → 目录」的函数；传 null 表示这一侧不写 last-error。
 *
 * 返回写进去的 entry（调用方目前都不用，测试拿来断言）；任何失败都不上抛——
 * 写日志失败不该让一次看视频的调用失败（原注释保留）。
 *
 * @param {string|(() => string)} file runs.jsonl 路径。
 *   **传函数也可以**（惰性求值）：路径求值的时机由调用方决定。
 *   基线两入口都是在 logRun 内部（try 块里）调 `runsFile()` 求值的 ——
 *   那个函数会走 `ensureCache()` / `cacheDir()`，缓存根没初始化时**会抛**。
 *   基线把它包在 try 里 → 抛了也只是「日志写不进去，插件继续跑」。
 *   切片 5 把它变成实参后，求值点跑到调用点（try 之外）→
 *   面板侧 index.js 的 `runLogRecord` → `finish` 没有 try，异常会一路冒到
 *   `child.on('close')` 的回调里变成未捕获异常。
 *   传惰性函数就把求值点挪回 lib 内部，恢复基线的异常边界。
 *   2026-10-31 三审（切片 5）抓出并修。
 * @param {{ command: string, bv?: string, argv?: string[], code?: number, signal?: string|null, ms?: number, version?: string, stderr?: string }} fields
 * @param {{ extra?: Record<string, any>|null, videoDirOf?: ((bv: string) => string|null)|null }} [opts]
 */
export function logRun(file, fields = {}, { extra = null, videoDirOf = null } = {}) {
  try {
    const filePath = typeof file === 'function' ? file() : file
    // ⚠ 这里必须是「只兜 undefined」，不能写成 `?? 0`。
    //   基线两入口都是解构默认 `code = 0`（`git show 2654000~1:index.js` 第 493 行），
    //   解构默认**只对 undefined 生效**：喂 null 时 code 保持 null → ok=false（失败）。
    //   换成 `?? 0` 后 null 被兜成 0 → ok=true（成功），而子进程被信号杀死时
    //   Node 的 close 事件给的 code 恰恰是 null（实跑：SIGKILL → code=null, signal='SIGKILL'）。
    //   于是「被杀掉的一次运行」被记成成功，last-error.json 也不写 ——
    //   用户事后排查「这条视频坏在哪」时最需要的那份现场文件没了。
    //   2026-10-31 三审（切片 5）抓出并修。
    const code = fields.code === undefined ? 0 : fields.code
    const entry = {
      at: new Date().toISOString(),
      command: fields.command,
      bv: String(fields.bv || ''),
      // 同上：基线是解构默认（只兜 undefined），`?? []` / `?? 0` 会把 null 也改掉。
      // argv / ms 传 null 实际不可达（两个入口都不这么传），但按基线语义对齐，别留半截。
      argv: fields.argv === undefined ? [] : fields.argv,
      code,
      signal: fields.signal === undefined ? null : fields.signal,
      ms: fields.ms === undefined ? 0 : fields.ms,
      version: fields.version ?? '',
      ok: code === 0,
    }
    if (!entry.ok) {
      entry.stderr = String(fields.stderr || '').slice(-4000)
      if (extra) Object.assign(entry, extra)
      // 按视频一份 last-error.json：事后直接定位「这条视频坏在哪」
      if (videoDirOf && /^BV[0-9A-Za-z]{10}$/.test(entry.bv)) {
        const d = videoDirOf(entry.bv)
        if (d) writeFileSync(join(d, 'last-error.json'), JSON.stringify(entry, null, 2) + '\n', 'utf8')
      }
    }
    appendJsonLine(filePath, entry)
    return entry
  } catch {
    return null
  }
}
