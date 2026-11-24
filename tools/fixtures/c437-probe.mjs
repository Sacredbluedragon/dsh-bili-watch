// C437 取证夹具：真编译产品 lookup+splitNextStep+trimForModel，桩 runLook 回放真跑 fixture。
// 判据 spawnSync 本脚本取 JSON 后下断言；形状全部由产品函数体产出，夹具不拼 parts。
import { readFileSync } from 'node:fs'
const ROOT = new URL('../../', import.meta.url)
const src = readFileSync(new URL('index.js', ROOT), 'utf8')
const keys = readFileSync(new URL('lib/keys.mjs', ROOT), 'utf8')
const err = readFileSync(new URL('tools/fixtures/c437-longtext-err.txt', ROOT), 'utf8')
const out = readFileSync(new URL('tools/fixtures/c437-longtext-out.txt', ROOT), 'utf8')
function fnBody(src, name) {
  const lines = src.split('\n')
  const re = new RegExp('^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(')
  const start = lines.findIndex((l) => re.test(l) && !/^\s*(?:\/\/|\*)/.test(l))
  if (start < 0) throw new Error('找不到 function ' + name)
  const head = lines[start]
  const startLine = head.slice(head.indexOf('function'))
  let end = -1
  for (let i = start + 1; i < lines.length; i++) { if (/^\}/.test(lines[i])) { end = i; break } }
  if (end < 0) throw new Error(name + ' 没有行首闭合括号')
  const isAsync = /^\s*(?:export\s+)?async\s/.test(head)
  return (isAsync ? 'async ' : '') + [startLine, ...lines.slice(start + 1, end + 1)].join('\n')
}
const NEXT_STEP_PREFIX = '▶ 下一步：'
const prelude = fnBody(keys, 'cutCp')
const runLook = async () => ({ code: 1, err, out, ms: 1 })
const body = prelude + '\n' + ['splitNextStep','lookup','trimForModel'].map((n) => fnBody(src, n)).join('\n') +
  '\nreturn { splitNextStep, lookup, trimForModel }'
const { lookup, trimForModel } = new Function('runLook','COMMANDS','writeLastRun','extractWrittenPath',
  'suggestFlag','NEXT_STEP_PREFIX','toolTextCap','toolTextHead','videoDir','join','writeFileSync','TOOL_FILE_SEQ','readTuning', body)(
  runLook, ['text','frames','ocr','local','clean','login','hot','search','comments'], () => {}, () => null,
  (x) => String(x), NEXT_STEP_PREFIX, () => 2000, () => 800, () => '/tmp/c437-probe',
  (a, b) => a + '/' + b, () => {}, 0, () => ({ toolTextCap: 2000, toolHead: 800 })
)
const r = await lookup({ command: 'text', bv: 'BV17x411c7mD', positionals: [], extra: ['--p','1','--fast'] })
const combined = String(r && r.text || '')
const trimmed = trimForModel(combined, 'text', 'BV17x411c7mD', false, { head: 800, noPersist: true })
const head800 = [...trimmed].slice(0, 800).join('')
const t2 = trimForModel(combined, 'text', 'BV17x411c7mD', false, { head: 1950, noPersist: true })
const mm = String(t2).match(/只回了前 (\d+) 字/)
const res = {
  hasNextPrefixInFixture: err.includes(NEXT_STEP_PREFIX),
  hasSummaryInFixture: /summary chars=0 loadFail=34/.test(err),
  combinedCp: [...combined].length, cap: 2000,
  truncated: trimmed !== combined, trimmedCp: [...trimmed].length,
  exitPos: combined.indexOf('退出码 1'),
  hasTextFailBeforeExit: combined.slice(0, Math.max(0, combined.indexOf('退出码 1'))).includes('text 失败'),
  head800HasExit: head800.includes('退出码 1'),
  stepLine: combined.split(/\r?\n/).find((l) => l.trim().startsWith(NEXT_STEP_PREFIX)) || '',
  head800HasCmd: head800.includes('frames BV17x411c7mD'),
  head800HasFresh: head800.includes('--fresh'),
  effHead: mm ? Number(mm[1]) : -1,
  t2WithinCap: [...t2].length <= 2000,
}
console.log(JSON.stringify(res))
