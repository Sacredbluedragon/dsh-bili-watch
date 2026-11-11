// C320 取证夹具：用真守卫 + --root 最小树，验 ⑥ 改完的扫面口径真的生效。
//   1522 段实测过 --root 可用；这里五个样本各自一棵树，互不干扰。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = join(HERE, '..', '..')
const GUARD = join(DEV, 'scripts', 'check-boundaries.mjs')
const LINE = "rmSync('/tmp/ScanProbe')"
const base = mkdtempSync(join(tmpdir(), 'c320-'))
const result = {}
try {
  const run = (tree) => {
    const r = spawnSync(process.execPath, [GUARD, '--root', tree], {
      cwd: DEV, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    })
    return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
  }
  const mk = (tag, rel, content) => {
    const t = join(base, tag)
    const p = join(t, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content + '\n')
    return run(t)
  }
  // 换扩展名 2 条：改完 EXTS 后必须被扫到
  result.mts = mk('mts', 'lib/evil.mts', LINE)
  result.ts = mk('ts', 'lib/evil.ts', LINE)
  // 换目录 2 条：发布面内的 lib/dist 要扫到，根级 dist 仍排除
  result.libDist = mk('libdist', 'lib/dist/evil.mjs', LINE)
  result.rootDist = mk('rootdist', 'dist/evil.mjs', LINE)
  // 干净树：防「一律报红」蒙混
  result.clean = mk('clean', 'lib/ok.mjs', 'const a = 1')
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(base, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
