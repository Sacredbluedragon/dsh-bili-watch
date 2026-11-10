// C226 / C238：在临时镜像树里跑真正的 check-boundaries.mjs，不碰生产树。
// 三对双向证据：干净 → 造坏（rc=1 且点名）→ 删掉坏行（rc=0）。
//
// C238：造坏输入不再手写 token 构造串。全部来自 c239-scan.mjs::collect() 从生产仓库
// 现抽的真实调用行（相对路径 / 行号 / 行文本），与守卫 walk 同口径。C266 会逐条比对
// cases[].lineText 确实是生产原文，防止有人把样本又改回手写。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { collect, TOKENS } from './c239-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const guard = join(REPO, 'scripts', 'check-boundaries.mjs')
const root = mkdtempSync(join(tmpdir(), 'c226-'))
const P = (rel, text) => {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
  return abs
}
const run = () => {
  const r = spawnSync(process.execPath, [guard, '--root', root], { encoding: 'utf8', timeout: 20000 })
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
}

const { rows } = collect(REPO)
// 干净树只取「整行恰好命中一类禁词」的真实行，按**原相对路径**写回去：
// 这些路径本来就在对应白名单里，守卫必须放行。行文本原样，不拼接、不改写。
const single = rows.filter((r) => TOKENS.filter((t) => r.text.includes(t)).length === 1)
const sample = TOKENS.map((t) => single.find((r) => r.token === t)).filter(Boolean)
const cleanByFile = new Map()
for (const r of sample) {
  if (!cleanByFile.has(r.rel)) cleanByFile.set(r.rel, [])
  cleanByFile.get(r.rel).push(r.text)
}
for (const [rel, lines] of cleanByFile) P(rel, lines.join('\n') + '\n')
// 一个不含禁词的普通文件，作镜像树的干净基线
P('tools/ok.mjs', 'export const ok = 1\n')
const clean = run()

// 造坏：把同一批生产原文写到白名单外的路径，token 也从现抽行取，不手写。
// probe/ 前缀既避开白名单，也避开上面干净树的原路径，造坏不会覆盖干净样本。
const BAD_RELS = {
  'rmSync(': 'probe/lib/media.mjs',
  'process.platform': 'probe/tools/look.mjs',
  'spawn(': 'probe/index.js',
  'execFileSync(': 'probe/index.js',
}
const cases = sample.map((r) => {
  const rel = BAD_RELS[r.token]
  const abs = P(rel, r.text + '\n')
  const bad = run()
  rmSync(abs, { force: true })
  const restored = run()
  return {
    name: r.token, rel, token: r.token, lineText: r.text,
    source: `${r.rel}:${r.line}`,
    badRc: bad.rc, badOut: bad.out,
    named: bad.out.includes(rel) && bad.out.includes(r.token),
    restoreRc: restored.rc,
  }
})

rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify({ cleanRc: clean.rc, cleanOut: clean.out, cases }))
