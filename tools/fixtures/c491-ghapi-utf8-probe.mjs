/**
 * C491：Invoke-GhApi 中文 body 在 PS5.1 必须按 UTF-8 字节发出（F-1 回归）。
 * 假 API 起独立子进程记录 POST body hex；PS5.1 与 pwsh7 各发一次中文正文，
 * 都必须是定稿文本的 UTF-8 字节，不能是 ISO-8859-1 的问号（3f）。
 * 抠 release.ps1 的 Invoke-GhApi 原样函数体执行，真正验产品代码。
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
const TEXT = '复核定稿正文'
const EXPECT = Buffer.from(TEXT, 'utf8').toString('hex')

const tmp = mkdtempSync(join(tmpdir(), 'c491-'))
const state = join(tmp, 'state.json')
writeFileSync(state, JSON.stringify({ hex: '' }))
const serverScript = `
const http=require('http'),fs=require('fs');
const state=${JSON.stringify(state)};
const s=http.createServer((req,res)=>{
  let b=[];req.on('data',d=>b.push(d));req.on('end',()=>{
    fs.writeFileSync(state,JSON.stringify({hex:Buffer.concat(b).toString('hex')}));
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');
  });
});
s.listen(0,'127.0.0.1',()=>{fs.writeFileSync(state+'.port',String(s.address().port))});
`
const server = spawn(process.execPath, ['-e', serverScript], { stdio: 'ignore' })
let port = null
for (let i = 0; i < 100; i++) {
  try { port = readFileSync(state + '.port', 'utf8').trim(); if (port) break } catch {}
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)'])
}
if (!port) { console.log('C491_JSON=' + JSON.stringify({ fatal: 'server 没起来' })); process.exit(0) }

const q = (v) => String(v).replace(/'/g, "''")
const probe = [
  '$ErrorActionPreference = "Continue"',
  '$tokens=$null;$e=$null',
  `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${q(REL)}',[ref]$tokens,[ref]$e)`,
  'if($e.Count -gt 0){ throw ("parse: " + $e[0].Message) }',
  '$fn=@($ast.FindAll({param($x) ($x -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($x.Name -eq "Invoke-GhApi")},$true)); if($fn.Count -ne 1){throw ("fn count="+$fn.Count)}',
  'Invoke-Expression $fn[0].Extent.Text',
  `$body='${q(TEXT)}'`,
  `$r=Invoke-GhApi 'POST' 'http://127.0.0.1:${port}/r' $body ''`,
  'if(-not $r.ok){ throw ("Invoke-GhApi 失败: " + $r.raw) }',
]
const psScript = probe.join('\n')
function send(exe, tag) {
  writeFileSync(state, JSON.stringify({ hex: '' }))
  const r = spawnSync(exe, ['-NoProfile', '-Command', psScript], { encoding: 'buffer', timeout: 40000 })
  let hex = ''
  try { hex = JSON.parse(readFileSync(state, 'utf8')).hex } catch {}
  const gdk = new TextDecoder('gbk')
  const err = gdk.decode(Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]))
  return { tag, rc: r.status, hex, ok: hex === EXPECT, err: hex === EXPECT ? '' : err.slice(-300) }
}
const out = { expect: EXPECT, text: TEXT, ps51: send(PS51, 'ps51'), ps7: send(PS7, 'ps7') }
try { process.kill(server.pid) } catch {}
try { rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log('C491_JSON=' + JSON.stringify(out))
