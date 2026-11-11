#!/usr/bin/env node
// C226：边界守卫 —— 四类禁词只允许出现在目标位置，新增散落调用一律 exit 1。
// 白名单与现状基线都写在本文件内的常量里，不从外部文件读（否则改白名单就能绕过）。
//   ALLOW_FILES = 1720 段给的目标位置（C227 搬家后的落点），按文件放行。
//   LEGACY      = 挂闸那一刻的现状命中，按「相对路径|规范行文本」放行；
//                 新增一行同禁词但文本不同 → 不命中 → 红。C227 搬家后这些行自然消失。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const ROOT = rootAt >= 0 ? resolve(args[rootAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EMIT = args.includes('--emit-legacy')
// C240：运行期往 LEGACY 里 .add() 一条时，源码里的初始化值仍是空集，抠源码文本的
// 判据会全绿，而守卫 :66 用的是被污染的运行期 Set → 直接放行。只有让守卫自己
// 在扫描结束后 dump 最终集合，判据读那个，才看得到污染。
const DUMP = args.includes('--dump-legacy')

// C239：删掉 `fs.` 前缀。按守卫自己的口径现数，带前缀的字面量在扫描面里 0 行，
// 裸调用 166 行 / 10 文件 —— 旧禁词从立起来那天起一次都没守住过任何删除调用。
// 其余三类本来就是裸的，只有这一类不一致。
const FORBIDDEN = ['rmSync(', 'process.platform', 'spawn(', 'execFileSync(']
// 每个条目旁边的注释回答「为什么这个文件必须永久豁免」，不是复述文件名。
// 这份名单按 C265 与现抽的真实调用分布双向咬合：有调用却没登记 = 守卫误报；
// 登记了却没有调用 = 预先放行未来的散落调用，等于给绕过留位置。
const ALLOW_FILES = {
  'rmSync(': [
    'index.js',                  // 宿主插件的迁移与清理收尾，删的是本插件自己的旧目录和半截迁移产物
    'lib/cache-own.mjs',         // 归属判定通过后删本插件自己的缓存条目，删除策略的唯一落点
    'lib/cache-path.mjs',        // 缓存根初始化时清掉自己刚造的临时探测目录
    'lib/config.mjs',            // 配置写坏时把坏文件留档，只删本插件刚写的临时文件
    'lib/runs.mjs',              // 历史运行记录轮转，只删本插件自己的 jsonl
    'lib/recycle.mjs',           // 三档删除策略统一落点（直删 / 回收站 / 智能档），外面不许再起一份
    'lib/source-cleanup.mjs',    // 通用 URL 下载产物「谁写谁删」，退出钩子收尾
    'scripts/fetch-deps.mjs',    // 装依赖时清自己刚下载、刚解包的临时目录
    'tools/look.mjs',            // CLI 命令收尾删本次临时目录与下载产物
    'tools/verify.mjs',          // 判据文件：每条坑造临时树再清掉，大量调用都是清理自己刚造的临时路径，不是产品删除路径
  ],
  'process.platform': [
    'lib/platform.mjs',          // 平台真值唯一读取处，其余文件一律走它的封装，不许自己摸平台
  ],
  'spawn(': [
    'lib/exec.mjs',              // 子进程调用唯一封装处，统一处理 Windows 路径、超时与错误透传
  ],
  'execFileSync(': [
    'lib/exec.mjs',              // 同步执行唯一封装处，外面不许再起第二份
  ],
}
// 守卫自身含禁词字面量（就是下面 FORBIDDEN），扫自己会自指，跳过。
const SELF = 'scripts/check-boundaries.mjs'
const EXCLUDE_DIRS = ['node_modules', '_backup', '.git', 'coverage']
// 1505 段 §三 1：dist 只认根级。写成路径前缀后，发布面内的 lib/dist/ 会被扫到，
// 而根级 dist/ 仍排除；boundaryGhostScan 读 --dump-legacy 的 excludePaths，两边同源。
const EXCLUDE_PATHS = ['tools/fixtures', 'dist']
const EXTS = /\.(mjs|js|cjs|py|mts|ts)$/
const norm = (p) => p.split(sep).join('/')

// 这份快照摄于 2026-11-11，只准缩不准长；新增的散落调用一律修掉，不许加豁免。
// key 用「相对路径|规范行文本」，不含行号，行号漂移不失配；由 --emit-legacy 用同一套
// 扫描逻辑生成后固化在这里，运行期不读外部文件。C227-E 双向咬合：
//   LEGACY 集合 == 独立现抽的存量 key 集合，既满足「非空」，又防人往里塞新豁免。
// ALLOW_FILES 仍是第一层文件级放行（C265 双向咬合验它），两者语义不同不许合并。
const LEGACY_KEYS = [
  "index.js|if (movedOld && copyVerified) { try { rmSync(bak, { recursive: true, force: true }) } catch {} }",
  "index.js|rmSync(DEPS_LOCK_FILE, { force: true })",
  "index.js|rmSync(p, { recursive: true, force: true })",
  "index.js|rmSync(tmp2, { recursive: true, force: true })",
  "index.js|try { rmSync(bak, { recursive: true, force: true }) } catch {}",
  "index.js|try { rmSync(outFile, { force: true }) } catch {}",
  "index.js|try { rmSync(tmp, { recursive: true, force: true }) } catch {}",
  "index.js|try { rmSync(tmp, { recursive: true, force: true }) } catch {} // 上次迁到一半的残留",
  "index.js|try { rmSync(tmp2, { recursive: true, force: true }) } catch {}",
  "lib/cache-own.mjs|try { rmSync(p, { recursive: true, force: true }); return null } catch (err) { return String(err?.message || err) }",
  "lib/cache-path.mjs|rmSync(probe, { force: true })",
  "lib/config.mjs|try { rmSync(tmp, { force: true }) } catch {}",
  "lib/exec.mjs|return execFileSync(bin, args, opts)",
  "lib/exec.mjs|return spawn(cmd, args, opts)",
  "lib/platform.mjs|return process.platform",
  "lib/recycle.mjs|rmSync(e.path, { recursive: true, force: true })",
  "lib/runs.mjs|try { rmSync(bak, { force: true }) } catch {}",
  "lib/source-cleanup.mjs|try { rmSync(dir, { recursive: true, force: true }) } catch {}",
  "scripts/fetch-deps.mjs|else rmSync(PART_STATE, { force: true })",
  "scripts/fetch-deps.mjs|if (cur && cur.pid === process.pid) rmSync(LOCK_FILE, { force: true })",
  "scripts/fetch-deps.mjs|if (existsSync(tmp)) rmSync(tmp, { force: true })",
  "scripts/fetch-deps.mjs|rmSync(LOCK_FILE, { force: true })",
  "scripts/fetch-deps.mjs|rmSync(gp, { force: true })",
  "scripts/fetch-deps.mjs|rmSync(left.snapshotDir, { recursive: true, force: true })",
  "scripts/fetch-deps.mjs|rmSync(out, { force: true })",
  "scripts/fetch-deps.mjs|rmSync(p, { recursive: true, force: true })",
  "scripts/fetch-deps.mjs|rmSync(tmp, { force: true })",
  "scripts/fetch-deps.mjs|rmSync(tmp, { recursive: true, force: true })",
  "scripts/fetch-deps.mjs|rmSync(tmpDir, { recursive: true, force: true })",
  "scripts/fetch-deps.mjs|rmSync(venv, { recursive: true, force: true })",
  "scripts/fetch-deps.mjs|rmSync(zip, { force: true })",
  "tools/look.mjs|if (existsSync(LOGIN_KEY_FILE)) rmSync(LOGIN_KEY_FILE, { force: true })",
  "tools/look.mjs|rmSync(tmp, { recursive: true, force: true })",
  "tools/look.mjs|try { if (existsSync(LOGIN_KEY_FILE)) rmSync(LOGIN_KEY_FILE, { force: true }) } catch {}",
  "tools/look.mjs|try { rmSync(cacheTxt, { force: true }) } catch {}",
  "tools/look.mjs|try { rmSync(join(dir, e.name), { recursive: true, force: true }) } catch {}",
  "tools/look.mjs|try { rmSync(tmp, { recursive: true, force: true }) } catch {}",
  "tools/look.mjs|try { rmSync(wav, { force: true }) } catch {}",
  "tools/verify.mjs|//     ① openSync(f,'r+') 持有写句柄后 rmSync(f)                    → 未抛",
  "tools/verify.mjs|//     ② 文件 chmod 0o444 后 rmSync(f)                              → 未抛",
  "tools/verify.mjs|//     ③ 子目录里的文件持句柄，rmSync(sub,{recursive:true})          → 未抛",
  "tools/verify.mjs|const iDel = look.indexOf('rmSync(LOGIN_KEY_FILE')",
  "tools/verify.mjs|for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }",
  "tools/verify.mjs|for (const s of [a, b]) rmSync(s.root, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(bad, { force: true })",
  "tools/verify.mjs|rmSync(box, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(cache, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(cfgDir, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(d, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(deps, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(dir, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(dir2, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(dir3, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(emptyDir, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(f)",
  "tools/verify.mjs|rmSync(home, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(homeEmpty, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(p, { force: true })   // login --poll 成功后就是这么删的",
  "tools/verify.mjs|rmSync(part)",
  "tools/verify.mjs|rmSync(shared, { force: true })",
  "tools/verify.mjs|rmSync(t, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(t0, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(tmp, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(userDir, { recursive: true, force: true })",
  "tools/verify.mjs|rmSync(work, { recursive: true, force: true })",
  "tools/verify.mjs|try { rmSync(f, { force: true }) } catch (e) { realCode = e.code }",
  "tools/verify.mjs|try { rmSync(kindDir, { recursive: true, force: true }) } catch {}",
  "tools/verify.mjs|} finally { rmSync(bad.dir, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(box, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(dir, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(empty, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(ok.dir, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(p.dir, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(p1.dir, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(p2.dir, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(r1, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(r2, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(r3, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(shadow, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(t2, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(tmp, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(tmp2, { recursive: true, force: true }) }",
  "tools/verify.mjs|} finally { rmSync(tmpPath, { force: true }) }"
]
const LEGACY = EMIT ? new Set() : new Set(LEGACY_KEYS)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = norm(relative(ROOT, abs))
    if (EXCLUDE_DIRS.includes(name) || EXCLUDE_PATHS.some((p) => rel === p || rel.startsWith(p + '/'))) continue
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) walk(abs, out)
    else if (EXTS.test(name)) out.push({ abs, rel })
  }
  return out
}

const hits = []
for (const f of walk(ROOT)) {
  if (f.rel === SELF) continue
  const lines = readFileSync(f.abs, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const token of FORBIDDEN) {
      if (!line.includes(token)) continue
      hits.push({ rel: f.rel, line: i + 1, text: line.trim(), token, key: `${f.rel}|${line.trim()}` })
    }
  })
}

if (EMIT) {
  console.log(JSON.stringify([...new Set(hits.map((h) => h.key))].sort(), null, 2))
  process.exit(0)
}

// 1505B §三 ⑧：两套计数分别与各自口径对账。产品面的非白名单命中必须是 0；
// 判据面的命中允许存在，但必须逐条进 LEGACY 且总数咬死。
const isJudge = (h) => h.rel.startsWith('tools/verify')
const face = {
  productHits: hits.filter((h) => !isJudge(h)).length,
  judgeHits: hits.filter(isJudge).length,
}
const badNow = hits.filter((h) => !ALLOW_FILES[h.token].includes(h.rel) && !LEGACY.has(h.key))
face.productBad = badNow.filter((h) => !isJudge(h)).length
face.judgeBad = badNow.filter(isJudge).length

// C240：把**运行期最终集合**原样交出去，判据只读这个，不再去源码里抠初始化表达式。
// 顺带带出另两个常量，让判据的形状前提也能核（读不到东西时不许把「空」当通过）。
if (DUMP) {
  // C317：把扫面口径与命中总数一并自报，判据拿守卫自己的真值做独立现抽，
  // 不许另抄一份 EXCLUDE/EXTS 常量（抄的那份会随守卫改动悄悄脱节）。
  console.log(JSON.stringify({
    legacy: [...LEGACY], forbidden: FORBIDDEN, allowFiles: ALLOW_FILES,
    excludeDirs: EXCLUDE_DIRS, excludePaths: EXCLUDE_PATHS, exts: EXTS.source,
    self: SELF, hits: hits.length,
    productHits: face.productHits, judgeHits: face.judgeHits,
    productBad: face.productBad, judgeBad: face.judgeBad,
  }))
  process.exit(0)
}

const bad = hits.filter((h) => !ALLOW_FILES[h.token].includes(h.rel) && !LEGACY.has(h.key))
if (bad.length) {
  console.error(`边界守卫：${bad.length} 处禁词出现在白名单之外（共扫 ${hits.length} 处命中）`)
  for (const h of bad) console.error(`  ${h.rel}:${h.line}  [${h.token}]  ${h.text.slice(0, 160)}`)
  process.exit(1)
}
console.log(`边界守卫：通过（扫 ${hits.length} 处禁词命中，全部在白名单或现状基线内；产品面 ${face.productHits} 处 / 判据面 ${face.judgeHits} 处）`)
