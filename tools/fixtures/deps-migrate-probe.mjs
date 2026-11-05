#!/usr/bin/env node
/**
 * tools/fixtures/deps-migrate-probe.mjs —— deps 迁移面（issue #11 问题 1）的判据
 *
 * 为什么单独一个文件、为什么真 import index.js：
 *   要测的是 `scheduleDepsMigration()` 这个**闭包住模块级状态**的函数（它读 DEPS、调 rebindDeps、
 *   写 depsWarning）。切开函数体＝复刻，复刻绿了不说明真模块对。所以照 deps-rebind-probe.mjs
 *   的路子：设 BILI_WATCH_DEPS 指到临时目录 → 真 import → 用 opts 驱动真迁移。
 *
 * 缺陷现场（issue #11，`CBlazed` 报的「deps 迁移会删掉并发下载的文件」）：
 *   index.js 的 scheduleDepsMigration 里是 `copyTreeSync(src, tmp)` → `rmSync(dst, force)` → `rename(tmp, dst)`。
 *   包外 dst 里**只在包外存在的东西**（用户刚下好的 venv、模型、yt-dlp.exe 的新版本）在 rmSync 那一步
 *   整棵消失；而且全程不抢 `.fetch-deps.lock`，下载进程正在写的中途被搬走，写出半截文件。
 *   用户侧表现：迁移完「刚装好的又没了」，还不报错。
 *
 * A–E 五组断言分两类（写清这一点，否则夹具本身是纸老虎）：
 *   defect     ＝当前代码的缺陷，修好之前 false、修好之后 true（verify.mjs C163 断言全 true）。
 *                A 包外独有文件被删 / B 锁在位照搬、dst 被改、warning 不说人话。
 *   capability ＝修的时候最容易弄坏的反向能力：C 合并方向（同名包内优先、src 独有文件要过来）/
 *                D 迁完仍重绑 / E 幂等（重试期间不许第二条链并跑）/ B 删锁后仍要搬。
 *   只做「一律不搬」能让 A、B 变绿，但 C/D 会红；只合并不抢锁能让 A 绿，B 仍红。
 *
 * 2026-11-05 扩（`20261105-0020-DSH` 判据 A–D + `20261105-1532-DSH` 补三点）：
 *   A 补「内容真读回比」；B 补 dst 逐字节快照、warning、重试上界、删锁后重触发；
 *   D 补四个派生路径都在 dst 下；E 新增幂等组。原 A/B/C/D 的字段一个没删。
 *
 * 2026-11-05 扩 K 组（`20261105-1702-DSH` / `1712` §五）：**全部真调生产
 *   scheduleDepsMigration**，不拿复刻探针当唯一证据。K1 断链 junction（校验不过、
 *   不上位、不删 bak、warning 点名、处置后能恢复）/ K2 有效 junction（必须迁成功，
 *   防「宁可全拒绝」的假绿）/ K3 失败后只撤自己建的空 dst（第 3 轮 P1）/
 *   K4 上位后失败要完整复位（第 2 轮 P2-1）。每个场景用带 query 的全新模块实例，
 *   避免 DEPS_MOVED_MARK / depsWarning / inFlight 互相串扰。
 *
 * 2026-11-05 扩 L / M / N 组（1810 §二）：锁路径统一后的三条判据，并进 C163 现有
 *   defect 断言（编号数不变）。L 在「包外不存在 / 已存在 / 迁移中途」三态各量一次
 *   「宿主锁路径 === 下载侧锁路径」；下载侧取值由真跑 scripts/fetch-deps.mjs 的
 *   lockcheck 给出，不是复刻共享函数。M 真起两个进程，第二个必须拿到「被占用」。
 *   N 扫全仓源码，只许共享函数里留一处拼锁路径的写法。
 *
 * 退出码：0 全部符合预期 · 1 有断言不符（fails 里点名）· 2 探针自身坏
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const { depsLockFile } = await import(pathToFileURL(join(ROOT, 'lib', 'plugin-paths.mjs')).href)

const defect = {}
const capability = {}
const notes = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 「一个字节没动」的证据：相对路径 → 内容 sha256，前后逐项比对（0020 判据 B）。 */
function treeSnapshot(dir) {
  const out = {}
  const walk = (d, rel) => {
    let list
    try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else {
        try { out[r] = createHash('sha256').update(readFileSync(p)).digest('hex') } catch { out[r] = 'UNREADABLE' }
      }
    }
  }
  walk(dir, '')
  return out
}

const sandbox = mkdtempSync(join(tmpdir(), 'bw-mig-'))
const report = { defect, capability, notes, error: null }

/** 等某个文件出现（迁移是 setTimeout 驱动的）。 */
async function waitFile(p, ms = 4000) {
  let waited = 0
  while (!existsSync(p) && waited < ms) {
    await sleep(50)
    waited += 50
  }
  notes.push(`wait ${p.slice(-24)} ${waited}ms`)
  return existsSync(p)
}

/** 读不出来返回 null，别让「断言不符」变成「探针崩了」（rc=2 会掩盖真正的红）。 */
const readText = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/**
 * 断链条目**不能**用 existsSync 判存在：它跟随目标，断链时返回 false（Node/Windows 实测）。
 *   这与 1710 §一 要求 collectEntries 用 lstatSync 不跟随是同一现象——校验器若也用
 *   stat 系的判据，连「条目还在」都看不見。
 */
const lstatKind = (p) => {
  try {
    const s = lstatSync(p)
    return s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'
  } catch { return null }
}

/**
 * K 组每个场景要一个**全新模块实例**：DEPS_MOVED_MARK / DEPS / depsWarning /
 * depsMigrationInFlight 全是模块级，共用实例会互相覆盖 warning 与 mark 路径。
 * query string 是标准的 ESM 重新求值手段，不改生产代码，也不是复刻迁移链。
 */
const freshModule = async (tag, depsDir) => {
  process.env.BILI_WATCH_DEPS = depsDir
  return import(pathToFileURL(join(ROOT, 'index.js')).href + `?k=${tag}`)
}

/** 失败场景没有「文件出现」信号，只能轮询迁移链是否收工。 */
async function waitIdle(m, ms = 5000) {
  let waited = 0
  while (waited < ms) {
    const s = m.depsMigrationSnapshot()
    if (!s.inFlight && s.runs > 0) return s
    await sleep(40)
    waited += 40
  }
  return m.depsMigrationSnapshot()
}

/**
 * 本机 Node v22.22.2 / win32 实测：symlinkSync(target, link, 'file') 抛 EPERM
 *   （无开发者模式/管理员），junction 可建且 lstatSync 报 symlink；junction 指向
 *   **文件**会变成断链（statSync ENOENT）。所以有效链接场景只能用 junction→目录。
 *   造不出链接就让外层 catch 记 report.error → rc=2，**不许静默跳过当通过**。
 */
function makeJunction(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

try {
  // ── 场景 A：包外有「只在包外存在的」东西（模拟并发下载刚装好的 venv），迁移不能删它 ──
  {
    const srcA = join(sandbox, 'srcA')
    const dstA = join(sandbox, 'pref', 'depsA')
    mkdirSync(srcA, { recursive: true })
    writeFileSync(join(srcA, 'bundled.txt'), 'from-package', 'utf8')
    // 包外已有：一个 src 完全没有的目录（= 用户刚下好装好的 venv）
    mkdirSync(join(dstA, 'venv-asr', 'Scripts'), { recursive: true })
    writeFileSync(join(dstA, 'venv-asr', 'Scripts', 'python.exe'), 'JUST-DOWNLOADED-VENV', 'utf8')

    process.env.BILI_WATCH_DEPS = dstA
    const m = await import(pathToFileURL(join(ROOT, 'index.js')).href)
    m.scheduleDepsMigration({ delayMs: 0, src: srcA, dst: dstA, force: true })
    await waitFile(join(dstA, 'bundled.txt'))

    const venvFile = join(dstA, 'venv-asr', 'Scripts', 'python.exe')
    defect.A_pkgExternalKept = existsSync(venvFile)
    // 0020 判据 A 还要求「内容是你造的那个、不是包内的」：只判存在会被
    // 「拷了个同名空文件」骗过去，所以真读回比内容。
    let venvContent = null
    try { venvContent = readFileSync(venvFile, 'utf8') } catch {}
    defect.A_pkgExternalContentKept = venvContent === 'JUST-DOWNLOADED-VENV'
    // 反向：包内文件必须搬过来（否则「一律不搬」也能让 A 变绿，等于把迁移功能删了）
    capability.A_srcMoved = existsSync(join(dstA, 'bundled.txt'))
    notes.push(`A: 包外独有 venv 存活=${existsSync(venvFile)} 内容=${JSON.stringify(venvContent)}，包内文件到位=${existsSync(join(dstA, 'bundled.txt'))}`)
  }

  // ── 场景 B：`deps/.fetch-deps.lock` 在位（有下载正在跑），迁移必须不搬 ──
  //   0020 判据 B 的四项：没搬 / warning 含「有下载在跑」/ dst 一个字节没动 /
  //   删掉锁后再触发这次要搬。重试上界用 opts 压缩成 150ms × 3 次（生产默认 15s × 8，
  //   语义相同），否则夹具要空等两分钟才能看到「放弃」那句 warning。
  {
    const srcB = join(sandbox, 'srcB')
    const dstB = join(sandbox, 'pref', 'depsB')
    process.env.BILI_WATCH_DEPS = dstB
    // 锁已不在 deps 目录里、落在 deps 的父级（1810 §二）。这里必须真调 lib 的
    //   depsLockFile()：手写一个 `.fetch-deps.lock` 会造出没人看的锁，场景 B 变假绿。
    const lockB = depsLockFile({ env: process.env })
    mkdirSync(srcB, { recursive: true })
    writeFileSync(join(srcB, 'bundled.txt'), 'from-package', 'utf8')
    mkdirSync(dstB, { recursive: true })
    // 锁的主人用当前进程 pid（活着），迁移逻辑应当把它当「有人在跑」
    writeFileSync(lockB, JSON.stringify({ pid: process.pid, startedAt: Date.now(), target: 'ytdlp' }), 'utf8')
    const beforeB = treeSnapshot(dstB)

    process.env.BILI_WATCH_DEPS = dstB
    const m = await import(pathToFileURL(join(ROOT, 'index.js')).href)
    const snapOf = () => (m.depsMigrationSnapshot ? m.depsMigrationSnapshot() : {})
    m.scheduleDepsMigration({ delayMs: 0, src: srcB, dst: dstB, force: true, retryMs: 150, maxAttempts: 3 })
    await sleep(900) // 3 次尝试 × 150ms + 余量

    const snapB = snapOf()
    defect.B_lockBlocksMigration = !existsSync(join(dstB, 'bundled.txt'))
    defect.B_lockStillThere = existsSync(lockB)
    defect.B_dstByteIdentical = JSON.stringify(beforeB) === JSON.stringify(treeSnapshot(dstB))
    defect.B_warningMentionsDownload = /有下载在跑/.test(String(snapB.warning || ''))
    capability.B_retryBounded = snapB.retries === 2 && snapB.inFlight === false
      && /本次不迁移/.test(String(snapB.warning || ''))
    notes.push(`B: warning=${JSON.stringify(snapB.warning)} retries=${snapB.retries} inFlight=${snapB.inFlight} dstIdentical=${defect.B_dstByteIdentical}`)

    // 删掉锁后再触发：这一次必须真搬（证明「不搬」是锁造成的，不是把迁移功能阉了）
    rmSync(lockB, { force: true })
    m.scheduleDepsMigration({ delayMs: 0, src: srcB, dst: dstB, force: true, retryMs: 150, maxAttempts: 3 })
    await waitFile(join(dstB, 'bundled.txt'))
    capability.B_movesAfterLockGone = existsSync(join(dstB, 'bundled.txt'))
    capability.B_lockReleased = !existsSync(lockB)
    notes.push(`B2: 删锁后 bundled.txt=${capability.B_movesAfterLockGone}，自己的锁已释放=${capability.B_lockReleased}`)
  }

  // ── 场景 C（必须绿）：合并方向 —— 同名时包内优先，src 独有的文件要过来 ──
  {
    const srcC = join(sandbox, 'srcC')
    const dstC = join(sandbox, 'pref', 'depsC')
    mkdirSync(srcC, { recursive: true })
    writeFileSync(join(srcC, 'same.txt'), 'PACKAGE-WINS', 'utf8')
    writeFileSync(join(srcC, 'src-only.txt'), 'SRC-ONLY', 'utf8')
    mkdirSync(dstC, { recursive: true })
    writeFileSync(join(dstC, 'same.txt'), 'EXTERNAL-OLD', 'utf8')

    process.env.BILI_WATCH_DEPS = dstC
    const m = await import(pathToFileURL(join(ROOT, 'index.js')).href)
    m.scheduleDepsMigration({ delayMs: 0, src: srcC, dst: dstC, force: true })
    await waitFile(join(dstC, 'src-only.txt'))

    capability.C_packageWinsSame = existsSync(join(dstC, 'same.txt'))
      && readFileSync(join(dstC, 'same.txt'), 'utf8') === 'PACKAGE-WINS'
    capability.C_srcOnlyComes = existsSync(join(dstC, 'src-only.txt'))
  }

  // ── 场景 D（必须绿）：迁完当场重绑，不能等下次启动 ──
  {
    const snap = (await import(pathToFileURL(join(ROOT, 'index.js')).href)).depsPathSnapshot()
    const expectDst = join(sandbox, 'pref', 'depsC')
    capability.D_rebounded = resolve(snap.dir) === resolve(expectDst)
    capability.D_derivedRebounded = snap.downloadLog === join(expectDst, 'download.log')
    // 0020 判据 D 要「四个派生路径都在 dst 下」。两个凭据路径不在此列：
    //   它们在 $DSH_HOME 下、按设计不随 deps 迁移移动（deps-rebind-probe.mjs:150）。
    capability.D_fourDerivedRebounded = ['lastRun', 'cacheCfg', 'uiCfg', 'downloadLog']
      .every((k) => snap[k] === join(expectDst, {
        lastRun: 'last-run.json', cacheCfg: 'cache-config.json',
        uiCfg: 'ui-config.json', downloadLog: 'download.log',
      }[k]))
    notes.push(`D: dir=${snap.dir} fourDerived=${capability.D_fourDerivedRebounded}`)
  }

  // ── 场景 E（capability，1532 新增）：幂等 —— 重试期间不许第二条链并跑 ──
  //   两次同步触发只有第一次真正进链；否则两个 setTimeout 会同时 copy / rename
  //   同一个 tmp，那就是「修 A 的路上造出新的丢文件路径」。
  {
    const srcE = join(sandbox, 'srcE')
    const dstE = join(sandbox, 'pref', 'depsE')
    mkdirSync(srcE, { recursive: true })
    writeFileSync(join(srcE, 'e.txt'), 'E', 'utf8')
    const m = await import(pathToFileURL(join(ROOT, 'index.js')).href)
    const runsBefore = m.depsMigrationSnapshot ? m.depsMigrationSnapshot().runs : 0
    m.scheduleDepsMigration({ delayMs: 0, src: srcE, dst: dstE, force: true })
    m.scheduleDepsMigration({ delayMs: 0, src: srcE, dst: dstE, force: true })
    await waitFile(join(dstE, 'e.txt'))
    await sleep(120)
    const snapE = m.depsMigrationSnapshot ? m.depsMigrationSnapshot() : {}
    capability.E_noSecondMigration = snapE.runs === runsBefore + 1 && snapE.inFlight === false
    capability.E_noStrayTmp = !existsSync(dstE + '.migrating')
    notes.push(`E: runs ${runsBefore} → ${snapE.runs}，inFlight=${snapE.inFlight}，tmp 残留=${!capability.E_noStrayTmp}`)
  }

  // ══ K 组（1702 §四 / 1712 §五）：P0-1 的端到端真调证据 + P1-1 / P2-1 现场 ══════
  //   第 2 轮报 P0 用的是「照抄 copyTreeSync 函数体 + 5 个动作」的复刻探针。这里一律
  //   真调生产 `scheduleDepsMigration`（DSH 1702 §五：不拿复刻探针当唯一证据）。
  //   K1 断链 / K2 有效链接 / K3 空 dst 撤销 / K4 上位后失败复位。
  notes.push('K 前置: 本机 symlinkSync(...,\'file\')=EPERM 实测；有效链接用 junction→目录（lstat=symlink, statSync 可达）')

  // ── K1（defect）：dst 里放一个断链 junction → 校验不过、不上位、不删 bak ────────
  {
    const srcK1 = join(sandbox, 'srcK1')
    const dstK1 = join(sandbox, 'pref', 'depsK1')
    mkdirSync(srcK1, { recursive: true })
    writeFileSync(join(srcK1, 'bundled.txt'), 'FROM-PACKAGE-K1', 'utf8')
    mkdirSync(dstK1, { recursive: true })
    writeFileSync(join(dstK1, 'sentinel.txt'), 'USER-SENTINEL-K1', 'utf8')
    const broken = join(dstK1, 'junc-broken')
    makeJunction(join(sandbox, 'no-such-target-K1'), broken)

    const m = await freshModule('K1', dstK1)
    m.scheduleDepsMigration({ delayMs: 0, src: srcK1, dst: dstK1, force: true })
    const s1 = await waitIdle(m)
    const w1 = String(s1.warning || '')
    defect.K1_migrationFailed = !existsSync(join(dstK1, 'bundled.txt'))
    defect.K1_dstEntriesIntact = readText(join(dstK1, 'sentinel.txt')) === 'USER-SENTINEL-K1'
      && lstatKind(broken) === 'symlink'
    defect.K1_noBak = !existsSync(dstK1 + '.migrating.bak')
    defect.K1_noTmp = !existsSync(dstK1 + '.migrating')
    // 这两条是扰动①的靶子：校验恒通过时断链会改走「异常冒泡」分支，
    //   数据仍然安全，但用户拿不到「哪几个条目、为什么、怎么办」——warning 必须红。
    defect.K1_warningIsValidationStop = /迁移已停止/.test(w1) && /无法完整复制/.test(w1)
    // 只查子串会被骗：异常分支的 `ENOENT: ...stat '…\junc-broken'` 里也带这个名字
    //   （扰动①实测它没红）。要求「条目名 + 括号里的原因」——那是校验分支才会给的、
    //   用户能据此处置的线索（1702 §二.3「点名缺失的条目」）。
    defect.K1_warningNamesBrokenLink = /junc-broken（[^）]+）/.test(w1)
    defect.K1_warningNotClaimSuccess = !/本次已生效/.test(w1)
    notes.push(`K1: warning=${JSON.stringify(w1)} runs=${s1.runs} dstIntact=${defect.K1_dstEntriesIntact}`)

    // 再触发一次：失败不许把状态卡死，也不许第二次偷偷上位
    const runsBeforeRetry = s1.runs
    m.scheduleDepsMigration({ delayMs: 0, src: srcK1, dst: dstK1, force: true })
    const s1b = await waitIdle(m)
    capability.K1_retryStillSafe = s1b.runs === runsBeforeRetry + 1
      && !existsSync(join(dstK1, 'bundled.txt'))
      && readText(join(dstK1, 'sentinel.txt')) === 'USER-SENTINEL-K1'
      && /迁移已停止/.test(String(s1b.warning || ''))
    // 用户按 warning 处置（移走断链条目）后必须真的迁成 —— 「三条出路」的闭环
    rmSync(broken, { recursive: true, force: true })
    m.scheduleDepsMigration({ delayMs: 0, src: srcK1, dst: dstK1, force: true })
    const s1c = await waitIdle(m)
    capability.K1_recoversAfterUserFix = readText(join(dstK1, 'bundled.txt')) === 'FROM-PACKAGE-K1'
      && /本次已生效/.test(String(s1c.warning || ''))
    notes.push(`K1-recover: runs=${s1c.runs} warning=${JSON.stringify(s1c.warning)} 恢复=${capability.K1_recoversAfterUserFix}`)
  }

  // ── K2（capability）：有效 junction → 迁移必须**成功**（1712 §五 防「宁可全拒绝」）──
  {
    const srcK2 = join(sandbox, 'srcK2')
    const dstK2 = join(sandbox, 'pref', 'depsK2')
    const targetK2 = join(sandbox, 'k2-target') // 链接目标必须在 dst 之外，否则会被一起搬走
    mkdirSync(srcK2, { recursive: true })
    writeFileSync(join(srcK2, 'bundled.txt'), 'FROM-PACKAGE-K2', 'utf8')
    mkdirSync(targetK2, { recursive: true })
    writeFileSync(join(targetK2, 'blob.bin'), 'HF-BLOB-CONTENT', 'utf8')
    mkdirSync(dstK2, { recursive: true })
    writeFileSync(join(dstK2, 'sentinel.txt'), 'USER-SENTINEL-K2', 'utf8')
    makeJunction(targetK2, join(dstK2, 'junc-ok'))

    const m = await freshModule('K2', dstK2)
    m.scheduleDepsMigration({ delayMs: 0, src: srcK2, dst: dstK2, force: true })
    const s2 = await waitIdle(m)
    capability.K2_migrationSucceeded = /本次已生效/.test(String(s2.warning || ''))
      && existsSync(join(dstK2, 'bundled.txt'))
    capability.K2_bundledContent = readText(join(dstK2, 'bundled.txt')) === 'FROM-PACKAGE-K2'
    capability.K2_juncContentCopied = readText(join(dstK2, 'junc-ok', 'blob.bin')) === 'HF-BLOB-CONTENT'
    capability.K2_sentinelKept = readText(join(dstK2, 'sentinel.txt')) === 'USER-SENTINEL-K2'
    capability.K2_dstProperlySwapped = existsSync(dstK2)
      && !existsSync(dstK2 + '.migrating') && !existsSync(dstK2 + '.migrating.bak')
    // 1658 §三.3：成功路径不许碰 dst —— 一条断言钉住「成功时 dst 在且非空」
    capability.K2_successDstNonEmpty = existsSync(dstK2) && readdirSync(dstK2).length > 0
    // 实测前提：成功路径 rmSync(bak) 不许跟随 junction 把链接指向的外部目录删掉
    capability.K2_linkTargetSurvived = readText(join(targetK2, 'blob.bin')) === 'HF-BLOB-CONTENT'
    notes.push(`K2: warning=${JSON.stringify(s2.warning)} juncCopied=${capability.K2_juncContentCopied} targetAlive=${capability.K2_linkTargetSurvived}`)
  }

  // ── K3（defect）：失败后只撤自己建的空 dst（第 3 轮 P1-1，扰动②的靶子）────────
  //   acquireDepsLock 第一行 mkdirSync(dst) 会建出 dst；失败后不撤，
  //   resolveDepsDir 判据③ 只看 existsSync(pref) → 下次启动迁移永不触发。
  {
    const srcK3 = join(sandbox, 'no-such-src-K3')  // 故意不存在：copyTreeSync(src,tmp) 抛 ENOENT
    const dstK3 = join(sandbox, 'pref', 'depsK3')  // 不预建
    const m = await freshModule('K3', dstK3)
    m.scheduleDepsMigration({ delayMs: 0, src: srcK3, dst: dstK3, force: true })
    const s3 = await waitIdle(m)
    defect.K3_emptyDstRemoved = !existsSync(dstK3)
    defect.K3_noBak = !existsSync(dstK3 + '.migrating.bak')
    defect.K3_noTmp = !existsSync(dstK3 + '.migrating')
    defect.K3_warningNoRetryPromise = !/下次启动会再试/.test(String(s3.warning || ''))
    capability.K3_warningSaysContinue = /继续用包内 deps/.test(String(s3.warning || ''))
    notes.push(`K3: dstExists=${existsSync(dstK3)} warning=${JSON.stringify(s3.warning)}`)
  }

  // ── K4（defect）：renameSync(tmp,dst) 之后失败必须完整复位（第 2 轮 P2-1）──────
  //   DEPS_MOVED_MARK 的位置预置成一个目录 → :317 writeFileSync 抛 EISDIR（实测）。
  //   此时新目录已上位、DEPS 未重绑、bak 未清；旧实现不回滚，留下第三种状态。
  {
    const srcK4 = join(sandbox, 'srcK4')
    const dstK4 = join(sandbox, 'pref', 'depsK4')
    mkdirSync(srcK4, { recursive: true })
    writeFileSync(join(srcK4, 'bundled.txt'), 'FROM-PACKAGE-K4', 'utf8')
    mkdirSync(join(dstK4, '.deps-moved'), { recursive: true })
    writeFileSync(join(dstK4, 'sentinel.txt'), 'USER-SENTINEL-K4', 'utf8')
    const m = await freshModule('K4', dstK4)
    m.scheduleDepsMigration({ delayMs: 0, src: srcK4, dst: dstK4, force: true })
    const s4 = await waitIdle(m)
    const w4 = String(s4.warning || '')
    defect.K4_rolledBackFully = readText(join(dstK4, 'sentinel.txt')) === 'USER-SENTINEL-K4'
      && existsSync(join(dstK4, '.deps-moved'))
      && !existsSync(join(dstK4, 'bundled.txt'))
    defect.K4_noBak = !existsSync(dstK4 + '.migrating.bak')
    defect.K4_noRollbackTmp = !existsSync(dstK4 + '.migrating.rollback')
    defect.K4_warningSaysRolledBack = /已完整复位/.test(w4)
    defect.K4_warningNotClaimSuccess = !/本次已生效/.test(w4)
    notes.push(`K4: warning=${JSON.stringify(w4)} rolledBack=${defect.K4_rolledBackFully}`)
  }

  // ══ L / M / N 组（1810 §二）：锁路径统一后的三条判据，并进 C163 现有断言 ══════════
  const fetchScript = join(ROOT, 'scripts', 'fetch-deps.mjs')
  /** 下载侧锁路径：真跑 scripts/fetch-deps.mjs lockcheck，取 stdout 第一行。 */
  const downloadLockPath = (env) => {
    const r = spawnSync(process.execPath, [fetchScript, 'lockcheck'], {
      encoding: 'utf8', timeout: 20000, env,
    })
    return {
      path: String(r.stdout || '').split(/\r?\n/)[0].trim(),
      status: r.status,
      err: String(r.stderr || ''),
    }
  }

  // L1：包外 pref 不存在（delayMs 窗口内 run() 还没跑），两把锁必须同一串
  {
    const srcL1 = join(sandbox, 'srcL1')
    const dstL1 = join(sandbox, 'pref', 'depsL1')
    mkdirSync(srcL1, { recursive: true })
    writeFileSync(join(srcL1, 'l1.txt'), 'L1', 'utf8')
    const m = await freshModule('L1', dstL1)
    m.scheduleDepsMigration({ delayMs: 600, src: srcL1, dst: dstL1, force: true })
    const s = m.depsMigrationSnapshot()
    const d = downloadLockPath({ ...process.env, BILI_WATCH_DEPS: dstL1 })
    defect.L1_lockSameWhenPrefAbsent = s.inFlight === true && !existsSync(dstL1)
      && d.path.length > 0 && d.path === s.lockFile
    notes.push(`L1: prefAbsent=${!existsSync(dstL1)} inFlight=${s.inFlight} host=${s.lockFile} download=${d.path} rc=${d.status}`)
    await waitIdle(m)
  }

  // L2：包外 pref 已存在（用户手动建过 / 上次迁移残留），两把锁仍必须同一串
  {
    const srcL2 = join(sandbox, 'srcL2')
    const dstL2 = join(sandbox, 'pref', 'depsL2')
    mkdirSync(srcL2, { recursive: true })
    mkdirSync(dstL2, { recursive: true })
    writeFileSync(join(srcL2, 'l2.txt'), 'L2', 'utf8')
    const m = await freshModule('L2', dstL2)
    m.scheduleDepsMigration({ delayMs: 600, src: srcL2, dst: dstL2, force: true })
    const s = m.depsMigrationSnapshot()
    const d = downloadLockPath({ ...process.env, BILI_WATCH_DEPS: dstL2 })
    defect.L2_lockSameWhenPrefExists = s.inFlight === true && existsSync(dstL2)
      && d.path.length > 0 && d.path === s.lockFile
    notes.push(`L2: prefExists=${existsSync(dstL2)} inFlight=${s.inFlight} host=${s.lockFile} download=${d.path} rc=${d.status}`)
    await waitIdle(m)
  }

  // L3：迁移中途（别人的下载占着锁、迁移正在重试），两把锁还是同一串
  {
    const srcL3 = join(sandbox, 'srcL3')
    const dstL3 = join(sandbox, 'pref', 'depsL3')
    mkdirSync(srcL3, { recursive: true })
    writeFileSync(join(srcL3, 'l3.txt'), 'L3', 'utf8')
    const extLock = depsLockFile({ env: { ...process.env, BILI_WATCH_DEPS: dstL3 } })
    writeFileSync(extLock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), target: 'ytdlp' }), 'utf8')
    const m = await freshModule('L3', dstL3)
    m.scheduleDepsMigration({ delayMs: 0, src: srcL3, dst: dstL3, force: true, retryMs: 700, maxAttempts: 2 })
    await sleep(180)
    const s = m.depsMigrationSnapshot()
    const d = downloadLockPath({ ...process.env, BILI_WATCH_DEPS: dstL3 })
    defect.L3_lockSameWhileInFlight = s.inFlight === true && s.retries >= 1
      && d.path.length > 0 && d.path === s.lockFile
    notes.push(`L3: inFlight=${s.inFlight} retries=${s.retries} host=${s.lockFile} download=${d.path} rc=${d.status}`)
    rmSync(extLock, { force: true })
    await waitIdle(m)
  }

  // M：两个进程并发。A 持锁 1.5s，B 必须拿到「被占用」而不是「拿到了」。
  //   用独立锁根（mroot/），不与 L 组共用 pref/。
  //   **不靠固定 sleep 猜谁先启动**：首版 sleep(300) 时 A 反而被 B 先写的锁挡住
  //   （A_err 出现「已经有一个安装进程在跑」、B_rc=0），是实现正确时的假红。
  //   现在等到锁体里的 pid 真等于 A 的 pid 才放 B，并把「A 确实持锁」写成前提断言。
  {
    const mLockRoot = join(sandbox, 'mroot')
    const envM = { ...process.env, BILI_WATCH_DEPS: join(mLockRoot, 'depsM') }
    const mLockFile = depsLockFile({ env: envM })
    rmSync(mLockFile, { force: true })
    const a = spawn(process.execPath, [fetchScript, 'lockcheck', '--hold=1500'], {
      env: envM, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let aErr = ''
    a.stderr.on('data', (b) => { aErr += b })
    let aHeld = false
    for (let i = 0; i < 60; i++) {
      const cur = readText(mLockFile)
      if (cur) {
        try {
          const j = JSON.parse(cur)
          if (j.pid === a.pid && j.target === 'lockcheck') { aHeld = true; break }
        } catch {}
      }
      await sleep(50)
    }
    const b = spawnSync(process.execPath, [fetchScript, 'lockcheck'], {
      encoding: 'utf8', timeout: 20000, env: envM,
    })
    defect.M_secondProcessBlocked = aHeld && b.status === 3
      && /已经有一个安装进程在跑/.test(String(b.stderr || ''))
    notes.push(`M: A_held=${aHeld} A_pid=${a.pid} B_rc=${b.status} B_stderr=${JSON.stringify(String(b.stderr || '').slice(0, 200))} A_err=${JSON.stringify(aErr.slice(0, 120))}`)
    if (a.exitCode === null) await new Promise((r) => a.on('exit', r))
  }

  // N：全仓源码只许共享函数里留一处「把锁名拼进某个目录」的写法。
  {
    const JOIN_CALL = ['jo', 'in('].join('')
    const LOCK_CONST = ['DEPS', '_LOCK_NAME'].join('')
    const skip = new Set(['node_modules', '.git', 'deps', 'docs'])
    const hits = []
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { if (!skip.has(e.name)) walk(p, r) }
        else if (/\.(mjs|js)$/.test(e.name)) {
          String(readFileSync(p, 'utf8')).split(/\r?\n/).forEach((line, i) => {
            if (line.includes(JOIN_CALL) && line.includes(LOCK_CONST)) hits.push(`${r}:${i + 1}`)
          })
        }
      }
    }
    walk(ROOT, '')
    defect.N_singleSharedLockJoin = hits.length === 1 && hits[0].startsWith('lib/plugin-paths.mjs:')
    notes.push(`N: 命中=${JSON.stringify(hits)}`)
  }
} catch (e) {
  report.error = String(e?.stack || e)
} finally {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {}
}

// 2026-11-05：defect 组的消费方（verify.mjs C163）断言「每一条都是 true」——那是修好
// 之后的期望。旧写法要求全 false（缺陷现场的期望），修完不改这里，夹具 rc 会永远 1，
// 扰动实验就分不清「判据红」和「夹具自称没修好」。字段本身一个没动，只对齐口径。
const defectOK = Object.entries(defect).every(([, v]) => v === true)
const capOK = Object.entries(capability).every(([, v]) => v === true)
const ok = Boolean(defectOK && capOK && !report.error)
process.stdout.write(JSON.stringify({ ok, ...report }))
process.exitCode = report.error ? 2 : ok ? 0 : 1
