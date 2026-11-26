// 1516 C 件行为回归取证夹具：隔离副本 + 假 npm，真跑五场景。
// stdout 只吐一行 GATE_JSON=<json>；造失败全在 D:/007 Dsh工作区/_临时/ 下，跑完 rmSync 清理。
// 不碰正式发布树、不连真实 GitHub/registry、不 push/tag/publish。
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')                 // 真实 dev 树根
const PS51 = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const win = (p) => p.replace(/\//g, '\\')

const BASE = mkdtempSync(join('D:/007 Dsh工作区/_临时', 'c486gate-'))
const baseW = win(BASE)
const mkdir = (d) => mkdirSync(d, { recursive: true })

function countFiles(d) {
  let n = 0
  try {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      n += e.isDirectory() ? countFiles(join(d, e.name)) : 1
    }
  } catch {}
  return n
}

function makeDev(name) {
  const d = join(BASE, name)
  mkdir(d)
  // 最小完整副本：files 白名单 + repoOnly 守卫全套（sync 的 AssertNoPaths 需要完整扫描面）。
  for (const f of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'auto-trigger.js',
    'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', '.leak-ids']) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(d, f))
  }
  for (const dir of ['lib', 'docs', 'scripts', 'tools']) cpSync(join(ROOT, dir), join(d, dir), { recursive: true })
  mkdir(join(d, 'deps'))
  if (existsSync(join(ROOT, 'deps', '_bili-asr.py'))) cpSync(join(ROOT, 'deps', '_bili-asr.py'), join(d, 'deps', '_bili-asr.py'))
  return d
}

const srcA = makeDev('srcA'), srcB = makeDev('srcB'), srcC = makeDev('srcC'), srcD = makeDev('srcD')
const relA = join(BASE, 'relA'), relB = join(BASE, 'relB'), relC = join(BASE, 'relC'), relD = join(BASE, 'relD')
;[relA, relB, relC, relD].forEach(mkdir)

// 假 npm（pure ASCII；cmd 按 GBK 读，中文注释会被拆成命令污染 stderr）。
function fakeNpm(name, echoLine) {
  const d = join(BASE, name)
  mkdir(d)
  writeFileSync(join(d, 'npm.cmd'),
    '@echo off\nrem fake npm ' + name + '\nif /i "%~1"=="view" (\n  echo ' + echoLine +
    '\n  exit /b 0\n)\necho fake-' + name + '-unexpected %* 1>&2\nexit /b 1\n', 'ascii')
  return win(d)
}
const npmA = fakeNpm('fakeA', '["0.4.16"]')            // 目标 0.4.17 未发布
const npmB = fakeNpm('fakeB', '["0.4.16","0.4.17"]')   // 目标已发布（版本未递增闸）
const npmC = fakeNpm('fakeC', '[]')                     // 空列表（md5 闸绕开闸1）

// C486 写版本正对照要求「源版本 < 目标版本」。真实 dev 树 version 会随发布推进（现 0.4.17），
// 若源已是 0.4.17，release 写 0.4.17 就是 no-op，判据 before/after 假红。把专用 srcB 的源版本
// 钉到 0.4.16，让 before=0.4.16 → after=0.4.17 与真实 version 解耦（只改隔离副本，不碰真实包）。
{
  const pj = join(srcB, 'package.json')
  const j = JSON.parse(readFileSync(pj, 'utf8'))
  j.version = '0.4.16'
  writeFileSync(pj, JSON.stringify(j, null, 2) + '\n')
}

// srcB 元判据桩：元判据闸与三条元判据秒过（省 428s+846s；真品保留在 srcA/srcC）。
const STUB = "console.log('[stub] ok');process.exit(0)\n"
writeFileSync(join(srcB, 'tools', 'verify-self.mjs'), STUB, 'ascii')
writeFileSync(join(srcB, 'tools', 'verify.mjs'), STUB, 'ascii')

const gbk = new TextDecoder('gbk')
function ps(script, args, npmDir) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  env.PATH = npmDir ? (npmDir + ';' + (env.PATH || env.Path || '')) : (env.PATH || env.Path || '')
  const r = spawnSync(PS51, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', win(script), ...args], {
    cwd: baseW, env, encoding: 'buffer', timeout: 180000, windowsHide: true,
  })
  // PS 5.1 中文输出是 GBK（cmd 代码页），按 utf8 读会乱码，正则匹配不到文案。
  const out = gbk.decode(Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]))
  return { rc: r.status, out }
}
const outTail = (s, n = 10) => s.split(/\r?\n/).filter(Boolean).slice(-n).join(' | ')
const verOf = (p) => {
  const m = readFileSync(p, 'utf8').match(/"version"\s*:\s*"([^"]+)"/)
  return m ? m[1] : null
}

const R = {}

// ── C486：registry 正对照（非 DryRun，srcB 桩 + fakeA，真跑到写版本）──
{
  const before = verOf(join(srcB, 'package.json'))
  const r = ps(join(srcB, 'scripts', 'release.ps1'),
    ['-Version', '0.4.17', '-Source', win(srcB), '-Release', win(relC)], npmA)
  const after = verOf(join(srcB, 'package.json'))
  R.c486 = {
    rc: r.rc, before, after, wroteVersion: after === '0.4.17',
    sawMeta: /\[meta\] 源版本 -> 0\.4\.17/.test(r.out),
    sawNotPublished: /版本 0\.4\.17 未发布过/.test(r.out),
    outTail: outTail(r.out),
  }
}

// ── C487：缺件零写入（srcD + 空 relD，sync 真跑非 DryRun）──
{
  const beforeCount = countFiles(relD)
  const r = ps(join(srcD, 'scripts', 'sync-release.ps1'),
    ['-Source', win(srcD), '-Release', win(relD), '-Version', '0.4.17'], null)
  const afterCount = countFiles(relD)
  R.c487 = {
    rc: r.rc, beforeCount, afterCount, zeroWrite: beforeCount === 0 && afterCount === 0,
    sawFail: /发布树缺 auto-trigger\.js/.test(r.out), outTail: outTail(r.out),
  }
}

// ── C488：三道闸各注入一次失败 ──
// 闸1 版本未递增（release.ps1:659，fakeB + DryRun）
{
  const r = ps(join(srcA, 'scripts', 'release.ps1'),
    ['-DryRun', '-Version', '0.4.17', '-Source', win(srcA), '-Release', win(relA)], npmB)
  R.gate1 = { rc: r.rc, saw: /版本 0\.4\.17 已经在 npm 上发布过了/.test(r.out), outTail: outTail(r.out) }
}
// 闸2 md5 硬闸（release.ps1:726，DryRun；先预同步造对照，再制造 drift，fakeC 绕开闸1）
{
  cpSync(join(srcA, 'auto-trigger.js'), join(relB, 'auto-trigger.js'))
  cpSync(join(srcA, 'README.md'), join(relB, 'README.md'))
  const pre = ps(join(srcA, 'scripts', 'sync-release.ps1'),
    ['-Source', win(srcA), '-Release', win(relB), '-Version', '0.4.16'], null)
  writeFileSync(join(relB, 'index.js'), readFileSync(join(relB, 'index.js'), 'utf8') + '\n')
  const r = ps(join(srcA, 'scripts', 'release.ps1'),
    ['-DryRun', '-Version', '0.4.16', '-Source', win(srcA), '-Release', win(relB)], npmC)
  R.gate2 = {
    rc: r.rc, preRc: pre.rc, sawDrift: /发布树与 dev 不一致/.test(r.out),
    sawFail: /DryRun：闸门不放行/.test(r.out), outTail: outTail(r.out),
  }
}
// 闸3 元判据闸（release.ps1:607，截断主闸 + fakeA + DryRun）
{
  const t = readFileSync(join(srcC, 'tools', 'verify.mjs'))
  writeFileSync(join(srcC, 'tools', 'verify.mjs'), t.subarray(0, 50000))
  const r = ps(join(srcC, 'scripts', 'release.ps1'),
    ['-DryRun', '-Version', '0.4.17', '-Source', win(srcC), '-Release', win(relA)], npmA)
  R.gate3 = { rc: r.rc, saw: /元判据闸未过|疑似被截断|主闸.*截断/.test(r.out), outTail: outTail(r.out) }
}

rmSync(BASE, { recursive: true, force: true })
process.stdout.write('GATE_JSON=' + JSON.stringify(R) + '\n')
