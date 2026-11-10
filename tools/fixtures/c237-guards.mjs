// C237 真跑夹具：造一棵「对本文案面齐全」的最小假仓库，逐行送进两道文本闸。
//
// 为什么不沿用 C165 的最小树：check-public-text.mjs 在缺 tools/look.mjs、缺
// description/keywords 时会以「对外文案面未扫全」直接 exit 1。那棵树上**连干净行都红**，
// 只断 rc!==0 的断言等于恒真。这里把两面补齐，让「干净行 rc=0、命中行才 rc!==0」，
// 并且断到「输出点名了 probe.txt 第 1 行」，不看光秃秃的退出码。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PROBE_REL = 'probe.txt'

export function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'c237-'))
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: 'c237-probe', version: '0.0.1',
    description: 'minimal package for text guard probe',
    keywords: ['probe'],
    files: [PROBE_REL],
  }))
  writeFileSync(join(tmp, 'README.md'), '# probe\n\nA clean readme.\n')
  mkdirSync(join(tmp, 'tools'))
  // --help 面必须能真跑起来且 stdout 非空、内容干净，否则 public-text 会记「未扫全」。
  writeFileSync(join(tmp, 'tools', 'look.mjs'),
    "process.stdout.write('usage: probe [--help]\\n')\n")
  writeFileSync(join(tmp, PROBE_REL), '// clean\n')
  return tmp
}

export function dropRepo(tmp) { rmSync(tmp, { recursive: true, force: true }) }

/** 逐行送检；返回两道闸各自的 {guard, status, out, crashed, named} */
export function runGuards(repoRoot, tmp, line) {
  writeFileSync(join(tmp, PROBE_REL), line + '\n')
  const cases = [
    ['check-public-text', 'scripts/check-public-text.mjs', ['--repo', tmp], (o) => o.includes(`包内:${PROBE_REL}:1`)],
    ['check-release-leak', 'scripts/check-release-leak.mjs', ['--dir', tmp], (o) => o.includes(`${PROBE_REL}: 1 处`)],
  ]
  return cases.map(([guard, script, args, named]) => {
    const r = spawnSync(process.execPath, [join(repoRoot, script), ...args],
      { encoding: 'utf8', timeout: 60000, cwd: repoRoot })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    return {
      guard,
      status: r.status,
      out,
      crashed: /ERR_MODULE_NOT_FOUND|Cannot find module|ReferenceError|SyntaxError|TypeError|✗ 找不到/.test(out),
      named: named(out),
    }
  })
}

/** 控制组：干净行必须两闸都 rc=0，且 public-text 不许报「未扫全」。 */
export function control(repoRoot, tmp) {
  const res = runGuards(repoRoot, tmp, '// 缓存目录默认值见配置项')
  return res.map((r) => ({
    guard: r.guard,
    clean: r.status === 0 && !r.crashed && !/未扫全|没读到/.test(r.out),
    detail: `${r.guard} rc=${r.status}${r.crashed ? ' 脚本崩' : ''}${/未扫全/.test(r.out) ? ' 对外面未扫全' : ''}`,
  }))
}
