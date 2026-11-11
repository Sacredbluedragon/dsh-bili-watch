/**
 * 五条升级判据的隔离根取证夹具。每个 case 单独跑、只输出 JSON，不在夹具里下结论。
 *
 * 共同纪律：被测的是**原样源码**（真 import、真抠函数体在桩环境真跑、真起 CLI），
 * 不是把源码当字符串找子串。把守卫改成恒假（保留字面量）后，这里取到的值会跟着变，
 * 主闸的行为断言因此会红。
 */
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  rmSync, existsSync, readdirSync as fsReaddirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const IDX = join(ROOT, 'index.js')
const CACHE_PATH = pathToFileURL(join(ROOT, 'lib', 'cache-path.mjs')).href
const tmp = mkdtempSync(join(tmpdir(), 'bw-c341-'))
const home = join(tmp, 'home')
const cache = join(tmp, 'cache')
mkdirSync(home, { recursive: true })
mkdirSync(cache, { recursive: true })
const isolatedEnv = {
  ...process.env,
  DSH_HOME: home,
  BILI_WATCH_CACHE: cache,
  BILI_WATCH_DEPS: join(tmp, 'deps'),
}
process.env.DSH_HOME = home
process.env.BILI_WATCH_CACHE = cache
process.env.BILI_WATCH_DEPS = join(tmp, 'deps')

/** 取顶层函数的**原样函数体**（行首闭合括号为界），再编译自检。 */
function fnBody(src, name) {
  const lines = src.split('\n')
  const re = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const start = lines.findIndex((l) => re.test(l) && !/^\s*(?:\/\/|\*)/.test(l))
  if (start < 0) throw new Error(`找不到 function ${name}`)
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) { end = i; break }
  }
  if (end < 0) throw new Error(`${name} 没有行首闭合括号`)
  const body = lines.slice(start, end + 1).join('\n')
  new Function(`return (${body})`)
  return body
}

/**
 * 把原样函数体放进桩环境真跑：依赖按名字显式注入成参数，
 * 函数体自己的 const/let 保持词法绑定（不用 with，否则局部目录名会被桩成函数）。
 */
function runOriginal(src, names, overrides, prelude = '') {
  const keys = Object.keys(overrides)
  const body = `${prelude}\n${names.map((n) => fnBody(src, n)).join('\n')}\nreturn { ${names.join(', ')} }`
  return new Function(...keys, body)(...keys.map((k) => overrides[k]))
}

const out = { case: process.argv[2] || '' }

try {
  if (out.case === 'videoDir') {
    const { initCachePath, videoDir } = await import(CACHE_PATH)
    initCachePath(cache)
    const bv = 'BV1xx411c7mD'
    const titled = join(cache, `${bv}_原标题`)
    mkdirSync(titled, { recursive: true })
    const got = videoDir(bv)
    out.got = got
    out.titled = titled
    out.same = got === titled
    out.entries = readdirSync(cache)
  } else if (out.case === 'exitCode') {
    // 真起一个必然失败的 CLI；工具层的兜底函数体是源码原样，桩只负责把子进程结果交回去。
    const src = readFileSync(IDX, 'utf8')
    const runLook = async () => {
      const r = spawnSync(process.execPath, ['-e', "console.log('child-failed-output'); process.exit(7)"], { encoding: 'utf8' })
      return { code: r.status, out: r.stdout || '', err: r.stderr || '', ms: 1 }
    }
    const { lookup } = runOriginal(src, ['lookup'], {
      runLook,
      COMMANDS: ['text', 'clean', 'hot', 'login', 'search', 'comments'],
      writeLastRun: () => {},
      extractWrittenPath: () => null,
      suggestFlag: (x) => String(x),
    })
    const r = await lookup({ command: 'text', bv: 'BV1xx411c7mD', positionals: [], extra: [], badOut: false, unknownFlags: [], signal: null })
    out.text = String(r && r.text || '')
    out.ok = !!(r && r.ok)
    out.childRc = 7
  } else if (out.case === 'toolTxt') {
    const src = readFileSync(IDX, 'utf8')
    const dir = join(tmp, 'toolout')
    mkdirSync(dir, { recursive: true })
    const { trimForModel } = runOriginal(src, ['trimForModel'], {
      videoDir: () => dir,
      join,
      writeFileSync,
      readTuning: () => ({ toolTextCap: 100, toolHead: 50 }),
      toolTextCap: () => 100,
      toolTextHead: () => 50,
      cutCp: (s, n) => String(s).slice(0, n),
      TOOL_FILE_SEQ: 0,
    })
    out.ret = String(trimForModel('x'.repeat(500), 'out', 'BV1xx411c7mD', false, {})).slice(0, 160)
    out.files = readdirSync(dir)
  } else if (out.case === 'dataOnly') {
    const r = spawnSync(process.execPath, [LOOK, 'doctor', '--format', 'json'], {
      env: isolatedEnv, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    })
    const so = String(r.stdout || '')
    let parseOk = false, keys = 0
    try { const j = JSON.parse(so); parseOk = true; keys = Object.keys(j).length } catch {}
    out.rc = r.status
    out.parseOk = parseOk
    out.keys = keys
    out.firstChar = so.trimStart()[0] || ''
    out.head = so.slice(0, 160)
    out.err = String(r.stderr || '').slice(0, 160)
    // CLI 的 doctor 有自己一份 JSON 输出，不经过 printText；数据模式短路必须直接真跑那个函数体。
    // 沿用既有夹具的桩法：原样函数体放进 vm，桩掉写盘，把 stdout 收集起来看是不是纯数据。
    const lsrc = readFileSync(LOOK, 'utf8')
    const st = lsrc.indexOf("function printText(text, opts, bv, kind = 'text') {")
    const en = st >= 0 ? lsrc.indexOf('\n}\n', st) : -1
    if (st < 0 || en <= st) throw new Error('抠不到 printText 原样函数体')
    const body = lsrc.slice(st, en + 2)
    const store = { logs: [], files: {} }
    const sandbox = {
      console: {
        log: (...a) => store.logs.push(a.map(String).join(' ')),
        error: () => {},
      },
      process: { pid: 4242, exitCode: 0, stdout: { write: (s) => store.logs.push(String(s)) } },
      text: '{"probe":1}', opts: { dataOnly: true }, bv: 'BV1xx411c7mD', kind: 'json',
      videoDir: () => '<TMP>/vid',
      join: (...a) => a.join('/'),
      dirname: (p) => String(p).split('/').slice(0, -1).join('/'),
      mkdirSync: () => {},
      writeFileSync: (p, s) => { store.files[p] = String(s) },
      renameSync: (f, t) => { store.files[t] = store.files[f]; delete store.files[f] },
      readFileSync: (p) => store.files[p] ?? '',
      writeMeta: () => {}, scanInjection: () => [], emitWarn: () => {}, labelOf: (k) => k,
      sourceTagFor: () => '[source:json]', FENCE: '```',
      fencedDisplay: (s) => s, cutCp: (s, n) => String(s).slice(0, n), decorateData: (s) => s,
      tuning: () => ({ textLimit: 100000, textBrief: 400 }),
      textJsonPayload: (o) => o, textJsonLine: () => '', textJsonPath: (p) => `${p}.json`,
      writeTextJson: (p, payload) => { store.files[`${p}.json`] = JSON.stringify(payload); return `${p}.json` },
    }
    vm.runInNewContext(`let TMP_SEQ = 0\n${body}\n;printText(text, opts, bv, kind)`, sandbox, { timeout: 3000 })
    out.direct = store.logs.join('')
    out.directFiles = Object.keys(store.files).length
    try { const jj = JSON.parse(out.direct); out.directParseOk = true; out.directKeys = Object.keys(jj).length } catch { out.directParseOk = false; out.directKeys = 0 }
  } else if (out.case === 'freshLock') {
    const src = readFileSync(LOOK, 'utf8')
    const dir = join(cache, 'frames')
    mkdirSync(dir, { recursive: true })
    const sentinel = join(dir, 'old-frame.jpg')
    writeFileSync(sentinel, 'OLD-FRAME')
    const { grabFrames } = runOriginal(src, ['grabFrames'], {
      tuning: () => ({ maxFrames: 100000 }),
      viewOf: async () => ({ dur: 10, p: 1 }),
      autoStep: () => 2,
      atDirTag: () => null,
      framesDir: (root, name) => join(root, name),
      cacheDir: () => cache,
      framesDirName: () => 'frames',
      ensureDir: () => {},
      join,
      listJpgs: () => [],
      readManifest: () => ({ files: ['old-frame.jpg'] }),
      framesCacheHit: () => false,
      tryLock: async () => null,          // 锁被别人占着
      waitManifest: async () => ({ ok: true }), // 立刻拿不到锁的早退路径
      provableNamesIn: () => new Set(['old-frame.jpg']),
      readdirSync: fsReaddirSync,
      rmSync,
      sleep: async () => {},
    })
    let threw = ''
    try { await grabFrames('BV1xx411c7mD', { step: 0, fresh: true }) } catch (e) { threw = String(e && e.message || e).slice(0, 160) }
    out.kept = existsSync(sentinel)
    out.threw = threw
    out.dirEntries = readdirSync(dir)
  } else {
    out.error = `未知 case：${out.case}`
  }
} catch (e) {
  out.error = String(e && e.stack || e).slice(0, 900)
} finally {
  console.log(JSON.stringify(out))
  rmSync(tmp, { recursive: true, force: true })
}
