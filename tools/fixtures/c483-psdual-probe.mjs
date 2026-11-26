/**
 * c483-psdual-probe.mjs —— B 件 PS5.1/pwsh7 双跑取证（2026-11-25，1516 派单 B 件）
 * 本地 bare 远端 + 自起假 API + 「本地还没有标签」正常场景。
 * 复用 c454-resume-probe.mjs 的 --server 模式当假 Release API（不连真实 GitHub/registry）。
 * 两种 exe 各跑一次真 release.ps1 -ResumeGit 入口。stdout 吐 PS_DUAL_JSON=...
 */
import { spawnSync, spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const FIXTURE = join(HERE, 'c454-resume-probe.mjs')
const REL = join(ROOT, 'scripts', 'release.ps1')
const PS51 = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
// pwsh7 从 LOCALAPPDATA 运行时拼，源码里绝不写本机用户名字面量——
//   sync-release.ps1 的脱敏闸会扫 USERNAME 硬规则，写死本机路径会在发版复制前把整条发布链堵死。
const PS7 = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe')

const tmp = mkdtempSync(join(tmpdir(), 'psdual-'))
const emptyCfg = join(tmp, 'empty.gitconfig'); writeFileSync(emptyCfg, '')
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_SYSTEM: emptyCfg,
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
const git = (args, cwd) => spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 30000 })

const setup = (name) => {
  const repo = join(tmp, name), bare = join(tmp, name + '.git'); mkdirSync(repo)
  git(['init', '-q', '-b', 'main', repo])
  git(['config', 'user.email', 'dual@example.com'], repo); git(['config', 'user.name', 'dual'], repo)
  git(['init', '-q', '--bare', bare]); git(['remote', 'add', 'origin', bare], repo)
  writeFileSync(join(repo, 'a.txt'), 'first\n')
  git(['add', '-A'], repo); git(['commit', '-q', '-m', 'first'], repo)
  git(['push', '-q', '-u', 'origin', 'main'], repo)
  return { repo, bare }
}

const probePort = net.createServer()
const port = await new Promise((r) => probePort.listen(0, '127.0.0.1', () => { const p = probePort.address().port; probePort.close(() => r(p)) }))
const stateFile = join(tmp, 'state.json')
writeFileSync(stateFile, JSON.stringify({ postCount: 0, release: null }), 'utf8')
const server = spawn(process.execPath, [FIXTURE, '--server', String(port), stateFile], { stdio: ['ignore', 'pipe', 'pipe'] })
let ready = false
server.stdout.on('data', (d) => { if (String(d).includes('READY')) ready = true })
let serr = ''; server.stderr.on('data', (d) => { serr += String(d) })
const t0 = Date.now()
while (!ready && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50))
if (!ready) { console.log('PS_DUAL_JSON=' + JSON.stringify({ fatal: 'server not ready', serr })); process.exit(0) }

const source = join(tmp, 'source'); mkdirSync(source)
writeFileSync(join(source, 'package.json'), '{"name":"dual","version":"0.4.16"}\n')
const apiBase = `http://127.0.0.1:${port}`
const runOne = (exe, name) => {
  const { repo } = setup(name)
  const body = join(tmp, name + '-body.md'); writeFileSync(body, 'dual run body\n', 'utf8')
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REL,
    '-Source', source, '-Release', repo, '-ResumeGit', '-ReleaseApiBase', apiBase,
    '-ResumeBodyFile', body, '-ResumeTimeoutSec', '20']
  const r = spawnSync(exe, args, { cwd: repo, env: gitEnv, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  const ls = git(['ls-remote', 'origin'], repo)
  return {
    exe: name,
    rc: r.status,
    outTail: out.split('\n').filter(Boolean).slice(-6).join(' | '),
    reachedRemote: /远端：/.test(out),
    reachedTagStage: /标签/.test(out),
    crashed: /CommandNotFoundException|NativeCommandError|无法绑定参数|参数找不到|ambiguous argument/.test(out),
    tagOnRemote: /refs\/tags\/v0.4.16/.test(ls.stdout || ''),
    done: /已确认完成/.test(out),
  }
}

try {
  const result = {
    ps51: runOne(PS51, 'repo51'),
    ps7: runOne(PS7, 'repo7'),
    state: JSON.parse(readFileSync(stateFile, 'utf8')),
  }
  console.log('PS_DUAL_JSON=' + JSON.stringify(result))
} catch (e) {
  console.log('PS_DUAL_JSON=' + JSON.stringify({ fatal: String(e?.stack || e).slice(0, 1200) }))
} finally {
  try { server.kill('SIGTERM') } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
