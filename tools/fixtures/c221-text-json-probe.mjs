// C221/A·B7：printText 三个落盘路径（text / sub / asr）另落 json。
// 三层取证：① 真 lib 纯函数 + 真写盘；② printText 函数体原样切出在 vm 里跑三遍，
// 桩掉写盘收集「散文文件 / 围栏文件 / json 文件 / stdout」；③ 静态守卫。
// 散文不变不是靠夹具自述：vm 里逐字节比对 `${kind}.txt` 与传入全文，并验围栏自校验仍通过。
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { textJsonPath, textJsonPayload, writeTextJson, textJsonLine } from '../../lib/text-json.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'tools', 'look.mjs'), 'utf8')
const BV = 'BV19dJQ6sE9F'
const FULL = '第一行台词\n[01:23] 第二行台词\n末行台词'

// ── ① 真 lib ────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'c221-'))
const txtPath = join(tmp, 'text.txt')
writeFileSync(txtPath, FULL, 'utf8')
const plain = textJsonPayload({ bv: BV, kind: 'text', text: FULL })
const withCues = textJsonPayload({ bv: BV, kind: 'sub', text: FULL, cues: [{ sec: 1, content: '一句' }] })
const jp = writeTextJson(txtPath, plain)
let onDisk = null
try { onDisk = JSON.parse(readFileSync(jp, 'utf8')) } catch {}
const lib = {
  pathOk: textJsonPath('/x/y/asr.txt') === '/x/y/asr.json' && jp === textJsonPath(txtPath),
  keys: Object.keys(plain).sort().join(','),
  textOk: plain.text === FULL && plain.chars === FULL.length,
  timelineNull: plain.timeline === null,
  sourceOk: plain.source === 'text' && plain.video === BV,
  cuesOnlyWhenPresent: !('cues' in plain) && withCues.cues.length === 1,
  diskParseOk: !!onDisk,
  diskTextOk: onDisk?.text === FULL && onDisk?.chars === FULL.length,
  diskProseIntact: readFileSync(txtPath, 'utf8') === FULL,
  line: textJsonLine(jp),
}

// ── ② printText 真源码在 vm 里跑三遍 ─────────────────────────────────────────
const mark = "function printText(text, opts, bv, kind = 'text') {"
const st = src.indexOf(mark)
const en = st >= 0 ? src.indexOf('\n}\n', st) : -1
const body = st >= 0 && en > st ? src.slice(st, en + 2) : ''
const vmOut = {}
for (const kind of ['text', 'sub', 'asr']) {
  const store = { files: {}, logs: [], errors: [], jsonCalls: [] }
  const tag = `[source:${kind}:${BV}]`
  const sandbox = {
    console: {
      log: (...a) => store.logs.push(a.map(String).join(' ')),
      error: (...a) => store.errors.push(a.map(String).join(' ')),
    },
    process: { pid: 4242, exitCode: 0, stdout: { write: (s) => store.logs.push(String(s)) } },
    text: FULL, opts: {}, bv: BV, kind, store,
    videoDir: () => '<TMP>/vid',
    join: (...a) => a.join('/'),
    writeFileSync: (p, s) => { store.files[p] = String(s) },
    renameSync: (from, to) => { store.files[to] = store.files[from]; delete store.files[from] },
    readFileSync: (p) => store.files[p] ?? '',
    writeMeta: () => {},
    scanInjection: () => [], emitWarn: () => {}, labelOf: (k) => k,
    sourceTagFor: () => tag, FENCE: '```',
    fencedDisplay: (s) => s, cutCp: (s, n) => String(s).slice(0, n), decorateData: (s) => s,
    tuning: () => ({ textLimit: 100000, textBrief: 400 }),
    // 纯函数用真的；写盘那一个用桩记录调用参数（真写盘已在 ① 验过），
    // 这样 vm 里照样能逐字节比对三份产物，不会写到真实磁盘。
    textJsonPayload, textJsonLine,
    writeTextJson: (txt, payload) => {
      store.jsonCalls.push({ txt, payload })
      const p = textJsonPath(txt)
      store.files[p] = JSON.stringify(payload, null, 2) + '\n'
      return p
    },
  }
  let error = ''
  if (body) {
    const code = `let TMP_SEQ = 0\n${body}\n;printText(text, opts, bv, kind)`
    try { vm.runInNewContext(code, sandbox, { timeout: 3000 }) } catch (e) { error = String(e.message || e) }
  }
  const txt = `<TMP>/vid/${kind}.txt`
  const wrapped = `<TMP>/vid/${kind}.wrapped.txt`
  const json = `<TMP>/vid/${kind}.json`
  let j = null
  try { j = JSON.parse(store.files[json]) } catch {}
  const prose = store.files[txt]
  const wrapText = store.files[wrapped] || ''
  vmOut[kind] = {
    error,
    proseIntact: prose === FULL,
    wrappedIntact: wrapText.startsWith(tag) && wrapText.includes('```') && wrapText.trimEnd().endsWith('```'),
    jsonParseOk: !!j,
    jsonKeys: j ? Object.keys(j).sort().join(',') : '',
    jsonTextOk: j?.text === FULL && j?.chars === FULL.length,
    jsonSourceOk: j?.source === kind && j?.video === BV && j?.timeline === null,
    callTextOk: store.jsonCalls.length === 1 && store.jsonCalls[0].payload.text === FULL,
    stdoutLine: store.logs.find((l) => l.startsWith('结构化: ')) || '',
    stdoutLineOk: store.logs.includes(`结构化: ${json}`),
    proseStillPrinted: store.logs.some((l) => l.includes('第一行台词')),
  }
}
rmSync(tmp, { recursive: true, force: true })

// ── ③ 静态守卫 ──────────────────────────────────────────────────────────────
const stat = {
  bodyFound: body.length > 1000,
  proseWriteIntact: src.includes("writeFileSync(tmp, full, 'utf8')"),
  wrappedWriteIntact: src.includes('writeFileSync(wt, `${tag}\\n${FENCE}\\n${full}\\n${FENCE}\\n`, \'utf8\')') ||
    src.includes('writeFileSync(wt, `${tag}\\n${FENCE}\\n${full}\\n${FENCE}\\n`'),
  hasWriteJson: body.includes('writeTextJson('),
  hasLine: body.includes('textJsonLine('),
  hasPayload: body.includes('textJsonPayload('),
}

console.log(JSON.stringify({ lib, vmOut, stat }))
