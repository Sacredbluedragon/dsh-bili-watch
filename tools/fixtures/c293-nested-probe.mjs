// C293 取证夹具：stdout 只吐 JSON，所有断言留给 verify.mjs 自己做。
//   不设 PROBE_CHILD 轻量分支 —— 这条判据在任何路径都真跑，不新增阉割入口。
// 造四棵最小包树，真跑两道包内容面闸，交原始 rc 与原始输出；夹具不自判「通过」。
//   dirty : lib/top-leak.txt（平铺）+ lib/sub/leak.txt（嵌套）含两闸都必命中的泄漏串，
//           另在 files 里写一个没建的目录 not-created/，验「目录不存在进 ABSENT 不炸」。
//   clean : 同结构、无泄漏串，两闸应 rc=0。
//   deep  : lib/d1/.../d9/ 超过 8 层，验「深度超限记 complain，不许静默截断」。
//   link  : lib/junc 是指向树外目录的 junction，验「lstatSync 跳过符号链接」。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LEAK = join(ROOT, 'scripts', 'check-release-leak.mjs')
const TEXT = join(ROOT, 'scripts', 'check-public-text.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c293-'))

// 两道闸都必命中：release-leak 的「Windows 绝对路径」/「内部工作区」，
// public-text 包内容面的「内部路径」。哨兵前提由 C293 的平铺断言守着，
// 万一规则变了导致这个串不命中，判据会红在「平铺没被点名」，不会假绿。
const BAD = 'D:\\007 Dsh工作区\\c293\\sentinel'
const CLEAN = 'a harmless packaging note'

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  return { rc: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}

function both(root) {
  return {
    leak: run(LEAK, ['--dir', root]),
    text: run(TEXT, ['--repo', root]),
  }
}

function seed(name, opts = {}) {
  const { flat = false, nested = false, deep = false, link = false, missing = false } = opts
  const root = join(tmp, name)
  mkdirSync(join(root, 'tools'), { recursive: true })
  mkdirSync(join(root, 'lib', 'sub'), { recursive: true })
  const files = ['lib/']
  if (missing) files.push('not-created/')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'c293-fixture', version: '0.0.0',
    description: 'clean fixture package', keywords: ['clean'],
    files,
  }))
  // public-text 会扫 README 与 tools/look.mjs --help；两面都得存在且干净，
  // 否则 helpSkipped / metaScanned 会进 incomplete，把「干净树 rc=0」污染掉。
  writeFileSync(join(root, 'README.md'), 'clean fixture readme\n')
  writeFileSync(join(root, 'tools', 'look.mjs'), "console.log('usage: c293 fixture')\n")
  writeFileSync(join(root, 'lib', 'top-leak.txt'), `${flat ? BAD : CLEAN}\n`)
  writeFileSync(join(root, 'lib', 'sub', 'leak.txt'), `${nested ? BAD : CLEAN}\n`)
  if (deep) {
    let d = join(root, 'lib')
    for (let i = 1; i <= 9; i += 1) { d = join(d, `d${i}`); mkdirSync(d, { recursive: true }) }
    writeFileSync(join(d, 'deep.txt'), `${BAD}\n`)
  }
  let linkInfo = { created: false }
  if (link) {
    const outside = join(tmp, `${name}-outside`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'outside-leak.txt'), `${BAD}\n`)
    try {
      // Windows 上 'junction' 不需要管理员权限；target 必须绝对路径。
      symlinkSync(outside, join(root, 'lib', 'junc'), 'junction')
      linkInfo = { created: true, target: outside }
    } catch (e) {
      linkInfo = { created: false, reason: String((e && e.message) || e) }
    }
  }
  return { root, linkInfo }
}

const out = { error: null, trees: {} }
try {
  const dirty = seed('dirty', { flat: true, nested: true, missing: true })
  out.trees.dirty = both(dirty.root)
  const clean = seed('clean', {})
  out.trees.clean = both(clean.root)
  const deep = seed('deep', { deep: true })
  out.trees.deep = both(deep.root)
  const link = seed('link', { link: true })
  out.trees.link = { ...both(link.root), link: link.linkInfo }
} catch (e) {
  out.error = String((e && e.stack) || e)
}
process.stdout.write(JSON.stringify(out))
try { rmSync(tmp, { recursive: true, force: true }) } catch {}
