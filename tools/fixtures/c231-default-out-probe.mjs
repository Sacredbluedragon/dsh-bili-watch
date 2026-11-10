// C231 / A3 默认输出目录取证夹具：stdout 只吐 JSON。
// ① 真 CLI 跑 sheet --dry-run（离线、不抽帧、不写盘），四组配置形态验落点；
// ② 真 lib 纯函数直接调用，交叉核优先级与零回归；
// ③ 静态接线由判据核（这里只给源码字符串）。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pictureOutPath, textOutPath, defaultOutValue } from '../../lib/default-out.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const LOOK = join(ROOT, 'tools', 'look.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'c231-'))
const cache = join(tmp, 'cache')
const deps = join(tmp, 'deps')
const cfgDir = join(tmp, 'cfgout')
const envDir = join(tmp, 'envout')
mkdirSync(deps, { recursive: true })

const BV = 'BV19dJQ6sE9F'
const FILE = `${BV}-p1-3x3.jpg`
// 第三行计划：「[dry-run] 将拼成：… → 输出 <path>；格位索引将写 …」
const outPathOf = (stdout) => {
  const m = /→ 输出 (.+?)(?:；|\r?\n|$)/.exec(String(stdout || ''))
  return m ? m[1].trim() : ''
}

function runCli({ depsCfg = null, envOut = '', explicit = '' } = {}) {
  writeFileSync(join(deps, 'deps-config.json'), JSON.stringify(depsCfg || {}) + '\n', 'utf8')
  const env = {
    ...process.env,
    BILI_WATCH_CACHE: cache,
    BILI_WATCH_DEPS: deps,
    DSH_HOME: join(tmp, 'home'),
  }
  if (envOut) env.BILI_WATCH_OUT = envOut
  else delete env.BILI_WATCH_OUT
  const args = [LOOK, 'sheet', BV, '--dry-run', '--dur', '60', '--grid', '3x3']
  if (explicit) args.push('--out', explicit)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 })
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), path: outPathOf(r.stdout) }
}

const result = { cli: {}, pure: {}, stat: {} }
try {
  const explicitPath = join(tmp, 'explicit.jpg')
  result.cli.noCfg = runCli()
  result.cli.cfg = runCli({ depsCfg: { defaultOut: cfgDir } })
  result.cli.envOut = runCli({ depsCfg: {}, envOut: envDir })
  result.cli.explicit = runCli({ depsCfg: { defaultOut: cfgDir }, envOut: envDir, explicit: explicitPath })
  result.cli.blank = runCli({ depsCfg: { defaultOut: '   ' }, envOut: '' })

  // 真 lib 纯函数：期望值全部写死，不拿被测函数自己的读表结果当答案。
  const base = { filename: FILE, cacheDir: cache }
  result.pure = {
    plain: pictureOutPath({ ...base, cfg: {}, env: {} }),
    legacy: join(cache, 'sheets', FILE),
    cfg: pictureOutPath({ ...base, cfg: { defaultOut: cfgDir }, env: {} }),
    env: pictureOutPath({ ...base, cfg: {}, env: { BILI_WATCH_OUT: envDir } }),
    explicitWins: pictureOutPath({ ...base, cfg: { defaultOut: cfgDir }, env: { BILI_WATCH_OUT: envDir }, explicitOut: explicitPath }),
    blank: defaultOutValue({ defaultOut: '   ' }, {}),
    textPlain: textOutPath({ cfg: {}, env: {}, filename: 'x-ocr.txt' }),
    textCfg: textOutPath({ cfg: { defaultOut: cfgDir }, env: {}, filename: 'x-ocr.txt' }),
    textExplicit: textOutPath({ cfg: { defaultOut: cfgDir }, env: {}, filename: 'x-ocr.txt', explicitOut: explicitPath }),
  }

  // 静态接线由判据自己读源码，夹具只给可比对的路径常量（Windows 反斜杠归一）。
  result.stat = { cfgDir, envDir, explicitPath, cache, file: FILE }
  for (const k of ['cfgDir', 'envDir', 'explicitPath', 'cache']) result.stat[k] = result.stat[k].replace(/\\/g, '/')
} catch (e) {
  result.error = String(e?.stack || e?.message || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(result, null, 2))
