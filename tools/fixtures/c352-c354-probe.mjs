// C352–C354 共用取证夹具：0.4.11 三值分层派单第五件「判据改造」。
// 每个场景用独立 mkdtemp 根，stdout 只吐一行 JSON；finally 里 rmSync 回收，
// catch 里把 stack 放进 out.fatal，结论由 verify.mjs 的判据自己算。
//
// 不改 c348-clean-probe.mjs 的真删序列 —— 那个夹具先 dryOwned 再 removeAllOwned 真删，
// 插 removeOwned 真删会污染 realItems 等既有字段，让 C348–C351 连带假红。
// 这里四个场景各起一棵同形树，互不干扰。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const own = await import(pathToFileURL(join(ROOT, 'lib', 'cache-own.mjs')).href)
const { removeAllOwned, removeOwned } = own
const { appendLedger } = await import(pathToFileURL(join(ROOT, 'lib', 'frames.mjs')).href)

const out = { fatal: null }
const roots = []

// 与 c348-clean-probe.mjs 同形的树：标记 + BV 目录（meta/text/txt/json/sub）+ frames 容器 + 顶层 .zip + _logs。
function seed(root) {
  const put = (rel, body = 'x') => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body, 'utf8')
  }
  put('.bili-watch-root', 'mark')
  put('BV13hWj68ELy/meta.json', JSON.stringify({ bv: 'BV13hWj68ELy', files: [] }))
  put('BV13hWj68ELy/text.txt', 'hello')
  put('BV13hWj68ELy/text.json', JSON.stringify({ video: {}, source: {}, timeline: [], text: 'hello', chars: 5 }))
  put('BV13hWj68ELy/sub.wrapped.txt', 'sub')
  put('frames/BV13hWj68ELy-p1-14s/BV13hWj68ELy-p1-14s.jpg', 'jpg')
  put('frames/BV13hWj68ELy-p1-14s/peek-01.jpg', 'jpg')
  put('frames/BV13hWj68ELy-p1-14s/text.txt', 'txt')
  put('frames/BV13hWj68ELy.mp4', 'VIDEO')
  put('frames/我的工程.psd', 'PSD')
  put('_logs/migrate.log', 'log')
  put('_logs/doctor.log', 'log')
  put('我的素材.zip', 'ZIP')
  return root
}

const mkRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'bw-c352-'))
  roots.push(r)
  return seed(r)
}

try {
  // ── C352：removeOwned（立即清理）真删，只删第一类 ─────────────────────────
  {
    const root = mkRoot()
    removeOwned(root, { mode: 'permanent' })
    out.c352 = {
      psdSurvivedAfterOwned: existsSync(join(root, 'frames/我的工程.psd')),
      zipSurvivedAfterOwned: existsSync(join(root, '我的素材.zip')),
      mp4SurvivedAfterOwned: existsSync(join(root, 'frames/BV13hWj68ELy.mp4')),
      bvDirGoneAfterOwned: !existsSync(join(root, 'BV13hWj68ELy')),
    }
  }

  // ── C353：includeUnknown 两向真删（两个独立根） ──────────────────────────
  {
    // 不勾：第二类（.psd/.zip）默认保留，灰区 .mp4 删。
    const without = mkRoot()
    const dryWithout = removeAllOwned(without, { dryRun: true, mode: 'permanent' })
    removeAllOwned(without, { mode: 'permanent' })
    // 勾：第二类也纳入删除。
    const withRoot = mkRoot()
    const dryWith = removeAllOwned(withRoot, { dryRun: true, mode: 'permanent', includeUnknown: true })
    removeAllOwned(withRoot, { mode: 'permanent', includeUnknown: true })

    const names = (r) => (r.plan || []).map((e) => e.name)
    out.c353 = {
      without: {
        psdSurvived: existsSync(join(without, 'frames/我的工程.psd')),
        zipSurvived: existsSync(join(without, '我的素材.zip')),
        mp4Survived: existsSync(join(without, 'frames/BV13hWj68ELy.mp4')),
        plan: names(dryWithout),
        skipped: (dryWithout.skipped || []).map((e) => e.name),
      },
      with: {
        psdSurvived: existsSync(join(withRoot, 'frames/我的工程.psd')),
        zipSurvived: existsSync(join(withRoot, '我的素材.zip')),
        mp4Survived: existsSync(join(withRoot, 'frames/BV13hWj68ELy.mp4')),
        plan: names(dryWith),
        skipped: (dryWith.skipped || []).map((e) => e.name),
      },
    }
  }

  // ── C354：台账逐写盘点序列（先写产物 → 放用户 .psd → 再写产物） ──────────
  {
    const root = mkRoot()
    const bv = join(root, 'BV13hWj68ELy')
    appendLedger(bv, [{ name: 'text.txt', bytes: 5 }])
    writeFileSync(join(bv, '我的工程.psd'), 'PSD', 'utf8')
    appendLedger(bv, [{ name: 'text.json', bytes: 5 }])
    const meta = JSON.parse(readFileSync(join(bv, 'meta.json'), 'utf8'))
    out.c354 = {
      files: (meta.files || []).map((f) => f.name),
      ledgerVersion: meta.ledgerVersion,
      psdInLedger: (meta.files || []).some((f) => f.name === '我的工程.psd'),
    }
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 800)
} finally {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }) } catch {}
  }
}
console.log(JSON.stringify(out))
