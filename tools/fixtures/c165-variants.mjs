// C270 / C165 真跑夹具：8 个协作变体在「文案面齐全」的假仓库上逐个送两道文本闸。
//
// 为什么不沿用 C165 原来那棵最小树：缺 tools/look.mjs、缺 description/keywords 时
// check-public-text.mjs 会以「对外文案面未扫全」对**任何**输入 exit 1 —— 干净行也红。
// 只断 rc!==0 的那一半等于恒真（C237 报告 §五记的那个 P1，DSH 2232 段已独立复现）。
// 被测面统一用 c237-guards.mjs 的补齐树；另保留一棵缺 look.mjs 的对照树，单独证明
// 「按未扫全红」是 check-public-text 的另一条正确行为，不许因为修 C165 一起改掉。
//
// 本文件只做真跑与形状化，不判对错；判据在 tools/verify.mjs 的 C165 ② 与 C270。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { makeRepo, dropRepo, runGuards, PROBE_REL } from './c237-guards.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

export const CLEAN_LINE = '// 缓存目录默认值见配置项'
export const VARIANTS = Object.freeze(['WB-CN', 'wbcn', 'ＷＢＣＮ', 'Work Buddy', 'Hy-4',
  '20261105-2308-dsh', 'DSH　2308', '派 单'])

/** 对照树：C165 修前用的最小形态（无 tools/look.mjs、无 description/keywords）。 */
export function makeBareRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'c270-bare-'))
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: 'c270-bare-probe', version: '0.0.1', files: ['README.md', PROBE_REL],
  }))
  writeFileSync(join(tmp, 'README.md'), '# probe\n')
  writeFileSync(join(tmp, PROBE_REL), CLEAN_LINE + '\n')
  return tmp
}

/** 一行送两闸；只做形状化，规则名真求值在判据那边做，不在这里写死。 */
function shape(r) {
  const out = r.out || ''
  return {
    guard: r.guard,
    status: r.status,
    crashed: r.crashed,
    named: r.named,
    lineHit: /probe\.txt:1|:1 \[/.test(out),
    ruleTags: [...out.matchAll(/\[([^\]\n]{2,24})\]/g)].map((m) => m[1]),
    unscanned: /对外文案面未扫全/.test(out),
    lookMissing: /tools\/look\.mjs 不存在/.test(out),
    clean: r.status === 0 && !r.crashed && !/未扫全|没读到/.test(out),
  }
}

export function collect() {
  const full = makeRepo()
  let controlRows, variantRows
  try {
    controlRows = runGuards(ROOT, full, CLEAN_LINE).map(shape)
    variantRows = VARIANTS.map((variant) => ({ variant, rows: runGuards(ROOT, full, variant).map(shape) }))
  } finally { dropRepo(full) }
  const bare = makeBareRepo()
  let bareRows
  try { bareRows = runGuards(ROOT, bare, CLEAN_LINE).map(shape) }
  finally { rmSync(bare, { recursive: true, force: true }) }
  return { probeRel: PROBE_REL, cleanLine: CLEAN_LINE, variants: [...VARIANTS], controlRows, variantRows, bareRows }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(collect(), null, 2))
}
