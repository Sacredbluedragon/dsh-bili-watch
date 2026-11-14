// C348–C351 共用取证夹具：0.4.11 清空 P0 + 两按钮 + 三数 + _logs 归属。
// 在临时目录造真缓存根，真跑 lib/cache-own.mjs 的 previewAll / removeAllOwned /
// removeOwned / cacheBreakdown / isOwnedEntry —— 不读源码猜结论，也不 mock 被测函数。
// stdout 只吐一行 JSON；结论由 verify.mjs 的判据自己算。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'cache-own.mjs')).href)
const { previewAll, removeAllOwned, removeOwned, cacheBreakdown, isOwnedEntry } = mod
const clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8')
const ownSrc = readFileSync(join(ROOT, 'lib', 'cache-own.mjs'), 'utf8')

const root = mkdtempSync(join(tmpdir(), 'bw-c348-'))
const put = (rel, body = 'x') => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf8')
}

const out = { fatal: null }
try {
  put('.bili-watch-root', 'mark')
  // 形态 1：BV 目录含 <kind>.json（0.4.10 结构化副本）
  put('BV13hWj68ELy/meta.json', JSON.stringify({ bv: 'BV13hWj68ELy', files: [] }))
  put('BV13hWj68ELy/text.txt', 'hello')
  put('BV13hWj68ELy/text.json', JSON.stringify({ video: {}, source: {}, timeline: [], text: 'hello', chars: 5 }))
  put('BV13hWj68ELy/sub.wrapped.txt', 'sub')
  // 形态 2：frames 容器，子目录有凭证 + 容器根一个认不出的 .mp4 + 用户 .psd
  put('frames/BV13hWj68ELy-p1-14s/BV13hWj68ELy-p1-14s.jpg', 'jpg')
  put('frames/BV13hWj68ELy-p1-14s/peek-01.jpg', 'jpg')
  put('frames/BV13hWj68ELy-p1-14s/text.txt', 'txt')
  put('frames/BV13hWj68ELy.mp4', 'VIDEO')
  put('frames/我的工程.psd', 'PSD')
  // 形态 3：_logs 任意日志名
  put('_logs/migrate.log', 'log')
  put('_logs/doctor.log', 'log')
  // 顶层用户文件
  put('我的素材.zip', 'ZIP')

  const occupied = mod.dirStat(root, { includeLogs: true })
  const pv = previewAll(root)
  const bd = cacheBreakdown(root)
  const dryAll = removeAllOwned(root, { dryRun: true, mode: 'permanent' })
  const dryOwned = removeOwned(root, { dryRun: true, mode: 'permanent' })
  const autoLogs = isOwnedEntry(root, join(root, '_logs'))
  const real = removeAllOwned(root, { mode: 'permanent' })

  out.p0 = {
    preview: pv,
    breakdown: bd,
    dryPlan: dryAll.plan.map((e) => e.name),
    drySkipped: dryAll.skipped.map((e) => e.name),
    ownedPlan: dryOwned.plan.map((e) => e.name),
    ownedSkipped: dryOwned.skipped.map((e) => e.name),
    autoClaimsLogs: autoLogs === true,
    realItems: real.items,
    psdSurvived: existsSync(join(root, 'frames/我的工程.psd')),
    zipSurvived: existsSync(join(root, '我的素材.zip')),
    mp4Survived: existsSync(join(root, 'frames/BV13hWj68ELy.mp4')),
    logsGoneAfterAll: !existsSync(join(root, '_logs/migrate.log')),
    bvDirGone: !existsSync(join(root, 'BV13hWj68ELy')),
    // 三数关系：Z 必须等于 X − Y（同一处算出来，不许前端拼）
    zEqXminusY: bd.unrecognized.bytes === bd.occupied.bytes - bd.removable.bytes
      && bd.unrecognized.files === bd.occupied.files - bd.removable.files,
    occupied,
  }

  // 两按钮对函数：静态接线（谁绑到哪个函数）+ 两个函数各自发的 body
  const btnClean = /'data-bl-clean-now':\s*'',\s*onClick:\s*(\w+)/.exec(clientSrc)
  const btnAll = /'data-bl-clear-all':\s*'',\s*onClick:\s*(\w+)/.exec(clientSrc)
  const fnBody = (name) => {
    const at = clientSrc.indexOf(`const ${name} = async`)
    if (at < 0) return ''
    const end = clientSrc.indexOf('\n      }', at)
    return end > at ? clientSrc.slice(at, end) : ''
  }
  out.buttons = {
    cleanFn: btnClean ? btnClean[1] : '',
    allFn: btnAll ? btnAll[1] : '',
    cleanBody: fnBody(btnClean ? btnClean[1] : ''),
    allBody: fnBody(btnAll ? btnAll[1] : ''),
    // 两步确认：「彻底清空」按钮只打开确认框（openClearAll），真正发请求的是确认时的 doClearAll。
    //   判据必须跟到确认函数，不能只看按钮 onClick 那一个函数。
    confirmBody: fnBody('doClearAll'),
    allOpensDialog: /setDlg\('clearAll'\)/.test(fnBody(btnAll ? btnAll[1] : '')),
    // 反向：两个按钮接同一个函数 = 0730 段写反的那个错
    sameFn: !!btnClean && !!btnAll && btnClean[1] === btnAll[1],
    // 三数渲染位
    hasFactX: /'data-bl-fact-x'/.test(clientSrc),
    hasFactY: /'data-bl-fact-y'/.test(clientSrc),
    hasFactZ: /'data-bl-fact-z'/.test(clientSrc),
    // 按钮名动态
    labelDynamic: /clearAllLabel\(deleteMode\)/.test(clientSrc),
    labelFn: (() => {
      const at = clientSrc.indexOf('function clearAllLabel(deleteMode) {')
      return at < 0 ? '' : clientSrc.slice(at, clientSrc.indexOf('\n}', at) + 2)
    })(),
  }

  // <kind>.json 的同源证据：白名单里 .txt / .json 共用同一个 kind 常量。
  //   源码是 new RegExp 的字符串拼装，`\\.` 在文件里是两个反斜杠，所以这里不数反斜杠个数，
  //   只看「同一个 PRINT_TEXT_KINDS 常量后面 24 字符内出现 txt / json」。
  out.kinds = {
    sharedConst: /PRINT_TEXT_KINDS\}[^,\n]{0,26}txt/.test(ownSrc)
      && /PRINT_TEXT_KINDS\}[^,\n]{0,14}json/.test(ownSrc),
    hasJsonBranch: /PRINT_TEXT_KINDS\}[^,\n]{0,14}json/.test(ownSrc),
    // 反向：不许 .*\.json 通吃（那会把用户放的任意 .json 当成我们的）
    noWildcardJson: !/\.\*[^,\n]{0,3}\.json/.test(ownSrc),
  }
} catch (e) {
  out.fatal = String(e?.stack || e).slice(0, 800)
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(out))
