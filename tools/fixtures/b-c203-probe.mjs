// 1053-DSH 第一批夹具：把 index.js 的 execute extra 拼装段原样抠出来真跑，
// 输出 argv 原始数组，判与不判交给 tools/verify.mjs。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(ROOT, 'index.js'), 'utf8')
const a = src.indexOf('      const extra = []')
const b = src.indexOf("      if (args.command === 'hot')", a)
if (a < 0 || b < 0) throw new Error('extra 拼装段抽取点变了')
const seg = src.slice(a, b)
const argvFor = (args) => new Function('args', seg + '\nreturn extra')(args)
const schemaText = src.slice(src.indexOf('    parameters: {'), src.indexOf('    output: {'))
const COMMANDS = (() => {
  const m = /const COMMANDS = \[([^\]]*)\]/.exec(src)
  return m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : []
})()
const commandEnum = (() => {
  const m = /command: \{[\s\S]*?enum: \[([^\]]*)\]/.exec(src)
  return m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : []
})()

const keys = ['at', 'ffmpeg', 'asrMax', 'markSeen', 'noTime']
const cases = {
  at: { at: '12:30' }, ffmpeg: { ffmpeg: 'deps/ffmpeg.exe' },
  asrMax: { asrMax: 1800000 }, markSeen: { markSeen: true }, noTime: { noTime: true },
}
console.log(JSON.stringify({
  schemaKeys: keys.map((k) => [k, new RegExp('\\b' + k + ':\\s*\\{').test(schemaText)]),
  argvCases: Object.fromEntries(keys.map((k) => [k, argvFor(cases[k])])),
  argvEmpty: argvFor({}),
}))
