// C355 取证夹具：.tool.txt 不进逐写盘点台账（ledgerVersion 2）。
// 两个场景各起独立 mkdtemp 根，stdout 只吐一行 JSON；finally 里 rmSync 回收，
// catch 里把 stack 放进 out.fatal，结论由 verify.mjs 的 C355 自己算。
//
// 为什么单独一个夹具而不塞进 c352-c354-probe.mjs：那三个场景的 appendLedger 序列
// 是 C354 现期望值（files=["text.txt","text.json"]）的取证源，插 .tool.txt 会改到
// 既有字段，把 C354 连带弄红。这里另起一棵树，两个场景互不影响。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const { mergeLedger, appendLedger } = await import(pathToFileURL(join(ROOT, 'lib', 'frames.mjs')).href)

const out = { fatal: null }
const roots = []
const mkRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'bw-c355-'))
  roots.push(r)
  return r
}

try {
  // 场景 A：直接真调 mergeLedger。entries 里明确放一条 .tool.txt 与一条 meta.json，
  //   把「被测的东西」摆进场景里 —— 0112 段缺口二指出的正是旧 C354 场景里没有它。
  const entries = [
    { name: 'text.txt', bytes: 5 },
    { name: 'x.tool.txt', bytes: 7 },
    { name: 'meta.json', bytes: 2 },
  ]
  const direct = mergeLedger({}, entries)
  out.direct = {
    files: (direct.files || []).map((f) => f.name),
    ledgerVersion: direct.ledgerVersion,
    toolInLedger: (direct.files || []).some((f) => String(f.name).endsWith('.tool.txt')),
    // 前提断言用：确认传进去的那条 .tool.txt 确实在场，不是空场景假绿
    entriesToolSeen: entries.some((e) => e.name.endsWith('.tool.txt')),
    // 反向证明：正常产物没被一并过滤掉（若整棵树没跑，这条会是 false）
    normalSurvived: (direct.files || []).some((f) => f.name === 'text.txt'),
  }

  // 场景 B：真目录 + appendLedger 序列。目录里真落一个 .tool.txt 文件，
  //   并把它写进第二轮 entries（模拟工具层把长文本落盘产物也报进盘点），
  //   看 mergeLedger 是否仍把它挡在台账外。
  const root = mkRoot()
  const bv = join(root, 'BV13hWj68ELy')
  mkdirSync(bv, { recursive: true })
  appendLedger(bv, [{ name: 'text.txt', bytes: 5 }])
  const toolPath = join(bv, 'x.tool.txt')
  writeFileSync(toolPath, 'TOOL', 'utf8')
  appendLedger(bv, [
    { name: 'x.tool.txt', bytes: 7 },
    { name: 'text.json', bytes: 5 },
  ])
  const meta = JSON.parse(readFileSync(join(bv, 'meta.json'), 'utf8'))
  out.sequence = {
    files: (meta.files || []).map((f) => f.name),
    ledgerVersion: meta.ledgerVersion,
    toolInLedger: (meta.files || []).some((f) => String(f.name).endsWith('.tool.txt')),
    // 前提断言用：目录里那个 .tool.txt 真的存在（场景里被测的东西在场）
    toolOnDisk: existsSync(toolPath),
    normalSurvived: (meta.files || []).some((f) => f.name === 'text.txt')
      && (meta.files || []).some((f) => f.name === 'text.json'),
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 800)
} finally {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }) } catch {}
  }
}

console.log(JSON.stringify(out))
