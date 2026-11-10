// C296 取证夹具：stdout 只吐 JSON，所有断言留给 verify.mjs 自己做。
//   不设 PROBE_CHILD 轻量分支 —— 这条判据在任何路径都真跑，不新增阉割入口。
// 造四棵「完整」最小包树，真跑两道包内容面闸，交原始 rc 与原始输出；夹具不自判通过。
//   完整 = README.md / tools/look.mjs / description+keywords 都齐。缺任一个时
//   check-public-text 会因 helpSkipped / metaScanned 进 incomplete 而红 —— 那会让
//   「8 层内控制组 rc=0」和「两闸同源」变成凑出来的假绿，控制组必须干净。
//   deepDirty  : 9 层目录 + 深层文件含两闸都必命中的泄漏串（深层没被展开）。
//   deepClean  : 同样 9 层但内容干净 —— 验「没扫全就红」与有没有泄漏无关。
//   shallowClean: 8 层以内、干净 —— 反向控制组，两闸必须 rc=0 且说通过。
//   shallowDirty: 8 层以内、浅层文件含泄漏串 —— 验扫描面真有效，不是一律红。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LEAK = join(ROOT, 'scripts', 'check-release-leak.mjs')
const TEXT = join(ROOT, 'scripts', 'check-public-text.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c296-'))

// 两道闸都必命中：release-leak 的「内部工作区」、public-text 包内容面的「内部路径」。
// 哨兵前提由 shallowDirty 那条断言守着，规则变了会先红在「浅层没被点名」，不会假绿。
const BAD = 'D:\\007 Dsh工作区\\c296\\sentinel'
const CLEAN = 'a harmless packaging note'

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  const stdout = r.stdout || ''
  const stderr = r.stderr || ''
  return { rc: r.status, stdout, stderr, out: `${stdout}\n${stderr}` }
}

function both(root) {
  return {
    leak: run(LEAK, ['--dir', root]),
    text: run(TEXT, ['--repo', root]),
  }
}

function seed(name, { deep = false, bad = false } = {}) {
  const root = join(tmp, name)
  mkdirSync(join(root, 'tools'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'c296-fixture', version: '0.0.0',
    description: 'clean fixture package', keywords: ['clean'],
    files: ['lib/'],
  }))
  writeFileSync(join(root, 'README.md'), 'clean fixture readme\n')
  writeFileSync(join(root, 'tools', 'look.mjs'), "console.log('usage: c296 fixture')\n")
  // 浅层哨兵：只给 shallowDirty 放 BAD；深层那两棵的浅层保持干净。
  writeFileSync(join(root, 'lib', 'top.txt'), `${bad && !deep ? BAD : CLEAN}\n`)
  if (deep) {
    let d = join(root, 'lib')
    for (let i = 1; i <= 9; i += 1) { d = join(d, `d${i}`); mkdirSync(d, { recursive: true }) }
    writeFileSync(join(d, 'deep.txt'), `${bad ? BAD : CLEAN}\n`)
  }
  return { root }
}

const out = { error: null, trees: {} }
try {
  out.trees.deepDirty = both(seed('deepDirty', { deep: true, bad: true }).root)
  out.trees.deepClean = both(seed('deepClean', { deep: true }).root)
  out.trees.shallowClean = both(seed('shallowClean', {}).root)
  out.trees.shallowDirty = both(seed('shallowDirty', { bad: true }).root)
} catch (e) {
  out.error = String((e && e.stack) || e)
}
process.stdout.write(JSON.stringify(out))
try { rmSync(tmp, { recursive: true, force: true }) } catch {}
