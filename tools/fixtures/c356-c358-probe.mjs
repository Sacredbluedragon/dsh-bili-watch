// C356/C357/C358 共用取证夹具。输入域由「用户会往缓存放什么」反向生成
// （扩展名域 × 命名形态域 × 三个位置），不手写样本清单。
// stdout 只吐一行 JSON；结论由 tools/verify.mjs 的判据自己算。
// 所有造文件/删除只发生在 mkdtemp 假根，finally 里回收。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const own = await import(pathToFileURL(join(ROOT, 'lib', 'cache-own.mjs')).href)
const frames = await import(pathToFileURL(join(ROOT, 'lib', 'frames.mjs')).href)
const BV = 'BV13hWj68ELy'
const VIDEO = `${BV}.mp4`

// 输入域：12 个扩展名槽（含「无扩展名」）× 4 种命名形态 = 48 个名字。
// 命名形态覆盖 ASCII / 中文 / 带空格 / 点开头隐藏名；扩展名覆盖图片 / 文档 / 音视频。
const EXTS = ['jpg', 'png', 'heic', 'webp', 'md', 'txt', 'docx', 'pdf', 'mkv', 'mov', 'mp3', '']
const FORMS = ['IMG_2043', '我的照片', 'my photo', '.hidden-note']
const NAMES = []
for (const e of EXTS) for (const f of FORMS) NAMES.push(e ? `${f}.${e}` : f)
const POSITIONS = [
  { key: 'framesSub', rel: `frames/${BV}-p1-14s` },
  { key: 'bvRoot', rel: BV },
  { key: 'cacheTop', rel: '' },
]

const out = {
  fatal: null,
  domain: { exts: EXTS.length, forms: FORMS.length, names: NAMES.length, positions: POSITIONS.length, total: NAMES.length * POSITIONS.length, namesSample: NAMES.slice(0, 6) },
}
const roots = []
const mkRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'bw-c356-'))
  roots.push(root)
  writeFileSync(join(root, '.bili-watch-root'), 'mark')
  return root
}
const put = (p, body = 'x') => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf8')
}
const survived = (base) => NAMES.filter((n) => existsSync(join(base, n))).length

try {
  // ── C356：三位置 × 两向真删 ───────────────────────────────────────────
  out.c356 = []
  for (const pos of POSITIONS) {
    const row = { key: pos.key, names: NAMES.length }
    for (const mode of ['default', 'checked']) {
      const root = mkRoot()
      // 每位置都放一个 own 产物，作为「真删确实发生」的前提（防整棵树没跑的假绿）。
      put(join(root, 'runs.jsonl'), 'log')
      const base = pos.rel ? join(root, pos.rel) : root
      mkdirSync(base, { recursive: true })
      for (const n of NAMES) put(join(base, n), 'USER')
      if (pos.key === 'framesSub') {
        put(join(base, `${BV}-01.jpg`), 'JPG')
        put(join(base, 'manifest.json'), '{}')
      }
      if (pos.key === 'bvRoot') put(join(base, 'meta.json'), '{}')
      const before = survived(base)
      const dry = own.removeAllOwned(root, { dryRun: true, mode: 'permanent', ...(mode === 'checked' ? { includeUnknown: true } : {}) })
      const real = own.removeAllOwned(root, { mode: 'permanent', ...(mode === 'checked' ? { includeUnknown: true } : {}) })
      row[mode] = {
        before,
        after: survived(base),
        realItems: real.items,
        skippedCount: dry.skipped.length,
        ownDeleted: !existsSync(join(root, 'runs.jsonl')),
        userNamesInPlan: NAMES.filter((n) => dry.plan.some((e) => e.name === n || e.name.endsWith('/' + n))).length,
      }
    }
    out.c356.push(row)
  }

  // ── C357：台账文件必须走 own 通道，不许掉进保留清单 ─────────────────────
  {
    const root = mkRoot()
    const dir = join(root, 'frames', `${BV}-p1-14s`)
    put(join(dir, `${BV}-01.jpg`), 'JPG')
    put(join(dir, 'manifest.json'), '{}')
    put(join(dir, 'meta.json'), '{}')
    const en = own.enumerateForAll(root, {})
    const dry = own.removeAllOwned(root, { dryRun: true, mode: 'permanent' })
    const entryNames = en.entries.map((e) => e.name)
    const foreignNames = en.foreign.map((e) => e.name)
    out.c357 = {
      manifestInEntries: entryNames.some((n) => n === 'frames' || n.endsWith('/manifest.json')),
      metaInEntries: entryNames.some((n) => n === 'frames' || n.endsWith('/meta.json')),
      manifestInForeign: foreignNames.some((n) => n.endsWith('/manifest.json')),
      manifestInSkipped: dry.skipped.some((e) => e.name.endsWith('/manifest.json')),
      manifestInPlan: dry.plan.some((e) => e.name === 'frames' || e.name.endsWith('/manifest.json')),
      previewUnknownFiles: own.previewAll(root).unknownFiles.length,
    }
    const real = own.removeAllOwned(root, { mode: 'permanent' })
    out.c357.realItems = real.items
    out.c357.manifestGoneAfterReal = !existsSync(join(dir, 'manifest.json'))
    out.c357.metaGoneAfterReal = !existsSync(join(dir, 'meta.json'))
  }

  // ── C358：新写 manifest 含原视频名 + 新旧可区分 ────────────────────────
  const buildLedger = (mode) => {
    const root = mkRoot()
    const dir = join(root, 'frames', `${BV}-p1-14s`)
    const produced = [`${BV}-01.jpg`, `${BV}-02.jpg`]
    for (const n of [...produced, VIDEO]) put(join(dir, n), n === VIDEO ? 'VIDEO' : 'JPG')
    const info = { ok: true, bv: BV, p: 1, step: 14, scene: false, sceneTh: 0, frames: produced.length }
    const files = mode === 'new' ? [...produced, VIDEO] : produced
    frames.writeManifest(dir, { ...info, files, times: null })
    frames.appendLedger(dir, files.map((name) => {
      let bytes = 0
      try { bytes = statSync(join(dir, name)).size } catch {}
      return { name, bytes }
    }))
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    const dry = own.removeAllOwned(root, { dryRun: true, mode: 'permanent' })
    const real = own.removeAllOwned(root, { mode: 'permanent' })
    return {
      mode,
      manifestFiles: manifest.files,
      ledgerFiles: (meta.files || []).map((f) => f.name),
      ledgerVersion: meta.ledgerVersion,
      videoInSkipped: dry.skipped.some((e) => e.name.endsWith('/' + VIDEO)),
      realItems: real.items,
      videoSurvivedAfterReal: existsSync(join(dir, VIDEO)),
    }
  }
  out.c358 = { newDir: buildLedger('new'), oldDir: buildLedger('old') }

  // 静态守卫用：把生产调用点的写盘点原样行交给判据（不在这里下结论）。
  const lookLines = readFileSync(join(ROOT, 'tools', 'look.mjs'), 'utf8').split(/\r?\n/)
  // 只取代码行：注释里写一遍同样的字样不该让静态守卫变绿。
  const codeLines = lookLines.filter((s) => !/^\s*(?:\/\/|\*|\/\*)/.test(s))
  out.c358.writeSite = {
    manifestLine: (codeLines.find((s) => s.includes('files: [...produced, sourceVideo]')) || '').trim(),
    artifactsLine: (codeLines.find((s) => s.includes('const artifacts = [...produced, sourceVideo]')) || '').trim(),
    ledgerLine: (codeLines.find((s) => s.includes('appendLedger(dir, artifacts)')) || '').trim(),
    freshSkipLine: (codeLines.find((s) => s.includes('if (f === basename(mp4)) continue')) || '').trim(),
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 1200)
} finally {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }) } catch {} }
}
console.log(JSON.stringify(out))
