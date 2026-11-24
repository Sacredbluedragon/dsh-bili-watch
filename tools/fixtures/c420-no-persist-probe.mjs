/**
 * C420 取证夹具：错误 / 用法输出不落缓存（0.4.15 外审修单件一 A）。
 *
 * 纪律同 c383-tool-probe：被测的是**原样源码**——从 index.js 抠出 `lookup` / `trimForModel`
 * / `suggestFlag` 函数体在桩环境真编真跑，不是把源码当字符串找子串。缓存根用临时目录，
 * 走真 `lib/cache-path.mjs` 的 `initCachePath` 初始化、真 `videoDir` 落目录。
 *
 * 覆盖三条现场：
 *   ① 三种非法命令（vew / 2view / --head）带合法 BV：lookup 早退不进子进程，按斜杠调用点
 *      口径 trimForModel(noPersist) 之后，缓存根前后条目快照必须相等、零 `.tool.txt` 落盘，
 *      返回文本里不许出现「全文已存」；
 *   ② 成功路径行为一字不变：短输出仍落一份 `.tool.txt`，文件名能过 PROVEN_TOOL_TXT_RE；
 *      超长成功输出仍给「全文已存：路径」；
 *   ③ 超长失败输出：noPersist 下仍按 cap 截断（不许 500 字原样塞回模型），如实说未落盘，
 *      磁盘不再新增 `.tool.txt`。
 *
 * stdout 只吐一行 JSON；finally 回收临时目录，结论由 verify.mjs 的 C420 自己算。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initCachePath, videoDir } from '../../lib/cache-path.mjs'
import { PROVEN_TOOL_TXT_RE } from '../../lib/consts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const IDX = join(ROOT, 'index.js')
const src = readFileSync(IDX, 'utf8')

// ── 从 index.js 源码原样取 COMMANDS 数组字面量（不抄一份）────────────────────────
const commandsM = /^const COMMANDS = (\[[^\n]*\])/m.exec(src)
if (!commandsM) throw new Error('index.js 取不到 COMMANDS 字面量')
const COMMANDS = eval(commandsM[1])

// ── fnBody / runOriginal：口径同 c383-tool-probe.mjs ────────────────────────────
function fnBody(s, name) {
  const lines = s.split('\n')
  const re = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const start = lines.findIndex((l) => re.test(l) && !/^\s*(?:\/\/|\*)/.test(l))
  if (start < 0) throw new Error(`找不到 function ${name}`)
  let end = -1
  for (let i = start + 1; i < lines.length; i++) if (/^\}/.test(lines[i])) { end = i; break }
  if (end < 0) throw new Error(`${name} 没有行首闭合括号`)
  const body = lines.slice(start, end + 1).join('\n')
  new Function(`return (${body})`)
  return body
}

function runOriginal(names, overrides, prelude = '') {
  const keys = Object.keys(overrides)
  const body = `${prelude}\n${names.map((n) => fnBody(src, n)).join('\n')}\nreturn { ${names.join(', ')} }`
  return new Function(...keys, body)(...keys.map((k) => overrides[k]))
}

// ── 临时缓存根：真 initCachePath 初始化，DSH_HOME 指到临时目录避免迁移扫到本机家目录 ──
const tmp = mkdtempSync(join(tmpdir(), 'bw-c420-'))
const home = join(tmp, 'home')
const cache = join(tmp, 'cache')
mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home
initCachePath(cache)

const listTree = (dir) => {
  const out = []
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      out.push(relative(dir, p).replace(/\\/g, '/'))
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort()
}
const toolTxtOf = (dir) => listTree(dir).filter((f) => f.endsWith('.tool.txt'))

const BV = 'BV1c38200001'
const out = { fatal: null, before: listTree(cache) }

try {
  // 桩表：外部能力全部显式注入；真 lib 的 videoDir 走真缓存根。
  const baseOverrides = {
    videoDir, join, writeFileSync,
    toolTextCap: () => 100,
    toolTextHead: () => 50,
    cutCp: (s, n) => String(s).slice(0, n),
    runLook: async () => ({ code: 0, out: 'OK-成功输出', err: '' }),
    writeLastRun: () => {},
    extractWrittenPath: () => null,
    COMMANDS,
    TOOL_FILE_SEQ: 0,
    NEXT_STEP_PREFIX: '▶ 下一步：',
  }
  const stepNames = /function splitNextStep\(/.test(src) ? ['splitNextStep'] : []
  const { lookup, trimForModel, suggestFlag } = runOriginal(
    ['lookup', ...stepNames, 'trimForModel', 'suggestFlag'],
    baseOverrides,
  )

  // ① 非法命令三组：lookup 早退，不调子进程；按斜杠调用点口径 r.ok !== true 传 noPersist。
  const invalid = []
  for (const command of ['vew', '2view', '--head']) {
    const r = await lookup({ command, bv: BV, positionals: [BV], extra: [], badOut: false, unknownFlags: [] })
    const text = trimForModel(r.text, command, BV, false, { full: false, head: null, noPersist: r.ok !== true })
    invalid.push({
      command,
      ok: r.ok,
      textLen: text.length,
      textHasStored: text.includes('全文已存'),
      head: text.slice(0, 80),
    })
  }
  out.invalid = invalid
  out.afterInvalid = listTree(cache)
  out.invalidToolTxt = toolTxtOf(cache)

  // ② 成功短路径：仍落一份，文件名过凭证正则。
  const rOk = await lookup({ command: 'view', bv: BV, positionals: [BV], extra: [], badOut: false, unknownFlags: [] })
  const shortText = trimForModel(rOk.text, 'view', BV, false, { full: false, head: null, noPersist: rOk.ok !== true })
  const afterShort = toolTxtOf(cache)
  out.success = {
    ok: rOk.ok,
    textHasStored: shortText.includes('全文已存'),
    toolTxt: afterShort,
    namesRe: afterShort.map((f) => PROVEN_TOOL_TXT_RE.test(f.split('/').pop())),
  }

  // ②b 成功超长路径：行为不变——仍整体落盘并给「全文已存：路径」。
  const longOk = 'S'.repeat(500)
  const longText = trimForModel(longOk, 'sub', BV, false, { full: false, head: null, noPersist: false })
  const afterLong = toolTxtOf(cache)
  out.successLong = {
    textHasStored: longText.includes('全文已存'),
    added: afterLong.filter((f) => !afterShort.includes(f)),
  }

  // ③ 失败超长路径：noPersist 仍截断、说未落盘、不再落盘。
  const longFail = 'E'.repeat(500)
  const failText = trimForModel(longFail, '2view', BV, false, { full: false, head: null, noPersist: true })
  const afterFail = toolTxtOf(cache)
  out.failLong = {
    textLen: failText.length,
    cap: 100,
    textHasStored: failText.includes('全文已存'),
    saysNotPersisted: /未落盘|未存/.test(failText),
    added: afterFail.filter((f) => !afterLong.includes(f)),
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 800)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(JSON.stringify(out))
