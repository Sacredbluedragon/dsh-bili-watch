// C223：验「rate < 2 时 AI 能看到的那层真的带 ⚠」。
// 不 import look.mjs（会起命令层），把它 rate 计算到分支之间那段源码**原样切出来**在 vm 里真跑，
// 桩 track 收集调用方实际交给它的字符串。判据另验工具层 --quiet + filter(⚠) 的回灌链路。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { asrCoverageNotice } from '../../lib/asr-coverage.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'tools', 'look.mjs'), 'utf8')
const idx = readFileSync(join(root, 'index.js'), 'utf8')

const RATE = '      const rate = v.dur > 0 ? a.chars / v.dur : 0'
const BRANCH = '      if (rate >= 2 && !(a.verify && a.verify.suspect)) {'
const rateAt = src.indexOf(RATE)
const branchAt = src.indexOf(BRANCH, rateAt)
const snippet = rateAt >= 0 && branchAt > rateAt ? src.slice(rateAt, branchAt) : ''
// anchorOk 只管「切到了那段源码」，不管里面还有没有 track —— 否则删掉 track 时会
// 红在夹具前提上，把「AI 看不到 ⚠」这个真实现象遮住（C216 同型坑）。
const anchorOk = snippet.length > 0 && snippet.includes('asrCoverageNotice')

const run = (name, chars, dur) => {
  const captured = []
  const sandbox = {
    a: { chars }, v: { dur },
    track: (...args) => captured.push(args.map((x) => String(x)).join(' ')),
    asrCoverageNotice, Math, Number,
  }
  vm.runInNewContext(snippet, sandbox, { timeout: 2000 })
  return {
    name, chars, dur, trackLines: captured,
    hasWarn: captured.some((s) => s.includes('⚠')),
    hasReason: captured.some((s) => s.includes('覆盖不足')),
  }
}

const cases = [run('low', 30, 60), run('high', 300, 60), run('zeroDur', 30, 0)]

console.log(JSON.stringify({
  anchorOk,
  callCount: (src.match(/asrCoverageNotice\(/g) || []).length,
  importOk: src.includes("import { asrCoverageNotice } from '../lib/asr-coverage.mjs'"),
  placementOk: rateAt > src.indexOf('const a = await transcribe') && branchAt > rateAt,
  quietOk: /push\('--quiet'\)/.test(idx),
  filterOk: /filter\(\(l\) => l\.includes\('⚠'\)\)/.test(idx),
  snippet,
  cases,
}))
