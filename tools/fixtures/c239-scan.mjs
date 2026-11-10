// C239 / C238 共用的禁词现抽器：口径与 scripts/check-boundaries.mjs::walk 逐条对齐，
// 从生产代码现抽真实命中行（相对路径:行号:行文本），不手写造坏样本。
//
// mirror() 把命中行原样写进一棵临时树的对应路径，保留原行号（前面补空行）。
// 统一挂在 probe/ 前缀下：守卫的 ALLOW_FILES 按相对路径放行，镜像路径故意不在白名单里，
// 这样「每条都被点名」验的才是守卫真拦得住，而不是白名单刚好放过。
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const TOKENS = Object.freeze(['rmSync(', 'process.platform', 'spawn(', 'execFileSync('])
const SELF = 'scripts/check-boundaries.mjs'
const EXCLUDE_DIRS = ['node_modules', '_backup', '.git', 'dist', 'coverage']
const EXCLUDE_PATHS = ['tools/fixtures']
const EXTS = /\.(mjs|js|cjs|py)$/
const norm = (p) => p.split(sep).join('/')

export function walk(root) {
  const out = []
  const go = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const rel = norm(relative(root, abs))
      if (EXCLUDE_DIRS.includes(name) || EXCLUDE_PATHS.some((p) => rel === p || rel.startsWith(p + '/'))) continue
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) go(abs)
      else if (EXTS.test(name)) out.push({ abs, rel })
    }
  }
  go(root)
  return out
}

/** @returns {{rows: Array<{token:string,rel:string,line:number,text:string}>, fileCount:number, byToken: Record<string,number>}} */
export function collect(root) {
  const files = walk(root).filter((f) => f.rel !== SELF)
  const rows = []
  for (const f of files) {
    readFileSync(f.abs, 'utf8').split(/\r?\n/).forEach((text, i) => {
      for (const token of TOKENS) {
        if (text.includes(token)) rows.push({ token, rel: f.rel, line: i + 1, text: text.trim() })
      }
    })
  }
  const byToken = Object.fromEntries(TOKENS.map((t) => [t, rows.filter((r) => r.token === t).length]))
  return { rows, fileCount: files.length, byToken }
}

/** 按文件聚合，补空行到原行号；返回写进去的相对路径清单。 */
export function mirror(tmpRoot, rows, prefix = 'probe') {
  const byFile = new Map()
  for (const r of rows) {
    const rel = `${prefix}/${r.rel}`
    if (!byFile.has(rel)) byFile.set(rel, new Map())
    byFile.get(rel).set(r.line, r.text)
  }
  for (const [rel, lineMap] of byFile) {
    const abs = join(tmpRoot, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const maxLine = Math.max(...lineMap.keys())
    const lines = Array.from({ length: maxLine }, (_, i) => lineMap.get(i + 1) || '')
    writeFileSync(abs, lines.join('\n') + '\n', 'utf8')
  }
  return [...byFile.keys()]
}
