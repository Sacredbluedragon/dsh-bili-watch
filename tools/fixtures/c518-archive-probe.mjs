// C518：旧日志归档八现场。driver 模式 spawn 自己 --child，每个 SCENE 独立临时 DSH_HOME
// （避 lib/cache-path.mjs 的 initCachePath 进程级单例串根），真调 archiveOldLogs/archiveStatus。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SELF = fileURLToPath(import.meta.url)
const LIB = pathToFileURL(path.resolve(path.dirname(SELF), '../../lib/cache-path.mjs')).href

if (process.argv[2] === '--child') {
  const SCENE = process.env.SCENE
  const HOME = process.env.HOME_DIR
  const CUSTOM = process.env.CUSTOM_DIR || ''
  const bili = path.join(HOME, 'bili-watch')
  const cache = path.join(bili, 'cache')
  const topLogs = path.join(bili, '_logs')
  const defLogs = path.join(cache, '_logs')
  const arc = path.join(bili, 'logs', 'archive')
  const W = (d, f, s) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, f), s) }
  const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
  const mod = await import(LIB)
  const { archiveOldLogs, archiveStatus } = mod
  let R, extra = {}
  if (SCENE === 'old-root-only') {
    W(topLogs, 'runs.jsonl', 'OLD-A')
    R = archiveOldLogs()
    extra = { srcKept: rd(path.join(topLogs, 'runs.jsonl')), archivedAt: rd(path.join(arc, 'old-root', 'runs.jsonl')) }
  } else if (SCENE === 'coexist') {
    W(topLogs, 'runs.jsonl', 'OLD-B-TOP'); W(defLogs, 'runs.jsonl', 'NEW-B')
    R = archiveOldLogs()
    extra = { topKept: rd(path.join(topLogs, 'runs.jsonl')), defKept: rd(path.join(defLogs, 'runs.jsonl')),
      atOld: rd(path.join(arc, 'old-root', 'runs.jsonl')), atDef: rd(path.join(arc, 'default-cache', 'runs.jsonl')) }
  } else if (SCENE === 'custom-root') {
    W(topLogs, 'runs.jsonl', 'HOME-X'); W(path.join(CUSTOM, '_logs'), 'runs.jsonl', 'CUSTOM-Y')
    R = archiveOldLogs(CUSTOM)
    extra = { customKept: rd(path.join(CUSTOM, '_logs', 'runs.jsonl')), atCustom: rd(path.join(arc, 'custom-cache', 'runs.jsonl')) }
  } else if (SCENE === 'reuse') {
    W(topLogs, 'runs.jsonl', 'SAME'); archiveOldLogs()
    const before = rd(path.join(arc, 'old-root', 'runs.jsonl'))
    R = archiveOldLogs()
    extra = { before, after: rd(path.join(arc, 'old-root', 'runs.jsonl')) }
  } else if (SCENE === 'conflict') {
    W(topLogs, 'runs.jsonl', 'V1'); archiveOldLogs()
    W(topLogs, 'runs.jsonl', 'V2-DIFF')
    R = archiveOldLogs()
    extra = { atMain: rd(path.join(arc, 'old-root', 'runs.jsonl')), atTwo: rd(path.join(arc, 'old-root', 'runs.jsonl.2')) }
  } else if (SCENE === 'nonfile') {
    W(topLogs, 'runs.jsonl', 'PLAIN')
    fs.mkdirSync(path.join(topLogs, 'subdir'), { recursive: true })
    try { fs.symlinkSync(path.join(topLogs, 'runs.jsonl'), path.join(topLogs, 'alink')) } catch {}
    R = archiveOldLogs()
    extra = { atMain: rd(path.join(arc, 'old-root', 'runs.jsonl')), subdirExists: fs.existsSync(path.join(arc, 'old-root', 'subdir')) }
  } else if (SCENE === 'dedup-same-realpath') {
    W(topLogs, 'runs.jsonl', 'ONCE'); fs.mkdirSync(cache, { recursive: true })
    try { fs.symlinkSync(topLogs, defLogs, 'junction') } catch {}
    R = archiveOldLogs()
    extra = { srcKept: rd(path.join(topLogs, 'runs.jsonl')) }
  } else if (SCENE === 'overlap-kept') {
    // 新日志根与缓存根重叠时：跳过归档、保留现场（不搬不删）
    W(topLogs, 'runs.jsonl', 'KEEP')
    R = archiveOldLogs(HOME) // custom=HOME ⇒ custom/_logs 与真实 home 关系另算，用正常三来源
    extra = { srcKept: rd(path.join(topLogs, 'runs.jsonl')) }
  } else if (SCENE === 'midchange') {
    W(topLogs, 'runs.jsonl', 'STABLE'); R = archiveOldLogs()
    extra = { atMain: rd(path.join(arc, 'old-root', 'runs.jsonl')) }
  } else {
    process.stdout.write('C518_JSON=' + JSON.stringify({ error: 'bad SCENE ' + SCENE }) + '\n'); process.exit(0)
  }
  process.stdout.write('C518_JSON=' + JSON.stringify({ scene: SCENE, R, ...extra, statusSame: archiveStatus() === R }) + '\n')
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c518-archive-'))
const scenes = ['old-root-only', 'coexist', 'custom-root', 'reuse', 'conflict', 'nonfile', 'dedup-same-realpath', 'midchange']
const out = {}
for (const s of scenes) {
  const home = path.join(root, s, 'home')
  const custom = path.join(root, s, 'custom')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(custom, { recursive: true })
  const env = { ...process.env, DSH_HOME: home, SCENE: s, HOME_DIR: home, CUSTOM_DIR: custom }
  delete env.BILI_WATCH_CACHE
  const r = spawnSync(process.execPath, [SELF, '--child'], { env, encoding: 'utf8', timeout: 30000 })
  const m = /C518_JSON=(.*)/.exec(r.stdout || '')
  try { out[s] = { rc: r.status, ...(m ? JSON.parse(m[1]) : { parseFail: true, stdout: r.stdout, stderr: r.stderr }) } }
  catch (e) { out[s] = { rc: r.status, jsonError: String(e) } }
}
process.stdout.write('C518_JSON_ALL=' + JSON.stringify(out) + '\n')
try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
