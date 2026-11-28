/**
 * C539 夹具（1017 返修）：真 import index.js → apply(ctx) 捕获 bili_watch → 真调 tool.output.render。
 * 成功态统一口径：单块、type=text、块内文本与传入正文逐字相等——不再扫描正文内容判真伪。
 * 失败态：同样的块形状 + 约定前缀 + 完整原文。
 * C 项：真走 trimForModel 拿带真实落盘路径的回执 → 喂 render 逐字相等 → 读回文件核对。
 * 子进程 async import，回传 C539_JSON= 给同步判据解析。
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const INDEX = join(ROOT, 'index.js')
const cpLen = (s) => Array.from(String(s ?? '')).length
const PREFIX = '⚠ 本次调用失败（ok=false），下面是错误信息，不是视频内容。' + String.fromCharCode(10)

const captured = []
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  commands: { register() {} },
  on() {},
  get(name) { return name === 'tools' ? { register(t) { captured.push(t) } } : { register() {} } },
  effect(fn) { return fn() },
  webServer: { register() { return () => {} } },
}
const out = { cases: {}, fatal: null }

// 统一口径：成功态 = 单块 + type=text + 块内文本 == expected（逐字相等自动蕴含「没多出任何句子」）
const inspect = (tool, args, expected) => {
  const blocks = tool.output.render(args, { ok: true, text: expected })
  const arr = Array.isArray(blocks) ? blocks : []
  const text = arr.map((b) => String(b?.text ?? '')).join('')
  return {
    blockShapeOk: arr.length === 1 && arr[0]?.type === 'text',
    blocks: arr.length,
    type: arr[0]?.type ?? null,
    equal: arr.length === 1 && String(arr[0]?.text ?? '') === expected,
    renderLen: cpLen(text),
    srcLen: cpLen(expected),
  }
}
const inspectFail = (tool, args, errText) => {
  const blocks = tool.output.render(args, { ok: false, text: errText })
  const arr = Array.isArray(blocks) ? blocks : []
  const text = arr.map((b) => String(b?.text ?? '')).join('')
  return {
    blockShapeOk: arr.length === 1 && arr[0]?.type === 'text',
    blocks: arr.length,
    type: arr[0]?.type ?? null,
    hasPrefix: String(arr[0]?.text ?? '').startsWith(PREFIX),
    keepsFullText: String(arr[0]?.text ?? '') === PREFIX + errText,
    equal: String(arr[0]?.text ?? '') === PREFIX + errText,
    renderLen: cpLen(text),
    srcLen: cpLen(errText),
  }
}

try {
  const mod = await import(pathToFileURL(INDEX).href)
  mod.apply(ctx)
  const tool = captured.find((t) => t && t.name === 'bili_watch')
  if (!tool || !tool.output || typeof tool.output.render !== 'function') throw new Error('未捕获 tool.output.render')

  // ① 3000 字跨过旧 2500 线
  out.cases.plain3000 = inspect(tool, {}, '正文'.repeat(1500))
  // ② 失败态长正文：前缀 + 完整原文 + 块形状
  out.cases.failLong = inspectFail(tool, {}, '错误信息'.repeat(700))
  // ③ 正文引用提示原句（改前假红，改后必须过）
  out.cases.quotesHint = inspect(tool, {}, '视频里 UP 主念了一句：「已截断，全文见上面提示里的路径」'.repeat(3))
  // ④ 正文提到文件路径（改前假红，改后必须过）
  out.cases.mentionsPath = inspect(tool, {}, '全文已存：D:\\tmp\\x.txt' + String.fromCharCode(10) + 'read C:\\tmp\\y.tool.txt' + String.fromCharCode(10) + '正文'.repeat(50))
  // ⑤ 4800 码点长正文（含手写路径后缀）穿透 render 不改一字——只验透传，不冒充「从回执取齐」
  out.cases.passThrough4800 = inspect(tool, {}, '全文正文'.repeat(1200) + String.fromCharCode(10) + '全文已存：D:\\tmp\\x.tool.txt')
  // ⑥ full:true
  out.cases.fullLong = inspect(tool, { full: true }, '全文'.repeat(3000))
  // ⑦ 短正文
  out.cases.shortPlain = inspect(tool, {}, '短正文')

  // ⑧ C 项：真走 trimForModel 拿带真实落盘路径的回执 → 喂 render → 读回文件核对
  {
    const tmp = mkdtempSync(join(tmpdir(), 'bw-c539-receipt-'))
    try {
      const src = readFileSync(INDEX, 'utf8')
      // fnBody 式抠 trimForModel 函数体（与 verify.mjs 同口径：行首匹配 + 行首闭合）
      const m = /(?:^|\n)[ \t]*function[ \t]+trimForModel[ \t]*\(/.exec(src)
      if (!m) throw new Error('找不到 function trimForModel')
      const i = m.index + m[0].indexOf('function')
      const j = src.indexOf('\n}', i)
      if (j < i) throw new Error('trimForModel 没找到行首闭合括号')
      const fnSrc = src.slice(i, j + 2)
      const factory = new Function('deps', `
        const { join, writeFileSync, cutCp, videoDir, cap, head } = deps
        let TOOL_FILE_SEQ = 0
        const toolTextCap = () => cap
        const toolTextHead = () => head
        ${fnSrc}
        return trimForModel
      `)
      const trimForModel = factory({
        join: (a, b) => join(a, b),
        writeFileSync,
        cutCp: (s, n) => {
          const str = String(s ?? '')
          if (str.length <= n) return str
          const a = Array.from(str)
          return a.length <= n ? str : a.slice(0, n).join('')
        },
        videoDir: () => tmp,
        cap: 2000, // 试配：默认 6000，为缩小夹具体积用 2000，只影响「触发落盘」不影响 render 行为
        head: 800,
      })
      const input = '取齐正文'.repeat(900) // ≈3600 码点 > cap 2000，必走落盘 + 截断
      const receipt = trimForModel(input, 'text', 'BV_C539', false, {})
      const pathM = /全文已存：([^\s）)]+)/.exec(receipt)
      const receiptPath = pathM ? pathM[1] : null
      const blocks = tool.output.render({}, { ok: true, text: receipt })
      const arr = Array.isArray(blocks) ? blocks : []
      let disk = null
      if (receiptPath) {
        const body = readFileSync(receiptPath, 'utf8')
        disk = {
          bytes: statSync(receiptPath).size,
          chars: cpLen(body),
          equalsInput: body === input,
          head20: body.slice(0, 20),
          tail20: body.slice(-20),
        }
      }
      out.cases.receiptFetch = {
        inputLen: cpLen(input),
        receiptLen: cpLen(receipt),
        receiptHasPath: !!receiptPath,
        receiptPath: receiptPath ? receiptPath.replace(tmp, '<TMP>') : null,
        blockShapeOk: arr.length === 1 && arr[0]?.type === 'text',
        blocks: arr.length,
        type: arr[0]?.type ?? null,
        renderEqual: arr.length === 1 && String(arr[0]?.text ?? '') === receipt,
        renderLen: cpLen(arr.map((b) => String(b?.text ?? '')).join('')),
        disk,
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
} catch (e) { out.fatal = String((e && e.stack) || e) }

console.log('C539_JSON=' + JSON.stringify(out))
