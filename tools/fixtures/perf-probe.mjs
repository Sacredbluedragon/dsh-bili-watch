// 面板首屏性能：A 条（4 并发不堆叠）与 B 条（子进程调用次数 / 失败语义）的真跑夹具。
//
// 为什么除了墙钟还要测「事件循环心跳」：
//   原建议阈值是「4 并发墙钟 ≤ 单发耗时 × 2」。但缓存是共享的 —— 同步版里第一个
//   /status 跑完三处 execFileSync 就把 ffmpeg/ytdlp/import 三份缓存都写好了，后三个请求
//   全部命中缓存，于是 4 并发墙钟 ≈ 单发冷态，比值也会落在 2 以内，A 条单独会假绿。
//   真正区分「同步」与「异步」的是主线程有没有被堵：心跳 5ms 一跳，execFileSync 一堵
//   就漏跳。两条一起判，D1「改回 execFileSync」才有牙（扰动报告里会实测这一点）。
//
// 为什么子进程只在 /status 路径上延迟：yt-dlp --version / ffmpeg -version / python -c
//   三处各 80ms，GPU 探测与别的一律立即返回，避免把本机 nvidia-smi 拖进夹具。
//
// 输出一行 JSON：defect（修好前 false、修好后 true）/ capability（改的时候最易弄坏的反向能力）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const INDEX = join(ROOT, 'index.js')
const CHILD = join(HERE, 'perf-child.mjs')
const PRELOAD = join(HERE, 'perf-preload.mjs')
const DELAY = 80
const TICK_LIMIT = 40

const tmp = mkdtempSync(join(tmpdir(), 'bw-perf-'))
const depsDir = join(tmp, 'deps-main')
const emptyDir = join(tmp, 'deps-empty')
const cacheDir = join(tmp, 'cache')
const report = { fatal: null, defect: {}, capability: {}, notes: { rows: [], tmp } }
const d = report.defect
const c = report.capability

const run = (mode, n, dir, extra = {}) => {
  const plan = { mode, n, depsDir: dir, cacheDir, indexPath: INDEX }
  const cfg = { delayMs: DELAY, ...extra }
  // Windows 上 --import 必须是 file:// URL，传绝对路径会被当成 'd:' 协议（已实测红过一次）
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, CHILD, JSON.stringify(plan)], {
    encoding: 'utf8', timeout: 90000,
    env: { ...process.env, BW_PERF_CFG: JSON.stringify(cfg) },
  })
  // stdout 只该有一行 JSON；stderr 是 Node 的实验性警告，不参与解析但要留痕
  const stdout = String(r.stdout || '').trim()
  const stderr = String(r.stderr || '').trim()
  let j = null
  try { j = JSON.parse(stdout) } catch {}
  if (!j || j.fatal || r.status !== 0) {
    report.fatal = `${mode} 子探针失效（rc=${r.status}）：${(j?.fatal || stdout).slice(0, 300)} | stderr=${stderr.slice(-300)}`
    return null
  }
  report.notes.rows.push({ mode, n, wallMs: j.wallMs, maxTickMs: j.maxTickMs,
    spawns: j.spawns.length, ytdlp: j.spawns.filter((s) => s.kind === 'ytdlp').length,
    sync: j.spawns.filter((s) => s.kind === 'sync').length, codes: j.codes, oks: j.oks,
    detail: j.ytdlpRow?.detail, ok: j.ytdlpRow?.ok, stderr: stderr.slice(0, 120) })
  return j
}

try {
  const PY_DIR = process.platform === 'win32' ? 'Scripts' : 'bin'
  const PY_EXE = process.platform === 'win32' ? 'python.exe' : 'python'
  const YT = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  mkdirSync(depsDir, { recursive: true })
  mkdirSync(emptyDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
  // 假的 yt-dlp：只需 existsSync/statSync 成功，真执行被 preload 桩接管。
  writeFileSync(join(depsDir, YT), 'stub-binary-not-executed\n')
  for (const env of ['.venv-asr', '.venv-ocr']) {
    const p = join(depsDir, env, PY_DIR)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, PY_EXE), 'stub-python-not-executed\n')
  }

  const single = run('single', 1, depsDir)
  const quad = run('quad', 4, depsDir)
  const missing = run('missing', 1, emptyDir)
  const execFail = run('execFail', 1, depsDir, { ytdlpFail: true })

  if (!report.fatal) {
    // ── A 条：4 并发墙钟（DSH 建议阈值）+ 事件循环心跳（补牙） ──
    d.C184_quadWallWithinTwiceSingle = quad.wallMs > 0 && single.wallMs > 0
      && quad.wallMs <= single.wallMs * 2
    d.C184_eventLoopNotBlocked = quad.maxTickMs >= 0 && quad.maxTickMs <= TICK_LIMIT
    c.C184_fourConcurrentReallyServed = quad.codes.length === 4
      && quad.codes.every((x) => x === 200) && quad.oks.every((x) => x === true)
    c.C184_baselineGreen = single.spawns.length > 0 && quad.spawns.length > 0
      && single.codes[0] === 200 && single.oks[0] === true
    c.C184_singleNotCheated = single.maxTickMs <= TICK_LIMIT

    // ── B 条：4 并发下 yt-dlp 只起 1 次；没有同步 spawn ──
    d.C185_ytdlpSpawnOnce = quad.spawns.filter((s) => s.kind === 'ytdlp').length === 1
    d.C185_noSyncSpawn = quad.spawns.every((s) => s.kind !== 'sync')
    c.C185_singleSpawnsOnce = single.spawns.filter((s) => s.kind === 'ytdlp').length === 1
    // D2：路径不存在 → detail 必须是「没找到」，ok=false，不能拿 Promise/对象糊上去
    c.C185_missingYtDetail = missing.ytdlpRow !== null
      && missing.ytdlpRow.detail === '没找到，非 B 站 URL 不可用'
      && missing.ytdlpRow.ok === false
    // D2 反面：子进程失败但文件在 → detail 仍是确定字符串，不许出现 undefined / [object ...]
    c.C185_execFailDetailClean = execFail.ytdlpRow !== null
      && typeof execFail.ytdlpRow.detail === 'string'
      && execFail.ytdlpRow.detail.length > 0
      && !/undefined|\[object|Promise/.test(execFail.ytdlpRow.detail)
  }
} catch (e) {
  report.fatal = String(e?.stack || e).slice(0, 600)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify(report))
