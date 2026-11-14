// C360 取证夹具：0.4.11 收口五条修的真跑证据。
//   A 真跑 removeAllOwned：根目录三个用户文件，默认全保留 / 勾选 includeUnknown 后全进 plan。
//   B 抠 client.js 的 doClearAll 原样函数体 + 桩，真收 setMsg 的四类文案。
//   C 抠 index.js 的 /cache/clear 回包判定原样片段 + 桩，真求 ok / why。
//   D 读 README 的两态安全承诺（对外文案，只能静态）。
// stdout 只吐一行 JSON；结论由 verify.mjs 的判据自己算。删除只落 mkdtemp 假根。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const own = await import(pathToFileURL(join(ROOT, 'lib', 'cache-own.mjs')).href)
const clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8')
const indexSrc = readFileSync(join(ROOT, 'index.js'), 'utf8')
const readmeSrc = readFileSync(join(ROOT, 'README.md'), 'utf8')

const USER_FILES = ['IMG_2043.jpg', '读书笔记.md', '我的素材']
const out = { fatal: null }
const roots = []

// ---------- A：根目录用户文件，两向真跑 ----------
const buildRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'bw-c360-'))
  roots.push(root)
  writeFileSync(join(root, '.bili-watch-root'), 'mark')
  writeFileSync(join(root, 'meta.json'), JSON.stringify({ ledgerVersion: 2, files: [] }))
  for (const n of USER_FILES) writeFileSync(join(root, n), 'user-data')
  return root
}

// ---------- B：抠 doClearAll 原样函数体，喂四类回包桩 ----------
const fnBody = () => {
  const at = clientSrc.indexOf('const doClearAll = async () => {')
  if (at < 0) return ''
  const open = clientSrc.indexOf('{', at)
  // 函数结尾是 6 空格缩进的 `}`；内部块至少 8 空格，`\n      }` 只会命中结尾。
  const end = clientSrc.indexOf('\n      }', open)
  return end > open ? clientSrc.slice(open + 1, end) : ''
}
const runPanel = (body, reply, includeUnknown = false) => {
  if (!body) return { error: 'doClearAll 函数体抠不出来' }
  const msgs = []
  const ctx = {
    includeUnknown,
    jpost: async () => reply,
    setMsg: (s) => msgs.push(String(s)),
    dirtyRef: { current: true },
    load: async () => {},
    refreshFacts: async () => {},
  }
  // 原样函数体编译执行：断言的是「函数真的把什么送进 setMsg」，不是源码里有没有那句话。
  const fn = new Function(
    'ctx',
    `const { includeUnknown, jpost, setMsg, dirtyRef, load, refreshFacts } = ctx
     return (async () => { ${body} })()`,
  )
  return fn(ctx).then(() => ({ msgs })).catch((e) => ({ msgs, error: String(e?.message || e) }))
}

// ---------- C：抠回包判定原样片段，喂四类 cleared 桩 ----------
const replyFragment = () => {
  const a = indexSrc.indexOf('const failedCount = cleared.failed.length')
  if (a < 0) return ''
  const b = indexSrc.indexOf("const why = partial ? reasons.join('；') : undefined", a)
  return b > a ? indexSrc.slice(a, b + "const why = partial ? reasons.join('；') : undefined".length) : ''
}
const runReply = (fragment, cleared) => {
  if (!fragment) return { error: '回包判定片段抠不出来' }
  try {
    const fn = new Function('cleared', `${fragment}\nreturn { ok: !partial, why }`)
    return fn(cleared)
  } catch (e) {
    return { error: String(e?.message || e) }
  }
}

try {
  // A
  {
    const r = buildRoot()
    const def = own.removeAllOwned(r, { mode: 'permanent', dryRun: true })
    const chk = own.removeAllOwned(r, { mode: 'permanent', dryRun: true, includeUnknown: true })
    out.plan = {
      defaultPlan: def.plan.map((e) => typeof e === 'string' ? e : e.name),
      checkedPlan: chk.plan.map((e) => typeof e === 'string' ? e : e.name),
      userFiles: USER_FILES,
    }
  }

  // B
  const body = fnBody()
  out.bodyLength = body.length
  out.panel = {}
  out.panel.fallback = await runPanel(body, {
    ok: true, data: { items: 3, fallback: [{ name: 'BV1xx.mp4' }] },
  })
  out.panel.zero = await runPanel(body, {
    ok: true, data: { items: 0, skippedOverflow: { count: 3 } },
  })
  out.panel.partial = await runPanel(body, {
    ok: false, why: '部分失败：2 项；回收站空间不足跳过 3 项',
    data: {
      items: 0, failed: [{ name: '卡住的.log' }], fallback: [{ name: 'BV2xx.mp4' }],
      skipped: [{ name: '我的照片.jpg', why: '认不出归属' }],
    },
  })
  out.panel.normal = await runPanel(body, {
    ok: true, data: { items: 3 },
  })

  // C
  const frag = replyFragment()
  out.fragmentLength = frag.length
  out.reply = {
    overflowOnly: runReply(frag, { failed: [], overflow: { count: 3 } }),
    failedOnly: runReply(frag, { failed: [{ name: 'x' }], overflow: { count: 0 } }),
    clean: runReply(frag, { failed: [], overflow: { count: 0 } }),
    both: runReply(frag, { failed: [{ name: 'x' }, { name: 'y' }], overflow: { count: 3 } }),
  }

  // D：只截本节，到下一个二级标题为止。固定 1400 字会跨到「卸载后残留」，
  //   那边也有「不会删/一并删」字样，会把文案断言拼成假绿。
  const at = readmeSrc.indexOf('缓存根归插件专用')
  let stop = at >= 0 ? readmeSrc.indexOf('\n## ', at) : -1
  if (stop < at) stop = readmeSrc.length
  out.readme = {
    section: at >= 0 ? readmeSrc.slice(at, stop) : '',
    found: at >= 0,
    warningLines: at >= 0
      ? readmeSrc.slice(at, stop).split('\n').filter((l) => /^>\s?/.test(l))
      : [],
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 1200)
} finally {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }) } catch {} }
}
console.log(JSON.stringify(out))
