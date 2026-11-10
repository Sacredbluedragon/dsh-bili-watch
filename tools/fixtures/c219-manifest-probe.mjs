// C219 / A6：sheet 写了格位索引却不说在哪。
// ① 纯函数真写盘 → existsSync + JSON 可解析；② CLI dry-run 两种 grid 都点名索引路径；
// ③ 把 cmdSheet 里「写索引 + 打提示」两行原样切出在 vm 里跑，桩 console.log 收集真实输出。
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { manifestPathOf, writeSheetManifest, manifestLine } from '../../lib/sheet-manifest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const look = join(root, 'tools', 'look.mjs')
const src = readFileSync(look, 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'c219-'))
const out = join(tmp, 'out.jpg')

// ① 真写盘
const data = { bv: 'BV-C219', grid: '3x3', at: null, step: 10, cells: [{ cell: 1, sec: 5 }] }
const mp = writeSheetManifest(out, data)
const written = existsSync(mp)
let parsed = null
try { parsed = JSON.parse(readFileSync(mp, 'utf8')) } catch {}
const keysOk = parsed && Object.keys(parsed).sort().join(',') === 'at,bv,cells,grid,step'
const pathOk = mp === manifestPathOf(out) && mp.endsWith('.manifest.json')
const lineOk = manifestLine(mp).startsWith('格位索引: ') && manifestLine(mp).includes(mp)

// ② CLI dry-run 两种形态（缓存指向临时目录，全程离线）
const env = { ...process.env, BILI_WATCH_CACHE: tmp }
const runCli = (args) => {
  const r = spawnSync(process.execPath, [look, 'sheet', 'BV19dJQ6sE9F', '--dry-run', ...args], { encoding: 'utf8', env, timeout: 30000 })
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.split(tmp).join('<TMP>') }
}
const grid33 = runCli(['--dur', '60'])
const grid44 = runCli(['--dur', '120', '--grid', '4x4'])
const names = (o) => o.out.includes('格位索引将写') && o.out.includes('.manifest.json') && o.out.includes('dry-run 不落盘')

// ③ 原样切出「写索引 + 打提示」两行，vm 里跑，收集 console.log
const aMark = '      const mp = writeSheetManifest('
const bMark = '      console.log(manifestLine(mp))'
const a = src.indexOf(aMark)
const b = src.indexOf(bMark, a)
const fragment = a >= 0 && b > a ? src.slice(a, src.indexOf('\n', b)) : ''
const logs = []
if (fragment) {
  const sandbox = {
    writeSheetManifest: () => '<TMP>/out.manifest.json', manifestLine,
    bv: 'BV-C219', grid: '3x3', at: '', stepUsed: 10, cells: [], out: '<TMP>/out.jpg',
    // C220 之后这两行之间多了一句 opts.result.manifest = mp；沙箱要认得它，
    // 否则整段抛 ReferenceError 被吞掉，提示行反而没跑到（红错地方）。
    opts: { result: {} },
    console: { log: (...x) => logs.push(x.join(' ')), error: () => {} },
  }
  try { vm.runInNewContext(fragment, sandbox, { timeout: 2000 }) } catch {}
}

// 既有散文输出行必须一字未改
const proseUntouched = src.includes('    console.log(`拼图: ${out}（${(statSync(out).size / 1024).toFixed(0)} KiB，共 ${picked.length} 帧）`)')
const appendInSource = src.includes('console.log(manifestLine(mp))')
rmSync(tmp, { recursive: true, force: true })

console.log(JSON.stringify({
  written, pathOk, keysOk, lineOk,
  grid33, grid44, names33: names(grid33), names44: names(grid44),
  fragmentLength: fragment.length, logs, proseUntouched, appendInSource,
}))
