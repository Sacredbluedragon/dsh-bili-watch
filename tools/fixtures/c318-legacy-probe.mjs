// C318/C319 取证夹具：stdout 只吐 JSON，结论留给 verify.mjs 自己算。
//   1518 段 §三 4 / 1522 段：真守卫 + --root 最小树，不复制守卫逻辑、不改真源码。
//   ① 正向：新散落调用的 key 不在 LEGACY 快照里 → 必红；
//   ② 反向：副本守卫把该 key 塞进 LEGACY_KEYS → 必绿（证明放行真按 key 工作）；
//   ③ C319 毒化：副本守卫塞一条真树不存在的假 key，dump 与 emit 的双向差集必须非空。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = join(HERE, '..', '..')
const GUARD = join(DEV, 'scripts', 'check-boundaries.mjs')
const PROBE_LINE = "rmSync('/tmp/NewScatteredCall')"
const NEW_KEY = 'lib/evil.mjs|' + PROBE_LINE
const FAKE_KEY = 'lib/never-exists.mjs|const fake = 1'
const GUARD_ANCHOR = 'const LEGACY = EMIT ? new Set() : new Set(LEGACY_KEYS)'

const result = {}
const tmp = mkdtempSync(join(tmpdir(), 'c318-tree-'))
const guardDir = mkdtempSync(join(tmpdir(), 'c318-guard-'))
try {
  const tree = join(tmp, 'tree')
  mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'lib', 'evil.mjs'), PROBE_LINE + '\n')

  const guardSrc = readFileSync(GUARD, 'utf8')
  const built = guardSrc.includes(GUARD_ANCHOR)

  const runGuard = (guard, args) => {
    const r = spawnSync(process.execPath, [guard, ...args], {
      cwd: DEV, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    })
    return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
  }
  const withKey = (key) => built
    ? guardSrc.replace(GUARD_ANCHOR, `LEGACY_KEYS.push(${JSON.stringify(key)})\n` + GUARD_ANCHOR)
    : guardSrc

  // ① 正向
  result.forward = runGuard(GUARD, ['--root', tree])

  // ② 反向：副本守卫（放在另一临时目录，不在 --root 扫面里）
  const guardRev = join(guardDir, 'guard-reverse.mjs')
  writeFileSync(guardRev, withKey(NEW_KEY))
  result.reverse = { built, ...runGuard(guardRev, ['--root', tree]) }

  // ③ 毒化与对照：dump/emit 都显式指回真树，保证两边同源
  const guardPoison = join(guardDir, 'guard-poison.mjs')
  writeFileSync(guardPoison, withKey(FAKE_KEY))
  result.poison = {
    built,
    dump: runGuard(guardPoison, ['--dump-legacy', '--root', DEV]),
    emit: runGuard(GUARD, ['--emit-legacy', '--root', DEV]),
  }
  result.clean = {
    dump: runGuard(GUARD, ['--dump-legacy', '--root', DEV]),
    emit: runGuard(GUARD, ['--emit-legacy', '--root', DEV]),
  }
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  try { rmSync(guardDir, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
