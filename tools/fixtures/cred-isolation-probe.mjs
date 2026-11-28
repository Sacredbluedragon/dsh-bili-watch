/**
 * 1740-DSH 任务 A：试做夹具凭证隔离自检（判据 C535）。
 *
 * 背景：1602 的 sub 试做夹具只设了 BILI_WATCH_CACHE/DSH_HOME，没设 BILI_WATCH_DEPS、
 *   也没预建临时 deps → resolveDepsDir 走到「包内 deps 有内容」判据 → credPaths().legacy
 *   指向产品树 deps/credential.json（真凭证）。本夹具证明这条回落路径已被阻断。
 *
 * 三件事：
 *   ① 阻断可证：隔离态下 <DEPS> 与 credPaths().legacy 都不指向产品树 deps/；反例（故意
 *      不隔离）必须落回产品树 deps → 断言红。
 *   ② 合成凭证两路：把合成凭证放临时 deps（legacy）→ adoptLegacyCred 迁移到临时 home
 *      （shared）→ 「带凭证」；两处都不放 → 「匿名」。全程只合成值，不碰真凭证。
 *   ③ 证据出口白名单：mock.hits() 只输出 {host,path,query}，不输出 cookie/凭证值。
 *
 * 只读产品代码、只写 temp、跑完 rmSync；不 push/tag/publish；不读真凭证。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const MOCK_BV = 'BV1mock00001'
const SYNTH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' // 合成 sessdata，不是真值
const SYNTH_CRED = JSON.stringify({ sessdata: SYNTH, bili_jct: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', buvid3: 'cccc', buvid4: 'dddd' })

const { startMockBili } = await import(pathToFileURL(join(HERE, 'bili-mock.mjs')).href)
const { resolveDepsDir } = await import(pathToFileURL(join(ROOT, 'lib', 'plugin-paths.mjs')).href)
const { credPaths } = await import(pathToFileURL(join(ROOT, 'lib', 'cred.mjs')).href)

const temp = mkdtempSync(join(tmpdir(), 'bw-cred-iso-'))
const cache = join(temp, 'cache'), home = join(temp, 'home'), deps = join(temp, 'deps')
const outDir = join(temp, 'out'), escapeLog = join(temp, 'escape.jsonl'), guardFile = join(temp, 'guard.mjs')
for (const d of [cache, home, deps, outDir]) mkdirSync(d, { recursive: true })
writeFileSync(join(cache, '.bili-watch-root'), '')
writeFileSync(escapeLog, '')

// guard：B 站四域名→mock；其它外部域名记日志+抛错（防止真请求出去）
const guardSrc = [
  "import { appendFileSync } from 'node:fs'",
  "const PORT = process.env.BW_MOCK_PORT || ''",
  "const ESC = process.env.BW_ESCAPE_LOG || ''",
  "const HOSTS = new Set(['api.bilibili.com','passport.bilibili.com','comment.bilibili.com','i0.hdslb.com'])",
  "const real = globalThis.fetch",
  "function esc(url) { try { if (ESC) appendFileSync(ESC, url + '\\n') } catch {} }",
  "globalThis.fetch = function(input, init) {",
  "  const raw = typeof input === 'string' ? input : String(input && input.url ? input.url : input)",
  "  let u; try { u = new URL(raw) } catch { esc(raw); throw new Error('guard: url unparsable ' + raw) }",
  "  if (HOSTS.has(u.hostname)) {",
  "    if (!PORT) { esc(raw); throw new Error('guard: BW_MOCK_PORT missing') }",
  "    return real('http://127.0.0.1:' + PORT + '/' + u.hostname + u.pathname + u.search, init)",
  "  }",
  "  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') return real(input, init)",
  "  esc(raw); throw new Error('guard: external blocked ' + u.hostname + u.pathname)",
  "}",
].join('\n') + '\n'
writeFileSync(guardFile, guardSrc)

const out = { fatal: null, isolation: {}, synthetic: {}, whitelist: {} }
const prodDeps = resolve(join(ROOT, 'deps'))

// ===== ① 阻断生效可证（含反例）=====
try {
  // 隔离态：修法 1 —— BILI_WATCH_DEPS 指向预建的临时 deps
  const isoEnv = { ...process.env, BILI_WATCH_DEPS: deps, DSH_HOME: home }
  const isoDeps = resolveDepsDir({ pluginRoot: ROOT, env: isoEnv, home })
  const isoLegacy = resolve(credPaths(isoDeps).legacy)
  out.isolation.isoDeps = isoDeps.replace(temp, '<TEMP>')
  out.isolation.isoLegacy = isoLegacy.replace(temp, '<TEMP>')
  out.isolation.isolatedOk = isoDeps === resolve(deps) && !isoLegacy.includes(prodDeps) && isoLegacy.startsWith(temp)

  // 反例：只设 DSH_HOME、不设 BILI_WATCH_DEPS、不预建临时 deps → 落回产品树 deps
  const badEnv = { ...process.env, DSH_HOME: home }
  delete badEnv.BILI_WATCH_DEPS
  const badDeps = resolveDepsDir({ pluginRoot: ROOT, env: badEnv, home })
  const badLegacy = resolve(credPaths(badDeps).legacy)
  out.isolation.badDeps = badDeps.replace(ROOT, '<PRODUCT>')
  out.isolation.badLegacy = badLegacy.replace(ROOT, '<PRODUCT>')
  // 反例必须落回产品树 deps（即「不隔离时断言会红」）——worktree 的 deps/ 有 _bili-asr.py，有内容
  out.isolation.counterexampleFails = badLegacy === resolve(join(prodDeps, 'credential.json')) || badLegacy.startsWith(prodDeps)
} catch (e) { out.fatal = 'isolation: ' + String(e && e.message ? e.message : e) }

// ===== ②③ 合成凭证两路 + 白名单出口 =====
const runCli = (env) => {
  const r = spawnSync(process.execPath, [LOOK, 'sub', MOCK_BV], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env,
  })
  return { rc: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
const whitelistHits = (hits) => hits.map(({ host, path, query }) => ({ host, path, query }))

let mock = null
try {
  const baseEnv = { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(guardFile).href, BW_ESCAPE_LOG: escapeLog,
    BILI_WATCH_CACHE: cache, DSH_HOME: home, BILI_WATCH_DEPS: deps }
  for (const k of ['BILI_WATCH_PROJ', 'BILI_WATCH_DEPS_REAL']) delete baseEnv[k]

  // 合成凭证放临时 deps（legacy）→ adoptLegacyCred 迁移到临时 home（shared）
  writeFileSync(join(deps, 'credential.json'), SYNTH_CRED, 'utf8')
  mock = await startMockBili()
  const withEnv = { ...baseEnv, BW_MOCK_PORT: String(mock.port) }
  const withCred = runCli(withEnv)
  const withHits = whitelistHits(mock.hits())
  out.synthetic.withCred = {
    rc: withCred.rc,
    hasCredMark: withCred.stdout.includes('（带凭证）'),
    hasAnonMark: withCred.stdout.includes('（匿名）'),
    migratedNotice: /\[cred\].*已复制/.test(withCred.stderr),
    hits: withHits,
    // 只出布尔：合成值是否进了 cookie，不输出值本身
    synthCookieSeen: mock.hits().some((h) => String(h.cookie || '').includes('SESSDATA=' + SYNTH)),
  }
  await mock.close(); mock = null

  // 无凭证：两处都不放 → 匿名
  rmSync(join(deps, 'credential.json'), { force: true })
  const sharedCred = join(home, 'bili-watch', 'credential.json')
  rmSync(sharedCred, { force: true })
  mock = await startMockBili()
  const noEnv = { ...baseEnv, BW_MOCK_PORT: String(mock.port) }
  const noCred = runCli(noEnv)
  const noHits = whitelistHits(mock.hits())
  out.synthetic.noCred = {
    rc: noCred.rc,
    hasAnonMark: noCred.stdout.includes('（匿名）'),
    hasCredMark: noCred.stdout.includes('（带凭证）'),
    hits: noHits,
    anySessdataInCookie: mock.hits().some((h) => String(h.cookie || '').includes('SESSDATA=')),
  }
  await mock.close(); mock = null

  // 白名单出口：序列化后的 JSON 不含合成值、不含 cookie 字段名/真凭证特征
  const serialized = JSON.stringify(out)
  out.whitelist = {
    keys: [...new Set(withHits.concat(noHits).flatMap((h) => Object.keys(h)))],
    noSynthValueInOutput: !serialized.includes(SYNTH),
    noCookieFieldInOutput: !serialized.includes('"cookie"'),
    noRealCredPattern: !/SESSDATA=[0-9a-f]{20,}|bili_jct=[0-9a-f]{20,}/i.test(serialized),
  }
  out.escapeLogText = readFileSync(escapeLog, 'utf8')
} catch (e) { out.fatal = (out.fatal ? out.fatal + ' | ' : '') + 'synthetic: ' + String(e && e.message ? e.message : e) }
finally {
  if (mock) await mock.close().catch(() => {})
  rmSync(temp, { recursive: true, force: true })
}

console.log('C535_JSON=' + JSON.stringify(out))
