/**
 * C454–C456 / C462–C466 续推（任务 A）取证夹具。stdout 只吐 JSON，任何路径都真跑。
 *
 * 全程隔离：本地 bare remote 当 origin，自起一个本地假 Release API（自 spawn 一份本文件
 * 带 --server），pwsh 真跑 release.ps1 -ResumeGit。不连任何真实 GitHub / registry。
 * 23:59 返修后覆盖 A-4 表 8 个现场：
 *   1 假成功（本地/远端分叉 + 无标签 + API 有 Release）→ rc=2 零写      (c463)
 *   2 轻量标签（远端 tag 非附注对象）→ rc=2 零写                       (c464)
 *   3 三级全匹配 → rc=0 零写                                            (c456)
 *   4 写成功丢回包 → 第一次 rc=3、第二次 rc=0，POST 累计 1              (c454)
 *   5 鉴权失败 401 → rc=2 零写                                          (c465.auth)
 *   6 超时（API 不响应，timeout=3）→ rc=3 零写                          (c465.timeout)
 *   7 正文文件不存在 → rc=2 零写                                        (c466)
 *   8 远端 main 落后一提交（该补推）→ rc=0，main push 1 + POST 1         (c468)
 * 另：远端查询失败（origin 坏）→ rc∈{2,3} 且不是 1                      (c465.remoteFail)
 */
import { spawnSync, spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import http from 'node:http'

const HERE = fileURLToPath(import.meta.url)
const ROOT = join(dirname(HERE), '..', '..')
const REL = join(ROOT, 'scripts', 'release.ps1').replace(/\//g, '\\')

// ---- server 模式：读 stateFile，GET 三级 Release，POST 计数 + 可丢回包/鉴权失败/超时 ----
if (process.argv[2] === '--server') {
  const port = Number(process.argv[3])
  const stateFile = process.argv[4]
  const read = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return {} } }
  const write = (s) => writeFileSync(stateFile, JSON.stringify(s), 'utf8')
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/__state') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(read())); return
    }
    if (u.pathname.endsWith('/releases') && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const st = read()
        st.postCount = (st.postCount || 0) + 1
        // C480 (3-F1)：POST 鉴权失败但 main/tag 已经推上去了 —— 造「部分写入后失败」现场。
        //   计数要先加（客户端确实发了一次 POST），但不写 st.release。
        if (st.postAuthFail) {
          write(st)
          res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"message":"Bad credentials"}'); return
        }
        let payload = {}
        try { payload = JSON.parse(body) } catch {}
        // 0114：POST 建出来的 Release 是正式版（draft/prerelease 显式 false），
        // 与新预检口径一致，避免老现场因缺字段被误判冲突。
        st.release = { tag_name: payload.tag_name || '', body: payload.body || '', draft: false, prerelease: false }
        write(st)
        if (st.lostReplyOnce) {
          st.lostReplyOnce = false; write(st)
          res.socket.destroy() // 写成功但回包丢 —— 客户端只能看到网络错
          return
        }
        res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(st.release))
      })
      return
    }
    const m = u.pathname.match(/\/releases\/tags\/(.+)$/)
    if (m && req.method === 'GET') {
      const st = read()
      if (st.hangAPI) { setTimeout(() => { try { res.destroy() } catch {} }, 20000); return }
      if (st.authFail) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"message":"Bad credentials"}'); return }
      const tag = decodeURIComponent(m[1])
      if (st.badJson) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('NOT_A_JSON<<<>>>'); return }
      if (st.forceRelease200 && st.release) {
        // 0114 现场6：Release 存在但缺 tag_name，仍要按 200 返回才能验「缺 tag_name 不算完成」
        const out = { body: '', draft: false, prerelease: false, ...st.release }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); return
      }
      if (st.release && st.release.tag_name === tag && st.releaseAlive !== false) {
        // 0114：老现场只给 tag_name/body，默认补正式版标志；新现场可显式设 draft/prerelease=true
        // 或删掉 tag_name 来触发对应缺陷。
        const out = { body: st.release.body, draft: false, prerelease: false, ...st.release }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"message":"Not Found"}')
      }
      return
    }
    res.writeHead(404); res.end()
  })
  srv.listen(port, '127.0.0.1', () => console.log('READY'))
  process.on('SIGTERM', () => srv.close(() => process.exit(0)))
  process.exitCode = 0
} else {
  // ---- driver 模式 ----
  const tmp = mkdtempSync(join(tmpdir(), 'c454-'))
  const emptyCfg = join(tmp, 'empty.gitconfig'); writeFileSync(emptyCfg, '')
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_SYSTEM: emptyCfg,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const repo = join(tmp, 'repo'); const bare = join(tmp, 'remote.git')
  mkdirSync(repo)
  const git = (args, cwd) => spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 30000 })
  git(['init', '-q', '-b', 'main', repo])
  git(['config', 'user.email', 'probe@example.com'], repo)
  git(['config', 'user.name', 'probe'], repo)
  git(['init', '-q', '--bare', bare])
  git(['remote', 'add', 'origin', bare], repo)

  const source = join(tmp, 'source'); mkdirSync(source)
  writeFileSync(join(source, 'package.json'), '{"name":"probe","version":"0.4.16"}\n')
  // -ResumeGit 按 -Release 参数定位 git 仓库（Push-Location），不依赖调用者 cwd。
  const outsideCwd = join(tmp, 'outside'); mkdirSync(outsideCwd)
  const bodyFile = join(tmp, 'body.md'); writeFileSync(bodyFile, 'release notes v0.4.16\nline2\n', 'utf8')
  const bodyMissing = join(tmp, 'no-such-body.md') // 现场 7：故意不创建

  const probePort = net.createServer()
  const port = await new Promise((resolve) => {
    probePort.listen(0, '127.0.0.1', () => { const p = probePort.address().port; probePort.close(() => resolve(p)) })
  })
  const stateFile = join(tmp, 'state.json')
  const setState = (s) => writeFileSync(stateFile, JSON.stringify(s), 'utf8')
  setState({ postCount: 0, lostReplyOnce: true, release: null })

  const server = spawn(process.execPath, [HERE, '--server', String(port), stateFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  let serverReady = false
  server.stdout.on('data', (d) => { if (String(d).includes('READY')) serverReady = true })
  let serverErr = ''
  server.stderr.on('data', (d) => { serverErr += String(d) })
  const t0 = Date.now()
  while (!serverReady && Date.now() - t0 < 10000) { await new Promise((r) => setTimeout(r, 50)) }
  if (!serverReady) { console.log(JSON.stringify({ fatal: 'server not ready', serverErr })); process.exit(0) }

  // PS 5.1 按 GBK 解 UTF-8 中文注释会解析失败，用 pwsh 7。
  const pwshExe = 'pwsh'
  const apiBase = `http://127.0.0.1:${port}`
  const runResume = (cwd = outsideCwd, releaseDir = repo, opts = {}) => {
    // 0114：显式传 bodyFile:null 才真正省略 -ResumeBodyFile（验「缺定稿」）；空串会被 || 回退掉。
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REL,
      '-Source', source, '-Release', releaseDir, '-ResumeGit', '-ReleaseApiBase', apiBase]
    if (opts.bodyFile !== null) args.push('-ResumeBodyFile', opts.bodyFile || bodyFile)
    args.push('-ResumeTimeoutSec', String(opts.timeoutSec || 12))
    const r = spawnSync(pwshExe, args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
    return { rc: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').slice(-300) }
  }
  const state = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return {} } }
  const countRefs = (r = repo) => {
    const a = git(['ls-remote', 'origin'], r)
    const lines = (a.stdout || '').trim().split('\n').filter(Boolean)
    return { count: lines.length, raw: (a.stdout || '').trim() }
  }
  const mkRepo = (name, first) => {
    const r = join(tmp, name), b = join(tmp, name + '.git'); mkdirSync(r)
    git(['init', '-q', '-b', 'main', r])
    git(['config', 'user.email', 'probe@example.com'], r); git(['config', 'user.name', 'probe'], r)
    git(['init', '-q', '--bare', b]); git(['remote', 'add', 'origin', b], r)
    writeFileSync(join(r, 'a.txt'), first + '\n'); git(['add', '-A'], r); git(['commit', '-q', '-m', first], r)
    return { r, b }
  }

  // 基线：本地一个提交，远端空
  writeFileSync(join(repo, 'a.txt'), 'probe\n'); git(['add', '-A'], repo); git(['commit', '-q', '-m', 'probe'], repo)

  // === 现场4 (C454)：第一次写成功丢回包 → rc=3；第二次零重复写 → rc=0、postCount 仍 1 ===
  const r1 = runResume()
  const st1 = state()
  const r2 = runResume()
  const st2 = state()
  const refsAfter454 = countRefs()

  // === 现场3 (C456/C462)：三级全匹配 → rc=0、零新增 POST/push ===
  setState({ postCount: st2.postCount || 0, lostReplyOnce: false, release: { tag_name: 'v0.4.16', body: bodyFileBody() } })
  function bodyFileBody () { return readFileSync(bodyFile, 'utf8') }
  const r3 = runResume()
  const st3 = state()
  const refsAfter456 = countRefs()
  const cwdGit = git(['rev-parse', '--is-inside-work-tree'], outsideCwd)
  const cwdIsGit = (cwdGit.status === 0 && (cwdGit.stdout || '').trim() === 'true')
  const rInside = runResume(repo, repo)

  // === 现场 C455a：同名标签剥离目标不同 → rc=2、远端引用数不变 ===
  const rb0 = mkRepo('repoB', 'A')
  git(['push', '-q', 'origin', 'main'], rb0.r)
  git(['tag', '-a', 'v0.4.16', '-m', 'A'], rb0.r); git(['push', '-q', 'origin', 'v0.4.16'], rb0.r)
  writeFileSync(join(rb0.r, 'a.txt'), 'B\n'); git(['add', '-A'], rb0.r); git(['commit', '-q', '-m', 'B'], rb0.r)
  setState({ postCount: 0, lostReplyOnce: false, release: { tag_name: 'v0.4.16', body: bodyFileBody() } })
  const refsBBefore = (git(['ls-remote', 'origin'], rb0.r).stdout || '').trim()
  const rb = spawnSync(pwshExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REL,
    '-Source', source, '-Release', rb0.r, '-ResumeGit',
    '-ReleaseApiBase', apiBase, '-ResumeBodyFile', bodyFile, '-ResumeTimeoutSec', '12'],
    { cwd: outsideCwd, env: gitEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  const refsBAfter = (git(['ls-remote', 'origin'], rb0.r).stdout || '').trim()

  // === 现场 C455b：Release 正文不同 → rc=2、POST 不增加 ===
  setState({ postCount: 0, lostReplyOnce: false, release: { tag_name: 'v0.4.16', body: 'DIFFERENT BODY\n' } })
  const rcBody = spawnSync(pwshExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REL,
    '-Source', source, '-Release', repo, '-ResumeGit',
    '-ReleaseApiBase', apiBase, '-ResumeBodyFile', bodyFile, '-ResumeTimeoutSec', '12'],
    { cwd: outsideCwd, env: gitEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  const stBody = state()

  // === 现场1 (C463)：假成功 —— 本地/远端分叉 + 远端无标签 + API 有正式 Release ===
  const rc0 = mkRepo('repoC', 'A')
  git(['push', '-q', 'origin', 'main'], rc0.r) // bareC main=A
  const alt = join(tmp, 'alt'); mkdirSync(alt)
  git(['init', '-q', '-b', 'main', alt]); git(['config', 'user.email', 'p@e.com'], alt); git(['config', 'user.name', 'p'], alt)
  git(['remote', 'add', 'origin', rc0.b], alt)
  writeFileSync(join(alt, 'x.txt'), 'X\n'); git(['add', '-A'], alt); git(['commit', '-q', '-m', 'X'], alt)
  git(['push', '-q', '-f', 'origin', 'main'], alt) // bareC main=X（与本地 A 无共同祖先）
  setState({ postCount: 0, lostReplyOnce: false, release: { tag_name: 'v0.4.16', body: bodyFileBody() } })
  const refsCBefore = countRefs(rc0.r)
  const rcFake = runResume(outsideCwd, rc0.r)
  const refsCAfter = countRefs(rc0.r)
  const stFake = state()

  // === 现场2 (C464)：轻量标签 —— 远端 refs/tags/v0.4.16 指向 commit（非 tag 对象）、无 ^{} ===
  const re0 = mkRepo('repoE', 'A')
  git(['push', '-q', 'origin', 'main'], re0.r)
  git(['tag', 'v0.4.16'], re0.r) // 轻量标签
  git(['push', '-q', 'origin', 'v0.4.16'], re0.r)
  setState({ postCount: 0, lostReplyOnce: false, release: { tag_name: 'v0.4.16', body: bodyFileBody() } })
  const refsEBefore = countRefs(re0.r)
  const rcLight = runResume(outsideCwd, re0.r)
  const refsEAfter = countRefs(re0.r)
  const stLight = state()

  // === 现场5 (C465.auth)：鉴权失败 401 → rc=2、零写 ===
  setState({ postCount: 0, lostReplyOnce: false, authFail: true, release: null })
  const rcAuth = runResume(outsideCwd, repo)
  const stAuth = state()

  // === 现场6 (C465.timeout)：API 不响应 + timeout=3 → rc=3、零写 ===
  setState({ postCount: 0, lostReplyOnce: false, hangAPI: true, release: null })
  const rcTimeout = runResume(outsideCwd, repo, { timeoutSec: 3 })
  const stTimeout = state()

  // === 现场7 (C466)：正文文件不存在 → rc=2、零写 ===
  setState({ postCount: 0, lostReplyOnce: false, release: null })
  const rcNoBody = runResume(outsideCwd, repo, { bodyFile: bodyMissing })
  const stNoBody = state()

  // === 现场8 (C468)：远端 main 落后一提交（该补推）→ rc=0，push + POST ===
  const rd0 = mkRepo('repoD', 'A')
  git(['push', '-q', 'origin', 'main'], rd0.r) // bareD main=A
  writeFileSync(join(rd0.r, 'b.txt'), 'B\n'); git(['add', '-A'], rd0.r); git(['commit', '-q', '-m', 'B'], rd0.r)
  setState({ postCount: 0, lostReplyOnce: false, release: null })
  const refsDBefore = countRefs(rd0.r)
  const rcBehind = runResume(outsideCwd, rd0.r)
  const refsDAfter = countRefs(rd0.r)
  const stBehind = state()

  // === 远端查询失败 (C465.remoteFail)：origin 指向不存在的路径 → rc∈{2,3} 且不是 1 ===
  const rg0 = mkRepo('repoG', 'A')
  git(['remote', 'set-url', 'origin', join(tmp, 'no-such-remote.git')], rg0.r)
  setState({ postCount: 0, lostReplyOnce: false, release: null })
  const rcRemoteFail = runResume(outsideCwd, rg0.r, { timeoutSec: 3 })
  const stRemoteFail = state()

  // ==================== 0114 七边界返修：7 现场 + 正对照 ====================
  // 现场1 draft=true（main/标签齐、正文齐）。基线 rc=0 误判完成；新规则须 rc≠0、POST=0、main 不变。
  const s1 = mkRepo('s1', 'A')
  git(['push', '-q', 'origin', 'main'], s1.r)
  git(['tag', '-a', 'v0.4.16', '-m', 'A'], s1.r); git(['push', '-q', 'origin', 'v0.4.16'], s1.r)
  setState({ postCount: 0, lostReplyOnce: false,
    release: { tag_name: 'v0.4.16', body: bodyFileBody(), draft: true, prerelease: false } })
  const s1Before = (git(['ls-remote', 'origin'], s1.r).stdout || '').trim()
  const c469draft = runResume(outsideCwd, s1.r)
  const s1After = (git(['ls-remote', 'origin'], s1.r).stdout || '').trim()
  const st469draft = state()

  // 现场2 prerelease=true
  setState({ postCount: 0, lostReplyOnce: false,
    release: { tag_name: 'v0.4.16', body: bodyFileBody(), draft: false, prerelease: true } })
  const s1Before2 = (git(['ls-remote', 'origin'], s1.r).stdout || '').trim()
  const c469pre = runResume(outsideCwd, s1.r)
  const s1After2 = (git(['ls-remote', 'origin'], s1.r).stdout || '').trim()
  const st469pre = state()

  // 现场3 远端轻量标签 + main 落后一提交（可快进）。基线先推 main 才在③报 rc2；新规则须预检 rc2、main 前后 SHA 不变。
  const s3 = mkRepo('s3', 'A')
  git(['push', '-q', 'origin', 'main'], s3.r)
  git(['tag', 'v0.4.16'], s3.r); git(['push', '-q', 'origin', 'v0.4.16'], s3.r) // 轻量标签
  writeFileSync(join(s3.r, 'b.txt'), 'B\n'); git(['add', '-A'], s3.r); git(['commit', '-q', '-m', 'B'], s3.r)
  setState({ postCount: 0, lostReplyOnce: false, release: null })
  const s3mainBefore = (git(['ls-remote', 'origin', 'refs/heads/main'], s3.r).stdout || '').trim()
  const c470 = runResume(outsideCwd, s3.r)
  const s3mainAfter = (git(['ls-remote', 'origin', 'refs/heads/main'], s3.r).stdout || '').trim()
  const st470 = state()

  // 现场4 本地轻量标签、远端无标签。基线把它推上去（对象类型 commit）；新规则须 rc2、远端不出现标签。
  const s4 = mkRepo('s4', 'A')
  git(['push', '-q', 'origin', 'main'], s4.r)
  git(['tag', 'v0.4.16'], s4.r) // 本地轻量标签，未推
  setState({ postCount: 0, lostReplyOnce: false, release: null })
  const s4TagsBefore = (git(['ls-remote', 'origin', 'refs/tags/v0.4.16'], s4.r).stdout || '').trim()
  const c471 = runResume(outsideCwd, s4.r)
  const s4TagsAfter = (git(['ls-remote', 'origin', 'refs/tags/v0.4.16'], s4.r).stdout || '').trim()
  const st471 = state()

  // 现场5 缺定稿（不传 -ResumeBodyFile）
  setState({ postCount: 0, lostReplyOnce: false, release: null })
  const c472nobody = runResume(outsideCwd, repo, { bodyFile: null })
  const st472nobody = state()

  // 现场6 Release 缺 tag_name（spread 后用 undefined 覆盖删除字段）
  const s6 = mkRepo('s6', 'A')
  git(['push', '-q', 'origin', 'main'], s6.r)
  git(['tag', '-a', 'v0.4.16', '-m', 'A'], s6.r); git(['push', '-q', 'origin', 'v0.4.16'], s6.r)
  setState({ postCount: 0, lostReplyOnce: false, forceRelease200: true,
    release: { body: bodyFileBody(), draft: false, prerelease: false } })
  const c472notag = runResume(outsideCwd, s6.r)
  const st472notag = state()

  // 现场7 Release 返回非 JSON
  const s7 = mkRepo('s7', 'A')
  git(['push', '-q', 'origin', 'main'], s7.r)
  git(['tag', '-a', 'v0.4.16', '-m', 'A'], s7.r); git(['push', '-q', 'origin', 'v0.4.16'], s7.r)
  setState({ postCount: 0, lostReplyOnce: false, badJson: true })
  const c472badjson = runResume(outsideCwd, s7.r)
  const st472badjson = state()

  // 正对照 a：本来就全匹配 → 零写入文案
  setState({ postCount: 0, lostReplyOnce: false,
    release: { tag_name: 'v0.4.16', body: bodyFileBody(), draft: false, prerelease: false } })
  const c473zero = runResume(outsideCwd, repo)
  const st473zero = state()

  // 正对照 b：本轮补写 main（push 1 次）+ POST 建 Release → 补写文案
  const s8 = mkRepo('s8', 'A')
  git(['push', '-q', 'origin', 'main'], s8.r)
  writeFileSync(join(s8.r, 'b.txt'), 'B\n'); git(['add', '-A'], s8.r); git(['commit', '-q', '-m', 'B'], s8.r)
  setState({ postCount: 0, lostReplyOnce: false, release: null })
  const c473write = runResume(outsideCwd, s8.r)
  const st473write = state()

  // === C480 (3-F1)：main/tag 已推成功，POST 401 失败 → 回执必须逐项说清，不许谎称「未写入远端」===
  const s9 = mkRepo('s9', 'A')
  git(['push', '-q', 'origin', 'main'], s9.r)      // bare main=A
  writeFileSync(join(s9.r, 'b.txt'), 'B\n'); git(['add', '-A'], s9.r); git(['commit', '-q', '-m', 'B'], s9.r)
  git(['tag', '-a', 'v0.4.16', '-m', 'B'], s9.r)   // 本地附注标签，远端还没有
  setState({ postCount: 0, lostReplyOnce: false, postAuthFail: true, release: null })
  const mainSha = (raw) => { const m = (raw || '').match(/^([0-9a-f]{40})\s+refs\/heads\/main$/m); return m ? m[1] : '' }
  const c480Before = (git(['ls-remote', 'origin'], s9.r).stdout || '').trim()
  const c480 = runResume(outsideCwd, s9.r)
  const st480 = state()
  const c480After = (git(['ls-remote', 'origin'], s9.r).stdout || '').trim()
  const c480mainPushed = mainSha(c480Before) !== '' && mainSha(c480Before) !== mainSha(c480After)
  const c480tagPushed = !/refs\/tags\/v0\.4\.16/.test(c480Before) && /refs\/tags\/v0\.4\.16/.test(c480After)

  server.kill('SIGTERM')
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}

  console.log(JSON.stringify({
    serverErr: serverErr.slice(-200),
    c454: { r1, r2, post1: st1.postCount || 0, post2: st2.postCount || 0, refCount: refsAfter454.count,
      r1out: r1.out.slice(-500), r2out: r2.out.slice(-500) },
    c456: { r3, post3: st3.postCount || 0, refCount: refsAfter456.count, r3out: r3.out.slice(-400) },
    c462: { cwdIsGit, cwdOut: (cwdGit.stdout || '').trim(), rc: r3.rc, out: r3.out.slice(-400),
      inside: { rc: rInside.rc, out: rInside.out.slice(-300) } },
    c455: { peel: { rc: rb.status, out: (rb.stdout || '').slice(-500), err: (rb.stderr || '').slice(-200),
        refsUnchanged: refsBBefore === refsBAfter, refsBBefore, refsBAfter },
      body: { rc: rcBody.status, out: (rcBody.stdout || '').slice(-500), post: stBody.postCount || 0 } },
    c463: { rc: rcFake.rc, out: rcFake.out.slice(-600), err: rcFake.err,
      refsBefore: refsCBefore.count, refsAfter: refsCAfter.count,
      refsUnchanged: refsCBefore.raw === refsCAfter.raw, post: stFake.postCount || 0 },
    c464: { rc: rcLight.rc, out: rcLight.out.slice(-600),
      refsBefore: refsEBefore.count, refsAfter: refsEAfter.count,
      refsUnchanged: refsEBefore.raw === refsEAfter.raw, post: stLight.postCount || 0 },
    c465: { auth: { rc: rcAuth.rc, out: rcAuth.out.slice(-400), post: stAuth.postCount || 0 },
      timeout: { rc: rcTimeout.rc, out: rcTimeout.out.slice(-400), post: stTimeout.postCount || 0 },
      remoteFail: { rc: rcRemoteFail.rc, out: rcRemoteFail.out.slice(-500), post: stRemoteFail.postCount || 0 } },
    c466: { rc: rcNoBody.rc, out: rcNoBody.out.slice(-500), post: stNoBody.postCount || 0 },
    c468: { rc: rcBehind.rc, out: rcBehind.out.slice(-500),
      refsBefore: refsDBefore.count, refsAfter: refsDAfter.count, post: stBehind.postCount || 0 },
    // 0114 七边界
    c469: {
      draft: { rc: c469draft.rc, out: c469draft.out.slice(-400), post: st469draft.postCount || 0,
        mainUnchanged: s1Before === s1After, mainBefore: s1Before, mainAfter: s1After },
      prerelease: { rc: c469pre.rc, out: c469pre.out.slice(-400), post: st469pre.postCount || 0,
        mainUnchanged: s1Before2 === s1After2 },
    },
    c470: { rc: c470.rc, out: c470.out.slice(-500), post: st470.postCount || 0,
      mainUnchanged: s3mainBefore === s3mainAfter, mainBefore: s3mainBefore, mainAfter: s3mainAfter },
    c471: { rc: c471.rc, out: c471.out.slice(-500), post: st471.postCount || 0,
      remoteTagsBefore: s4TagsBefore, remoteTagsAfter: s4TagsAfter, tagAbsent: !s4TagsAfter },
    c472: {
      nobody: { rc: c472nobody.rc, out: c472nobody.out.slice(-400), post: st472nobody.postCount || 0 },
      notag: { rc: c472notag.rc, out: c472notag.out.slice(-400), post: st472notag.postCount || 0 },
      badjson: { rc: c472badjson.rc, out: c472badjson.out.slice(-400), post: st472badjson.postCount || 0 },
    },
    c473: {
      zero: { rc: c473zero.rc, out: c473zero.out.slice(-400), post: st473zero.postCount || 0 },
      write: { rc: c473write.rc, out: c473write.out.slice(-400), post: st473write.postCount || 0 },
    },
    c480: { rc: c480.rc, out: c480.out.slice(-700), err: c480.err, post: st480.postCount || 0,
      mainPushed: c480mainPushed, tagPushed: c480tagPushed,
      mainBefore: mainSha(c480Before), mainAfter: mainSha(c480After) },
  }))
}
