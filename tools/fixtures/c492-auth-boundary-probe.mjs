/**
 * A 件 F-2：认证边界四格矩阵 + Test-IsOfficialGhApi 判定 + 取凭据条件 + 重定向实测。
 * - 抠 release.ps1 的 Test-IsOfficialGhApi / Invoke-GhApi / Get-GhToken / Say 原样函数体，
 *   以及 Invoke-Resume 里那条「条件取凭据」if 语句原样（不手写等价行，避免检查面与被检查面分叉）。
 * - mock Invoke-WebRequest：不真发网络，只记有无 Authorization 头。
 * - mock git：credential fill 记调用次数，返回合成假 token（绝不读真凭据）。
 * - 四格：PS5.1/pwsh7 × 官方源/自定义源 → 头有无 + 提供器调用次数。
 * - 防御格：强塞非空 token 给自定义源/非默认端口，Invoke-GhApi 仍必须不挂头。
 * - 判定函数对 6 种 URL 的布尔值。
 * - 跨端口重定向：A 收头、B 收头（验 PowerShell 自带剥离）。
 */
import { spawnSync, spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const REL = join(ROOT, 'scripts', 'release.ps1').replace(/\//g, '\\')
const PS51 = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const PS7 = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
const q = (v) => String(v).replace(/'/g, "''")
const gdk = new TextDecoder('gbk')
const dec = (b) => gdk.decode(Buffer.concat([b || Buffer.alloc(0)]))

const tmp = mkdtempSync(join(tmpdir(), 'c492-'))
const hdrFile = join(tmp, 'header.txt')
const cnt = join(tmp, 'count')
const cntPath = q(cnt.replace(/\//g, '\\'))
const hdrPath = q(hdrFile.replace(/\//g, '\\'))

const common = () => [
  '$ErrorActionPreference="Continue"',
  '$tokens=$null;$errs=$null',
  `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${q(REL)}',[ref]$tokens,[ref]$errs)`,
  'if($errs.Count){throw ("parse: "+$errs[0].Message)}',
  '$names=@("Test-IsOfficialGhApi","Invoke-GhApi","Get-GhToken","Say")',
  '$fns=@($ast.FindAll({param($x)($x -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($names -contains $x.Name)},$true))',
  'foreach($f in $fns){Invoke-Expression $f.Extent.Text}',
  // 从 Invoke-Resume 函数体抠出「条件取凭据」那条 if 语句原样
  '$resumeFn=@($ast.FindAll({param($x)($x -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and $x.Name -eq "Invoke-Resume"},$true))[0]',
  'if(-not $resumeFn){throw "Invoke-Resume not found"}',
  '$tokIf=@($resumeFn.Body.FindAll({param($x)($x -is [System.Management.Automation.Language.IfStatementAst]) -and $x.Extent.Text -match "Get-GhToken"},$true))[0]',
  'if(-not $tokIf){throw "token if stmt not found"}',
  '$tokenStmt=$tokIf.Extent.Text',
  `function Invoke-WebRequest { param([string]$Method,$Uri,$Headers,$Body,$UseBasicParsing,$TimeoutSec,$ContentType,$MaximumRedirection) $hd=$Headers; $h=if($hd -and $hd.ContainsKey('Authorization')){'PRESENT'}else{'none'}; Set-Content -LiteralPath '${hdrPath}' -Value $h -Encoding ascii; return @{StatusCode=200;Content='{}'} }`,
  `function git { param([Parameter(ValueFromRemainingArguments=$true)]$a) if($a -contains 'fill'){ $n=[int](Get-Content -LiteralPath '${cntPath}'); Set-Content -LiteralPath '${cntPath}' -Value ($n+1); Write-Output 'username=fake'; Write-Output 'password=FAKE_TOKEN_12345' } }`,
].join('\n')

function grid(exe, url, mode) {
  writeFileSync(cnt, '0'); writeFileSync(hdrFile, '')
  const tokenLine = mode === 'forced'
    ? "$token='FAKE_FORCED_TOKEN'"
    : '$token=\'\'; Invoke-Expression $tokenStmt'
  const ps = common() + '\n' + [
    `$api='${q(url)}'`,
    tokenLine,
    `$r=Invoke-GhApi 'GET' '${q(url)}' '' $token`,
    'if(-not $r.ok){throw "api fail"}',
  ].join('\n')
  const r = spawnSync(exe, ['-NoProfile', '-Command', ps], { encoding: 'buffer', timeout: 30000 })
  let hdr = ''
  try { hdr = readFileSync(hdrFile, 'utf8').trim() } catch {}
  const calls = parseInt(readFileSync(cnt, 'utf8').trim(), 10) || 0
  return { rc: r.status, header: hdr || 'NONE', credCalls: calls, err: r.status === 0 ? '' : dec(r.stderr).slice(-160) }
}
function judge(exe) {
  const ps = common() + '\n' +
    "@('https://api.github.com/x','https://API.GitHub.com/x','https://api.github.com:8443/x','http://api.github.com/x','https://api.github.com.evil.com/x','http://127.0.0.1:45999/x') | %{ \"$_=>$(Test-IsOfficialGhApi $_)\" }"
  const r = spawnSync(exe, ['-NoProfile', '-Command', ps], { encoding: 'buffer', timeout: 30000 })
  return dec(r.stdout).split(/\r?\n/).map(x => x.trim()).filter(Boolean)
}

// 重定向实测（独立 server 子进程）
const pA = 46201, pB = 46202
const rstate = join(tmp, 'rstate.json')
writeFileSync(rstate, JSON.stringify({ A: [], B: [] }))
const srv = `
const http=require('http'),fs=require('fs');const st=${JSON.stringify(rstate)};
function rec(k,q){let s=JSON.parse(fs.readFileSync(st,'utf8'));s[k].push(q.headers['authorization']?'PRESENT':'none');fs.writeFileSync(st,JSON.stringify(s))}
http.createServer((q,r)=>{rec('A',q);r.writeHead(302,{Location:'http://127.0.0.1:${pB}/t'});r.end()}).listen(${pA},'127.0.0.1',()=>{
http.createServer((q,r)=>{rec('B',q);r.writeHead(200,{'Content-Type':'application/json'});r.end('{}')}).listen(${pB},'127.0.0.1',()=>fs.writeFileSync(st+'.ok','1'))});
`
const server = spawn(process.execPath, ['-e', srv], { stdio: 'ignore' })
for (let i=0;i<100;i++){try{if(readFileSync(rstate+'.ok','utf8')==='1')break}catch{}spawnSync(process.execPath,['-e','setTimeout(()=>{},20)'])}
function redir(exe) {
  writeFileSync(rstate, JSON.stringify({ A: [], B: [] }))
  const ps = `Invoke-WebRequest -Uri 'http://127.0.0.1:${pA}/x' -Headers @{Authorization='Bearer FAKE_TOKEN'} -UseBasicParsing | Out-Null`
  const r = spawnSync(exe, ['-NoProfile', '-Command', ps], { encoding: 'buffer', timeout: 30000 })
  const s = JSON.parse(readFileSync(rstate, 'utf8'))
  return { rc: r.status, A: s.A[0]||'NONE', B: s.B[0]||'NONE' }
}

const out = {}
for (const [k,exe] of [['ps51',PS51],['ps7',PS7]]) {
  out[k] = {
    judge: judge(exe),
    official: grid(exe, 'https://api.github.com/repos/o/r/releases/tags/v1', 'real'),
    custom: grid(exe, 'http://127.0.0.1:45999/repos/o/r/releases/tags/v1', 'real'),        // 真实路径：不取凭据
    customForced: grid(exe, 'http://127.0.0.1:45999/repos/o/r/releases/tags/v1', 'forced'), // 防御：强塞 token 也不挂头
    nonDefaultPort: grid(exe, 'https://api.github.com:8443/repos/o/r/releases/tags/v1', 'forced'),
    redir: redir(exe),
  }
}
try { process.kill(server.pid) } catch {}
try { rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log('AUTH_JSON=' + JSON.stringify(out))
