// 1717 A件判据夹具：真调 archiveOldLogs 出口，注入硬链接 ENOTSUP + 回退短写/抛错/成功/重试。
// driver spawn 自己 --child，--require c524-patch.cjs（ESM 静态 import 绑 patch 必须 syncBuiltinESMExports）。
// patch 文件放同目录保持夹具自洽；每现场独立临时 DSH_HOME。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const PATCH = join(dirname(SELF), 'c524-patch.cjs')
const MOD_URL = pathToFileURL(join(dirname(SELF), '..', '..', 'lib', 'cache-path.mjs')).href

async function child() {
  const { archiveOldLogs, archiveStatusSummary } = await import(MOD_URL)
  const R = archiveOldLogs(null)
  console.log('C524_CHILD=' + JSON.stringify({ summary: archiveStatusSummary(), errors: R.errors, conflicts: R.conflicts }))
}

function runScene(home, mode) {
  const env = { ...process.env, DSH_HOME: home, PATCH_MODE: mode }
  delete env.BILI_WATCH_CACHE
  const r = spawnSync(process.execPath, ['--require', PATCH, SELF, '--child'], { encoding: 'utf8', env })
  const m = (r.stdout || '').match(/C524_CHILD=(.*)/)
  if (!m) return { err: (r.stderr || '').slice(0, 400), rc: r.status }
  return { ...JSON.parse(m[1]), rc: r.status }
}
function mkHome(tag) {
  const home = mkdtempSync(join(tmpdir(), 'c524-' + tag + '-'))
  const logs = join(home, 'bili-watch', '_logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'runs.jsonl'), 'ABCDEFGH')
  return home
}
function inspect(home) {
  const logs = join(home, 'bili-watch', '_logs')
  const dstDir = join(home, 'bili-watch', 'logs', 'archive', 'old-root')
  const files = existsSync(dstDir) ? readdirSync(dstDir).filter((f) => f !== 'runs.jsonl') : []
  const main = existsSync(join(dstDir, 'runs.jsonl')) ? readFileSync(join(dstDir, 'runs.jsonl'), 'utf8') : null
  const src = existsSync(join(logs, 'runs.jsonl')) ? readFileSync(join(logs, 'runs.jsonl'), 'utf8') : null
  return { extraFiles: files, main, src }
}

if (process.argv[2] === '--child') {
  await child()
} else {
  const out = {}
  for (const [tag, mode] of [['enospc', 'enospc'], ['short', 'short'], ['tamper', 'tamper'], ['ok', 'ok']]) {
    const home = mkHome(tag)
    out[tag] = { ...runScene(home, mode), ...inspect(home) }
    rmSync(home, { recursive: true, force: true })
  }
  {
    const home = mkHome('retry')
    const fail = runScene(home, 'short')
    const afterFail = inspect(home)
    const ok = runScene(home, 'ok')
    out.retry = { fail, afterFail, ok, final: inspect(home) }
    rmSync(home, { recursive: true, force: true })
  }
  console.log('C524_JSON=' + JSON.stringify(out))
}
