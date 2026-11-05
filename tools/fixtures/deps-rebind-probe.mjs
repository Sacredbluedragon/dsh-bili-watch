#!/usr/bin/env node
/**
 * tools/fixtures/deps-rebind-probe.mjs —— 0.4.7「迁完当场生效」的判据（顺序敏感）
 *
 * 为什么必须真 import index.js，不能像别的探针那样把函数体切出来：
 *   这里要验的是**模块级求值时机** —— `DEPS` 与四个派生常量在模块加载那一刻就定值，
 *   之后 `DEPS` 再怎么变，它们不动。切函数体只能测「某个函数被调用后做了什么」，
 *   测不到「它出生在哪个目录上」。切开就等于复刻，绿了也不说明真模块对。
 *
 * 四步（DSH 2026-11-04 12:18 重写；昨晚那版「6 个名字能找到新目录」不成立）：
 *   0. 前提：新目录里原本没有 last-run.json，且新旧不是同一处（否则第 3 步必然假绿）
 *   1. 模块加载时 DEPS 指**旧目录**，四个派生常量已按旧目录求值完成 —— 逐字段核，不只核 dir
 *   2. 触发真实迁移，搬到新目录
 *   3. 七个名字（DEPS + LAST_RUN + CACHE_CFG + UI_CFG + DOWNLOAD_LOG + SHARED_CRED + LEGACY_CRED）
 *      逐字段 `===` 指向新目录
 *   4. 在新目录做**真实 I/O**：往派生路径写入唯一标记，再**读回比对内容** ——
 *      证明不是字符串对了、读写还走旧地址。不许退化成 existsSync/stat：
 *      新目录里本来就有同名文件时，只 stat 会假绿（DSH 2026-11-04 14:32 追加）。
 *
 * 注：DSH 段里写「6 个名字」，括号里枚举是 1+4+2=7。本判据按枚举做，段里已回。
 *
 * 退出码：0 通过 · 1 被测代码红（fails 里点名）· 2 探针自身坏
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const fails = []
const notes = []
const must = (cond, msg) => {
  if (!cond) fails.push(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const prefRoot = mkdtempSync(join(tmpdir(), 'bw-rebind-pref-'))
const fakeLocal = mkdtempSync(join(tmpdir(), 'bw-rebind-local-'))
const dst = join(prefRoot, 'deps')
const report = { ok: false, step: 'init', fails, notes }

let probeError = null
try {
  // 旧目录的替身：两个文件 + 一层子目录。真包内 deps 是 481 MB，搬它会把判据拖成分钟级，
  // 而迁移逻辑对「搬的是什么」不敏感 —— 只要它能原样到新目录就行。
  writeFileSync(join(fakeLocal, 'a.txt'), 'A')
  mkdirSync(join(fakeLocal, 'sub'))
  writeFileSync(join(fakeLocal, 'sub', 'b.txt'), 'B')

  // 让 pref 落在临时目录且不存在 —— 模块加载时 resolveDepsDir 会判「包内 deps 有内容」
  // 而落到 `<ROOT>/deps`，这正是用户的真实处境（还没搬）。
  process.env.BILI_WATCH_DEPS = dst
  const dstExistedAtStart = existsSync(dst)

  // ── 前提（第 0 步）：新目录里没有 last-run.json，且新旧不是同一处 ──
  report.step = 'step0-preconditions'
  const localDeps = join(ROOT, 'deps')
  must(resolve(dst) !== resolve(localDeps), '前提不成立：新旧目录是同一处，本判据必然假绿')
  must(!existsSync(join(dst, 'last-run.json')), '前提不成立：新目录里本来就有 last-run.json')

  report.step = 'import'
  const m = await import(pathToFileURL(join(ROOT, 'index.js')).href)

  // ── 接缝存在性：缺哪个就指名，别让它以「跑着跑着 undefined 崩了」的形式红 ──
  report.step = 'seams'
  if (typeof m.depsPathSnapshot !== 'function') {
    fails.push('缺 depsPathSnapshot 导出：生产没有可观测的路径快照，判据无从断言')
  }
  if (typeof m.scheduleDepsMigration !== 'function') {
    fails.push('缺 scheduleDepsMigration 导出：判据无法驱动真实迁移')
  }
  if (typeof m.rebindDeps !== 'function') {
    fails.push('缺 rebindDeps 导出：热重绑的接缝没有暴露出来')
  }

  if (fails.length === 0) {
    const derived = [
      ['lastRun', 'last-run.json'],
      ['cacheCfg', 'cache-config.json'],
      ['uiCfg', 'ui-config.json'],
      ['downloadLog', 'download.log'],
    ]

    // ── 第 1 步：模块加载时，七个名字全在旧目录上 ──
    report.step = 'step1-loaded-on-old'
    const before = m.depsPathSnapshot()
    must(before && typeof before === 'object', 'depsPathSnapshot() 没返回对象')
    if (before && typeof before === 'object') {
      must(
        resolve(before.dir) === resolve(localDeps),
        `加载时 DEPS 应落在包内 deps（${localDeps}），实际 ${before.dir}`,
      )
      for (const [k, base] of derived) {
        must(
          before[k] === join(before.dir, base),
          `加载时 ${k} 应派生自旧目录（期望 ${join(before.dir, base)}，实际 ${before[k]}）`,
        )
      }
      for (const k of ['sharedCred']) {
        must(typeof before[k] === 'string' && before[k].length > 0, `加载时 ${k} 是空值`)
      }
      // legacy 才是 deps 下的那份；shared 在 $DSH_HOME 下，与 DEPS 无关 —— 见第 3 步的反向断言。
      must(
        before.legacyCred === join(before.dir, 'credential.json'),
        `加载时 legacyCred 应派生自旧目录（期望 ${join(before.dir, 'credential.json')}，实际 ${before.legacyCred}）`,
      )
    }

    // ── 第 2 步：触发真实迁移（3 秒延迟缩短为 0，其余与生产同一条路径）──
    report.step = 'step2-migrate'
    m.scheduleDepsMigration({ delayMs: 0, src: fakeLocal, force: true })
    let waited = 0
    while (!existsSync(join(dst, 'a.txt')) && waited < 5000) {
      await sleep(50)
      waited += 50
    }
    notes.push(`waited=${waited}ms`)
    must(existsSync(join(dst, 'a.txt')), `迁移没落地：${waited} ms 后 ${dst} 里没有 a.txt`)
    must(existsSync(join(dst, 'sub', 'b.txt')), '迁移没把子目录一起搬过去')
    must(existsSync(join(dst, '.deps-moved')), '迁移没写 .deps-moved（重启后会再判一次旧目录）')
    must(
      existsSync(fakeLocal) && readdirSync(fakeLocal).length > 0,
      '迁移把源目录清空了：现口径是复制不删源，删了会让回退无路可走',
    )

    // ── 第 3 步：七个名字逐字段指向新目录（这是「顺序敏感」的正题）──
    report.step = 'step3-rebound'
    const after = m.depsPathSnapshot()
    must(after && typeof after === 'object', '迁移后 depsPathSnapshot() 没返回对象')
    if (after && typeof after === 'object') {
      must(resolve(after.dir) === resolve(dst), `迁移后 DEPS 没重绑：期望 ${dst}，实际 ${after.dir}`)
      for (const [k, base] of derived) {
        must(
          after[k] === join(dst, base),
          `迁移后 ${k} 没重绑（期望 ${join(dst, base)}，实际 ${after[k]}）—— 模块级常量出生在旧目录上，只改 DEPS 改不动它`,
        )
      }
      // legacy 必须跟着走；shared 必须**不**跟着走 —— 它在 $DSH_HOME 下，
      //   lib/cred.mjs 的 credPaths(deps) 只拿 deps 算 legacy。这条是反向断言：
      //   共享凭证位置一旦随迁移漂移，用户登录态就凭空丢了，比「没重绑」更难查。
      must(
        typeof after.legacyCred === 'string' && resolve(after.legacyCred || '.').startsWith(resolve(dst)),
        `迁移后 legacyCred 没跟着走（实际 ${after.legacyCred}，新目录 ${dst}）`,
      )
      must(
        after.sharedCred === before.sharedCred,
        `迁移后 sharedCred 变了（${before.sharedCred} → ${after.sharedCred}）—— 它在 $DSH_HOME 下，不该随 deps 迁移移动`,
      )

      // ── 第 4 步：真实 I/O 必须落在新目录（写 + 读回，不许只 stat）──
      report.step = 'step4-real-io'
      if (typeof after.lastRun === 'string') {
        // 写之前先确认目标真在新目录内。若生产漏绑 LAST_RUN，直接写会污染包内那份真实 deps，
        // 而且会把「判据自己弄脏了工作区」混进失败原因里。
        const inNewDir = resolve(dirname(after.lastRun)) === resolve(dst)
        must(inNewDir, `真实 I/O 的目标不在新目录：${after.lastRun}（新目录 ${dst}）`)
        if (inNewDir) {
          const marker = `rebind-io-${randomUUID()}`
          try {
            writeFileSync(after.lastRun, marker)
            const readBack = readFileSync(after.lastRun, 'utf8')
            must(
              readBack === marker,
              `写进去的内容读不回来（写入 ${marker}，读回 ${readBack}）—— 路径字符串对了，I/O 却没落到它上面`,
            )
            must(
              existsSync(join(dst, 'last-run.json')) &&
                readFileSync(join(dst, 'last-run.json'), 'utf8') === marker,
              '真实 I/O 没跟着走：新目录的 last-run.json 里不是刚写进去的内容',
            )
          } catch (e) {
            fails.push(
              `按重绑后的路径读写失败（${String((e && e.message) || e)}）—— 字符串对了但目录不可写，等于没绑上`,
            )
          }
        }
      }
    } else {
      notes.push('快照没拿到，第 3/4 步未执行')
    }
  }

  notes.push(`dst=${dst}`, `dstExistedAtStart=${dstExistedAtStart}`)
  report.ok = fails.length === 0
} catch (e) {
  probeError = String((e && e.stack) || e)
} finally {
  try {
    rmSync(prefRoot, { recursive: true, force: true })
    rmSync(fakeLocal, { recursive: true, force: true })
  } catch {}
}

if (probeError) {
  console.log(JSON.stringify({ ok: false, probeError }, null, 1))
  process.exit(2)
}
console.log(JSON.stringify(report, null, 1))
process.exit(report.ok ? 0 : 1)
