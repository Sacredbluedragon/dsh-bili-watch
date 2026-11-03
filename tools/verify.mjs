/**
 * 发布前守卫：把「已经踩过一次的坑」变成可执行断言。
 *
 * 由来（2026-10-26 审查 T12）：0.2.23 的两个修复（.tool.txt 后缀隔离、--format json 的
 * 数据模式短路）没有任何自动化守卫，改一下就可能悄悄退回去。这个文件只做一件事：
 * 每条坑一条断言，跑完打印 PASS/FAIL，有 FAIL 就 exit 1。
 *
 * 用法：node tools/verify.mjs
 * 不进 npm 包（files 里只留 tools/look.mjs，见 package.json）。
 */
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync, copyFileSync, openSync, closeSync, statSync, symlinkSync, chmodSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// C97（2026-11-01 0.4.1 第 2 条）：client.js 是给宿主加载的浏览器脚本，要验它「宿主太老时抛不抛」，
//   只能在假 window 里真求值——用 vm 而不是 new Function，才与宿主的脚本执行语义一致。
import vm from 'node:vm'
// 2026-10-31：被测函数搬进 lib/ 之后，断言可以直接 import 真跑——
//   不必再「读整份源码 → 正则抠函数体 → new Function 重编译」三件套。
//   这不是「放松」：原来的 C7/C25 是「比两处函数体是否相等」，只证明两边写得一样，不证明写得对；
//   现在是喂对抗输入看输出。函数被改坏时，旧断言只会在「两处不同步」时红，新断言会在「行为错了」时红。
import { cleanKey, bvOf } from '../lib/keys.mjs'
// 2026-10-31：锁判据与「目录能不能认领」搬进 lib/ 之后，C6/C23 也改成 import 真跑。
import { hasAnyLock, isAdoptableDir, lockExpired, pidAlive, readLock } from '../lib/locks.mjs'
import { isOwnBvDir, isOwnedEntry, isOurCacheRoot, removeOwned } from '../lib/cache-own.mjs'
// 2026-10-31：调优表 / 钳制 / TTL 换算只剩 lib/tuning.mjs 一份，断言直接 import 真跑。
import { lockTtlMsOf, normalizeTuning } from '../lib/tuning.mjs'
// 2026-10-31：runs.jsonl 的轮转 + 追加搬进 lib/runs.mjs，这里真跑四种现场。
import { appendJsonLine } from '../lib/runs.mjs'
// 2026-10-31：坏配置留档 + 回默认值的行为只剩 lib/config.mjs 一份，C38 直接 import 真跑。
import { readJsonOrBackup } from '../lib/config.mjs'
// 2026-10-31：缓存根的状态搬进 lib/cache-path.mjs。这里只 import 两个**无状态**的动作
//   （路径推导 / 落盘探测）真跑；有状态的那半（initCachePath / cacheDir）必须另起进程验——
//   本进程一旦 init 过，C65 的「未初始化必抛」就永远绿不起来了。
import { pickCacheDir, resolveCacheDir } from '../lib/cache-path.mjs'
// 2026-10-31：凭证的位置 / 四字段判据 / 旧路径迁移只剩 lib/cred.mjs 一份，C16 直接 import 真跑。
import { adoptLegacyCred, credPaths, missingCredFields, readCred } from '../lib/cred.mjs'
import { claimRoute, releaseRoute, claimedPaths } from '../lib/route-claim.mjs'
import { checkOutDir } from './cli-io.mjs'
// 2026-10-31 第一步：media 的两个原语搬进 lib/media.mjs，C81/C82 直接 import 真跑。
// 四个纯判据（parseAtTimes / atDirTag / framesCacheHit / autoStep）与
//   downloadTo / cachedMp4 / sceneTimes / pickEvenly 也搬过去了，于是 C44/C47 从
//   「读 look.mjs → 正则抠函数体 → new Function 重编译」改成直接 import 真跑。
import {
  atDirTag, autoStep, cachedMp4, downloadTo, ffExec, findFfmpeg,
  framesCacheHit, parseAtTimes, pickEvenly, sceneTimes,
} from '../lib/media.mjs'
// 2026-10-31：cache 层（目录 / manifest / 等他人）搬进 lib/frames.mjs；
//   抢锁放锁搬进 lib/locks.mjs 的 makeLocks。C47/C87/C88 直接 import 真跑。
import { ensureDir, frameFilesToKeep, framesDirName, listJpgs, readManifest, shotsDirName, waitManifest, writeManifest } from '../lib/frames.mjs'
import { makeLocks } from '../lib/locks.mjs'
// 2026-10-31 三审：C90 的三条守卫需要 logRun与缓存根推导的真跑。
import { logRun } from '../lib/runs.mjs'
import { defaultCacheRoot } from '../lib/cache-path.mjs'
// 2026-11-01（P0-3）：must 也跟着 makeChecker 搬进 check-run.mjs。
//   它是 700 多处断言的失败信号，却原来只是本文件的局部常量——外面碰不到，也就没有一条断言验过它。
//   C77 现在 import 同一个绑定，直接喂 false 验「必须抛」。**别在这里再写一份**（那就又成了「验的不是用的」）。
import { makeChecker, must } from './check-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/**
 * 2026-11-02：`look.mjs` 认不认某个 flag —— **真跑**，不读源码。
 *
 * 原来 C9 / C42 / C44 是「读 look.mjs，找 `const KNOWN_FLAGS = new Set([...])` 里有没有这个词」。
 * 第二步把 KNOWN_FLAGS 改成从 lib/params.mjs 生成，那三处同时红 —— 不是代码坏了，
 * 是判据在验「字面量长什么样」而不是「运行时认不认」。
 *
 * 改成真跑之后判据更强：谁把 KNOWN_FLAGS 打空、或者生成链断了，这里立刻红；
 * 而它不再关心源码怎么写。用 `help` 命令是因为它只打 HELP、不做任何实际工作。
 */
function flagAccepted(flag, val) {
  const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'help', `--${flag}`, ...(val ? [val] : [])], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  })
  const err = r.stderr || ''
  return { ok: !/未知参数/.test(err), status: r.status, err }
}

const results = []
// 2026-10-31：执行器搬进 tools/check-run.mjs，就为了让它**自己可被断言**——
//   它是「所有断言是否真跑」的唯一开关，原来却是唯一没有断言的代码。C77 直接 import 它喂 async 回调。
const check = makeChecker(results)
// must 从 ./check-run.mjs import（2026-11-01 P0-3）。它原来就在这一行，是文件局部常量。
// 依赖网络的断言默认跳过：网络抖动不该让守卫变红（静态断言永远可跑）。VERIFY_ONLINE=1 才联网验。
// C1（2026-10-27）：skip 以前记成 ok:true——汇总把跳过当通过，「8/8 通过」是虚的。
//   现在记成 ok:false + skip:true，汇总时单独数跳过，不再混进通过数，也不算失败。
const skip = (name, why) => results.push({ name, ok: false, skip: true, detail: why })
const online = process.env.VERIFY_ONLINE === "1"

// —— 静态断言 ——
check('版本号不是 0.2.22（P0：sync-release 会把新版覆盖成旧版）', () => {
  const v = JSON.parse(read('package.json')).version
  must(v !== '0.2.22', `package.json version=${v}`)
  return v
})

check('lib/cache-path.mjs 的 videoDir 复用「BV_标题」目录（P0：同一视频两个兄弟目录）', () => {
  // 2026-10-31：videoDir 搬进 lib/cache-path.mjs（它读缓存根，而缓存根住在那边），
  //   原来这条盯的是 index.js——现在盯那份唯一实现。
  const t = read('lib/cache-path.mjs')
  must(t.includes("d.startsWith(base + '_')"), 'videoDir 没有复用逻辑')
  return 'ok'
})

check('index.js 的失败兜底带退出码（P0：别把错误抹成「没有输出」）', () => {
  const t = read('index.js')
  must(!t.includes("|| '（没有输出）'"), '旧的「（没有输出）」还在')
  must(t.includes('退出码'), '兜底文案没带退出码')
  return 'ok'
})

check('工具层落盘用 .tool.txt 后缀（P0：别覆盖 CLI 落的全文）', () => {
  const t = read('index.js')
  must(t.includes('`${name}.tool.txt`'), '找不到 .tool.txt')
  return 'ok'
})

check('数据模式短路还在（P0：--format json 不许被提示污染）', () => {
  const t = read('tools/look.mjs')
  must(t.includes('opts.dataOnly'), 'printText 里没有 dataOnly 分支')
  return 'ok'
})

// —— 阶段 B（2026-10-28）新增断言 ——
// 派单要求「新增的行为自己补断言（可以加，不许改已有的断言让它过）」。
// 以下四条对应副本 B 第 1 轮修的三处（W-14 / W-04 / W-07）+ 一条跨文件一致性守卫。
// 为什么不全真跑：writeMeta / autoCleanCache 都不导出，真跑要宿主或联网；
//   但它们的关键是「守卫挡在读写之前」这个顺序，结构断言正好能钉住顺序——改成顺序错也会红。

// 取某个顶层函数的函数体：从 `function NAME(` 到行首第一个 `}`（嵌套块都带缩进，不会误判）
//
// 2026-10-31：**取到了不等于取对了**。这个函数有两个洞，都会返回一段
//   「看起来像函数、其实是垃圾」的片段，而下游全是字符串断言（indexOf / 正则 / 哈希），
//   拿到垃圾照样跑完，红和绿都不代表真事：
//   ① `indexOf('function NAME(')` 会命中**注释里**的同名声明。实测在 index.js 第 10 行插
//      `// 早期版本这里是 function cleanKey( 的实现`，取到 1223 字符（正常 493），
//      从 `function cleanKey( 的实现` 一路切到下一个行首 `}`。
//   ② `search(/\n\}/)` 认「换行 + }」，函数体内模板字符串里有一行以 `}` 开头就会提前截断。
//   所以加一道编译自检：**抽出来必须是一个能解析的函数**。失败时直接说「抽错了」，
//   而不是让调用方的断言报「两处不一致」——那是红在对的断言之外，等于没验。
//   包装成表达式（`return ( ... )`）而不是声明：片段自带 `function NAME(...)`，
//   前面补 `async` 是为了片段里有 `await` 时不误报（`async function` 被 indexOf 命中时
//   只从 `function` 起切，`async` 关键字是丢掉的）。
const fnBody = (src, name) => {
  // 2026-11-01（0.4.1 第 7 条）：原来用 `src.indexOf('function ' + name + '(')`——
  //   ① 认不出 `export function name(`（lib/ 下全是这个形状，抽不到就报「找不到函数」）；
  //   ② 会命中**注释里**的同名声明（改成按行首匹配，注释行前面是 `//` 或 ` *`，匹配不上）。
  //   两条都只改「怎么找」，找到之后仍然从 `function` 起切 —— 返回值形状不变，
  //   下游 compile() 拿到的还是能直接包进 `new Function` 的片段（export 前缀必须丢掉）。
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`)
  const m = re.exec(src)
  must(m, `找不到 function ${name}`)
  const i = m.index + m[0].indexOf('function')
  const j = src.indexOf('\n}', i)
  must(j > i, `${name} 的函数体没有行首闭合括号`)
  const body = src.slice(i, j + 2)
  const isAsync = /async\s$/.test(src.slice(Math.max(0, i - 20), i))
  try {
    new Function(`return (${isAsync ? 'async ' : ''}${body})`)
  } catch (e) {
    must(
      false,
      `${name} 抽出来的不是合法函数体（多半是命中了注释里的同名声明，或函数体内有以 } 开头的行）：` +
        `${e.message}；片段开头 ${JSON.stringify(body.slice(0, 60))}（共 ${body.length} 字符）`,
    )
  }
  return body
}

// #20（2026-10-30，P1）：守卫自己的口径必须统一。原来 C6/C7 比「函数体原文」——只改一行注释
//   就假红，逼得人把注释删掉才能过；而 C17 早就剥注释再比。同一套守卫里两种尺子，
//   结果就是「无害改注释会假红，真分叉不会红」。
//   现在统一走这一个 normalize：去行注释 + 压空白。
//   只认「行首或空白后」的 `//`——`'https://x'`、`/^https?:\/\//` 里的不会被误当注释切掉。
const stripComments = (s) =>
  s
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n')
    .replace(/\s+/g, '')

// DB 10-28 独立审核抓到的真问题：只查字符串的断言没有牙——把守卫条件拆成 `if (false && ...)`，
//   C5 照样 PASS。所以这里把源码里的顶层函数**取出来真跑**：塞进隔离的 Function，喂参数、看返回值。
//   prelude 用来带出函数依赖的模块级常量（如 LOOPBACK 那个 Set）。
const compile = (src, names, { prelude = '', params = [], args = [] } = {}) => {
  const body = `${prelude}\n${names.map((n) => fnBody(src, n)).join('\n')}\nreturn { ${names.join(', ')} }`
  return new Function(...params, body)(...args)
}

// 2026-11-01（T38-8）：这条守卫原来**永远绿**，判据取错了位置。
//   原写法：`t.indexOf('await tryLock(dir)')` 取的是**全文首处** —— 落在 look.mjs 的
//   peekFrames 里；而要比对的 fresh 清理块属于 grabFrames（它自己的 tryLock 在更后面）。
//   两个下标来自**不同函数**，大小关系跟「grabFrames 内顺序」完全无关。
//   实测扰动：把 fresh 块挪到 grabFrames 的 tryLock **之前**（真·锁外删除），断言照样 PASS。
//   现在改成：先把 grabFrames 的函数体抠出来（fnBody，注释里已说明它会编译自检），
//   再在**这一段内部**比下标 —— 段内三处标记各自唯一（tryLock / 守卫 / fresh 块）。
//   判据还多钉一层：fresh 块必须在 try{ 之后、unlock 之前 —— 只比「锁在前」不够，
//   万一有人把整段挪到 unlock 之后（锁已放），下标依然满足 iFresh > iLock。
const grabFramesLockOrder = (src) => {
  const body = fnBody(src, 'grabFrames')
  const iLock = body.indexOf('await tryLock(dir)')
  const iGuard = body.indexOf('if (!lock)')
  const iFresh = body.indexOf('if (fresh && !outDir) {')
  const iTry = body.indexOf('try {')
  const iUnlock = body.indexOf('unlock(lock)')
  return { body, iLock, iGuard, iFresh, iTry, iUnlock }
}

check('--fresh 的删除在 tryLock 之后（P0：锁外删会删掉别人的 .lock）', () => {
  const t = read('tools/look.mjs')
  const { body, iLock, iGuard, iFresh, iTry, iUnlock } = grabFramesLockOrder(t)
  must(iLock >= 0, 'grabFrames 里找不到 tryLock')
  must(iGuard > iLock, 'grabFrames 里「没抢到锁」的守卫不在抢锁之后')
  must(iFresh > iGuard, 'fresh 清理出现在「没抢到锁就抛」的守卫之前 —— 没锁住也会删')
  must(iFresh > iTry, 'fresh 清理不在 try{} 块里 —— 不受 finally 保护')
  must(iUnlock > iFresh, 'fresh 清理出现在 unlock 之后 —— 锁已经放了还在删')
  must(!t.includes('if (fresh && !outDir && existsSync(dir)) rmSync'), '锁外那份 rmSync 还在')
  return `lock@${iLock} < guard@${iGuard} < try@${iTry} < fresh@${iFresh} < unlock@${iUnlock}`
})

check('C113 T38-8 守卫的判据有牙：把 fresh 块挪到 tryLock 之前必须被它抓住', () => {
  // 这条是上面那条守卫的自检 —— 原守卫之所以「永远绿」，就是没人验证过它还能不能红。
  // 手法：拿真源码**改坏**（把 fresh 清理块整块挪到 grabFrames 的 `await tryLock(dir)` 之前
  // = 真·锁外删除，别人正在用这个目录时我们照样把它清空），
  // 再喂给同一个判定函数，必须报「不成立」。这样它才是一把有牙的尺子，而不是一句空话。
  const src = read('tools/look.mjs')
  const { body, iFresh } = grabFramesLockOrder(src)
  must(iFresh >= 0, '拿不到 fresh 清理块的位置')
  // fresh 块的范围：从 `if (fresh && !outDir) {` 到那个 for 循环闭合的 `    }`
  const iFreshEnd = body.indexOf('\n    }', iFresh) + '\n    }'.length
  must(iFreshEnd > iFresh, 'fresh 块的结束位置找不到')
  const freshBlock = body.slice(iFresh, iFreshEnd)
  // 把整块摘出来，插到 `const lock = await tryLock(dir)` 那一行之前
  const without = body.slice(0, iFresh) + body.slice(iFreshEnd)
  const iLockLine = without.indexOf('const lock = await tryLock(dir)')
  must(iLockLine >= 0, '拿不到 tryLock 那一行')
  const iIns = without.lastIndexOf('\n', iLockLine) + 1
  const broken = without.slice(0, iIns) + freshBlock + '\n' + without.slice(iIns)
  // 判定：改坏之后 fresh 必须落在 tryLock 之前 —— 这才是「锁外删」
  const iLockBroken = broken.indexOf('await tryLock(dir)')
  const iFreshBroken = broken.indexOf('if (fresh && !outDir) {')
  must(iLockBroken >= 0 && iFreshBroken >= 0, '改坏后的片段里找不到关键标记')
  must(iFreshBroken < iLockBroken,
    '改坏后 fresh 竟然还在 tryLock 之后 —— 扰动没生效，这条自检证明不了什么')
  return `扰动生效：fresh@${iFreshBroken} < lock@${iLockBroken}（真·锁外删），原守卫会红`
})

// C114（2026-11-01，准修 P0 后加）：闸门不许把自己的身份写死在源码里。
//
//   背景（实测出来的 P0）：scripts/check-public-text.mjs 曾把本机身份
//   （用户名 / 昵称 / mid）写死在自己的正则里，而它在 sync-release.ps1 的
//   $repoOnly 清单里（只进仓库、不进包）。sync 的「仅仓库」那遍扫描用
//   $hardRules（本机身份）扫 repoOnly 文件 —— 于是**闸门自己撞自己的闸门**：
//   真跑 release.ps1 必然在 sync 阶段 exit 2，0.4.2 之后的所有发版全被堵住。
//   （0.4.2 发于 13:58，check-public-text.mjs 进 scripts/ 是 14:12 —— 闸门从那以后
//    一次都没真跑过，所以没人发现。）
//
//   C41 只查了 sync-release.ps1 一个文件有没有硬编码身份，漏掉了其余 repoOnly 文件 ——
//   这就是 P0 能溜进来的缝。这条把口径扩到**全部 repoOnly 文件**。
//
//   三条判据：
//   ① 每个 repoOnly 文件都不含本机身份字面量（用户名 + .leak-ids 的每一条）
//   ② sync-release.ps1 里有 .leak-ids 的显式排除声明（$localOnly）
//   ③ 扰动自检：把身份写回 check-public-text.mjs，①必须报出来
check('C114 闸门自己不许写死本机身份（否则闸门撞自己的闸门，发版全被堵住）', () => {
  const sp = join(ROOT, 'scripts/sync-release.ps1')
  if (!existsSync(sp)) {
    skip('C114 闸门自己不许写死本机身份', '发布树不含 scripts/sync-release.ps1（含本机路径，只留开发态）')
    return 'ok'
  }
  const syncSrc = readFileSync(sp, 'utf8')

  // ① 全部 repoOnly 文件都不含身份字面量
  //   $repoOnly 的权威定义在 sync-release.ps1 里 —— 别自己另抄一份（另抄会漂）。
  const m = syncSrc.match(/\$repoOnly\s*=\s*@\(([^)]*)\)/)
  must(m, 'sync-release.ps1 里找不到 $repoOnly 定义')
  const repoOnly = m[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
  must(repoOnly.length >= 6, `$repoOnly 只解析出 ${repoOnly.length} 项（应 ≥6）——解析口径可能变了`)

  const uid = (process.env.USERNAME || process.env.USER || '').trim()
  const idsFile = join(ROOT, '.leak-ids')
  let ids = []
  if (existsSync(idsFile)) {
    ids = readFileSync(idsFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))
  }
  const idents = [uid, ...ids].filter((x) => x && x.length >= 2)

  const hits = []
  for (const rel of repoOnly) {
    const p = join(ROOT, rel)
    if (!existsSync(p)) continue
    const s = readFileSync(p, 'utf8')
    for (const id of idents) {
      if (s.includes(id)) hits.push(`${rel} → 含身份字面量 ${JSON.stringify(id)}`)
    }
  }
  must(!hits.length, '只进仓库的文件里写死了本机身份（这份清单本身会随仓库公开）：\n  ' + hits.join('\n  '))

  // ② .leak-ids 必须在 sync 里有显式排除声明
  //    （它装的就是身份：落进任何扫描面就会被自己的内容命中）
  must(/\$localOnly\s*=\s*@\([^)]*\.leak-ids/.test(syncSrc),
    'sync-release.ps1 里没有 $localOnly 的 .leak-ids 排除声明 —— 这份身份清单落进扫描面就会被自己的内容命中')
  must(syncSrc.includes('$repoOnly -contains $lo'),
    'sync-release.ps1 里没有「.leak-ids 不得进 $repoOnly」的断言 —— 以后有人往 $repoOnly 加条目时没人拦')

  // ③ 扰动自检：把身份写回 check-public-text.mjs，①必须报出来
  //    ——不然这条只是「现在恰好干净」，不是「以后也不许脏」
  const cpt = join(ROOT, 'scripts/check-public-text.mjs')
  let perturbNote = '无身份可扰动（用户名与 .leak-ids 都取不到）'
  if (idents.length && existsSync(cpt)) {
    const victim = idents[0]
    const orig = readFileSync(cpt, 'utf8')
    const broken = orig + `\n// 扰动：${victim}\n`
    const broke = idents.some((id) => broken.includes(id))
    must(broke, '扰动没生效：把身份写回去后竟然查不出来 —— 这条自检证明不了什么')
    perturbNote = `扰动生效：往 check-public-text.mjs 写入 ${JSON.stringify(victim)} 会被 ① 抓住`
  }
  return `repoOnly ${repoOnly.length} 个文件零身份字面量（用户名${uid ? '已查' : '不可用'}、.leak-ids ${ids.length} 条已查）；${perturbNote}`
})

check('W-14 writeMeta 抢不到锁就不读改写（P1：并发下 meta.files 快照会丢项）', () => {
  const body = fnBody(read('tools/look.mjs'), 'writeMeta')
  const iLock = body.indexOf('tryLockSync')
  const iGuard = body.indexOf('if (!lock)')
  const iRead = body.indexOf('readFileSync')
  must(iLock >= 0, 'writeMeta 里找不到 tryLockSync')
  must(iGuard > iLock, 'if (!lock) 守卫不存在，或出现在抢锁之前')
  must(iRead > iGuard, '守卫在读 meta.json 之后——必须挡在「读-改-写」之前')
  return `lock@${iLock} < guard@${iGuard} < read@${iRead}`
})

check('W-04 autoCleanCache 有锁就不清（P1：正在转写时清缓存会让转写白跑且无提示）', () => {
  const body = fnBody(read('index.js'), 'autoCleanCache')
  const iGuard = body.indexOf('hasAnyLock')
  const iWalk = body.indexOf('walkEntries')
  must(iGuard >= 0, 'autoCleanCache 里没有 hasAnyLock 判据')
  must(iWalk > iGuard, 'hasAnyLock 出现在 walkEntries 之后——判据必须挡在遍历/删除之前')
  must(/locked:\s*true/.test(body.slice(iGuard, iGuard + 240)), '有锁时没返回 locked:true（面板分不清「跳过」与「没东西可清」）')
  return `lock@${iGuard} < walk@${iWalk}`
})

check('W-07 所有命令的 --out 都过黑名单（P0：原来只有 frames 一处过闸）', () => {
  // 真跑一次：DSH_HOME 指到独立临时目录，缓存/凭证/runs.jsonl 全落在里面，跑完删掉，不碰真实数据
  const tmp = mkdtempSync(join(tmpdir(), 'bw-verify-'))
  try {
    const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'text', 'BV1xx411c7mD', '--out', 'C:\\Windows\\Temp\\bw'], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_HOME: tmp },
    })
    const err = String(r.stderr || '')
    must(r.status !== 0, `text --out C:\\Windows 的退出码是 ${r.status}，期望非 0（说明没被拦）`)
    must(err.includes('不能指向系统目录'), `stderr 里没有拒绝文案：${JSON.stringify(err.slice(0, 200))}`)
    return `rc=${r.status}`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// 2026-10-31：原来这里还有一条「hasAnyLock 在 index.js 与 tools/look.mjs 逐字一致」的哈希断言。
//   函数搬进 lib/locks.mjs 之后，物理上只剩一份，「两处一致」不再是判据（永远真）——留着只会永远红。
//   删掉不是放松：一致性是搬家的**结果**，行为正确性由下面的 C6 真跑负责。

// —— 阶段 B 第 2 轮（2026-10-28）：承诺不兑现类 ——
// 主题是「同族命令的参数校验/传递不齐」：--format 只在部分命令上真生效、--out 只在部分命令上被校验、
// --ffmpeg 只在部分链路上传下去。三条断言都盯「调用面」，不盯某个具体位置——以后新增命令也逃不掉。

check('W-22 text/local 的 --format 白名单（P1：srt/txt 静默降级成散文还 rc=0）', () => {
  const look = read('tools/look.mjs')
  // cmdText：只允许 text/json/md（emitText 只实现 json+md）
  must(/if \(_fmt && !\['text', 'json', 'md'\]\.includes\(_fmt\)\)/.test(look), 'cmdText 没有 --format 白名单')
  // cmdLocal：只允许 text/json
  must(/if \(_fmt && !\['text', 'json'\]\.includes\(_fmt\)\)/.test(look), 'cmdLocal 没有 --format 白名单')
  // 真跑：srt 必须被拒绝，且指路 sub
  const tmp = mkdtempSync(join(tmpdir(), 'bw-verify-'))
  try {
    const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'text', 'BV1xx411c7mD', '--format', 'srt'], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_HOME: tmp },
    })
    must(r.status !== 0, `text --format srt 退出码 ${r.status}，期望非 0（说明还在静默降级）`)
    must(/不支持 --format srt/.test(String(r.stderr)), `stderr 没说不支持：${JSON.stringify(String(r.stderr).slice(0, 200))}`)
    return `rc=${r.status}`
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

check('W-25 comments/danmaku 的 --out 必须配 --format json（P1：不配就静默不写文件）', () => {
  const look = read('tools/look.mjs')
  // 两个函数都要有 out && format === 'text' 的拦截（cmdText 早就有，这里补的是另两条同族命令）
  const hits = (look.match(/if \(out && format === 'text'\)/g) || []).length
  must(hits >= 2, `只找到 ${hits} 处 --out 拦截，comments 与 danmaku 应各一处`)
  const tmp = mkdtempSync(join(tmpdir(), 'bw-verify-'))
  try {
    for (const c of ['comments', 'danmaku']) {
      const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), c, 'BV1xx411c7mD', '--out', 'x.json'], {
        encoding: 'utf8', timeout: 60000, cwd: tmp, env: { ...process.env, DSH_HOME: tmp },
      })
      must(r.status !== 0, `${c} --out（无 --format）退出码 ${r.status}，期望非 0（说明还在静默丢 --out）`)
      must(/需配合 --format json/.test(String(r.stderr)), `${c} 的 stderr 没给提示：${JSON.stringify(String(r.stderr).slice(0, 160))}`)
    }
    return 'comments+danmaku 都拦住了'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

check('W-27 全文件不存在无参 findFfmpeg() 调用（P1：--ffmpeg 在任何链路上都不许断）', () => {
  const lines = read('tools/look.mjs').split('\n')
  const bad = []
  lines.forEach((ln, i) => {
    const code = ln.split('//')[0] // 去掉注释；findFfmpeg() 不会出现在字符串/URL 里
    if (/findFfmpeg\(\)/.test(code)) bad.push(`${i + 1}: ${ln.trim()}`)
  })
  must(!bad.length, `还有无参调用（--ffmpeg 在这几处会被无视）：${bad.join(' | ')}`)
  // main 分发要把 --ffmpeg 交下去：text / local / runGeneric 三条都要
  // 按调用行判（不用 [^)]* —— 参数里有 flag('fast') 这类调用，遇到第一个 ) 就截断了）
  const src = read('tools/look.mjs')
  const callLines = src.split('\n')
  for (const fn of ['cmdText', 'cmdLocal', 'runGeneric']) {
    const line = callLines.find((l) => l.includes(`await ${fn}(`) && !l.trimStart().startsWith('//'))
    must(line, `找不到 ${fn} 的调用行`)
    must(/ffmpeg:\s*opt\('ffmpeg'\)/.test(line), `${fn} 的调用没把 --ffmpeg 传下去：${line.trim().slice(0, 120)}`)
  }
  return '0 处无参 + 三条分发都传了'
})

// —— 阶段 B 第 3 轮（2026-10-28）：并发写 + 凭证判据的单一出口 ——
// 这两条的共同点：同一个东西在两处各有一份实现/判据，只改一处等于制造不一致。

check('W-33 printText 的 tmp 名带 pid+序号（P1：两路 text 共用同一 tmp 会互盖成半截）', () => {
  const body = fnBody(read('tools/look.mjs'), 'printText')
  must(!/const tmp = target \+ '\.tmp'/.test(body), "固定的 `target + '.tmp'` 还在——两个进程会写同一个 tmp")
  must(/const tmp = `\$\{target\}\.\$\{process\.pid\}-\$\{\+\+TMP_SEQ\}\.tmp`/.test(body), 'tmp 名里没有 pid+序号')
  must(/let TMP_SEQ = 0/.test(read('tools/look.mjs')), 'TMP_SEQ 计数器没定义')
  return 'pid+seq'
})

check('W-28 credState 与 loadCred 用同一套四字段判据（P1：残缺凭证报 ok，面板打勾但实际走匿名）', () => {
  // 阶段 A 的 A-4 只修了 CLI 侧的 loadCred，面板侧的 credState 是同一件事的另一半。
  // 2026-10-31：四字段清单搬进 lib/cred.mjs 的 CRED_FIELDS——原来「两边各写一段字面量、
  //   靠断言比对一致」的做法失效了（找不到字面量，红在错的地方）。现在判据物理上只有一份，
  //   断言改成「清单在 lib 且只有一份 + 两个入口都调它 + 面板仍把残缺说成 incomplete」。
  const lib = read('lib/cred.mjs')
  must(/export const CRED_FIELDS = \['sessdata', 'bili_jct', 'buvid3', 'buvid4'\]/.test(lib), 'lib/cred.mjs 里没有四字段清单')
  const st = fnBody(read('index.js'), 'credState')
  must(/missingCredFields\(/.test(st), 'credState 没用 lib 的 missingCredFields（面板侧会被改回「文件存在就算 ok」）')
  must(/state: 'incomplete'/.test(st), "credState 没返回 'incomplete' 状态，面板分不出「残缺」和「正常」")
  // depRows 要把它说出来，否则面板只显示「更新于 N 天前」，用户看不出是匿名态
  must(/cred\.state === 'incomplete'/.test(read('index.js')), 'depRows 没有把 incomplete 显示出来')
  // CLI 侧：loadCred 走 lib 的 readCred（判据同一份），且仍把「残缺」与「读失败」分开报
  const lc = fnBody(read('tools/look.mjs'), 'loadCred')
  must(/readCred\(/.test(lc), 'loadCred 没走 lib 的 readCred（CLI 侧会被改回只看 sessdata）')
  must(/r\.why === 'incomplete'/.test(lc), 'loadCred 没把「残缺」与「读失败」分开报')
  // 判据本体真跑：缺一个字段必须点名缺哪个，齐了必须放行
  must(missingCredFields({ sessdata: 's' }).join('/') === 'bili_jct/buvid3/buvid4', 'missingCredFields 报的缺字段不对')
  must(missingCredFields({ sessdata: 's', bili_jct: 'j', buvid3: '3', buvid4: '4' }).length === 0, '四字段齐全却被判成残缺')
  must(readCred(join(tmpdir(), 'bw-w28-nope.json')).why === 'enoent', 'readCred 没把「文件不存在」与「内容坏」分开')
  // 两个入口都不许再各写一份字段清单
  for (const rel of ['index.js', 'tools/look.mjs']) {
    must(!/'sessdata', 'bili_jct'/.test(read(rel)), `${rel} 还写着四字段字面量（判据又变两份了）`)
  }
  return '判据在 lib 一份，两个入口都调它；incomplete 仍能传到面板'
})

// —— 行为断言（真跑，但都很快）——
if (online) check('text 摘要里给出落盘路径（P0：摘要必须指路，别让人再跑一遍）', () => {
  const out = execFileSync(process.execPath, [join(HERE, 'look.mjs'), 'text', 'BV19dJQ6sE9F', '--head', '40'], {
    encoding: 'utf8', timeout: 120000,
  })
  must(/text\.txt/.test(out), '输出里没有 text.txt 路径')
  must(/全文/.test(out), '输出里没有全文长度说明')
  return 'ok'
})

if (online) check('sub --format json 的 stdout 是纯 JSON（P0：机器可读格式不许有中文提示）', () => {
  const out = execFileSync(process.execPath, [join(HERE, 'look.mjs'), 'sub', 'BV19dJQ6sE9F', '--format', 'json'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  })
  must(out.trimStart().startsWith('{'), `首字符是 ${JSON.stringify(out.slice(0, 12))}`)
  JSON.parse(out)
  return `${out.length} B`
})

if (!online) {
  skip('text 摘要里给出落盘路径', '联网断言，设 VERIFY_ONLINE=1 才跑')
  skip('sub --format json 纯 JSON', '联网断言，设 VERIFY_ONLINE=1 才跑')
}

// —— 阶段 C（2026-10-28 全量检查）新增断言 ——
// 每一条对应一处这次修掉的问题。原则同前：断言要盯「调用面」而不是「点位」——
// 例如 W-27 的 ffmpeg 不许只断言某一个调用行，否则明天新增一条命令忘了传照样绿。

check('C1 失败原因不再写 stdout（P1：--format json 时错误行会让 JSON.parse 直接失败）', () => {
  const t = read('tools/look.mjs')
  const bad = t.match(/console\.log\(\s*['"`]✗/g) || []
  must(bad.length === 0, `还有 ${bad.length} 处 console.log('✗ …') 走 stdout`)
  const good = t.match(/console\.error\(\s*['"`]✗/g) || []
  must(good.length >= 19, `console.error('✗ …') 只有 ${good.length} 处，少于预期的 19 处`)
  return `stdout 0 处 / stderr ${good.length} 处`
})

check('C2 每条接受 --ffmpeg 的命令在分发处都传了它（P1：ocr 链路原来断了）', () => {
  const lines = read('tools/look.mjs').split('\n')
  // 这 9 条命令/分支的实现都吃 ffmpeg；少传一条就等于「自装 ffmpeg 的用户在这条路上走不到自己那份」
  const need = ['cmdPeek', 'cmdAsr', 'cmdFrames', 'cmdSheet', 'cmdSubstrip', 'cmdOcr', 'cmdText', 'cmdLocal', 'runGeneric']
  const missing = []
  for (const fn of need) {
    const line = lines.find((l) => l.includes(`await ${fn}(`))
    must(line, `分发处找不到 await ${fn}(`)
    if (!line.includes('ffmpeg')) missing.push(fn)
  }
  must(missing.length === 0, `这些分发没把 --ffmpeg 传下去：${missing.join(', ')}`)
  return `${need.length} 条都传了`
})

check('C3 local 的 --out 不再被静默忽略（P1：rc=0 却不生成文件）', () => {
  const body = fnBody(read('tools/look.mjs'), 'cmdLocal')
  must(body.includes('opts.out'), 'cmdLocal 完全没读 opts.out')
  must(body.includes('已写入'), 'cmdLocal 没打印「✓ 已写入」（工具层靠这行回路径给模型）')
  must(/opts\.out\s*&&\s*_fmt\s*!==\s*'json'/.test(body), '缺少「--out 必须配 --format json」的拦截')
  return 'ok'
})

check('C4 --out 黑名单：真喂路径看拦/放（P1：`C:\\Windows.\\` 原来能过）', () => {
  // 2026-10-31：checkOutDir 搬进 tools/cli-io.mjs，于是这条从「compile 抽函数体」
  //   改成「直接 import 生产模块真跑」——比抽源码编译更接近真实调用（模块级依赖由 import 解析）。
  const src = read('tools/cli-io.mjs')
  const body = fnBody(src, 'checkOutDir')
  must(body.includes('const norm ='), '没有归一化步骤')
  must(/\[\\s\.\]\+\$/.test(body), '归一化没剥每段尾部的点/空格')
  must(body.includes('[?.][\\\\/]'), '没剥 \\\\?\\ NT 前缀')
  must(body.includes("'/etc'") && body.includes("'/usr'"), 'POSIX 黑名单还是空的')
  // 核对（2026-10-28 09:3x）：上一轮我在这里加过「含 .. 段一律拒绝」，把 `--out ..\out` 这种
  //   照 README「相对路径相对当前目录」写的正常用法也拒了。resolve() 已经折叠 `..`，
  //   折叠后比黑名单就够；重新加回无条件 `..` 禁令要让这条变红。
  must(!body.includes("includes('..')"), '又出现了无条件的 .. 拒绝（会误伤 `--out ..\\out`）')
  must(body.includes('resolve(raw)'), '黑名单不是拿 resolve 之后的绝对路径比对的')

  // 行为部分（DB 10-28 审核：只查字符串等于没测，真牙口原来在 W-07 那条）——取出来真喂路径
  // checkOutDir 见文件头静态 import（tools/cli-io.mjs）
  const blocked = [
    'C:\\Windows\\x', 'C:\\Windows.\\x', 'C:\\Windows \\x', '\\\\?\\C:\\Windows\\x',
    'C:\\Windows\\Temp\\..\\Windows\\x', 'C:\\', 'C:/Windows/../Windows/x',
  ]
  // POSIX 分支本机（Windows）跑不出真值：`/etc/x` 会被 resolve 成 `<当前盘>:\etc\x`，
  //   黑名单项 `/etc` 经 norm() 后是 `\etc`，两边永不相等。所以只在非 Windows 上断言。
  const posixBlocked = process.platform === 'win32' ? [] : ['/etc/x', '/usr/local/x', '/sys/x', '/']
  const allowed = ['..\\x', '..\\out', '.\\out', 'out', join(ROOT, 'out'), '']
  const bad = []
  const expectBlocked = (p) => {
    try { checkOutDir(p); bad.push(`\`${p}\` 该拦却放行了`) } catch { /* 拦住了，对 */ }
  }
  const expectAllowed = (p) => {
    try { checkOutDir(p) } catch (e) { bad.push(`\`${p}\` 该放行却拦了（${e?.message}）`) }
  }
  for (const p of blocked.concat(posixBlocked)) expectBlocked(p)
  for (const p of allowed) expectAllowed(p)
  must(bad.length === 0, bad.join('；'))
  const n = blocked.length + posixBlocked.length + allowed.length
  return `${n} 条行为${process.platform === 'win32' ? '（POSIX 4 条未在本机验证）' : ''}`
})

check('C5 写端点的回环判据真拦非本机请求（P1：Host 头可伪造，绑 0.0.0.0 时局域网可删凭证）', () => {
  const src = read('index.js')
  // 顺序：remoteAddress 判据必须在 Host 判据之前，否则等于没兜底
  const body = fnBody(src, 'sameOriginBlocked')
  const iPeer = body.indexOf('remoteAddress')
  const iHost = body.indexOf('hostNameOf')
  must(iPeer > 0 && iPeer < iHost, 'remoteAddress 判据必须在 Host 判据之前')

  // 行为（DB 10-28 审核：原来只查「源码里有 remoteAddress 这个字符串」，
  //   把条件拆成 `if (false && ...)` 照样 28/0/2 全绿）。现在真喂 req 看返回值。
  // 注意：集合里有 "[::1]" 这种自带方括号的项，所以按行取，别按方括号配对取
  const m = src.match(/^const LOOPBACK = [^\n]+/m)
  must(m, '找不到 LOOPBACK 集合')
  const { sameOriginBlocked } = compile(src, ['hostNameOf', 'sameOriginBlocked'], { prelude: m[0] })
  const req = (peer, headers = {}, method = 'GET') => ({ socket: { remoteAddress: peer }, method, headers })
  const H = { host: '127.0.0.1:3080' }
  const W = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }
  const cases = [
    // [说明, req, 期望是否被拦]
    ['局域网对端 + 伪造回环 Host/Origin 的写请求（DB 复现的场景）', req('192.168.1.20', W, 'POST'), true],
    ['局域网对端读 /status', req('192.168.1.20', H, 'GET'), true],
    ['局域网对端 ::ffff:192.168.1.20', req('::ffff:192.168.1.20', H, 'GET'), true],
    ['本机 127.0.0.1 正常写', req('127.0.0.1', W, 'POST'), false],
    ['本机 ::1 正常写', req('::1', W, 'POST'), false],
    ['IPv4 映射 ::ffff:127.0.0.1 正常写', req('::ffff:127.0.0.1', W, 'POST'), false],
    ['本机读 /status', req('127.0.0.1', H, 'GET'), false],
    ['本机 + 伪造 Host（DNS rebinding）', req('127.0.0.1', { ...W, host: 'evil.example:3080' }, 'POST'), true],
    // 2026-10-28 issue #2 P1-1：DSH 桌面端壳层的同源 fetch 不带 Origin，硬拦会把面板写操作全打成 403。
    ['本机写但缺 Origin（桌面壳层，issue #2 P1-1 → 放行）', req('127.0.0.1', { host: '127.0.0.1:3080', 'content-type': 'application/json' }, 'POST'), false],
    ['本机写缺 Origin 且 sec-fetch-site=cross-site', req('127.0.0.1', { host: '127.0.0.1:3080', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 'POST'), true],
    ['本机写缺 Origin 且 sec-fetch-site=same-site', req('127.0.0.1', { host: '127.0.0.1:3080', 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }, 'POST'), true],
    ['本机写 text/plain（CSRF 简单请求）', req('127.0.0.1', { ...W, 'content-type': 'text/plain' }, 'POST'), true],
    ['本机写但 sec-fetch-site=cross-site', req('127.0.0.1', { ...W, 'sec-fetch-site': 'cross-site' }, 'POST'), true],
  ]
  const bad = []
  for (const [name, r, want] of cases) {
    const got = sameOriginBlocked(r)
    const blocked = got != null
    if (blocked !== want) bad.push(`${name}（期望${want ? '拦' : '放'}，实际${blocked ? '拦：' + got : '放'}）`)
  }
  must(bad.length === 0, bad.join('；'))
  return `${cases.length} 条行为`
})

check('C14 /status 也过同源闸，所以路径遮罩退化成直通是安全的（10-28 豆包派单的承重墙）', () => {
  const src = read('index.js')
  const iGuard = src.indexOf('const blocked = sameOriginBlocked(req)')
  const iStatus = src.indexOf("url.pathname === '/api/bili-watch/status'")
  must(iGuard > 0, 'webServer 处理器里找不到 sameOriginBlocked(req)')
  must(iStatus > iGuard, '同源闸不在路由分支之前——GET /status 会绕过回环判据，路径就会漏给局域网')
  const body = fnBody(src, 'maskAbs')
  must(/return String\(p \|\| ''\)/.test(body), 'maskAbs 又变成遮罩了（要恢复遮罩，先确认 C5 的回环判据仍是唯一出口）')
  must(!body.includes('…'), 'maskAbs 里还有省略号遮罩')
  return `guard@${iGuard} < status@${iStatus}`
})

check('C6 锁判据真跑：活锁算占用、残留锁不算、坏锁当没有（P1：残留 .lock 会让 clean 永久拒绝）', () => {
  // 2026-10-31：4 个函数搬进 lib/locks.mjs，原来「两处函数体逐字一致」的判据作废（只剩一份）。
  //   改成喂真实锁文件看返回值：ttl 比反、EPERM 当死、坏 JSON 当活、owner.ttlMs 被忽略——任何一条都会红。
  const dir = mkdtempSync(join(tmpdir(), 'bw-c6-'))
  const f = join(dir, '.lock')
  const write = (o) => writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o))
  try {
    // ① 活锁：本进程 pid + 刚写的时间 → 算占用
    write({ pid: process.pid, at: Date.now(), ttlMs: 60000, owner: 'x' })
    must(hasAnyLock(dir, 60000) === true, '活锁（本进程 pid + 刚写的 at）没被认成占用')

    // ② 过期与边界
    must(lockExpired({ at: Date.now() }, 60000) === false, '刚写的锁被判过期')
    must(lockExpired({ at: Date.now() - 120000 }, 60000) === true, '2 分钟前的锁配 60 秒 TTL 没判过期')
    must(lockExpired(null, 60000) === true, 'owner 为空没判过期（没有持有者就不存在占用）')
    // 锁自带的 ttlMs 优先：at 比 ttlMs 更老 → 过期（10ms > 5ms，不受机器快慢影响）
    must(lockExpired({ at: Date.now() - 10, ttlMs: 5 }, 60000) === true, 'lockExpired 没优先用锁自带的 ttlMs（用户中途改设置会让在跑的转写被抢）')
    // 反过来：锁自带一个很大的 ttlMs → 不能因为传进来的 1ms 就判过期
    must(lockExpired({ at: Date.now(), ttlMs: 999999999 }, 1) === false, 'lockExpired 用传入 ttlMs 盖掉了锁自带的 ttlMs')

    // ③ 残留锁不算占用（Ctrl-C / 强杀留下的 .lock，判成占用会让缓存永远清不掉）
    write({ pid: process.pid, at: Date.now() - 120000, ttlMs: 60000 })
    must(hasAnyLock(dir, 60000) === false, '过期锁被认成占用（残留锁会让 clean 永久拒绝）')
    rmSync(f)
    must(hasAnyLock(dir, 60000) === false, '没有锁文件却报占用')

    // ④ 判活
    must(pidAlive(process.pid) === true, 'pidAlive 对自己这个进程说没活')
    must(pidAlive(0) === false && pidAlive(-1) === false && pidAlive(1.5) === false, '非法 pid 被当成活着')
    must(pidAlive(9999999) === false, '不存在的 pid 被当成活着')

    // ⑤ 坏锁文件当没有（手改坏的 .lock 不能永久堵住缓存）
    write('not json')
    must(readLock(f) === null, '坏 JSON 没返回 null')
    write({ pid: 'x' })
    must(readLock(f) === null, 'pid 不是正整数也返回了对象')
    write({ pid: 123 })
    must(readLock(f)?.pid === 123, '合法锁文件读不出来')

    // ⑥ TTL 换算：算式收在 lib/tuning.mjs 的 lockTtlMsOf。
    //   按 2026-10-31 16:14 的判据：**同一份配置，两个入口算出的 TTL 必须完全相同**。
    //   做法：把两个入口（index.js 的 readTuning / look.mjs 的 tuning）真编译出来，
    //   只桩「配置从哪来」（depsCfg / readDepsCfg），钳制与换算是生产代码。
    //   字段名写错（比如 tuning 里读 cfg.lockTtlMinX）→ 那一侧回落默认 30 分钟 → 两边不等 → 红。
    const ttlOf = (file, entry, cfg) => {
      const prelude =
        `const __CFG = ${JSON.stringify(cfg)}\n` +
        (entry === 'readTuning'
          ? 'function depsCfg() { return __CFG }'
          : 'function readDepsCfg() { return __CFG }\nfunction opt() { return null }')
      const fn = compile(read(file), [entry], {
        prelude,
        params: ['normalizeTuning', 'lockTtlMsOf'],
        args: [normalizeTuning, lockTtlMsOf],
      })[entry]
      return lockTtlMsOf(fn())
    }
    for (const cfg of [
      { lockTtlMin: 30, asrTimeoutSec: 600 }, // max(1800000, 720000) = 1800000
      { lockTtlMin: 5, asrTimeoutSec: 3600 }, // max(300000, 3720000) = 3720000
    ]) {
      const want = Math.max(cfg.lockTtlMin * 60000, (cfg.asrTimeoutSec + 120) * 1000)
      const a = ttlOf('index.js', 'readTuning', cfg)
      const b = ttlOf('tools/look.mjs', 'tuning', cfg)
      must(a === want, `index.js 入口对 ${JSON.stringify(cfg)} 算出 ${a}，应为 ${want}`)
      must(b === want, `look.mjs 入口对 ${JSON.stringify(cfg)} 算出 ${b}，应为 ${want}`)
      must(a === b, `同一份配置两个入口算出不同 TTL：index=${a} look=${b}（面板与 CLI 会互相抢锁）`)
    }

    // ⑦ 真读盘那一段（上面 ⑥ 把「配置从哪来」桩掉了，这里补上）：
    //   deps-config.json → JSON.parse → normalizeTuning → lockTtlMsOf，用上限值压边界。
    const cfgDir = mkdtempSync(join(tmpdir(), 'bw-c6-cfg-'))
    try {
      const p = join(cfgDir, 'deps-config.json')
      writeFileSync(p, JSON.stringify({ lockTtlMin: 240, asrTimeoutSec: 3600 }))
      const real = lockTtlMsOf(normalizeTuning(JSON.parse(readFileSync(p, 'utf8'))))
      must(real === 14400000, `配置 lockTtlMin=240 应为 14400000，实际 ${real}`)
      // 越界值回落默认：241 超出 5–240，必须回落到 30 分钟
      const off = lockTtlMsOf(normalizeTuning(JSON.parse('{"lockTtlMin":241,"asrTimeoutSec":900}')))
      must(off === 1800000, `lockTtlMin=241 应回落默认 30 分钟（1800000），实际 ${off}`)
    } finally {
      rmSync(cfgDir, { recursive: true, force: true })
    }

    // ⑧ 算式只许有一份：入口文件里不能再出现「分钟 → 毫秒」的换算
    for (const f of ['index.js', 'tools/look.mjs']) {
      must(!/lockTtlMin\s*\*\s*60\s*\*\s*1000/.test(read(f)), `${f} 又抄了一份 TTL 算式（只能调 lib/tuning.mjs 的 lockTtlMsOf）`)
    }

    return '锁 3 态 + 判活 + 两入口同配置同 TTL（1800000 / 3720000）+ 真读盘边界（14400000 / 越界回落 1800000）'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('C7 cleanKey 挡路径逃逸与 Windows 保留名（P2：尾部点号会被系统吃掉、con.txt 仍是设备名）', () => {
  // 2026-10-31：原来是「比两处函数体的 md5」——那是结构断言，函数搬进 lib/ 后必然失效，
  //   而且它只证明「两边写得一样」，不证明「写得对」（两边一起改错照样绿）。
  //   现在函数只有一份，直接 import 真跑，喂对抗输入看输出。
  const cases = [
    ['..', '_misc', '纯点点会被当上级目录'],
    ['.', '_misc', '当前目录'],
    ['con', '_misc', 'Windows 设备名'],
    ['con.txt', '_misc', '带后缀仍是设备名（按去扩展名后的基名判）'],
    ['NUL.ini', '_misc', '设备名大小写不敏感'],
    ['COM1', '_misc', '串口设备名'],
    ['a/b\\c', 'abc', '路径分隔符必须剥掉，否则输入能决定磁盘路径'],
    ['  x  ', 'x', '首尾空格'],
    ['abc...', 'abc', '尾部点号在 Windows 上会被系统吃掉'],
    ['', '_misc', '空输入'],
    ['BV1xx411c7mD', 'BV1xx411c7mD', '正常 BV 号原样保留'],
  ]
  for (const [inp, want, why] of cases) {
    const got = cleanKey(inp)
    must(got === want, `cleanKey(${JSON.stringify(inp)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}（${why}）`)
  }
  must(cleanKey('x'.repeat(100)).length === 40, 'cleanKey 没截到 40 字符')
  must(!/[\\/]/.test(cleanKey('../../etc/passwd')), 'cleanKey 输出里还有路径分隔符（能穿出缓存根）')
  must(!/[\\/]/.test(cleanKey('a\\..\\b')), 'cleanKey 输出里还有反斜杠')
  return `${cases.length} 条对抗输入 + 长度上限 + 无路径分隔符`
})

check('C8 pickCacheDir 建根 + 真写可写探针，正常/回退都返回 { dir, fallback }（#18，P1：形状不同会让缓存根变成 [object Object]）', () => {
  // 2026-10-31：pickCacheDir 只剩 lib/cache-path.mjs 一份（原来两个入口各一份，靠本条的
  //   「两处逐字一致」绑住）。搬家之后「一致」自动成立，所以改成**行为断言**：
  //   真造两种目录形态，看它建了什么、探针有没有删干净、回退换到哪个根、回退根有没有标记。
  //   #18 那条坑（一侧返回字符串、另一侧返回对象）现在只可能出现在「有人又抄一份实现」时，
  //   那种情况由 C66（实现只有一份）拦。
  const dir = mkdtempSync(join(tmpdir(), 'bw-c8-'))
  const oldHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join(dir, 'home')
    const good = join(dir, 'cache-ok')
    const ok = pickCacheDir(good)
    must(ok && typeof ok === 'object' && typeof ok.dir === 'string', `正常路径没返回 { dir }（拿到 ${JSON.stringify(ok)}）`)
    must(ok.fallback === null, `正常路径 fallback 应为 null，实际 ${JSON.stringify(ok.fallback)}`)
    must(ok.dir === good, `正常路径返回的 dir 不对：${ok.dir}`)
    must(existsSync(good), '正常路径没把缓存根建出来')
    must(existsSync(join(good, '.bili-watch-root')), '正常路径没写根标记（删除面会整片失效）')
    const left = readdirSync(good).filter((n) => n.startsWith('.write-test-'))
    must(left.length === 0, `探针没删掉：${left.join(', ')}——clean 会把它当外来文件跳过，根目录留垃圾`)
    // 「父级是文件」逼出 catch 分支：mkdir 必失败，与平台无关，也不用改权限
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const bad = join(blocker, 'cache')
    const fb = pickCacheDir(bad)
    must(fb && typeof fb === 'object' && typeof fb.dir === 'string', `回退分支没返回 { dir }（拿到 ${JSON.stringify(fb)}）`)
    must(fb.dir !== bad && Boolean(fb.fallback), `回退分支应换到默认根并给出 fallback 原因，实际 ${JSON.stringify(fb)}`)
    must(fb.dir === join(dir, 'home', 'bili-watch', 'cache'), `回退根不对：${fb.dir}`)
    must(existsSync(join(fb.dir, '.bili-watch-root')), '回退根没写标记（P1-①：clean 会永远删不动、面板报「已清理 0 个文件」）')

    // 「探针没留下来」证明不了它**写过**——把写探针那段整块删掉，剩下的同样是「没有探针」（R5 实测：
    //   删掉后这条照样绿）。所以再补一段注入 fs 真跑：让写探针必失败、写标记照常成功，
    //   pickCacheDir 必须走回退。这是「能建根、写不进」那个老坑的唯一可移植判据——
    //   本机（Windows + Node）造不出真 EPERM/EBUSY，与 C10 同一条限制。
    const { pickCacheDir: pickInjected } = compile(read('lib/cache-path.mjs'), ['pickCacheDir'], {
      prelude: [
        `const CACHE_MARK = '.bili-watch-root'`,
        `const resolveCacheDir = () => 'W:/want'`,
        `const defaultCacheRoot = () => 'W:/def'`,
      ].join('\n'),
      params: ['join', 'process', 'mkdirSync', 'existsSync', 'writeFileSync', 'rmSync'],
      args: [
        join,
        { pid: 7 },
        () => {},
        () => false,
        (p) => { if (String(p).includes('.write-test-')) { const e = new Error('EPERM: 只读目录'); e.code = 'EPERM'; throw e } },
        () => {},
      ],
    })
    const inj = pickInjected('/whatever')
    must(inj && inj.dir === 'W:/def' && Boolean(inj.fallback), `写探针失败时没有回退（拿到 ${JSON.stringify(inj)}）——说明可写探测没做：只 mkdir + 写标记时，只读目录 / 配额满 / 盘符掉线都照样报成功`)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(dir, { recursive: true, force: true })
  }
  return '正常/回退两分支真跑（建根、写标记、探针删净、回退根带标记）+ 注入 fs 证明探针写失败会回退'
})


check('C9 KNOWN_FLAGS 两处都认识 --asr-max（P2：真生效却被报「未知参数已忽略」）', () => {
  // index.js 侧仍是数组字面量，读源码；look.mjs 侧改真跑（第二步：那边已改成从参数表生成，
  //   再读字面量就是验「长什么样」而不是「认不认」）。
  const a = read('index.js')
  const iA = a.indexOf('const KNOWN_FLAGS')
  must(iA >= 0, '找不到 index.js 的 KNOWN_FLAGS')
  must(a.slice(iA, iA + 700).includes("'--asr-max'"), 'index.js 的 KNOWN_FLAGS 缺 --asr-max')
  const r = flagAccepted('asr-max', '30000')
  must(r.ok, `look.mjs 报「未知参数 --asr-max」：stderr=${r.err.slice(0, 160)}`)
  return 'index.js 字面量有 --asr-max；look.mjs 真跑 help --asr-max 不报未知参数'
})

check('C10 clean 把「删除失败」与「不是我们的数据」分开报（P2：原来 EPERM 被说成「没动」且 rc=0）', () => {
  // 2026-10-31：removeOwned 搬进 lib/cache-own.mjs，「删除失败」与「不是我们的数据」分开报这件事
  //   只剩一处实现；后半段仍盯 look.mjs 的 clean 分支（读 cleared.failed 并改退出码）。
  //
  // 前半段改真跑（反向验证 R7 抓出来的）：原来只断言「函数体里出现过 failed.push」——
  //   三个分支里删掉两处它照样绿，牙不齐。现在用一个会抛错的假 fs，看它把「删不掉」记进
  //   failed 还是混进 skipped，并且这条条目不能被算成「已清理」。
  //
  // 2026-10-31：先试「真占用」，造不出来才用假 fs。
  //   本机实测三种方式**都删得掉**（不抛）：
  //     ① openSync(f,'r+') 持有写句柄后 rmSync(f)                    → 未抛
  //     ② 文件 chmod 0o444 后 rmSync(f)                              → 未抛
  //     ③ 子目录里的文件持句柄，rmSync(sub,{recursive:true})          → 未抛
  //   原因：libuv 在 Windows 上以 FILE_SHARE_READ|WRITE|DELETE 打开，删不掉的前提（独占句柄）
  //   用 Node 造不出来。所以这里退回假 fs，并把「真码优先、假码兜底」写进断言——
  //   换一台真能造出来的机器，这条会自动用真错误码跑，不用改断言。
  let realCode = null
  {
    const d = mkdtempSync(join(tmpdir(), 'bw-c10-probe-'))
    try {
      const f = join(d, 'locked.bin')
      writeFileSync(f, 'x')
      const fd = openSync(f, 'r+')
      try { rmSync(f, { force: true }) } catch (e) { realCode = e.code }
      try { closeSync(fd) } catch {}
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  }
  const mkRemove = (code) => {
    const ents = [
      { name: 'frames', isDirectory: () => true, isFile: () => false },
      { name: 'mine.txt', isDirectory: () => false, isFile: () => true },
    ]
    return compile(read('lib/cache-own.mjs'), ['removeOwned'], {
      prelude: [
        `const CACHE_MARK = '.bili-watch-root'`,
        `const OWN_CACHE_DIRS = new Set(['frames'])`,
        'const isOurCacheRoot = () => true',
        'const isOwnBvDir = () => false',
        'const looksLikeOwnUrlDir = () => false',
        'const dirStat = () => ({ files: 1, bytes: 10 })',
        // 2026-11-01（X-02）：removeOwned 现在对白名单目录还要过内容校验。
        //   这里默认「是我们要的」——本断言测的是「删不掉进 failed」，不该被归属判据干扰。
        //   归属判据本身由 C112 单独钉（这条 stub 会把它整个屏蔽掉，别指望它抓）。
        'const whitelistDirIsOurs = () => true',
      ].join('\n'),
      params: ['readdirSync', 'rmSync', 'lstatSync', 'join'],
      args: [
        () => ents,
        () => { const e = new Error(`${code}: operation not permitted`); e.code = code; throw e },
        () => ({ size: 10 }),
        join,
      ],
    }).removeOwned
  }
  const removeOwned = mkRemove(realCode || 'EPERM')
  const r = removeOwned('/fake-root')
  must(Array.isArray(r.failed) && r.failed.length === 1, `删不掉时没进 failed（failed=${JSON.stringify(r.failed)}）——会被说成「没动」`)
  must(r.failed[0].name === 'frames', `failed 里记的条目不对：${JSON.stringify(r.failed[0])}`)
  must(String(r.failed[0].why).includes(realCode || 'EPERM'), 'failed 没带真实原因（用户看不到是权限问题）')
  must(r.skipped.some((s) => s.name === 'mine.txt'), '不是我们的数据没进 skipped')
  must(!r.skipped.some((s) => s.name === 'frames'), '删不掉的条目混进了 skipped（就是这条坑）')
  must(r.files === 0 && r.bytes === 0, `删失败却把体积算成已清理（files=${r.files} bytes=${r.bytes}）`)

  // Windows 上删被占用文件常见的是 EBUSY 不是 EPERM。生产代码 catch 一切错误，
  //   但断言要证明「换个码也照样进 failed」——否则只测过一个码，换台机器可能红。
  if (realCode !== 'EBUSY') {
    const r2 = mkRemove('EBUSY')('/fake-root')
    must(r2.failed.length === 1 && String(r2.failed[0].why).includes('EBUSY'), 'EBUSY 没被记进 failed（换台机器就漏报）')
    must(r2.files === 0, 'EBUSY 被算成已清理')
  }

  // 后半段：cli 侧必须读 failed 并改退出码（否则面板/脚本看不出这次没删干净）
  const t = read('tools/look.mjs')
  const i = t.indexOf('cleared.failed.length')
  must(i > 0, 'clean 分支没读 cleared.failed')
  must(t.slice(i, i + 300).includes('process.exitCode = 1'), '报失败但没改退出码')
  return `${realCode ? '真 ' + realCode : '假 fs（本机造不出真 EPERM/EBUSY：写句柄 / 只读位 / 递归删目录都不抛，libuv 用 FILE_SHARE_DELETE）'} 进 failed 且不算已清理；EBUSY 同样；clean 分支读 failed 并改退出码`
})

check('C11 sync-release 的检查面等于发布面（P1：原来 scripts/ 与 verify*.mjs 被整体排除，是假绿）', () => {
  // 发布树（= GitHub 仓库 clone 后的形态）不含 scripts/sync-release.ps1——它含本机路径字面量，
  //   只在开发态存在。此时这条断言无从可查，记跳过而不是失败（2026-10-30：反向清理恢复
  //   verify*.mjs 之后，发布树第一次能跑自检，跑出来就是这条 ENOENT）。
  if (!existsSync(join(ROOT, 'scripts/sync-release.ps1'))) {
    skip('C11 sync-release 的检查面', '发布树不含 scripts/sync-release.ps1（含本机路径，只留开发态）')
    return 'ok'
  }
  const t = read('scripts/sync-release.ps1')
  must(!/\^\(scripts\/\|/.test(t), '扫描清单里还有「排除整个 scripts/」的正则')
  must(t.includes('$detectors'), '没有检测器混入发布清单的守卫')
  must(t.includes('$scanList = @(($copyList + $excludeCopy)'), '扫描清单不再由发布清单直接展开')
  return 'ok'
})

check('C12 search 的 --limit 在 --days 生效时仍然截断（P2：原来最多打 60 条）', () => {
  const body = fnBody(read('tools/look.mjs'), 'cmdSearch')
  must(/list\.slice\(0,\s*Math\.floor\(limit\)\)/.test(body), '没有按 limit 截断')
  return 'ok'
})

check('C13 package.json 的 files 是显式列表，且不含内部脚本（P1：tools/ 目录通配会把 verify 两个文件发出去）', () => {
  const f = JSON.parse(read('package.json')).files
  must(Array.isArray(f), 'files 不是数组')
  must(!f.includes('tools/') && !f.includes('scripts/'), 'files 里还有目录项（目录项会整目录展开）')
  for (const bad of ['tools/verify.mjs', 'tools/verify-todo.mjs', 'scripts/sync-release.ps1']) {
    must(!f.includes(bad), `files 里还有 ${bad}`)
  }
  must(f.includes('tools/look.mjs') && f.includes('tools/ocr.py'), 'files 缺运行时必需的 tools/look.mjs 或 tools/ocr.py')

  // 2026-11-01 补：判据原来只硬编码 'tools/' 与 'scripts/' 两个串，**deps 不在其中**。
  //   实测（造临时副本真跑 sync）：files 里若出现 `deps`（目录项），它会整目录展开，
  //   把 deps/credential.json（真凭证 584B）、deps/.anon-buvid3（设备指纹）、
  //   deps/yt-dlp.exe（17.8MB）、deps/ui-config.json 一起复制进发布树 ——
  //   而「deps 现在是单文件 deps/_bili-asr.py」正是「__pycache__ 不会进包」这个结论
  //   所依赖的前提（2026-11-01 那条核查）。前提没人守 = 迟早被改。
  //
  //   注意这里**不是**「一律禁止目录项」：`lib/` 本来就是目录项，是合法设计（lib 下全是
  //   发布件，没有本机产物）。真正的危险是「目录里混着工作区状态/运行时产物」——
  //   deps/ 里有凭证、指纹、17MB 的 yt-dlp.exe，整个当目录项列出去就是全带进包。
  //   所以判据是「**这些特定目录**不许当目录项」，而不是「所有目录项都红」。
  //   不做「目录里有没有敏感文件」的通用推断——那要靠 sync 的扫描（另一条判据的事），
  //   这里只守「别把工作区目录整个列进白名单」这个已知形态。
  const WORKDIRS = ['deps', 'node_modules', 'cache', 'runs']
  for (const entry of f) {
    const rel1 = String(entry).replace(/[\\/]+$/, '').replace(/\\/g, '/')
    if (!rel1) continue
    const abs = join(ROOT, rel1)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue
    const top = rel1.split('/')[0]
    must(!WORKDIRS.includes(top),
      `files 里有工作区目录项 ${entry} —— 它会整目录展开，把 ${top}/ 下的凭证、设备指纹、` +
      `yt-dlp.exe、__pycache__ 这类本机产物一起带进包。请逐个列文件（像 deps/_bili-asr.py 那样）。`)
  }

  // 2026-11-01（拍板的第三条）：补上标题里早就承诺、但一直没实体判据的那半句
  //   —— C13 的标题写着「P1：tools/ 目录通配会把 verify 两个文件发出去」，但原来只有
  //   「files 里不许出现 tools/verify.mjs 这个字符串」的点名判据，**没有任何一条拦通配符本身**。
  //   标题承诺了、判据没跟上，就是「判据在验错对象」的另一种形态。
  //
  //   为什么要拦：上面那条 WORKDIRS 只挡「目录项」这一种**形态**（`deps` / `deps/`）。而 `deps/*`
  //   这种 glob 写法会整段绕过去：`existsSync(join(ROOT,'deps/*'))` 判假 → 上面那个 continue
  //   直接放行，而 npm 打包时照样把 deps 整个展开 —— 与「写目录项」是同一条路，只是换个形状
  //   骗过判据。（跟今天 C117 上踩的同类病：判据只认某一种写法，换个写法就是默认关掉的口子。）
  //
  //   为什么用「按形态拦」而不是继续给 WORKDIRS 点名：点名是黑名单，以后新增一个工作区目录
  //   没人记得加名字；通配符禁令挡全类，不用维护。
  //
  //   为什么只拦 `*` 和 `?`、没把 `[]` 算进来：npm 确实也支持方括号 glob，但 `[` 在合法文件名里
  //   是常见字符（内容哈希、`[id].js` 这类动态路由命名），禁它会误报真文件；而 `*`/`?` 在
  //   Windows 文件名里本来就非法，写进 files 只可能是 glob。误报成本高于漏报概率，所以这条
  //   只认 `*`/`?`；将来真出现方括号 glob，再单独加。
  const globs = f.filter((e) => /[*?]/.test(String(e)))
  must(globs.length === 0,
    `files 里有通配符条目：${globs.join(', ')} —— npm 会把它整段展开，等于把整个目录（含凭证、` +
    `设备指纹、yt-dlp.exe、__pycache__）带进包。要打包什么就逐个写文件名。`)
  return `${f.length} 项`
})

// 2026-10-30 B 方案：原来 C16 守的是「syncPanelSmallToShared 两处函数体逐字一致」。
//   用户拍板把「跟随同机其它工具」整套功能拿掉，那个函数已经不存在了——这条断言必须跟着改，
//   否则它会变成指着已删代码的空转断言（E6-08 说的正是这个毛病）。
//   新判据改成「终态」：两处都只认自己那份凭证，且全仓不许再出现同机其它工具的痕迹。
check('C16 凭证只认自己那份：不再跟随同机其它工具（B 方案终态）', () => {
  const idx = read('index.js')
  const look = read('tools/look.mjs')
  for (const [name, src] of [['index.js', idx], ['tools/look.mjs', look]]) {
    must(!/syncPanelSmallToShared/.test(src), `${name} 里还有 syncPanelSmallToShared（B 方案应已删）`)
    must(!/PANEL_CRED|PANEL_SMALL|CRED_CLEARED/.test(src), `${name} 里还有同机其它工具的凭证常量`)
  }
  // 两处的凭证解析都只能出现 SHARED / LEGACY 两个路径
  // 2026-10-31：迁移判据搬进 lib/cred.mjs 之后，两个入口只剩「拿结果」这一步。
  //   原来这里 compile 抽 resolveCredPath 的函数体去跑——搬走以后那份函数体只剩一行，
  //   再抽就是「用空壳验空壳」。改成：结构上钉「两个入口都在用 lib」，行为上直接跑 lib。
  const r1 = fnBody(idx, 'resolveCredPath')
  const r2 = fnBody(look, 'credFor')
  must(/adoptLegacyCred\(\{ shared: SHARED_CRED, legacy: LEGACY_CRED \}\)\.path/.test(r1), 'resolveCredPath 没走 lib 的 adoptLegacyCred')
  must(/adoptLegacyCred\(/.test(r2), 'credFor 没走 lib 的 adoptLegacyCred')
  must(!/PANEL_/.test(r1) && !/PANEL_/.test(r2), '凭证解析里还在引用同机其它工具')
  // 删掉仲裁之后，「谁新用谁」的 mtime 比较不该再出现
  must(!/mtimeOf\(/.test(look), 'credFor 里还留着 mtime 仲裁')
  // 路径推导也只有 lib 一份：两个入口不许再自己拼 $DSH_HOME/bili-watch/credential.json
  //   （同款表达式在 DEPS 解析里也有，那是 deps 的路径，不归凭证管——所以只认带 credential.json 的那一行）
  for (const [name, src] of [['index.js', idx], ['tools/look.mjs', look]]) {
    const bad = src.split('\n').filter((l) => /homedir\(\), '\.dsh'\)/.test(l) && /credential\.json/.test(l))
    must(bad.length === 0, `${name} 还在自己拼凭证路径（应在 lib/cred.mjs 的 credPaths）：${bad[0]?.trim()}`)
  }
  must(/export function credPaths/.test(read('lib/cred.mjs')), 'lib/cred.mjs 缺 credPaths')

  // 真跑（不是查字符串）：造五种现场看 adoptLegacyCred 到底返回哪条、有没有把坏凭证搬过去。
  //   只查源码里有没有 SHARED_CRED 是纸老虎——把 if 改成恒假照样绿。
  const dir = mkdtempSync(join(tmpdir(), 'bw-c16-'))
  try {
    const shared = join(dir, 'bili-watch', 'credential.json')
    const legacy = join(dir, 'deps', 'credential.json')
    const P = { shared, legacy }
    // ① 两处都没有：只返回 SHARED 路径，不凭空造文件
    const a1 = adoptLegacyCred(P)
    must(a1.path === shared, '① 两处都没有时应返回 SHARED 路径')
    must(a1.sharedExists === false, '① 两处都没有时 sharedExists 应为 false')
    must(!existsSync(shared), '① 只是算路径就创建了文件')
    // ② 旧位置凭证齐全：迁到 SHARED 并返回 SHARED，字段不能丢
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ sessdata: 's', bili_jct: 'j', buvid3: '3', buvid4: '4' }))
    const a2 = adoptLegacyCred(P)
    must(a2.path === shared && a2.moved === true, '② 旧凭证齐全时没迁到 SHARED')
    must(a2.cred?.sessdata === 's', '② 迁移没把凭证交给调用方（CLI 侧要靠它直接用）')
    must(existsSync(shared), '② 旧凭证齐全时没真的写 SHARED')
    const mig = JSON.parse(readFileSync(shared, 'utf8'))
    must(mig.sessdata === 's' && mig.buvid4 === '4', '② 迁移把字段弄丢了')
    // ③ 旧位置凭证残缺：继续用 LEGACY，不迁（半个凭证搬过去等于把登录态弄坏）
    rmSync(shared, { force: true })
    writeFileSync(legacy, JSON.stringify({ sessdata: 's' }))
    const a3 = adoptLegacyCred(P)
    must(a3.path === legacy, '③ 旧凭证缺字段时应继续用 LEGACY，不迁')
    must(a3.problem === 'incomplete' && a3.missing?.join('/') === 'bili_jct/buvid3/buvid4', `③ 残缺没报清缺哪些字段：${a3.problem}/${a3.missing}`)
    must(!existsSync(shared), '③ 旧凭证缺字段却还是写了 SHARED')
    // ④ SHARED 在就永远优先，哪怕 LEGACY 更新——这正是 B 方案要拿掉的「谁新用谁」
    writeFileSync(shared, JSON.stringify({ sessdata: 'new' }))
    writeFileSync(legacy, JSON.stringify({ sessdata: 'old', bili_jct: 'j', buvid3: '3', buvid4: '4' }))
    const a4 = adoptLegacyCred(P)
    must(a4.path === shared, '④ SHARED 存在时不该回读 LEGACY（谁新用谁已拿掉）')
    must(a4.moved === false, '④ SHARED 存在时不该再迁移')
    must(JSON.parse(readFileSync(shared, 'utf8')).sessdata === 'new', '④ SHARED 被旧凭证覆盖了')
    // ⑤ 旧位置是坏 JSON：继续用 LEGACY，不当成「没有凭证」而静默转匿名
    rmSync(shared, { force: true })
    writeFileSync(legacy, '{ 这不是 JSON')
    const a5 = adoptLegacyCred(P)
    must(a5.path === legacy && a5.problem === 'bad-json', `⑤ 坏 JSON 没报 bad-json：${a5.problem}`)
    must(!existsSync(shared), '⑤ 坏 JSON 被搬到了 SHARED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // ⑥ 写 SHARED 失败（父路径是个文件）：路径留在 LEGACY，但凭证必须照样交出来——
  //   迁移失败不等于「这次没登录」，两边都不该因此变成匿名。
  const dir2 = mkdtempSync(join(tmpdir(), 'bw-c16b-'))
  try {
    const blocker = join(dir2, 'blocker')
    writeFileSync(blocker, 'x')
    const legacy2 = join(dir2, 'deps', 'credential.json')
    mkdirSync(dirname(legacy2), { recursive: true })
    writeFileSync(legacy2, JSON.stringify({ sessdata: 's', bili_jct: 'j', buvid3: '3', buvid4: '4' }))
    const a6 = adoptLegacyCred({ shared: join(blocker, 'bili-watch', 'credential.json'), legacy: legacy2 })
    must(a6.path === legacy2, '⑥ 写 SHARED 失败时应继续用 LEGACY 路径')
    must(a6.cred?.sessdata === 's', '⑥ 写 SHARED 失败时没把凭证交出来（CLI 会因此变成匿名）')
    must(a6.problem === 'write-failed', `⑥ 没报 write-failed：${a6.problem}`)
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
  return '两个入口都只认 lib 的判据；真跑六种现场（无/齐/残/已存在/坏JSON/写失败）都对'
})

check('C17 TUNING_DEFS 只有一份（lib/tuning.mjs），18 项齐全，两个入口不许再各写一份（面板改了 CLI 没效果）', () => {
  // 2026-10-31：原来这里比「index.js 与 tools/look.mjs 两份表逐键一致」。
  //   表搬进 lib 之后只剩一份，「两处一致」自动成立——继续比就是恒真断言。
  //   留下的判据：① 表只有一份且 18 项齐全；② 两个入口真的从 lib 引；③ 钳制真跑。
  const grab = (src) => {
    const m = src.match(/const\s+TUNING_DEFS\s*=\s*\{/)
    must(m, 'lib/tuning.mjs 里找不到 TUNING_DEFS 定义')
    const from = src.indexOf('{', m.index)
    let d = 0
    let i = from
    for (; i < src.length; i++) {
      if (src[i] === '{') d++
      else if (src[i] === '}') { d--; if (d === 0) break }
    }
    return src.slice(from, i + 1).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
  }
  const a = grab(read('lib/tuning.mjs'))
  const keys = (a.match(/[A-Za-z_$][\w$]*:\{def:/g) || []).length
  // E6-08（2026-10-30）：阈值原写 13，实际 18 项，删 5 个键照样绿。改成实际值，少一个就红。
  must(keys >= 18, `TUNING_DEFS 只解析到 ${keys} 项，应为 18 项（少一个就说明表被删了）`)
  for (const f of ['index.js', 'tools/look.mjs']) {
    must(!/const\s+TUNING_DEFS\s*=\s*\{/.test(read(f)), `${f} 又写了一份 TUNING_DEFS（第二份真相，「面板改了没效果」就是这么来的）`)
    must(/from '\.\.?\/lib\/tuning\.mjs'/.test(read(f)), `${f} 没从 lib/tuning.mjs 引入（表删了却没接上，运行时会 ReferenceError）`)
  }
  // 钳制真跑：空配置回落默认、越界回落默认、字符串数字接受、上界不误判
  must(normalizeTuning({}).asrMaxSec === 1800, '空配置没回落到默认 asrMaxSec=1800')
  must(normalizeTuning({ asrMaxSec: 99999 }).asrMaxSec === 1800, 'asrMaxSec 越界没回落默认')
  must(normalizeTuning({ asrMaxSec: '600' }).asrMaxSec === 600, 'asrMaxSec 的字符串数字没被接受（Number() 丢了？）')
  must(normalizeTuning({ maxFrames: 1000 }).maxFrames === 1000, 'maxFrames 上界 1000 被误判超界')
  return `${keys} 项单一来源（${a.length} 字符）+ 两入口都从 lib 引 + 钳制真跑 4 例`
})

check('C18 --fresh 只删 manifest.files 记过的文件，绝不按文件名猜（老 manifest 无 files 时一个都不碰）', () => {
  // 定位的是「用户 --out 目录」那一段：它由 Array.isArray(m0?.files) 起。
  // 注意 tools/look.mjs 里还有另一处 if (fresh)（peekFrames，删的是插件自己的缓存目录），不在本守卫范围。
  const src = read('tools/look.mjs')
  const at = src.indexOf('Array.isArray(m0')
  must(at >= 0, '找不到按 manifest.files 清理的那段')
  const ifAt = src.lastIndexOf('if (fresh)', at)
  must(ifAt >= 0, '清理段不在 if (fresh) 里')
  const from = src.indexOf('{', ifAt)
  let d = 0
  let i = from
  for (; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') { d--; if (d === 0) break }
  }
  const body = src.slice(from, i + 1)
  must(body.includes('.files'), '清理段没有按 manifest.files 删')
  must(!body.includes('ownRe'), '清理段又出现 ownRe 命名兜底（用户的 1.jpg 会被删）')
  must(body.includes('没有 files 清单'), '缺少「manifest 无 files 就跳过」的提示')
  return '只按 manifest.files 删，无清单时跳过'
})

// 第十条（2026-10-29）：GPU 加速面板
check('C19 asrDevice 是枚举项：lib/tuning.mjs 写 kind:enum 且钳制跳过它（Math.floor(\'auto\') = NaN）', () => {
  // 2026-10-31：表从两份变一份，检查对象从「两个文件」变成「lib 一处 + 真跑」。
  const lib = read('lib/tuning.mjs')
  must(/asrDevice:\s*\{\s*def:\s*'auto',\s*kind:\s*'enum',\s*values:\s*\['auto',\s*'cpu'\]\s*\}/.test(lib),
    'lib/tuning.mjs 的 asrDevice 定义不对（要 def:\'auto\' + kind:\'enum\' + values [\'auto\',\'cpu\']）')
  must(/if \(d\.kind === 'enum'\)/.test(lib), 'lib/tuning.mjs 的钳制函数没跳过枚举项（Math.floor(\'auto\') = NaN）')
  // 真跑：合法值归一、非法值回落（不暴露强制 cuda，理由见 TUNING_DEFS 里的注释）
  must(normalizeTuning({ asrDevice: 'CPU' }).asrDevice === 'cpu', 'asrDevice=CPU 没归一到 cpu')
  must(normalizeTuning({ asrDevice: 'cuda' }).asrDevice === 'auto', 'asrDevice=cuda 没回落 auto')
  must(normalizeTuning({ asrDevice: 123 }).asrDevice === 'auto', 'asrDevice 非字符串没回落 auto')
  return 'lib 里是枚举项、钳制跳过它；CPU→cpu、cuda→auto、123→auto 真跑'
})

check('C20 GPU 依赖行 + 删除走 pip uninstall + -Target cuda 在、all 不含它', () => {
  const idx = read('index.js')
  must(/id: 'cuda'/.test(idx), 'depRows 里没有 id: cuda 的依赖行')
  // GPU 第二轮：/status 里改成先 `const gpuNow = await gpuStatus()` 再复用给 depRows 与 data.gpu
  //   （一次探测两处用），原来断言写死 `gpu: gpuStatus()` 会误判。改成在 /status 块内同时断言
  //   「有 gpu 字段」+「这个字段来自 gpuStatus」，比原来更贴行为、也不绑具体写法。
  const statusI = idx.indexOf("url.pathname === '/api/bili-watch/status'")
  must(statusI > 0, '找不到 /status 分支')
  const statusBlock = idx.slice(statusI, statusI + 1800)
  must(/gpu:\s*[^,\n]+/.test(statusBlock), '/status 没返回 gpu 字段（面板三态拿不到数据）')
  must(/gpuStatus\(/.test(statusBlock), '/status 的 gpu 不是从 gpuStatus 取的（面板会拿到别的值）')
  const i = idx.indexOf("if (t === 'cuda')")
  must(i > 0, 'deleteDeps 没有 cuda 分支')
  const seg = idx.slice(i, i + 800)
  must(/pip['"],\s*['"]uninstall/.test(seg), 'cuda 删除没走 pip uninstall（只删目录会留 dist-info，重装报「已安装」但文件没了）')
  must(!/rmSync\([^)]*nvidia/.test(seg), 'cuda 删除直接 rmSync 了 nvidia 目录（必须走 pip）')
  // 2026-11-02（fetch-deps 合一）：被测对象从 scripts/fetch-deps.ps1 变成 scripts/fetch-deps.mjs。
  //   断言的意思没变：cuda 必须是一个能被单独选中的 target，但不能混进 all 的步骤表。
  const fd = read('scripts/fetch-deps.mjs')
  must(/TARGETS = \[[^\]]*'cuda'/.test(fd), 'fetch-deps.mjs 的 Target 清单里没有 cuda')
  const stepsM = fd.match(/const STEPS = TARGET === 'all' \? \[([^\]]*)\]/)
  must(stepsM, "fetch-deps.mjs 里找不到 all 的步骤表（const STEPS = TARGET === 'all' ? [...]）")
  must(!/cuda/.test(stepsM[1]), 'all 的步骤表把 cuda 带上了（应当保持「不问、不装 1.4 GB」）')
  return 'deps 行 + /status.gpu + pip uninstall + cuda target 都在，all 不含 cuda'
})

// C21/C22（2026-10-29，rumo-test）：clean 的两条行为第一次真跑。
//   W-04 与 C10 原来都只读源码找子串——实测「…→...」「变量改名但注释留旧名」都能让断言照绿。
//   这里造合法缓存根（.bili-watch-root + BV 目录里的 meta.json；否则 pickCacheDir 会另建
//   bili-watch-cache 子目录，测到的是空目录、什么也证明不了），再真跑一次 clean。
// 2026-10-31 补丁（复核抓到的脆断言）：C64 断的是「默认缓存根」，但它的 env 是
//   {...process.env}——于是这条断言能不能过，取决于**跑它的人 shell 里有没有 BILI_WATCH_CACHE**。
//   DSH 自己带着这个变量跑就 78/1/2，红的正是 C64，报「默认根不对」，其实是外部变量生效了。
//   假红比不红更坏：人会开始不信这条断言，下次真红也就顺手改绿了。
//   凡是「验默认行为」的子进程都从这里出发：先摘掉会改结果的环境变量，再按本场景补自己需要的。
const ENV_LEAKS = ['BILI_WATCH_CACHE', 'BILI_WATCH_PROJ', 'BILI_WATCH_DEPS', 'DSH_HOME']
const baseEnv = (over = {}) => {
  const env = { ...process.env }
  for (const k of ENV_LEAKS) delete env[k]
  return { ...env, ...over }
}
const mkCacheRoot = (tag) => {
  const dir = mkdtempSync(join(tmpdir(), `bw-verify-${tag}-`))
  writeFileSync(join(dir, '.bili-watch-root'), '')
  const bv = join(dir, 'BV1aaaaaaaaa')
  mkdirSync(bv, { recursive: true })
  writeFileSync(join(bv, 'meta.json'), JSON.stringify({ files: ['1.jpg'], at: Date.now() }))
  writeFileSync(join(bv, '1.jpg'), 'x')
  return dir
}
const runClean = (cache) => {
  // 顺手把这一族也收紧（同 baseEnv 的由来）：clean 的判据随 DSH_HOME 里的调优变——
  //   跑的人把 lockTtlMin 调小，C21 的「活锁」就会被判成过期锁而假红。一次临时 home 让它
  //   只用包内默认调优（deps/deps-config.json 里没有 lockTtlMin，缺省 30 分钟）。
  const home = mkdtempSync(join(tmpdir(), 'bw-verify-home-'))
  try {
    const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'clean'], {
      env: baseEnv({ DSH_HOME: home, BILI_WATCH_CACHE: cache }),
      encoding: 'utf8',
      timeout: 120000,
    })
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

check('C21 clean 遇到活锁必须真拒绝：rc≠0 且用户文件一个没动（W-04 的行为版）', () => {
  const cache = mkCacheRoot('live')
  try {
    const fr = join(cache, 'frames')
    mkdirSync(fr, { recursive: true })
    writeFileSync(join(fr, 'BV1aaaaaaaaa-1.jpg'), 'x')
    writeFileSync(join(fr, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), ttlMs: 3600000, owner: 'live' }))
    const r = runClean(cache)
    must(r.code !== 0, `活锁下 clean 还是 rc=0（应当拒绝并退出非 0）；输出：${r.out.slice(0, 160)}`)
    must(existsSync(join(fr, 'BV1aaaaaaaaa-1.jpg')), '活锁下帧文件被删了')
    must(existsSync(join(cache, 'BV1aaaaaaaaa')), '活锁下 BV 目录被删了')
    return `rc=${r.code}，文件与目录都在`
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})

check('C22 clean 遇到残留锁照清：rc=0 且 BV 目录被移除（别把死锁当占用）', () => {
  const cache = mkCacheRoot('stale')
  try {
    const fr = join(cache, 'frames')
    mkdirSync(fr, { recursive: true })
    writeFileSync(join(fr, 'BV1aaaaaaaaa-1.jpg'), 'x')
    writeFileSync(join(fr, '.lock'), JSON.stringify({ pid: 999999, at: Date.now() - 7200000, ttlMs: 60000, owner: 'stale' }))
    const r = runClean(cache)
    must(r.code === 0, `残留锁下 clean 失败 rc=${r.code}：${r.out.slice(0, 160)}`)
    must(!existsSync(join(cache, 'BV1aaaaaaaaa')), '残留锁下 BV 目录没被清掉（把死锁当占用了）')
    return 'rc=0，BV 目录已清'
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})

// 2026-10-29 追加（删除面 / 新增断言，不改任何老断言）：
//   isOurCacheRoot 是「删之前先问一句这是不是我们的根」的唯一判据。
//   2026-10-31：它和 isAdoptableDir 都搬进 lib/（各只剩一份），「两处逐字一致」不再是判据——
//   改成「真跑判据 + 钉住四个入口都还在调用」。剩下要防的不再是「两份分叉」，而是
//   「改 lib 时把判据改坏」与「重构调用点时把闸拆了」。
//   编号 C23：C21/C22 已被 dev 517d6bf 占用（clean 遇活锁 rc≠0 / 残留锁照清），合流时留位不撞。
check('C23 删除面守卫真跑：根标记 / 认领判据都对，四个入口都先问一句（P0）', () => {
  const a = read('index.js')
  // 2026-10-31：look.mjs 侧不再单独读——认领判据只剩 lib/cache-path.mjs 一份，在下面真跑。
  // 2026-10-31：isOurCacheRoot 已搬进 lib/cache-own.mjs（只剩一份），「两处一致」作废——改成真跑。
  const own = read('lib/cache-own.mjs')
  const t0 = mkdtempSync(join(tmpdir(), 'bw-c23-root-'))
  try {
    const bare = join(t0, 'bare')
    mkdirSync(bare)
    writeFileSync(join(bare, 'x.txt'), 'x')
    must(isOurCacheRoot(bare) === false, '没有标记文件的目录被判成「我们的缓存根」——clean 会进去删东西')
    writeFileSync(join(bare, '.bili-watch-root'), '{}')
    must(isOurCacheRoot(bare) === true, '带标记文件的目录没被判成缓存根')
    must(isOurCacheRoot(join(t0, 'nope')) === false, '不存在的目录被判成缓存根')
  } finally {
    rmSync(t0, { recursive: true, force: true })
  }
  // 2026-10-31：isAdoptableDir 已搬进 lib/locks.mjs（只剩一份），改成真跑四种目录形态。
  const t = mkdtempSync(join(tmpdir(), 'bw-c23-'))
  try {
    const fresh = join(t, 'nope')
    must(isAdoptableDir(fresh) === true, '不存在的目录没被判成可认领（我们会新建它，这是唯一能认领的三种之一）')
    const empty = join(t, 'empty')
    mkdirSync(empty)
    must(isAdoptableDir(empty) === true, '空目录没被判成可认领')
    const marked = join(t, 'marked')
    mkdirSync(marked)
    writeFileSync(join(marked, '.bili-watch-root'), '{}')
    must(isAdoptableDir(marked) === true, '带标记的目录没被判成可认领')
    const user = join(t, 'user')
    mkdirSync(user)
    writeFileSync(join(user, 'mine.txt'), 'x')
    must(isAdoptableDir(user) === false, '有内容又没有标记的用户目录被判成可认领——pickCacheDir 会写标记，紧接着 clean 就删用户文件')
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
  // 2026-10-31：removeOwned 搬进 lib/cache-own.mjs，闸还在不在要看 lib 那份（不再看两个入口）。
  must(/if \(!isOurCacheRoot\(dir\)\) return/.test(fnBody(own, 'removeOwned')), 'removeOwned 没先判 isOurCacheRoot（删之前不问这是不是我们的根）')
  must(/if \(!isOurCacheRoot\(cacheDir\(\)\)\) return/.test(fnBody(a, 'autoCleanCache')), 'autoCleanCache 没先判 isOurCacheRoot')
  must(/if \(!isOurCacheRoot\(root\)\) return/.test(fnBody(a, 'pruneEmptyDirs')), 'pruneEmptyDirs 没先判 isOurCacheRoot')
  // 认领判据：有内容又没有标记的用户目录，绝不能当成缓存根（否则本次运行就把标记写进去，守卫空转）
  // 2026-10-31：resolveCacheDir 搬进 lib/cache-path.mjs（只剩一份）。结构上钉「还在用
  //   isAdoptableDir」，行为上真跑三种目录形态——只钉字符串的话，把判据反过来写照样绿。
  must(/!isAdoptableDir\(dir\)/.test(fnBody(read('lib/cache-path.mjs'), 'resolveCacheDir')), 'lib 的 resolveCacheDir 没用 isAdoptableDir 判认领')
  const userDir = mkdtempSync(join(tmpdir(), 'bw-c23-user-'))
  const emptyDir = mkdtempSync(join(tmpdir(), 'bw-c23-empty-'))
  try {
    writeFileSync(join(userDir, 'mine.txt'), 'x') // 有内容、没标记 = 用户自己的目录
    must(resolveCacheDir(userDir) === join(userDir, 'bili-watch-cache'), `用户自己的目录被认领了（应退到它下面的专属子目录，实际 ${resolveCacheDir(userDir)}）——pickCacheDir 会写标记，紧接着 clean 就删用户文件`)
    must(resolveCacheDir(emptyDir) === emptyDir, '空目录没被认领（会平白多一层 bili-watch-cache）')
    writeFileSync(join(emptyDir, '.bili-watch-root'), '{}')
    writeFileSync(join(emptyDir, 'x.txt'), 'x')
    must(resolveCacheDir(emptyDir) === emptyDir, '带标记的目录没被认领（已有内容也不该再套子目录）')
  } finally {
    rmSync(userDir, { recursive: true, force: true })
    rmSync(emptyDir, { recursive: true, force: true })
  }
  return 'isOurCacheRoot 3 态 + isAdoptableDir 4 态 + resolveCacheDir 3 态真跑；removeOwned / autoCleanCache / pruneEmptyDirs 的闸都还在'
})

// 追加四（2026-10-29）：旧缓存提示既不能漏、也不能滥。真跑 clean 验三种场景，
// 因为这条的行为是「打一行字 + 一个文件都不删」，静态读源码证明不了。
check('C24 旧缓存提示：有内容无标记才提示，且用户文件一个不删（P0 不删）', () => {
  const mkUserDir = (tag, { mark = false, files = false } = {}) => {
    const d = mkdtempSync(join(tmpdir(), `bw-c24-${tag}-`))
    if (mark) writeFileSync(join(d, '.bili-watch-root'), '{}')
    if (files) {
      mkdirSync(join(d, 'BV1aaaaaaaaa'), { recursive: true })
      writeFileSync(join(d, 'BV1aaaaaaaaa', 'mine.mp4'), 'x')
      writeFileSync(join(d, 'BV1bbbbbbbbb.mp4'), 'x')
    }
    return d
  }
  const dirs = []
  try {
    // ① 有内容、没标记：必须提示，且一个用户文件都不动
    const dirty = mkUserDir('dirty', { files: true }); dirs.push(dirty)
    const r1 = runClean(dirty)
    must(r1.code === 0, `脏目录 clean 非 0：rc=${r1.code} ${r1.out.slice(0, 160)}`)
    must(/发现旧缓存/.test(r1.out), '有内容且无标记时没出旧缓存提示（用户会以为清干净了）')
    must(!/--adopt/.test(r1.out), '提示里出现了 --adopt，但 0.3.6 还没有这个参数')
    must(existsSync(join(dirty, 'BV1aaaaaaaaa', 'mine.mp4')), '提示场景下删了用户的 mine.mp4')
    must(existsSync(join(dirty, 'BV1bbbbbbbbb.mp4')), '提示场景下删了用户的 BV 文件')
    // ② 空目录：不许提示
    const empty = mkUserDir('empty'); dirs.push(empty)
    must(!/发现旧缓存/.test(runClean(empty).out), '空目录也提示了（会变成噪音）')
    // ③ 已带标记（本来就是我们的根）：不许提示
    const marked = mkUserDir('marked', { mark: true, files: true }); dirs.push(marked)
    must(!/发现旧缓存/.test(runClean(marked).out), '已认领的根也提示了')
    return '脏目录提示且不删、空目录不提示、已认领不提示'
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  }
})

// 追加五（2026-10-30）：E6-02 的两侧分叉——抽 BV 的防护原先只在插件侧，
// CLI 的 positional 是原样接的（模型把整条链接传进来更常见），会把 http 开头的串当目录名。
check('C25 bvOf 从整条链接抽 BV（E6-02，P0：不许造出 http 开头的目录名）', () => {
  // 2026-10-31：原来比「两处 bvOf 函数体相等」，再手工跑一次正则——
  //   前者函数搬进 lib/ 后必然失效；后者是「用另一份实现验证这份实现」，等于自证。
  //   现在直接 import 真跑，并把「抽出来再进 cleanKey 会不会还是 http 开头」也钉住。
  const cases = [
    ['https://www.bilibili.com/video/BV1xx411c7mD?p=1&t=3', 'BV1xx411c7mD', '整条链接'],
    ['BV1xx411c7mD', 'BV1xx411c7mD', '裸 BV 号'],
    ['【标题】BV1xx411c7mD 第3P', 'BV1xx411c7mD', '带标题与噪音'],
    ['b23.tv/abc123', 'b23.tv/abc123', '短链没解析出 BV 时原样返回（再由 cleanKey 压成安全名）'],
    ['', '', '空输入原样返回'],
  ]
  for (const [inp, want, why] of cases) {
    const got = bvOf(inp)
    must(got === want, `bvOf(${JSON.stringify(inp)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}（${why}）`)
  }
  // 端到端：整条链接 → bvOf → cleanKey，结果绝不能还是 http 开头（否则缓存里出现 httpbilibili… 目录）
  const k = cleanKey(bvOf('https://www.bilibili.com/video/BV1xx411c7mD?p=1&t=3'))
  must(!/^http/i.test(k), `整条链接经过 bvOf→cleanKey 后仍是 http 开头：${k}`)
  must(k === 'BV1xx411c7mD', `整条链接经 bvOf→cleanKey 后应等于 BV1xx411c7mD，实际 ${k}`)
  // 2026-10-31：videoDir 搬进 lib/cache-path.mjs，两处变一处——盯那份唯一实现
  must(/cleanKey\(bvOf\(/.test(fnBody(read('lib/cache-path.mjs'), 'videoDir')), 'lib/cache-path.mjs 的 videoDir 没走 bvOf')
  return `${cases.length} 条输入 + 端到端不落 http 名 + videoDir 走 bvOf`
})

// #1（2026-10-30 E8 总表）：删除面有两个入口——用户点清理走 removeOwned，自动清理走 autoCleanCache → walkEntries
//   → isOwnedEntry。removeOwned 早就改成「名字 + meta.json」，isOwnedEntry 却还按 /^BV…/ 名字直接认领，
//   于是用户在缓存根放一个自己的 BV1234567890/ 会被自动清理连文件一起删。
//   2026-10-31：两个入口的实现搬进 lib/cache-own.mjs，物理上只剩一份——「两处一致」不再需要断言，
//   但「判据本身对不对」更要紧（只剩一份时改坏一处就是两个入口一起坏）。所以保留「必须走 isOwnBvDir」
//   的结构钉，其余全部改成 import 真跑。
check('C26 自动清理与手点清理同一认领判据：BV 目录必须有 meta.json 或为空（#1，P0：别按名字删）', () => {
  const own = read('lib/cache-own.mjs')
  const ea = fnBody(own, 'isOwnedEntry')
  must(/return isOwnBvDir\(/.test(ea), 'isOwnedEntry 没走 isOwnBvDir（还在按名字认领）')
  must(!/\^BV\[0-9A-Za-z\]\{10\}\/i\.test\(first\)\)\s*return true/.test(ea), 'isOwnedEntry 里仍有「按名字直接 return true」')
  const dir = mkdtempSync(join(tmpdir(), 'bw-c26-'))
  try {
    writeFileSync(join(dir, '.bili-watch-root'), '{}')
    mkdirSync(join(dir, 'BV1aaaaaaaaa'))
    writeFileSync(join(dir, 'BV1aaaaaaaaa', 'meta.json'), '{}')
    mkdirSync(join(dir, 'BV9999999999'))
    writeFileSync(join(dir, 'BV9999999999', 'mine.mp4'), 'x')
    mkdirSync(join(dir, 'BV1234567890extra'))
    writeFileSync(join(dir, 'BV1234567890extra', 'mine.mp4'), 'x')
    // videoDir 的真实命名是「BV_标题」，右边界 (_|$) 就是为它留的
    mkdirSync(join(dir, 'BV1bbbbbbbbb_标题'))
    writeFileSync(join(dir, 'BV1bbbbbbbbb_标题', 'meta.json'), '{}')
    mkdirSync(join(dir, 'BVcccccccccc'))

    // ① 自动清理侧（isOwnedEntry，缓存根由参数传入）
    must(isOwnedEntry(dir, join(dir, 'BV1aaaaaaaaa')) === true, '有 meta.json 的 BV 目录没被认领（会漏删自己的）')
    must(isOwnedEntry(dir, join(dir, 'BV9999999999')) === false, '用户自己的 BV 目录被认领了（自动清理会删里面的文件）')
    must(isOwnedEntry(dir, join(dir, 'BV1234567890extra')) === false, 'BV 前缀陷阱被认领了（正则缺右边界）')
    // 右边界 (_|$)：videoDir 的命名是「BV_标题」，少了它自己的缓存目录不被认领，自动清理永远漏删这一批
    must(isOwnedEntry(dir, join(dir, 'BV1bbbbbbbbb_标题')) === true, 'BV_标题 自建目录没被认领（正则右边界 (_|$) 掉了）')

    // ② 手点清理侧（isOwnBvDir 是 removeOwned 用的判据，同一份实现）
    must(isOwnBvDir(join(dir, 'BV1aaaaaaaaa'), 'BV1aaaaaaaaa') === true, 'clean 侧：有 meta.json 的 BV 目录没被认领')
    must(isOwnBvDir(join(dir, 'BV9999999999'), 'BV9999999999') === false, 'clean 侧：用户自己的 BV 目录被认领了')
    // 右边界（WB-CN 2026-10-30 扰动实测补的）：三条用例原来全是「恰好 BV+10 位」，$ 和 (_|$) 都能过，
    //   把 `(_|$)` 改回 `$` 时 C26 照样全绿。右边界真正管的是「BV_标题」这种自建目录——
    //   少了它，自己建过的缓存目录不被认领，clean 永远清不掉（漏删比误删难发现）。
    must(isOwnBvDir(join(dir, 'BV1bbbbbbbbb_标题'), 'BV1bbbbbbbbb_标题') === true, 'clean 侧：BV_标题 自建目录没被认领（正则右边界 (_|$) 掉了，clean 清不掉自己的缓存）')
    must(isOwnBvDir(join(dir, 'BV1234567890extra'), 'BV1234567890extra') === false, 'clean 侧：BV 前缀陷阱被认领了（正则右边界松了）')
    // 空目录也要认领（E7 那条放宽：空目录说明是我们建过又清空的）
    must(isOwnBvDir(join(dir, 'BVcccccccccc'), 'BVcccccccccc') === true, 'clean 侧：空 BV 目录没被认领（清不掉会留垃圾）')

    return 'isOwnedEntry(root,p) 4 例 + isOwnBvDir 5 例，两个删除入口同一份实现都说 4 例/5 例一致'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// #6（2026-10-30 E8 总表）：安装脚本原本只选 Python 3.10–3.13（理由是「onnxruntime 没 cp314 wheel」，
//   该理由当天被实测推翻，脚本已把 3.14 收进候选，见 C30）。但「已就绪」判据一直是「文件在不在」，
//   用户机器上早先由 3.14 建的 venv 照绿，跑起来才在 import 炸。
//   这条钉住失败文案要点名环境版本（不改判据——3.14 能跑，硬拒会误伤）。
check('C27 环境用 Python 3.14 建时，ASR/OCR 失败文案要点名（#6：别只说「导入失败」）', () => {
  const src = read('tools/look.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'bw-c27-'))
  try {
    const v314 = join(dir, 'v314', '.venv-asr')
    mkdirSync(join(v314, 'Scripts'), { recursive: true })
    writeFileSync(join(v314, 'pyvenv.cfg'), 'version = 3.14.6\n')
    const v312 = join(dir, 'v312', '.venv-asr')
    mkdirSync(join(v312, 'Scripts'), { recursive: true })
    writeFileSync(join(v312, 'pyvenv.cfg'), 'version = 3.12.13\n')
    const { pyEnvNote } = compile(src, ['pyEnvNote'], {
      params: ['join', 'dirname', 'readFileSync'],
      args: [join, dirname, readFileSync],
    })
    const a = pyEnvNote(join(v314, 'Scripts', 'python.exe'))
    const b = pyEnvNote(join(v312, 'Scripts', 'python.exe'))
    must(a.includes('3.14'), '3.14 建的环境没被点名：' + JSON.stringify(a))
    must(b === '', '3.12 建的环境不该提示，实际：' + JSON.stringify(b))
    must(/pyEnvNote\(ASR_PY\)/.test(src), 'ASR 失败文案没接 pyEnvNote')
    must(/pyEnvNote\(OCR_PY\)/.test(src), 'OCR 失败文案没接 pyEnvNote')
    return '3.14 点名、3.12 不提示、ASR/OCR 两条失败出口都接了'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// E7-01（2026-10-30，P0）：闸门原来只写在 cmdText 的降级分支里，cmdAsr 完全没有——直接跑到
//   「[asr] GPU 转写失败，回落 CPU：bad allocation」。WBin 真跑一次 asr 才暴露。
//   这条把 canRunAsr 真函数抽出来跑四种组合（不只看文案里有没有「可用内存」这几个字）。
check('C28 asr 闸门两条腿：时长超限拒绝、长片内存不足拒绝、短片不受内存约束（E7-01，P0）', () => {
  const src = read('tools/look.mjs')
  const mk = (freeMB) => compile(src, ['canRunAsr', 'fmtSec'], {
    prelude: [
      "const ASR_PY = 'X/python.exe'",
      "const ASR_SCRIPT = 'X/asr.py'",
      'const asrReady = () => true',
      'const tuning = () => ({ asrMaxSec: 1800, asrMemMB: 1536 })',
      'const freemem = () => ' + (freeMB * 1024 * 1024),
    ].join('\n'),
  }).canRunAsr

  const overTime = mk(8000)(2000)                        // 33 分钟 > 30 分钟闸门
  must(overTime.ok === false, '时长超限没拒绝')
  must(/转写闸门/.test(overTime.why), '时长拒绝的文案没提转写闸门：' + overTime.why.slice(0, 60))

  const lowMemLong = mk(800)(900)                        // 15 分钟片 + 0.78 GB 可用
  must(lowMemLong.ok === false, '长片内存不足没拒绝')
  must(/可用内存/.test(lowMemLong.why), '内存拒绝的文案没提可用内存：' + lowMemLong.why.slice(0, 60))
  // 文案要给人「怎么办」，不能只是个数字（mkl_malloc 允许出现在解释里，它说明为什么会崩）
  must(/抽帧|关掉|别的程序/.test(lowMemLong.why), '内存拒绝的文案没给替代方案：' + lowMemLong.why.slice(0, 80))

  const lowMemShort = mk(800)(120)                       // 2 分钟片不受内存判据约束
  must(lowMemShort.ok === true, '短片被内存判据误拒了')

  const okLong = mk(8000)(900)
  must(okLong.ok === true, '长片内存充足却被拒了：' + JSON.stringify(okLong))

  // 调用点在 transcribe 里，两条入口共用（cmdAsr / cmdText 不必各写一遍）
  must(/canRunAsr\(/.test(src), '找不到 canRunAsr')
  const calls = (src.match(/canRunAsr\(/g) || []).length
  must(calls >= 2, 'canRunAsr 只有定义没调用点（期望至少「定义 + transcribe 里一次」），实际 ' + calls)
  return '时长/内存两条腿都拒绝，短片放行，transcribe 内统一调用'
})

// E7-02（2026-10-30，P0）：--out 黑名单由 checkOutDir 抛错拦住，但外层 catch 调 emitFailureJson，
//   它读同一个 opt('out') 把「拒绝原因」写进被拒的位置——实测 rc=1 的同时
//   stderr 打着「✓ 已写入 C:/Windows/Temp/…」，文件真的落在系统目录。这条真跑子进程验三个事实。
check('C29 --out 指向系统目录：rc≠0、目标文件不创建、正文退回 stdout（E7-02，P0）', () => {
  const bad = 'C:\\Windows\\Temp\\bw-c29-should-not-exist.json'
  rmSync(bad, { force: true })
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'look.mjs'), 'clean', '--out', bad], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, BILI_WATCH_CACHE: mkdtempSync(join(tmpdir(), 'bw-c29-cache-')) },
  })
  must(r.status !== 0, 'rc 应该非零，实际 ' + r.status)
  must(!existsSync(bad), '目标文件被创建了——错误处理器绕过了黑名单：' + bad)
  must(/不能指向系统目录/.test(String(r.stderr || '')), 'stderr 没说明拒绝原因：' + String(r.stderr || '').slice(0, 120))
  must(!/已写入/.test(String(r.stderr || '')), 'stderr 里出现了「已写入」（说明它真写了被拒的位置）')
  // 合法路径仍要能写：别修成「一律不写」
  const okPath = join(mkdtempSync(join(tmpdir(), 'bw-c29-ok-')), 'out.json')
  const r2 = spawnSync(process.execPath, [join(ROOT, 'tools', 'look.mjs'), 'clean', '--out', okPath], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, BILI_WATCH_CACHE: mkdtempSync(join(tmpdir(), 'bw-c29-cache2-')) },
  })
  // clean 本来就不落 --out（它只打报告），所以这里只验「合法路径不被误拒」，不验写没写文件
  must(r2.status === 0, '合法 --out 被误拒了：rc=' + r2.status + ' err=' + String(r2.stderr || '').slice(0, 120))
  must(!/不能指向/.test(String(r2.stderr || '')), '合法路径也报了「不能指向」')
  return '系统目录 rc≠0 且文件没建、文案说明了原因；合法路径照常写'
})

// E6 补充（2026-10-30，B 方案后修订）：仓库根曾有一份 fetch-deps.ps1，与 scripts/ 那份逐字相同，
//   却没有任何引用（代码走 join(SCRIPTS,'fetch-deps.ps1')，README 也只写 scripts\ 路径）。
//   两份并存时改一份就静默分叉，所以 2026-10-30 把根目录那份移进 备份\，只留 scripts/ 一份。
//   这条现在守的是「只能有一份」：根目录再出现同名文件，就是又长出了第二个真相源。
//   同时钉住 3.14 判据本身：这是「PR#4 的前提已被实测推翻」那处修复的承重点，
//   只钉「文件唯一」是不够的——把正则改回 1[0-3] 照样绿（见 E6-08 的结构性天花板）。
// 2026-11-02（fetch-deps 合一）：被测对象从 .ps1 换成 .mjs，断言意思不变——
//   ① 只能有一份（多一份就是第二个真相源）；② Python 版本正则必须收到 3.14。
check('C30 fetch-deps 只应有一份（在 scripts/）+ Python 版本正则收 3.14（E8 #6）', () => {
  const b = join(ROOT, 'scripts', 'fetch-deps.mjs')
  must(existsSync(b), 'scripts/fetch-deps.mjs 不存在——插件调的就是这一份')
  must(
    !existsSync(join(ROOT, 'fetch-deps.mjs')),
    '根目录又出现了 fetch-deps.mjs：插件只调 scripts/ 那份，多一份就是第二个真相源，请删掉或移进备份',
  )
  // 合并前的两份实现（.ps1 / .sh）如果还留着，就是「一份名义上删了、一份还在跑」的形状
  for (const old of ['fetch-deps.ps1', 'fetch-deps.sh']) {
    must(!existsSync(join(ROOT, 'scripts', old)), `scripts/${old} 还在——合并后只该有 fetch-deps.mjs，旧实现留着就是第二份真相源`)
  }
  const body = read('scripts/fetch-deps.mjs')
  // 判据承重点：Python 版本判定必须收到 3.14
  const m = /function pyOk\(v\) \{\s*return \/([^/]+)\//.exec(body)
  must(m, '找不到 pyOk 的版本正则')
  must(/1\[0-4\]/.test(m[1]), `pyOk 的正则仍是 /${m[1]}/——3.14 会被硬拒（实测 3.14.6 的 venv 里 onnxruntime 1.31.1 可用）`)
  must(!/return \(\$v -match/.test(body), '还残留 PowerShell 写法（$v -match）——看起来是没搬完')
  return `判据 /${m[1]}/ 已收 3.14；全仓只有 scripts/ 一份（${readFileSync(b).length} B）`
})

// E4-02（2026-10-30，P0）：删 credential 时后端会**同时** push deleted 与 skipped
//   （SHARED 那份删掉了、LEGACY 那份 rm 失败，或者反过来）。前端单条删除原来写的是
//   `d.deleted?.length ? 已删除 : 未删除`，于是只报「已删除 credential」，skipped 里的原因被整条吞掉。
//   注：B 方案（当天下午）已经把「同机别的工具写的凭证」这个 skipped 来源拿掉了，
//   但「删了 A 没删掉 B」的形状仍然存在（文件被占用 / 权限不足），所以这条断言继续有效，
//   喂的载荷换成仍然可能发生的那种原因。
//   这条把 fmtDelMsg 抽出来真跑：只查「源码里有没有 skipped」挡不住它（原来那行也有 skipped）。
check('C31 删除结果消息：deleted 与 skipped 同时非空时不许只报成功（E4-02，P0）', () => {
  const { fmtDelMsg } = compile(read('client.js'), ['fmtDelMsg'])
  // ① E4-02 的真实形状：一份删掉了，另一份没删掉，watch 还会接着用它
  const m1 = fmtDelMsg({
    deleted: ['credential'],
    skipped: [{ id: 'credential', why: '旧位置的凭证删不掉（文件被占用），watch 还会继续用它' }],
  })
  must(/已删除/.test(m1), '① 没报已删除：' + m1)
  must(/继续用它/.test(m1), '① 把 skipped 的原因吞了——这正是 E4-02：' + m1)
  // ② 干净删掉：不该冒出「跳过」
  const m2 = fmtDelMsg({ deleted: ['ytdlp'], skipped: [] })
  must(/已删除/.test(m2), '② 没报已删除：' + m2)
  must(!/跳过/.test(m2), '② 干净删除却出现了「跳过」：' + m2)
  // ③ 什么都没删：必须说清原因，不能只说「未删除」
  const m3 = fmtDelMsg({ deleted: [], skipped: [{ id: 'model', why: '本来就不存在' }] })
  must(/未删除/.test(m3) && /本来就不存在/.test(m3), '③ 没说清为什么没删：' + m3)
  // ④ 空载荷不许抛
  const m4 = fmtDelMsg({})
  must(/未删除/.test(m4), '④ 空载荷应报未删除：' + m4)
  // ⑤ 单条与批量必须共用同一份拼装——否则又会各说各话
  const src = read('client.js')
  const calls = (src.match(/setMsg\(fmtDelMsg\(/g) || []).length
  must(calls >= 2, `只找到 ${calls} 处 setMsg(fmtDelMsg(...))：单条删除与批量删除应共用同一份拼装`)
  return `四种载荷都对（含「删了但没删干净」），${calls} 处调用共用同一份拼装`
})

// E1-01（2026-10-30，P0）：下载结束写「（成功）」的依据原来是退出码 0。
//   Windows 上 DSH 跑在带 KILL_ON_JOB_CLOSE 的 Job Object 里，宿主一停整棵树被内核回收，
//   下载进程跟着死——而日志照样写「退出码 0（成功）」。PR#4 修的是同一功能的另一面
//   （detached:true 让脚本一行不执行），两个方向都没对：真正的错是「用退出码当成功判据」。
//   这条把 downloadVerdict 抽出来真跑，喂「退出码 0 但产物没就绪」这个真实形状。
check('C32 下载结束的「成功」必须由产物推导，不能只看退出码 0（E1-01，P0）', () => {
  const src = read('index.js')
  // 目标映射从源码里取，不手抄——否则测试里那份会和实现分叉
  const mapSrc = /const DOWNLOAD_TARGET_DEPS = \{[\s\S]*?\n\}/.exec(src)
  must(mapSrc, '找不到 DOWNLOAD_TARGET_DEPS')
  const { downloadVerdict } = compile(src, ['downloadVerdict'], { prelude: mapSrc[0] })
  const rows = (pairs) => pairs.map(([id, ok]) => ({ id, ok }))

  // ① 退出码 0 且产物就绪 → 才算成功
  const v1 = downloadVerdict('ytdlp', 0, null, rows([['ytdlp', true]]))
  must(v1.ok, '① 产物就绪却判失败：' + v1.note)
  // ② 就是 E1-01 的真实形状：退出码 0，但 yt-dlp 还是不可用
  const v2 = downloadVerdict('ytdlp', 0, null, rows([['ytdlp', false]]))
  must(!v2.ok, '② 退出码 0 就判成功——这正是 E1-01：' + v2.note)
  must(/仍不可用/.test(v2.note), '② 没说清「没装好」：' + v2.note)
  // ③ 查不到产物时不许谎称成功
  const v3 = downloadVerdict('ytdlp', 0, null, null)
  must(!v3.ok, '③ depRows 失败却判成功：' + v3.note)
  // ④ 非零退出码、信号，仍按失败
  must(!downloadVerdict('ytdlp', 1, null, null).ok, '④ 退出码 1 应失败')
  must(!downloadVerdict('ytdlp', 0, 'SIGTERM', rows([['ytdlp', true]])).ok, '④ 收到信号应失败')
  // ⑤ -Target all 只要有一项没就绪就不能算成功（且要点名是哪项）
  const v5 = downloadVerdict('all', 0, null, rows([['ytdlp', true], ['ffmpeg', true], ['asr', false], ['ocr', true], ['model', true]]))
  must(!v5.ok, '⑤ all 有缺项却判成功：' + v5.note)
  must(/asr/.test(v5.note), '⑤ 没点名缺的是哪一项：' + v5.note)
  // ⑥ 退出处理器必须真的用了这个判据
  must(/downloadVerdict\(/.test(src.slice(src.indexOf("child.on('exit'"))), "child.on('exit') 里没调用 downloadVerdict")
  return '产物就绪才算成功；退出码 0 但缺项会点名；查不到产物不谎称成功'
})

// 2026-10-30（用户要求「全面搜一轮本机泄漏」）：把「哪些字面量不许进包」变成一条可执行的断言。
//   检查面 = 发布面：文件清单直接从 package.json 的 files 取，不手写——手写就会漏掉以后新增的文件。
//   注意：C:\Windows / C:\Program Files 这类**系统目录**不算泄漏（它们是判据要拦的目标），
//   所以盘符规则只扫 C:\Users 与 D–Z 盘，避免把黑名单示例本身判成泄漏。
//
//   2026-10-30：本机身份类字面量一律不写死在源码里。
//   原先这里写死了三份身份（一个 Windows 用户名、一个 B 站昵称、一个 B 站 mid）——而本文件会进公开仓库，
//   等于拿「防泄漏清单」本身去泄漏真实身份（用户名还好，昵称和 mid 是能直接定位到人的）。
//   现在三种来源，按优先级合并去重：
//     ① 环境变量 BILI_WATCH_LEAK_IDS（逗号/空白分隔）
//     ② 仓库外的 `.leak-ids`（一行一个，# 注释，已 gitignore）——发布树天然没有这个文件，
//        所以在发布树跑自检时这两类会跳过，结果里会明说少扫了什么，不会假装扫过。
//     ③ 环境里的用户名（USERNAME / USER）
//   取不到的那一项跳过：纯 ASCII 短名（<4）几乎必然误报（`\busr\b` 之类），
//   宁可少扫一项，也不要让别的机器一跑就假红；中文昵称按 ≥2 字放宽。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LOCAL_USER = (process.env.USERNAME || process.env.USER || '').trim()
const okId = (s) => s.length >= 4 || (/[^\x00-\x7F]/.test(s) && s.length >= 2)
const IDENTITY_IDS = (() => {
  const fromEnv = String(process.env.BILI_WATCH_LEAK_IDS || '').split(/[,，\s]+/).filter(Boolean)
  let fromFile = []
  try {
    fromFile = readFileSync(join(ROOT, '.leak-ids'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  } catch { /* 没有这个文件是正常情况（发布树、别人的机器） */ }
  return [...new Set([...fromEnv, ...fromFile].map((s) => s.trim()).filter(okId))]
})()
const IDENTITY_WORDS = [...new Set([LOCAL_USER, ...IDENTITY_IDS].filter(okId))]
const LEAK_PATTERNS = [
  [/\bbili-duty\b|\bbili-panel\b|_bili-duty/, '同机其它工具的名字'],
  // 身份这一条不加 \b：中文昵称前后都不是 ASCII 单词字符，加了反而永不命中
  ...(IDENTITY_WORDS.length ? [[new RegExp(`(?:${IDENTITY_WORDS.map(escapeRe).join('|')})`), '本机身份（用户名 / 昵称 / mid）']] : []),
  [/Dsh工作区|DeepSeek-Harness|GPT-SoVITS|刷B站|surf CORE/, '本机路径 / 其它项目名'],
  [/C:[\\/]Users[\\/]/, 'C 盘用户目录'],
  // 盘符路径：前面不能是字母（否则 `HKCU:\` 的 `U:`、模板串里 `OCR:\n` 的 `R:` 会误报），
  //   后面必须还有路径字符（否则注释里的占位符 `X:\` 会误报）。
  [/(^|[^A-Za-z])[D-Z]:[\\/]\S/, '本机盘符绝对路径'],
]
check('C33 打包文件里零本机字面量：昵称 / 盘符路径 / 其它工具名（用户要求全面清查）', () => {
  const pkg = JSON.parse(read('package.json'))
  const files = [...(pkg.files || []), 'package.json']
  must(files.length > 5, 'files 白名单解析失败：' + files.length)
  const hits = []
  for (const f of files) {
    let s
    try { s = read(f) } catch { continue } // files 里可能有本机未生成的路径
    for (const [re, why] of LEAK_PATTERNS) {
      const m = re.exec(s)
      if (m) hits.push(`${f} → ${why}：${JSON.stringify(m[0])}`)
    }
  }
  must(!hits.length, '打包文件里有本机字面量：\n  ' + hits.join('\n  '))
  // 不打印身份值本身（那等于在日志里再泄漏一次），只说扫了几个、覆盖到哪几类
  const idNote = IDENTITY_WORDS.length
    ? `身份项 ${IDENTITY_WORDS.length} 个`
    : '身份项 0 个（用户名取不到、也没有 .leak-ids → 昵称/mid 两类没扫）'
  return `${files.length} 个打包文件零命中（${LEAK_PATTERNS.length} 类规则；${idNote}）`
})

// E6-07 / E3-03（2026-10-30，P1）：符号链接口径。两处注释都写「与对方同口径」，实际都不成立：
//   dirStat 在 index.js 是 `else`（链接按自身大小计入），在 tools/look.mjs 是 `else if (e.isFile())`
//   （链接两个分支都不进，直接跳过）；walkEntries 又用 statSync 取大小（= 目标大小）。
//   后果：「已清理 X MB」按目标大小虚高，而 rmSync 只删链接本身。
//   这条不靠字符串：造一份假 dirent 列表真跑 dirStat / walkEntries，看它把链接算成多少。
check('C34 符号链接口径统一：dirStat 按 lstat 计、walkEntries 也按 lstat（E6-07，P1：已清理 MB 会虚高）', () => {
  const ents = [
    { name: 'a.txt', isDirectory: () => false, isFile: () => true },
    { name: 'link', isDirectory: () => false, isFile: () => false }, // 符号链接：两个 is* 都 false
  ]
  const readdirSync = () => ents
  // 文件 100 B、链接自身 7 B；stat 会跟到目标（9999 B）——用它就说明口径错了
  const lstatSync = (p) => ({ size: String(p).endsWith('link') ? 7 : 100, mtimeMs: 1 })
  const statSync = () => { throw new Error('用了 statSync（会跟到链接目标）') }
  // 2026-10-31：dirStat 搬进 lib/cache-own.mjs，只剩一处实现——「两处口径统一」不再是判据，
  //   但「口径本身对不对」仍要钉：喂同一个假 fs，看它怎么算链接。
  for (const [label, src] of [['lib/cache-own.mjs', read('lib/cache-own.mjs')]]) {
    const { dirStat } = compile(src, ['dirStat'], {
      prelude: `const CACHE_MARK = '.bili-watch-root'`,
      params: ['readdirSync', 'lstatSync', 'statSync', 'join'],
      args: [readdirSync, lstatSync, statSync, join],
    })
    const r = dirStat('/fake')
    must(r.files === 2, `${label} 的 dirStat 少算了符号链接（files=${r.files}，应为 2）`)
    must(r.bytes === 107, `${label} 的 dirStat 体积口径不对（bytes=${r.bytes}，应为 107 = 文件 100 + 链接自身 7）`)
  }
  const { walkEntries } = compile(read('index.js'), ['walkEntries'], {
    prelude: `const CACHE_MARK = '.bili-watch-root'\nfunction isOwnedEntry() { return true }`,
    params: ['readdirSync', 'lstatSync', 'statSync', 'join'],
    args: [readdirSync, lstatSync, statSync, join],
  })
  const out = walkEntries('/fake')
  must(out.length === 2, `walkEntries 还在用 statSync 取大小（条目数 ${out.length}，应为 2）`)
  must(out.find((e) => e.path.endsWith('link'))?.size === 7, 'walkEntries 把链接按目标大小算了')
  return 'dirStat（lib，唯一一份）按 lstat 计链接；walkEntries 也用 lstat'
})

// #9（2026-10-30，P1）：/download 回包是 { ok, data: { results: [...] } }。单条路径 2026-10-29
//   改成按 results 读了，批量路径还在看扁平 j.ok / j.why——后端 ok:true 但目标没启动时（宿主
//   Job Object 被杀、脚本不存在、目标名不认识），批量把失败算成成功，报的原因还是 request()
//   补的「HTTP 400」，与真实原因完全无关。这条把 readDownloadResp 抽出来真跑三种真实形状。
check('C35 批量下载必须读 data.results[].why，不能只看 ok（#9，P1：报的原因与真实原因无关）', () => {
  const src = read('client.js')
  const { readDownloadResp } = compile(src, ['readDownloadResp'])
  // ① 后端 400：每一项自己的 why 才是原因
  const r1 = readDownloadResp({
    ok: false,
    why: 'HTTP 400',
    data: { results: [{ started: false, why: '插件目录里没有 scripts/fetch-deps.ps1' }], started: 0 },
  })
  must(r1.allStarted === false, '① 目标没启动却判成成功')
  must(/fetch-deps\.ps1/.test(r1.why), '① 没取到 results[].why，拿到的是：' + r1.why)
  // ② ok:true 但目标没启动——这正是 #9 的形状
  const r2 = readDownloadResp({ ok: true, data: { results: [{ started: false, why: '下载进程被宿主带走' }], started: 0 } })
  must(r2.allStarted === false, '② ok:true 时把「没启动」算成了成功')
  // ③ 正常启动
  const r3 = readDownloadResp({ ok: true, data: { results: [{ started: true, log: 'deps/download.log' }], started: 1 } })
  must(r3.allStarted === true && r3.log === 'deps/download.log', '③ 正常启动被判失败')
  // ④ 两处调用点共用同一份解读（定义 1 + 单条 1 + 批量 1）
  const n = (src.match(/readDownloadResp\(/g) || []).length
  must(n >= 3, `只找到 ${n} 处 readDownloadResp：单条与批量应共用同一份解读`)
  return '三种形状都对；单条与批量共用同一份解读'
})

// #10（2026-10-30，P1）：/login/poll 的 500 分支原来没有 state，前端把 undefined 当「等待中」
//   无限重试。这条真跑 pollStep 五种输入，并钉住后端异常分支也必须带 state。
check('C36 登录轮询：认不出的 state 不许当「等待中」（#10，P1：界面会永远等待中）', () => {
  const { pollStep } = compile(read('client.js'), ['pollStep'])
  const ok = pollStep({ state: 'ok' })
  must(ok.act === 'ok', 'state=ok 应结束并保存')
  const exp = pollStep({ state: 'expired' })
  must(exp.act === 'stop' && exp.state === 'expired', 'state=expired 应停下')
  const err = pollStep({ state: 'error', why: '凭证写入失败' })
  must(err.act === 'stop' && /凭证写入失败/.test(err.why), 'state=error 应停下并带上原因')
  const wait = pollStep({ state: 'waiting' })
  must(wait.act === 'wait', 'state=waiting 应继续等')
  // ⑤ 后端 500 的形状：{ ok:false, why:'HTTP 500：…' }，没有 state
  const bad = pollStep({ ok: false, why: 'HTTP 500：轮询失败' })
  must(bad.act === 'retry', '没有 state 时被当成了「等待中」——这正是 #10')
  must(/HTTP 500/.test(bad.why), '没有 state 时没把后端的原因带出来')
  // 后端：/login/poll 分支必须自己接住异常并给 state
  const idx = read('index.js')
  const i = idx.indexOf("url.pathname === '/api/bili-watch/login/poll'")
  must(i > 0, '找不到 /login/poll 路由')
  const seg = idx.slice(i, i + 800)
  must(/catch/.test(seg), '/login/poll 没接住 loginPollOnce 抛错——会冒到最外层 500，回包没有 state')
  must(/state:\s*'error'/.test(seg), "/login/poll 的异常分支没写 state:'error'")
  return '五种状态都对（含后端 500 的无 state 形状）；后端异常也带 state'
})

// #12（2026-10-30，P1）：外层硬顶写死 20 分钟，而面板能调的 ASR 超时上限是 60 分钟——
//   调到 3600 的长视频会在第 20 分钟被外层杀掉，报「超时」还分不清哪层杀的。
check('C37 外层超时必须覆盖内层可调的 ASR 超时上限（#12，P1：调大内层等于没调）', () => {
  const src = read('index.js')
  const mk = (asrTimeoutSec) =>
    compile(src, ['outerBudgetMs'], {
      prelude: `function readTuning() { return { asrTimeoutSec: ${asrTimeoutSec} } }`,
    }).outerBudgetMs
  const b = mk(3600)()
  must(b > 3600 * 1000, `asrTimeoutSec=3600 时外层只有 ${b} ms——内层还没到点就被外层杀了`)
  const d = mk(900)()
  must(d === 1_200_000, `默认配置下外层预算应保持 20 分钟，实际 ${d} ms`)
  // runLook 必须真的用 limitMs，不能只定义不用
  const body = fnBody(src, 'runLook')
  must(/const limitMs =/.test(body), 'runLook 没有引入 limitMs')
  must(/\},\s*limitMs\)/.test(body), 'runLook 的定时器还在用 timeoutMs——改动没生效')
  return `asrTimeoutSec=3600 → 外层 ${Math.round(b / 60000)} 分钟；默认仍是 20 分钟`
})

// #17（2026-10-30，P1）：deps-config.json 原来有三个读入口、三种坏文件行为，只有 readDepsCfgFile
//   会备份，而真正被读得最多的是两处裸 parse。坏文件只打一句 warning 就返回 {}，
//   下一次任何写入口整份写回，用户手改坏的配置就永久没了。
check('C38 deps-config.json 坏了要先留档再回默认值（#17，P1：否则下次写回就永久覆盖）', () => {
  // 2026-10-31：行为搬进 lib/config.mjs，直接 import 真跑（返回 {value, problem}）。
  //   原来这条靠 compile 抽 index.js 的 readJsonOrBackup + 一个 `let cfgWarning` 的 prelude——
  //   那是「编译一份影子实现」，搬走之后就抽不到了。
  const src = read('index.js')
  const dir = mkdtempSync(join(tmpdir(), 'bw-c38-'))
  try {
    const p = join(dir, 'deps-config.json')
    writeFileSync(p, '{ 坏掉的 json', 'utf8')
    const r = readJsonOrBackup(p, {})
    must(r.value && typeof r.value === 'object' && !Array.isArray(r.value), '坏文件应退回默认对象，实际 ' + JSON.stringify(r.value))
    must(r.problem?.kind === 'parse', '坏文件没有报 parse problem（调用方拿不到告警）')
    must(!existsSync(p), '坏文件还在原地——下次写回会把它覆盖掉')
    const baks = readdirSync(dir).filter((n) => n.includes('.broken-'))
    must(baks.length === 1, `没留下备份（目录里：${readdirSync(dir).join(', ') || '空'}）`)
    must(r.problem.backup && basename(r.problem.backup) === baks[0], 'problem.backup 与实际留档文件名不一致')
    // ENOENT / 空文件都不算异常（「没配过」是正常状态，不能每 8 秒刷一条面板告警）
    must(readJsonOrBackup(join(dir, 'nope.json'), {}).problem === null, '文件不存在被当成异常（ENOENT 是正常情况）')
    writeFileSync(join(dir, 'empty.json'), '  \n')
    must(readJsonOrBackup(join(dir, 'empty.json'), {}).problem === null, '空文件被当成异常')
    // 留档之后第二次读必须是干净的（否则面板每轮都报同一条）
    must(readJsonOrBackup(p, {}).problem === null, '留档后第二次读还报异常（面板会每 8 秒刷一条）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // index 侧薄壳真跑：problem → 中文文案 → cfgWarnings 数组。
  //   compile 抽的是生产代码，只把 lib 函数与 basename 从外面注入，不写影子实现。
  const warns = []
  const shell = compile(src, ['readJsonOrBackup', 'cfgProblemText'], {
    prelude: 'const pushWarn = (m) => { if (m && !__warns.includes(m)) __warns.push(m) }',
    params: ['__warns', 'readJsonOrBackupRaw', 'basename'],
    args: [warns, readJsonOrBackup, basename],
  })
  const dir3 = mkdtempSync(join(tmpdir(), 'bw-c38b-'))
  try {
    const bad = join(dir3, 'ui.json')
    writeFileSync(bad, '{ 还是坏的')
    shell.readJsonOrBackup(bad, {})
    must(warns.length === 1, `index 薄壳没产出告警（warns=${JSON.stringify(warns)}）`)
    must(/解析失败/.test(warns[0]) && /已备份为/.test(warns[0]), `告警文案不对：${warns[0]}`)
    must(/ui\.json/.test(warns[0]), '告警里没有文件名（用户不知道该改哪个文件）')
    // ENOENT 不能产告警（否则面板每 8 秒刷一条）
    shell.readJsonOrBackup(join(dir3, 'nope.json'), {})
    must(warns.length === 1, 'ENOENT 也产出了告警（会每 8 秒刷一条）')
  } finally {
    rmSync(dir3, { recursive: true, force: true })
  }
  must(/\.\.\.cfgWarnings/.test(src), '/status 的 warnings 没展开 cfgWarnings（还在用单个 cfgWarning）')
  must(!/^\s*let cfgWarning\s*=/m.test(src), '单个 cfgWarning 变量还在（谁后读谁覆盖，两条告警会丢一条）')
  // 三个读入口只剩一种行为：index.js 的 depsCfg 复用 readDepsCfgFile
  must(/function depsCfg\(\)[\s\S]{0,160}readDepsCfgFile/.test(src), 'index.js 的 depsCfg 没有复用 readDepsCfgFile——坏文件还是只打一句 warning')
  // look 侧：必须仍走 lib，且文案保持英文（PS 5.1 管道按当前代码页解码，中文会变问号）
  const rd = fnBody(read('tools/look.mjs'), 'readDepsCfg')
  must(/readJsonOrBackup\(/.test(rd), 'tools/look.mjs 没走 lib/config.mjs（两边行为又会分叉）')
  must(/process\.stderr\.write/.test(rd), 'tools/look.mjs 的 readDepsCfg 不再打 stderr')
  must(/read failed/.test(rd) && /parse failed/.test(rd), 'CLI 侧的英文文案被改掉了（PS 管道会乱码）')
  return '坏文件改名留档 + 回默认值；problem 结构 / ENOENT / 空文件 / 二次读 / 两侧文案都核过'
})

// #11（2026-10-30，P1）：/status 是 8 秒一轮，同一路由里 autoCleanCache() 早就节流了，
//   但 cache 占用那块每次都 dirStat(CACHE) 全盘递归 walk（3 万文件实测中位 219 ms）——
//   面板一开着就是「每 8 秒白扫一遍」，机器上缓存一大就顶到面板 10 秒超时。
//   这条不能写成「等 30 秒再问一次」：慢、脆，机器一慢就假绿。改成注入假时钟 + 计数桩替掉 dirStat，
//   数「真 walk 了几次」。TTL 从源码读出来当参数传进去，不在断言里另抄一份常量
//   （另抄一份就是第二个真相源，改源码不改正则时这条会绿得毫无意义——E6-08 说的正是这个）。
// ── 五处状态写入的原子化（2026-11-02）────────────────────────────────
// 换掉的是 index.js 里五个写函数：writeTuning / writeDepsCfg / writeUiCfg / writeLastRun / writeCacheCfg。
//   这五个名字在 verify.mjs 里原来是**零命中**（手工列表、我复了一遍 grep），下面是新覆盖。
// 五条分工：C131 正常路径与格式 / C132 写失败路径 / C133 跨进程并发（不变量）/
//   C135 rename 重试逻辑（确定性桩）/ C134 失败语义没被顺手改掉。
//   C135 排在这里而不是文件末尾，因为它就是从 C133 拆出来的那半（见 C133 头注释），
//   放在一起看才看得出「为什么一个用真并发、一个用桩」。编号没按顺序排，别当笔误。
//
// 为什么 C132 要「抠函数体 + 桩」而不是真造一个磁盘满：`writeJsonAtomic` 唯一的失败入口是
//   writeFileSync / renameSync 抛错，没有可注入的依赖。抠出定义段、只把 fs 三个函数换成桩，
//   被测的 if/else、catch、清理逻辑一个字没动 —— 这是测真代码，不是复刻。

// 从源码抠出模块级常量声明：手抄一份 prelude 就是「复刻」，常量一改判据不会跟着变。
const declOf = (src, name) => {
  const m = new RegExp(`^[ \\t]*(?:const|let)[ \\t]+${name}[ \\t]*=.*$`, 'm').exec(src)
  must(m, `lib/config.mjs 里找不到模块级声明 ${name}（函数依赖它，判据抽不出来就会静默退化）`)
  return m[0].trim()
}
// writeJsonAtomic 的依赖：计数器 / 重试参数 / 重试错误码表 / 同步小睡
const atomicPrelude = (src) =>
  [declOf(src, 'WRITE_SEQ'), declOf(src, 'RENAME_RETRY_MS'), declOf(src, 'RENAME_RETRY_CODES'), declOf(src, 'sleepSync')].join('\n')

check('C131 五处状态写入走原子写，且原有两种格式逐字节不变', () => {
  const cfg = read('lib/config.mjs')
  const { writeJsonAtomic } = compile(cfg, ['writeJsonAtomic', 'renameWithRetry'], {
    prelude: atomicPrelude(cfg),
    params: ['writeFileSync', 'renameSync', 'rmSync'],
    args: [writeFileSync, renameSync, rmSync],
  })
  const dir = mkdtempSync(join(tmpdir(), 'bw-c131-'))
  try {
    const p = join(dir, 'deps-config.json')
    const obj = { ffmpeg: 'C:\\bin\\ffmpeg.exe', unitLimit: 5000 }
    // ① 缩进 2（writeTuning / writeUiCfg / writeDepsCfg 三处原有格式）。
    //   基线**不是我以为的格式**，是真跑旧实现一次存下来的字节。96feae6 里这三处原文：
    //     writeFileSync(p, JSON.stringify(cur, null, 2), 'utf8')          // writeTuning   :294
    //     writeFileSync(UI_CFG, JSON.stringify(next, null, 2), 'utf8')    // writeUiCfg     :433
    //     writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')         // writeDepsCfg   :763
    //   下面这行就是它原样跑一次（不是为了断言「看起来一样」，是真拿旧版跑一遍比）。
    const baseA = join(dir, 'base-a.json')
    writeFileSync(baseA, JSON.stringify(obj, null, 2), 'utf8')
    writeJsonAtomic(p, obj)
    const wantA = readFileSync(baseA, 'utf8')
    const gotA = readFileSync(p, 'utf8')
    must(
      gotA === wantA,
      `缩进 2 的写盘结果与 96feae6 的写入结果不一致：旧版结尾 ${JSON.stringify(wantA.slice(-40))}，新版 ${JSON.stringify(gotA.slice(-40))}`,
    )
    must(!gotA.endsWith('\n'), '写盘结果多了尾换行 —— 旧实现没有，这会让逐字节比对的下游看到差异')
    // ② 紧凑格式（writeLastRun / writeCacheCfg 两处原有格式）。96feae6 原文：
    //     writeFileSync(LAST_RUN, JSON.stringify({...}), 'utf8')            // writeLastRun  :651
    //     writeFileSync(CACHE_CFG, JSON.stringify({ days, maxMb }), 'utf8') // writeCacheCfg  :750
    const compact = { days: 7, maxMb: 0 }
    const baseB = join(dir, 'base-b.json')
    writeFileSync(baseB, JSON.stringify(compact), 'utf8')
    writeJsonAtomic(p, compact, 0)
    must(
      readFileSync(p, 'utf8') === readFileSync(baseB, 'utf8'),
      'indent 0 的写盘结果与 96feae6 的紧凑格式不一致 —— 改前这两处是 JSON.stringify(x) 无缩进，加缩进就变了文件字节',
    )
    // ③ 覆盖：写两次，读回来必须是新的完整内容（不是旧的、也不是混合）
    writeJsonAtomic(p, { a: 1, pad: 'x'.repeat(5000) })
    writeJsonAtomic(p, { a: 2 })
    must(readFileSync(p, 'utf8') === JSON.stringify({ a: 2 }, null, 2), '第二次写没有完整覆盖第一次（读到旧内容或新旧混合）')
    // ④ 不留 tmp（base-a / base-b 是本判据自己造的基线文件，不算残留）
    const extra = readdirSync(dir).filter((n) => !['deps-config.json', 'base-a.json', 'base-b.json'].includes(n))
    must(extra.length === 0, `写完之后目录里多了东西（${extra.join(', ')}）—— tmp 没清干净`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // ⑤ index.js 侧：五个函数体内必须走 writeJsonAtomic，且不再有裸 writeFileSync。
  //   逐函数抠体，不是 grep 全文 —— grep 全文会被别的函数里的正常写入蒙混过去。
  const idx = read('index.js')
  for (const f of ['writeTuning', 'writeDepsCfg', 'writeUiCfg', 'writeLastRun', 'writeCacheCfg']) {
    const body = stripComments(fnBody(idx, f))
    must(body.includes('writeJsonAtomic('), `${f} 没走 writeJsonAtomic（还是裸写？）`)
    must(!body.includes('writeFileSync('), `${f} 里还有裸 writeFileSync —— 五处原子化漏了这一处`)
  }
  return '基线 = 96feae6 三处写入表达式真跑结果：缩进 2 / 紧凑两种格式逐字节一致 + 覆盖完整 + 零残留 tmp + 五处都走原子写'
})

check('C132 写 tmp 中途失败：目标文件逐字节不变、不留残留 tmp', () => {
  const cfg = read('lib/config.mjs')
  let stubCalls = 0
  // 桩：**先真写半截到盘，再抛 ENOSPC**。写半截是故意的 —— 如果 catch 里忘了删 tmp，
  //   下面「零残留」那条才照得出来；只抛不写的话，残留断言永远绿。
  const stubWrite = (p, data) => {
    stubCalls++
    writeFileSync(p, String(data).slice(0, Math.floor(String(data).length / 2)), 'utf8')
    throw Object.assign(new Error('ENOSPC: no space left on device (simulated)'), { code: 'ENOSPC' })
  }
  const { writeJsonAtomic } = compile(cfg, ['writeJsonAtomic', 'renameWithRetry'], {
    prelude: atomicPrelude(cfg),
    params: ['writeFileSync', 'renameSync', 'rmSync'],
    args: [stubWrite, renameSync, rmSync],
  })
  const dir = mkdtempSync(join(tmpdir(), 'bw-c132-'))
  try {
    const p = join(dir, 'deps-config.json')
    const oldText = JSON.stringify({ keep: 'old', n: 111 }, null, 2)
    writeFileSync(p, oldText, 'utf8')
    let err = null
    try {
      writeJsonAtomic(p, { keep: 'new', pad: 'y'.repeat(2000) })
    } catch (e) {
      err = e
    }
    must(stubCalls === 1, `桩一次都没被调用（stubCalls=${stubCalls}）—— 这条根本没测到东西`)
    must(err, '写盘失败却没抛出去：调用方的失败分支永远走不到（假保存）')
    must(err?.code === 'ENOSPC', `抛出来的不是原始错误（${err?.code}）—— 失败原因被换掉了，调用方没法判断该重试还是该报错`)
    const now = readFileSync(p, 'utf8')
    must(now === oldText, `写失败后目标文件变了 —— 旧配置被半截内容破坏：${JSON.stringify(now.slice(0, 60))}`)
    const left = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    must(left.length === 0, `写失败后留下残留 tmp（${left.join(', ')}）—— 下次谁扫这个目录会把它当成配置文件`)
    return '半截写 → 抛原始错误 / 旧内容逐字节保留 / 零残留 tmp'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('C133 一个进程密集读、另一个进程持续写：读到的永远是完整 JSON（核心）', () => {
  // 为什么是独立探针而不是在 check 里 await：check() 是同步收集，async 函数直接 await 进来
  //   会被记成 PASS（2026-11-01 踩过）。所以并发逻辑丢给 fixtures/atomic-race.mjs，
  //   它自己 spawn 两个子进程，把结论打成一行 JSON 回来。
  //
  // 2026-11-02 修：这条原来还断言 `writer.hardFail === 0`（重试用完仍有写失败）与 `sawMax >= 50`，
  //   **两条都是 flaky**。实测：把重试去掉时 hardFail=4~6（能抓到），但**有重试时偶尔也是 1**
  //   （7 档退避共 78ms，在系统负载高时不够）。于是「H 轮改 index.js 的 catch」这种
  //   与探针毫无关系的扰动，都让这条红了一次——判据随机红比永远绿更坏，下一个人会去调阈值。
  //
  //   根因是把两种确定性不同的东西捆在一条里：
  //     · `bad === 0` 是**不变量**（原子写的定义：要么旧全量、要么新全量）；
  //     · `hardFail === 0` 是**概率属性**（这个读密度下重试够不够）。
  //   现在这条只判不变量；「重试逻辑在不在、上限对不对」交给 C135 用**确定性桩**判
  //   （桩 renameSync 抛 N 次 EPERM，不依赖任何调度运气）。hardFail 与 sawMax 降级为 detail 里的信息。
  const dir = mkdtempSync(join(tmpdir(), 'bw-c133-'))
  try {
    const target = join(dir, 'deps-config.json')
    writeFileSync(target, JSON.stringify({ seq: -1, pad: 'x'.repeat(100 * 1024) }), 'utf8')
    const r = spawnSync(process.execPath, [join(HERE, 'fixtures', 'atomic-race.mjs'), target, '100', '1000', '100'], {
      encoding: 'utf8',
      timeout: 120000,
      env: baseEnv(),
    })
    must(r.status === 0, `探针没跑起来（rc=${r.status}）：${(r.stderr || '').slice(0, 300)}`)
    let out = null
    try {
      out = JSON.parse(String(r.stdout || '').trim().split('\n').pop())
    } catch {}
    must(out, `探针输出不是预期 JSON：${(r.stdout || '').slice(0, 200)}`)
    must(out.reader?.bad === 0, `读到 ${out.reader?.bad} 次半截 JSON —— 原子写没起作用（改前的裸写在这个规模下会读到 6–12 次）`)
    must(out.reader?.weird === 0, `读到 ${out.reader?.weird} 次结构不完整的对象（能 parse 但字段缺），共 ${out.reader?.ok} 次正常`)
    must(out.reader?.ok >= 500, `正常读只成功 ${out.reader?.ok} 次（应接近 1000）—— 探针多半空转了，这条等于没测`)
    // 「另一个进程能读到**新值**」——这是判据 2 的核心（跨进程可见）。
    //   只断言 >0 不断言具体值：重试偶尔会漏一次（hardFail=1 不是错误，见上面那段），
    //   但要 100 次写里连一次都没被读到，说明写根本没生效或读方解析不了。
    must((out.reader?.sawMax ?? -1) > 0, `读进程从没读到过新值（最大 seq=${out.reader?.sawMax}）—— 原子写之后另一个进程读不到更新，配置改了不生效`)
    must(out.tmpLeft === 0, `跑完目录里留有 ${out.tmpLeft} 个 .tmp`)
    // hardFail / sawMax 只报不断言（见函数头那段）。写不进去会让 sawMax 停在中途，
    //   但那是「重试够不够」，C135 用桩判得更准。
    return `100 次写 / 1000 次读：0 半截、0 结构不完整、读到 ${out.reader.ok} 次正常；写失败 ${out.writer?.hardFail} 次、最大 seq=${out.reader.sawMax}（信息，不断言）`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('C135 rename 遇 EPERM 会退避重试，遇到别的错误码立刻抛（Windows 上并发读会挡住 rename）', () => {
  // 这条替代 C133 原来那条 flaky 的 hardFail 断言：用**确定性桩**验证重试逻辑本身，
  //   不依赖调度运气，也不会因为机器忙就红。
  //
  // 为什么这件事重要：Windows 上 rename 覆盖「正被别的进程打开读」的文件会 EPERM
  //   （POSIX 不会：rename 只看目录权限）。而面板写 deps-config.json 的同时，
  //   tools/look.mjs 的 tuning() 一次调用要读它十几次。不重试的话，加了原子性反而让
  //   「保存」随机失败——比改前的裸写更糟（裸写从不失败）。
  const cfg = read('lib/config.mjs')
  const mk = (plan) => {
    // plan：按顺序消费的重试结果；'ok' 表示真 rename，字符串表示抛对应 code 的错误
    let n = 0
    const stubRename = (tmp, p) => {
      const step = plan[Math.min(n, plan.length - 1)]
      n++
      if (step === 'ok') return renameSync(tmp, p)
      throw Object.assign(new Error(`${step}: operation not permitted (simulated)`), { code: step })
    }
    const { writeJsonAtomic } = compile(cfg, ['writeJsonAtomic', 'renameWithRetry'], {
      prelude: atomicPrelude(cfg),
      params: ['writeFileSync', 'renameSync', 'rmSync'],
      args: [writeFileSync, stubRename, rmSync],
    })
    return { writeJsonAtomic, calls: () => n }
  }
  const dir = mkdtempSync(join(tmpdir(), 'bw-c135-'))
  try {
    // ① 前 3 次 EPERM、第 4 次成功：必须写成，且真的重试了 4 次
    const a = mk(['EPERM', 'EPERM', 'EBUSY', 'ok'])
    const pa = join(dir, 'a.json')
    a.writeJsonAtomic(pa, { k: 1 })
    must(readFileSync(pa, 'utf8') === JSON.stringify({ k: 1 }, null, 2), '前三次 EPERM/EBUSY 之后应当第 4 次写成功（重试没生效或内容不对）')
    must(a.calls() === 4, `应当尝试 4 次，实际 ${a.calls()} 次 —— 重试次数与预期不符`)

    // ② 一直 EPERM：必须抛出来（不能吞），且不留 tmp
    const b = mk(['EPERM'])
    const pb = join(dir, 'b.json')
    writeFileSync(pb, 'OLD', 'utf8')
    let errB = null
    try {
      b.writeJsonAtomic(pb, { k: 2 })
    } catch (e) {
      errB = e
    }
    must(errB, '一直 EPERM 却没有任何异常 —— 写没成功却报成功（假保存）')
    must(errB?.code === 'EPERM', `抛出来的不是 EPERM（${errB?.code}），调用方没法区分「稍后重试」和「配置目录不对」`)
    must(b.calls() > 1, `只尝试了 ${b.calls()} 次就放弃 —— 没有重试`)
    must(b.calls() <= 20, `重试了 ${b.calls()} 次 —— 上限失控（正常是 7 次退避）`)
    must(readFileSync(pb, 'utf8') === 'OLD', '重试全失败后目标文件被动了（应当原样保留旧内容）')
    must(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length === 0, '重试全失败后留下残留 tmp')

    // ③ 非重试类错误（比如目标目录不存在）：必须立刻抛，不许白等 78ms 退避
    const c = mk(['ENOENT', 'ok'])
    let errC = null
    try {
      c.writeJsonAtomic(join(dir, 'c.json'), { k: 3 })
    } catch (e) {
      errC = e
    }
    must(errC?.code === 'ENOENT', `ENOENT 应当直接抛出去，实际 ${errC ? '抛了 ' + errC.code : '没抛'}`)
    must(c.calls() === 1, `ENOENT 被重试了 ${c.calls()} 次 —— 只该对 EPERM/EBUSY/EACCES 退避，别的错误重试也没用`)
    return 'EPERM/EBUSY 会退避重试（4 次写成）/ 一直失败则抛原始码且零残留 tmp / ENOENT 立刻抛不空转'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('C134 五处写函数的失败语义没被 2a 顺手改掉（抛 / 吞 / ok:false 各归各位）', () => {
  // 这条防两件事：
  //   ① 顺手把五种失败形态统一了 —— 那是 2b 的活，提前做了会让 2b 无法验证自己改了什么；
  //   ② 顺手把 writeLastRun 的空 catch 去掉 —— 那个 catch 是有意的：它是「每条命令后写一次」的
  //      旁路统计（index.js 里紧跟在每条命令执行完之后），写不进去不该把命令的退出码带偏。
  // 这是**结构判据**，不是运行时判据：它只能证明「这次 diff 里没人动这些出口」，
  //   证不了「运行时确实如此」—— 后者由 C131/C132 覆盖。之所以接受这个较弱形态，
  //   是因为「有没有人动过这些出口」本身就是源码事实，抠函数体看比造五种失败场景真跑更直接，
  //   而且造场景要先能注入 fs 失败，那需要给生产代码开测试后门。
  const idx = read('index.js')
  const bodyOf = (n) => stripComments(fnBody(idx, n))
  const ui = bodyOf('writeUiCfg')
  must(!/try\s*\{/.test(ui), 'writeUiCfg 被包了 try —— 它的语义是「直接抛给调用方」，包起来就把失败变成静默了')
  must(!ui.includes('return { ok'), 'writeUiCfg 开始返回 {ok:...} 了 —— 返回值形态被改，那是 2b 的事')
  const lastRun = bodyOf('writeLastRun')
  must(/catch\s*\{\s*\}/.test(lastRun), 'writeLastRun 的空 catch 没了 —— 写盘失败会把命令的退出码带偏')
  must(!lastRun.includes('return {'), 'writeLastRun 开始返回值了 —— 它的语义是「吞掉、什么都不说」')
  for (const n of ['writeTuning', 'writeDepsCfg', 'writeCacheCfg']) {
    const b = bodyOf(n)
    must(/return\s*\{\s*ok:\s*false/.test(b), `${n} 不再返回 {ok:false,...} 了`)
    if (n === 'writeTuning') {
      must(/code:\s*400/.test(b), 'writeTuning 的 code: 400 没了（参数非法要能区分出 4xx）')
    } else {
      must(!/code:\s*\d+/.test(b), `${n} 多了 code 字段 —— code 只在 HTTP 层加（定下的口径）`)
    }
  }
  return 'writeUiCfg 仍抛 / writeLastRun 仍吞 / 三个仍返回 ok:false（code 只在 writeTuning）'
})

// ── 四处 0600 凭证写入点（2026-11-02）──────────────────────────────────
//
// 四处 = index.js 面板扫码 / lib/cred.mjs 的 adoptLegacyCred / tools/look.mjs 的 --poll 与 login。
// 前三处写同一个 deps/credential.json（`CRED_FILE = SHARED_CRED`），第四处写 deps/login-key.json
//   —— 另一个文件、生命周期更短（登录成功或二维码过期就删）。
//
// 「四处」这个数不写在判据里当常量，而是逐文件数实际出现次数（C137）：上一版把「三处」写死在
//   lib/config.mjs 注释里，结果人和工具互相引用、`login-key.json` 整条漏掉。数字写进注释会腐化，
//   现在注释里留的是可 grep 的标记「0600 点」。

check('C136 writeJsonAtomic 的 mode：tmp 建时带 0600、chmod 只打 tmp、且在 rename 之前', () => {
  // 为什么用桩判顺序、不真跑 stat：Windows 上 mode/chmod 全是空操作（2026-11-02 实测 stat 恒 666），
  //   真跑只能在 POSIX 上验（那条交给 C139，Windows skip）。而「顺序」这个事在 Windows 上
  //   一点症状都没有，却正是要防的风险来源：先 rename 再 chmod 目标，目标若已被删就 ENOENT，
  //   于是「写成功了却报失败」——tools/look.mjs 的 login 分支写完马上删 login-key.json，正好有这个窗口。
  const cfg = read('lib/config.mjs')
  const calls = []
  const stubWrite = (p, data, opt) => { calls.push(['write', p, opt]) }
  const stubRename = (a, b) => { calls.push(['rename', a, b]) }
  const stubRm = (p) => { calls.push(['rm', p]) }
  const okChmod = (p, m) => { calls.push(['chmod', p, m]) }
  const mk = (chmodStub) =>
    compile(cfg, ['writeJsonAtomic', 'renameWithRetry'], {
      prelude: atomicPrelude(cfg),
      params: ['writeFileSync', 'chmodSync', 'renameSync', 'rmSync'],
      args: [stubWrite, chmodStub, stubRename, stubRm],
    })

  const { writeJsonAtomic } = mk(okChmod)
  writeJsonAtomic('/x/credential.json', { a: 1 }, 2, { mode: 0o600 })
  const w = calls.find((c) => c[0] === 'write')
  must(w, '桩一次都没被调用 —— 这条根本没测到东西')
  must(w[2] && w[2].mode === 0o600, `tmp 建的时候没带 mode（第三个参数是 ${JSON.stringify(w[2])}）—— 文件按 umask 先建成 0644，中间有一段可读窗口`)
  must(w[2].encoding === 'utf8', 'tmp 写入没指定 utf8 —— Windows 中文路径下会按当前代码页落盘')
  const ch = calls.filter((c) => c[0] === 'chmod')
  must(ch.length === 1, `chmod 调了 ${ch.length} 次（应恰好 1 次）—— 多出来的那次多半是 rename 之后去补目标权限，目标被删就 ENOENT`)
  must(ch[0][1] === w[1], `chmod 打的不是 tmp（打的是 ${ch[0][1]}）—— 打在目标上就多一条「目标被删 → ENOENT」的失败路径`)
  must(ch[0][2] === 0o600, `chmod 的 mode 是 ${ch[0][2]}，不是 0o600`)
  const iCh = calls.findIndex((c) => c[0] === 'chmod')
  const iRn = calls.findIndex((c) => c[0] === 'rename')
  must(iCh >= 0 && iRn >= 0 && iCh < iRn, `chmod 不在 rename 之前（chmod@${iCh}, rename@${iRn}）—— 先换 inode 再补权限，中间目标已是 0644`)
  must(calls.filter((c) => c[0] === 'rename').length === 1, 'rename 次数不是 1')

  // 不传 mode（五处状态写就是这么调的）：一次 chmod 都不许有。
  // 多一次系统调用是小事，「多一条失败路径」才是事 —— 状态写不该因为权限而失败。
  calls.length = 0
  writeJsonAtomic('/x/deps-config.json', { a: 1 }, 0)
  must(!calls.some((c) => c[0] === 'chmod'), '不传 mode 也调了 chmod —— 五处状态写会跟着多一条失败路径')
  const w2 = calls.find((c) => c[0] === 'write')
  must(typeof w2[2] === 'string', '不传 mode 时写入参数不是 "utf8" 字符串了 —— 2a 的调用形态被改了')

  // chmod 失败：必须删 tmp、抛原始错误码、且**不许 rename**。
  //   静默当成成功正是这个参数要防的事（权限没设对 = 凭证可读，功能却全正常）。
  calls.length = 0
  const { writeJsonAtomic: bad } = mk((p, m) => {
    calls.push(['chmod', p, m])
    throw Object.assign(new Error('EPERM: chmod denied (simulated)'), { code: 'EPERM' })
  })
  let e2 = null
  try { bad('/x/c.json', { a: 1 }, 2, { mode: 0o600 }) } catch (e) { e2 = e }
  must(e2 && e2.code === 'EPERM', `chmod 失败被吞了（抛出来的是 ${e2 && e2.code}）—— 权限没设对却当成功`)
  must(calls.some((c) => c[0] === 'rm'), 'chmod 失败后没删 tmp')
  must(!calls.some((c) => c[0] === 'rename'), 'chmod 失败后仍然 rename 了 —— 把一个权限不对的文件换上了正式位置')
  return 'tmp 建时带 0600 / chmod 恰好 1 次且只打 tmp / chmod 在 rename 前 / 不传 mode 零 chmod / chmod 失败删 tmp 并抛原码'
})

check('C137 四处凭证写入点都改走 writeJsonAtomic 带 mode，没有残留的裸写与「写完再 chmod」', () => {
  // 数实际出现次数，不认「有一处改了就算过」：漏改一处时那种写法照样绿 ——
  //   这正是 2a 那轮「五处实现只验了三处」的同型坑，这次换到 0600 上。
  const files = { 'index.js': read('index.js'), 'lib/cred.mjs': read('lib/cred.mjs'), 'tools/look.mjs': read('tools/look.mjs') }
  const want = { 'index.js': 1, 'lib/cred.mjs': 1, 'tools/look.mjs': 2 }
  for (const [name, src] of Object.entries(files)) {
    const s = stripComments(src)
    const n = (s.match(/mode:\s*0o600/g) || []).length
    must(n === want[name], `${name} 里 mode: 0o600 出现 ${n} 次，应为 ${want[name]} —— 少一处就是「改了但没改全」`)
    // 反向：裸 writeFileSync 写这三个变量，一个都不许留
    const bare = s.match(/writeFileSync\s*\(\s*(SHARED_CRED|CRED_FILE|LOGIN_KEY_FILE)\b/g) || []
    must(bare.length === 0, `${name} 里还有裸 writeFileSync(${bare.join(', ')}) —— 那一处没有原子性，进程被杀会留半截`)
    // 反向：chmodSync(…, 0o600) 回潮 = 有人把「写完再 chmod 目标」加回来了
    const chmod = s.match(/chmodSync\s*\([^)]*0o600/g) || []
    must(chmod.length === 0, `${name} 里还有 chmodSync(…, 0o600) —— 那一步在 rename 之后，会多一条 ENOENT 失败路径`)
  }
  // 注释里的标记必须在（它是「四处」这件事的唯一可查来源）
  must(/0600 点/.test(read('lib/config.mjs')), 'lib/config.mjs 里找不到「0600 点」标记 —— 那样「哪四处」又要靠人记，上一版就是这么漏掉 login-key.json 的')
  return 'index 1 / cred 1 / look 2 处 mode；裸写 0、回潮 chmod 0；标记在'
})

check('C138 四处写出的字节与旧写法逐字节相同（indent 2、无尾换行、中文不转义）', () => {
  const cfg = read('lib/config.mjs')
  const { writeJsonAtomic } = compile(cfg, ['writeJsonAtomic', 'renameWithRetry'], {
    prelude: atomicPrelude(cfg),
    params: ['writeFileSync', 'chmodSync', 'renameSync', 'rmSync'],
    args: [writeFileSync, chmodSync, renameSync, rmSync],
  })
  const dir = mkdtempSync(join(tmpdir(), 'bw-c138-'))
  try {
    const o = { sessdata: 'a%3Db', bili_jct: '', buvid3: 'x', buvid4: '', mid: '123', note: '扫码登录（插件面板），只用于读取 AI 字幕', updatedAt: '2026-11-02T00:00:00.000Z' }
    const p = join(dir, 'credential.json')
    writeJsonAtomic(p, o, 2, { mode: 0o600 })
    const got = readFileSync(p, 'utf8')
    // 旧写法：四处都是 `writeFileSync(x, JSON.stringify(obj, null, 2), ...)`，不带尾换行。
    const want = JSON.stringify(o, null, 2)
    must(got === want, `字节不一致：旧写法 ${want.length}B、新写法 ${got.length}B`)
    must(!got.endsWith('\n'), '多了尾换行 —— 旧写法四处都没有')
    must(got.includes('扫码登录'), '中文被转义 —— 写盘编码不是 utf8')
    // 紧凑格式（indent 0）也必须还是原来那个：`writeLastRun` / `writeCacheCfg` 用的是它
    const p2 = join(dir, 'last-run.json')
    writeJsonAtomic(p2, { a: 1 }, 0)
    must(readFileSync(p2, 'utf8') === '{"a":1}', `indent 0 的输出变了：${readFileSync(p2, 'utf8')}`)
    return `${want.length}B 逐字节一致、无尾换行、中文未转义；紧凑格式仍是 {"a":1}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('C139 POSIX 上凭证文件落盘就是 0600（Windows 无此语义，skip 不假绿）', () => {
  // 这条是唯一真跑权限的判据，所以 Windows 上必须 skip 而不是「跑一遍说通过」：
  //   实测 Windows 上 mode/chmod 都是空操作（stat 恒 666），真跑也只能得出结论「666」，
  //   把它判成 PASS 就是拿一个必然成立的观察冒充判据。
  if (process.platform === 'win32') {
    skip('C139 POSIX 上凭证文件落盘就是 0600（Windows 无此语义，skip 不假绿）', 'win32：mode/chmod 是空操作（实测 stat 恒 666），权限语义只在 POSIX 上存在；参数是否传入由 C136 覆盖')
    return
  }
  const cfg = read('lib/config.mjs')
  const { writeJsonAtomic } = compile(cfg, ['writeJsonAtomic', 'renameWithRetry'], {
    prelude: atomicPrelude(cfg),
    params: ['writeFileSync', 'chmodSync', 'renameSync', 'rmSync'],
    args: [writeFileSync, chmodSync, renameSync, rmSync],
  })
  const dir = mkdtempSync(join(tmpdir(), 'bw-c139-'))
  try {
    // 先造一个「权限已经被改宽」的旧文件：rename 换 inode 后，旧文件的 0644 **不该**被继承下来。
    const p = join(dir, 'credential.json')
    writeFileSync(p, '{"old":true}', 'utf8')
    chmodSync(p, 0o644)
    writeJsonAtomic(p, { new: true }, 2, { mode: 0o600 })
    const m = statSync(p).mode & 0o777
    must(m === 0o600, `落盘权限是 ${m.toString(8)}，不是 600 —— 凭证对同机其他用户可读（这一步不会报错，只有权限变了）`)
    return `旧文件 644 → 原子替换后 600（mode 位 ${m.toString(8)}）`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('C140 login-key.json 的生命周期：能删、删后还能再写，且删除不依赖它自己存在', () => {
  // 2026-11-02 的两条生命周期断言：
  //   ① 登录成功后 login-key.json 被删掉；② 它被删掉之后，chmod 不会因为文件不存在抛错。
  // ②在实现上已经从根上去掉了（chmod 打在 tmp 上，tmp 刚创建必然存在 —— C136 钉着），
  //   所以这里验的是「删掉之后整条写入路径仍然走得通」，而不是「chmod 有没有 try 包着」。
  const cfg = read('lib/config.mjs')
  const { writeJsonAtomic } = compile(cfg, ['writeJsonAtomic', 'renameWithRetry'], {
    prelude: atomicPrelude(cfg),
    params: ['writeFileSync', 'chmodSync', 'renameSync', 'rmSync'],
    args: [writeFileSync, chmodSync, renameSync, rmSync],
  })
  const dir = mkdtempSync(join(tmpdir(), 'bw-c140-'))
  try {
    const p = join(dir, 'login-key.json')
    const key = { qrcode_key: 'k1', url: 'https://x' }
    writeJsonAtomic(p, key, 2, { mode: 0o600 })
    must(existsSync(p), '第一次写就没成功')
    rmSync(p, { force: true })   // login --poll 成功后就是这么删的
    must(!existsSync(p), '删除没生效')
    let e = null
    try { writeJsonAtomic(p, { qrcode_key: 'k2', url: 'https://y' }, 2, { mode: 0o600 }) } catch (err) { e = err }
    must(!e, `删除后再写抛了 ${e && e.message} —— 登录信息写不回去（一次登录只能成功一次）`)
    must(existsSync(p), '重写后文件不在')
    must(JSON.parse(readFileSync(p, 'utf8')).qrcode_key === 'k2', '重写后内容不是新的')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // 结构：login --poll 的成功分支必须先写凭证、再删 login-key.json。
  //   顺序反了的话，删完之后若是写入失败，用户会看到一个「已登录但没有凭证」的中间态。
  const look = stripComments(read('tools/look.mjs'))
  const iWrite = look.indexOf('writeJsonAtomic(CRED_FILE')
  const iDel = look.indexOf('rmSync(LOGIN_KEY_FILE')
  must(iWrite >= 0, 'tools/look.mjs 里找不到写 CRED_FILE 的调用')
  must(iDel >= 0, 'tools/look.mjs 里找不到删 LOGIN_KEY_FILE 的调用 —— 登录成功后不清理，二维码 key 会一直留在盘上')
  must(iWrite < iDel, `写凭证(@${iWrite}) 在删 login-key(@${iDel}) 之后 —— 先删再写，写失败就留下「已登录无凭证」的中间态`)
  return '写→删 顺序正确；删后重写不抛；重写内容正确'
})

check('C141 look.mjs 两处凭证写入失败不裸抛：转成 stderr + exitCode=1（「统一失败处理」的落点）', () => {
  // 2b 说的「统一失败处理」不是「四处返回值同形」——消费者不同（面板要返回对象、CLI 要退出码），
  //   注定不同形。能统一的是**都不许裸抛**：裸抛会被顶层兜成一句没有上下文的堆栈，
  //   用户看不出「是凭证没写进去」。这条逐点钉「调用点在 try 里、catch 里是 stderr + exitCode」。
  //
  // 判法用「最近的那个 try / catch」（indexOf 从调用点往后找），不用「全文有没有 try」——
  //   后者在同一个函数里任何一个 try 都能满足，等于没判（2a 的 C134 是同型判据，已知弱）。
  // 注意：下面的 `look` 已经过 stripComments，它会**去掉所有空白**（`try {` → `try{`）。
  //   第一版这里写的是 `'try {'`，于是永远找不到、判据自己红 —— 判据的字面形态必须跟它的输入对齐，
  //   这跟「枚举名凭记忆写」是同一类错：先求值打印，再写判据。
  const look = stripComments(read('tools/look.mjs'))
  const sites = ['writeJsonAtomic(CRED_FILE', 'writeJsonAtomic(LOGIN_KEY_FILE']
  const detail = []
  for (const s of sites) {
    const i = look.indexOf(s)
    must(i >= 0, `tools/look.mjs 里找不到 ${s} 的调用`)
    const before = look.slice(0, i)
    const iTry = before.lastIndexOf('try{')
    must(iTry >= 0 && i - iTry < 900, `${s} 前面 900 字符内没有 try —— 写失败会裸抛到顶层`)
    const iCatch = look.indexOf('}catch(e){', i)
    must(iCatch > i && iCatch - i < 900, `${s} 后面 900 字符内没有 catch —— 抛了没人接`)
    const catchBody = look.slice(iCatch, iCatch + 320)
    must(/console\.error\(/.test(catchBody), `${s} 的 catch 里没有 console.error —— 失败对用户不可见`)
    must(/process\.exitCode=1/.test(catchBody), `${s} 的 catch 里没设 exitCode=1 —— 脚本化调用看到 rc=0 会当成成功`)
    detail.push(`${s.split('(')[1]}@try${iTry}`)
  }
  return `两处都在 try 内、catch 里有 stderr + exitCode=1（${detail.join(' / ')}）`
})

check('C39 /status 的缓存占用走节流，清理后立刻失效（#11，P1：每 8 秒白扫一遍）', () => {
  const src = read('index.js')
  const mTtl = /const CACHE_STAT_TTL_MS = ([0-9]+) \* 1000/.exec(src)
  must(mTtl, '找不到 CACHE_STAT_TTL_MS 定义——节流被删了？')
  const ttl = Number(mTtl[1]) * 1000
  // 8 秒轮询：TTL 至少得是它的两倍才有意义；超过 5 分钟面板看到的就是太旧的数
  must(ttl >= 16_000 && ttl <= 300_000, `TTL=${ttl} ms 不合理：要么挡不住 8 秒轮询，要么旧到没有参考价值`)
  must(/let cacheStatVal = null/.test(src), '找不到 cacheStatVal 的初值（变量被改名了？这条断言要跟着改）')

  let walks = 0
  let now = 1_000_000
  const { cacheStat, invalidateCacheStat } = compile(src, ['cacheStat', 'invalidateCacheStat'], {
    // cacheStat 里读的是 cacheDir()（缓存根状态搬进 lib 之后，本文件不再有 CACHE 值）
    prelude: `const cacheDir = () => 'X:/fake-cache'\nlet cacheStatAt = 0\nlet cacheStatVal = null`,
    params: ['dirStat', 'Date', 'CACHE_STAT_TTL_MS'],
    // dirStat 换成一个只数调用次数的桩：它被调几次 = 真 walk 了几次
    args: [() => { walks += 1; return { files: walks, bytes: walks * 100 } }, { now: () => now }, ttl],
  })

  const r1 = cacheStat()
  must(walks === 1, `第一次调用没真 walk（walks=${walks}）`)
  must(r1.files === 1 && r1.bytes === 100, `返回的不是 dirStat 的结果：${JSON.stringify(r1)}`)

  cacheStat()
  must(walks === 1, `TTL 内第二次调用又 walk 了一遍（walks=${walks}）——节流没生效，等于每 8 秒白扫`)

  now += ttl - 1000
  cacheStat()
  must(walks === 1, `TTL 未到就重算了（walks=${walks}）——节流窗口比声明的小`)

  now += 2000
  cacheStat()
  must(walks === 2, `TTL 过了还不重算（walks=${walks}）——缓存永不过期，面板会一直显示陈旧的占用`)

  invalidateCacheStat()
  cacheStat()
  must(walks === 3, `invalidate 之后没有立刻重算（walks=${walks}）——清理完面板最多 30 秒还在显示清理前的体积`)

  // 调用面：/status 必须走 cacheStat，清理两条路径都必须调 invalidate
  must(/cache:\s*\{\s*\.\.\.cacheStat\(\)/.test(src), '/status 的 cache 那块没走 cacheStat()')
  must(!/cache:\s*\{\s*\.\.\.dirStat\(cacheDir\(\)\)/.test(src), '/status 的 cache 那块还在直接 dirStat(cacheDir())')
  must(/invalidateCacheStat\(\)/.test(fnBody(src, 'autoCleanCache')), 'autoCleanCache 清了东西却不失效缓存，面板读到的是清理前的体积')
  const iClear = src.indexOf("url.pathname === '/api/bili-watch/cache/clear'")
  must(iClear > 0, '找不到 /cache/clear 路由')
  // 只取这一个路由的体：从它到下一个路由判据为止，别把邻家的 invalidate 算进来
  const iNext = src.indexOf('url.pathname ===', iClear + 10)
  const clearSeg = src.slice(iClear, iNext > 0 ? iNext : iClear + 2000)
  must(/invalidateCacheStat\(\)/.test(clearSeg), '/cache/clear 清完不失效缓存')

  return `${ttl / 1000} 秒窗口内 5 次调用只真 walk ${walks} 次（invalidate 那次立刻重算）；两条清理路径都接上了`
})

// E7-03（2026-10-30，P1）：隔离必须真隔离，而「只设 DSH_HOME」做不到。
//   机制在 tools/look.mjs 的 DEPS 派生：pref = BILI_WATCH_DEPS || $DSH_HOME/bili-watch/deps，
//   **但 pref 不存在时回落到包内 deps/**（那份里有真凭证）。于是 credential.json 找到了，
//   `login --check` 返回 rc=0「✓ 凭证有效：<你的昵称>」——手工检查时看到「隔离下已登录」，
//   很自然当成「本来就没登录」，整轮检查其实都在用真实身份跑。
//   真隔离必须两个变量都指空目录：DSH_HOME 管新位置，BILI_WATCH_DEPS 管旧位置 + 挡住回落。
check('C40 双变量隔离下必须「还没登录」：只设 DSH_HOME 会回落到包内 deps（E7-03，P1）', () => {
  const box = mkdtempSync(join(tmpdir(), 'bw-verify-c40-'))
  const home = join(box, 'home')
  const deps = join(box, 'deps')
  mkdirSync(home, { recursive: true })
  mkdirSync(deps, { recursive: true })
  const run = (env) => {
    const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'login', '--check'], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 120000,
    })
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
  }
  try {
    // ① 双变量：必须 rc≠0，且不能出现「凭证有效」
    const both = run({ DSH_HOME: home, BILI_WATCH_DEPS: deps })
    const tail = both.out.trim().slice(0, 200)
    must(both.code !== 0, `双变量隔离下 login --check 返回 rc=${both.code}——隔离没生效，读到的是本机真实凭证：${tail}`)
    must(!/凭证有效/.test(both.out), `隔离环境下说「凭证有效」，说明凭证是从别处读来的：${tail}`)
    must(/还没登录|未登录/.test(both.out), `rc≠0 但没说清是「没登录」，用户看不懂这句：${tail}`)

    // ② 对照：单设 DSH_HOME 时能不能骗过自己。这里**不断言 rc**——它取决于本机包内 deps 有没有凭证，
    //   换个没登录过的机器同样是 rc≠0。只把事实写进返回信息，让看到的人知道「单变量撞巧过了」不算隔离。
    const one = run({ DSH_HOME: home, BILI_WATCH_DEPS: '' })
    return `双变量 rc=${both.code}、文案「还没登录」；只设 DSH_HOME 在本机 rc=${one.code}` +
      (one.code === 0 ? '（回落到包内 deps 读到了真凭证——这就是假隔离）' : '（本机包内 deps 无凭证；别的机器有，所以单变量永远不能当隔离）')
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})

// C41（2026-10-30，严重漏洞）：泄漏闸门的扫描面必须覆盖「只进仓库」的文件，且闸门自己不许写死本机身份。
//   成因：sync-release.ps1 的 $scanList 由 package.json 的 files 展开，而 tools/verify*.mjs 走的是
//   $repoOnly 通路（只进仓库、不进包），从来没进过扫描清单——于是写在 verify.mjs 规则里的本机用户名
//   跟着 sync 进了发布树，闸门还照打「零本机字面量」。判据：扫描面集合 == 实际会进仓库的集合。
//   这条只证明接线对；「注入身份后闸门真能红」是手工验过的，不在这里重复跑（要起 PowerShell）。
check('C41 泄漏闸门的扫描面必须覆盖只进仓库的文件（且闸门自己不含本机身份）', () => {
  const sp = join(ROOT, 'scripts/sync-release.ps1')
  if (!existsSync(sp)) {
    skip('C41 泄漏闸门的扫描面', '发布树不含 scripts/sync-release.ps1（含本机路径，只留开发态）')
    return 'ok'
  }
  const s = readFileSync(sp, 'utf8')
  const atRepo = s.indexOf('$repoOnly = @(')
  const atScan = s.indexOf('AssertNoPaths $Source')
  must(atRepo > 0, 'sync-release.ps1 里找不到 $repoOnly 定义')
  must(atScan > atRepo, '$repoOnly 定义在泄漏扫描之后——扫描时它还不存在，等于白扫')
  // 两处 AssertNoPaths（开发态 + 发布树）都必须检查 $repoOnly；少一处就等于那侧白扫。
  const nRepo = (s.match(/\$repoOnly \$hardRules/g) || []).length
  must(nRepo === 2, 'AssertNoPaths 只在 ' + nRepo + ' 处检查了 $repoOnly（应 2 处：开发态 + 发布树）——「只进仓库」的文件等于不被检查')
  must(!/\$scanList \$hardRules/.test(s), 'AssertNoPaths 把 $scanList 和 $hardRules 配在一起了：进包那侧必须用 $allRules，否则软规则整档失效')
  const uid = (process.env.USERNAME || process.env.USER || '').trim()
  if (uid && uid.length >= 3) must(!s.includes(uid), 'sync-release.ps1 里硬编码了本机用户名')
  const idsFile = join(ROOT, '.leak-ids')
  let nIds = 0
  if (existsSync(idsFile)) {
    const ids = readFileSync(idsFile, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'))
    nIds = ids.length
    for (const id of ids) must(!s.includes(id), 'sync-release.ps1 里硬编码了 .leak-ids 的条目')
  }
  return `扫描面含 repoOnly；闸门自身不含本机身份（用户名${uid ? '已查' : '不可用'}、.leak-ids ${nIds} 条已查）`
})

// A1：text/sub 默认格式带时间码，--no-time 退回纯文本
check('C42 cuesToTxt 带 withTime 时每行 [mm:ss] 前缀（A1：模型要能定位到第几分钟那句）', () => {
  const b = read('tools/look.mjs')
  const { cuesToTxt } = compile(b, ['cuesToTxt'])
  // 真跑：withTime=true 时必须带 [mm:ss] 前缀
  const cues = [{ from: 65.5, content: '测试句1' }, { from: 125.2, content: '测试句2' }]
  const outT = cuesToTxt(cues, { withTime: true })
  must(outT.text.includes('[01:05] 测试句1'), 'withTime=true 时第 1 行没有 [mm:ss] 前缀')
  must(outT.text.includes('[02:05] 测试句2'), 'withTime=true 时第 2 行没有 [mm:ss] 前缀')
  // 真跑：withTime=false 时必须不带前缀
  const outF = cuesToTxt(cues, { withTime: false })
  must(!outF.text.includes('[01:05]'), 'withTime=false 时不该有 [mm:ss] 前缀')
  must(outF.text.includes('测试句1'), 'withTime=false 时丢了内容')
  // 调用点：cmdSub/cmdText 默认都接了 withTime（字符串断言保留，因为调用点不好真跑）
  const src = b
  const cmdSubBlock = src.slice(src.indexOf('async function cmdSub('), src.indexOf('async function cmdSubstrip('))
  must(cmdSubBlock.includes('withTime: true'), 'cmdSub 默认 text 格式没用带时间码的 cuesToTxt')
  must(cmdSubBlock.includes('noTime'), 'cmdSub 没接 --no-time 开关')
  const cmdTextBlock = src.slice(src.indexOf('async function cmdText('), src.indexOf('async function cmdLocal('))
  must(cmdTextBlock.includes('withTime: true'), 'cmdText 没用带时间码的 cuesToTxt')
  must(cmdTextBlock.includes('noTime'), 'cmdText 没接 --no-time 开关')
  // KNOWN_FLAGS 加了 no-time（第二步起改真跑：那张表已从 lib/params.mjs 生成，读字面量会验不住）
  const nt = flagAccepted('no-time')
  must(nt.ok, `look.mjs 报「未知参数 --no-time」：stderr=${nt.err.slice(0, 160)}`)
  return 'cuesToTxt 真跑：withTime=true 带 [mm:ss] 前缀、withTime=false 不带；cmdSub/cmdText 调用点已接'
})

check('C43 peek 先走 videoshot，失败回落抽帧（A2：省流量，别只写顺路径）', () => {
  const b = read('tools/look.mjs')
  // 验证 peekViaVideoShot 函数体不是一进门就 return false
  const peekVsBody = fnBody(b, 'peekViaVideoShot')
  must(peekVsBody.length > 50, 'peekViaVideoShot 函数体太短——是不是一进门就 return false？')
  must(peekVsBody.includes('await jget('), 'peekViaVideoShot 没调 jget——是不是一进门就 return false？')
  must(peekVsBody.includes('return { times:'), 'peekViaVideoShot 没返回 times——是不是一进门就 return false？')
  // 验证 peekFrames 里先调 videoshot，失败时回落
  const peekBlock = b.slice(b.indexOf('async function peekFrames('), b.indexOf('async function peekOcrLines('))
  must(peekBlock.includes('peekViaVideoShot(bv, v, dir, bin)'), 'peekFrames 里没调 peekViaVideoShot')
  must(peekBlock.includes('track(`[track] videoshot 失败，回落抽帧：'), 'peekFrames 里 videoshot 失败时没打 track（静默吞了）')
  must(peekBlock.includes('let mp4 = fresh ? null : cachedMp4'), 'peekFrames 里 videoshot 失败后没回落原来的抽帧逻辑（cachedMp4 那段）')
  // 协议相对 URL 补 https:
  must(b.includes("startsWith('//') ? 'https:' + sheetUrl"), 'peekViaVideoShot 没给协议相对 URL 补 https:')
  return 'peekViaVideoShot 函数体有 await jget 和 return times（不是一进门就 return false）；peekFrames 先试 videoshot，失败打 track 后回落抽帧；协议相对 URL 补了 https:'
})

check('C44 --at 时间解析容错（A3：12:30 / 12:3 都当 12 分 30 秒；abc 报错）', () => {
  const b = read('tools/look.mjs')
  // parseAtTimes 搬进 lib/media.mjs，直接从 import 的那份真跑（不再 compile 抠函数体）。
  //   这一步顺带证明「搬走的是同一份」：下面五条期望值一个字没改，仍然全过。
  // 真跑：三种格式都对
  must(JSON.stringify(parseAtTimes('750', 936, 2)) === '[750]', '750（秒）解析错了')
  must(JSON.stringify(parseAtTimes('12:30', 936, 2)) === '[750]', '12:30（分:秒）解析错了')
  must(JSON.stringify(parseAtTimes('12:30-12:35', 936, 5)) === '[750,755]', '12:30-12:35（区间）解析错了')
  // 真跑：abc 报错
  let threw = false
  try { parseAtTimes('abc', 936, 2) } catch { threw = true }
  must(threw, 'abc 这种格式不该不报错')
  // 调用点：grabFrames 接了 at 参数
  const src = b
  const grabBlock = src.slice(src.indexOf('async function grabFrames('), src.indexOf('async function transcribe('))
  must(grabBlock.includes('parseAtTimes(at'), 'grabFrames 里没调 parseAtTimes')
  // KNOWN_FLAGS 加了 at（第二步起改真跑；顺带钉住 `--at` 进了 VALUE_OPTS ——
  //   它原来不在那张表里，`help --at 12:30` 会把 12:30 当成位置参数去 resolveSource）
  const atOk = flagAccepted('at', '12:30')
  must(atOk.ok, `look.mjs 报「未知参数 --at」：stderr=${atOk.err.slice(0, 160)}`)
  return 'parseAtTimes 真跑：750/12:30/12:30-13:10 三种格式都对，abc 报错；grabFrames 接了 at，KNOWN_FLAGS 有 at'
})

check('C45 时间索引固定格式 r1c1 00:00-00:05 @00:02（A4：三处出索引）', () => {
  const b = read('tools/look.mjs')
  const { fmtIdxLine } = compile(b, ['fmtIdxLine'])
  // 真跑：格式是 rXcY mm:ss-mm:ss @mm:ss
  must(fmtIdxLine(1, 1, 0, 5) === 'r1c1 00:00-00:05 @00:02', `fmtIdxLine(1,1,0,5) 输出错了：${fmtIdxLine(1,1,0,5)}`)
  must(fmtIdxLine(1, 2, 45, 50) === 'r1c2 00:45-00:50 @00:47', `fmtIdxLine(1,2,45,50) 输出错了：${fmtIdxLine(1,2,45,50)}`)
  // 调用点：三处都出索引
  const src = b
  const peekBlock = src.slice(src.indexOf('async function cmdPeek('), src.indexOf('async function grabFrames('))
  must(peekBlock.includes('fmtIdxLine(1, i + 1'), 'peek 没出索引')
  const sheetBlock = src.slice(src.indexOf('async function cmdSheet('), src.indexOf('async function cmdSubstrip('))
  must(sheetBlock.includes('fmtIdxLine(row, col'), 'sheet 没出索引')
  const framesBlock = src.slice(src.indexOf('async function cmdFrames('), src.indexOf('async function cmdOcr('))
  must(framesBlock.includes('fmtIdxLine(1, names.length'), 'frames --at 没出索引')
  return 'fmtIdxLine 真跑：格式 rXcY mm:ss-mm:ss @mm:ss；peek/sheet/frames --at 三处都出索引'
})

check('C46 peek 索引时刻透传全链路：videoshot 返回 times、peekFrames 三个分支都带 times、manifest 写 times、cmdPeek 不自己重算 pcts', () => {
  const b = read('tools/look.mjs')
  // 1. peekViaVideoShot 返回 times
  const peekVsBody = fnBody(b, 'peekViaVideoShot')
  must(peekVsBody.includes('return { times:'), 'peekViaVideoShot 没返回 times——索引时刻对不上')
  // 2. peekFrames 三个 return 分支都透传 times
  const peekFramesBody = fnBody(b, 'peekFrames')
  // 缓存命中分支：return { dir, cached: true, times: m0.times ?? null }
  must(peekFramesBody.includes('times: m0.times ?? null'), 'peekFrames 缓存命中分支没透传 times')
  // videoshot 成功分支：return { dir, cached: false, source: 'videoshot', times: vs.times }
  must(peekFramesBody.includes('times: vs.times'), 'peekFrames videoshot 成功分支没透传 times')
  // mp4 抽帧分支：return { dir, cached: false, times }
  must(peekFramesBody.match(/return \{ dir, cached: false, times \}/), 'peekFrames mp4 抽帧分支没透传 times')
  // 3. manifest 写 times
  must(peekFramesBody.includes('writeManifest(dir, { ok: true, bv, p: v.p ?? 1, frames: 5, source: \'videoshot\', times: vs.times })'), 'peekFrames videoshot 成功时 manifest 没写 times')
  // 4. cmdPeek 不自己重算 pcts（验证没有 const pcts = 这样的变量声明，注释不算）
  const cmdPeekBody = fnBody(b, 'cmdPeek')
  must(!cmdPeekBody.match(/const pcts\s*=/), 'cmdPeek 还在声明 pcts 变量重算时刻——videosort 路径下索引时刻对不上')
  must(cmdPeekBody.includes('r.times'), 'cmdPeek 没遍历 r.times——是不是自己重算了？')
  return 'peekViaVideoShot 返回 times；peekFrames 三个分支都透传 times；manifest 写 times；cmdPeek 遍历 r.times 不自己重算'
})

// C47–C49（2026-10-30，WB-CN）：0.3.9 挡发的两条。①②能溜进「60 条全绿」，根因是 C42–C45 全是
//   字符串断言——这次一律真跑：把判定逻辑抽成顶层纯函数（atDirTag / framesCacheHit / nextGpuCache），
//   喂真输入看真输出，不是 grep 源码里有没有某段字。
check('C47 frames --at 换时刻不许撞缓存（P0：--at 460 与 --at 750 都叫 at-1p，第二次 rc=0 返回 07:40）', () => {
  const b = read('tools/look.mjs')
  // atDirTag / framesCacheHit 搬进 lib/media.mjs，直接 import 真跑。
  //   原来要根据 createHash 注入（compile 的 prelude/params），现在 lib 自己那份 import 了 crypto。
  // 1. 目录名必须带上时刻指纹
  const d460 = atDirTag([460])
  const d750 = atDirTag([750])
  must(d460 && d750 && d460 !== d750, `不同时刻撞同一目录：${d460} vs ${d750}`)
  must(atDirTag([460]) === d460, '同一组时刻算出来的目录名不稳定（会每次新目录、缓存永远命中不了）')
  must(atDirTag(null) === null, '非 at 模式不该有 at 前缀')
  const many = atDirTag(Array.from({ length: 50 }, (_, i) => i * 10))
  must(many.length <= 20, `50 个点的目录名太长（${many.length} 字符），会炸 Windows 路径长度`)
  // 2. 缓存判据必须比对 times（--out 指向同一目录、目录名没法隔离时就靠这条）
  const m460 = { ok: true, step: 20, scene: false, times: [460] }
  must(framesCacheHit(m460, 20, false, [750], 1) === false, 'manifest.times=[460] 却把 --at 750 判成命中——又是 rc=0 给旧帧')
  must(framesCacheHit(m460, 20, false, [460], 1) === true, '同一组时刻没判成命中——每次都重抽，缓存白做')
  must(framesCacheHit({ ok: true, step: 20, scene: false }, 20, false, null, 1) === true, '非 at 模式的老 manifest（无 times）没命中——升级后所有老缓存白抽')
  must(framesCacheHit({ ok: true, step: 20, scene: false }, 20, false, [460], 1) === false, '老 manifest 没有 times 却命中了 at 请求')
  must(framesCacheHit(m460, 20, false, [460], 0) === false, '零张 jpg 也判成命中——残帧被当完整结果')
  // 3. manifest 往返：times 真的写进去、真读回来
  // 2026-10-31：manifest 读写搬进 lib/frames.mjs —— 直接 import 真跑。
  //   原来用 compile 从 look.mjs 抠函数体，搬家后抠不到，判据就变成「找不到 function writeManifest」假红。
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c47-'))
  let backTimes
  try {
    writeManifest(tmp, { ok: true, times: [460, 750] })
    backTimes = readManifest(tmp)?.times
  } finally { rmSync(tmp, { recursive: true, force: true }) }
  must(JSON.stringify(backTimes) === '[460,750]', `manifest 里的 times 读回来是 ${JSON.stringify(backTimes)}`)
  // 4. 调用点：grabFrames 不许退回「只带点数」的写法（剥注释再判——注释里会引用旧写法作对照）
  const grabBody = stripComments(fnBody(b, 'grabFrames'))
  must(!grabBody.includes('at-${atTimes.length}p`'), 'grabFrames 里还是 `at-${atTimes.length}p` 只带点数')
  must(grabBody.includes('atDirTag(atTimes)'), 'grabFrames 没调 atDirTag')
  must((grabBody.match(/framesCacheHit\(/g) || []).length >= 2, 'grabFrames 的缓存判据没走 framesCacheHit（主判据 + 等锁后那处，两处都要）')
  // 5. cmdFrames 只列本次时刻（--out 同一个目录里还留着上一轮的帧时，别把旧帧算进本次索引）
  const { framesToShow } = compile(b, ['framesToShow'])
  const mixed = ['f_12m30s.jpg', 'f_7m40s.jpg']
  must(JSON.stringify(framesToShow([460], mixed)) === '["f_7m40s.jpg"]', `--at 460 时列成了 ${JSON.stringify(framesToShow([460], mixed))}——旧帧混进来了`)
  must(JSON.stringify(framesToShow([750, 460], mixed)) === '["f_12m30s.jpg","f_7m40s.jpg"]', '多个时刻时没按请求顺序列')
  must(JSON.stringify(framesToShow(null, mixed)) === '["f_12m30s.jpg","f_7m40s.jpg"]', 'r.times 缺失（老缓存）时没退回目录扫描排序')
  must(stripComments(fnBody(b, 'cmdFrames')).includes('framesToShow(r.times'), 'cmdFrames 没走 framesToShow')
  // 6. --fresh 删得掉 at 产物：**真跑** manifest.files 那条链路（0.4.1 第 12 条）
  //   原来只查 `const produced` 那一行含不含 `f_` —— 那问的是「源码里有没有这个字」，
  //   既不看算出来的清单对不对，也不看它到底有没有进 manifest。
  //   现在判定是 lib/frames.mjs 的纯函数 frameFilesToKeep，喂真文件名看真输出；
  //   再落一次真 manifest 读回来比对，把「files: produced 真进没进」也一并验掉。
  //   （不需要下 B 站视频 / 起 ffmpeg：`jpgs()` 只是 `listJpgs(dir)`，这段判定本来就不碰 ffmpeg。）
  const BV = 'BV1aaaaaaaaa'
  const dirFiles = [
    `${BV}-01.jpg`, `${BV}-02.jpg`,      // 等间隔产物
    'f_7m40s.jpg', 'f_12m30s.jpg',       // --at 产物
    'f_1m05s.jpg',                       // --at 产物（秒补零，两位）
    'note.txt',                          // 不是 jpg
    `${BV}-p2-01.jpg`,                   // 另一个分P的产物，不该算进本批
  ]
  const kept = frameFilesToKeep(BV, dirFiles)
  must(JSON.stringify(kept) === JSON.stringify([`${BV}-01.jpg`, `${BV}-02.jpg`, 'f_7m40s.jpg', 'f_12m30s.jpg', 'f_1m05s.jpg']),
    `本次产物清单是 ${JSON.stringify(kept)} —— 少了 f_ 会漏删旧时刻帧，混进 -p2- 会误删别的分P`)
  must(frameFilesToKeep(BV, ['f_7m40s.jpg']).length === 1,
    '只有 at 产物时清单为空 —— --fresh 会走「没有清单就一律不碰」，旧时刻帧永远删不掉')
  const tmp2 = mkdtempSync(join(tmpdir(), 'bw-c47b-'))
  let backFiles
  try {
    writeManifest(tmp2, { ok: true, bv: BV, frames: kept.length, files: kept, times: [460, 750] })
    backFiles = readManifest(tmp2)?.files
  } finally { rmSync(tmp2, { recursive: true, force: true }) }
  must(JSON.stringify(backFiles) === JSON.stringify(kept),
    `manifest.files 读回来是 ${JSON.stringify(backFiles)}，与写进去的 ${JSON.stringify(kept)} 不一致 —— --fresh 拿不到清单`)
  // 调用点也必须真接上：判定函数与 manifest 里那份得是同一个来源
  must(grabBody.includes('frameFilesToKeep('), 'grabFrames 没走 frameFilesToKeep —— 清单和判定不是同一份')
  must(/files:\s*produced\b/.test(grabBody), 'grabFrames 没把 produced 传进 writeManifest 的 files')
  return `atDirTag([460])=${d460} ≠ ${d750}；times 不等不命中、零帧不命中、无 times 的老 manifest 非 at 仍命中；manifest 往返 times=${JSON.stringify(backTimes)}；本次产物清单 ${kept.length} 项（含 f_ at 产物、不含 -p2-）真写进 manifest.files 并读回`
})

check('C48 GPU：不确定的结论不许写缓存（P1：一次超时锁死 5 分钟，用户盯着假状态）', () => {
  const src = read('index.js')
  const { nextGpuCache } = compile(src, ['nextGpuCache'], { prelude: 'const GPU_CACHE_MS = 5 * 60 * 1000', params: [], args: [] })
  const old = { at: 100, val: { deviceCount: 1, dllReady: true, cudaLibs: true, note: '' } }
  const sure = nextGpuCache(old, { confident: true, val: { deviceCount: 1, dllReady: false, cudaLibs: true, note: 'x' } }, 999)
  must(sure.at === 999 && sure.val.dllReady === false, '确定的结论没写进缓存（那面板会每 8 秒重探）')
  must(nextGpuCache(old, { confident: false, val: { deviceCount: 0, dllReady: false } }, 999) === old, '不确定的结论也写进了缓存——一次超时锁死 5 分钟')
  must(nextGpuCache(old, null, 999) === old, '探测异常（res=null）也把假状态写进缓存')
  must(nextGpuCache(old, { val: { dllReady: true } }, 999) === old, '没带 confident 的旧形状被当成确定（默认信它就会锁死）')
  // 调用点：gpuStatus 走 nextGpuCache，catch 里不许再写 _gpuCache
  const g = fnBody(src, 'gpuStatus')
  must(g.includes('nextGpuCache('), 'gpuStatus 没走 nextGpuCache')
  must(!/\.catch\([\s\S]{0,400}?_gpuCache\s*=/.test(g), 'gpuStatus 的 catch 里还在写 _gpuCache')
  // ④ reset 之后旧探测不许落地（WB-CN 2026-10-30 lifecycle 复核：原来 reset 只置空 _probePromise，
  //   在飞那次完成时照样写缓存——用户刚装完运行库点「重置」，旧结论会把新的盖掉，还再锁 5 分钟）
  must(g.includes('mySeq === _gpuSeq'), 'gpuStatus 没有序号判据——resetGpuCache() 之后在飞的旧探测会把新结论盖掉')
  must(fnBody(src, 'resetGpuCache').includes('_gpuSeq++'), 'resetGpuCache 没推进 _gpuSeq，序号判据永远成立')
  return 'nextGpuCache 真跑：确定才写、不确定/异常/无 confident 都不动缓存；gpuStatus catch 不再写缓存；reset 后旧探测不落地'
})

check('C49 GPU 探测失败必须说真因（P1：stdio:ignore 让面板只剩一句「加载失败」，看不见超时还是缺 DLL）', () => {
  const src = read('index.js')
  const body = fnBody(src, 'probeGpu')
  must(!/stdio:\s*'ignore'/.test(body), "probeGpu 里还有 stdio:'ignore'——子进程输出全丢，失败只剩笼统文案")
  const utf8 = (body.match(/encoding:\s*'utf8'/g) || []).length
  must(utf8 >= 3, `probeGpu 只有 ${utf8} 处收输出，nvidia-smi / spec / --probe-gpu 三处都要（否则看不出真因）`)
  must(body.includes('probeWhy('), 'probeGpu 失败时没调 probeWhy——真因（超时/退出码/stderr）没进 note')
  must(!body.includes('cublas64_12.dll 加载失败（GPU 运行库未装'), '旧的笼统文案还在')
  must(/const GPU_PROBE_TIMEOUT_MS = 10000/.test(src), 'GPU_PROBE_TIMEOUT_MS 不是 10000（3 秒偏紧，机器忙时被当成「没装」）')
  // probeWhy 真跑：超时要说 killed，非零退出要带 code 与 stderr 末段
  const { probeWhy } = compile(src, ['probeWhy'], { prelude: 'const GPU_PROBE_TIMEOUT_MS = 10000', params: [], args: [] })
  const killed = probeWhy({ ok: false, stdout: '', err: { killed: true, code: null, signal: 'SIGTERM' } })
  must(/超时/.test(killed) && /killed=true/.test(killed), `超时的真因写错了：${killed}`)
  const bad = probeWhy({ ok: false, stdout: '', err: { code: 1, stderr: 'ImportError: DLL load failed while importing cublas: 找不到指定的模块。' } })
  must(/code=1/.test(bad) && /DLL load failed/.test(bad), `stderr 没带到 note 里：${bad}`)
  return `10 秒超时；三处都收 utf8；probeWhy 真跑：超时→「${killed}」、失败→「${bad.slice(0, 60)}…」`
})

// C50（2026-10-30，WB-CN）：C43 只查函数体字符串——把 peekViaVideoShot 开头插一句
//   `if (true) return { times: [] }`（后面死代码留着），C43 照样绿，而 peek 永远回落抽帧。
//   这里真跑：桩掉网络(jget/downloadTo)与 ffmpeg(ffExec)，离线喂一份 index，看 times 到底等于什么。
//   为什么用子进程：check 回调是同步的，等不了 Promise；子进程里可以 await，execFileSync 天然同步等待。
check('C50 peek videoshot 真跑到 times（桩掉网络与 ffmpeg）：不许一进门就短路', () => {
  const script = `
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const SRC = ${JSON.stringify(join(HERE, 'look.mjs'))}
const src = readFileSync(SRC, 'utf8')
const i = src.indexOf('async function peekViaVideoShot(')
if (i < 0) throw new Error('找不到 peekViaVideoShot')
const j = src.slice(i).search(/\\n\\}/)
if (j <= 0) throw new Error('peekViaVideoShot 没有行首闭合括号')
const body = src.slice(i, i + j + 2)
const dir = mkdtempSync(join(tmpdir(), 'bw-c50-'))
const INDEX = Array.from({ length: 188 }, (_, k) => k * 5)
const jget = async () => ({ code: 0, data: { image: ['//i0.hdslb.com/bfs/x.jpg'], index: INDEX, img_x_len: 10, img_y_len: 10, img_x_size: 480, img_y_size: 270 } })
const downloadTo = async (url, dest) => { writeFileSync(dest, 'x') }
const ffExec = (bin, args) => { writeFileSync(args[args.length - 1], 'x') }
const ffTimeoutMs = () => 1000
try {
  const f = new Function('jget', 'downloadTo', 'ffExec', 'ffTimeoutMs', 'existsSync', 'join', 'readdirSync', 'unlinkSync',
    body + '\\nreturn peekViaVideoShot')(jget, downloadTo, ffExec, ffTimeoutMs, existsSync, join, readdirSync, unlinkSync)
  const r = await f('BV1test', { dur: 936 }, dir, 'ffmpeg')
  // 2026-10-31：期望值从 index[0/46/93/140/187] 改为 index[1/47/94/140/187]。
  //   不是放宽——格 k 存的是 index[k+1]（灰度指纹对拍实测，见 C52），所以 t 必须整体右移一格。
  const want = [1, 47, 94, 140, 187].map((k) => INDEX[k])
  console.log(JSON.stringify({ got: r && r.times, want }))
} finally { rmSync(dir, { recursive: true, force: true }) }
`
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c50p-'))
  try {
    const f = join(tmp, 'c50.mjs')
    writeFileSync(f, script)
    const out = execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 60000 })
    const { got, want } = JSON.parse(out.trim().split('\n').pop())
    must(Array.isArray(got), `peekViaVideoShot 没返回 times（返回的是 ${JSON.stringify(got)}）——一进门就短路了？`)
    must(JSON.stringify(got) === JSON.stringify(want), `times 对不上：拿到 ${JSON.stringify(got)}，应该是 index[1/47/94/140/187]=${JSON.stringify(want)}`)
    return `真跑：index 188 点 → times=${JSON.stringify(got)}，与 index[1/47/94/140/187] 逐个相等`
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

check('C52 peek 取格不许错位（P1：格 k 存 index[k+1]，按 index[k] 取会整排错一格、末帧落黑格）', () => {
  // 真跑 peekViaVideoShot，把每帧的 crop 参数与「格号」一起记下来，三条一起断：
  //   ① times 必须是 index[k+1]（不是 index[k]）
  //   ② 末帧不许落到「格数」以外（usable = index.length - 1，末格号 usable-1）
  //   ③ crop 的 x/y 必须由格号算出（idx→row/col→像素），三方对齐才算「像素就是那个时刻」
  const script = `
import { readFileSync, mkdtempSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const SRC = ${JSON.stringify(join(HERE, 'look.mjs'))}
const src = readFileSync(SRC, 'utf8')
const i = src.indexOf('async function peekViaVideoShot(')
if (i < 0) throw new Error('找不到 peekViaVideoShot')
const j = src.slice(i).search(/\\n\\}/)
const body = src.slice(i, i + j + 2)
const dir = mkdtempSync(join(tmpdir(), 'bw-c52-'))
// 188 个时间点 = 187 格（0..186）：最后一点是哨兵，不能当格用
// 非方阵 8×5（不是 10×10）：这样「列数取 x_len 还是 y_len」也会被这条钉住
const INDEX = Array.from({ length: 188 }, (_, k) => 100 + k * 5)
const jget = async () => ({ code: 0, data: { image: ['//a.jpg', '//b.jpg', '//c.jpg', '//d.jpg', '//e.jpg'], index: INDEX, img_x_len: 8, img_y_len: 5, img_x_size: 480, img_y_size: 270 } })
const downloadTo = async (url, dest) => { writeFileSync(dest, 'x') }
const crops = []
const ffExec = (bin, args) => {
  const k = args.indexOf('-vf')
  crops.push(k >= 0 ? args[k + 1] : null)
  writeFileSync(args[args.length - 1], 'x')
}
const ffTimeoutMs = () => 1000
try {
  const f = new Function('jget', 'downloadTo', 'ffExec', 'ffTimeoutMs', 'existsSync', 'join', 'readdirSync', 'unlinkSync',
    body + '\\nreturn peekViaVideoShot')(jget, downloadTo, ffExec, ffTimeoutMs, existsSync, join, readdirSync, unlinkSync)
  const r = await f('BV1test', { dur: 936 }, dir, 'ffmpeg')
  console.log(JSON.stringify({ times: r && r.times, crops, len: INDEX.length }))
} finally { rmSync(dir, { recursive: true, force: true }) }
`
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c52p-'))
  try {
    const f = join(tmp, 'c52.mjs')
    writeFileSync(f, script)
    const out = execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 60000 })
    const { times, crops } = JSON.parse(out.trim().split('\n').pop())
    const INDEX = Array.from({ length: 188 }, (_, k) => 100 + k * 5)
    const usable = INDEX.length - 1 // 187 格：0..186
    // 均匀覆盖 0..usable-1 的 5 个格号
    const wantIdx = [0, 1, 2, 3, 4].map((i) => Math.floor((usable - 1) * i / 4))
    const wantTimes = wantIdx.map((k) => INDEX[k + 1])
    must(JSON.stringify(times) === JSON.stringify(wantTimes),
      `times 不是 index[格号+1]：拿到 ${JSON.stringify(times)}，应为 ${JSON.stringify(wantTimes)}（格号 ${JSON.stringify(wantIdx)}）`)
    must(wantIdx[wantIdx.length - 1] <= usable - 1, `末格号越界：${wantIdx[wantIdx.length - 1]} > ${usable - 1}`)
    // 格号 → 行列 → 像素，必须与 crop 一致（列数取 img_x_len：非方阵拼版图按 y_len 算会整排错）
    const cols = 8, rows = 5
    const wantCrops = wantIdx.map((k) => {
      const inSheet = k % (cols * rows)
      return `crop=480:270:${(inSheet % cols) * 480}:${Math.floor(inSheet / cols) * 270}`
    })
    must(JSON.stringify(crops) === JSON.stringify(wantCrops),
      `crop 与格号对不上：拿到 ${JSON.stringify(crops)}，应为 ${JSON.stringify(wantCrops)}`)
    return `真跑：格号 ${JSON.stringify(wantIdx)}（末格 ${usable - 1} 未越界）→ times=${JSON.stringify(times)}、crop 逐个对齐`
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

check('C51 /bili 层「收不收」与「提示表」不许分叉（P1：parseCommandLine 才是判据，漏词=拒执行且自指报错）', () => {
  const src = read('index.js')
  const listLit = src.match(/const KNOWN_FLAGS = (\[[^\]]*\])/)
  must(listLit, '找不到 index.js 的 KNOWN_FLAGS')
  const flags = new Function(`return ${listLit[1]}`)()
  const { parseCommandLine } = compile(src, ['parseCommandLine'])
  // 三个例外：写了理由才能进这张清单；清单里的词必须真的在 KNOWN_FLAGS 里（下面会查），
  //   这样「表改了、例外说明过期」也会红。
  const EXEMPT = {
    '--quiet': '/bili 层自己有渲染，用不上 CLI 的 QUIET 抑制',
    '--help': '/bili 没有 help 命令（look.mjs 那边才有）',
    '--frames': '/bili 没有 local 命令；它是 --ocr 的别名，斜杠层传 --ocr',
  }
  const WITH_VALUE = new Set(['--step', '--p', '--cred', '--days', '--limit', '--order', '--grid',
    '--out', '--ffmpeg', '--head', '--format', '--at', '--asr-max', '--key'])
  const missed = []
  for (const f of flags) {
    if (EXEMPT[f]) continue
    const line = WITH_VALUE.has(f) ? `text BV1xx411c7mD ${f} tmp` : `text BV1xx411c7mD ${f}`
    const r = parseCommandLine(line)
    if (r.unknownFlags.includes(f)) missed.push(`${f}（${line} → 未知参数）`)
    else if (!r.extra.includes(f)) missed.push(`${f}（${line} → 被静默吞掉，没进 extra）`)
  }
  must(missed.length === 0, `parseCommandLine 不收这些白名单词，斜杠层会拒执行：${missed.join('、')}`)
  // 反向：实现了分支却没进提示表 → 用户看到「未知参数 X，你是想用 X 吗」（60e0c86 就是这么坏的）
  const implemented = [...new Set([...src.matchAll(/t === '(--[a-z-]+)'/g)].map((m) => m[1]))]
  must(implemented.length >= 15, `只从 parseCommandLine 里认出 ${implemented.length} 个分支，正则失效了？`)
  const unlisted = implemented.filter((f) => !flags.includes(f) && !EXEMPT[f])
  must(unlisted.length === 0, `parseCommandLine 收这些词但提示表里没有：${unlisted.join('、')}`)
  for (const k of Object.keys(EXEMPT)) must(flags.includes(k), `例外 ${k} 不在 KNOWN_FLAGS 里——例外清单过期了`)
  return `${flags.length} 个词逐个真跑 parseCommandLine 全部收下；${implemented.length} 个分支全部在提示表里；例外 ${Object.keys(EXEMPT).length} 个`
})

check('C53 `<命令> --help` 只打帮助、不许执行（P1：clean --help 真删了 158 个文件 / 18.1 MB）', () => {
  // 实测踩到的：help 只按位置参数判（cmd === 'help'），--help 落在 opts 里没人读，
  //   于是 `node look.mjs clean --help` = 真清缓存。这条用隔离缓存真跑一次，钉住「不许有副作用」。
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c53-'))
  try {
    const cache = join(tmp, 'cache')
    const bvDir = join(cache, 'frames', 'BV1aaaaaaaaa')
    mkdirSync(bvDir, { recursive: true })
    writeFileSync(join(cache, '.bili-watch-root'), '{}')
    writeFileSync(join(bvDir, 'meta.json'), '{"bv":"BV1aaaaaaaaa"}')
    const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'clean', '--help'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DSH_HOME: tmp, BILI_WATCH_CACHE: cache },
    })
    const out = String(r.stdout || '')
    must(existsSync(join(bvDir, 'meta.json')), '`clean --help` 真的执行了 clean（隔离缓存里的目录被删）——help 必须只打帮助')
    must(/用法:/.test(out), `\`clean --help\` 没打帮助（stdout 前 120 字：${out.slice(0, 120)}）`)
    return '真跑：隔离缓存里 clean --help 未删任何文件，且打印了用法'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// C54（2026-10-31，issue #6 坑 4）：两个安装脚本的 pip 版本约束必须逐字一致。
//   背景：faster-whisper 1.2.1 的 audio.py:46 无条件传 av.open(metadata_errors=...)，而 PyAV 19
//   删了这个参数 —— 裸 `pip install faster-whisper` 拉到 av 19 就在 decode_audio() 里抛
//   TypeError，转写和抽帧一起坏，报错还在第三方库内部，用户根本定位不到。
//   Windows 侧 fetch-deps.ps1 早就钉了 av==15.1.0，Linux 侧 fetch-deps.sh 原来只写包名 ——
//   同一份代码在两条脚本下行为不同，这条守卫盯的就是「两边说的是同一组版本」。
check('C54 安装脚本的 pip 版本约束齐（issue #6 坑 4：av 19 会让 faster-whisper 1.2.1 抛 TypeError）', () => {
  // 2026-11-02（fetch-deps 合一）：这条原来叫「**两个**安装脚本的 pip 版本约束一致」。
  //
  //   合一之后「一致」不再是一条要守的性质 —— 只有一份代码，不一致在结构上不可能发生。
  //   这里**没有**把它改写成「比一份自己跟自己一不一致」那种恒真的假判据（那等于删了它却留着编号）。
  //   改守真正还会出错的两件事：
  //     ① 四个 pin 还在 —— 漏一个就会装到不兼容版本（av 19 → decode_audio() 抛 TypeError）；
  //     ② ensureVenv 的**调用行**里没有裸 av / av>=19 把 pin 盖掉。
  //   顺手把旧判据的松处收紧：原来按 `includes('ensure_venv')` 数行，函数定义行 `ensure_venv() {`
  //   也算进去了，于是「定义 1 行 + 调用 1 行」就能满足 >=2。现在只数调用行，要求 asr 与 ocr 各一处。
  const fd = read('scripts/fetch-deps.mjs')
  const pins = ['faster-whisper==1.2.1', 'av==15.1.0', 'ctranslate2==4.8.3', 'rapidocr-onnxruntime==1.2.3']
  const miss = pins.filter((p) => !fd.includes(p))
  must(miss.length === 0, `fetch-deps.mjs 缺版本约束：${miss.join('、')}——不锁 av 会装到 19，decode_audio() 抛 TypeError`)
  // 只看真正会执行的行（注释里本来就要提「av 19 会炸」，连注释一起扫会把这条守卫变成报警器）。
  const callLines = fd.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !/^\s*function\s/.test(l) && l.includes('ensureVenv('))
  must(callLines.length >= 2, `fetch-deps.mjs 里 ensureVenv 的调用行只找到 ${callLines.length} 行（应有 asr 与 ocr 各一处）`)
  for (const l of callLines) {
    const bareAv = /(^|[\s"'])av(["'\s]|$)/.test(l)
    const av19 = /av[><]=?\s*19|av==19/.test(l)
    must(!bareAv, `fetch-deps.mjs 的调用行里有裸 av（没带版本约束）：${l.trim()}`)
    must(!av19, `fetch-deps.mjs 的调用行把 av 放到了 19：${l.trim()}`)
  }
  return `四个 pin 齐；${callLines.length} 条调用行无裸 av / av>=19（「两份一致」已因合一不复存在，改守单份内容）`
})

// —— issue #6 / #5 的 Linux 修复（2026-10-31）——
// 本机没有 WSL，Linux 分支只能靠「桩掉 curl / tar / python3，真跑原样函数体」来验。
//
// 2026-11-02（fetch-deps 合一）：这里原来还挂着一个 190 秒的全量夹具
//   tools/fixtures/fetch-deps-sh.test.sh（14 用例 / 39 断言）。
//   脚本合成 node 一份后它自动失效，**已删除** —— 留着会让下一个人以为「还有一份全量覆盖」，
//   而它测的脚本根本不存在了。这就是那条老教训的现场：夹具不进门禁就会悄悄过期。
//
//   现在这一层的真跑统一走下面的 fdProbe()：**切源文件的定义段原样跑**，只桩外部能力。
//   覆盖面比那份 14 用例窄，窄在「不跑真实 curl/tar」，不窄在「不跑被测代码」。窄在哪，
//   每条判据的返回串里都写明了。

// 找一个能用的 bash（Windows 上是 Git Bash；发布树/用户机器上没有就 SKIP）
const findBash = () => {
  for (const c of [process.env.BASH, 'bash', 'C:/Program Files/Git/bin/bash.exe', '/bin/bash'].filter(Boolean)) {
    const r = spawnSync(c, ['-c', 'echo bwok'], { encoding: 'utf8', timeout: 15000 })
    if (r.status === 0 && /bwok/.test(r.stdout || '')) return c
  }
  return ''
}
// Python 版 fnBody：从 `def NAME(` 到下一个顶层定义（def / class / if __name__）
const pyFn = (src, name) => {
  const i = src.indexOf(`def ${name}(`)
  must(i >= 0, `找不到 def ${name}`)
  const rest = src.slice(i)
  const m = /\n(?=def |class |if __name__)/.exec(rest)
  must(m, `${name} 后面没找到下一个顶层定义`)
  return rest.slice(0, m.index)
}
const findPowerShell = () => {
  for (const c of ['powershell', 'pwsh']) {
    const r = spawnSync(c, ['-NoProfile', '-Command', 'Write-Output pwok'], { encoding: 'utf8', timeout: 20000 })
    if (r.status === 0 && /pwok/.test(r.stdout || '')) return c
  }
  return ''
}
const findPy = () => {
  for (const c of ['python3', 'python', 'py'].filter(Boolean)) {
    const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15000 })
    if (r.status === 0 && /1/.test(r.stdout || '')) return c
  }
  return ''
}

// ── fetch-deps 探针（2026-11-02，fetch-deps 合一后新增）───────────────────
//
//   合一前那批判据靠「假 curl / 假 tar 塞进 PATH 前面」来真跑 shell 脚本。现在被侧对象是 node，
//   而那两条路全断了：`curlBin()` 在 Windows 返回 `System32\curl.exe` 的**绝对路径**，
//   `tarBin()` 同理 —— PATH 前置一律无效（老判据在 Linux 上生效、在 Windows 上整条 skip，
//   所以这个坑一直没暴露）。
//
//   做法：把 scripts/fetch-deps.mjs 的**定义段原样切出来**（切到「// ── 主流程」锚点为止），
//   拼上 tools/fixtures/fetch-deps-probe-tail.txt 里那截「桩掉外部能力」的尾巴，生成可执行探针。
//
//   两个要点：
//     · 切的是**源文件原始字节**，不是手抄。手抄抄错的方式常与被测 bug 同型（同一份逻辑
//       写两遍、两处错得一样），那样测出来的绿没有信息量。
//     · 只桩「环境」：网络下载、tar/pip/python 这些外部命令。被测的 if/else、文案、
//       退出路径一个字都没动 —— 桩 run 返回什么，就走原样代码里对应的那条分支。
const FD_PROBE_TAIL = readFileSync(join(ROOT, 'tools', 'fixtures', 'fetch-deps-probe-tail.txt'), 'utf8')

/**
 * 生成一个探针并跑一条模式。
 * @param {string} mode BW_PROBE_MODE（ffmpeg-html / ffmpeg-list6000 / ffmpeg-version / bootstrap-pip / move-venv / venv-import）
 * @param {object} env 额外环境变量
 * @returns {{ r: object, dir: string, out: () => string, kv: (k: string) => string }}
 */
const fdProbe = (mode, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-fdprobe-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'lib'), { recursive: true })
  copyFileSync(join(ROOT, 'lib', 'plugin-paths.mjs'), join(dir, 'lib', 'plugin-paths.mjs'))
  const src = read('scripts/fetch-deps.mjs')
  const cut = src.indexOf('// ── 主流程')
  must(cut > 0, 'fetch-deps.mjs 里找不到「// ── 主流程」锚点 —— 结构变了，探针切不出来（锚点别删，它是这条测试接缝）')
  const probe = join(dir, 'scripts', 'probe.mjs')
  writeFileSync(probe, src.slice(0, cut) + '\n' + FD_PROBE_TAIL, 'utf8')
  // 传 'all' 占住 positional，否则 target 校验会拿模式名当 target 直接 exit 2。
  const r = spawnSync(process.execPath, [probe, 'all', 'probe'], {
    env: {
      ...process.env,
      BILI_WATCH_DEPS: join(dir, 'deps'),
      DSH_HOME: join(dir, 'home'),
      BW_PROBE_MODE: mode,
      BW_PROBE_DIR: dir,
      ...env,
    },
    encoding: 'utf8', timeout: 180000,
  })
  const out = () => `${r.stdout || ''}\n${r.stderr || ''}`
  // 探针把结果打成 PROBE_KEY=value；取不到返回空串（调用方用它做断言，不要用「有没有这一行」当判据）
  const kv = (k) => {
    const m = new RegExp(`^PROBE_${k}=(.*)$`, 'm').exec(r.stdout || '')
    return m ? m[1].trim() : ''
  }
  return { r, dir, out, kv }
}

// C115（2026-11-01，准修 P0 后加）：发布链不许被自己的闸门堵死。
//
//   为什么 C114（静态查字面量）还不够：
//   P0 的真实形态是「闸门跑不起来」，而不是「某个文件里有个字符串」。
//   scripts/check-public-text.mjs 曾把身份写死在自己的正则里，而它在 $repoOnly 里，
//   sync 的「仅仓库」那遍扫描用 $hardRules（本机身份）扫 repoOnly 文件 ——
//   于是**闸门自己撞自己的闸门**，真跑 release.ps1 必然在 sync 阶段 exit 2。
//   0.4.2 发于 13:58、check-public-text.mjs 进 scripts/ 是 14:12 —— 闸门从那以后
//   一次都没真跑过，所以没人发现（静态断言当时也不存在）。
//
//   这条是**端到端**的：造一个隔离副本（源 ≠ 发布树），真跑一次 sync-release.ps1 -DryRun，
//   要求 rc=0。它能抓住任何形态的「自己撞自己」，不只是「写死在某个文件里」。
//
//   为什么用 -DryRun：DryRun 在复制之前退出，不动任何文件 ——
//   隔离副本是唯一的安全网，绝不能去碰真发布树。
//
//   注意这条必须放在 findPowerShell 定义之后（const 声明不提升，用早了会 TDZ）。
check('C115 发布链真跑一遍 sync（不许被自己的闸门堵死——P0 的真实形态）', () => {
  const ps1 = join(ROOT, 'scripts', 'sync-release.ps1')
  if (!existsSync(ps1)) {
    skip('C115 发布链真跑一遍 sync', '发布树不含 scripts/sync-release.ps1（含本机路径，只留开发态）')
    return 'ok'
  }
  const pwsh = findPowerShell()
  if (!pwsh) {
    skip('C115 发布链真跑一遍 sync', '这台机器没有 powershell/pwsh（Windows 自带 powershell.exe；macOS/Linux 装上 pwsh 就好，装好后这条会真跑）')
    return 'ok'
  }
  // 隔离副本：源树与发布树都复制到临时目录，两边独立 —— 真发布树绝不碰。
  //   源树要带 .leak-ids（它是 gitignore 的，但本机有；复制时手动带上，
  //   否则测的是「没有清单」的退化路径，测不到「有清单时自己撞自己」那个形态）。
  //
  //   复制用**逐文件** copyFileSync 而不是 fs.cpSync：
  //   实测 cpSync({recursive:true}) 在这台 Windows 上复制目录会卡死（scripts/ 那步就挂住，
  //   verify 直接无输出退出）—— 逐文件复制同一棵树只要 93ms。
  const copyTree = (s, d) => {
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true })
      for (const e of readdirSync(s)) copyTree(join(s, e), join(d, e))
    } else {
      mkdirSync(dirname(d), { recursive: true })
      copyFileSync(s, d)
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-sync-'))
  const src = join(tmp, 'src')
  const rel = join(tmp, 'rel')
  try {
    // 复制清单**从 package.json 的 files 展开**，不再手写一份。
    //
    //   为什么必须这样（2026-11-01 实测踩出来的，这条判据自己假绿过一次）：
    //   原来这里是硬编码的 need 清单，写的是 package.json / scripts / tools / lib / index.js …
    //   唯独漏了 docs/。而 35d78ee 把 docs/*.png 加进了 files 白名单 ——
    //   副本里没有 png，sync 的 Test-Path 判假就 continue，于是**这条端到端判据一直绿着**，
    //   真跑 sync 却红（png 的压缩数据里随机字节 `p:\` 撞上盘符规则）。
    //   实测：同一份 need 清单，加一个 docs 就 rc 1→0 反转（探针见提交说明）。
    //
    //   教训与「别自己另编 repoOnly 清单」同源：**检查面必须从权威清单展开**，
    //   手写一份等于给判据开了个默认关掉的口子 —— 且这个口子只会越来越大。
    //
    //   scripts/ 额外带上：sync 脚本自己（scripts/sync-release.ps1）不在 files 里，
    //   但副本里必须有它才能跑；package.json 同理（files 清单本身就是从它读的）。
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const need = new Set(['package.json', 'scripts'])
    for (const entry of pkg.files || []) {
      const rel1 = String(entry).replace(/[\\/]+$/, '').replace(/\\/g, '/')
      if (rel1) need.add(rel1)
    }
    // $repoOnly 也要展开（2026-11-01 第三轮）。
    //   「只进 GitHub 仓库、不进 npm 包」的文件**在发布树里是存在的** —— sync 的 [copy-repo]
    //   那几行就干这个。但副本原来只有 files 展开的东西，没有 tools/verify.mjs 这些，
    //   于是 sync 的「发布树（仅仓库）」那遍扫描：**原来** Test-Path 判假就 continue（静默跳过、
    //   照打 [ok]），**现在**改成「清单里有、盘上没有 ⇒ 红」，副本立刻露馅（C115 由绿转红）。
    //   这正是那条改动想要的效果：副本不完整必须红，不许靠静默跳过蒙过去。
    //   仍然不手写清单：$repoOnly 的权威在 sync-release.ps1 里，从那里解析。
    const syncSrc = readFileSync(join(ROOT, 'scripts', 'sync-release.ps1'), 'utf8')
    const roMatch = /\$repoOnly\s*=\s*@\(([\s\S]*?)\)/.exec(syncSrc)
    must(roMatch, 'C115 副本：从 sync-release.ps1 里解析不出 $repoOnly 数组 —— 清单结构变了？先看这条正则')
    // 注意引号：$repoOnly 数组里用的是**双引号**（"tools/verify.mjs"），不是单引号。
    //   第一版按单引号解析，得到 0 项 —— 而「解析出 0 项」本来会被下面那条 must 拦住，
    //   所以它是「红着被发现的」，不是静默假绿。
    const repoOnly = [...roMatch[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
    must(repoOnly.length >= 4, `C115 副本：$repoOnly 只解析出 ${repoOnly.length} 项，解析结果不像真的`)
    for (const r1 of repoOnly) need.add(r1)
    for (const rel1 of need) {
      const s = join(ROOT, rel1)
      if (!existsSync(s)) continue
      copyTree(s, join(src, rel1))
    }
    // 副本必须覆盖扫描面 —— 这条是这次补的，堵的就是「判据自己假绿」那个洞。
    //
    //   2026-11-01 实测：need 硬编码漏了 docs/，副本里没有 png，sync 的 Test-Path 判假
    //   就 continue，于是 C115 一直绿着，真跑 sync 却红。**判据在验错对象比判据不够真更隐蔽** ——
    //   它连红一次的机会都没有。
    //
    //   现在显式断言：files 里列的每一项（目录/manifest 里的每个文件）在副本里都存在。
    //   缺一个就是判据有口子，直接红，不许悄悄少扫。
    const missing = []
    for (const entry of pkg.files || []) {
      const rel1 = String(entry).replace(/[\\/]+$/, '').replace(/\\/g, '/')
      if (!rel1) continue
      const inSrc = join(src, rel1)
      const inRoot = join(ROOT, rel1)
      if (!existsSync(inRoot)) continue // 源树里就没有（files 列了但没这个文件）→ 那是别的判据管的事
      if (!existsSync(inSrc)) { missing.push(rel1); continue }
      if (statSync(inRoot).isDirectory()) {
        for (const f of readdirSync(inRoot)) {
          if (!existsSync(join(inSrc, f))) missing.push(`${rel1}/${f}`)
        }
      }
    }
    // repoOnly 项同样要覆盖（2026-11-01 第三轮，理由见上面 need 那段）
    for (const r1 of repoOnly) {
      if (!existsSync(join(ROOT, r1))) { missing.push(`${r1}（repoOnly，源树里也没有）`); continue }
      if (!existsSync(join(src, r1))) missing.push(`${r1}（repoOnly）`)
    }
    must(missing.length === 0,
      `C115 的隔离副本漏了 ${missing.length} 项（${missing.join(', ')}）—— 副本没覆盖扫描面，\n` +
      `  这条判据就是在验错对象（真跑 sync 会扫到、副本里却压根没有）。\n` +
      `  复制清单必须从 package.json 的 files 展开，不许手写。`)
    // 发布树副本：从源树复制一份（当发布树的初态，drift 小、跑得快）
    copyTree(src, rel)
    // .leak-ids：gitignore 的文件不在 git 里，但本机有 —— 手动带上
    const lf = join(ROOT, '.leak-ids')
    if (existsSync(lf)) copyFileSync(lf, join(src, '.leak-ids'))

    const r = spawnSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Source', src, '-Release', rel, '-DryRun'],
    { encoding: 'utf8', timeout: 120000 })
    const out = `${r.stdout || ''}\n${r.stderr || ''}`
    must(r.status === 0,
      `sync-release.ps1 -DryRun 红了（rc=${r.status}）—— 发布链被自己的闸门堵死了。\n` +
      `  这就是 2026-11-01 那个 P0 的形态（闸门自己撞自己的闸门）。\n` +
      `  末几行：\n${out.split('\n').slice(-6).map((l) => '    ' + l).join('\n')}`)
    // 不能是「因为没东西可扫才绿」—— 要看到它真的跑到了扫描那两段。
    //
    //   判据只能认 ASCII：PowerShell 5.1 的控制台输出是 GBK 字节，spawnSync 用 utf8
    //   解码 → 中文全是乱码（实测输出是「[DryRun] �� 27 ���ļ�」）。
    //   拿中文当判据等于永远匹配不上 —— 这是真踩到的坑。
    //
    //   认得出来的 ASCII 痕迹：
    //     · DryRun 清单里的每行是相对路径（纯 ASCII）
    //     · 清单前后的标记里带 "[DryRun]" 与 "DryRun"
    //   所以数「清单行数」：文件清单一行一个，全是 ASCII 路径。
    const lines = out.split('\n')
    const listLines = lines.filter((l) => /^\s{2}[A-Za-z0-9._\-/\\]+\s*$/.test(l))
    must(listLines.length >= 20,
      `sync 的 DryRun 清单只认出 ${listLines.length} 行（应 ≥20）—— 它可能压根没跑到清单那段（假绿）。\n` +
      `  末几行：\n${lines.slice(-8).map((l) => '    ' + l).join('\n')}`)
    must(/DryRun/.test(out),
      `sync 的输出里没有 DryRun 标记 —— 它可能走的是别的分支（假绿）：\n${lines.slice(-8).join('\n')}`)

    // 二进制跳过必须**明说**（[skip] 行 + 文件名），不许静默少扫。
    //   「静默跳过」= 发出去的东西不检查，正是 P1-2 修掉的那种假绿。
    //   判据只认 ASCII：`[skip]` 与文件名都是 ASCII，中文说明部分是乱码也无妨。
    const binInCopy = []
    const walk = (dir, base) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        const rel1 = base ? `${base}/${e}` : e
        if (statSync(p).isDirectory()) { walk(p, rel1); continue }
        const head = readFileSync(p).subarray(0, 8192)
        if (head.includes(0)) binInCopy.push(rel1)
      }
    }
    walk(src, '')
    if (binInCopy.length > 0) {
      const skipLines = lines.filter((l) => l.includes('[skip]'))
      must(skipLines.length > 0,
        `副本里有 ${binInCopy.length} 个二进制文件（${binInCopy.slice(0, 3).join(', ')}），` +
        `sync 却没打 [skip] 行 —— 它可能在静默跳过（或者又拿文本正则扫二进制了）。\n` +
        `  末几行：\n${lines.slice(-8).map((l) => '    ' + l).join('\n')}`)
      for (const b of binInCopy) {
        const named = skipLines.some((l) => l.includes(b))
        must(named, `二进制文件 ${b} 被跳过了但没在 [skip] 行里点名 —— 少扫了什么必须让人看得见`)
      }
    }
    // 反向：跳过不能变成「全放行」。文本文件里塞本机字面量仍必须红。
    //   （这条是「跳过二进制」这个修法的护栏，没有它，修法就等于开了个洞。）
    //   注入点必须选**扫描面上**的文件：README.md 在 $excludeCopy 里、被加进 $scanList，
    //   所以它一定被扫。别新建一个 PROBE.md —— 不在 files 白名单里，sync 压根不看它，
    //   那样这条护栏会因为「注入点没被扫」而永远绿（又一个验错对象）。
    const readmePath = join(src, 'README.md')
    const readmeOrig = readFileSync(readmePath)
    writeFileSync(readmePath, Buffer.concat([readmeOrig, Buffer.from('\nprobe\nD:\\007\\Dsh\n')]))
    const r2 = spawnSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Source', src, '-Release', rel, '-DryRun'], { encoding: 'utf8', timeout: 120000 })
    must(r2.status !== 0,
      `往副本的 README.md（在扫描面上）塞了一个含本机盘符的**文本**行，sync 居然还是 rc=0 —— ` +
      `「跳过二进制」这个修法把文本检查也一起跳掉了（等于开洞）。`)
    writeFileSync(readmePath, readmeOrig)
    return `rc=0；清单 ${listLines.length} 行、DryRun 标记都在；` +
      `二进制跳过 ${binInCopy.length} 个且都点名；文本注入仍被抓住；副本 ${tmp}`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// C116（2026-11-01，分P 静默回落 P0）：p=NaN / "NaN" / "abc" / "2.7" 以前**不抛错**——
//   旧判定 `p < 1 || p > pages.length` 对 NaN 两边都是 false，于是 pages[NaN-1]=undefined
//   被 `?? pages[0]` 兜成 P1：静默给出 P1 的数据，用户看不出来（"2.7" 尤其阴：标签显示
//   P2.7，数据其实是 P1）。CLI 的 --p 到手是字符串（tools/cli-io.mjs 的 opt()），所以
//   修法必须先把 p 归一成数字再判「正整数」——天真的 Number.isFinite(p) 会把合法的 "2"
//   也砸掉。这条断言真跑 viewOf 验修法，并附带反向自检证明守卫有牙。
//   为什么走子进程：viewOf 是 async，check() 回调写成 async 会被记成 PASS（C77 的坑），
//   所以照 C105–C111 的规矩 spawnSync 起子进程跑内联脚本，结果以 JSON 打 stdout 再断言。
check('C116 viewOf 分P 守卫真跑：NaN/非数字/小数/超界必须抛错、合法值（含 CLI 的字符串 "2"）返回正确分P，且守卫有牙', () => {
  // 内联探针：喂固定 3 分P payload，把整组 case 的结果打成 JSON。
  // 被测模块路径走环境变量（真 lib 一份、改坏版一份），脚本本身不变。
  const SCRIPT = `
    import(process.env.BW_C116_MOD).then(async (mod) => {
      const payload = { code: 0, data: { aid: 1, title: 't', duration: 100,
        pages: [{ cid: 11, duration: 10 }, { cid: 22, duration: 20 }, { cid: 33, duration: 30 }],
        owner: { name: 'u', mid: 1 }, stat: { view: 1, reply: 1 }, desc: '' } }
      const get = async () => payload
      const cases = { n1: 1, n3: 3, s2: '2', nNaN: NaN, sNaN: 'NaN', sabc: 'abc', s27: '2.7', zero: 0, neg: -1, over: 4 }
      const out = {}
      for (const [k, p] of Object.entries(cases)) {
        try { const r = await mod.viewOf({ get }, 'BV1fix', p); out[k] = { cid: r.cid, p: r.p } }
        catch (e) { out[k] = { err: String((e && e.message) || e) } }
      }
      process.stdout.write(JSON.stringify(out))
    })
  `
  const runCases = (modPath, tag) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT],
      { env: { ...process.env, BW_C116_MOD: pathToFileURL(modPath).href }, encoding: 'utf8', timeout: 60000 })
    must(r.status === 0, `${tag}：探针子进程挂了（rc=${r.status}）：${(r.stderr || '').slice(0, 300)}`)
    try { return JSON.parse(String(r.stdout).trim()) } catch { must(false, `${tag}：探针输出不是 JSON：${String(r.stdout).slice(0, 200)}`) }
  }

  // ① 真 lib：合法值（数字与 CLI 传来的字符串形态）返回对应分P，且 p 归一成数字
  const ok = runCases(join(ROOT, 'lib', 'bili-api.mjs'), '真 lib')
  must(ok.n1?.cid === 11 && ok.n1.p === 1, `p=1 应给 P1（cid 11）：${JSON.stringify(ok.n1)}`)
  must(ok.n3?.cid === 33 && ok.n3.p === 3, `p=3 应给 P3（cid 33）：${JSON.stringify(ok.n3)}`)
  must(ok.s2?.cid === 22 && ok.s2.p === 2, `p="2"（CLI 的真实形态）应给 P2（cid 22）且归一成数字 2：${JSON.stringify(ok.s2)}`)
  // ② 真 lib：非法值全部抛错，错误信息要能看出「你给的是什么、为什么不行」
  for (const k of ['nNaN', 'sNaN', 'sabc', 's27', 'zero', 'neg', 'over']) {
    must(ok[k]?.err, `case ${k} 没抛错（返回了 ${JSON.stringify(ok[k])}）—— 分P 静默回落又回来了`)
    must(ok[k].err.includes('分P'), `case ${k} 的报错不像分P 守卫的话：${ok[k].err}`)
  }
  must(ok.s27.err.includes('2.7'), `报错里没带用户给的原始值 "2.7"：${ok.s27.err}`)
  must(ok.sabc.err.includes('abc'), `报错里没带用户给的原始值 "abc"：${ok.sabc.err}`)
  must(ok.over.err.includes('超出范围'), `p=4 超界应报「超出范围」：${ok.over.err}`)

  // ③ 反向自检：把守卫判定式改坏（整条换成 false），非法值必须重新静默回落到 P1 ——
  //   证明上面那排「必须抛错」是真有牙的，不是永远绿。改坏只发生在**内存字符串** +
  //   tmpdir 临时副本（顺带把 ./consts.mjs 的相对导入改写成绝对 URL，副本才能独立加载），
  //   不碰真文件。
  const src = readFileSync(join(ROOT, 'lib', 'bili-api.mjs'), 'utf8')
  const GUARD = '!Number.isInteger(pn) || pn < 1'
  must(src.includes(GUARD), `源码里找不到分P 守卫的判定式（${GUARD}）—— 守卫可能被改写了，这条自检得跟着改`)
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c116-'))
  try {
    const brokenSrc = src
      .replace('./consts.mjs', pathToFileURL(join(ROOT, 'lib', 'consts.mjs')).href)
      .replace(GUARD, 'false')
    const brokenPath = join(tmp, 'bili-api-broken.mjs')
    writeFileSync(brokenPath, brokenSrc)
    const bo = runCases(brokenPath, '改坏版')
    for (const k of ['nNaN', 'sNaN', 'sabc', 's27', 'zero', 'neg']) {
      must(bo[k]?.cid === 11 && !bo[k].err,
        `改坏后 case ${k} 竟然还抛错了（${bo[k]?.err}）—— 扰动没生效，这条自检证明不了什么`)
    }
    must(bo.over?.err, '改坏后 p=4（纯超界）仍应抛「超出范围」（那段判定没被动过）')
    return `10 case：合法 3 个归一正确；非法 7 个全抛错；改坏后 6 个静默回落 P1、超界仍抛`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/// C55（2026-10-31，issue #6 坑 1）：脚本的 deps 目录必须与运行时同一套三级解析。
//   原来写死 DEPS="$ROOT/deps"，而插件启动过一次后运行时读的是包外 —— 脚本把 yt-dlp
//   下到包内，面板永远「不可用」。
//
//   2026-11-02（fetch-deps 合一）：这条原来真跑 fetch-deps.sh（没有 bash 就 skip，本机 Windows
//   上就一直是 skip）。合成 node 一份后被测对象就是 node，**skip 出口删掉**；「两个文件各验一遍」
//   的那半段（ps1）随文件消失。验法也换了个更直接的入口：用 `where`——它只回答「装到哪」，
//   不下载、不建目录，正好把三级解析这件事单独拎出来看，一次网络请求都不发。
check('C55 fetch-deps 的 deps 目录三级解析，与运行时同一套（issue #6 坑 1）', () => {
  const fdSrc = join(ROOT, 'scripts', 'fetch-deps.mjs')
  const libSrc = join(ROOT, 'lib', 'plugin-paths.mjs')
  // 造一个「插件包」骨架（scripts/ + lib/），因为「包内 deps 已有内容」那条分支只能靠
  //   插件根目录下的 deps 触发 —— 直接在仓库根造 deps 就是污染生产目录，判据不许这么干。
  const mkPkg = (dir) => {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'lib'), { recursive: true })
    copyFileSync(fdSrc, join(dir, 'scripts', 'fetch-deps.mjs'))
    copyFileSync(libSrc, join(dir, 'lib', 'plugin-paths.mjs'))
    return join(dir, 'scripts', 'fetch-deps.mjs')
  }
  // 默认把 BILI_WATCH_DEPS 清空：本机环境变量若指到真 deps，下面每条分支都会走同一个出口，
  //   分支之间的差异就全被盖掉了（那是「夹具没生效但恰好绿」的一种）。
  const runFd = (script, args, env) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, BILI_WATCH_DEPS: '', ...env },
    encoding: 'utf8', timeout: 60000,
  })
  const norm = (s) => String(s).trim().replace(/\\/g, '/')
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c55-'))
  try {
    // ① 包外已存在 → 用包外，且 where 的输出就是那条路径（stdout 只放路径）
    const pkg = join(tmp, 'pkg')
    const script = mkPkg(pkg)
    const home = join(tmp, 'home')
    mkdirSync(join(home, 'bili-watch', 'deps'), { recursive: true })
    const a = runFd(script, ['where'], { DSH_HOME: home })
    must(a.status === 0, `where 没正常退出（rc=${a.status}）：${(a.stderr || '').slice(0, 200)}`)
    must(/来源：包外/.test(a.stderr), `包外 deps 已存在时没选包外：${(a.stderr || '').slice(0, 200)}`)
    must(norm(a.stdout) === norm(join(home, 'bili-watch', 'deps')),
      `where 打印的路径不对（stdout 必须只有路径、不带提示行）：期望 ${join(home, 'bili-watch', 'deps')}，实际 ${JSON.stringify(a.stdout)}`)
    // ② BILI_WATCH_DEPS 优先
    const explicit = join(tmp, 'explicit')
    const b = runFd(script, ['where'], { DSH_HOME: home, BILI_WATCH_DEPS: explicit })
    must(/来源：BILI_WATCH_DEPS/.test(b.stderr), `BILI_WATCH_DEPS 没生效：${(b.stderr || '').slice(0, 200)}`)
    must(norm(b.stdout) === norm(explicit), `BILI_WATCH_DEPS 指向 ${explicit}，where 却打印 ${JSON.stringify(b.stdout)}`)
    // ③ 包外不存在、包内**已有内容** → 仍用包内（运行时 index.js:185 的例外）
    const pkg2 = join(tmp, 'pkg2')
    const script2 = mkPkg(pkg2)
    mkdirSync(join(pkg2, 'deps'), { recursive: true })
    // 必须真放一个文件：这条分支判的是「有内容」不是「存在」。
    writeFileSync(join(pkg2, 'deps', 'yt-dlp'), 'x')
    const c = runFd(script2, ['where'], { DSH_HOME: join(tmp, 'h2') })
    must(/来源：包内/.test(c.stderr), `包内已有 deps、包外没有时没选包内：${(c.stderr || '').slice(0, 200)}`)
    // ③b 包内 deps 存在但**是空的** → 必须用包外。
    //   这是复核时抓出来的真 bug：.ps1 用 Test-Path 判「存在」，index.js:185 用
    //   readdirSync().length > 0 判「有内容」。只跟 .ps1 对齐的话，包内空目录会让脚本
    //   装进包内、运行时读包外 —— 坑 1 原样复发，而且更难发现（目录是「对的那个名字」）。
    const pkg3 = join(tmp, 'pkg3')
    const script3 = mkPkg(pkg3)
    mkdirSync(join(pkg3, 'deps'), { recursive: true }) // 空目录，里面什么都没有
    const e = runFd(script3, ['where'], { DSH_HOME: join(tmp, 'h3') })
    must(/来源：包外/.test(e.stderr),
      `包内 deps 是空目录时应该用包外（index.js:185 判的是「有内容」不是「存在」）：${(e.stderr || '').slice(0, 200)}`)
    // ④ 包外和包内都没有 → 用包外（不往包里写）
    const pkg4 = join(tmp, 'pkg4')
    const script4 = mkPkg(pkg4)
    const d = runFd(script4, ['where'], { DSH_HOME: join(tmp, 'h4') })
    must(/来源：包外/.test(d.stderr), `干净安装时没选包外：${(d.stderr || '').slice(0, 200)}`)
    must(!existsSync(join(pkg4, 'deps')), '干净安装时不该往插件包目录里建 deps')
    // ⑤ where 不许建目录。
    //   不建目录是硬要求：顺手建一个空的包外目录，会让「包内 deps 已有内容」的机器
    //   下次改用那个空目录（第 41 行判的是「存在」），等于把已有 venv 和模型丢掉。
    must(!existsSync(join(tmp, 'h4', 'bili-watch', 'deps')),
      'where 不该创建 deps 目录（会让「包内已有内容」的机器改用空目录）')
    // ⑥ 真跑（非 DRY）确实在**选中的那个目录**上建。
    //   原来 ②③④ 各验一次「目录被创建」—— 那三处验的是同一个 mkdirSync，合并成一次不损抓错力。
    //   用 --python 指一个不存在的解释器：mkdir 在第 141 行（早于一切），随后立刻失败退出，
    //   零网络、零下载。
    const pkg5 = join(tmp, 'pkg5')
    const script5 = mkPkg(pkg5)
    const deps5 = join(tmp, 'deps5')
    const f = runFd(script5, ['asr', '--python', join(tmp, 'no-such-python')],
      { BILI_WATCH_DEPS: deps5, DSH_HOME: join(tmp, 'h5') })
    must(f.status === 1, `--python 指不存在的解释器时 asr 应 rc=1（别默默成功）：rc=${f.status} ${(f.stderr || '').slice(0, 300)}`)
    must(/指定的 Python 不存在/.test(f.stderr || ''), `没说清为什么失败：${(f.stderr || '').slice(0, 300)}`)
    must(existsSync(deps5), '真跑时没在选中的 deps 目录上建目录（BILI_WATCH_DEPS 指哪儿就该建哪儿）')
    return 'where 六条分支（包外已存在 / BILI_WATCH_DEPS / 包内例外 / 包内空目录 / 干净安装 / where 不建目录）都按运行时口径；真跑一次证明 mkdir 落在选中目录上'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// C56（2026-10-31，issue #6 坑 2）：ffmpeg 要真下载，且解压前必须 tar -t 预校验。
//   镜像给 HTML 错误页时 curl 可能照样 exit 0，直接解压会得到一堆垃圾或半截目录。
//   这里用假 curl 喂一段 HTML，断言：拦住 + 把拿到的内容打出来 + 不落坏文件。
// C56（2026-10-31，issue #6 坑 2；2026-11-02 合一后改走探针）：ffmpeg 要真下载，
//   且解压前必须 tar -t 预校验。镜像给 HTML 错误页时 curl 可能照样 exit 0，
//   直接解压会得到一堆垃圾或半截目录。
//   断言：拦住 + 把拿到的内容打出来 + 不落坏文件。
check('C56 ffmpeg 下载有 tar -t 预校验，HTML 错误页会被拦住（issue #6 坑 2）', () => {
  // ① 前提真跑一次：真 tar 确实会拒绝一段 HTML。
  //   这是整条预校验成立的基础，不能靠「源码里有 tar -t」推断 —— 工具换了、参数写错了，
  //   结构断言照样绿。拒不了就红，别 skip（这台机器上 tar 不存在本身就该修）。
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c56-'))
  try {
    const html = join(tmp, 'x.tar.xz')
    writeFileSync(html, '<!DOCTYPE html><html><body>404 Not Found</body></html>')
    const tar = process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
    must(existsSync(tar) || process.platform !== 'win32', `本机没有 ${tar} —— fetch-deps 的 tarBin() 也会抛，先修环境`)
    const t = spawnSync(tar, ['-tJf', html], { encoding: 'utf8', timeout: 30000 })
    must(t.status !== 0,
      `真 tar 竟然把 HTML 当归档接受了（rc=${t.status}）—— 预校验的前提不成立，先查这个 tar 是什么`)
  } finally { rmSync(tmp, { recursive: true, force: true }) }

  // ② 原样分支：探针桩掉 download（写 HTML）与 tar（拒绝），真跑 ensureFfmpegLinux
  const p = fdProbe('ffmpeg-html')
  try {
    const out = p.out()
    must(/^PROBE_RESULT=throw:/m.test(out), `HTML 错误页没被拦住（应当抛错退出）：${out.slice(0, 400)}`)
    must(/不是有效的 \.tar\.xz/.test(out), `没说清「下载到的不是有效归档」：${out.slice(0, 400)}`)
    must(/DOCTYPE html/.test(out), `没把拿到的内容打出来（只说「下载失败」没法排障）：${out.slice(0, 400)}`)
    must(!existsSync(join(p.dir, 'ffmpeg')), 'HTML 被当成压缩包解出了 ffmpeg —— 预校验失效')
    return '真 tar 拒绝 HTML（前提校准过）；原样分支抛错 + 点名「不是有效的 .tar.xz」+ 打出前 200 字节 + 没落 exe'
  } finally { rmSync(p.dir, { recursive: true, force: true }) }
})

// C57（2026-10-31，issue #6 坑 3）：venv 不依赖 ensurepip。
//   Ubuntu 26.04 的 python3.14 没带 ensurepip，`python3 -m venv` 直接失败；脚本要能
//   降级到 --without-pip + get-pip.py，且引导失败时**不留半成品 venv**、直接说清该装什么。
//   这里真跑 bootstrap_pip：给一个总是失败的 python，curl 也失败，断言报错内容。
// C57（2026-10-31，issue #6 坑 3）：venv 不依赖 ensurepip。
//   Ubuntu 26.04 的 python3.14 没带 ensurepip，`python3 -m venv` 直接失败；要能
//   降级到 get-pip.py，且引导失败时**不留半成品 venv**、直接说清该装什么。
//
//   2026-11-02（合一）：原来靠 bash `eval "$(sed -n '/^bootstrap_pip()/,/^}/p' ...)"` 抠函数体跑。
//   现在改走探针（原样定义段 + 桩掉网络），两段都比原来更真：
//     ① bootstrapPip 在「没 pip、没 ensurepip、get-pip.py 也取不到」时返回 false 并指路；
//     ② moveSemiVenv 必须**真把目录改名**——不是只在屏幕上说一句「已删除半成品」。
check('C57 venv 引导不依赖 ensurepip，取不到 get-pip 时说清该装什么（issue #6 坑 3）', () => {
  const fd = read('scripts/fetch-deps.mjs')
  // 结构上先钉住降级路径还在（真跑能覆盖文案，覆盖不了「这条路有没有被整段删掉」）
  must(/ensurepip/.test(fd), 'bootstrapPip 里没了 ensurepip 那一步')
  must(/get-pip\.py/.test(fd), '没有 get-pip.py 引导')

  // ① 取不到 get-pip.py：文案必须指到「手工装什么」，至少四个平台各一句
  const p1 = fdProbe('bootstrap-pip')
  try {
    const out = p1.out()
    must(p1.kv('RESULT') === 'false',
      `bootstrapPip 应当返回 false（装不上就别说装上了），实际 ${JSON.stringify(p1.kv('RESULT'))}：${out.slice(0, 300)}`)
    must(/取不到 get-pip\.py/.test(out), `没报「取不到 get-pip.py」：${out.slice(0, 300)}`)
    must(/apt install python3-pip/.test(out), `没告诉用户 Debian/Ubuntu 该装什么：${out.slice(0, 300)}`)
    must(/dnf install python3-pip/.test(out), `没告诉用户 Fedora/RHEL 该装什么：${out.slice(0, 300)}`)
  } finally { rmSync(p1.dir, { recursive: true, force: true }) }

  // ② 半成品 venv 必须真的被改名留档，且内容不丢。
  //   2026-11-01（P1-2）那次的形态是：断言拿 bootstrap_pip 的输出去验
  //   「已删除半成品」，右半边还 `|| /已删除半成品/.test(sh)` —— 源码里当然有这句话，
  //   于是那条断言从来没红过。这里改成验**文件系统状态**，不看文案也红得起来。
  const p2 = fdProbe('move-venv')
  try {
    must(p2.kv('VIVID') === 'false', `半成品 venv 目录还在（应当改名留档）：${p2.out().slice(0, 300)}`)
    must(/\.venv-asr\.old-/.test(p2.kv('OLDS')), `没生成 .venv-asr.old-* 留档目录：${JSON.stringify(p2.kv('OLDS'))}`)
    must(Number(p2.kv('OLDSIZE')) > 0, `留档目录是空的（内容丢了，改名等于删除）：size=${p2.kv('OLDSIZE')}`)
    must(/半成品 venv 已改名为/.test(p2.out()), `没告诉用户改名了（用户不知道旧目录去哪了）：${p2.out().slice(0, 300)}`)
  } finally { rmSync(p2.dir, { recursive: true, force: true }) }
  return 'bootstrapPip 取不到 get-pip 时返回 false 并给四个平台的手工命令；moveSemiVenv 真把半成品改名（内容留存）'
})

// C58（2026-10-31，issue #5）：GPU 运行库那一行在 Linux 上恒红。
//   两处根因：index.js 的 probeGpu 只在 win32 分支赋值 dllReady；_bili-asr.py 的
//   --probe-gpu 写死 ctypes.WinDLL（Linux 没有这个属性）。
//   判据：面板那一行必须两平台走同一个子进程接口；脚本的 Linux 分支要「预载 + CDLL + 看卡数」。
check('C58 GPU 探测跨平台：面板两平台走同一接口，Linux 分支预载后 CDLL（issue #5）', () => {
  const idx = read('index.js')
  const body = fnBody(idx, 'probeGpu')
  must(/--probe-gpu/.test(body), 'probeGpu 没调 --probe-gpu')
  must(!/非 Windows：GPU 运行库走系统 CUDA/.test(body), 'probeGpu 里还留着「非 Windows 不做探测」那段——Linux 会恒红')
  const n = (stripComments(body).match(/--probe-gpu/g) || []).length
  must(n === 1, `probeGpu 里 --probe-gpu 出现 ${n} 次（应为 1 次，两平台共用同一条）`)

  const py = read('deps/_bili-asr.py')
  const probe = pyFn(py, '_probe_gpu')
  must(/WinDLL/.test(probe), 'Windows 分支的 WinDLL 不见了')
  // 必须是 CDLL，不能只是「出现了 libcublas.so.12」——反向测试发现：把 CDLL 换成 WinDLL
  //   错误消息里照样含这个文件名，只查文件名的话断言照样绿（纸老虎）。
  must(/ctypes\.CDLL\("libcublas\.so\.12"\)/.test(probe), 'Linux 分支不是 ctypes.CDLL("libcublas.so.12")（WinDLL 在 Linux 上不存在）')
  must(/get_cuda_device_count/.test(probe), 'Linux 分支没看 ctranslate2 的卡数——库能载入但驱动不对时会误判绿')
  const addDirs = pyFn(py, '_add_nvidia_dll_dirs')
  must(/RTLD_GLOBAL/.test(addDirs), '_add_nvidia_dll_dirs 的 Linux 分支没做 RTLD_GLOBAL 预载')
  must(!/if os\.name != "nt":\n\s*return/.test(addDirs), '_add_nvidia_dll_dirs 第一句还是「非 nt 直接 return」')
  // 预载循环必须包 try：混着版本不匹配的 .so 是常态，裸 CDLL 一抛就带 traceback 退出
  must(/try:\s*\n\s*ctypes\.CDLL\(so, mode=ctypes\.RTLD_GLOBAL\)\s*\n\s*except OSError:\s*\n\s*pass/.test(addDirs),
    '预载循环没包 try/except OSError——坏 .so 会让整个探针 traceback 退出、误报红')

  // 真跑 Linux 分支：本机是 Windows，ctypes.CDLL("libcublas.so.12") 必失败，
  //   正好等价于「Linux 上库没装」。要验的是「不抛 AttributeError（WinDLL）、返回 1」。
  const pyBin = findPy()
  if (!pyBin) {
    // 2026-11-01（P1-8）：原来是裸 `return '静态判据全过（本机没有 python，…）'`，
    //   执行器把它记成一笔 PASS —— 「本机没跑」就这样变成了「验过了」，通过数虚高。
    //   正解照 C55：先 skip() 记一笔（不算通过也不算失败），再 return。
    skip('C58 GPU 探测跨平台', '本机没有 python，Linux 分支没真跑（结构判据已过；把 python3 装进 PATH 后这条会真跑）')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c58-'))
  try {
    const asr = join(ROOT, 'deps', '_bili-asr.py').replace(/\\/g, '/')
    const code = [
      'import importlib.util, sys',
      `spec = importlib.util.spec_from_file_location("m", r"${asr}")`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'print("RC=" + str(m._probe_gpu("posix")))',
      '',
    ].join('\n')
    const f = join(tmp, 'p.py')
    writeFileSync(f, code)
    const r = spawnSync(pyBin, [f], { encoding: 'utf8', timeout: 60000 })
    const out = (r.stdout || '') + (r.stderr || '')
    must(/RC=1/.test(r.stdout || ''), `posix 分支在库缺失时应返回 1：${out.slice(0, 300)}`)
    must(/libcublas\.so\.12/.test(out), `posix 分支报的不是 libcublas.so.12：${out.slice(0, 300)}`)
    must(!/WinDLL/.test(out) && !/AttributeError/.test(out), `posix 分支还在用 WinDLL（issue #5 的原 bug）：${out.slice(0, 300)}`)
    return '两平台同一接口；Linux 分支真跑返回 1 且报 libcublas.so.12，没有 WinDLL'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// C59（2026-10-31，issue #5 同族，复核抓出）：面板「GPU 运行库」那行的「一键下载」是死按钮。
//   client.js 的 canDownload = !d.ok（凭证行除外），所以 cuda 行在没装时会渲染按钮，
//   点下去把行 id 当 target 传给后端，而 runDownload 的 allowed 里没有 cuda ——
//   两个平台都回「不支持的依赖：cuda」。README 还写着「点那一行的下载」，等于给死路。
//   判据：后端放行 cuda，且**两个脚本都真有 cuda 分支**（只有一边有 = 另一半平台还是死按钮）。
check('C59 面板「GPU 运行库」的下载按钮不是死按钮：后端放行 cuda，脚本真有 cuda 分支且装完真探测（issue #5）', () => {
  const idx = read('index.js')
  const body = fnBody(idx, 'runDownload')
  const m = body.match(/const allowed = \[([^\]]*)\]/)
  must(m, 'runDownload 里找不到 allowed 白名单')
  const allowed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  must(allowed.includes('cuda'), `allowed 不含 cuda（面板的 GPU 行会点出「不支持的依赖」）：${allowed.join('/')}`)

  // 2026-11-02（fetch-deps 合一）：原来这三段分别读 .sh 与 .ps1（sh 判「cuda 分支真接到函数」
  //   + 装完探测，ps1 只判 Target 枚举里有 cuda）。两份合成一份后，判据从「两个文件各验一遍」
  //   变成「同一份里三个点都在」—— 强度没降：枚举收 cuda、all 不带、装完真探测，一个不少。
  const fd = read('scripts/fetch-deps.mjs')
  const tm = fd.match(/const TARGETS = \[([^\]]*)\]/)
  must(tm, 'fetch-deps.mjs 里找不到 TARGETS 枚举 —— 结构变了？先看这条正则')
  const targets = tm[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  must(targets.includes('cuda'), `TARGETS 不含 cuda（面板的 GPU 行会点出「不支持的依赖」）：${targets.join('/')}`)

  // all 不许带 cuda（第十条：1.4 GB，不问不装）
  const sm = fd.match(/const STEPS = TARGET === 'all' \? \[([^\]]*)\]/)
  must(sm, "fetch-deps.mjs 里找不到 `const STEPS = TARGET === 'all' ? [...]` —— 结构变了？先看这条正则")
  const allSteps = sm[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  must(!allSteps.includes('cuda'), `all 把 cuda 带上了（约 1.4 GB，第十条要求不问不装）：${allSteps.join('/')}`)

  const fn = fnBody(fd, 'installCudaLibs')
  must(/nvidia-cublas-cu12/.test(fn), 'installCudaLibs 没装 nvidia-cublas-cu12')
  must(/--probe-gpu/.test(fn), 'installCudaLibs 装完没跑 --probe-gpu 校验（pip 装成功 ≠ 能加载）')

  // 真跑：没有 .venv-asr 时必须立刻失败并指路，不许去碰网络
  //   2026-11-02：这段原来要 bash（找不到就整条 skip）。现在被测对象自己就是 node，
  //   **不再有 skip 出口** —— 这是合一的附带收益：真跑不再挑平台。
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c59-'))
  try {
    const deps = join(tmp, 'deps')
    mkdirSync(deps, { recursive: true })
    const home = join(tmp, 'home')
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fetch-deps.mjs'), 'cuda'], {
      env: { ...process.env, DSH_HOME: home, BILI_WATCH_DEPS: deps },
      encoding: 'utf8', timeout: 60000,
    })
    const combined = `${r.stdout || ''}${r.stderr || ''}`
    must(r.status === 1, `没有 ASR 环境时 cuda 分支应 exit 1（别默默成功）：rc=${r.status} ${combined.slice(0, 300)}`)
    must(/先跑 node scripts\/fetch-deps\.mjs asr/.test(combined),
      `没告诉用户先装 ASR 环境：${combined.slice(0, 300)}`)
    must(!/pip install/.test(combined), '没有 ASR 环境却已经开始 pip install 了')
    return '后端 allowed 含 cuda；TARGETS 收 cuda、all 不带；installCudaLibs 真装真探测；真跑无 venv → rc=1 并指路（零网络）'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// C60（2026-10-31，深入审查抓出）：`set -o pipefail` + `| head` = 静默中止。
//   实测：`set -euo pipefail; v="$(yes | head -1)"` 整个脚本 rc=141 退出，
//   后面一句都不执行。fetch-deps.sh 里有两处 `| head`：
//     · 打印「归档前 10 项」的诊断路径 —— 恰好在「正要解释失败原因」时死掉，
//       用户只看到一个 141，连提示都看不到（比不给提示更糟）；
//     · `find … | head -1` 找解压出来的 ffmpeg。
//   判据：喂一个「能通过 xz 魔数、但列表有几千项且没有 ffmpeg/ffprobe」的归档，
//   必须打印诊断并 exit 1，不许 141、不许无声退出。
// C60（2026-10-31，深入审查抓出）：`set -o pipefail` + `| head` = 静默中止。
//   实测（旧 .sh）：`set -euo pipefail; v="$(yes | head -1)"` 整个脚本 rc=141 退出，
//   后面一句都不执行。fetch-deps.sh 里有两处 `| head`，其中一处恰好落在
//   「正要解释失败原因」的诊断路径上 —— 用户只看到一个 141，连提示都看不到
//   （比不给提示更糟）。
//
//   2026-11-02（合一）**机制变了，判据跟着换，不硬造等价断言**：
//     node 里没有 SIGPIPE 这一类坑 —— `run()` 是参数数组 spawn（不拼 shell 管道），
//     清单是 `list.out.split(...).slice(0, 10)` 内存切片。所以「141 静默退出」
//     在这个实现里**不可能发生**，写一条 `rc !== 141` 去守它等于永远绿。
//   改守它真正想保的东西：**诊断必须打得出来，而且只打 10 行**（6000 项清单下）。
check('C60 诊断路径：6000 项清单下仍抛错收尾、只列前 10 项、不倒满屏（`| head` 静默中止已随实现消失）', () => {
  const p = fdProbe('ffmpeg-list6000')
  try {
    const out = p.out()
    must(/^PROBE_RESULT=throw:/m.test(out), `归档里没有 ffmpeg/ffprobe 时应当抛错：${out.slice(0, 400)}`)
    must(/归档里没有/.test(out), `没打印「归档里没有 ffmpeg ffprobe」：${out.slice(0, 400)}`)
    must(/ffmpeg ffprobe/.test(out), `没说清缺的是哪两个文件：${out.slice(0, 400)}`)
    // 只列前 10 项 —— 6000 行全倒出来会把屏幕刷没，和「看不到提示」是同一类后果
    const filler = (out.match(/filler-\d+/g) || []).length
    must(filler === 10, `诊断只该列前 10 项，实际列了 ${filler} 项`)
    // 而且这 10 项要真的打全（旧坑的后果正是「一行都没打出来」）
    must(/filler-0\b/.test(out), '第 1 项没打出来（诊断被截断了？）')
    must(/filler-9\b/.test(out), '第 10 项没打出来（诊断被截断了？）')
    return '6000 项清单下：抛错收尾 + 点名缺 ffmpeg/ffprobe + 只列前 10 项且第 1、10 项都在'
  } finally { rmSync(p.dir, { recursive: true, force: true }) }
})

// C61（2026-10-31，深入审查抓出）：ffmpeg 装完必须真跑一次 `-version` 才敢说「✓」。
//   E1-01 同族：原来 `cp` 成功就打印 `✓ $DEPS/ffmpeg`，`-version` 只是「顺手打一行、失败也无所谓」。
//   但运行时（look.mjs 的 resolveFfmpeg）会真试跑 `-version`，跑不起来就判「没装 ffmpeg」——
//   于是脚本说装好了、面板说没装，两边对不上。文件在 ≠ 能用。
//   这里用假 tar 造两种解压结果：能跑的 ffmpeg（必须 ✓ 且带版本号）、跑不起来的（必须报错 exit 1）。
// C61（2026-10-31，深入审查抓出）：ffmpeg 装完必须真跑一次 `-version` 才敢说「✓」。
//   E1-01 同族：原来 `cp` 成功就打印 `✓ $DEPS/ffmpeg`，`-version` 只是「顺手打一行、失败也无所谓」。
//   但运行时（look.mjs 的 resolveFfmpeg）会真试跑 `-version`，跑不起来就判「没装 ffmpeg」——
//   于是脚本说装好了、面板说没装，两边对不上。文件在 ≠ 能用。
//
//   2026-11-02（合一）：原来靠假 tar 造两种解压结果。现在探针桩掉 tar（外部工具），
//   被测的「-version 失败该怎么报」是原样代码。两条分支：
//     能跑 → ✓ 且带版本首行；跑不起来 → 抛错，且**区分「文件在但执行不了」与「没装上」**。
check('C61 ffmpeg 装完要真跑一次 -version：文件在 ≠ 能用（E1-01 同族，深入审查）', () => {
  // ① 能跑：必须打 ✓ 且把版本首行带出来（用户能一眼确认装的是哪个版本）
  const ok = fdProbe('ffmpeg-version')
  try {
    const out = ok.out()
    must(/^PROBE_RESULT=ok$/m.test(out), `能跑的 ffmpeg 应当正常收尾：${out.slice(0, 400)}`)
    must(/✓ /.test(out), `装好了却没打 ✓：${out.slice(0, 400)}`)
    must(/（ffmpeg version 7\.1-static-test）/.test(out), `✓ 那行没带版本首行（用户看不出装的是哪版）：${out.slice(0, 400)}`)
  } finally { rmSync(ok.dir, { recursive: true, force: true }) }

  // ② 跑不起来：必须抛错，而且不能报成「没装上」——那会把用户引向「重装一次」，
  //   重装完还是一样跑不起来。
  const bad = fdProbe('ffmpeg-version', { BW_PROBE_VER_CODE: '1' })
  try {
    const out = bad.out()
    must(/^PROBE_RESULT=throw:/m.test(out), `-version 跑不起来时必须抛错（不许打 ✓）：${out.slice(0, 400)}`)
    must(/文件已放到/.test(out), `没说清「文件其实已经放到了」：${out.slice(0, 400)}`)
    must(/不是「没装上」/.test(out), `没区分「跑不起来」和「没装上」（用户会去重装，装了也一样）：${out.slice(0, 400)}`)
    must(/noexec|SELinux|架构/.test(out), `没给排查方向（noexec / SELinux / 架构不对）：${out.slice(0, 400)}`)
  } finally { rmSync(bad.dir, { recursive: true, force: true }) }
  return '能跑 → ✓ 带版本首行；跑不起来 → 抛错 + 区分「文件在但执行不了」并给 noexec/SELinux/架构 三个方向'
})

// C62（2026-10-31，深入审查）：没有 NVIDIA 卡的机器不该出现「一键下载」。
//   原来条件写死在 DepRow 里（`!d.ok && d.id !== 'credential'`），GPU 那行在无卡机器上
//   也有按钮 —— 点下去装 2.2 GB（Linux）运行库，装完照样走 CPU。
//   这里真跑 client.js 的 canDownloadRow，四种行逐个验；同时验后端确实给了 installable。
check('C62 无卡机器不显示 GPU 行的「一键下载」（深入审查，真跑 canDownloadRow）', () => {
  const { canDownloadRow } = compile(read('client.js'), ['canDownloadRow'])
  const rows = [
    [{ id: 'cuda', ok: false, installable: false }, false, '无卡的 GPU 行不该能下载'],
    [{ id: 'cuda', ok: false, installable: true }, true, '有卡的 GPU 行应该能下载'],
    [{ id: 'cuda', ok: false }, true, '没带 installable 的行要向后兼容（照旧能下载）'],
    [{ id: 'cuda', ok: true, installable: true }, false, '已就绪的行不该有下载按钮'],
    [{ id: 'credential', ok: false }, false, '凭证行走扫码，不是下载'],
    [{ id: 'ffmpeg', ok: false }, true, '普通缺项照旧能下载'],
    [null, false, 'null 行不能抛异常'],
  ]
  for (const [d, want, why] of rows) {
    const got = canDownloadRow(d)
    must(got === want, `${why}（期望 ${want}，实际 ${got}）：${JSON.stringify(d)}`)
  }
  // 顶部「缺 N 个依赖」的口径必须与按钮一致，否则「去安装」永远清不掉计数
  const { missingDeps } = compile(read('client.js'), ['missingDeps'])
  const all = [
    { id: 'ffmpeg', ok: false },
    { id: 'cuda', ok: false, installable: false },
    { id: 'model', ok: true },
  ]
  const m = missingDeps(all)
  must(m.length === 1 && m[0].id === 'ffmpeg',
    `「缺几个依赖」的计数把不可安装的行也算进去了：${JSON.stringify(m.map((d) => d.id))}`)
  must(missingDeps(null).length === 0, 'missingDeps(null) 应返回空数组')

  // 后端必须给 GPU 行带 installable，否则上面的 false 分支永远走不到
  const idx = read('index.js')
  const a = idx.indexOf("id: 'cuda'")
  const b = idx.indexOf("id: 'credential'")
  must(a > 0 && b > a, 'index.js 里找不到 GPU 行（id: cuda … id: credential）')
  const cudaRow = idx.slice(a, b)
  must(/installable:\s*!gpu\.noCard/.test(cudaRow),
    'index.js 的 GPU 行没按 noCard 给 installable —— 无卡机器仍会显示下载按钮')
  // 不能用 deviceCount === 0 当判据：nvidia-smi 超时/异常时它也是 0，
  //   那时藏按钮会让「有卡但探测抖动」的用户无从下手。
  must(!/installable:\s*gpu\.deviceCount/.test(cudaRow),
    'installable 用了 deviceCount——探测超时时会把有卡的机器也判成「没卡」')
  const probe = fnBody(idx, 'probeGpu')
  must(/noCard\s*=\s*true/.test(probe) && /ENOENT/.test(probe), 'probeGpu 没在 ENOENT 分支置 noCard')
  must(/val:\s*\{[^}]*noCard/.test(probe), 'probeGpu 的返回值里没有 noCard')
  return 'canDownloadRow 真跑 7 种行 + missingDeps 真跑（不可安装的行不计入「缺 N 个」）；GPU 行的 installable 由 noCard（仅 ENOENT）决定'
})

// 2026-10-31：appendRunLine 的轮转与追加搬进 lib/runs.mjs，两个入口各一行调用。
//   搬之前这段逻辑没有任何断言（grep appendRunLine 在 verify.mjs 里是 0 条）——
//   也就是说「日志无限涨」「写日志把调用搞挂」两条都不设防。搬进 lib 正好补上。
check('C63 appendJsonLine 真跑：自动建目录、满 2000 行 / 5 MB 轮转成 .1、写失败不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-c63-'))
  try {
    // ① 嵌套目录自动创建 + 单行 JSON
    const f = join(dir, 'deep', '_logs', 'runs.jsonl')
    appendJsonLine(f, { command: 'view', code: 0 })
    must(existsSync(f), '嵌套目录没有自动创建（日志会静默丢失）')
    must(readFileSync(f, 'utf8') === '{"command":"view","code":0}\n', '追加的不是单行 JSON + 换行')

    // ② 行数轮转：2001 行 → 下一次 append 先把旧文件挪成 .1
    writeFileSync(f, Array.from({ length: 2001 }, (_, i) => `{"i":${i}}`).join('\n') + '\n')
    appendJsonLine(f, { command: 'after' })
    must(existsSync(f + '.1'), '超过 2000 行没有轮转（诊断日志会无限涨）')
    const rest = readFileSync(f, 'utf8').trim().split('\n')
    must(rest.length === 1 && rest[0] === '{"command":"after"}', `轮转后原文件应只剩新写的一行，实际 ${rest.length} 行`)
    must(readFileSync(f + '.1', 'utf8').split('\n').length - 1 === 2001, '轮转把旧内容弄丢了')

    // ③ 体积轮转：单行 6 MB（行数没超，只能靠体积判据）
    const g = join(dir, 'big.jsonl')
    writeFileSync(g, 'x'.repeat(6 * 1024 * 1024) + '\n')
    appendJsonLine(g, { command: 'big' })
    must(existsSync(g + '.1'), '超过 5 MB 没有轮转')

    // ④ 写失败不抛：父路径是个文件，mkdirSync 必失败
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    let threw = false
    try { appendJsonLine(join(blocker, 'x.jsonl'), { a: 1 }) } catch { threw = true }
    must(!threw, '写日志失败上抛了（会让一次看视频的调用整体失败）')

    return '建目录 + 2001 行轮转 + 6 MB 轮转 + 写失败不抛，四态真跑'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 缓存根的**状态与时序**（2026-10-31）────────────────────────────
// 2026-10-31 16:58 定的三条硬要求，这里逐条落成断言：
//   ① 真起两个进程，比对 stdout/stderr 里的**实际路径**——不比源码；
//   ② 删掉初始化调用必须红，而且要红在「路径不对」；
//   ③ 未初始化就调 cacheDir() 必须抛。
// 为什么这一片不能沿用前三次的 compile 套路：那三次搬的是纯函数（输入 → 输出），
//   抽出来跑等价于真跑；这一片搬的是可变模块状态 + 「谁先调」，compile 抽不出状态，抽出来的
//   函数体看着对、跑起来照样错——正是「唯一一步 compile 会骗人」。
const CACHE_PROBE = [
  "const mod = await import(process.argv[2])",
  'let route = null',
  'const ctx = {',
  '  logger: { warn() {}, info() {}, error() {} },',
  '  commands: { register() {} },',
  '  on() {},',
  '  get() { return { register() {} } },',
  '  effect(fn) { return fn() },',
  "  webServer: { register(rt) { route = rt; return () => {} } },",
  '}',
  'mod.apply(ctx)',
  "if (!route) { console.log('NO_ROUTE'); process.exit(3) }",
  "const req = { method: 'GET', url: '/api/bili-watch/status', headers: { host: '127.0.0.1:1' }, socket: { remoteAddress: '127.0.0.1' } }",
  'let payload = null',
  "const res = { writeHead() { return this }, setHeader() { return this }, end(b) { try { payload = JSON.parse(String(b)) } catch {} }, write() { return this } }",
  'await route.handler(req, res)',
  "console.log('CACHE_DIR=' + (payload?.data?.cache?.dir ?? 'MISSING'))",
  'process.exit(0)',
].join('\n')

check('C64 两个入口各起真进程，算出同一个缓存根（状态与时序 compile 验不出来）', () => {
  const idxUrl = pathToFileURL(join(ROOT, 'index.js')).href
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c64-'))
  const probe = join(tmp, 'probe.mjs')
  writeFileSync(probe, CACHE_PROBE)
  // 同一份输入造两个沙箱（CLI 一个、面板一个），各自跑，最后比「相对沙箱根的尾巴」。
  //   比尾巴而不是比全路径：两个沙箱根不同，同一套算法必然给出同样的相对结构——
  //   这正好把「路径是不是同一个」和「绝对路径前缀不同」两件事分开。
  const mkSandbox = (tag, custom) => {
    const root = mkdtempSync(join(tmp, tag + '-'))
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    let user = null
    if (custom) {
      user = join(root, 'user')
      mkdirSync(user)
      writeFileSync(join(user, 'note.txt'), 'mine') // 有内容、没标记 = 用户自己的目录
    }
    return { root, home, user }
  }
  // 本断言验的是「默认根」，所以 env 必须先摘掉 BILI_WATCH_CACHE（baseEnv）；
  //   自定义场景再按需补回来——否则跑的人 shell 里带着这个变量就一定假红（2026-10-31 踩到）。
  const envOf = (s) => baseEnv({ DSH_HOME: s.home, ...(s.user ? { BILI_WATCH_CACHE: s.user } : {}) })
  const runCli = (s) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'look.mjs'), 'clean'], { env: envOf(s), encoding: 'utf8' })
    const out = String(r.stdout || '')
    const m = /已清理 (.+?)（/.exec(out)
    must(m, `CLI 没打出实际清理路径（rc=${r.status}）：stdout=${out.trim().slice(0, 300)} stderr=${String(r.stderr || '').trim().slice(0, 300)}`)
    return m[1]
  }
  const runPanel = (s) => {
    const r = spawnSync(process.execPath, [probe, idxUrl], { env: envOf(s), encoding: 'utf8' })
    const out = String(r.stdout || '')
    must(/CACHE_DIR=/.test(out), `面板侧没打出路径（rc=${r.status}）：stdout=${out.trim().slice(0, 300)} stderr=${String(r.stderr || '').trim().slice(0, 400)}`)
    const p = out.split('CACHE_DIR=')[1].split('\n')[0].trim()
    must(p !== 'MISSING', '面板 /status 的 data.cache.dir 是空的——/status 已经拿不到缓存根了')
    return p
  }
  const cases = []
  try {
    for (const [label, custom] of [['默认根', false], ['指向非空用户目录', true]]) {
      const a = mkSandbox(label + '-cli', custom)
      const b = mkSandbox(label + '-panel', custom)
      const cliPath = runCli(a)
      const panelPath = runPanel(b)
      const relCli = relative(a.root, cliPath)
      const relPanel = relative(b.root, panelPath)
      // 两侧都必须把路径说成「沙箱根之下的相对尾巴」，否则下面的比较没有意义
      must(!relCli.startsWith('..') && !relPanel.startsWith('..'), `有一侧把根算到了沙箱外面：CLI=${cliPath} PANEL=${panelPath}`)
      must(relCli === relPanel, `${label}：两个入口算出两个缓存根——CLI=${relCli}，面板=${relPanel}（面板写一处、CLI 写另一处，clean 永远清不到）`)
      cases.push(`${label}=${relCli}`)
      // 非空用户目录必须退到它下面的专属子目录（绝不认领用户目录本身）
      if (custom) must(relCli === join('user', 'bili-watch-cache'), `用户目录没退到专属子目录：${relCli}`)
      else must(relCli === join('home', 'bili-watch', 'cache'), `默认根不对：${relCli}`)
      for (const s of [a, b]) rmSync(s.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return `两个真进程两套场景（${cases.join('；')}）路径逐段相同`
})

check('C65 未初始化就调 cacheDir() 必须抛，且点名 initCachePath（不许返回「看着能用」的默认值）', () => {
  const url = pathToFileURL(join(ROOT, 'lib', 'cache-path.mjs')).href
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c65-'))
  const f = join(tmp, 'probe.mjs')
  writeFileSync(f, [
    `import('${url}').then((m) => {`,
    '  try { m.cacheDir(); console.log("NO_THROW") }',
    '  catch (e) { console.log("THREW " + e.message) }',
    '})',
  ].join('\n'))
  try {
    const r = spawnSync(process.execPath, [f], { env: baseEnv({ DSH_HOME: join(tmp, 'home') }), encoding: 'utf8' })
    const out = String(r.stdout || '').trim()
    must(!/NO_THROW/.test(out), '未初始化时 cacheDir() 没抛——它会返回一个算出来但没建过根的值，后面所有落盘都写进那棵树')
    must(/^THREW /.test(out), `没拿到预期的抛错输出：${out || '(空)'} / stderr=${String(r.stderr || '').slice(0, 200)}`)
    must(/initCachePath/.test(out), `抛错信息没点名 initCachePath，现场只能看到「未定义」：${out}`)
    return '未初始化必抛，且文案指路'
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('C66 缓存根的状态与推导只剩 lib/cache-path.mjs 一份（两个入口都不许再自己存 CACHE）', () => {
  const lib = read('lib/cache-path.mjs')
  for (const rel of ['index.js', 'tools/look.mjs']) {
    const src = read(rel)
    // 只看代码行：注释里提到旧名字是应该的（讲清来龙去脉），不能算残留
    const code = src.split('\n').filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    }).join('\n')
    for (const name of ['resolveCacheDir', 'pickCacheDir', 'migrateLegacyCache', 'cacheAdoptNotice', 'videoDir']) {
      must(!new RegExp(`function ${name}\\s*\\(`).test(code), `${rel} 里还有 function ${name}——实现没搬干净，又会出现两份判据`)
    }
    must(!/^\s*let CACHE = /m.test(code), `${rel} 还自己存着 CACHE 值（应一律改走 cacheDir()）`)
    must(!/CACHE_READY/.test(code), `${rel} 还留着 CACHE_READY（初始化标志该由 lib 的 initCachePath 管）`)
  }
  for (const name of ['resolveCacheDir', 'pickCacheDir', 'migrateLegacyCache', 'cacheAdoptNotice', 'videoDir', 'initCachePath', 'cacheDir', 'previewCacheDir']) {
    must(new RegExp(`export function ${name}\\s*\\(`).test(lib), `lib/cache-path.mjs 缺 ${name}`)
  }
  // ensureCache() 在 logRun → runsFile() 里每写一条日志都会被调一次。want 若在入口处就求值
  //   （initCachePath(cacheWant())），「已经初始化好了」这条早退路径每次都白读一遍 deps-config.json——
  //   原来的 CACHE_READY 就是为了省这一下。lib 收函数（initCachePath(cacheWant)）才是原语义。
  for (const rel of ['index.js', 'tools/look.mjs']) {
    must(/initCachePath\(cacheWant\)/.test(read(rel)), `${rel} 把 want 提前求值了（initCachePath(cacheWant())）——每写一条日志都要多读一次配置`)
  }
  // 缓存根只允许从 cacheDir() 读：两个入口里任何 `CACHE` 标识符（注释除外）都算漏网
  for (const rel of ['index.js', 'tools/look.mjs']) {
    const bad = read(rel).split('\n').filter((line) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
      return /\bCACHE\b(?!_)/.test(line) && !/BILI_WATCH_CACHE/.test(line)
    })
    must(bad.length === 0, `${rel} 里还有直接读 CACHE 的代码：${bad.slice(0, 2).map((s) => s.trim()).join(' | ')}`)
  }
  return '五个函数 + 可变状态只在 lib；两个入口零残留'
})

// ── 补丁：面板侧 logRun 落盘的真跑证据（2026-10-31）────────────────────
// 收尾时留了一处「靠推断」：index.js 侧 logRun → videoDir → runsFile() 这条链只验了
//   CLI 那半边（CLI 跑一条坏命令 → runs.jsonl 有行），面板侧从没真跑过。
//   这个手法与 C64 同源：probe 里真调 apply()，拿它注册的 handler，喂一条必失败的命令。
// 这里选 `view BV0000000000`（不存在的 BV）：请求必然失败 → code≠0 → 走 logRun 的 !ok 分支，
//   于是「写 runs.jsonl」和「写 BV 目录下的 last-error.json」两件事同时被逼出来——
//   一处不写就红，不用读源码猜它写不写。
const RUNLOG_PROBE = [
  "const mod = await import(process.argv[2])",
  'let cmdDef = null',
  'let route = null',
  'const ctx = {',
  '  logger: { warn() {}, info() {}, error() {} },',
  '  commands: { register(d) { cmdDef = d } },',
  '  on() {},',
  '  get() { return { register() {} } },',
  '  effect(fn) { return fn() },',
  '  webServer: { register(rt) { route = rt; return () => {} } },',
  '}',
  'mod.apply(ctx)',
  "if (!cmdDef || !route) { console.log('NO_CMD'); process.exit(3) }",
  'let kind = null',
  "try { const r = await cmdDef.handler({ rawInput: 'view BV0000000000' }); kind = r && r.kind } catch (e) { kind = 'THREW ' + (e && e.message) }",
  "console.log('KIND=' + kind)",
  // 缓存根仍然问 /status：不在断言里复算一遍路径，否则「复算对了、写歪了」会被掩盖
  "const req = { method: 'GET', url: '/api/bili-watch/status', headers: { host: '127.0.0.1:1' }, socket: { remoteAddress: '127.0.0.1' } }",
  'let payload = null',
  "const res = { writeHead() { return this }, setHeader() { return this }, end(b) { try { payload = JSON.parse(String(b)) } catch {} }, write() { return this } }",
  'await route.handler(req, res)',
  "console.log('CACHE_DIR=' + (payload?.data?.cache?.dir ?? 'MISSING'))",
  'process.exit(0)',
].join('\n')

check('C67 面板侧 logRun 真写盘：跑一条必失败的命令，runs.jsonl 有行、BV 目录有 last-error.json（唯一「靠推断」的那处）', () => {
  const idxUrl = pathToFileURL(join(ROOT, 'index.js')).href
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c67-'))
  const home = join(tmp, 'home')
  const cache = join(tmp, 'cache')
  mkdirSync(home, { recursive: true })
  mkdirSync(cache, { recursive: true })
  const probe = join(tmp, 'probe.mjs')
  writeFileSync(probe, RUNLOG_PROBE)
  try {
    const r = spawnSync(process.execPath, [probe, idxUrl], {
      // 这条跑的是「默认缓存根」的反面：显式指定 cache，验的是「日志写到你指定的那棵树」。
      //   仍然从 baseEnv 出发——外部 BILI_WATCH_DEPS 会把 DEPS 指走，日志就落到别处了。
      env: baseEnv({ DSH_HOME: home, BILI_WATCH_CACHE: cache }),
      encoding: 'utf8',
      timeout: 180000,
    })
    const out = String(r.stdout || '')
    const err = String(r.stderr || '')
    must(!/NO_CMD/.test(out), `probe 没拿到命令注册或路由注册（rc=${r.status}）：stderr=${err.slice(0, 300)}`)
    const kind = (/KIND=(.*)/.exec(out) || [])[1]
    must(kind === 'error', `必失败的命令没被判成 error：KIND=${kind ?? '(空)'}  stderr=${err.slice(0, 300)}`)
    const cacheDir = (/CACHE_DIR=(.*)/.exec(out) || [])[1]?.trim()
    must(cacheDir && cacheDir !== 'MISSING', `面板侧拿不到缓存根：${out.slice(0, 300)}`)

    // ① runs.jsonl：子进程（look.mjs）**自己也会写一行**（它的 exit handler），所以「文件里有行」
    //   根本证明不了面板侧 logRun 跑过——第一版这里就是这么假绿的（R2 把面板侧的 last-error 写入
    //   整段注释掉，断言照样全绿）。真判据必须是「能认出哪一行是面板写的」：
    //   两边 entry 的字段差是稳定的——CLI 那份无条件带 diag/trackTail，index 的 logRun 没有这两个键。
    //   面板在子进程 close 之后才写，所以它那行一定是最后一行。
    const runs = join(cacheDir, '_logs', 'runs.jsonl')
    must(existsSync(runs), `面板侧跑完一条命令，runs.jsonl 没落地：${runs}（logRun → runsFile() 这条链断了）`)
    const lines = readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean)
    must(lines.length >= 2, `runs.jsonl 只有 ${lines.length} 行：子进程自己会写一行，面板 logRun 必须再写一行（少了就是面板侧那条链没执行）`)
    const panel = JSON.parse(lines[lines.length - 1])
    must(!('diag' in panel) && !('trackTail' in panel), `最后一行是 CLI 自己写的那份（带 diag/trackTail），不是面板 logRun 写的：${lines[lines.length - 1].slice(0, 200)}`)
    must(panel.command === 'view', `日志里记的命令不对：${panel.command}（runLogRecord 没取 args[0]）`)
    must(panel.bv === 'BV0000000000', `日志里记的 BV 不对：${panel.bv}（runLogRecord 没取 args[1]）`)
    must(panel.ok === false && panel.code !== 0, `失败命令在日志里被记成成功：ok=${panel.ok} code=${panel.code}`)

    // ② last-error.json：同一份文件被写过两次——CLI 先写（带 diag），面板 logRun 后写覆盖它（不带 diag）。
    //   所以「文件在」同样不算数，要看**现在这份是谁写的**。
    const bvDir = readdirSync(cacheDir).find((d) => d === 'BV0000000000' || d.startsWith('BV0000000000_'))
    must(bvDir, `没建出 BV 目录（videoDir 没被调用或写到了别处）：${readdirSync(cacheDir).join(',') || '(空)'}`)
    const le = join(cacheDir, bvDir, 'last-error.json')
    must(existsSync(le), `BV 目录里没有 last-error.json：${le}（logRun 的 !ok 分支没走 videoDir）`)
    const j = JSON.parse(readFileSync(le, 'utf8'))
    must(!('diag' in j) && !('trackTail' in j), 'last-error.json 还是 CLI 写的那份（带 diag/trackTail）——面板 logRun 没有覆盖它，videoDir 那条链没跑')
    must(j.ok === false && j.bv === 'BV0000000000', `last-error.json 内容不对：ok=${j.ok} bv=${j.bv}`)
    must(String(j.stderr || '').trim().length > 0, 'last-error.json 没带 stderr——事后没法定位「这条视频坏在哪」')
    return `runs.jsonl ${lines.length} 行（末行由面板 logRun 写）+ last-error.json 被面板覆盖（rc=${r.status}，BV 目录=${bvDir}）`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── 凭证的位置与迁移（2026-10-31）────────────────────────────────
// 验收「凭证路径两入口一致」不能只靠读源码：路径是算出来的，两个进程各算一次才是证据。
// 这里走 /status 的真实路径（credState → resolveCredPath → adoptLegacyCred），
// 用「旧 deps 凭证有没有被搬到 $DSH_HOME」这个副作用来判断它算到了哪——面板侧不打印路径
// （/status 里那份是遮罩过的），所以只能看落点。
check('C68 面板侧的凭证也认 lib 的路径：旧 deps 凭证被迁到 $DSH_HOME，旧文件不删', () => {
  const idxUrl = pathToFileURL(join(ROOT, 'index.js')).href
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c68-'))
  const home = join(tmp, 'home')
  const deps = join(tmp, 'deps')
  mkdirSync(home, { recursive: true })
  mkdirSync(deps, { recursive: true })
  const legacy = join(deps, 'credential.json')
  writeFileSync(legacy, JSON.stringify({ sessdata: 'S', bili_jct: 'J', buvid3: '3', buvid4: '4' }))
  const shared = join(home, 'bili-watch', 'credential.json')
  const probe = join(tmp, 'probe.mjs')
  writeFileSync(probe, CACHE_PROBE)
  const runPanel = () => spawnSync(process.execPath, [probe, idxUrl], {
    env: baseEnv({ DSH_HOME: home, BILI_WATCH_DEPS: deps }),
    encoding: 'utf8',
    timeout: 60000,
  })
  try {
    must(!existsSync(shared), '沙箱一开始就有 shared 凭证——这个场景不成立')
    const r1 = runPanel()
    must(/CACHE_DIR=/.test(String(r1.stdout || '')), `面板 probe 没跑到 /status（rc=${r1.status}）：stderr=${String(r1.stderr || '').slice(0, 300)}`)
    must(existsSync(shared), `面板跑完 /status 后，旧 deps 凭证没被迁到 ${shared}（面板侧算的不是 lib 那条路径）`)
    const j = JSON.parse(readFileSync(shared, 'utf8'))
    must(j.sessdata === 'S' && j.buvid4 === '4', '迁移把凭证字段弄丢了')
    must(existsSync(legacy), '迁移把旧文件删了（旧文件必须原地留着）')
    // 再跑一次：迁移是一次性的，不该每轮重写（否则 mtime 会一直变、也会覆盖用户后来换的凭证）
    const t1 = statSync(shared).mtimeMs
    const r2 = runPanel()
    must(/CACHE_DIR=/.test(String(r2.stdout || '')), '第二次 probe 没跑通')
    must(statSync(shared).mtimeMs === t1, '第二次跑又把 shared 重写了一遍——迁移不是幂等的')
    return `面板侧把 ${legacy} 迁到了 ${shared}，字段完整、旧文件保留、第二次不重写`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── 判据 #2：两个入口的同名函数必须归零（可执行化）────────────
// 计划里写的是「同名 23 → 0」。实测收到 1（ensureCache），它不是逻辑重复：
//   两侧各 1 行，只差「pushWarn(maskAbs(...))」与「console.error(...)」——这是 lib 不产文案的必然结果
//   （面板要进 /status.warnings，CLI 要打 ASCII 前缀的 stderr）。
// 所以判据不追求字面 0，而是把「允许剩下哪些」写成白名单，并约束它的体量：
//   以后谁再复制粘贴一个函数过去，这条立刻红——这正是这条判据要守的。
const topFunctions = (src) => {
  const out = new Map()
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm
  let m
  while ((m = re.exec(src))) {
    const start = m.index
    const i = src.indexOf('{', start)
    if (i < 0) continue
    let depth = 0
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') { depth--; if (depth === 0) { out.set(m[1], src.slice(start, j + 1)); break } }
    }
  }
  return out
}
const codeLines = (s) => s.split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))

check('C69 两个入口的同名顶层函数只剩文案薄壳：白名单之外一个都不许有（判据 #2）', () => {
  const ALLOW = ['ensureCache']
  const a = topFunctions(read('index.js'))
  const b = topFunctions(read('tools/look.mjs'))
  const common = [...a.keys()].filter((k) => b.has(k))
  const extra = common.filter((k) => !ALLOW.includes(k))
  must(extra.length === 0, `两个入口又有同名函数：${extra.join(', ')}——逻辑应搬进 lib/，各留一份就是两处判据`)
  // 白名单里的那个也要盯住体量：允许它存在，是因为「只差文案」，不是「允许它再长回 18 行」
  for (const name of ALLOW) {
    if (!a.has(name) || !b.has(name)) continue
    const la = codeLines(a.get(name)), lb = codeLines(b.get(name))
    const sb = new Set(lb)
    const onlyA = la.filter((l) => !sb.has(l))
    must(onlyA.length <= 2 && la.length <= 8, `${name} 已经不只是一行文案差（仅 index ${onlyA.length} 行、共 ${la.length} 行）——该搬进 lib 了`)
  }
  return `同名 ${common.length} 对（${common.join(',') || '无'}），白名单外 0 个`
})

// ── 前置：apply(ctx) / 路由 / sendJson 在 78 条断言里出现 0 次（2026-10-31）──
// 先在**没有任何断言覆盖**的这段代码上补三条真跑，再动刀。
//   「真跑」的口径沿用 C67：断言要能证明「这段代码是我这方执行的」，不是「有没有返回值」。
// 三条都走同一个探针：import index.js → apply(ctx) → 拿它注册的 route.handler 真调，
//   假 res 记录 writeHead 的 code/headers 与 end 的 body——sendJson 的三个分支因此全部经过真实实现。
const ROUTE_PROBE = [
  "const mod = await import(process.argv[2])",
  'const regs = []',
  'const mkCtx = () => ({',
  '  logger: { warn() {}, info() {}, error() {} },',
  '  commands: { register() {} },',
  '  on() {},',
  '  get() { return { register() {} } },',
  '  effect(fn) { return fn() },',
  '  webServer: { register(rt) { regs.push(rt); return () => {} } },',
  '})',
  // ① 首次 apply：注册一次；② 同进程再来一次（fiber 重放）：必须被 claimRoute 挡住
  'const dispose = mod.apply(mkCtx())',
  'mod.apply(mkCtx())',
  'const afterTwice = regs.length',
  // ③ 不 release 就重放 → 路由永久 404（这正是 T41-P0-1 要防的）；dispose 后必须能重新注册
  'let disposeErr = null',
  'try { dispose() } catch (e) { disposeErr = String(e && e.message) }',
  'mod.apply(mkCtx())',
  'const afterDispose = regs.length',
  'const route = regs[0]',
  "if (!route) { console.log('NO_ROUTE'); process.exit(3) }",
  // 假 res：把 sendJson 真正写下去的东西记下来（writeHead 的 code/headers + end 的 body）
  'const mkRes = () => ({ code: null, headers: null, body: null, writeHead(c, h) { this.code = c; this.headers = h; return this }, setHeader() { return this }, end(b) { this.body = String(b) }, write() { return this } })',
  // POST 端点要 readJsonBody 读 body：它监听 data/end/error，空 body 就是一次 end
  "const mkReq = (method, url, extra = {}) => ({ method, url, headers: { host: '127.0.0.1:1' }, socket: { remoteAddress: '127.0.0.1' }, on(ev, cb) { if (ev === 'end') setTimeout(cb, 0); return this }, ...extra })",
  'const call = async (req) => { const res = mkRes(); await route.handler(req, res); let j = null; try { j = JSON.parse(res.body) } catch {} return { code: res.code, headers: res.headers, body: res.body, json: j } }',
  // 分支一：正常 200（/status 是唯一读端点，字段最全）
  "const status = await call(mkReq('GET', '/api/bili-watch/status'))",
  // 分支二：ok:false 的状态码（走不到的路由 → 404）
  "const notFound = await call(mkReq('GET', '/api/bili-watch/nope'))",
  // 分支三：兜底 catch → 500。req.url 取一次就抛，异常发生在 handler 的 try 里，
  //   于是必然落到 catch 那条 sendJson(res, 500, { ok:false, why })——这是最容易漏的分支。
  "const boom = await call({ get url() { throw new Error('boom-url') }, method: 'GET', headers: { host: '127.0.0.1:1' }, socket: { remoteAddress: '127.0.0.1' } })",
  // 分支四：写端点 /cache/clear 真跑（这六条会删用户文件，不该一直靠人工审）。
  //   沙箱就是探针自己的 BILI_WATCH_CACHE：造一个本插件的 BV 目录 + 一个用户自己的文件，
  //   调完之后断言「BV 没了、用户文件在、skipped 里点了它的名」。
  'const fs = await import("node:fs")',
  'const path = await import("node:path")',
  'const root = process.env.BILI_WATCH_CACHE',
  'fs.mkdirSync(path.join(root, "BV1aaaaaaaaa"), { recursive: true })',
  'fs.writeFileSync(path.join(root, "BV1aaaaaaaaa", "meta.json"), "{}")',
  'const userFile = path.join(root, "我的视频.mp4")',
  'fs.writeFileSync(userFile, "user-data")',
  // 先验 CSRF 闸：不带 Content-Type 的 POST 必须被挡（面板走 fetch，会带 application/json）
  'const clearBlocked = await call(mkReq(\'POST\', \'/api/bili-watch/cache/clear\'))',
  'const afterBlocked = { bvStill: fs.existsSync(path.join(root, \'BV1aaaaaaaaa\')), userStill: fs.existsSync(userFile) }',
  'const clear = await call(mkReq(\'POST\', \'/api/bili-watch/cache/clear\', { headers: { host: \'127.0.0.1:1\', \'content-type\': \'application/json\' } }))',
  'const afterClear = { bvGone: !fs.existsSync(path.join(root, "BV1aaaaaaaaa")), userKept: fs.existsSync(userFile) }',
  'console.log("ROUTE_JSON=" + JSON.stringify({ afterTwice, afterDispose, disposeErr, status, notFound, boom, clear, clearBlocked, afterBlocked, afterClear }))',
  'process.exit(0)',
].join('\n')

/** 起一次探针，把 ROUTE_JSON 那行解析回来。 */
const runRouteProbe = (tag) => {
  const idxUrl = pathToFileURL(join(ROOT, 'index.js')).href
  const tmp = mkdtempSync(join(tmpdir(), `bw-${tag}-`))
  const home = join(tmp, 'home')
  const cache = join(tmp, 'cache')
  mkdirSync(home, { recursive: true })
  mkdirSync(cache, { recursive: true })
  const probe = join(tmp, 'probe.mjs')
  writeFileSync(probe, ROUTE_PROBE)
  try {
    const r = spawnSync(process.execPath, [probe, idxUrl], {
      env: baseEnv({ DSH_HOME: home, BILI_WATCH_CACHE: cache }),
      encoding: 'utf8',
      timeout: 120000,
    })
    const out = String(r.stdout || '')
    const err = String(r.stderr || '')
    must(!/NO_ROUTE/.test(out), `apply() 没注册出路由（rc=${r.status}）：stderr=${err.slice(0, 400)}`)
    const line = (/ROUTE_JSON=(.*)/.exec(out) || [])[1]
    must(line, `探针没打出结果（rc=${r.status}）：stdout=${out.trim().slice(0, 300)} stderr=${err.slice(0, 400)}`)
    return JSON.parse(line)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 这三条共用一次探针（一条探针跑三次进程没必要，同一个进程里三件事互不影响）。
//   懒执行：只在对应 check 走到时才跑，前一条红了后面照样能各自报出自己的错。
let routeProbeCache = null
const routeProbe = () => (routeProbeCache ??= runRouteProbe('c70'))

check('C70 /status 真跑：apply() 注册的 handler 喂进去，回 200 + ok:true + 面板要的字段一个不少', () => {
  const d = routeProbe()
  const s = d.status
  must(s.code === 200, `/status 回的不是 200：${s.code}（body=${String(s.body).slice(0, 200)}）`)
  must(s.json?.ok === true, `/status 的 ok 不是 true：${String(s.body).slice(0, 200)}`)
  const data = s.json?.data ?? {}
  // 这几个键是面板 index.html 直接读的：少一个就是「面板某一块永远空白」，不是样式问题
  for (const k of ['credential', 'deps', 'gpu', 'cache', 'tuning', 'tuningDefaults', 'tuningRanges', 'lastRun', 'ui', 'warnings']) {
    must(Object.prototype.hasOwnProperty.call(data, k), `/status.data 缺 ${k}——面板那一块会永远空白（现有键：${Object.keys(data).join(',')}）`)
  }
  must(typeof data.cache?.dir === 'string' && data.cache.dir.length > 0, '/status.data.cache.dir 不是非空字符串：遮罩后的缓存根没了，面板「清理」按钮没有目标')
  must(Array.isArray(data.warnings), '/status.data.warnings 不是数组（面板会 .filter 崩）')
  return `200 / ok:true / 字段齐（warnings ${data.warnings.length} 条）`
})

check('C71 sendJson 三个分支真跑：200 带 Content-Type、ok:false 走 404、抛错兜底 500', () => {
  const d = routeProbe()
  // ① 正常 200：状态码 + 头（Content-Type 写错，面板 fetch 拿到的就是 text/plain，res.json() 直接抛）
  must(d.status.code === 200, `① 正常分支不是 200：${d.status.code}`)
  const ct = String(d.status.headers?.['content-type'] ?? '')
  must(/^application\/json; charset=utf-8$/.test(ct), `① Content-Type 不对：${JSON.stringify(ct)}（应为 application/json; charset=utf-8）`)
  must(d.status.body && d.status.json, `① body 不是可解析的 JSON：${String(d.status.body).slice(0, 120)}`)
  // ② ok:false 的状态码：404 必须真的是 404，body 必须 ok:false（前端靠这两个分支区分失败）
  must(d.notFound.code === 404, `② 未知路由不是 404：${d.notFound.code}（body=${String(d.notFound.body).slice(0, 120)}）`)
  must(d.notFound.json?.ok === false, `② 404 的 body 没有 ok:false：${String(d.notFound.body).slice(0, 120)}`)
  must(/^application\/json; charset=utf-8$/.test(String(d.notFound.headers?.['content-type'] ?? '')), '② 404 分支没走 sendJson 的头')
  // ③ 兜底 500：这条最容易漏——handler 里任何一个 throw 都该落成 JSON 500，而不是挂住连接
  must(d.boom.code === 500, `③ 抛错没兜成 500：${d.boom.code}（body=${String(d.boom.body).slice(0, 200)}——请求会挂住或前端只看到 network error）`)
  must(d.boom.json?.ok === false, `③ 500 的 body 没有 ok:false：${String(d.boom.body).slice(0, 200)}`)
  must(/boom-url/.test(String(d.boom.json?.why ?? '')), `③ 500 的 why 没带原始错误信息：${JSON.stringify(d.boom.json?.why)}——出事了不知道原因`)
  return '200/json 头、404/ok:false、500 兜底三支都真跑过'
})

check('C72 claimRoute 真跑：同路径重复 apply 只注册一次，dispose 后必须能再注册（T41-P0-1）', () => {
  const d = routeProbe()
  // ② 同进程再 apply 一次（fiber 重放）：必须被挡住，否则同一个路径挂两个 handler
  must(d.afterTwice === 1, `同一路径 apply 两次注册了 ${d.afterTwice} 个——claimRoute 没挡住重放，两个 handler 会抢同一个 res`)
  // ③ dispose 之后必须能重新注册：不 release 的话重放后路由永久 404（原注释写的正是这个坑）
  must(!d.disposeErr, `apply() 返回的 dispose 抛错了：${d.disposeErr}`)
  must(d.afterDispose === 2, `dispose 之后重新 apply 没有重新注册（共 ${d.afterDispose} 个）——releaseRoute 没执行，重放后这条路由永久 404`)
  return `apply×2 → 1 个注册；dispose 后再 apply → ${d.afterDispose} 个（release 生效）`
})

// apply(ctx) 已从 429 行拆成 5 个子系统 + 8 行调度。这条断言盯两件事：
//   ① apply 本身不许再长回去（上限 120 是定下的）；
//   ② 五个子系统必须还在、必须有实质内容，且 apply 真的调它们——
//      否则「拆」可以靠「把内容删掉」通过，那不是拆。
check('C73 apply(ctx) 只剩调度：五个子系统各在其位，加起来的量级没缩水（429 → 8 行）', () => {
  const fn = topFunctions(read('index.js'))
  must(fn.has('apply'), '找不到 apply')
  const body = fn.get('apply')
  const la = codeLines(body)
  // 判据一律打在 codeLines 上，不打在原函数体上：R13 第一版就是这么假绿的——
  //   把 `registerTool(ctx)` 注释掉，`/registerTool\(ctx\)/` 仍然匹配到那行注释，
  //   于是「不接线」也能全绿。注释里提到的名字不算接线。
  const code = la.join('\n')
  must(la.length <= 120, `apply 又长回来了：${la.length} 行（上限 120，已拆成调度）`)
  must(la.length >= 5, `apply 只剩 ${la.length} 行——子系统被删了？`)
  // 调度形状：五条 ctx 调用一条不少
  const SUBS = { bootCache: 10, registerSlashCommand: 10, registerAutoHint: 25, registerTool: 60, registerPanelRoute: 100 }
  let sum = 0
  for (const [name, floor] of Object.entries(SUBS)) {
    must(fn.has(name), `apply 的子函数 ${name} 不见了（应留在 index.js 顶层）`)
    must(new RegExp(`^\\s*(?:return\\s+)?${name}\\(ctx\\)`, 'm').test(code), `apply 没真的调 ${name}(ctx)——子函数还在但没接线，等于死代码`)
    const n = codeLines(fn.get(name)).length
    sum += n
    must(n >= floor, `${name} 只剩 ${n} 行（应 ≥ ${floor}）——内容被搬走或删了，拆不等于删`)
  }
  // 具体内容不许回流到 apply：端点注册与工具 schema 都该在各自的子系统里
  must(!/webServer\.register/.test(code), 'apply 里又出现 webServer.register——路由注册回流了')
  must(!/defineTool\(/.test(code), 'apply 里又出现 defineTool(——工具 schema 回流了')
  return `apply ${la.length} 行；五个子系统合计 ${sum} 行（拆前同一个函数约 429 行）`
})

check('C74 路由守卫（lib/route-claim.mjs）：同路径被拒、不同路径不冲突、release 后可重登记', () => {
  // 为什么要单开一条：C72 只能黑盒验「apply 两次只注册 1 个」，
  //   而名单里的第三支「不同路径不冲突」黑盒根本测不到（面板只有一个路径）。
  //   搬进 lib 之后它是导出函数，这件事才能直接断言——不是为了测试改生产代码，是搬到能测的位置。
  const idx = read('index.js')
  must(!/^const ROUTE_PATHS = new Set\(\)/m.test(idx), 'index.js 里又有了本地 ROUTE_PATHS——两套登记表会各记各的')
  must(!/^function claimRoute\(/m.test(idx), 'index.js 里又有了本地 claimRoute（应在 lib/route-claim.mjs）')
  must(/from '\.\/lib\/route-claim\.mjs'/.test(idx), 'index.js 没有从 lib/route-claim.mjs 引入守卫')

  // 静态 import（见文件头）：check 是同步的，这里不能 await
  const A = '/api/c74-a'
  const B = '/api/c74-b'
  try {
    // ① 首次登记成功
    must(claimRoute(A) === true, '① 首次 claim 应返回 true')
    // ② 同一路径第二次被拒——fiber 重放时第二个 handler 不许挂上去
    must(claimRoute(A) === false, '② 同路径第二次 claim 应返回 false（否则两个 handler 抢同一个 res）')
    // ③ 不同路径互不影响（这条就是黑盒测不到的那半）
    must(claimRoute(B) === true, '③ 不同路径 claim 被误拒——守卫的粒度写成了「只要注册过就不许再注册」')
    must(claimRoute(A) === false && claimRoute(B) === false, '③ 两条都登记过之后，重复 claim 仍应各自 false')
    // ④ release 之后能重新登记：不 release 就永久 404，这正是 T41-P0-1 的坑
    releaseRoute(A)
    must(claimRoute(A) === true, '④ release 之后应能重新登记（否则 effect 重建一次路由就永久 404）')
    must(claimedPaths().includes(A) && claimedPaths().includes(B), '④ 登记表里没有 A/B')
  } finally {
    // 不许把状态漏给别人：verify 是同进程跑完所有断言，表里留东西会污染后续
    releaseRoute(A)
    releaseRoute(B)
  }
  must(claimedPaths().length === 0, `清理后登记表应为空，实际 ${JSON.stringify(claimedPaths())}`)
  return '四支真跑（首次 true / 重复 false / 另一路径 true / release 后 true），清理后表空'
})

check('C75 注释剥离器（verify-todo 的 stripComments）不会把 // 注释里的 /* 当成块注释起点', () => {
  // 为什么归到 verify：B5（「-404 有没有中文文案」）的判据完全建立在 stripComments 上。
  //   它坏掉时 B5 会给出与事实相反的结论，而 B5 自己看不出来——今天真实发生过：
  //   look.mjs 一行 `//` 注释里写了 `/*.mjs`，旧的「先剥块注释」实现从那里一路吃到下一个 `*/`，
  //   吞掉 237 行（含 biliCodeReason 的中文文案），B5 从 PASS 变 FAIL，看起来像功能被删了。
  //   所以剥注释这件事本身要有断言，且断在有代表性的四种输入上。
  // 取的是 verify-todo.mjs 里的**真实实现**（compile 抽函数体），不是抄一份。
  const { stripComments } = compile(read('tools/verify-todo.mjs'), ['stripComments'])
  const t = (src) => stripComments(src)
  // ① 行注释要被剥掉
  must(!/中文A/.test(t("const a = 1 // 中文A\nconst b = 2")), '① 行注释没被剥掉')
  // ② 块注释要被剥掉
  must(!/中文B/.test(t('/* 中文B */ const b = 2')), '② 块注释没被剥掉')
  // ③ 关键回归：行注释里出现 /* 不许开启块注释（这正是 B5 那次的事故）
  //   后面必须真的跟一个 */，否则「吃到下一个 */」这件事不会发生，用例就测不出差别
  //   （第一版没写这个块注释，旧实现照样绿——用例本身是弱的）。
  const r3 = t("// 见 tools/commands/*.mjs\nconst c = '中文C'\n/* 后面真有块注释 */\nconst f = 1")
  must(/中文C/.test(r3), '③ 行注释里的 /* 被当成块注释起点，一路吃到后面的 */，中间的代码被吞掉了（B5 会因此假红）')
  // ④ 字符串里的 // 与 /* 不是注释
  must(/中文D/.test(t("const d = '// 不是注释 /* 也不是 中文D'")), '④ 字符串里的 // 或 /* 被当成了注释起点')
  must(/中文E/.test(t('const e = `模板 // 中文E`')), '④ 模板串里的 // 被当成了注释起点')
  return '四类输入都对：行注释/块注释剥净，注释里的 /* 不开新块，字符串里的 // 不动'
})

check('C76 /cache/clear 真跑：删本插件的 BV 目录、不碰用户自己放的文件、skipped 里点名', () => {
  // 这条盯的是「会删用户文件的端点」里唯一大面积删除的那条。
  //   今天一整天在修的 isOwnedEntry / isOwnBvDir / removeOwned 全在这条链上，而它们的入口
  //   （HTTP 路由）此前一条真跑断言都没有——删错了只有用户会发现。
  // 沙箱由探针提供（临时 DSH_HOME + BILI_WATCH_CACHE），夹具是「一个 BV 目录 + 一个用户文件」。
  const d = routeProbe()
  const c = d.clear
  must(c, '探针没有 /cache/clear 的结果（探针没跑到那一支）')
  must(c.code === 200, `/cache/clear 回的不是 200：${c.code}（body=${String(c.body).slice(0, 200)}）`)
  must(c.json?.ok === true, `/cache/clear 没报成功：${String(c.body).slice(0, 300)}`)
  const data = c.json?.data ?? {}
  must(d.afterClear?.bvGone === true, '本插件的 BV 目录还在——/cache/clear 没删自己的缓存（面板点清理等于没反应）')
  must(d.afterClear?.userKept === true, '用户自己放在缓存根的文件被删了——这是数据丢失，不是清理')
  // CSRF 闸：不带 Content-Type 的 POST 必须 403，而且什么都没删（先挡再动手）
  const b = d.clearBlocked ?? {}
  must(b.code === 403, `不带 Content-Type 的 POST 没被挡：${b.code}（跨站写请求闸失效）`)
  must(d.afterBlocked?.bvStill === true && d.afterBlocked?.userStill === true, '被 CSRF 闸拒绝的那次请求居然删了东西')
  const skipped = Array.isArray(data.skipped) ? data.skipped : []
  must(skipped.some((s) => String(s?.name) === '我的视频.mp4'), `skipped 里没有点名用户文件（现有：${JSON.stringify(skipped)}）——E4-10 就是面板从不读这个字段`)
  must(Number(data.removed) >= 1, `removed 没数到真删掉的文件：${data.removed}`)
  return `403 闸有效且未删；200 + ok；BV 目录已删、用户文件保留且在 skipped 里点名；removed=${data.removed}`
})

// ── C78：jget 的五个特殊分支（搬进 lib/bili-api.mjs 时的真跑证据）──────
// 为什么现在才有：输出基线只覆盖成功路径——412/200+HTML/-352/5xx 这几支要么抛错要么返回
//   兜底对象，19 条命令一条都碰不到。搬到 lib 时任何一支被搬丢，基线也是全绿。
// 怎么跑：本地 http 服务器（127.0.0.1，随机端口），七种响应各来一次，探针在子进程里跑。
check('C78 jget 五支真跑：412 风控、200+HTML 风控、-352 翻译、5xx 只重试一次、非 JSON 兜底（本地服务器）', () => {
  const p = spawnSync(process.execPath, [join(HERE, 'fixtures', 'jget-probe.mjs')], { encoding: 'utf8', timeout: 120000 })
  must(p.status === 0, `探针退出码 ${p.status}：${String(p.stderr || '').slice(0, 300)}`)
  const r = JSON.parse(String(p.stdout).trim().split('\n').pop())
  must(r.ok?.ok === true && r.ok.val?.code === 0 && r.ok.val?.data?.x === 1, `正常 JSON 没原样透传：${JSON.stringify(r.ok)}`)
  must(r.html?.ok === false && /风控/.test(r.html.err) && /HTML/.test(r.html.err), `200+HTML 没被认成风控：${JSON.stringify(r.html)}`)
  must(r['412']?.ok === false && /412/.test(r['412'].err), `HTTP 412 没抛风控：${JSON.stringify(r['412'])}`)
  must(r.notjson?.val?.code === -999 && /content-type/.test(String(r.notjson.val.message)), `非 JSON 没走 -999 兜底：${JSON.stringify(r.notjson)}`)
  must(r.risk352?.val?.code === -352 && /触发风控/.test(String(r.risk352.val?.message)), `-352 没翻成人话：${JSON.stringify(r.risk352)}`)
  must(r.http500?.val?.code === -500, `5xx 没落到 HTTP 错误对象：${JSON.stringify(r.http500)}`)
  // 退避只重试一次：服务器收到两次 /500，第三次就该放弃（再多就是重试风暴）
  must(r.hits500 === 2, `/500 被请求了 ${r.hits500} 次（应恰好 2 次：原请求 + 一次重试）`)
  must(r.http404?.val?.code === -404, `404 没转成 -404：${JSON.stringify(r.http404)}`)
  // 6-10 的失败现场：每次响应都要记一笔，且 200 的 HTML 也要记（事后才查得清风控页长什么样）
  must(r.diagCount === 7, `onDiag 记了 ${r.diagCount} 次（7 次请求应记 7 次）`)
  must(r.diagHtml?.[1] === 200, `HTML 风控页的 diag 状态码不是 200：${JSON.stringify(r.diagHtml)}`)
  // ── 请求头（2026-11-01 第 1 条）────────────────────────────────────────
  // 断的是**服务器端收到的头**，不是源码里有没有那句字符串 —— 只有前者能证明「发出去的是它」。
  // 为什么要有这条：lib 化时 jget 的默认头从 H 退成 `{}`，而探针一直不传 headers，
  //   于是这条守卫验的是「裸奔的 jget」：本地服务器什么都不挑，线上 B 站必 412，
  //   2026-11-01 之前全仓库**零条**断言检查请求头（扰动默认头回 `{}` 时 109 条全绿）。
  must(
    Array.isArray(r.hdrUA) && r.hdrUA.length === 1 && /^Mozilla\/5\.0 /.test(r.hdrUA[0]),
    `8 次请求的 user-agent 不是同一个浏览器 UA：${JSON.stringify(r.hdrUA)}（lib 的默认头丢了或被写成空串）`
  )
  must(
    Array.isArray(r.hdrRef) && r.hdrRef.length === 1 && r.hdrRef[0] === 'https://www.bilibili.com/',
    `8 次请求的 referer 不是同一个站点根：${JSON.stringify(r.hdrRef)}`
  )
  // **不要**为「入口把 `headers = H` 改成 `{}` 时这条仍然绿」再补断言。
  //   默认参数是**整体替换**不是合并：入口一旦传了 headers，lib 的 DEFAULT_HEADERS 就不参与，
  //   所以这里绿是对的（薄壳少一层兜底只少一个 Cookie，属于入口的事）。
  //   补一条「断薄壳」的断言就是纸老虎——它永远不会红，还会让人以为 lib 的默认值在兜底。
  return '412 / HTML / -352 / -999 / 5xx 重试两次 / 404 全对，diag 七次；8 次请求都带同一个 UA + Referer'
})

// ── C79：verify-todo 的 fnBody（预处理函数）自检 ─────────────────────────
// 定下的规矩：**凡是「先预处理再匹配」的断言，预处理函数本身要有用例**（B5 那次
//   从 67 行吃到 304 行就是预处理出错，判据没错）。verify-todo 的 B 系列全靠 fnBody 取函数体，
//   它取错时那些断言会给出与事实相反的结论，而它们自己看不出来。
check('C79 verify-todo 的 fnBody 自检：export 前缀要认、注释里的同名声明不许认、截断落在行首括号', () => {
  const { fnBody } = compile(read('tools/verify-todo.mjs'), ['fnBody'])
  const src = [
    '// function ghost() { 这是注释里的同名声明，不许被取到',
    'export async function real(a) {',
    '  const x = 1',
    '  if (x) {',
    '    return a',
    '  }',
    '}',
    'const after = 1',
  ].join('\n')
  const body = fnBody(src, 'real')
  must(body, 'export async function 没被认出来（lib/ 里的实现全是这个形状，B14 会因此假红）')
  must(/return a/.test(body), '取到的函数体里没有函数内容')
  // fnBody 的切片从匹配起点开始，而匹配起点含前面的换行——所以只断「头里带 export」，
  // 不断「第一个字符是 e」（第一版断 ^ 就直接红了，是断错了，不是实现错了）。
  must(/export async function real\(a\)/.test(body.slice(0, 40)), `函数头没带 export：${JSON.stringify(body.slice(0, 40))}`)
  must(!/after/.test(body), '函数体吃过了行首闭合括号（把后面的代码也切进来了）')
  // 注释里的同名声明：整行以 // 开头，正则要求行首是 function/async/export，必须取不到
  must(fnBody(src, 'ghost') === null, '注释里的 function ghost(... 被当成了真声明')
  must(fnBody(src, 'nope') === null, '不存在的函数名返回了内容')
  // 2026-11-01（0.4.1 第 7 条）：抽到「半截垃圾」必须当没抽到（null），不许把片段交出去。
  //   函数体里有一行以 `}` 开头（模板字符串里很常见）就会被提前截断，而 B 系列全是字符串匹配，
  //   垃圾照样能匹配出结论。这里做编译自检：解析不了 → null → 调用方走「未找到」那条明路。
  const broken = ['function broken() {', '  const s = `', '}', '`', '  return s', '}', ''].join('\n')
  must(fnBody(broken, 'broken') === null,
    `截断后的垃圾片段没被编译自检拦下（交出去会让下游拿它算出红或绿，两种都不代表真事）：${JSON.stringify(fnBody(broken, 'broken'))}`)
  return 'export 认、ghost 不认、截断在行首 } 之前、半截垃圾返回 null'
})

// ── C81/C82：ffExec 与 findFfmpeg 真起进程（不是桩）─────────
// 为什么必须真跑而不是断源码里有这行：ffExec 的第三参数两种形状（数字=超时 / 对象=options），
//   写错的后果是**静默错**——只按数字处理，调用方的 encoding 丢了，sceneTimes 拿到 Buffer、
//   matchAll 抛错被 catch 成 []，「场景检测永远没结果」，不红不报。断源码有这行救不了这个。
// 用的「ffmpeg」是当前 node 自己（它认 -version，和 ffmpeg 一样能被 probe），所以不依赖本机装没装 ffmpeg。
check('C81 ffExec 真起进程：默认 utf8 / 数字=超时 / 对象=options 原样透传 / stderr 尾三行', () => {
  const bin = process.execPath
  // ① 第三参数不传 → 默认 encoding=utf8：返回字符串，不是 Buffer（sceneTimes 靠这个 matchAll）
  const s1 = ffExec(bin, ['-e', 'process.stdout.write("héllo")'])
  must(typeof s1 === 'string', `没传第三参数时返回了 ${typeof s1}：默认 encoding 丢了，sceneTimes 会静默变空`)
  must(s1 === 'héllo', `stdout 读错了：${JSON.stringify(s1)}`)

  // ② 第三参数是数字 → 当超时用：子进程睡 5s，给 400ms，必须被杀
  let e2 = null
  try { ffExec(bin, ['-e', 'setTimeout(() => {}, 5000)'], 400) } catch (e) { e2 = e }
  must(e2, '数字第三参数没当超时用：子进程睡 5 秒却没被超时杀掉')
  must(e2.code === 'ETIMEDOUT', `超时的 err.code 不是 ETIMEDOUT：${e2.code}/${e2.message}`)
  must(/^ffmpeg 失败：/.test(e2.message), `错误没走统一包装（用户会看到原始 spawnSync 报错）：${e2.message}`)

  // ③ 第三参数是对象 → 原样透传给 execFileSync：maxBuffer=8 给 100 字节输出，必须 ENOBUFS。
  //    这条是 N-04 那个坑的正身：对象被当成数字丢掉时，maxBuffer 退回默认值，这里就不会抛。
  let e3 = null
  try { ffExec(bin, ['-e', 'process.stdout.write("x".repeat(100))'], { encoding: 'utf8', maxBuffer: 8 }) } catch (e) { e3 = e }
  must(e3, '对象第三参数没被透传：maxBuffer=8 却没拦住 100 字节输出（fetchGenericMeta 会因此 ENOBUFS）')
  must(e3.code === 'ENOBUFS', `对象没进 execFileSync：code=${e3.code}`)

  // ④ 对象里没给 stdio → 补默认 ['ignore','pipe','pipe']：stderr 拿得到，且只取最后 3 行非空
  let e4 = null
  try {
    ffExec(bin, ['-e', 'process.stderr.write("a\\nb\\nc\\nd\\n");process.exit(3)'], { encoding: 'utf8', timeout: 10000 })
  } catch (e) { e4 = e }
  must(e4, '非零退出没抛错')
  must(e4.message === 'ffmpeg 失败：b / c / d', `stderr 尾三行拼得不对：${JSON.stringify(e4.message)}`)

  // ⑤ 调用方自己给 stdio 时不许被覆盖（面板那边有传 stdio 的调用点）
  const s5 = ffExec(bin, ['-e', 'process.stderr.write("noise");process.stdout.write("clean")'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  must(s5 === 'clean', `调用方的 stdio 被覆盖了：${JSON.stringify(s5)}`)
  return '默认 utf8 / 超时 ETIMEDOUT / maxBuffer 生效 / 尾三行 / stdio 不被覆盖'
})

check('C82 findFfmpeg 真起进程：arg → extra → PATH 的顺序，跑不通的跳过，全不通返回 null', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bw-ff-'))
  // 被测二进制用当前 node：它不能吃 ffmpeg 的 -version（实测 rc=9），所以探测参数换成 -e 0
  const PROBE = ['-e', '0']
  try {
    // ① arg 能跑通探测 → 原样返回
    must(findFfmpeg(process.execPath, [], PROBE) === process.execPath, 'arg 能跑通却没被选中')
    // ② arg 不存在 → 落到 extra 的第一项
    must(findFfmpeg(join(tmp, 'nope.exe'), [process.execPath], PROBE) === process.execPath, 'arg 不存在时没回落到 extra')
    // ③ 存在但跑不起来的文件必须跳过（不是「存在就算」）——一个 txt 放在 arg 位
    const fake = join(tmp, 'not-a-binary.txt')
    writeFileSync(fake, 'not an executable')
    must(findFfmpeg(fake, [process.execPath], PROBE) === process.execPath, '存在但跑不通的文件被当成可用 ffmpeg（后面每次抽帧都会失败）')
    // ④ 一个都不通 → null（PATH 清空，免得本机装的 ffmpeg 让这条变成环境依赖）
    const script = `import('${pathToFileURL(join(ROOT, 'lib', 'media.mjs')).href}')
      .then((m) => process.stdout.write(String(m.findFfmpeg('${join(tmp, 'x.exe').replace(/\\/g, '\\\\')}', ['${join(tmp, 'y.exe').replace(/\\/g, '\\\\')}']))))`
    const empty = join(tmp, 'empty-path')
    mkdirSync(empty, { recursive: true })
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PATH: empty, Path: empty }, encoding: 'utf8', timeout: 60000,
    })
    must(r.stdout === 'null', `候选全不通时返回了 ${JSON.stringify(r.stdout)} / stderr=${(r.stderr || '').slice(0, 200)}`)
    return 'arg 优先 / 回落 extra / 跑不通跳过 / 全不通 null'
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── C83/C84：下载与「缓存里有没有 mp4」两条真跑 ──────────────────────────────
// 为什么值得单独一轮：这两条的**每一条分支都只在出错时走到**，输出基线（57 个文件）只覆盖
//   成功下载那两条，任何一支被搬丢、被改坏，基线一个字都不会变。后来把 downloadTo
//   搬进 lib 时顺带把「上限」文案从写死的 512 MB 改成跟 maxBytes 走，这里把新文案钉住。
check('C83 downloadTo 八支真跑（本地 http）：风控 HTML/JSON、404、两条超限、过小、网络层、原子写不留 .part', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/fixtures/download-probe.mjs')], {
    encoding: 'utf8', timeout: 180000, env: { ...process.env },
  })
  must(r.status === 0, `探针自己挂了（rc=${r.status}）：${(r.stderr || '').slice(0, 300)}`)
  let o
  try {
    o = JSON.parse(String(r.stdout).trim().split('\n').pop())
  } catch {
    must(false, `探针输出不是 JSON：${String(r.stdout).slice(0, 200)}`)
  }
  // ① 正常：写出 2048 B，且不残留 .part（先写 part 再改名，成功时 part 必须已消失）
  must(o.ok?.ok === true && o.ok.bytes === 2048, `正常下载没写成：${JSON.stringify(o.ok)}`)
  must(o.ok.partLeft === false, '正常下载后还留着 .part')
  // ② 200 + HTML / 200 + JSON 都必须按「风控」拦（B13：别把验证页存成 mp4）
  must(String(o.html?.err || '').includes('触发风控'), `200+HTML 没认成风控：${o.html?.err}`)
  must(String(o.json?.err || '').includes('触发风控'), `200+JSON 没认成风控：${o.json?.err}`)
  // ③ 非 200
  must(String(o.notfound?.err || '') === '下载失败 HTTP 404', `404 处理不对：${o.notfound?.err}`)
  // ④ 超限两条判据都在：先看 Content-Length（省流量），没给头时靠读完之后再比
  must(String(o.big?.err || '').includes('Content-Length'), `有 Content-Length 时没先拦：${o.big?.err}`)
  must(String(o.big?.err || '').includes('上限 2 MB'), `上限文案没跟 maxBytes 走（还写死 512 MB？）：${o.big?.err}`)
  must(String(o.bigChunked?.err || '').includes('3145728 B'), `chunked（无 Content-Length）时没按实际体积拦：${o.bigChunked?.err}`)
  must(!String(o.bigChunked?.err || '').includes('Content-Length'), `无头时不该报 Content-Length：${o.bigChunked?.err}`)
  // ⑤ 小于 1 KB
  must(String(o.tiny?.err || '').includes('下载内容太小'), `过小的响应没拦：${o.tiny?.err}`)
  // ⑥ 网络层：注入的 onNetError 必须被调用（CLI 注入的是 friendlyNetError）
  must(String(o.net?.err || '').startsWith('NETWRAP:'), `onNetError 没被调用：${o.net?.err}`)
  // ⑦ 所有失败分支一律不留文件、不留 .part
  const bad = Object.entries(o).filter(([, v]) => v.ok === false && (v.destExists || v.partLeft))
  must(bad.length === 0, `失败分支留下了产物：${bad.map(([k]) => k).join(',')}`)
  return `8 支：成功 2048 B / HTML+JSON 风控 / 404 / CL 3 MB>2 MB / chunked 3 MB / 100 B / NETWRAP；失败分支零残留`
})

check('C84 cachedMp4 真造目录：只认本 P、小于 1 KB 不算、根不存在返回 null', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c84-'))
  try {
    const base = join(tmp, 'frames')
    const mk = (dir, name, bytes) => {
      mkdirSync(join(base, dir), { recursive: true })
      writeFileSync(join(base, dir, name), Buffer.alloc(bytes, 1))
    }
    // p1 有正片、p2 也有；BVtiny 那份只有 500 B（半截/占位）；另一个 BV 的目录不许被认
    mk('BV1aa-p1-2s', 'BV1aa.mp4', 4096)
    mk('BV1aa-p2-2s', 'BV1aa.mp4', 8192)
    mk('BV1bb-p1-2s', 'BV1bb.mp4', 500)
    mk('BV1aa-p1-2s', 'other.mp4', 4096)
    must(cachedMp4(base, 'BV1aa', 1) === join(base, 'BV1aa-p1-2s', 'BV1aa.mp4'), 'p1 没命中自己的 mp4')
    must(cachedMp4(base, 'BV1aa', 2) === join(base, 'BV1aa-p2-2s', 'BV1aa.mp4'), 'p2 没命中自己的 mp4（多 P 会拿错 P 的画面）')
    must(cachedMp4(base, 'BV1bb', 1) === null, '500 B 的半截文件被当成可用 mp4')
    must(cachedMp4(base, 'BV1cc', 1) === null, '没有这个 BV 也返回了路径')
    must(cachedMp4(join(tmp, 'nope'), 'BV1aa', 1) === null, '缓存根不存在时没返回 null')
    return 'p1/p2 各命中自己那份；500 B 与不存在的 BV 返回 null；根不存在返回 null'
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('C85 autoStep / pickEvenly 真跑（快慢自适应与均匀取点，都是帧数上限的输入）', () => {
  must(autoStep(0) === 2 && autoStep(-5) === 2, '时长拿不到时没退到 2 秒（3 小时视频会抽几千帧的旧坑）')
  must(autoStep(60) === 2, '短频（60s）间隔不是 2')
  must(autoStep(120) === 2, '120s 边界不是 2')
  must(autoStep(121) === 5, '刚过 120s 没进 5 秒档')
  must(autoStep(301) === 10, '刚过 300s 没进 10 秒档')
  must(autoStep(901) === 20, '刚过 900s 没进 20 秒档')
  must(JSON.stringify(pickEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)) === '[1,6,10]', `10 个点取 3 个不对：${JSON.stringify(pickEvenly([1,2,3,4,5,6,7,8,9,10], 3))}`)
  must(JSON.stringify(pickEvenly([7, 8], 1)) === '[7]', 'n<=1 时没返回第一个')
  must(pickEvenly([1, 2, 3], 3).length === 3, '取点数与要求不符')
  return 'autoStep 六档边界对；pickEvenly 首尾必取、n<=1 取首个'
})

// ── C86：sceneTimes 真起 ffmpeg（本机没装就跳过，不当通过）──────────────────
// 为什么要真跑：sceneTimes 的 catch 会把**任何**异常吞成 []，而 [] 在 grabFrames 里
//   只是「回落等间隔」——用户看到的是「场景检测没效果」，不是报错。上一轮 ffExec 的
//   第三参数坏掉（对象当数字处理）就是这种形状：sceneTimes 永远返回 []，全绿。
check('C86 sceneTimes 真起 ffmpeg：两段纯色片子必须有 1 个变化点；阈值真的生效；坏路径返回 [] 不抛', () => {
  const cands = [process.env.BILI_WATCH_FFMPEG, join(ROOT, 'deps', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')].filter(Boolean)
  const bin = findFfmpeg(null, cands)
  if (!bin) {
    skip('C86 sceneTimes 真起 ffmpeg', '本机找不到 ffmpeg（PATH、BILI_WATCH_FFMPEG、deps 三处都看了）——装一个 ffmpeg 到 PATH 或设 BILI_WATCH_FFMPEG 指过去，这条会真跑；跳过不算通过')
    return
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c86-'))
  try {
    const file = join(tmp, 'two-colors.mp4')
    execFileSync(bin, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=red:s=160x120:d=1.5',
      '-f', 'lavfi', '-i', 'color=blue:s=160x120:d=1.5',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1', '-c:v', 'mpeg4', '-y', file,
    ], { stdio: 'ignore', timeout: 120000 })
    const pts = sceneTimes(file, 0.08, bin)
    must(Array.isArray(pts) && pts.length >= 1, `两段纯色片子没检出变化点（返回 ${JSON.stringify(pts)}）——ffExec 第三参数一坏就是这个形状`)
    must(Math.abs(pts[0] - 1.5) < 0.6, `变化点位置不对：${JSON.stringify(pts)}（应≈1.5s）`)
    // 阈值真的传进去了：0.4 的场景分在 0.99 的门槛下必须一个都不留
    must(sceneTimes(file, 0.99, bin).length === 0, '阈值 0.99 还检出变化点——th 没传进去？')
    // 坏路径：不抛，返回 []（调用方据此回落等间隔）
    must(sceneTimes(join(tmp, 'nope.mp4'), 0.3, bin).length === 0, '喂不存在的文件时没安静返回 []')
    return `检出 ${JSON.stringify(pts)}；0.99 阈值下 0 个；坏路径 []`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})


// 背景：`check('X', async () => {...})` 会被记一笔 PASS、断言体跑不完，而且**任何反向测试都救不了**
//   ——反向也不跑，照样绿。这条断的是「守卫还在」：喂一个 async 回调，必须看见 FAIL。
//   守卫要是被删/被改坏，这条会红；它红了就说明「今天所有断言的结果都不作数」，比任何一条业务断言失败都严重。
check('C77 执行器自检：async 回调必须记 FAIL、must(false) 必须抛（守卫自己也有断言）', () => {
  // ① 主用例：async 回调 → 必须 FAIL，且原因写的是 Promise
  const r1 = []
  const c1 = makeChecker(r1)
  let afterAwait = false
  c1('selftest-async', async () => {
    await Promise.resolve()
    afterAwait = true
    throw new Error('这行永远进不了 catch')
  })
  must(r1.length === 1, `async 回调记了 ${r1.length} 条结果（应为 1）`)
  must(r1[0].ok === false, 'async 回调被记成 PASS —— thenable 守卫失效，所有异步断言会静默变绿')
  must(/Promise/.test(String(r1[0].detail)), `FAIL 原因不是 Promise：${r1[0].detail}`)
  // ② 再钉一次 bug 的形状：await 之后那句确实没跑（Promise 里的异常没人接，正是原 bug）
  must(afterAwait === false, 'await 之后的语句居然执行了——执行器行为变了，守卫的判断前提要重看')

  // ③ 同步抛错 → FAIL，detail 取消息（别把错误吞成 PASS）
  const r2 = []
  makeChecker(r2)('selftest-throw', () => { throw new Error('同步炸了') })
  must(r2.length === 1 && r2[0].ok === false && r2[0].detail === '同步炸了', `同步抛错记成了 ${JSON.stringify(r2)}`)

  // ④ 内部已记过一笔（skip）→ 不许再补 PASS（C1：跳过不混进通过数）
  const r3 = []
  makeChecker(r3)('selftest-skip', () => {
    r3.push({ name: 'selftest-skip', ok: false, skip: true, detail: '需要联网' })
    return undefined
  })
  must(r3.length === 1 && r3[0].skip === true, `skip 之后被补了 PASS：${JSON.stringify(r3)}`)

  // ⑤ 正常同步通过 → 一条 PASS，detail 原样带出
  const r4 = []
  makeChecker(r4)('selftest-ok', () => 'ok-detail')
  must(r4.length === 1 && r4[0].ok === true && r4[0].detail === 'ok-detail', `同步通过记成了 ${JSON.stringify(r4)}`)

  // ⑥ must 自己必须会抛（2026-11-01，P0-3）
  //
  //   它原来在 verify.mjs 第 64 行是文件局部常量，外面碰不到 —— 于是「700 多处断言全靠它把
  //   不成立变成异常」的这个东西，自己一条断言都没有。实测把它打空（`const must = () => {}`）：
  //   97 通过 / 7 失败 / 2 跳过，而当时这条 C77 **仍然 PASS** —— 那 97 里每一条都是假绿。
  //
  //   这一段的意义是钉 four things：会抛 / 抛的是 Error / 消息是原文 / 真值不许抛。
  //
  //   **为什么这里用原生 `throw` 而不是 must(...)：**
  //   用 must 来验 must 是自指 —— must 被打空时，本段里那些 `must(...)` 也全都不抛，
  //   于是「验 must 的断言」自己被静默跳过，C77 照样绿，这条守卫等于没有。
  //   自证类断言的判据必须落在**被测对象之外**（这里是 JS 的 throw 语义）。
  //   这一条是这轮想明白的：C77 当初验 makeChecker 时用 must 是安全的（must 当时还活着），
  //   但一旦被验对象就是 must 本身，就必须换判据。
  let threwMust = null
  try { must(false, 'must-selftest') } catch (e) { threwMust = e }
  if (!(threwMust instanceof Error)) {
    throw new Error(`must(false) 没有抛 Error（抛的是 ${JSON.stringify(threwMust)}）—— 700 多处断言的失败信号没了，整个验证器会全线假绿`)
  }
  if (threwMust.message !== 'must-selftest') {
    throw new Error(`must 抛的消息不是原文：${threwMust.message}`)
  }
  for (const truthy of [true, 1, 'x', [], {}]) {
    let bad = false
    try { must(truthy, '不该抛') } catch { bad = true }
    if (bad) throw new Error(`must(${JSON.stringify(truthy)}) 抛了 —— 判据方向反了`)
  }
  for (const falsy of [false, 0, '', null, undefined, NaN]) {
    let ok = false
    try { must(falsy, '该抛') } catch { ok = true }
    if (!ok) throw new Error(`must(${String(falsy)}) 没抛 —— falsy 必须算失败`)
  }

  // ⑦ 「must 只有一份」——结构上钉住，防止有人在 verify.mjs 里顺手再写一个局部 must。
  //   这是 ⑥ 的补强：⑥ 验的是「我 import 的那个绑定会抛」，但如果将来有人在 verify.mjs 里
  //   重新加一行 `const must = ...`，它会把 import 的那个悄悄遮蔽（JS 的 const 重复声明会报错，
  //   但改成别的名字或写进函数作用域就不会），于是 ⑥ 验的是 A、用的可能是 B。
  //   实测：把 import 换回局部 const 后 ⑥ 仍绿（它验的是 import 的那份），这条 ⑦ 才红。
  const vsrc = read('tools/verify.mjs')
  if (/^[ \t]*const must[ \t]*=/m.test(vsrc)) {
    throw new Error("verify.mjs 里又出现了 `const must = ...`（第二份实现）——C77 验的是 check-run.mjs 那份，用的可能是另一份")
  }
  if (!/import\s*\{[^}]*\bmust\b[^}]*\}\s*from\s*'\.\/check-run\.mjs'/.test(vsrc)) {
    throw new Error("verify.mjs 没有从 ./check-run.mjs import must")
  }

  // ⑧ 抛出物转不成字符串时，执行器也不许崩（2026-11-01，P1-7）
  //   原来 catch 里写 `e?.message ?? String(e)` —— `String(Object.create(null))` 会抛
  //   TypeError（Cannot convert object to primitive value）。那是**在 catch 里**，
  //   于是「记录一条失败」这一步自己失败，验证器崩在做记录这一行：
  //   一条结果都没 push、汇总一行都没打，看上去像「验证器跑不起来」而不是「有一条断言失败」。
  //   三段：不崩 / 记成 FAIL / detail 是字符串。
  const weird = Object.create(null)
  const r5 = []
  let crashed = null
  try {
    makeChecker(r5)('selftest-weird-throw', () => { throw weird })
  } catch (e) { crashed = e }
  if (crashed) throw new Error(`抛出物是 Object.create(null) 时执行器崩了：${crashed && crashed.message}`)
  if (r5.length !== 1 || r5[0].ok !== false) {
    throw new Error(`抛出物是 Object.create(null) 时没记成 FAIL：${JSON.stringify(r5.map((x) => x.ok))}`)
  }
  if (typeof r5[0].detail !== 'string' || r5[0].detail === '') {
    throw new Error('抛出物转不成字符串时 detail 不是非空字符串')
  }

  return 'async 记 FAIL（body 未跑完）、同步抛错记 FAIL、skip 不重复记账、同步通过记 PASS、must(false) 抛 Error、must 只有一份、异形抛出物不崩'
})

check('C80 Python 回退链：某个候选不可用时继续试下一个，不许整条链断掉（issue #7 的 node 版）', () => {
  // issue #7 的根因：PS 5.1 的全局 $ErrorActionPreference='Stop' 下，py 启动器探测「没装的版本」
  //   会往 stderr 写 [ERROR] No runtime installed... → 原生命令写 stderr 就抛 NativeCommandError
  //   → 回退链第一个候选就炸，一次都没走到后面的版本。
  // 2026-11-02（fetch-deps 合一）：脚本改成 node 之后**这个机制不存在了**（spawnSync 只看退出码），
  //   但「某个候选失败会不会让整条链停下来」这件事仍然要真跑才算数 —— 判据守行为，不守写法。
  //   判法：--dry-run 打印的 Python 计划必须是一句正常描述。旧版这里会把异常消息当计划打出来
  //   （实测：合并前跑 fetch-deps.ps1 -Target all -DryRun，这一行正是
  //     [dry-run] Python：error: No interpreter found for Python 3.12 ...）。
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fetch-deps.mjs'), 'asr', '--dry-run'], {
    encoding: 'utf8',
    timeout: 180000,
    env: baseEnv(),
  })
  const out = String(r.stdout || '') + String(r.stderr || '')
  const m = out.match(/\[dry-run\] Python：(.+)/)
  must(m, '--dry-run 没打印 Python 计划（rc=' + r.status + '）：' + out.slice(0, 300))
  must(m[1].trim().length > 0, 'Python 计划这一行是空的')
  must(
    !/No interpreter|error while|Traceback|NativeCommandError/i.test(m[1]),
    'Python 计划这一行是异常消息而不是计划（回退链断在这一步）：' + m[1].trim(),
  )

  // 结构面：候选版本必须逐个试，且每个都靠退出码判（不是靠异常中断）
  const src = read('scripts/fetch-deps.mjs')
  const loop = src.match(/for \(const v of \[('[^']+'(?:,\s*'[^']+')*)\]\) \{\s*const r = run\(launcher/)
  must(loop, '找不到 py 启动器的候选版本循环（回退链结构变了，先修判据）')
  const vers = [...loop[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  must(vers.length >= 3, '候选版本只有 ' + vers.length + ' 个（回退链太短）')
  must(vers.includes('3.14'), '候选版本里没有 3.14：' + vers.join('/') + '（实测 3.14.6 的 venv 能跑 ASR/OCR，不该被硬拒）')
  return '真跑计划正常（' + m[1].trim().slice(0, 50) + '）；回退链 ' + vers.join('/')
})

// ── C87/C88：cache 层（目录 / manifest / 等他人）与锁工厂，真跑 ──────
// 这两层原来是 tools/look.mjs 里的局部函数，verify 只能靠「抠函数体 + new Function」碰它们，
// 抠不到就假红、抠到了也只是「看起来像」。搬进 lib 之后可以 import 真跑。
check('C87 cache 层真跑：manifest 往返、坏 manifest 当没有、等他人命中/超时、目录名形状', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c87-'))
  try {
    // ① manifest 往返：写进去的字段原样读回来（times 是「--at 换时刻不许撞缓存」那条 C47 的地基）
    writeManifest(tmp, { ok: true, bv: 'BV1aaaaaaaaa', p: 2, frames: 5, times: [460, 750] })
    const back = readManifest(tmp)
    must(back?.ok === true && back.frames === 5, `manifest 读回来是 ${JSON.stringify(back)}`)
    must(JSON.stringify(back.times) === '[460,750]', `times 读回来是 ${JSON.stringify(back.times)}`)
    must(typeof back.at === 'number', 'manifest 没带写入时刻 at')
    // ② manifest 坏了 / 不存在 → 当「没做完」，不许把残帧当完整结果复用
    writeFileSync(join(tmp, 'manifest.json'), '{ 这不是 JSON', 'utf8')
    must(readManifest(tmp) === null, '坏 manifest 没有返回 null——会被当成有效缓存')
    const empty = mkdtempSync(join(tmpdir(), 'bw-c87b-'))
    try {
      must(readManifest(empty) === null, '没有 manifest 时没有返回 null')
    } finally { rmSync(empty, { recursive: true, force: true }) }
    // ③ 等他人：waitManifest 是 async，check() 回调必须同步（C77）→ 另起进程真跑，父进程 spawnSync 读结果
    //    探针里 sleep 是注入的假函数，不真等 1 秒，所以是秒级的
    const probe = spawnSync(process.execPath, [join(HERE, 'fixtures', 'frames-probe.mjs')], {
      encoding: 'utf8', timeout: 60000,
    })
    must(probe.status === 0, `waitManifest 探针退出码 ${probe.status}：${String(probe.stderr || '').slice(0, 300)}`)
    let w
    try {
      w = JSON.parse(String(probe.stdout || ''))
    } catch {
      throw new Error(`waitManifest 探针输出不是 JSON：${String(probe.stdout || '').slice(0, 300)}`)
    }
    must(w.hitFrames === 5, `等他人没等到 manifest（hitFrames=${JSON.stringify(w.hitFrames)}）`)
    must(w.polls === 1, `第一次轮询就该命中，实际轮询了 ${w.polls} 次`)
    must(w.none === null, `等不到时返回了 ${JSON.stringify(w.none)}——调用方会以为命中`)
    must(w.n === 3, `轮询次数是 ${w.n}，应等于 tries=3`)
    must(w.lateFrames === 9 && w.latePolls === 2, `第 2 轮才写 manifest 的情形不对：${JSON.stringify(w)}`)
    must(w.halfIsNull === true, `已有的半截 manifest（frames=2，判据要 ≥5）被当成了命中：${JSON.stringify(w)}`)
    must(w.halfPolls === 3, `半截 manifest 情形下轮询了 ${w.halfPolls} 次，应等于 tries=3`)
    // ④ jpg 清单：只认 .jpg
    const jdir = join(tmp, 'jpgs')
    ensureDir(jdir)
    writeFileSync(join(jdir, 'a.jpg'), 'x')
    writeFileSync(join(jdir, 'b.jpg'), 'x')
    writeFileSync(join(jdir, 'note.txt'), 'x')
    const list = listJpgs(jdir)
    must(list.length === 2 && list.every((f) => f.endsWith('.jpg')), `jpg 清单是 ${JSON.stringify(list)}`)
    // ⑤ 目录名形状：peek 的 shots 目录必须落在 cachedMp4 认的 `<BV>-p<page>-` 前缀里（B16 的地基）
    must(shotsDirName('BV1aaaaaaaaa', 2) === 'BV1aaaaaaaaa-p2-shots', `shots 目录名是 ${shotsDirName('BV1aaaaaaaaa', 2)}`)
    must(framesDirName('BV1aaaaaaaaa', 2, '5s') === 'BV1aaaaaaaaa-p2-5s', `frames 目录名是 ${framesDirName('BV1aaaaaaaaa', 2, '5s')}`)
    must(framesDirName('BV1aaaaaaaaa', 2, 'at-1p-abcdef12') === 'BV1aaaaaaaaa-p2-at-1p-abcdef12', 'at 目录名形状不对')
    return `manifest 往返 ok；坏/缺 manifest → null；等他人 ${w.polls} 次命中、超时 ${w.n} 次返回 null；${list.length} 张 jpg；目录名形状对`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('C88 抢锁放锁真跑：抢不到不放别人的锁、owner 校验、过期锁可接管、TTL 每次现取', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c88-'))
  try {
    const dir = join(tmp, 'd')
    ensureDir(dir)
    let ttlSeen = 7
    // TTL 传的是**取值函数**：每次抢锁现取，改配置下一把生效。
    // 7 这个值只用来证明「真的现取」——验证完**立刻**升到 60 秒再往下跑。
    //   （2026-11-01 0.4.1 第 12 条：原来整个用例都是 7，于是 ①「主人还活着就抢不到」变成了
    //    与调度赛跑——Windows 上读一次锁 + pidAlive 就可能超过 7ms，锁被判过期接管，
    //    l2 不为 null，断言随机红。这不是被测代码的 bug，是用例自己埋的定时炸弹。）
    const locks = makeLocks({ ttlMs: () => ttlSeen })
    // tryLockSync 是同步版（tryLock 是 async，见下面的子进程探针）
    const lTtl = locks.tryLockSync(dir)
    must(lTtl && lTtl.f, '验证 TTL 现取的那把锁没抢到')
    must(JSON.parse(readFileSync(lTtl.f, 'utf8')).ttlMs === 7, `锁体里的 ttl 是 ${JSON.parse(readFileSync(lTtl.f, 'utf8')).ttlMs}，应是现取的 7`)
    locks.unlock(lTtl)
    must(!existsSync(lTtl.f), '验证 TTL 的那把锁解不掉')
    // 往下全程用一个不可能在本次运行里过期的 TTL：这些用例要验的是 owner/接管判据，不是超时
    ttlSeen = 60000
    const l1 = locks.tryLockSync(dir)
    must(l1 && l1.f, '第一次抢锁失败')
    must(existsSync(l1.f), '抢到锁但锁文件不在')
    const body = JSON.parse(readFileSync(l1.f, 'utf8'))
    must(body.ttlMs === 60000, `锁体里的 ttl 是 ${body.ttlMs}，应是升上去的 60000（TTL 不是现取的）`)
    must(body.owner === l1.owner, '锁体 owner 与返回值不一致')
    must(Number.isInteger(body.pid) && body.pid > 0, '锁体里没有合法 pid')
    // ① 主人还活着 → 抢不到，且**不能删掉别人的锁**（A-1 的正身）
    const l2 = locks.tryLockSync(dir)
    must(l2 === null, '同一目录第二次抢锁成功了——两个进程都以为持锁')
    must(existsSync(l1.f), '抢不到锁时把主人的锁删了——第三个进程会挤进来')
    must(JSON.parse(readFileSync(l1.f, 'utf8')).owner === l1.owner, '抢不到锁时锁的持有者被换掉了')
    // ② owner 校验：拿别人的 owner 去 unlock 不许删（X-13：老主人退出时会删掉新主人的锁）
    locks.unlock({ f: l1.f, owner: 'someone-else' })
    must(existsSync(l1.f), '用别人的 owner 解锁把锁删了')
    // ③ 自己的 owner 才能解
    locks.unlock(l1)
    must(!existsSync(l1.f), '正确的 owner 解锁后锁还在')
    const l1b = locks.tryLockSync(dir)
    must(l1b, '解锁之后还抢不到锁')
    locks.unlock(l1b)
    // ④ 过期锁可接管：写一个「主人已死」的锁（pid 不存在）
    const dead = join(dir, '.lock')
    writeFileSync(dead, JSON.stringify({ pid: 2147483646, at: Date.now(), ttlMs: 60000, owner: 'ghost' }), 'utf8')
    const l3 = locks.tryLockSync(dir)
    must(l3 && l3.f === dead, '主人已死的锁没被接管')
    must(JSON.parse(readFileSync(dead, 'utf8')).owner === l3.owner, '接管后锁的持有者没换成新主人')
    locks.unlock(l3)
    // ⑤ TTL 是现取的：改了取值函数，下一把锁就带新值
    //   这里也不用毫秒级的值——同一个道理，用例不该自己埋「读一次就过期」的雷。
    ttlSeen = 45000
    const l4 = locks.tryLockSync(dir)
    must(l4 && JSON.parse(readFileSync(l4.f, 'utf8')).ttlMs === 45000, 'TTL 不是现取的（改配置后仍写旧值）')
    locks.unlock(l4)
    // ⑥ 异步那半截（tryLock 会 sleep 重试）另起进程真跑——check() 回调是同步的（C77）
    const probe = spawnSync(process.execPath, [join(HERE, 'fixtures', 'lock-probe.mjs')], {
      encoding: 'utf8', timeout: 60000,
    })
    must(probe.status === 0, `锁探针退出码 ${probe.status}：${String(probe.stderr || '').slice(0, 300)}`)
    let w
    try {
      w = JSON.parse(String(probe.stdout || ''))
    } catch {
      throw new Error(`锁探针输出不是 JSON：${String(probe.stdout || '').slice(0, 300)}`)
    }
    must(w.gotLock && w.fExists, `异步抢锁失败：${JSON.stringify(w)}`)
    must(w.secondIsNull === true, '异步版第二次抢锁成功了——两个进程都以为持锁')
    must(w.lockStillThere === true, '异步版抢不到锁时把主人的锁删了')
    must(w.afterUnlockGone === true, '异步版解锁后锁还在')
    must(w.reLock === true, '异步版解锁之后抢不到锁')
    must(w.takeOver === true, '异步版没接管主人已死的锁')
    return '抢到/抢不到/owner 校验/过期接管/TTL 现取/同步与异步版 都对'
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── C89：三稿复制提示词（正文逐字节一致 + 按钮位置 + 不带内部东西）──────
// 验收口径是「把三个按钮实际复制出的文本各贴一份原样出来」——靠人眼比不行，
// 改成可执行断言：把 client.js 里 `const COPY_XXX = String.raw`...`` 当浏览器里那样求值，
// 与基准文件（`tools/fixtures/copy-texts.md`）里的三个代码块逐字节比。
// 任何人改了稿子忘了同步、或改坏了转义，这条都会红。
check('C89 三稿复制提示词：正文与基准文件逐字节一致、三稿互斥、按钮在对应区块、无内部编号', () => {
  const cli = read('client.js')
  const names = ['COPY_DEPS', 'COPY_ASR', 'COPY_PANEL']
  const texts = {}
  for (const n of names) {
    const m = cli.match(new RegExp('const ' + n + ' = String\\.raw`([\\s\\S]*?)`'))
    must(m, `client.js 里找不到 ${n}`)
    // 与浏览器等价：String.raw 保反斜杠（正文里有 .venv-asr\\Scripts\\python.exe，
    // 普通模板字符串会把 \\S 吃掉），${ORIGIN} 照样插值。
    texts[n] = new Function('ORIGIN', `return String.raw\`${m[1]}\``)('{{ORIGIN}}')
  }
  // ① 与基准文件逐字节一致
  //   2026-11-01 0.4.1 第 12 条（一）：原来文件不在时只往 mdNote 写一句「跳过」就继续，整条仍 PASS。
  //   这是 C89 自己犯的毛病——判据依赖仓库外的文件时，**要么红要么 skip，不许静默通过**。
  //   2026-11-01 0.4.1 第 12 条（二，用户拍板）：基准从仓库外搬进 `tools/fixtures/copy-texts.md`。
  //   原来那条路径指向工作区里的审查记录（在仓库外），vendor 出去或 CI 上
  //   必然缺、必然红；更根本的是，断言的价值在于「期望值独立于被测代码」，基准只在
  //   我这台机器上，等于这条断言对外不存在。
  //   基准不进 npm 包（`tools/` 不在 package.json 的 files 里），发布出去的是 client.js 里的正身。
  const mdPath = join(HERE, 'fixtures', 'copy-texts.md')
  must(existsSync(mdPath),
    `基准文件不在：${mdPath} —— 逐字节比对这一项没做，不能算过（它随仓库走，缺了说明 checkout 不完整）`)
  const mdBlocks = [...readFileSync(mdPath, 'utf8').matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1])
  must(mdBlocks.length === 3, `基准文件里代码块是 ${mdBlocks.length} 个，应为 3 个`)
  names.forEach((n, i) => {
    must(texts[n] === mdBlocks[i],
      `${n} 与基准文件第 ${i + 1} 段不一致（${texts[n].length} B vs ${mdBlocks[i].length} B）——正文改了要同步`)
  })
  const mdNote = '三段都与基准文件逐字节一致'
  // ② 三稿互斥：症状不同，正文不能雷同（雷同＝三稿当一份用，正是要防的坑）
  must(texts.COPY_DEPS !== texts.COPY_ASR, '稿一与稿二正文一样')
  must(texts.COPY_DEPS !== texts.COPY_PANEL, '稿一与稿三正文一样')
  must(texts.COPY_ASR !== texts.COPY_PANEL, '稿二与稿三正文一样')
  // 每稿都写清自己只管一种症状
  must(texts.COPY_DEPS.includes('依赖装不上'), '稿一没写清症状是「依赖装不上」')
  must(texts.COPY_ASR.includes('转写'), '稿二没写清症状是「转写」')
  must(texts.COPY_PANEL.includes('面板打不开'), '稿三没写清症状是「面板打不开」')
  // ③ 报告格式五段都在（用户拿它去问人，格式是功能的核心）
  for (const n of names) {
    for (const k of ['现象：', '环境：', '日志片段：', '已排查项：', '怀疑点：']) {
      must(texts[n].includes(k), `${n} 少了报告格式里的「${k}」`)
    }
    must(texts[n].includes('不要修改任何文件'), `${n} 没写「不要修改任何文件」——只读边界丢了`)
  }
  // ④ 不能带内部编号 / 内部词 / HTML 标签（这是给用户看的正文）
  //    HTML 标签用**白名单**判，不能用「<后面跟个字母」这种宽判——
  //    正文里本来就有 <DSH 主目录>、<转写 python> 这类中文占位符，宽判会误报（第一版就误报过一次）。
  const HTML_TAG = /<\/?(div|span|br|p|b|i|u|em|strong|code|pre|script|style|html|body|a|img|table|tr|td|th|ul|ol|li|h[1-6]|input|button|form|iframe)\b/i
  for (const n of names) {
    must(!HTML_TAG.test(texts[n]), `${n} 里混进了 HTML 标签`)
    must(!/\bC\d{2}\b|\bE[1-8]-\d+\b|台账|切片|断言|verify\.mjs/.test(texts[n]),
      `${n} 里混进了内部编号或内部说法`)
  }
  // ⑤ 面板地址不写死：必须是 ${ORIGIN} 占位，且不许出现硬编码端口
  for (const n of names) {
    must(texts[n].includes('{{ORIGIN}}'), `${n} 里没有 {{ORIGIN}} 占位`)
    must(!/127\.0\.0\.1:\d+|localhost:\d+/.test(texts[n]), `${n} 里写死了面板地址`)
  }
  must(cli.includes("const ORIGIN = (typeof window !== 'undefined'"), 'client.js 里没有 ORIGIN 常量')
  must(cli.includes('window.location.origin'), 'ORIGIN 没取 window.location.origin')
  // ⑥ 按钮位置：稿一稿二在「遇到问题」区，稿三在「面板打不开」区（结构建议）
  const secDeps = cli.slice(cli.indexOf("'遇到问题'"), cli.indexOf("'面板打不开'"))
  const secPanel = cli.slice(cli.indexOf("'面板打不开'"), cli.indexOf("'抽帧缓存'"))
  must(secDeps.includes('text: COPY_DEPS') && secDeps.includes('text: COPY_ASR'),
    '稿一稿二的按钮不在「遇到问题」区里')
  must(!secDeps.includes('text: COPY_PANEL'), '稿三的按钮混进了「遇到问题」区')
  must(secPanel.includes('text: COPY_PANEL'), '稿三的按钮不在「面板打不开」区里')
  must(cli.indexOf("'遇到问题'") > cli.indexOf("'运行依赖'"), '「遇到问题」区跑到「运行依赖」区前面了')
  must(cli.indexOf("'遇到问题'") < cli.indexOf("'抽帧缓存'"), '「遇到问题」区跑到「抽帧缓存」区后面了')
  // 按钮标签必须是**症状本身**，三稿不能同名 ——
  //   原话：「统一叫『复制排查提示词』等于把三稿当一份用，正是参考实现踩过的坑」。
  //   这条单列，是因为它不在正文里（正文一致也救不了它），扰动测试实测漏过一次。
  const labels = [...cli.matchAll(/h\(CopyButton, \{ text: COPY_\w+, label: '([^']+)' \}\)/g)].map((m) => m[1])
  must(labels.length === 3, `CopyButton 按钮是 ${labels.length} 个，应为 3 个`)
  must(new Set(labels).size === 3, `三个按钮的标签重了：${JSON.stringify(labels)}——标签必须写清症状`)
  must(!labels.some((l) => l.includes('排查提示词')),
    `按钮标签用了笼统的「排查提示词」：${JSON.stringify(labels)}——要写症状本身`)
  // ⑦ 复制走 navigator.clipboard.writeText(text)，不许塞 HTML
  must(cli.includes('navigator.clipboard.writeText(text)'), 'CopyButton 没走 navigator.clipboard.writeText(text)')
  must(!/writeText\(\s*<[a-zA-Z/]/.test(cli), 'CopyButton 往剪贴板里塞了 HTML')
  must(cli.includes('复制失败'), 'CopyButton 失败时不提示「复制失败」')
  return `${mdNote}；三稿互斥；五段格式齐全；无内部编号与 HTML；地址用 {{ORIGIN}}；按钮分区正确`
})

// ── C90：三审抓出的三条 P0 的守卫（2026-10-31 三审）──────────────────
// 这三条都是「verify 全绿但行为已经变了」的类型，所以每条都要能红：
//   ① code=null 被记成成功 → ok:true 且不写 last-error.json（被信号杀死的运行）
//   ② runsFile() 求值点外移 → 面板侧异常从 child.on('close') 里冒出来
//   ③ String(want) → 非法配置不再回退默认根，缓存根被建在 CWD 下
check('C90 三审三条 P0 的守卫：code=null 记失败、runsFile 惰性求值、非法缓存配置回退默认根', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c90-'))
  try {
    // ── ① code=null 必须记成失败，且写 last-error.json ──
    //  子进程被信号杀死时 Node 的 close 事件给的 code 就是 null（实跑 SIGKILL → code=null）。
    //  基线是解构默认 `code = 0`（只兜 undefined），所以 null 保持 null → ok=false。
    //  写成 `?? 0` 会把 null 兜成 0 → ok=true，且 last-error.json 不写 ——
    //  用户事后排查「这条视频坏在哪」时最需要的那份现场文件没了。
    const bv = 'BV1aaaaaaaaa'
    const vidDir = join(tmp, 'videos', bv)
    mkdirSync(vidDir, { recursive: true })
    const runsPath = join(tmp, 'runs.jsonl')
    const entryNull = logRun(runsPath, { command: 'peek', bv, argv: ['peek', bv], code: null, ms: 5, stderr: 'killed' },
      { videoDirOf: (b) => (b === bv ? vidDir : null) })
    must(entryNull.ok === false, `code=null 被记成成功（ok=${entryNull.ok}）——被信号杀死的运行会被当成没出错`)
    must(entryNull.code === null, `code 被改写了：${JSON.stringify(entryNull.code)}，基线语义应是 null`)
    must(existsSync(join(vidDir, 'last-error.json')), 'code=null 时没写 last-error.json——失败现场丢了')
    // code=undefined 仍兜成 0（解构默认的老语义）
    const entryUndef = logRun(runsPath, { command: 'peek', bv: '', argv: [], code: undefined, ms: 1 })
    must(entryUndef.code === 0 && entryUndef.ok === true, `code=undefined 没兜成 0：${JSON.stringify(entryUndef)}`)
    // code=0 成功；code 非 0 失败
    const entryOk = logRun(runsPath, { command: 'peek', bv: '', argv: [], code: 0, ms: 1 })
    must(entryOk.ok === true, 'code=0 应当算成功')
    const entryBad = logRun(runsPath, { command: 'peek', bv: '', argv: [], code: 3, ms: 1 })
    must(entryBad.ok === false && entryBad.code === 3, `code=3 应当算失败：${JSON.stringify(entryBad)}`)
    // 兜底语义要逐字对基线：argv / ms 也只兜 undefined，不兜 null。
    //   ⚠ signal **不列在这里**：基线是 `signal = null`，而 `?? null` 与「只兜 undefined」
    //   对 undefined/null/字符串三种输入的结果完全相同 —— 两种写法语义等价，
    //   写断言判它等于判一个恒真的式子（扰动测试实测：改回 `?? null` 时 C90 不红）。
    //   这正是「断言自己也得被扰动一次」的又一例。
    //   version 也不列：基线是模块常量 `version: PLUGIN_VERSION`，**没有解构默认**，
    //   lib 里的 `?? ''` 是新引入的兜底，不属「搬迁偏差」，按基线语义判它是错的。
    const e2 = logRun(runsPath, { command: 'x', argv: null, ms: null })
    must(e2.argv === null, `argv=null 被兜成 ${JSON.stringify(e2.argv)}——基线解构默认不兜 null`)
    must(e2.ms === null, `ms=null 被兜成 ${JSON.stringify(e2.ms)}——基线解构默认不兜 null`)

    // ── ② runsFile() 必须惰性求值（求值点在 logRun 的 try 内部）──
    //  基线是在 logRun 内部（try 里）调 runsFile() 求值的，那个函数会走 ensureCache()，
    //  缓存根没初始化时**会抛**；基线把它包在 try 里 → 抛了只是日志写不进去，插件继续跑。
    //  把它变成实参后求值点跑到调用点（try 之外）→ 面板侧 index.js 的
    //  runLogRecord → finish 没有 try，异常会一路冒到 child.on('close') 的回调里。
    let threw = false
    try {
      logRun(() => { throw new Error('缓存根尚未初始化') }, { command: 'peek', bv: '', argv: [], code: 0, ms: 1 })
    } catch (e) {
      threw = true
    }
    must(!threw, 'logRun 传惰性函数时抛了——求值点跑到 try 外面了，异常会冒到调用方')
    // 传字符串（求值点在调用点）时抛出来——这正是「求值点外移」的表现，用来对照
    let threwStr = false
    try {
      const p = (() => { throw new Error('缓存根尚未初始化') })()
      logRun(p, { command: 'peek', bv: '', argv: [], code: 0, ms: 1 })
    } catch (e) {
      threwStr = true
    }
    must(threwStr, '对照用例：字符串路径在调用点求值时本该抛出——说明 try 没兜住，对照失效')
    // 两个入口都必须传函数（不是传字符串）
    const idx = read('index.js')
    const look = read('tools/look.mjs')
    must(/logRun\(\s*runsFile\s*,/.test(idx), 'index.js 侧 logRun 没传惰性函数 runsFile')
    must(/logRun\(\s*runsFile\s*,/.test(look), 'tools/look.mjs 侧 logRun 没传惰性函数 runsFile')
    must(!/logRun\(\s*runsFile\(\)\s*,/.test(idx) && !/logRun\(\s*runsFile\(\)\s*,/.test(look),
      '还有入口在传 runsFile() 的求值结果——求值点又跑到 try 外面了')

    // ── ③ 非法缓存配置必须回退默认根，不许在 CWD 下建目录 ──
    //  基线：配置值直接当路径用 → 非字符串时 mkdirSync 抛 ERR_INVALID_ARG_TYPE
    //        → 被 pickCacheDir 的 catch 捕获 → 回退默认根。
    //  写成 String(want) 后 123 变成 '123'（合法字符串）→ 不抛 → 不回退
    //        → 缓存根被建在进程 CWD 下，用户的视频缓存被写到别处，且无告警。
    for (const bad of [123, { x: 1 }, ['a'], true]) {
      const got = resolveCacheDir(bad)
      must(got === defaultCacheRoot(),
        `配置值 ${JSON.stringify(bad)} 算出的缓存根是 ${got}，应是默认根 ${defaultCacheRoot()}`)
      must(!/[\\/](123|true|a|\[object Object\])$/.test(got),
        `配置值 ${JSON.stringify(bad)} 把缓存根算成了 ${got}`)
    }
    // 字符串配置照旧生效（别把正常用法也堵死）
    must(resolveCacheDir('D:\\some\\where') === 'D:\\some\\where\\bili-watch-cache'
      || resolveCacheDir('D:\\some\\where') === 'D:\\some\\where',
      `字符串配置没照旧生效：${resolveCacheDir('D:\\some\\where')}`)
    must(resolveCacheDir('') === defaultCacheRoot(), '空字符串应落回默认根')
    must(resolveCacheDir(undefined) === defaultCacheRoot(), 'undefined 应落回默认根')
    // 真跑 pickCacheDir：非法配置下必须落回默认根，且**不许在 CWD 下留下目录**。
    // 注意：这里 fallback 期望是 null——因为归一后 want 直接变成空串，
    // 于是「没配过用户目录」这条路径正常走默认根，**根本不需要回退**。
    // （基线是靠「非法值抛错 → catch 回退」绕了一圈；现在是把非法值当没配，更直接。
    //   两者落点相同，差别只在有没有那条「已回退到…」的告警——
    //   非法配置从来不是真配过，不该报「回退」，所以 null 才是对的。）
    const cwdBefore = readdirSync(process.cwd()).length
    const picked = pickCacheDir(123)
    must(picked.dir === defaultCacheRoot(), `pickCacheDir(123) 落到了 ${picked.dir}，应落回默认根`)
    const cwdAfter = readdirSync(process.cwd()).length
    must(cwdAfter === cwdBefore, `CWD 下多了/少了目录（${cwdBefore} → ${cwdAfter}）——缓存根被建到 CWD 了`)
    return 'code=null 记失败且写 last-error.json；runsFile 惰性求值不外抛；非法缓存配置回退默认根且 CWD 干净'
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── C91：lib 的导出在两个入口里不许有「第二份逻辑」（2026-10-31 三审）──────────
// C69 只查「同名顶层 function」——但搬完之后剩下的薄壳大多是
//   `const jget = (url, headers, timeoutMs) => jgetRaw(url, {...})` 这种**箭头函数形式**，
//   C69 看不见它们。搬走的东西在入口里留一份真逻辑 = 两处判据（E6-02 的老坑）。
// 所以这条补上：lib 的每一个导出名，在 index.js / tools/look.mjs 里如果还出现，
//   那个出现必须是**纯委托或纯参数注入**——不许有分支、循环、自己的判据。
// 这条是三审自查时写的：先手工跑了一遍（_临时/check-second-impl.mjs），
//   21 处命中全是薄壳（判据太粗的假阳性），逐个看过确认没有第二份逻辑。
check('C91 lib 的导出在两个入口里只有纯委托薄壳：没有第二份逻辑实现', () => {
  const libFiles = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs'))
  const exportsOf = new Map()
  for (const f of libFiles) {
    const s = read(join('lib', f))
    for (const m of s.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) exportsOf.set(m[1], f)
    for (const m of s.matchAll(/^export const ([A-Za-z0-9_]+)/gm)) exportsOf.set(m[1], f)
  }
  must(exportsOf.size > 40, `lib 只导出 ${exportsOf.size} 个，扫面不对`)
  // 剥注释：注释里出现同名不算实现（标准第六章「某函数被调用的断言必须先剥注释」）
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  // 纯委托：箭头函数或 function，体内只有一次 lib 调用 + 参数转发
  const PURE = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_]+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*[A-Za-z0-9_]+\w*\(([^)]*)\)\s*;?\s*$/
  const PURE_FN = /^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(([^)]*)\)\s*\{\s*return\s+[A-Za-z0-9_]+\w*\(([^)]*)\)\s*;?\s*\}\s*$/
  const entries = ['index.js', 'tools/look.mjs']
  let shells = 0
  const bad = []
  for (const file of entries) {
    const lines = strip(read(file)).split('\n')
    for (const [name, libFile] of exportsOf) {
      const re = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|function|async function)\\s+${name}\\b`)
      const idx = lines.findIndex((l) => re.test(l))
      if (idx < 0) continue
      // 收集定义体：括号配平，最多 12 行
      const body = []
      let depth = 0
      for (let k = idx; k < Math.min(lines.length, idx + 12); k++) {
        body.push(lines[k].trim())
        for (const ch of lines[k]) {
          if (ch === '(' || ch === '{' || ch === '[') depth++
          else if (ch === ')' || ch === '}' || ch === ']') depth--
        }
        if (depth <= 0 && k > idx) break
      }
      const text = body.join(' ').replace(/\s+/g, ' ')
      if (PURE.test(text) || PURE_FN.test(text)) { shells++; continue }
      // 不是纯委托：允许「参数注入型」——体内只有 lib 调用 + 字面量/配置表达式，没有分支与判据
      // 判据：出现 if / for / while / switch / try / catch / return（除纯委托那行）就算有逻辑
      const hasLogic = /\b(if|for|while|switch|try|catch)\b/.test(text)
      if (hasLogic) {
        // 白名单：**只豁免「把 lib 返回的结构化 problem 变成用户能看的告警」这一句**，
        //   不是豁免整个函数 —— 白名单写成整函数豁免时，把它改成真逻辑也不会红（扰动实测）。
        //   lib 不产文案（lib/config.mjs 头注释明写），所以这句必须留在调用方。
        const ALLOW = {
          'index.js:readJsonOrBackup': {
            why: '调 lib/config.mjs 的 readJsonOrBackupRaw 取 {value,problem}，'
              + '再用 pushWarn 把 problem 变成面板告警——lib 只返回结构化 problem，文案归调用方',
            // 白名单只认「除这一句 if 之外没有别的分支」：函数里只许有这一个 if
            allowIfCount: 1,
            // 且**必须仍然调 lib**：把它换成自己解析 JSON 就是第二份实现，
            // 而 if 数量不变 —— 只判分支数会漏（扰动实测过）。
            mustCall: /readJsonOrBackupRaw/,
          },
        }
        const key = `${file}:${name}`
        const rule = ALLOW[key]
        if (rule) {
          const ifCount = (text.match(/\bif\b/g) || []).length
          const otherLogic = /\b(for|while|switch|try|catch)\b/.test(text)
          const callsLib = rule.mustCall ? rule.mustCall.test(text) : true
          if (ifCount <= rule.allowIfCount && !otherLogic && callsLib) { shells++; continue }
          bad.push(`${file}:${idx + 1} ${name}（lib/${libFile}）→ 白名单只允许 ${rule.allowIfCount} 个 if`
            + `${otherLogic ? '，还有循环/try' : ''}${callsLib ? '' : '，且没调 lib（自己实现了）'}：${text.slice(0, 120)}`)
          continue
        }
        bad.push(`${file}:${idx + 1} ${name}（lib/${libFile}）→ ${text.slice(0, 120)}`)
      } else shells++
    }
  }
  must(bad.length === 0, `lib 的导出在入口里有第二份逻辑：\n  ${bad.join('\n  ')}`)
  return `lib 导出 ${exportsOf.size} 个；两个入口里 ${shells} 处同名，全是纯委托/参数注入薄壳，没有第二份逻辑`
})

// ── C92：复制按钮点下去真会调 writeText ──────────────────────────────────────
// 这一版的验收缺口是「真点一下按钮看剪贴板」。无头浏览器进不去 DSH（要 token），
// 人点一次只验当次。但「点了没反应」这个失败模式只有三种成因，三种都能静态断：
//   ① button 没绑 onClick —— 不报错、点了什么都不发生
//   ② writeText 收到的不是那段文本 —— 复制到空的或别的东西
//   ③ clipboard 不可用时静默 return —— 用户以为复制了
// 另：h 若不是 React.createElement，onClick 这个 key 根本不会被识别（同 ① 的症状）。
check('C92 复制按钮：button 绑了 onClick、writeText 收到 props.text、不可用与失败都上屏', () => {
  const cli = read('client.js')
  must(/const h = React\.createElement/.test(cli),
    'client.js 的 h 不是 React.createElement —— 传进去的 onClick 不会被识别，点了没反应')
  const start = cli.indexOf('function CopyButton(')
  must(start > 0, 'client.js 里找不到 function CopyButton')
  const end = cli.indexOf('\n    function ', start + 10)
  must(end > start, '找不到 CopyButton 的结尾（下一个 4 空格缩进的 function）')
  const body = cli.slice(start, end)
  must(/function CopyButton\(\{\s*text\b/.test(body), 'CopyButton 的 props 里没有 text')
  must(/h\('button',\s*\{[^}]*onClick/.test(body),
    'CopyButton 里的 button 没有 onClick —— 点了没反应，且不报错')
  must(/navigator\.clipboard\.writeText\(\s*text\s*\)/.test(body),
    'writeText 收到的不是 props.text（复制到的东西和按钮标签对不上）')
  must(/typeof navigator\.clipboard\.writeText !== 'function'/.test(body),
    '没检查 writeText 是否存在')
  must(/throw new Error/.test(body),
    'clipboard 不可用时没有 throw —— 会变成「点了没反应」')
  must(/setStatus\('fail'\)/.test(body), "catch 里没有 setStatus('fail') —— 失败了用户看不见")
  must(/'data-bl-bad'/.test(body), '没有渲染「复制失败」的节点')
  // 三稿各要有一个按钮真用上（漏挂一个 = 那种症状的用户没得点）
  for (const [n, label] of [['COPY_DEPS', '依赖装不上'], ['COPY_ASR', '转写/OCR 失败'], ['COPY_PANEL', '面板打不开']]) {
    must(cli.includes('text: ' + n), `没有哪个 CopyButton 用到 ${n}`)
    must(cli.includes(`label: '${label}'`) || cli.includes(`label: '${label} / 点了没反应'`),
      `${n} 的按钮标签里没有「${label}」——用户看不出该点哪个`)
  }
  return 'h=createElement；onClick 已绑；writeText(text)；不可用 throw、失败上屏；三稿各一个按钮且标签写症状'
})

// ── C93：凭证「降级到旧位置」这条路必须留痕（P0-1，2026-11-01）───────────────────
// 现场：[cred] 提示绑在 a.moved 上时，于是「新位置写不了 → 退回用 deps/ 里那份旧凭证」
//   一句话都没有。用户以为自己用的是刚在本插件里扫的凭证，实际用的是发布包里别人的。
// 判据：按「这次用的是不是新位置那份」而不是某一个分支，所以三条都真跑：
//   ① 写不了（$DSH_HOME/bili-watch 被一个同名文件占住）→ 必须说「写不了 / 仍用旧那份」；
//   ② 搬成了 → 必须说「已复制」，且文件真落到新位置；
//   ③ 两份都没有（正常路径）→ stderr 里不许出现 [cred]（否则污染逐字节比对的断言）。
// 另外钉一句「文案不许撒谎」：write-failed 现场不许出现「已复制」（基线 bc25a07 那句在这种现场是假话）。
// 只测 CLI 侧：面板侧（index.js resolveCredPath）基线本来就静默，靠 /status.credState 展示，
//   这条不代表要求面板也打 stderr。
// 只看 stderr：提示在网络请求之前就 write 出去了，所以断网/超时也不会让这条变红（rc 不断言）。
check('C93 凭证降级必须留痕：新位置写不了要说、搬成了要说、正常路径一个字不多（P0-1）', () => {
  const box = mkdtempSync(join(tmpdir(), 'bw-verify-c93-'))
  const cred = JSON.stringify({ sessdata: 's', bili_jct: 'j', buvid3: 'b3', buvid4: 'b4' })
  const run = (home, deps) => {
    const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'login', '--check'], {
      env: { ...process.env, DSH_HOME: home, BILI_WATCH_DEPS: deps },
      encoding: 'utf8',
      timeout: 60000,
    })
    return String(r.stderr || '')
  }
  const head = (s) => s.trim().slice(0, 300)
  try {
    // ① 新位置写不了：$DSH_HOME/bili-watch 是个文件，旧位置有一份好凭证
    const h1 = join(box, 'blocked'), d1 = join(box, 'deps1')
    mkdirSync(h1, { recursive: true })
    mkdirSync(d1, { recursive: true })
    writeFileSync(join(h1, 'bili-watch'), 'occupied')
    writeFileSync(join(d1, 'credential.json'), cred)
    const e1 = run(h1, d1)
    must(/\[cred\]/.test(e1),
      `新位置写不了时 stderr 没有 [cred] 提示——用户会用着别人的凭证还以为是自己扫的：${head(e1)}`)
    must(/写不了/.test(e1) && /旧位置/.test(e1),
      `提示没说清「写不了 / 这次仍在用旧位置那份」：${head(e1)}`)
    // 光「有话说」不够，还要「说的是真话」：write-failed 时根本没复制成功，
    //   基线(bc25a07)那句「已复制到 …」在这种现场是假话（/regress-check 2026-11-01 A/B 实测）。
    //   谁把两支文案合并回一句、或者把 moved 那句拿来复用，这条就红。
    must(!/已复制/.test(e1),
      `写不了时却说「已复制」——修了静默换来一句谎：${head(e1)}`)
    // 这里原来还有一条 `!existsSync(h1/bili-watch/credential.json)`，2026-11-01 复核（regress-check）
    //   指出它是**恒真**的：占位的 bili-watch 本身是个文件，下面永远不可能存在任何文件，永远不会红，
    //   不构成证据（E6-08 那种「结构在、没牙」）。已删——「说已复制就真在」由第②支的
    //   `existsSync(h2/bili-watch/credential.json)` 反向钉住，不需要这条空转的。

    // ② 搬成了：新位置可写、旧位置有凭证
    const h2 = join(box, 'okhome'), d2 = join(box, 'deps2')
    mkdirSync(h2, { recursive: true })
    mkdirSync(d2, { recursive: true })
    writeFileSync(join(d2, 'credential.json'), cred)
    const e2 = run(h2, d2)
    must(/\[cred\]/.test(e2) && /已复制/.test(e2), `迁移成功时没说「已复制」：${head(e2)}`)
    must(existsSync(join(h2, 'bili-watch', 'credential.json')),
      '提示说已复制，但新位置并没有那份文件')

    // ③ 正常路径：两份都没有 → 只该有「还没登录」，不许有 [cred]
    const h3 = join(box, 'clean'), d3 = join(box, 'deps3')
    mkdirSync(h3, { recursive: true })
    mkdirSync(d3, { recursive: true })
    const e3 = run(h3, d3)
    must(!/\[cred\]/.test(e3), `没有降级却打了 [cred]，正常路径被污染：${head(e3)}`)
    must(/还没登录|未登录/.test(e3), `没登录时没说「还没登录」：${head(e3)}`)
    return '写不了→说「写不了/仍用旧那份」且不许说「已复制」（文案不能撒谎）；搬成→说「已复制」且文件真在；无凭证→只有「还没登录」，无 [cred]'
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})

check('C95 「本机没装所以没跑」必须走 skip()，不许直接 return 说明串（否则算成 PASS）', () => {
  // 2026-11-01（P1-8）：C58 / C59 / C80 原来是「工具不在就 return 一句说明」。
  //   执行器收下那个字符串，记成一笔 **PASS** —— 「本机没跑」被算成「验过了」：
  //   通过数虚高，而且**越缺依赖的机器看起来越绿**（缺 python 的 CI 反而全过）。
  //   正解是 C55 的写法：先 skip() 记一笔（不算通过也不算失败），再 return。
  //
  //   这条守卫只扫一种形状：`if` 取反一个标识符之后直接跟 `return '...'`。
  //   多行形状（`if (!String(x).includes(...)) { return '...' }`）它扫不到 —— 那种要人看，
  //   C80 那处就是多行形状，是我手改的。
  //
  //   注意：正则在**全文**上跑，注释也算。所以本段注释里刻意不写出完整形状，
  //   以免这条守卫被自己命中（那种误报一眼能看出来，但没必要留个坑）。
  const src = read('tools/verify.mjs')
  const bad = []
  const re = /if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\s*\)\s*return\s*'/g
  let m
  while ((m = re.exec(src))) {
    bad.push(`:${src.slice(0, m.index).split('\n').length}（${m[1]}）`)
  }
  must(bad.length === 0, `这些行用裸 return 代替了 skip()：${bad.join('，')} —— 会把「本机没跑」算成通过`)
  return `裸 return 0 处（扫了 ${src.split('\n').length} 行）`
})

check('C96 白名单目录不按名字整棵删：里面出现用户的文件就不认领（P1-5）', () => {
  // 2026-11-01（P1-5）：`OWN_CACHE_DIRS.has(name)` 原来一票通过——**只看名字**。
  //   缓存根能被 BILI_WATCH_CACHE 指到任何目录（只要有我们的标记文件），用户在那种根下
  //   自建一个 frames/ 放素材，点「清除」就被整棵删。现在要求「顶层每个条目都像我们的产物」。
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c96-'))
  try {
    const root = join(tmp, 'cache')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'frames'), { recursive: true }) // 空目录：该认领（清 mkdir 空壳）
    mkdirSync(join(root, 'asr'), { recursive: true }) // 只有我们的产物
    writeFileSync(join(root, 'asr', 'BV1aa4111111.json'), '{}')
    writeFileSync(join(root, 'asr', '.lock'), '')
    mkdirSync(join(root, 'sheets'), { recursive: true })
    writeFileSync(join(root, 'sheets', 'a.png'), 'x')
    mkdirSync(join(root, 'frames', 'BV1aa4111111-p1-shots'), { recursive: true }) // 我们的子目录形状
    mkdirSync(join(root, '_hot'), { recursive: true }) // 用户自己的东西
    writeFileSync(join(root, '_hot', '工程文件.psd'), 'user')
    mkdirSync(join(root, '_misc'), { recursive: true })
    mkdirSync(join(root, '_misc', '我的素材'), { recursive: true })
    writeFileSync(join(root, '_misc', '我的素材', 'a.png'), 'x')

    must(isOwnedEntry(root, join(root, 'frames')) === true,
      '空的白名单目录没被认领 —— 那样 mkdir 留下的空壳永远清不掉')
    must(isOwnedEntry(root, join(root, 'asr')) === true,
      '只含我们产物（BV*.json + .lock）的目录没被认领 —— 正常清理会失效')
    must(isOwnedEntry(root, join(root, 'sheets')) === true,
      '只含 .png 的目录没被认领')
    must(isOwnedEntry(root, join(root, '_hot')) === false,
      '用户的 .psd 被当成我们的 —— 点「清除」会把用户文件整棵删掉（这条是 P1-5 的本体）')
    must(isOwnedEntry(root, join(root, '_misc')) === false,
      '用户的子目录（我的素材/）被当成我们的 —— 同上，整棵删')
    return '空目录/纯产物目录认领；含用户文件或用户子目录时不认领'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// ── C94：fetch-deps.sh 两处「判断反了」的 P2（2026-11-01，两条都本机复现过）──
//   ① `printf '%s\n' "$list" | grep -Eq …`：grep -q 一命中就退出，上游 printf 还在灌几千行
//      → SIGPIPE → pipefail 把整条管道判成 141 → `||` 把 miss 写上 →「官方静态包」被报成
//      「归档里没有 ffmpeg ffprobe」并 exit 1（本机实测命中场景 rc=141）。
//   ② `ver="$(… -version 2>&1 | sed -n '1p' || true)"`：2>&1 让 stderr 上的报错也算「有输出」，
//      `|| true` 又抹掉 ffmpeg 的退出码 —— 装坏了照样打 ✓（本机假 ffmpeg 复现）。
//   光看源码形状不够（缩进/引号一改就漏），这里按**真实顺序**真跑脚本：ffmpeg/ffprobe 在清单
//   前两行 + 6000 行填充（必须大于管道缓冲，printf 才写不完），解出来的 ffmpeg 用假脚本替身。
// C94（2026-11-01）：两处 P2。
//   ① 清单判断被 `printf … | grep -q` 的 SIGPIPE（141）打断 —— grep 命中即退出，
//      printf 写不完，pipefail 下整个脚本 141，判断结果反过来。
//   ② ffmpeg `-version` 那次真跑加了 `2>&1` —— stderr 上的报错被当成「有输出 = 成功」，
//      退出码又来自 sed/管道而不是 ffmpeg 本身。
//
//   2026-11-02（合一）**两条的形态都变了，逐条说明，不硬凑**：
//     ① node 里不拼 shell 管道，SIGPIPE 这一类不存在。所以改守「把它请回来的入口」：
//        `run()` 不许开 `shell: true`（一开，管道/重定向就回来了，141 与「退出码来自 sed」
//        就都回来了），清单判定必须是内存切片。
//     ② 这条**原样有效**，而且更该守：`run()` 返回的 `{code,out,err}` 三样分开，
//        判定只要写错成「out 非空就算成功」，stderr 一响就翻。所以既验源码只看 code，
//        也真跑一次「有 stdout 但退出码非 0」的反证。
check('C94 fetch-deps：清单判定不拼 shell 管道、ffmpeg 真跑只认它自己的退出码（P2 两条）', () => {
  const fd = read('scripts/fetch-deps.mjs')
  const codeLines = fd.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')

  // ① 不拼 shell：`shell: true` 是唯一能把管道/重定向请回来的开关
  const runBody = fnBody(fd, 'run')
  must(!/shell\s*:\s*true/.test(runBody),
    'run() 开了 shell:true —— 管道/重定向一回来，SIGPIPE(141) 和「退出码来自 sed 而不是 ffmpeg」就都回来了')
  // 清单判定必须是内存切片（不是外部命令的输出截断）
  must(/list\.out\.split\(/.test(fd) && /slice\(0, 10\)/.test(fd),
    '归档清单不是「内存里 split 再 slice(0,10)」——诊断可能被外部工具打断或截断')

  // ② 只认 ffmpeg 自己的退出码
  const verIdx = fd.indexOf("['-version']")
  must(verIdx > 0, "找不到 -version 那处真跑（findFfmpeg / ensureFfmpeg 的结构变了？）")
  const seg = fd.slice(verIdx, verIdx + 800)
  must(/v\.code\s*!==\s*0/.test(seg), '-version 的判定没看退出码（v.code !== 0）—— 按「有输出=成功」判迟早翻')
  must(!/2>&1/.test(codeLines), '代码里又出现 2>&1：stderr 被并进 stdout 后，「有输出」就不等于「跑得起来」了')

  // ③ 真跑反证：**有 stdout 输出、但退出码非 0** —— 必须判失败。
  //   这是 ② 的唯一有力证明：源码里写着 v.code 也可能被改成 `!v.out`，只有反证照得出来。
  const p = fdProbe('ffmpeg-version', { BW_PROBE_VER_CODE: '1' })
  try {
    const out = p.out()
    must(/^PROBE_RESULT=throw:/m.test(out),
      `-version 打了一行版本、却以非 0 退出时必须判失败（按「有输出=成功」就漏了）：${out.slice(0, 400)}`)
  } finally { rmSync(p.dir, { recursive: true, force: true }) }
  return 'run() 无 shell:true；清单走内存切片；-version 只看 v.code 且无 2>&1；反证：有 stdout 但 rc≠0 必判失败'
})

// —— 延迟异步检测（2026-11-01，P1-6）——
//
//   C77 的 thenable 守卫只看 `fn()` 的**返回值**：`check('X', async () => …)` 返回 Promise，拦得住。
//   但这一种拦不住：回调**同步返回 undefined**，异步体是它自己起的——
//       check('X', () => { setTimeout(() => { must(false, '…') }, 0) })
//   异步体在 check() 返回之后才跑：它记的结果要么赶在汇总之前（偶发、看运气），要么赶不上
//   （永远不显示）；里面要是抛错，直接 uncaughtException 把进程带走，一条汇总都不打。
//
//   做法照第二个选项：汇总之前让出两轮事件循环（setImmediate + setTimeout 0），
//   把排队的任务放完，期间任何 unhandledRejection / uncaughtException 都记成 FAIL。
//   判据是「两轮之后有没有新结果冒出来 / 有没有异常」，不去猜是哪条断言起的异步。
//
//   为什么是两轮：setImmediate 走 check 阶段，setTimeout(0) 走 timers 阶段，
//   两者之间还夹着 Promise 微任务队列 —— 一轮放不干净。
{
  let lateErr = null
  const onLate = (e) => { if (!lateErr) lateErr = e }
  process.on('unhandledRejection', onLate)
  process.on('uncaughtException', onLate)
  const beforeDrain = results.length
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 0))
  const afterDrain = results.length
  process.off('unhandledRejection', onLate)
  process.off('uncaughtException', onLate)

  if (afterDrain !== beforeDrain) {
    results.push({
      name: 'C77 延迟异步：断言不许在 check() 返回之后才记结果',
      ok: false,
      detail: `两轮事件循环之后又多出 ${afterDrain - beforeDrain} 条结果——有断言体在 check() 之外起了异步，它记的结论不受 summarization 管`,
    })
  }
  if (lateErr) {
    results.push({
      name: 'C77 延迟异步：断言体之外起的异步里抛了错',
      ok: false,
      detail: String((lateErr && lateErr.stack) || (lateErr && lateErr.message) || lateErr).split('\n')[0],
    })
  }
}

// ── C97：宿主太老时必须「抛」，不许「静默跳过」（2026-11-01 0.4.1 第 2 条）────────
// 原来的写法是给 MODULE_LOADER 一个空实现 + console.warn：本文件能加载完，但宿主照样报
//   `loaded without registering`——那句话指向**结果**（面板没注册），不指向**原因**（宿主 < 0.2.0-rc.2）。
// 断法：把 client.js 当浏览器脚本在假 window 里真求值（vm），必须抛那句带版本要求的话。
//   旧写法在这里会「走完整个文件且不抛」，所以这条能红——不是读源码里有没有 throw 两个字。
check('C97 宿主缺 window.__ModuleLoader__ 时 client.js 直接抛「需要 DSH ≥ 0.2.0-rc.2」，不许静默跳过', () => {
  const src = read('client.js')
  const sandbox = { window: {}, console: { warn() {}, log() {}, error() {} } }
  let err = null
  let finished = false
  try {
    vm.runInNewContext(src, sandbox, { timeout: 10000 })
    finished = true
  } catch (e) {
    err = e
  }
  must(!finished, '假 window（没有 __ModuleLoader__）里跑完了整个文件——fallback 又变回静默跳过了')
  const msg = String((err && err.message) || err)
  must(/DSH\s*≥\s*0\.2\.0-rc\.2/.test(msg), `抛的不是「宿主太老」这句：${msg.slice(0, 160)}`)
  must(/window\.__ModuleLoader__/.test(msg), `报错里没点名缺的是 window.__ModuleLoader__（用户据此才能搜到原因）：${msg.slice(0, 160)}`)
  return '假 window 下直接抛，报错点名「需要 DSH ≥ 0.2.0-rc.2」与缺失的 window.__ModuleLoader__'
})

// ── C98：ensure_venv 的**出口**也要验一次 import（2026-11-01 0.4.1 第 3 条）──────
// 入口验了（`if "$dir/bin/python" -c "import $mod"`），装完之后没有：pip 返回 0 就直接打 ✓。
// 空壳 venv、requires-python 不满足、wheel 落到别的解释器，这三种都是 install 成功、import 失败，
// 要等用户跑转写才炸，而且报的是「转写失败」，与「依赖没装上」隔了一层。
// 真跑：PATH 上放一个假 python3（建得出 venv、pip 一律 exit 0、只有 `-c "import …"` 的退出码可控）。
//   两个方向都跑——只跑失败那个方向的话，「脚本在别处提前退出」会被当成「拦住了」。
// C98（2026-11-01，P1）：pip 返回 0 不算装成。
//   原来 `pip install` 一返回 0 就打 ✓，但包可能「装了却 import 不了」
//   （requires-python 不满足、wheel 装上了但缺运行库、同名包冲突……）。
//   结果：脚本说装好了，转写时 ImportError，用户被绕一圈。
//   要求：装完必须再 import 一次；失败要把半成品改名留档，并说清「为什么 pip 成功还报错」。
//
//   2026-11-02（合一）：原判据真跑 .sh 并 grep 它的输出。现在探针把 pip 桩成返回 0、
//   把 `import` 桩成失败，走的是**原样的 ensureVenv**，断言落在「真的抛错 + 真的改名」上。
check('C98 pip 返回 0 不算装成，装完必须再 import 一次；失败要改名留档并说清原因', () => {
  const fd = read('scripts/fetch-deps.mjs')
  const body = fnBody(fd, 'ensureVenv')
  must(/import \$\{mod\}/.test(body), 'ensureVenv 装完没有再 import 一次 —— pip 返回 0 不等于装成')
  must(/moveSemiVenv\(venv\)/.test(body), 'ensureVenv 失败时没把半成品 venv 改名留档（下次会拿它当可用的）')
  must(/pip 返回 0 不算装成/.test(body), '文案没说清「pip 返回 0 不算装成」——用户会以为装好了')

  const p = fdProbe('venv-import')
  try {
    const out = p.out()
    must(/^PROBE_RESULT=throw:/m.test(out), `pip 成功但 import 失败时必须抛错（不能打 ✓）：${out.slice(0, 400)}`)
    must(/装完了但 import faster_whisper 仍然失败/.test(out), `没点名是哪个模块 import 失败：${out.slice(0, 400)}`)
    must(/pip 返回 0 不算装成/.test(out), `没解释「为什么 pip 成功了还报错」：${out.slice(0, 400)}`)
    must(/排查：/.test(out), `没给排查方向（用户只能反复重装）：${out.slice(0, 400)}`)
    // 落在文件系统状态上：改名这件事必须真发生，不能只打一行字
    must(p.kv('VIVID') === 'false', `半成品 venv 目录还在（没改名，下次会被当成可用的）：${out.slice(0, 300)}`)
    must(/\.venv-asr\.old-/.test(p.kv('OLDS')), `没生成 .venv-asr.old-* 留档：${JSON.stringify(p.kv('OLDS'))}`)
  } finally { rmSync(p.dir, { recursive: true, force: true }) }
  return 'ensureVenv 真跑：pip 返回 0 但 import 失败 → 抛错 + 点名模块 + 解释「pip 0 不算装成」+ 给排查方向 + 半成品真改名留档'
})

// ── C99：sheet 认 --at（2026-11-01 0.4.1 第 5 条）────────────────────────────
// frames 有 --at、sheet 没有：同一个「我只要这几秒的画面」的需求，两处得到两种结果。
// 断三件：① 调用点真把 --at 传下去（不传的话下面全绿也没意义）；
//        ② --at 模式按时刻取帧（f_12m30s.jpg），**不是** `${bv}-NN.jpg`；
//        ③ 索引里的秒数从文件名读，推不出就给 null（不许编 00:00）。
check('C99 sheet 认 --at：按时刻取帧、索引时间从文件名读、推不出留空', () => {
  const src = read('tools/look.mjs')
  const callLine = src.split('\n').find((l) => /cmdSheet\(BV, \{/.test(l)) || ''
  must(/at:\s*opt\('at'\)/.test(callLine), `sheet 的调用点没把 --at 传下去（用户敲了也不生效）：${callLine.trim().slice(0, 160)}`)
  must(/look\.mjs sheet <BV或链接>[^\n]*--at/.test(src), '--help 里的 sheet 用法没写 --at')
  // 两个纯函数真跑（与 look.mjs 里同一份源码；依赖用同名 prelude 注入）
  const prelude = `
    const frameList = (dir, bv) => { const out = []; for (let i = 1; i < 1000; i++) { const n = join(dir, bv + '-' + String(i).padStart(2, '0') + '.jpg'); if (!existsSync(n)) break; out.push(n) } return out }
    const framesToShow = (times, dirFiles) => Array.isArray(times) && times.length
      ? times.map((t) => 'f_' + Math.floor(t / 60) + 'm' + String(t % 60).padStart(2, '0') + 's.jpg')
      : dirFiles.filter((f) => f.startsWith('f_') && f.endsWith('.jpg')).sort()
  `
  const { sheetFrameFiles, frameSecOf } = compile(src, ['sheetFrameFiles', 'frameSecOf'], {
    prelude,
    params: ['join', 'basename', 'existsSync'],
    args: [join, basename, existsSync],
  })
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c99-'))
  try {
    writeFileSync(join(tmp, 'f_0m05s.jpg'), 'x')
    writeFileSync(join(tmp, 'f_12m30s.jpg'), 'x')
    const atFiles = sheetFrameFiles(tmp, 'BV1xx', '0:05,12:30', [5, 750], readdirSync(tmp))
    must(atFiles.length === 2 && atFiles.every((f) => /f_\d+m\d+s\.jpg$/.test(f)),
      `--at 模式没按时刻取帧（原来固定走 frameList，会直接「没抽到帧」）：${JSON.stringify(atFiles)}`)
    const partial = sheetFrameFiles(tmp, 'BV1xx', '0:05,9:99', [5, 5999], readdirSync(tmp))
    must(partial.length === 1, `请求了但不存在的时刻没被过滤（会拼进一个不存在的文件）：${JSON.stringify(partial)}`)
    writeFileSync(join(tmp, 'BV1xx-01.jpg'), 'x')
    writeFileSync(join(tmp, 'BV1xx-02.jpg'), 'x')
    const plain = sheetFrameFiles(tmp, 'BV1xx', '', null, readdirSync(tmp))
    must(plain.length === 2 && plain.every((f) => /BV1xx-\d\d\.jpg$/.test(f)),
      `普通模式的帧选择被改坏了（这是老路径，不该动）：${JSON.stringify(plain)}`)
    must(frameSecOf(join(tmp, 'f_12m30s.jpg'), 0, 0) === 750,
      '--at 的索引没从文件名读时间——会退回按 step 推，于是九宫格索引显示 00:00 / 00:02，与用户要的时刻不符')
    must(frameSecOf(join(tmp, 'BV1xx-02.jpg'), 1, 2) === 2, '普通模式按 step 推时间算错了')
    must(frameSecOf(join(tmp, 'BV1xx-02.jpg'), 1, 0) === null, '推不出时间时应该给 null（不许编一个 00:00 出来）')
    return '调用点传 at；--at 取 f_*m*s.jpg 并滤掉不存在的时刻；索引 750s；普通模式与推不出时的 null 都没变'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// ── C100：/cache/clear 的 skipped 要上屏（2026-11-01 0.4.1 第 6 条，E4-10）──────────
// 后端 index.js 的 /cache/clear 一直返回 data.skipped（「认出来不是本插件的、所以没删」），
// 前端只读 removed/bytes/failed。后果：面板说「缓存已清理」，用户去目录一看文件还在。
check('C100 /cache/clear 的 skipped 要上屏（E4-10）：有就点名原因，没有就一个字不多', () => {
  const src = read('client.js')
  must(/const keptNote = fmtSkippedNote\(d\)/.test(src),
    'saveCache 没调用 fmtSkippedNote —— 函数写在文件里没人用，等于没改')
  const { fmtSkippedNote } = compile(src, ['fmtSkippedNote'])
  must(fmtSkippedNote({}) === '', '没有 skipped 时不该多话（正常清理路径要保持安静）')
  must(fmtSkippedNote({ skipped: [] }) === '', 'skipped 是空数组时也不该多话')
  must(fmtSkippedNote(null) === '', 'data 缺失时崩了/多话了')
  const one = fmtSkippedNote({ skipped: [{ name: '我的视频.mp4', why: '不在白名单' }] })
  must(one.includes('我的视频.mp4') && one.includes('不在白名单'), `skipped 的文件名/原因没上屏：${one}`)
  must(one.includes('保留 1 项'), `没说清保留了几项（用户无法判断要不要自己动手删）：${one}`)
  const many = fmtSkippedNote({ skipped: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.mp4`, why: 'x' })) })
  must(many.includes('保留 6 项'), `总数不对（应报 6 项）：${many}`)
  must(/等 6 项/.test(many), `超过 3 个没收敛成「等 N 项」，会把对话框刷屏：${many}`)
  must(fmtSkippedNote({ skipped: ['纯字符串.mp4'] }).includes('纯字符串.mp4'), '老形状（字符串数组）会崩或不显示')
  return '空→静默；1 项点名原因；6 项收敛成「等 6 项」；字符串形状兼容'
})

// ── C101：verify.mjs 自己的 fnBody 也要认 export、也不吃注释（2026-11-01 0.4.1 第 7 条）──
// C79 只验了 verify-todo 那份。verify.mjs 这份原来用 `indexOf('function name(')`：
//   ① 认不出 `export function`（lib/ 下全是这个形状，抽不到就报「找不到函数」，
//      报错长得像「函数被删了」而不像「工具抽错了」）；
//   ② 会命中注释里的同名声明，抽出一段从注释切到下一个行首 `}` 的垃圾。
// 两个 fnBody 不统一（各抽各的文件，今天安全），所以这里是**第二份**自检，不是重复。
check('C101 verify.mjs 的 fnBody：认 export 前缀、不吃注释里的同名声明、返回值仍是纯 function', () => {
  const src = [
    '// function real(a) { 这是注释里的老实现，不许被取到',
    'export async function real(a) {',
    '  const x = 1',
    '  if (x) {',
    '    return a * 2',
    '  }',
    '}',
    'const after = 1',
  ].join('\n')
  const body = fnBody(src, 'real')
  must(/return a \* 2/.test(body), `抽到的不是真函数体：${JSON.stringify(body.slice(0, 80))}`)
  must(!/老实现/.test(body), '命中了注释里的同名声明（这条是 indexOf 那个洞的原样复现）')
  must(!/after/.test(body), '函数体吃过了行首闭合括号')
  // compile() 会把返回值直接包进 `new Function('return ( ... )')`，带 export 前缀就是语法错，
  // 所以这里必须从 `function` 起切。
  must(/^function /.test(body), `返回值不是以 function 开头（compile 会语法错）：${JSON.stringify(body.slice(0, 30))}`)
  let threw = ''
  try { fnBody(src, 'nope') } catch (e) { threw = String(e.message || e) }
  must(/找不到 function nope/.test(threw), `不存在的函数名没报「找不到」：${threw}`)
  return 'export async 认出且从 function 起切；注释同名不吃；不存在时报找不到'
})

// ── C102：deps 判据只有一份（2026-11-01 0.4.1 第 8 条）──────────────────────────
// 原来 index.js 与 tools/look.mjs 各写一份「用哪份 deps」，且**不是逐字相同**：
//   index 判「包内有内容」，look 判「包内目录存在」。干净安装（包内 deps 是空目录）时，
//   面板用包外、CLI 用包内 —— 装到哪、读哪个 venv，两边各说各话。版本号那份同理（只是路径差一层）。
// 这条断两件：① 两个入口都真走 lib（没有偷偷再算一份）；② lib 的五种场景判据对。
check('C102 deps 判据只有一份：两个入口都走 lib/plugin-paths.mjs，五种场景判据对', () => {
  const iSrc = read('index.js')
  const lSrc = read('tools/look.mjs')
  must(/resolveDepsDir\(\{ pluginRoot: HERE/.test(iSrc), 'index.js 没走 lib 的 resolveDepsDir（判据又分叉了）')
  must(/resolveDepsDir\(\{ pluginRoot: join\(HERE, '\.\.'\)/.test(lSrc), 'tools/look.mjs 没走 lib 的 resolveDepsDir')
  must(!/const DEPS = \(\(\) =>/.test(iSrc + lSrc), '还有入口在自己算 DEPS')
  must(!/PLUGIN_VERSION = \(\(\) =>/.test(iSrc + lSrc), '还有入口在自己读版本号')
  must(/readPluginVersion\(HERE\)/.test(iSrc) && /readPluginVersion\(join\(HERE, '\.\.'\)\)/.test(lSrc),
    '版本号没走 lib 的 readPluginVersion')
  const { resolveDepsDir } = compile(read('lib/plugin-paths.mjs'), ['depsPaths', 'resolveDepsDir'], {
    params: ['join', 'resolve', 'existsSync', 'readdirSync', 'mkdirSync', 'homedir'],
    // homedir 给个假值即可：下面每个场景都显式传 home，默认值只在不传时才求值
    args: [join, resolve, existsSync, readdirSync, mkdirSync, () => join(tmpdir(), 'bw-c102-nohome')],
  })
  const box = mkdtempSync(join(tmpdir(), 'bw-c102-'))
  try {
    const mk = (p) => { mkdirSync(p, { recursive: true }); return p }
    // ① 包内是空目录、包外没有 → 包外（这格就是原来两边分叉的地方，CLI 侧随之改了判据）
    const rootA = mk(join(box, 'a', 'pkg'))
    mk(join(rootA, 'deps'))
    const homeA = join(box, 'a', 'home')
    const eA = resolveDepsDir({ pluginRoot: rootA, env: { DSH_HOME: homeA }, home: homeA })
    must(eA === join(homeA, 'bili-watch', 'deps'), `包内空目录时没判包外（还是「存在即用」那套）：${eA}`)
    // ② 包内有内容 → 包内（老安装、用户把依赖装在包里，不能突然读不到）
    const rootB = mk(join(box, 'b', 'pkg'))
    mk(join(rootB, 'deps'))
    writeFileSync(join(rootB, 'deps', 'x.txt'), 'x')
    const homeB = join(box, 'b', 'home')
    must(resolveDepsDir({ pluginRoot: rootB, env: { DSH_HOME: homeB }, home: homeB }) === join(rootB, 'deps'),
      '包内有内容时没判包内（会让老用户的 venv / 模型突然失效）')
    // ③ 包外已存在 → 包外，且不覆盖
    const rootC = mk(join(box, 'c', 'pkg'))
    mk(join(rootC, 'deps'))
    writeFileSync(join(rootC, 'deps', 'x.txt'), 'x')
    const homeC = mk(join(box, 'c', 'home'))
    mk(join(homeC, 'bili-watch', 'deps'))
    must(resolveDepsDir({ pluginRoot: rootC, env: { DSH_HOME: homeC }, home: homeC }) === join(homeC, 'bili-watch', 'deps'),
      '包外已存在时没判包外')
    // ④ BILI_WATCH_DEPS 最高优先
    const rootD = mk(join(box, 'd', 'pkg'))
    mk(join(rootD, 'deps'))
    const explicit = join(box, 'd', 'custom')
    must(resolveDepsDir({ pluginRoot: rootD, env: { BILI_WATCH_DEPS: explicit }, home: join(box, 'd', 'home') }) === explicit,
      'BILI_WATCH_DEPS 没优先')
    // ⑤ 只有面板侧（mkdirPref）建目录；CLI 缺省不许有副作用
    const rootE = mk(join(box, 'e', 'pkg'))
    mk(join(rootE, 'deps'))
    const homeE = join(box, 'e', 'home')
    const eE = resolveDepsDir({ pluginRoot: rootE, env: { DSH_HOME: homeE }, home: homeE, mkdirPref: true })
    must(eE === join(homeE, 'bili-watch', 'deps') && existsSync(eE), 'mkdirPref=true 时没建出包外目录（面板首次启动写不进去）')
    const rootF = mk(join(box, 'f', 'pkg'))
    mk(join(rootF, 'deps'))
    const homeF = join(box, 'f', 'home')
    const eF = resolveDepsDir({ pluginRoot: rootF, env: { DSH_HOME: homeF }, home: homeF })
    must(eF === join(homeF, 'bili-watch', 'deps') && !existsSync(eF), 'CLI 侧（mkdirPref 缺省）也去建目录了——只读命令不该有副作用')
    return '两入口同走 lib；空包内→包外、有内容→包内、包外优先、BILI_WATCH_DEPS 优先、只有面板建目录'
  } finally { rmSync(box, { recursive: true, force: true }) }
})

// ── C103：两个入口不许有「同名不同物」的顶层定义（2026-11-01 0.4.1 第 9 条）──────
// 原来 index.js 有 `function depsCfg()`（每次调用读盘），tools/look.mjs 有 `const depsCfg = readDepsCfg()`
// （模块加载时的快照）。同名不同物 → 外部审查脚本看见 `depsCfg.cache` 以为是当前配置，
// 实际拿到的是快照；反过来看见 `depsCfg()` 以为是同一份对象。人也会这么读。
// 这条是通用闸：以后再有人把「函数」和「常量」用同一个名字分放两个入口，这里会红。
check('C103 两个入口没有同名异类的顶层定义（depsCfg 那种撞名会让外部审查脚本读错东西）', () => {
  const defs = (file) => {
    const s = read(file)
    const map = new Map()
    for (const m of s.matchAll(/^(?:export\s+)?function\s+([A-Za-z0-9_$]+)/gm)) map.set(m[1], 'function')
    for (const m of s.matchAll(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/gm)) if (!map.has(m[1])) map.set(m[1], 'const')
    return map
  }
  const a = defs('index.js')
  const b = defs('tools/look.mjs')
  must(a.size > 50 && b.size > 50, `扫面不对（顶层定义 index ${a.size} / look ${b.size}），正则失效了`)
  const clash = []
  for (const [name, kind] of a) {
    if (b.has(name) && b.get(name) !== kind) clash.push(`${name}（index=${kind} / look=${b.get(name)}）`)
  }
  must(clash.length === 0, `两个入口有同名异类的顶层定义：${clash.join('、')} —— 外部审查脚本会按名字读错东西`)
  return `index ${a.size} 个顶层定义 / look ${b.size} 个，无同名异类`
})

// ── C104：缓存根的「谁负责初始化」必须与代码一致（2026-11-01 0.4.1 第 11 条）──────────
// cache-path.mjs 原来写「现在两侧统一走 cacheDir()」，而 index.js 的 runsFile 实际走 ensureCache()。
// 注释错还是代码错？核下来是**注释错**：
//   · CLI 一条命令一进程，没初始化就是真没初始化 → cacheDir() 必抛，最省事；
//   · 面板是常驻进程，runLogRecord 可能在 apply() 之前被调到 → ensureCache() 幂等就地初始化，
//     否则整条日志丢掉。它拿的不是「未初始化的纯路径」，所以不属于「伪装成初始化好了」那种错。
// 两边算出来的根是同一个（C64 真起两个进程比过），差异只在「谁负责初始化」。
// 这条钉住这个分工：谁把它改成「统一」了，就直接红——那种「统一」会把日志或初始化时机弄坏。
check('C104 缓存根初始化责任分明：CLI 的 runsFile 走 cacheDir()（必抛），面板走 ensureCache()（幂等）', () => {
  const iSrc = read('index.js')
  const lSrc = read('tools/look.mjs')
  must(/const runsFile = \(\) => join\(ensureCache\(\), '_logs', 'runs\.jsonl'\)/.test(iSrc),
    'index.js 的 runsFile 不再走 ensureCache() —— 换成 cacheDir() 会在 apply() 之前抛，整条日志丢掉')
  must(/const runsFile = \(\) => join\(cacheDir\(\), '_logs', 'runs\.jsonl'\)/.test(lSrc),
    'tools/look.mjs 的 runsFile 不再是 cacheDir() —— CLI 侧应保留「未初始化必抛」')
  // 面板侧「幂等」的落点就在这个定义上：ensureCache 必须只是 initCachePath(cacheWant) 的薄壳。
  //   哪天它被改成「先读一个已有 CACHE、没有再初始化」，这里的幂等就变成了「读到空就抛」，注释又对不上了。
  must(/function ensureCache\(\) \{\s*\n\s*const r = initCachePath\(cacheWant\)/.test(iSrc),
    'index.js 的 ensureCache 不再是 initCachePath(cacheWant) 的薄壳 —— 面板侧的「幂等就地初始化」前提没了')
  // 注释靶子：这两句都已经被实证为「与代码不符」，写回去就红（它们正是第 11 条要修的东西）
  const badNotes = [
    /一律走 lib 的 cacheDir\(\)/,
    /缓存根没初始化时 runsFile\(\) 会抛/,
  ].filter((re) => re.test(iSrc))
  must(badNotes.length === 0, `index.js 又写回了与代码不符的注释：${badNotes.map(String).join(' / ')}`)
  const libSrc = read('lib/cache-path.mjs')
  // 只认「整行就是那句断言」的写法（新注释里引用这句时带引号、不是行首，不该误判）
  must(!/^\/\/\s*现在两侧统一走 cacheDir\(\)/m.test(libSrc), 'cache-path.mjs 又写回了「两侧统一走 cacheDir()」，与代码不符')
  must(/ensureCache\(\)/.test(libSrc), 'cache-path.mjs 的说明没提面板侧的 ensureCache()，读者会以为两边一样')
  return 'CLI=cacheDir（必抛）/ 面板=ensureCache（幂等自初始化）；文档与代码一致'
})

// ── C105–C111：七条命令的命令级端到端（2026-11-01 E5 补观测）────────────────────────
// 由来：view / peek / hot / sheet / substrip / asr / login 这七条命令，到这一批之前
//   **一条端到端断言都没有**。原语级（jget / downloadTo / sceneTimes / cache / 锁）都有真跑，
//   但「用户敲下那条命令、拿到什么输出」这一层是空的：把 cmdHot 的 fmtPlay 改坏、把 sheet 的
//   索引行删掉、把 login 的 Lv 字段取错（E7 真踩过），117 条断言一条都不会红。
//
// 三条写这条断言的硬规矩（踩过才定的，别放宽）：
//   ① **必须真跑**：spawn 一个真进程去执行 tools/look.mjs。读源码 grep 字段名不算——那验的是
//      「源码里写了这个词」，不是「命令跑出来长这样」。
//   ② **钉输出契约，不只钉退出码**：rc=0 是最弱的一档（命令打了一句废话也是 0）。
//      所以下面钉的是具体的行：`UP: … (mid 456)  时长 2m05s`、`r1c1 00:00-00:02 @00:01`、
//      `✓ 凭证有效：…（mid=10086，Lv6）`。格式一变就红。
//   ③ 网络怎么处理：这七条里六条要先打 B 站接口。**online 开关（VERIFY_ONLINE）不够用**——
//      它让「网络抖动」变成假红，而假红会逼人下次直接改绿。这里改成把网络换成本地夹具：
//      tools/fixtures/bili-mock.mjs 起一个假 B 站（worker 线程里，端口 0），
//      tools/fixtures/bili-mock-preload.mjs 用 node 的 `--import` 预载、
//      把发往 api/passport/comment/i0.hdslb.com 的 fetch 改写到它。
//      命令本身照原样跑：真进程、真参数解析、真输出格式，只有 HTTP 响应是假的。
//      **生产代码一行没动**（没给 look.mjs 加 API 根地址之类的开关——那种开关泄漏进用户环境
//      会把请求真打到别处，而且等于为了好测改行为）。
//
// 两个本机环境的坑，写的时候都撞了：
//   · mock server 不能住在主线程：断言是 spawnSync（同步等），主线程事件循环被冻住，
//     server 永远答不上来 → 子进程超时、rc=null、一条 hit 都没有。所以它在 worker 里。
//   · 缓存帧夹具必须先写 `.bili-watch-root` 标记：pickCacheDir 对「非空又没标记」的目录
//     会退到它下面的 bili-watch-cache 子目录，帧就白造了（第一次跑就是这样，三条全 miss）。
//
// ffmpeg 的两条（sheet / substrip）分两支：**有 ffmpeg 就钉成功输出**（拼图行 / 索引九格 /
//   manifest / 字幕带行），没有就钉「缺 ffmpeg 时说清了、rc≠0、且没白下视频」。
//   两支都以「缓存命中不重下」为前提——那一条与环境无关，两支都钉。
const { startMockBili, INJECT_COMMENT, INJECT_SUBTITLE } = await import('./fixtures/bili-mock.mjs')
const LOOK_MJS = join(HERE, 'look.mjs')
const MOCK_PRELOAD = pathToFileURL(join(HERE, 'fixtures', 'bili-mock-preload.mjs')).href
const MOCK_BV = 'BV1mock00001'
let mockBili = null
let mockWhy = ''
try { mockBili = await startMockBili() } catch (e) { mockWhy = String(e?.message ?? e) }
// 第二个 mock：热评与字幕换成带注入的正文（C127~C130 用）。
//   为什么要两个实例：护栏要证「有命中」和「没命中」两种输出，而「没命中」必须是同一条代码路径、
//   同一批命令参数 —— 换个 mock 端口比在一条命令里塞开关干净（生产侧一个开关都不加）。
let mockInject = null
let mockInjectWhy = ''
try {
  mockInject = await startMockBili({ commentText: INJECT_COMMENT, subtitleText: INJECT_SUBTITLE })
} catch (e) { mockInjectWhy = String(e?.message ?? e) }
// 本机 ffmpeg 的判据与 look.mjs 同一套：BILI_WATCH_FFMPEG（用户配置）→ PATH 里的 ffmpeg
const FF_BIN = (() => { try { return findFfmpeg(process.env.BILI_WATCH_FFMPEG || '') } catch { return null } })()
// 合法缓存根 = 空目录 + 标记文件（否则 pickCacheDir 会退到子目录，见上面那段注释）
const mockCache = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `bw-${tag}-`))
  writeFileSync(join(d, '.bili-watch-root'), '')
  return d
}
// baseEnv 先摘掉会改判据的环境变量（BILI_WATCH_CACHE/PROJ/DEPS/DSH_HOME）；
// BILI_WATCH_FFMPEG 也要摘——留着它「本机没 ffmpeg」那条分支就永远走不到，等于把一支断言悄悄关掉。
const mockEnvOn = (m, over = {}) => {
  const env = baseEnv({ BW_MOCK_PORT: String(m?.port ?? ''), ...over })
  if (!('BILI_WATCH_FFMPEG' in over)) delete env.BILI_WATCH_FFMPEG
  return env
}
const mockEnv = (over = {}) => mockEnvOn(mockBili, over)
const runLookMock = (args, env) =>
  spawnSync(process.execPath, ['--import', MOCK_PRELOAD, LOOK_MJS, ...args], { env, encoding: 'utf8', timeout: 180000 })
// 影子插件目录（2026-11-01）：让 look.mjs 在一个「deps 是空的」的插件根下跑。
//
// 为什么需要它：C111 要验「没凭证时 login --check 必须 rc≠0」。但凭证的**旧位置**
// 是 `<插件根>/deps/credential.json`（lib/cred.mjs 的 credPaths.legacy）——
// **硬编码在插件目录上，没有任何环境变量能改**（BILI_WATCH_DEPS 只管 deps 目录本身，
// 管不到 legacy 那条路径）。于是：
//   · 在没有凭证的干净 checkout 里跑 → 断言绿
//   · 在装了插件、deps/ 下有真凭证的机器上跑 → 命令读到真凭证 → rc=0 → **断言假红**
// 实测就是这个：主树里 deps/credential.json 是真凭证
// （10 月 20 日那份），合并到 main 后 C111 从绿变红。
//
// 做法：把要跑的两个 .mjs 拷进临时目录的 tools/，lib/ 用 junction 指回真仓库，
// 于是「插件根」= 那个临时目录，它的 deps/ 自然不存在。
// junction 而不是拷贝 lib/：lib 有十几个文件，拷贝既慢又可能与主树不同步；
// junction 在 Windows 上 fs.symlinkSync(..., 'junction') 可用（不需要管理员）。
const shadowPlugin = () => {
  const root = mkdtempSync(join(tmpdir(), 'bw-shadow-'))
  mkdirSync(join(root, 'tools'), { recursive: true })
  for (const f of ['look.mjs', 'cli-io.mjs']) {
    copyFileSync(join(HERE, f), join(root, 'tools', f))
  }
  try { symlinkSync(join(HERE, '..', 'lib'), join(root, 'lib'), 'junction') } catch {}
  return root
}
const runLookShadow = (root, args, env) =>
  spawnSync(process.execPath, ['--import', MOCK_PRELOAD, join(root, 'tools', 'look.mjs'), ...args],
    { env, encoding: 'utf8', timeout: 180000 })
// 夹具起不来是「本机基础设施缺」，不是「被测代码坏」——按 C95 的规矩走 skip()，不进通过数
const needMock = (name) => {
  if (mockBili) return true
  skip(name, `本地 mock server 起不来，命令级真跑做不了：${mockWhy}`)
  return false
}
const tail = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').slice(-n)

check('C105 view 真跑（本地 mock）：UP 行字段与时长格式、aid/cid 行、热评区、view+reply 两跳都打到', () => {
  const NAME = 'C105 view 真跑'
  if (!needMock(NAME)) return
  const cache = mockCache('c105')
  const home = mkdtempSync(join(tmpdir(), 'bw-c105-home-'))
  try {
    mockBili.clearHits()
    const r = runLookMock(['view', MOCK_BV], mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: home }))
    const out = String(r.stdout || '')
    must(r.status === 0, `view 退出码 ${r.status}（应当是 0）；stderr=${tail(r.stderr)}`)
    must(/^视频: 夹具视频标题$/m.test(out), `「视频: <标题>」那一行没了或字段改了：${tail(out)}`)
    // 这一行钉三件事：owner 后面带 mid；时长走 fmtSec（125 秒 = 2m05s，不是 02:05）；播放/评论两个数
    must(out.includes('UP: 夹具UP (mid 456)  时长 2m05s  播放 1234  评论 56'),
      `UP 行的字段或格式变了（时长必须是 fmtSec 的 2m05s）：${tail(out)}`)
    must(/^aid=999 cid=789$/m.test(out), `aid/cid 行没了（下游 --p / 直链全靠这两个数）：${tail(out)}`)
    must(/^简介: 夹具简介一行$/m.test(out), `简介行没了：${tail(out)}`)
    must(/^热评:$/m.test(out), `热评区标题没了：${tail(out)}`)
    must(/^  \[赞7\] 甲: 好片子$/m.test(out), `热评第一条没按「[赞N] 昵称: 内容」打：${tail(out)}`)
    must(/^  \[赞3\] 乙: 第二条热评$/m.test(out), `热评第二条没打出来（ps 上限或 slice 被改坏）：${tail(out)}`)
    const paths = mockBili.hits().map((h) => h.path)
    must(paths.includes('/x/web-interface/view'), `没有请求 view 接口（$paths 里只有这些）：${paths.join(',')}`)
    must(paths.includes('/x/v2/reply/main'), `没有请求评论接口，热评区是空转：${paths.join(',')}`)
    return 'rc=0；视频/UP(含 mid、2m05s)/aid+cid/简介/热评两条；view + reply 两跳都打到'
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

check('C106 hot 真跑（本地 mock）：榜单标题带条数、每条形如「BV  播放  时长  日期  标题」、--limit 真截断', () => {
  const NAME = 'C106 hot 真跑'
  if (!needMock(NAME)) return
  const cache = mockCache('c106')
  const home = mkdtempSync(join(tmpdir(), 'bw-c106-home-'))
  try {
    mockBili.clearHits()
    const r = runLookMock(['hot', '--limit', '2'], mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: home }))
    const out = String(r.stdout || '')
    must(r.status === 0, `hot 退出码 ${r.status}；stderr=${tail(r.stderr)}`)
    must(/^综合热门榜 前 2 条（按热度排，不是纯播放量）$/m.test(out),
      `榜首标题行没了或条数不对（--limit 2 应报 2）：${tail(out)}`)
    // 12345 → 「1.2万」（fmtPlay 的万位换算）、225 秒 → 3:45、pubdate → 2025-10-01
    must(/^  BV1mock00002  1\.2万播放  3:45  2025-10-01  第二个视频$/m.test(out),
      `条目行格式变了（播放量万位 / 时长 m:ss / 日期 / 标题 四段）：${tail(out)}`)
    must(/^           UP 夹具UP2$/m.test(out), `条目下的 UP 行没了：${tail(out)}`)
    must(/^  BV1mock00003  999播放  0:45  2025-10-01  第三个视频$/m.test(out),
      `不满一万的播放量没按原数打（不该有「万」）：${tail(out)}`)
    must(!out.includes('不该出现的第四条'), '--limit 2 没截断：第三条也打出来了（模型会被榜单淹掉）')
    must(mockBili.hits().some((h) => h.path === '/x/web-interface/ranking/v2'), '没有请求排行接口')
    return 'rc=0；前 2 条标题行；四段式条目（1.2万/3:45/日期/标题）；--limit 真截断'
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

check('C107 peek 真跑（本地 mock + 缓存帧）：5 帧复用行、r1c1…r1c5 索引行、判据行；命中缓存不重下', () => {
  const NAME = 'C107 peek 真跑'
  if (!needMock(NAME)) return
  const cache = mockCache('c107')
  const home = mkdtempSync(join(tmpdir(), 'bw-c107-home-'))
  const TIMES = [3, 30, 60, 90, 120]
  try {
    // 造「已经抽好的 5 帧」：peekFrames 的缓存判据是 manifest.ok && jpg>=5，命中后不再碰下载
    const dir = join(cache, 'frames', `${MOCK_BV}-p1-shots`)
    mkdirSync(dir, { recursive: true })
    TIMES.forEach((_, i) => writeFileSync(join(dir, `peek-0${i + 1}.jpg`), 'x'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ok: true, bv: MOCK_BV, p: 1, frames: 5, source: 'videoshot', times: TIMES, at: Date.now() }))
    mockBili.clearHits()
    const r = runLookMock(['peek', MOCK_BV], mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: home }))
    const out = String(r.stdout || '')
    must(r.status === 0, `peek 退出码 ${r.status}（缓存命中应当是 0）；stderr=${tail(r.stderr)}`)
    // peek 的 UP 行**不带 mid**（与 view 有意不同），别照 view 的格式来钉
    must(out.includes('UP: 夹具UP  时长 2m05s  播放 1234  评论 56'), `peek 的 UP 行格式变了：${tail(out)}`)
    must(/^  \[7\] 甲: 好片子$/m.test(out), `peek 的热评格式是「[赞数] 昵称: 内容」（不带「赞」字）：${tail(out)}`)
    must(new RegExp(`^5 帧（复用）: .*${MOCK_BV}-p1-shots$`, 'm').test(out.trim()),
      `「5 帧（复用）: <目录>」那一行没了——模型就不知道画面在哪：${tail(out)}`)
    must(/^索引：$/m.test(out), `索引区标题没了：${tail(out)}`)
    const idx = out.split('\n').map((l) => l.trim()).filter((l) => /^r1c\d+ \d\d:\d\d-\d\d:\d\d @\d\d:\d\d$/.test(l))
    must(idx.length === 5, `索引应有 5 行（r1c1…r1c5），实际 ${idx.length}：${idx.join(' / ')}`)
    must(idx[0] === 'r1c1 00:03-00:03 @00:03', `第一格索引不对（时间该从 manifest.times 来）：${idx[0]}`)
    must(idx[4] === 'r1c5 02:00-02:00 @02:00', `最后一格索引不对：${idx[4]}`)
    must(out.includes('判据：画面文字多/图表/歌词'), '结尾那句判据没了')
    const paths = mockBili.hits().map((h) => h.path)
    must(!paths.includes('/x/player/playurl'), `缓存里有 5 帧却还是重新下了视频：${paths.join(',')}`)
    must(!paths.includes('/x/player/videoshot'), `缓存命中还去打了 videoshot：${paths.join(',')}`)
    return 'rc=0；5 帧（复用）行 + 5 条 r1cN 索引 + 判据行；命中缓存零下载'
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// 造一张真 jpg 给拼图用：ffmpeg 的 tile 过滤器会拒绝对不上号的输入，空壳文件只会换来
// 「Nothing was written into output file」——那种红说明夹具不对，不说明代码不对。
const seedJpg = (dir) => {
  const p = join(dir, 'seed.jpg')
  const g = spawnSync(FF_BIN, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1', '-frames:v', '1', p], { encoding: 'utf8', timeout: 60000 })
  must(g.status === 0, `造夹具 jpg 失败（ffmpeg rc=${g.status}）：${tail(g.stderr)}`)
  return p
}
const fillFrames = (dir, seed, n) => {
  for (let i = 1; i <= n; i++) {
    const f = join(dir, `${MOCK_BV}-${String(i).padStart(2, '0')}.jpg`)
    if (seed) copyFileSync(seed, f)
    else writeFileSync(f, 'x')
  }
}

check('C108 sheet 真跑（本地 mock + 缓存帧）：首行格式、拼图行、九格 r1c1…r3c3、manifest 落盘；命中缓存不重下', () => {
  const NAME = 'C108 sheet 真跑'
  if (!needMock(NAME)) return
  const cache = mockCache('c108')
  const home = mkdtempSync(join(tmpdir(), 'bw-c108-home-'))
  const work = mkdtempSync(join(tmpdir(), 'bw-c108-work-'))
  try {
    const dir = join(cache, 'frames', `${MOCK_BV}-p1-2s`)
    mkdirSync(dir, { recursive: true })
    fillFrames(dir, FF_BIN ? seedJpg(work) : null, 9)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ok: true, step: 2, scene: false, times: null, frames: 9, at: Date.now() }))
    mockBili.clearHits()
    const args = ['sheet', MOCK_BV, '--step', '2']
    if (FF_BIN) args.push('--ffmpeg', FF_BIN)
    const r = runLookMock(args, mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: home }))
    const out = String(r.stdout || '')
    const err = String(r.stderr || '')
    // 与环境无关的两条：首行格式 + 「缓存命中不重下视频」
    must(out.includes(`九宫格 ${MOCK_BV}（3x3，从抽帧里均匀挑 9 张拼一张图）`),
      `首行没了或格式变了（BV / 格子 / 张数三段）：${tail(out)}`)
    const paths = mockBili.hits().map((h) => h.path)
    must(paths.includes('/x/web-interface/view'), `连 view 都没打（时长拿不到，缓存判据会跟着错）：${paths.join(',')}`)
    must(!paths.includes('/x/player/playurl'), `缓存里有 9 帧却还是重新下了视频（白等一次下载）：${paths.join(',')}`)
    if (!FF_BIN) {
      // 本机没有 ffmpeg：这条命令的终点就是这句话。rc 必须非 0，且说清缺什么、去哪儿装
      must(r.status === 1, `缺 ffmpeg 时退出码应是 1，实际 ${r.status}`)
      must(/✗ 找不到 ffmpeg：.*fetch-deps/.test(err), `缺 ffmpeg 时没说清怎么装：${tail(err)}`)
      return 'rc=1；首行格式对；缺 ffmpeg 时点名「找不到 ffmpeg」+ 安装出路；缓存命中不重下（本机无 ffmpeg，拼图那半支未验）'
    }
    must(r.status === 0, `sheet 退出码 ${r.status}；stderr=${tail(err)}`)
    must(new RegExp(`^拼图: .*${MOCK_BV}-p1-3x3\\.jpg（\\d+ KiB，共 9 帧）$`, 'm').test(out),
      `拼图行没了或格式变了（路径 / 体积 / 帧数）：${tail(out)}`)
    must(/^索引：$/m.test(out), `索引区标题没了（模型看图不知道第几格是第几秒）：${tail(out)}`)
    const idx = out.split('\n').map((l) => l.trim()).filter((l) => /^r\d+c\d+ \d\d:\d\d-\d\d:\d\d @\d\d:\d\d$/.test(l))
    must(idx.length === 9, `索引应有 9 行（3x3），实际 ${idx.length}：${idx.join(' / ')}`)
    must(idx[0] === 'r1c1 00:00-00:02 @00:01', `第一格索引不对（step=2 应覆盖 0-2 秒）：${idx[0]}`)
    must(idx[8] === 'r3c3 00:16-00:18 @00:17', `最后一格索引不对（行列号或时刻算错）：${idx[8]}`)
    const man = join(cache, 'sheets', `${MOCK_BV}-p1-3x3.manifest.json`)
    must(existsSync(man), `拼图的 manifest 没落盘（面板/下游靠它认格）：${man}`)
    const mj = JSON.parse(readFileSync(man, 'utf8'))
    must(mj.grid === '3x3' && Array.isArray(mj.cells) && mj.cells.length === 9,
      `manifest 的 grid/cells 不对：${JSON.stringify(mj).slice(0, 200)}`)
    must(mj.cells[0].cell === 1 && mj.cells[0].sec === 0 && mj.cells[8].sec === 16,
      `manifest 里的 cell/sec 不对：${JSON.stringify(mj.cells.slice(0, 1))} / ${JSON.stringify(mj.cells.slice(8))}`)
    return 'rc=0；首行 + 拼图行 + 九条 r1c1…r3c3 索引 + manifest（grid/cells/sec）；缓存命中不重下'
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

check('C109 substrip 真跑（本地 mock + 缓存帧）：首行格式、字幕带行（体积/条数）、收尾提示；命中缓存不重下', () => {
  const NAME = 'C109 substrip 真跑'
  if (!needMock(NAME)) return
  const cache = mockCache('c109')
  const home = mkdtempSync(join(tmpdir(), 'bw-c109-home-'))
  const work = mkdtempSync(join(tmpdir(), 'bw-c109-work-'))
  try {
    // substrip 默认 --step 7 → 目录 tag 是 7s；最多取 12 条
    const dir = join(cache, 'frames', `${MOCK_BV}-p1-7s`)
    mkdirSync(dir, { recursive: true })
    fillFrames(dir, FF_BIN ? seedJpg(work) : null, 12)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ok: true, step: 7, scene: false, times: null, frames: 12, at: Date.now() }))
    mockBili.clearHits()
    const args = ['substrip', MOCK_BV]
    if (FF_BIN) args.push('--ffmpeg', FF_BIN)
    const r = runLookMock(args, mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: home }))
    const out = String(r.stdout || '')
    const err = String(r.stderr || '')
    must(out.includes(`字幕带 ${MOCK_BV}（每 7 秒一条，竖拼一张图）`),
      `首行没了或步长默认值变了（不传 --step 应是 7）：${tail(out)}`)
    const paths = mockBili.hits().map((h) => h.path)
    must(!paths.includes('/x/player/playurl'), `缓存里有 12 帧却还是重新下了视频：${paths.join(',')}`)
    if (!FF_BIN) {
      must(r.status === 1, `缺 ffmpeg 时退出码应是 1，实际 ${r.status}`)
      must(/✗ 找不到 ffmpeg：.*fetch-deps/.test(err), `缺 ffmpeg 时没说清怎么装：${tail(err)}`)
      return 'rc=1；首行格式对；缺 ffmpeg 时点名「找不到 ffmpeg」+ 安装出路；缓存命中不重下（本机无 ffmpeg，拼图那半支未验）'
    }
    must(r.status === 0, `substrip 退出码 ${r.status}；stderr=${tail(err)}`)
    must(new RegExp(`^字幕带: .*${MOCK_BV}-p1-substrip\\.jpg（\\d+ KiB，共 12 条）$`, 'm').test(out),
      `字幕带行没了或格式变了（路径 / 体积 / 条数）：${tail(out)}`)
    must(existsSync(join(cache, 'sheets', `${MOCK_BV}-p1-substrip.jpg`)), '字幕带图没落盘')
    must(out.includes('一张图里是整片底部字幕'), '结尾那句「一张图里是整片底部字幕」没了')
    return 'rc=0；首行（默认 7 秒）+「字幕带: …（N KiB，共 12 条）」+ 收尾提示；缓存命中不重下'
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

check('C110 asr 真跑：缺 whisper 环境时先挡在闸门外——rc≠0、点名缺的两个路径、说清怎么装，且不碰网络', () => {
  // 这条能钉的和不能钉的必须说清楚：
  //   能钉：环境闸门（asrReady）+ 两句指路文案 + 「没环境就不该往下走」。BILI_WATCH_DEPS 指空目录
  //         让这一支**机器无关**——不管本机装没装 whisper，这条走到的都是同一个分支。
  //   没钉：真转写（下音轨 → faster-whisper → 时间轴）。那要真模型 + 真音轨，属于外部能力，
  //         不在这条守卫的射程里；要验它得真装 .venv-asr（scripts/fetch-deps -Target asr）。
  const cache = mockCache('c110')
  const home = mkdtempSync(join(tmpdir(), 'bw-c110-home-'))
  const deps = mkdtempSync(join(tmpdir(), 'bw-c110-deps-'))
  try {
    mockBili && mockBili.clearHits()
    const r = runLookMock(['asr', MOCK_BV], mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: home, BILI_WATCH_DEPS: deps }))
    const out = String(r.stdout || '')
    const err = String(r.stderr || '')
    must(r.status === 1, `缺转写环境时退出码应是 1（0 会让插件以为转写成功了），实际 ${r.status}`)
    must(err.includes(`✗ 本地转写环境不可用（缺 `), `闸门没说话或文案变了：${tail(err)}`)
    // 点名的必须是「这次真缺的那两个路径」，不是一句含糊的「环境不可用」
    must(err.includes(join(deps, '.venv-asr')), `没说清缺哪一个虚拟环境（BILI_WATCH_DEPS 下的 .venv-asr）：${tail(err)}`)
    must(err.includes(join(deps, '_bili-asr.py')), `没说清缺哪一个脚本（_bili-asr.py）：${tail(err)}`)
    // 2026-11-02（fetch-deps 合一）：出路的写法跟着命令变了 —— 三平台都是 node 一条命令。
    must(/跑 node scripts\/fetch-deps\.mjs asr/.test(out), `没给安装出路（用户只知道坏了、不知道怎么办）：${tail(out)}`)
    must(/或用 text 走字幕\/OCR 降级/.test(out), `没给降级出路：${tail(out)}`)
    if (mockBili) {
      const paths = mockBili.hits().map((h) => h.path)
      must(paths.length === 0, `没环境就该在发请求之前返回，实际打了：${paths.join(',')}`)
    }
    return 'rc=1；点名缺 .venv-asr 与 _bili-asr.py 两个路径；给了安装与降级两条出路；零网络请求'
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(deps, { recursive: true, force: true })
  }
})

check('C111 login 真跑：--check 有凭证 → 「✓ 凭证有效…（mid=…，Lv…）」且真带 Cookie；没凭证 → rc≠0 指路', () => {
  const NAME = 'C111 login 真跑'
  if (!needMock(NAME)) return
  const cache = mockCache('c111')
  const home = mkdtempSync(join(tmpdir(), 'bw-c111-home-'))
  const homeEmpty = mkdtempSync(join(tmpdir(), 'bw-c111-empty-'))
  try {
    // ① 有凭证：四字段齐全才算「一份能用的凭证」（lib/cred.mjs 的 CRED_FIELDS）
    mkdirSync(join(home, 'bili-watch'), { recursive: true })
    writeFileSync(join(home, 'bili-watch', 'credential.json'),
      JSON.stringify({ sessdata: 'S1', bili_jct: 'J1', buvid3: 'B3', buvid4: 'B4' }))
    mockBili.clearHits()
    const ok = runLookMock(['login', '--check'], mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: home }))
    const okOut = String(ok.stdout || '')
    must(ok.status === 0, `有凭证时 login --check 退出码 ${ok.status}；stderr=${tail(ok.stderr)}`)
    // E7 踩过：等级在 data.level_info.current_level，取错就打出「Lvundefined」。这里连 Lv 一起钉
    must(/^✓ 凭证有效：夹具账号（mid=10086，Lv6）$/m.test(okOut),
      `「✓ 凭证有效：<昵称>（mid=…，Lv…）」那一行没了或字段取错（Lvundefined 就是这么回来的）：${tail(okOut)}`)
    const nav = mockBili.hits().find((h) => h.path === '/x/web-interface/nav')
    must(nav, `没有请求 nav 接口：${mockBili.hits().map((h) => h.path).join(',')}`)
    must(nav.cookie.includes('SESSDATA=S1') && nav.cookie.includes('bili_jct=J1')
      && nav.cookie.includes('buvid3=B3') && nav.cookie.includes('buvid4=B4'),
      `请求没带全四个 cookie（带了才发现凭证是坏的）：${nav.cookie}`)
    // ② 没凭证：不许拿匿名请求冒充「有效」，退出码要非 0 并指到 login
    //    **必须在影子插件目录下跑**（见上面 shadowPlugin 的注释）：
    //    凭证的旧位置 <插件根>/deps/credential.json 硬编码在插件目录上，
    //    换个 DSH_HOME / BILI_WATCH_DEPS 都躲不掉 —— 主树的 deps/ 下就有真凭证。
    //    原来这里直接跑插件目录里的 look.mjs，在装了插件的机器上必然假红。
    mockBili.clearHits()
    const shadow = shadowPlugin()
    try {
      const no = runLookShadow(shadow, ['login', '--check'],
        mockEnv({ BILI_WATCH_CACHE: cache, DSH_HOME: homeEmpty }))
      const noErr = String(no.stderr || '')
      must(no.status === 1, `没凭证时退出码应是 1，实际 ${no.status}（rc=0 会让脚本以为已登录）`)
      must(/✗ 还没登录（.*credential\.json 不存在），先跑 node look\.mjs login/.test(noErr),
        `没凭证时没说清「还没登录 + 该跑哪条命令」：${tail(noErr)}`)
      must(mockBili.hits().length === 0, `没凭证还去打了接口（应当是本地就拦住）：${mockBili.hits().map((h) => h.path).join(',')}`)
    } finally { rmSync(shadow, { recursive: true, force: true }) }
    return 'rc=0 时打出昵称/mid/Lv6 且四个 cookie 都随请求发出；没凭证时 rc=1、指路 login、零网络'
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(homeEmpty, { recursive: true, force: true })
  }
})

// 2026-11-02：原来在这里就把 mockBili 关了。C127 要在文件末尾再用它做「未命中时逐字节不变」
//   （那是最硬的一条不变量：没命中就必须一个字节都不变），所以关闭点挪到汇总之后，
//   连带新的 mockInject 一起关。挪后不影响退出——process.exit 本身终止 worker，
//   只是把「这批跑完就关」改成「全跑完就关」。

check('C112 removeOwned 对白名单目录也要看内容：混了用户文件就整目录不动并点名（X-02）', () => {
  // 2026-11-01（X-02，数据丢失）：缓存根可以被 BILI_WATCH_CACHE / deps-config.json 指到任何目录，
  //   只要里面有我们的标记文件。用户在那种根下自建 frames/ 放素材，面板「立即清除」/`clean`
  //   会整棵删掉——实测 removed=2、skipped 是空数组，一个字都没提。
  //   自动清理那条路（isOwnedEntry）2026-11-01 已经加了内容校验，removeOwned 是另一份实现，没跟上。
  //
  // 为什么必须真跑：C10 用 compile + prelude stub 抽 removeOwned 的函数体，stub 把
  //   whitelistDirIsOurs 整个屏蔽掉了——它永远不会因为「只认名字」变红。两条路的口径差异，
  //   只能靠真跑同一个目录、看它删没删来抓。
  const mk = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'bw-c112-'))
    writeFileSync(join(root, '.bili-watch-root'), '')
    mkdirSync(join(root, 'frames'), { recursive: true })
    for (const f of files) writeFileSync(join(root, 'frames', f), 'x')
    return root
  }
  // ① 混了用户的工程文件：整个 frames/ 不动，而且 skipped 要说出是哪个目录、为什么
  const r1 = mk(['f001.jpg', '用户的工程.psd'])
  try {
    const a = removeOwned(r1)
    must(existsSync(join(r1, 'frames', '用户的工程.psd')),
      '用户文件被删了（frames/ 只按名字认领，没看内容）')
    must(a.skipped.some((s) => s.name === 'frames'),
      '整目录跳过了却没进 skipped —— 用户既不知道自己的东西还在，也不知道为什么没清')
  } finally { rmSync(r1, { recursive: true, force: true }) }
  // ② 全是我们的 jpg：必须照常清掉（别把修复做成「白名单目录永远不删」）
  const r2 = mk(['f001.jpg', 'f002.jpg'])
  try {
    const b = removeOwned(r2)
    must(!existsSync(join(r2, 'frames')), '纯产物的 frames/ 没被清掉 —— 修过头了，clean 会永远清不动')
    must(!b.skipped.some((s) => s.name === 'frames'), '纯产物的 frames/ 被记进了 skipped')
  } finally { rmSync(r2, { recursive: true, force: true }) }
  // ③ 空目录（mkdir 留下的壳）：该清，删了不损失任何东西
  const r3 = mk([])
  try {
    removeOwned(r3)
    must(!existsSync(join(r3, 'frames')), '空 frames/ 没被清掉（空壳留下来只会在面板上占一行）')
  } finally { rmSync(r3, { recursive: true, force: true }) }
  return '混用户文件→整目录不动并点名；纯产物→照常清；空壳→清'
})

// C117（2026-11-01，第三条）：skip 的原因必须可判读。
//
//   背景：「那 3 条 skip 补原因」，说「现在只打「跳过」，看不出为什么」。
//   实测下来**前提不成立** —— 当时 24 处 skip() 调用**全都有原因**，SKIP 行本来就会打
//   detail（`SKIP  名字  —  原因`）。但顺着这条查，发现两个真问题：
//     ① 4 处写成「本机没有 bash 或找不到 scripts/fetch-deps.sh」—— 「A 或 B」的复合原因，
//        读者分不清到底缺哪个，也不知道怎么才能让它跑（已拆成两条 if，各说各的）；
//     ② 汇总行只有「N 跳过」一个数字，只看结尾的人不知道跳过了哪几条。
//        （已在汇总段后面加「跳过明细」块，列名字 + 原因。）
//   这条断言守的是「以后也不许退回去」：原因必须存在、不许复合、必须能看出怎么办。
check('C117 skip 的原因必须可判读：不许空、不许「A 或 B」式复合、必须说清怎么才能让它跑', () => {
  const src = read('tools/verify.mjs')
  // 抽出所有 skip('名字', '原因') 的第二个参数。原因可能是字符串字面量或模板串。
  // 不用正则硬啃整段（模板串里有嵌套），改用逐行扫：skip( 之后到下一个 `)` 之前的文本。
  // 切行时顺手去掉 CRLF 的 \r：JS 的 `$` 不把 \r 当行尾，留着会让下面的 `(.+)$` 整行失配。
  // （踩过：文件被编辑器写成 CRLF 时，第一版扫出 0 处 skip，断言自己红在「只认出 0 处」上。
  //   仓库里存的是 LF，但不同机器/编辑器会写 CRLF，所以这层剥离留着，不当摆设。）
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''))
  const reasons = []
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    const m = l.match(/skip\(\s*'([^']*)'\s*,\s*(.+)$/)
    if (!m) continue
    // 名字里带 ' 的不会这样写；拿到原因的开头，可能跨行，往下拼到括号平衡为止
    let buf = m[2]
    let j = i
    let depth = (buf.match(/\(/g) || []).length - (buf.match(/\)/g) || []).length
    while (depth > 0 && j + 1 < lines.length) {
      j += 1
      buf += '\n' + lines[j]
      depth += (lines[j].match(/\(/g) || []).length - (lines[j].match(/\)/g) || []).length
    }
    reasons.push({ name: m[1], line: i + 1, why: buf })
  }
  // 阈值 20 → 14（2026-11-02，fetch-deps 合一）。
  //   6 条判据原来带「本机没 bash / 找不到 fetch-deps.sh 就 skip」的出口，合一后改成真跑
  //   （探针切原样代码），skip 出口本来**就该减少** —— 减得对，阈值跟着动。
  //   但下限不能拿掉：它的用处是「扫描方式过时了要红」。真掉到 14 以下说明又有大批 skip
  //   被删掉或换了写法，得有人看一眼再决定是不是也「减得对」。
  must(reasons.length >= 14, `只认出 ${reasons.length} 处 skip() 调用（应有 14+）—— 扫描方式可能过时了，或者 skip 被大批删掉/改了写法`)

  // 覆盖自检：只给名字、不给原因的 skip('x') 会绕过上面的正则（要求有逗号），那是默认关掉的口子。
  // 报错文案里引用的示例是模板串（含 ` 或 ${），按「含反引号就跳过」区分，不误报。
  const noReason = []
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return // 注释里举的示例（比如本段注释自己）不算调用
    if (l.includes('`') || l.includes('${')) return
    if (/skip\(\s*'[^']*'\s*\)/.test(l)) noReason.push(i + 1)
  })
  must(noReason.length === 0,
    `第 ${noReason.join(', ')} 行 skip() 只给了名字没给原因 —— 跳过必须说明为什么`)

  // 把第二个实参剥成纯文本：去掉行尾的 `)` 和包住它的引号。
  // （踩过：不剥引号时空原因 '' 会被当成 2 个字符，`length > 0` 白过。）
  const unquote = (s) => s.replace(/\)\s*$/, '').trim().replace(/^(['"`])([\s\S]*)\1$/, '$2').trim()

  // ① 不许空原因
  for (const r of reasons) {
    const body = unquote(r.why)
    must(body.length > 0, `第 ${r.line} 行 skip('${r.name}') 没有原因 —— 跳过必须说明为什么`)
  }

  // ② 不许「A 或 B」式复合原因（读者分不清是哪个条件不满足）
  //    只查中文的「或」连接两个并列条件这种形态；「或」出现在正常叙述里（如「生或死」）不该误报，
  //    所以限定在「没有 X 或 找不到 Y」「缺 X 或 无 Y」这类条件并列上。
  const compound = /没有[^，。]{0,20}或[^，。]{0,20}(找不到|没有|缺|无)/
  for (const r of reasons) {
    must(!compound.test(r.why),
      `第 ${r.line} 行 skip('${r.name}') 的原因是「A 或 B」复合式（${r.why.slice(0, 60).trim()}…）—— ` +
      `拆成两个 if，各写各的，否则读者不知道到底缺哪个`)
  }

  // ③ 原因必须能看出「怎么才能让它跑」（给出一条可操作的路）
  //    认得出来的形态：装什么 / 设哪个环境变量 / 或明说这是「已知不覆盖」。
  //    这条不要求每一条都命中（有些原因本身就够清楚），所以只对**含糊**的几类做硬判：
  //      · 只写「跳过」「没跑」这种没信息量的
  //      · 只写「本机没有 X」但不说怎么办的
  const vague = /^(跳过|没跑|略|n\/a|skip)[。.!]?$/i
  for (const r of reasons) {
    const body = unquote(r.why)
    must(!vague.test(body), `第 ${r.line} 行 skip('${r.name}') 的原因只有「${body}」—— 等于没说`)
    if (/^(本机|这台机器)(没有|没找到|找不到)/.test(body)) {
      must(/（[^）]*(装|设|配|VERIFY|PATH|Git Bash|环境变量)[^）]*）|要装|装好|设 VERIFY/.test(body),
        `第 ${r.line} 行 skip('${r.name}') 写「${body.slice(0, 40)}…」但没说怎么才能让它跑 —— ` +
        `补一句「装什么/设哪个变量」，否则读者只能干看着`)
    }
  }

  return `${reasons.length} 处 skip：原因都非空、无「A 或 B」复合、缺环境类都给了补救办法`
})

// C118（2026-11-01，判 P0）：64 KB 闸之后，请求必须正常结束。
//   旧写法 `if (raw.length > 65536) req.destroy()` 一了百了，真测出来两个后果：
//     ① `IncomingMessage.destroy()` 不带 error 参数时**不 emit 'error'**，'end' 也不来
//        → Promise 永远 pending，闭包里那份 raw 跟着泄漏（每个超限请求一份）；
//     ② socket 被毁 → 200 写不回去，客户端只拿到 ECONNRESET / socket hang up（英文，没提示）。
//   这条判据**必须真起 server、真发 body**：用假 req（EventEmitter）验「destroy 之后会不会
//   emit end」等于把自己的假设当成被测事实——C57 就是栽在「判据在验错对象」。
//   走 fixtures/readbody-probe.mjs：它把 readJsonBody 的**源码逐字**抠出来当 handler。
check('C118 64 KB 闸之后请求不许挂死（P0：原来 destroy 后 Promise 永不落地）', () => {
  const probe = join(HERE, 'fixtures', 'readbody-probe.mjs')
  const run = (env) => {
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } })
    must(r.status === 0, `探针退出码 ${r.status}：${String(r.stderr || '').slice(0, 300)}`)
    const out = String(r.stdout || '').trim()
    must(out.startsWith('{'), `探针没输出 JSON：${JSON.stringify(out.slice(0, 200))}`)
    return JSON.parse(out)
  }

  // 甲：70 KB 的**合法** JSON（超闸）
  //   故意用合法 JSON —— 这样「回 {}」只可能来自超闸分支，不可能是 JSON.parse 失败兜的底；
  //   而「闸被整个删掉」时它会原样回 70 KB（bodyLen 远超 2），这条也一并抓住。
  const big = run({})
  must(big.ok === true, `超 64 KB 的 POST 没拿到 200：${JSON.stringify(big)}`)
  must(big.status === 200, `状态码 ${big.status}，期望 200`)
  must(big.body === '{}', `超闸的 body 回的是 ${JSON.stringify(big.body)}（${big.bodyLen}B），期望 {} —— ` +
    `回出原文说明 64 KB 闸没了，回别的东西说明超闸分支的行为变了`)

  // 乙：没超闸的小 JSON 必须原样解析（区分度：否则「一律回 {}」也能骗过甲）
  const small = run({ PROBE_JSON: '{"a":1}' })
  must(small.ok === true && small.body === '{"a":1}',
    `小 body 没被正常解析：${JSON.stringify(small)} —— 修超闸那条时把正常路径改坏了`)

  return `超闸 200/{}（${big.ms}ms）｜未超闸原样（${small.ms}ms）`
})

// C119（2026-11-01，X-14 第一步）：锁必须能续期，而且续期不许把进程钉住。
//   背景：`lockTtlMsOf` 只覆盖「一次转写」，但持锁段还有「下载音轨 + ffmpeg 转 wav」，
//   余量只有固定 120 秒；面板把锁过期拉到 5 分钟时，大视频必超 → 锁被判过期 → 别人抢进来 →
//   两个进程写同一个 `cacheTxt + '.tmp'`（这个 tmp 名**不带 pid**）→ 转写结果损坏。
//   四条判据全在 `fixtures/x14-probe.mjs` 里真跑（真 locks.mjs API、真子进程抢锁）：
//     ① 不续期 → 子进程**必须抢到**：钉住「缺陷真的存在」，防止以后有人以为已经好了
//     ② 续期   → 子进程**必须抢不到**，且收尾时锁还是自己的
//     ③ 续期中持着锁 → 进程**必须自己退出**：钉住 `setInterval` 的 `unref()`。
//        这条我第一版写错过：探针里 unlock 了，于是「丢锁 → 停表 → 进程退出」也绿，
//        跟 unref 毫无关系；现在改成持着锁不退，只有 unref 能让它撒手。
//     ④ 续期时锁被换人 → `onLost` **必须**被调用（丢锁不许静默）
check('C119 锁续期：不续期会被抢、续期守得住、且不许把进程钉住（X-14）', () => {
  const probe = join(HERE, 'fixtures', 'x14-probe.mjs')
  const run = (mode, timeout = 30000) => {
    const r = spawnSync(process.execPath, [probe, mode], { encoding: 'utf8', timeout })
    return { r, out: String(r.stdout || '').trim() }
  }
  const parse = (o, mode) => {
    must(o.startsWith('{'), `${mode} 没输出 JSON：${JSON.stringify(o.slice(0, 200))}`)
    return JSON.parse(o)
  }

  // ① 缺陷真的存在（不续期 → 被抢）
  const hold = run('hold')
  must(hold.r.status === 0, `hold 退出码 ${hold.r.status}：${String(hold.r.stderr || '').slice(0, 200)}`)
  const h = parse(hold.out, 'hold')
  must(h.child === 'GOT', `不续期时子进程没抢到锁（child=${h.child}）—— 那这条判据就失去意义了：` +
    `它本该证明「超 TTL 的锁会被别人抢走」`)
  must(h.lockBeforeRelease === 'other', `被抢之后锁的归属是 ${h.lockBeforeRelease}，期望 other（自己已经不是主人）`)

  // ② 续期守得住
  const renew = run('renew')
  must(renew.r.status === 0, `renew 退出码 ${renew.r.status}：${String(renew.r.stderr || '').slice(0, 200)}`)
  const rn = parse(renew.out, 'renew')
  must(rn.child === 'NOPE', `续期期间子进程抢到了锁（child=${rn.child}）—— heartbeat 没把 at 刷上去`)
  must(rn.lockBeforeRelease === 'mine', `续期结束时锁已不是自己的（${rn.lockBeforeRelease}）`)

  // ③ unref：持着锁、定时器该一直跑，进程仍必须自己退出。
  //   timeout 给 8s：没 unref 时事件循环被 interval 钉住，spawnSync 会把它杀掉（status=null）。
  const ex = run('exit', 8000)
  must(ex.r.status === 0, `续期中的进程没能自己退出（status=${ex.r.status}, signal=${ex.r.signal ?? '无'}）` +
    `—— heartbeat 的 setInterval 八成忘了 unref()：CLI 跑完任务会一直挂着不退出`)
  const xe = parse(ex.out, 'exit')
  must(xe.period > 0, `续期周期算成了 ${xe.period}`)

  // ④ 丢锁不静默
  const lost = run('lost')
  must(lost.r.status === 0, `lost 退出码 ${lost.r.status}：${String(lost.r.stderr || '').slice(0, 200)}`)
  const ls = parse(lost.out, 'lost')
  must(ls.lostWhy === 'taken', `锁被换成别人后 onLost 没收到 taken（lostWhy=${ls.lostWhy}）—— 丢锁不许静默`)

  // ⑤ 调用点真的用上了。函数写好但没人调，就是今天 X-14 那个病反过来再犯一次
  //   （「部件在」不等于「它在承担职责」）。transcribe 是持锁最久的那处，先只包它。
  const tb = fnBody(read('tools/look.mjs'), 'transcribe')
  must(/heartbeat\(lock/.test(tb), 'transcribe 里没有 heartbeat(lock…) —— 续期函数写了但调用点没接')
  must(/hb\.stop\(\)/.test(tb), 'transcribe 没有 hb.stop()：定时器会一直跑到进程结束')
  const iStop = tb.indexOf('hb.stop()')
  const iUnlock = tb.indexOf('unlock(lock)')
  must(iStop > 0 && iUnlock > iStop,
    'transcribe 里 hb.stop() 必须在 unlock(lock) 之前 —— 反过来的话，stop 之前那一次刷写' +
    '会落在「已经不是自己的锁」上，把新主人的 at 改掉')
  must(/if \(lost\)/.test(tb), 'transcribe 没处置 lost：丢锁后仍会把可能被污染的结果当成功返回')

  return `不续期被抢（${h.lockBeforeRelease}）｜续期守住（${rn.lockBeforeRelease}）｜进程自退 ${xe.period}ms｜丢锁回调 ${ls.lostWhy}｜调用点已接`
})

// C120（2026-11-01）：脚本文件头形态。.ps1 必须带 UTF-8 BOM，.sh 必须不带。
//   由来：三天里第三次同类事故——身份字面量自撞闸门、二进制被当文本扫、BOM 被 edit 工具剥掉。
//   三次的共同根是「只看内容语义、不看文件属性」，而内容层面的断言永远看不见这一类。
//   .ps1 无 BOM 时 PS 5.1 按 GBK 读中文 → 25 处 ParseError、整个发版脚本跑不起来；
//   .sh 带 BOM 时 shebang 失效（`#!/bin/sh` 前面多了 EF BB BF）。
//   注意：check() 是立即执行并 push 到 results，本文件末尾按 results 顺序打印并计数，
//   所以这条必须写在「汇总」循环之前，否则既不打印也不计入总数。
check('C120 脚本文件头：.ps1 带 BOM、.sh 不带（都不许靠人记得）', () => {
  const dir = join(HERE, '..', 'scripts')
  const hasBom = (p) => {
    const b = readFileSync(p)
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  }
  const names = readdirSync(dir)
  const ps1 = names.filter((n) => n.endsWith('.ps1'))
  const sh = names.filter((n) => n.endsWith('.sh'))
  // 2026-11-02（fetch-deps 合一）：原来写 must(ps1.length >= 3)。scripts 下的 .ps1 从 3 个
  //   变成 2 个（fetch-deps 那份换成了 .mjs），写死的数量立刻误红 —— 正是「判据不许写死数量」那条。
  //   改成「发版链那两个必须在」：这才是这条判据真正想守的东西（抽取器别扫空）。
  for (const need of ['release.ps1', 'sync-release.ps1']) {
    must(ps1.includes(need), `scripts 下缺 ${need} —— 形态判据的覆盖面会静默缩小`)
  }
  // .sh 在合并后确实一个都不剩了，所以「必须有对照样本」这条不能再当硬条件；
  //   hasBom 本身有没有牙，由下面两个假文件自检负责（那才是真判据）。
  const badPs1 = ps1.filter((n) => !hasBom(join(dir, n)))
  must(badPs1.length === 0, `.ps1 缺 UTF-8 BOM：${badPs1.join(', ')} —— PS 5.1 会按 GBK 读中文、报 ParseError`)
  const badSh = sh.filter((n) => hasBom(join(dir, n)))
  must(badSh.length === 0, `.sh 带了 BOM：${badSh.join(', ')} —— shebang 会失效`)

  const tmp = mkdtempSync(join(tmpdir(), 'c120-'))
  try {
    const fakePs1 = join(tmp, 'x.ps1')
    writeFileSync(fakePs1, Buffer.from('Write-Host 1\n'))
    must([fakePs1].filter((p) => !hasBom(p)).length === 1, '去 BOM 的 .ps1 副本没被认出来 —— 这条断言没牙')
    const fakeSh = join(tmp, 'x.sh')
    writeFileSync(fakeSh, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#!/bin/sh\n')]))
    must([fakeSh].filter((p) => hasBom(p)).length === 1, '带 BOM 的 .sh 副本没被认出来')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// —— 2026-11-01 第三轮复核：三条「形态兄弟」断言（C121–C123） ——
//
// 由来：这次改动本来是两处小改动（`.ps1` 根定位统一、二进制判定兜底方向），
//   但改的过程中撞出「同一个坑只修了一半」的活例——4b 早就从裸 `& node` 改成 `cmd /c`，
//   同一个文件下一段 4b-2 还是裸 `&`，注释里甚至写着「4c 早用同一写法绕过了这个坑」。
//   这就是第 7 条铁律（修一处形态问题必须顺着找兄弟）的现场。三条断言把这次的
//   三个形态约束钉住，而不是只改完算数。

// 剥 PowerShell 注释（**字符串感知**）。
//   为什么不能简单「逐行截到第一个 #」：那一行里只要有字符串含 `#`，后面的代码会被当成注释
//   一起剥掉 —— 于是
//     Write-Host "a#b"; $Root = $MyInvocation.MyCommand.Path
//   里的 $MyInvocation 被藏起来，C121 直接漏判。实测 6 个用例里错 2 个（单引号 / 双引号各一）。
//   现在按字符扫描，跟踪单引号 / 双引号 / <# 块注释三种状态；
//   注释内容替换成空格、换行原样保留，因此**字符偏移不变**（报出来的行号仍然准）。
const stripPsComment = (src) => {
  const out = []
  let i = 0
  let quote = null // "'" | '"' | null
  let block = false
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (block) {
      if (c === '#' && n === '>') { block = false; i += 2; out.push('  '); continue }
      out.push(c === '\n' ? '\n' : ' ')
      i++
      continue
    }
    if (quote) {
      out.push(c)
      if (c === quote) {
        // PowerShell 在单/双引号字符串里用两个连续引号表示一个引号
        if (n === quote) { out.push(n); i += 2; continue }
        quote = null
      }
      i++
      continue
    }
    if (c === '<' && n === '#') { block = true; i += 2; out.push('  '); continue }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') { out.push(' '); i++ }
      continue
    }
    if (c === "'" || c === '"') { quote = c; out.push(c); i++; continue }
    out.push(c)
    i++
  }
  return out.join('')
}

// C121（2026-11-01 第三轮）：三个 .ps1 的根定位必须同一种写法——一律 $PSScriptRoot。
//   由来：release.ps1 / sync-release.ps1 一直用 $PSScriptRoot，只有 fetch-deps.ps1:66 独用
//   `Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)`。
//   `-File` 调用下两者等价，所以「跑了没坏」不能证明它没问题；但 $MyInvocation.MyCommand.Path
//   在点源（`. .\fetch-deps.ps1`）或从 ISE 里调用时可以是空，`Split-Path -Parent $null` 之后的
//   $Root 会**退化成相对当前工作目录**——后面所有 `Join-Path $Root ...` 都指向别处，
//   而且不报错，只表现为「找不到 deps / 找不到 tools」。三种写法里最脆的那种，且零断言。
check('C121 .ps1 根定位统一：代码里一律 $PSScriptRoot，不许 $MyInvocation', () => {
  const ps = findPowerShell()
  if (!ps) {
    skip('C121 .ps1 根定位统一', '找不到 powershell/pwsh —— 这条只能跳，不算通过')
    return
  }
  const dir = join(ROOT, 'scripts')
  const names = readdirSync(dir).filter((n) => n.endsWith('.ps1'))
  // 2026-11-02（fetch-deps 合一）：scripts 下的 .ps1 从 3 个变 2 个。写死数量会误红，
  //   改成点名「发版链那两个必须在」—— 那才是这条判据要守的东西。
  for (const need of ['release.ps1', 'sync-release.ps1']) {
    must(names.includes(need), `scripts 下缺 ${need} —— 形态判据的覆盖面会静默缩小`)
  }

  // 判据用 PowerShell 自己的 **Tokenizer**，不看源文本。
  //
  //   为什么不用文本匹配（2026-11-01 第三轮，独立复核实测 9 条绕过里 7 条成功）：
  //   · 剥注释 + 正则：`Write-Host "a#b"; $x = $MyInvocation...` 里字符串的 # 会把后面的代码
  //     当注释一起剥掉（这条我修过，但说明「靠剥注释」这条路本身脆）；
  //   · 更要紧的：`Get-Variable -Name 'MyInvocation'` / `$ExecutionContext...` 这类写法
  //     **不出现 $MyInvocation 字面量，照样拿到同一个自动变量** —— 文本匹配永远瞎。
  //   Tokenizer 直接给 Variable 与 StringConstant 两类 token，注释根本不进 token 流，
  //   双引号插值里的 $MyInvocation 也照样是 Variable token。这才是「它到底引用了没」。
  //
  //   同时加一条**正向**要求：每个 .ps1 至少引用一次 $PSScriptRoot。
  //   只判「不许用什么」是黑名单，漏一个写法就全瞎；正向要求把它们逼回同一个入口。
  //
  //   残留（明写，不假装全覆盖）：把变量名拆成片段拼接再 Get-Variable
  //   （`Get-Variable ('$My'+'Invocation')`）静态抓不到；但那种写法要三步组合，
  //   而 C125（能不能解析）、C122（能不能跑）盯着脚本本体，不会让它悄悄成立。
  const probe = [
    `$dir = '${dir.replace(/'/g, "''")}'`,
    '$bad = @()',
    '$noPss = @()',
    'foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter *.ps1)) {',
    '  $t = $null; $e = $null',
    '  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)',
    '  if ($e.Count -gt 0) { continue }',
    '  $hit = @()',
    '  $hasPss = $false',
    '  foreach ($tk in $t) {',
    '    if ($tk.Kind -eq [System.Management.Automation.Language.TokenKind]::Variable) {',
    "      if ($tk.Text -match '^\\$MyInvocation\\b') { $hit += ('变量 ' + $tk.Text + ' @' + $tk.Extent.StartLineNumber) }",
    "      if ($tk.Text -match '^\\$PSScriptRoot\\b') { $hasPss = $true }",
    '    }',
    '    if ($tk.Kind -eq [System.Management.Automation.Language.TokenKind]::StringLiteral -or $tk.Kind -eq [System.Management.Automation.Language.TokenKind]::StringExpandable) {',
    "      if ($tk.Value -eq 'MyInvocation') { $hit += ('字符串 MyInvocation @' + $tk.Extent.StartLineNumber) }",
    '    }',
    '  }',
    '  if ($hit.Count -gt 0) { $bad += ($f.Name + " -> " + ($hit -join ", ")) }',
    '  if (-not $hasPss) { $noPss += $f.Name }',
    '}',
    "Write-Output ('ROOT|' + $bad.Count + '|' + ($bad -join ' ;; ') + '|' + $noPss.Count + '|' + ($noPss -join ', '))",
  ].join('\n')
  if (process.env.DEBUG_C121) console.error('---PROBE---\n' + probe + '\n---END---')
  const enc = Buffer.from(probe, 'utf16le').toString('base64')
  const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
    encoding: 'utf8',
    timeout: 60000,
  })
  const out = r.stdout || ''
  must(
    r.status === 0,
    `Tokenizer 探针没跑起来（rc=${r.status}）：${out.slice(0, 300)} ${(r.stderr || '').slice(0, 200)}`,
  )
  const m = /ROOT\|(\d+)\|([^|]*)\|(\d+)\|([\s\S]*)/.exec(out)
  must(m, `探针输出里没有 ROOT 行：${out.slice(0, 300)}`)
  must(
    Number(m[1]) === 0,
    `${m[1]} 个 .ps1 引用了 $MyInvocation（Tokenizer 判的，注释不算、双引号插值算）：${m[2].trim()} —— ` +
      '点源时 $MyInvocation.MyCommand.Path 可能是空，$Root 会退化成相对当前工作目录',
  )
  must(Number(m[3]) === 0, `这些 .ps1 一次都没引用 $PSScriptRoot（那它的根是从哪来的？）：${m[4].trim()}`)
})

// C122（2026-11-01 第三轮）：二进制判定必须是**三态**，读不出来不许当文本。
//   由来：sync-release.ps1 的 Test-IsBinaryFile 原来返回布尔 + `catch { return $false }`，
//   而 check-release-leak.mjs（4b）那边是 `catch { continue }`。同一个读不到的文件，
//   sync 侧「当文本继续扫」→ 假红拦死发版；4b 侧「直接跳过」→ 静默放过。方向相反。
//   统一口径：**读不出来就不当文本扫**（拿读不到的内容去正则只会造误报）。
//   但也不许把「读不出来」说成「是二进制」——前者是异常（我们并不知道它是不是文本），
//   后者是正常。所以是三态，不是两态。
//
//   为什么真跑 PowerShell 而不是读源码字符串：判定逻辑的对错只有喂输入才知道。
//   抠函数体用 AST（ParseFile → FunctionDefinitionAst），不按行号、不按正则——
//   按正则抠函数体在本仓库栽过（C47 抠不到函数体、E6-08 拿函数体做逐字比对全都失效）。
check('C122 二进制判定三态：文本 / 二进制 / 读不出来必须分开，读不出来不许当文本', () => {
  const ps = findPowerShell()
  if (!ps) {
    skip('C122 二进制判定三态', '找不到 powershell/pwsh —— 这条只能跳，不算通过（换机器跑才能验）')
    return
  }
  const target = join(ROOT, 'scripts', 'sync-release.ps1')
  must(existsSync(target), '找不到 scripts/sync-release.ps1')

  const tmp = mkdtempSync(join(tmpdir(), 'c122-'))
  try {
    const txt = join(tmp, 't.txt')
    const bin = join(tmp, 'b.bin')
    const dirPath = join(tmp, 'd')
    const missing = join(tmp, 'nope.txt')
    writeFileSync(txt, 'hello world\n')
    writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]))
    mkdirSync(dirPath)

    // 探针用 -EncodedCommand 传（UTF-16LE + base64），**不用 -File**。
    //   教训（2026-11-01 亲自踩的）：-File 跑一个 UTF-8 **无 BOM** 的临时 .ps1 时，
    //   PS 5.1 按系统 ANSI（中文 Windows = GBK）解码，本仓库路径里含中文（`007 Dsh工作区`），
    //   于是 ParseFile 拿到的是被 GBK 打碎的路径 → 报「文件不存在」→ AST 为空 → 断言体拿到
    //   0 个函数、报的却是「找不到 Test-IsBinaryFile」。看着像产品缺陷，其实是**测试脚手架**的错。
    //   -EncodedCommand 把脚本当命令行参数传 UTF-16，不经过文件编码这一层，也不会有 BOM 问题。
    // 真仓库全量清单（进包文件）：验「本仓库没有任何文件被误判成二进制」。
    //
    //   为什么需要这条（2026-11-01 第三轮，独立复核提的两条已知限制）：
    //   ① UTF-16LE 文本每个字符夹 0x00 ⇒ 会被判 bin；
    //   ② 前 8192 字节无 NUL、之后才有 NUL 的文件 ⇒ 会被判 text（窗口只读 8KB）。
    //   两条都是设计取舍（本仓库强制 UTF-8；png 的文件头就有 NUL），**不修函数**。
    //   但不修就得有断言盯着结果：哪天有人塞个 UTF-16 文件进 files，它会被静默当二进制跳过
    //   （现在至少有 [skip] 点名，但点名不等于有人看）。
    //   这条直接验「进包的每个文件都被判对族」—— 见下面「按族判」那段（原来按文件名写死，会误红）。
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const targets = []
    for (const entry of pkg.files || []) {
      const rel1 = String(entry).replace(/[\\/]+$/, '').replace(/\\/g, '/')
      if (!rel1) continue
      const abs = join(ROOT, rel1)
      if (!existsSync(abs)) continue
      if (statSync(abs).isDirectory()) {
        for (const f of readdirSync(abs)) {
          const sub = join(abs, f)
          if (statSync(sub).isFile()) targets.push(sub)
        }
      } else {
        targets.push(abs)
      }
    }
    must(targets.length >= 20, `进包文件只展开出 ${targets.length} 个（应 ≥20），这条断言的覆盖面不对`)

    const probe = [
      '$tokens = $null; $errors = $null',
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${target.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)`,
      "if ($errors.Count -gt 0) { Write-Output ('ERR|parse=' + $errors[0].Message); exit 3 }",
      "$fns = @($ast.FindAll({ param($n) ($n -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($n.Name -eq 'Test-IsBinaryFile') }, $true))",
      "if ($fns.Count -ne 1) { Write-Output ('ERR|count=' + $fns.Count); exit 3 }",
      'Invoke-Expression $fns[0].Extent.Text',
      `Write-Output ('RESULT|' + (Test-IsBinaryFile '${txt.replace(/'/g, "''")}') + '|' + (Test-IsBinaryFile '${bin.replace(/'/g, "''")}') + '|' + (Test-IsBinaryFile '${dirPath.replace(/'/g, "''")}') + '|' + (Test-IsBinaryFile '${missing.replace(/'/g, "''")}'))`,
      // 第二段：真仓库全量（同一个进程，函数已在上面 Invoke-Expression 定义好）
      '$list = @(' + targets.map((p) => `'${p.replace(/'/g, "''")}'`).join(',') + ')',
      '$bins = @(); $texts = @(); $unread = @()',
      "foreach ($p in $list) { $k = Test-IsBinaryFile $p; if ($k -eq 'bin') { $bins += $p } elseif ($k -eq 'text') { $texts += $p } else { $unread += $p } }",
      "Write-Output ('BINS|' + $bins.Count + '|' + ($bins -join '|'))",
      "Write-Output ('TEXTS|' + $texts.Count + '|' + ($texts -join '|'))",
      "Write-Output ('UNREAD|' + $unread.Count + '|' + ($unread -join '|'))",
    ].join('\n')
    const enc = Buffer.from(probe, 'utf16le').toString('base64')

    const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      encoding: 'utf8',
      timeout: 60000,
    })
    // 只从 stdout 取结果（2026-11-01 第三轮实测）：`-EncodedCommand` 下 PowerShell 会把 progress
    // （「Preparing modules for first use.」）以 CLIXML 序列化到 stderr；把两边拼起来解析，
    // 那段 `<Objs ...>` 会正好插在 stdout 内容中间，把 BINS 行的两个路径劈成两半。
    const out = r.stdout || ''
    must(
      r.status === 0,
      `探针脚本没跑起来（rc=${r.status}）：${out.trim().slice(0, 300)} ${(r.stderr || '').slice(0, 200)}`,
    )
    const m = /RESULT\|([a-z]+)\|([a-z]+)\|([a-z]+)\|([a-z]+)/.exec(out)
    must(m, `探针输出里没有 RESULT 行：${out.trim().slice(0, 300)}`)
    const [, gotText, gotBin, gotDir, gotMissing] = m
    must(gotText === 'text', `普通文本被判成 ${gotText}（应为 text）—— 合法文本会被当二进制跳过，等于整份文件的检查被悄悄关掉`)
    must(gotBin === 'bin', `含 NUL 的文件被判成 ${gotBin}（应为 bin）`)
    must(
      gotDir === 'unreadable',
      `目录被判成 ${gotDir}（应为 unreadable）—— 这正是原来 catch { return \$false } 的分叉点：读不出来被当文本，Select-String 扫目录会报错`,
    )
    must(gotMissing === 'unreadable', `不存在的文件被判成 ${gotMissing}（应为 unreadable）`)

    // 结果二：真仓库全量 —— **按族判，不按文件名**（2026-11-02 00:13 定的）。
    //
    //   原来写的是 `wantBins = ['docs/architecture.png', 'docs/workflow.png']` 并要求**恰好相等**。
    //   那是一条会**误红**的判据：以后往 files 里加任何二进制（再放一张图、一个字体、一个 wasm）
    //   它立刻红，而那是完全合法的改动。误红的判据比没有判据更贵 —— 下一个人会去改 wantBins
    //   让它变绿，改着改着这条就退化成「记录当前有哪些图」的清单，它本来要守的东西
    //   （二进制不许被当文本扫）就没人守了。
    //   改成按**扩展名族**判：
    //     · 反向：凡是二进制族的，必须判 bin（漏一个 ⇒ 它会被拿文本正则扫，随机字节撞盘符）
    //     · 正向：凡是文本族的，必须判 text（错一个 ⇒ 合法文本被当二进制跳过，整份文件不检查）
    //     · 覆盖面：至少各有一个（防「目录里根本没有这类文件」时空转绿）
    const rows = out.split(/\r?\n/)
    const relOf = (p) => p.replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/') + '/', '')
    const pick = (tag) => {
      const line = rows.find((l) => l.startsWith(`${tag}|`))
      must(line, `探针输出里没有 ${tag} 行：${out.slice(0, 300)}`)
      const parts = line.trim().split('|')
      return { n: Number(parts[1]), list: parts.slice(2).filter(Boolean).map(relOf).sort() }
    }
    const bins = pick('BINS')
    const texts = pick('TEXTS')
    const unread = pick('UNREAD')

    // 每个进包文件都必须被分到三类之一：多一个、少一个都说明探针和清单对不上
    const seen = [...bins.list, ...texts.list, ...unread.list]
    must(
      seen.length === targets.length,
      `探针分类了 ${seen.length} 个文件、清单里是 ${targets.length} 个 —— 有条目漏判或重复`,
    )
    must(bins.n >= 1, '进包文件里一个二进制都没判出来 —— 这条断言在空转（docs 下应有 png）')
    must(texts.n >= 1, '进包文件里一个文本都没判出来 —— 这条断言在空转')
    must(unread.n === 0, `进包文件里有 ${unread.n} 个读不出来：${unread.list.join(', ')} —— 读不出来就没扫，按未通过处理`)

    // 族定义：多列的扩展名只会更严，不会误红（下面两条各自验的就是「这一族全对」）。
    //   .py / .yml 是清单之外补的：它们同样是文本，进包里确实有（tools/ocr.py、cordis.patch.yml）。
    const BIN_EXT = /\.(png|jpe?g|gif|webp|woff2?|wasm|pdf)$/i
    const TEXT_EXT = /\.(mjs|js|json|md|txt|ps1|sh|py|yml|yaml)$/i
    const badBin = seen.filter((p) => BIN_EXT.test(p) && !bins.list.includes(p))
    must(
      badBin.length === 0,
      `这些文件按扩展名是二进制、却没被判成 bin：${badBin.join(', ')} —— ` +
        '它们会被拿文本正则扫（png 压缩数据里的随机字节撞盘符，发版在 sync 阶段 exit 1）',
    )
    const badText = seen.filter((p) => TEXT_EXT.test(p) && !texts.list.includes(p))
    must(
      badText.length === 0,
      `这些文件按扩展名是文本、却没被判成 text：${badText.join(', ')} —— ` +
        '合法文本被当二进制跳过，等于整份文件的检查被悄悄关掉（UTF-16？前 8KB 无 NUL 但在窗口外有 NUL？）',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// C123（2026-11-01 第三轮）：闸门脚本调 node 一律走 `cmd /c`，不许裸 `&`。
//   由来：`$ErrorActionPreference = 'Stop'` 下，`& node x.mjs` 一旦让 node 往 stderr 写
//   （console.error / uncaught exception），PS 会抛 NativeCommandError ⇒ 调用点之后的
//   `Say $out; Fail "..."` **一句都不执行**，rc 退化成 1（设计的 2 丢了），操作员看不到任何提示。
//   4b 在 2026-11-01 修过这一条（`8f84eac`），但同一文件下一段 4b-2 还是裸 `&`——
//   修一处没顺着找兄弟。这条断言扫全部 `.ps1`，把这个坑一次堵死。
check('C123 闸门调 node 一律走 cmd /c：裸 & 会被 Stop 吃掉 Fail 与退出码', () => {
  // 只看 `&` **后面那一段**，不看整行。
  //
  //   为什么（2026-11-01 第三轮，独立复核指出两处）：
  //   · 原实现「整行含 node 就算」会误判：`& ./run.bat --node` 里 `--node` 是个开关，
  //     不是调 node，却被当成违规；
  //   · 原实现「整行含 cmd /c 就放过」会漏判：`& node ./x.mjs --cmd /c` 里别处的
  //     `cmd /c` 把真违规赦免了。
  //   改成逐行找每个 `&`，取它之后的子串，看**紧跟的第一个词**是不是 node。
  //
  //   残留（明写）：`$ne='node'; & $ne x` 这种变量间接，静态抓不到。
  const findBareNode = (code) =>
    code
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => {
        let idx = line.indexOf('&')
        while (idx >= 0) {
          const tail = line.slice(idx + 1).trimStart()
          // 紧跟 node（允许引号；允许 node.exe）
          if (/^["']?node(\.exe)?["']?(\s|$)/i.test(tail)) return true
          idx = line.indexOf('&', idx + 1)
        }
        return false
      })
      .map(({ no }) => `:${no}`)

  const dir = join(ROOT, 'scripts')
  const names = readdirSync(dir).filter((n) => n.endsWith('.ps1'))
  // 2026-11-02（fetch-deps 合一）：scripts 下的 .ps1 从 3 个变 2 个。写死数量会误红，
  //   改成点名「发版链那两个必须在」—— 那才是这条判据要守的东西。
  for (const need of ['release.ps1', 'sync-release.ps1']) {
    must(names.includes(need), `scripts 下缺 ${need} —— 形态判据的覆盖面会静默缩小`)
  }
  const hits = []
  for (const n of names) {
    const bad = findBareNode(stripPsComment(readFileSync(join(dir, n), 'utf8')))
    if (bad.length) hits.push(`${n}${bad.join(',')}`)
  }
  must(
    hits.length === 0,
    `这些地方用裸 & 调 node（node 一走 stderr 就抛 NativeCommandError，后面的 Say/Fail 全不执行、rc 也错）：${hits.join(' | ')}`,
  )

  // 反面对照 4 条：必须抓到的两条、必须放过的两条。
  //   少了「必须放过」那两条，判据可以靠「把一切都判违规」通过 —— 那种断言只会被删掉。
  must(findBareNode('    $out = (& node $s --dir $R 2>&1) -join "`n"').length === 1, '裸 & node 探针没被抓到 —— 这条断言没牙')
  must(
    findBareNode('    $out = (cmd /c "node `"$s`" --dir `"$R`" 2>&1") -join "`n"').length === 0,
    'cmd /c 写法被误判 —— 判据太宽',
  )
  must(
    findBareNode('    & ./run.bat --node').length === 0,
    '把 `--node` 这种**值是 node 的开关**当成调 node 了 —— 误判（独立复核 2026-11-01 实测的那种）',
  )
  must(
    findBareNode('    & node ./x.mjs --cmd /c').length === 1,
    '同一行别处出现 cmd /c 就放过了裸 & node —— 漏判（独立复核 2026-11-01 实测的那种）',
  )
})

// C124（2026-11-01 第三轮）：敏感信息扫描的「没扫」必须点名 —— 两个实现都要。
//   由来：sync-release.ps1 的 AssertNoPaths 与 check-release-leak.mjs（4b）是同一件事的两个实现
//   （扫 files 白名单的内容）。而「清单里有、盘上没有」与「读不出来」这两种情况，
//   两边原来都写 `continue` 静默跳过 —— 扫描面小了一块，脚本照样说「扫描通过」。
//   改完两边职责仍有别（sync 侧是红，4b 侧只点名），但**都必须让人看得见**。
//   这条只在 4b 上验（sync 侧的行为由 C115 端到端管）：造一个 files 里列了不存在文件的目录，
//   要求 4b 自己说出来；再补齐文件，要求它别乱报（判据太宽会被噪声淹没，等于没有）。
check('C124 敏感信息扫描的「没扫」必须点名：files 列了但盘上没有，4b 要报出来', () => {
  const script = join(ROOT, 'scripts', 'check-release-leak.mjs')
  must(existsSync(script), '找不到 scripts/check-release-leak.mjs —— C124 要验的对象不在了')
  const tmp = mkdtempSync(join(tmpdir(), 'c124-'))
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.1', files: ['a.txt', 'README.md'] }))
    writeFileSync(join(tmp, 'README.md'), '# x\n')
    // a.txt 故意不造 —— 模拟「清单与实物不符」
    const r = spawnSync(process.execPath, [script, '--dir', tmp], { encoding: 'utf8', timeout: 60000 })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    must(r.status === 0, `4b 对着造出来的目录跑出了非 0（rc=${r.status}）：${out.slice(0, 300)}`)
    must(/\[warn\]/.test(out), `files 里列了不存在的 a.txt，4b 一声不吭 —— 「没扫」和「扫过没问题」又长得一样了：${out.slice(0, 300)}`)
    must(/a\.txt/.test(out), `4b 打了 warn 但没点名 a.txt（点名才叫点名）：${out.slice(0, 300)}`)

    // 反向：文件齐了不许刷 warn。正常发版日志天天挂一堆 warn，就没人再看 warn 了。
    writeFileSync(join(tmp, 'a.txt'), 'hello\n')
    const r2 = spawnSync(process.execPath, [script, '--dir', tmp], { encoding: 'utf8', timeout: 60000 })
    const out2 = `${r2.stdout || ''}${r2.stderr || ''}`
    must(r2.status === 0, `第二次跑 rc=${r2.status}：${out2.slice(0, 300)}`)
    must(!/\[warn\]/.test(out2), `文件都齐了还报 warn —— 判据太宽，正常情况会被噪声淹没：${out2.slice(0, 300)}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// C124b（2026-11-02）：4b 遇到**读不出来**的文件必须变红，而不是「✓ 通过 + exit 0」。
//
//   为什么单开一条、不塞进 C124：C124 验的是相反的结论（清单缺项 ⇒ 只 warn、rc 必须 0），
//   这条要求 rc 必须 2。同一条 check 里同时断言两个相反结论，红的时候分不清是哪个塌了。
//   更要紧的是**跳过粒度**：C124b 要用平台专有手段造「存在但读不出来」，
//   手段不可用时（非 Windows 无 chmod 权限 / root / icacls 缺失）只能 skip。
//   混进 C124 的话，这一个 skip 会把 C124 里已经能跑的 absent 判据一起吞掉。
//
//   这条盯的是 2026-11-02 刚改的那段（scripts/check-release-leak.mjs 的 unreadable 分支）：
//   原来只 `[warn]` 然后照样 `✓ 扫描通过` + exit 0 —— 一个读不出来的文件换来一句「通过了」，
//   而这是发布链上唯一看内容的闸。改成红之后，行为没有常驻断言盯着，只有一次手工扰动。
//
//   造法：a.txt 存在，把当前用户的读权限 deny 掉（Windows: icacls /deny；POSIX: chmod 000）。
//   为什么只 deny (R) 就够：4b 的 listTargets 先 existsSync + statSync 判断是不是目录，
//   deny 的是读数据、不是读属性，所以 statSync 照常成功、readFileSync 抛 EPERM ——
//   夹具落在「存在但读不出来」这个精确状态上，而不是「文件不见了」（那是 C124 的现场）。
//
//   反向也验：恢复权限后必须回到 rc=0 且不许出现 ✗ —— 否则「把所有情况都判红」也能过这条。
//   **这条断言的余量只有一句话的宽度**：拿「HARD 命中」造一个 rc=2 + ✗ + 点名 a.txt + 无 ✓ 的现场，
//   前五条判据全满足，只有 UNREADABLE_NOTE 这一条挡住（2026-11-02 实测）。
//   所以把它抽成常量：名字本身就是提示 —— 删它 / 改它等于让「别的 rc=2」冒充「读不出来」。
const UNREADABLE_NOTE = '读不出来'

check('C124b 4b 遇到读不出来的文件必须变红：点名 + exit 2，且不许说「通过」', () => {
  const script = join(ROOT, 'scripts', 'check-release-leak.mjs')
  must(existsSync(script), '找不到 scripts/check-release-leak.mjs —— C124b 要验的对象不在了')

  const isWin = process.platform === 'win32'
  const user = process.env.USERNAME || ''
  if (isWin && !user) {
    skip('C124b 读不出来必须变红', 'Windows 上拿不到 USERNAME —— 造不出 deny ACE，这条只能跳（不算通过）')
    return
  }

  const tmp = mkdtempSync(join(tmpdir(), 'c124b-'))
  const target = join(tmp, 'a.txt')
  // denied 是幂等开关：中途 return / 抛错 / finally 都会再调一次 undoDeny()，
  //   重复 remove:d 无害，但少调一次就会在 tmpdir 里留一个读不掉的文件。
  let denied = false
  const undoDeny = () => {
    if (!denied) return
    denied = false
    if (isWin) {
      // -EncodedCommand 那套在这里用不上：icacls 是原生 exe，参数走 argv 不经 PowerShell 解析，
      //   所以我们不把中文路径交给 PS 的 GBK 解码器（这个仓库的已知坑）。
      spawnSync('icacls', [target, '/remove:d', user], { encoding: 'utf8', timeout: 60000 })
    } else {
      try { chmodSync(target, 0o644) } catch { /* 文件可能已被删；恢复失败不该盖住真错 */ }
    }
  }

  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.1', files: ['a.txt', 'README.md'] }))
    writeFileSync(target, 'hello\n')
    writeFileSync(join(tmp, 'README.md'), '# x\n')

    // —— 施加「存在但读不出来」——
    if (isWin) {
      const d = spawnSync('icacls', [target, '/deny', `${user}:(R)`], { encoding: 'utf8', timeout: 60000 })
      if (d.status !== 0) {
        // 夹具建不起来（icacls 不在 / 策略不允许）—— 跳，不是通过。
        skip('C124b 读不出来必须变红', `icacls /deny 没成功（rc=${d.status}）：${(d.stderr || '').trim().slice(0, 200)}`)
        return
      }
      denied = true
    } else {
      try { chmodSync(target, 0o000) } catch (e) {
        skip('C124b 读不出来必须变红', `chmod 000 失败（${e.code}）—— 造不出夹具，这条只能跳（不算通过）`)
        return
      }
      denied = true
    }

    // 夹具自检：**先确认真的读不出来**，再看 4b 的反应。
    //   少了这一步，夹具没生效（比如以 root / 带备份特权跑，deny 挡不住读）时，
    //   a.txt 会被正常扫过 —— 那时 4b 说「通过」反而是对的，而这条断言会红得莫名其妙。
    //   有了它，红的原因能落到「环境特权」上，也能防止「夹具没生效但 status 恰好是 2」这种假绿。
    let readable = true
    try { readFileSync(target) } catch { readable = false }
    if (readable) {
      skip('C124b 读不出来必须变红', '夹具没生效：deny/chmod 之后仍读得出来（多半是特权身份在跑）—— 这条只能跳（不算通过）')
      return
    }

    const r = spawnSync(process.execPath, [script, '--dir', tmp], { encoding: 'utf8', timeout: 60000 })
    // 4b 的失败输出走 console.error ⇒ stderr，成功走 stdout。必须合起来看，只看 stdout 会漏掉全部失败信息。
    const out = `${r.stdout || ''}${r.stderr || ''}`
    const head = `rc=${r.status} out=${out.slice(0, 300)}`

    must(r.status === 2, `有文件读不出来，4b 却返回 rc=${r.status}（必须 2）：${head}`)
    // 实际字样是 `✗ 敏感信息扫描：1 个文件读不出来` —— 代码里没有 `[fail]` 这个标签，
    //   所以这里认 ✗ 与「读不出来」，不是猜的标签名。
    must(/✗/.test(out), `有文件读不出来，4b 没打 ✗：${head}`)
    // 常量本身也守一道：它被改成空串 / 单字时 `includes` 会恒真，这条判据静默失效 ——
    //   而它正是唯一挡「别的 rc=2 冒充读不出来」的那一条。
    must(UNREADABLE_NOTE.length >= 3, `UNREADABLE_NOTE 被改成了 ${JSON.stringify(UNREADABLE_NOTE)} —— 太短会让下一条判据恒真`)
    must(out.includes(UNREADABLE_NOTE), `4b 打红了但没说清原因（「${UNREADABLE_NOTE}」不见了）：${head}`)
    must(/a\.txt/.test(out), `4b 打红了但没点名 a.txt —— 不点名等于让人自己去猜哪个文件没看：${head}`)
    // 这条是本条的真正重点：失败时**绝不许**出现宣告通过的那两句。
    //   注意不能用「不许出现『通过』」——4b 的失败文案自己是「（按未通过处理）」，
    //   那样写会让这条断言永远红（我实测过文案）。禁词只能是断言句本身。
    must(!/✓/.test(out), `有文件读不出来，4b 还打了 ✓：${head}`)
    must(!/敏感信息扫描通过/.test(out), `有文件读不出来，4b 还说了「敏感信息扫描通过」：${head}`)

    // —— 反向：恢复权限后必须回到干净 ——
    undoDeny()
    const r2 = spawnSync(process.execPath, [script, '--dir', tmp], { encoding: 'utf8', timeout: 60000 })
    const out2 = `${r2.stdout || ''}${r2.stderr || ''}`
    must(r2.status === 0, `权限恢复后 4b 仍返回 rc=${r2.status}（必须 0，否则等于「把一切都判红」也算通过）：${out2.slice(0, 300)}`)
    must(!/✗/.test(out2), `权限恢复后还打 ✗：${out2.slice(0, 300)}`)
    must(/敏感信息扫描通过/.test(out2), `权限恢复后 4b 没说「扫描通过」—— 反向判据也在验它确实扫了：${out2.slice(0, 300)}`)
  } finally {
    undoDeny()
    rmSync(tmp, { recursive: true, force: true })
  }
})

// C125（2026-11-01 第三轮）：三个 .ps1 必须能被 PowerShell 解析（0 个语法错误）。
//   为什么还要这条 —— C120 查 BOM、C121 查根定位、C123 查调用方式，**全是文本匹配**：
//   脚本哪怕语法全错，这三条照样绿（它们只是 grep）。C122 也只解析 sync-release.ps1 一个。
//   这次的现场：改 sync-release.ps1 时我一度以为改坏了语法，跑到 PowerShell 里 ParseFile 才发现
//   是探针自己的编码问题 —— 那一刻仓库里**没有任何断言**能回答「这个脚本还能不能跑」。
//   这条是**结果**判据：让 PS 自己说能不能解析。BOM 缺失（按 GBK 解出乱码 → 引号被吞）、
//   括号不配对、字符串未闭合，它全抓得住；而 C120 只是它的一个（更早报警的）手段。
check('C125 三个 .ps1 必须能被 PowerShell 解析（0 个语法错误）', () => {
  const ps = findPowerShell()
  if (!ps) {
    skip('C125 .ps1 语法可解析', '找不到 powershell/pwsh —— 这条只能跳，不算通过（换机器跑才能验）')
    return
  }
  const dir = join(ROOT, 'scripts')
  const names = readdirSync(dir).filter((n) => n.endsWith('.ps1'))
  // 2026-11-02（fetch-deps 合一）：scripts 下的 .ps1 从 3 个变 2 个。写死数量会误红，
  //   改成点名「发版链那两个必须在」—— 那才是这条判据要守的东西。
  for (const need of ['release.ps1', 'sync-release.ps1']) {
    must(names.includes(need), `scripts 下缺 ${need} —— 形态判据的覆盖面会静默缩小`)
  }
  // 同样走 -EncodedCommand：脚本目录路径含中文，-File 会被 GBK 解码打碎（C122 那段踩过）
  const probe = [
    `$dir = '${dir.replace(/'/g, "''")}'`,
    '$bad = @()',
    'foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter *.ps1)) {',
    '  $t = $null; $e = $null',
    '  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)',
    "  if ($e.Count -gt 0) { $bad += ($f.Name + ' → ' + $e.Count + ' 处: ' + $e[0].Message) }",
    '}',
    "Write-Output ('PARSE|' + $bad.Count + '|' + ($bad -join ' ;; '))",
  ].join('\n')
  const enc = Buffer.from(probe, 'utf16le').toString('base64')
  const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
    encoding: 'utf8',
    timeout: 60000,
  })
  const out = r.stdout || ''
  must(
    r.status === 0,
    `语法检查探针没跑起来（rc=${r.status}）：${out.slice(0, 300)} ${(r.stderr || '').slice(0, 200)}`,
  )
  const m = /PARSE\|(\d+)\|([\s\S]*)/.exec(out)
  must(m, `探针输出里没有 PARSE 行：${out.slice(0, 300)}`)
  must(
    Number(m[1]) === 0,
    `${m[1]} 个 .ps1 有语法错误（PowerShell 自己解析出来的，不是猜的）：${m[2].trim()}`,
  )
})

// ── C126：git 推送段必须局部降级（2026-11-02 发 0.4.3 的现场）────────────────
//   现场：第 6 步 `& git push origin main 2>&1 | Out-Null` 在全局 $ErrorActionPreference="Stop"
//   下，把 git 写在 **stderr** 的进度行当成终止错误抛出 → 脚本断在第 6 步，`git tag -a` 与
//   推 tag 都没跑，而远端 main 其实**已经推成功了**。断点位置与实际结果相反，比「push 失败」
//   更难判。修法是这一段局部切 Continue、finally 还原。
//   这条钉两件事：别把降级改回去；新增的 git 调用也别指望全局 Stop。
check('C126 git 推送段必须局部降级成 Continue（Stop 会把 git 的 stderr 当终止错误）', () => {
  const p = join(ROOT, 'scripts', 'release.ps1')
  must(existsSync(p), '找不到 scripts/release.ps1')
  const src = read('scripts/release.ps1')
  // 抽第 6 段：`# ---- 6. git` 到 `[skip] git`（段尾），不用行号，段落挪位置也不失效
  const i0 = src.indexOf('# ---- 6. git')
  must(i0 >= 0, 'release.ps1 里找不到第 6 段标记（# ---- 6. git）—— 段落结构变了，先看这条')
  const i1 = src.indexOf('[skip] git', i0)
  must(i1 > i0, '第 6 段找不到结尾标记（[skip] git）')
  const segRaw = src.slice(i0, i1)
  // 注释里有反例原文（`& git push origin main 2>&1`、`git tag`），直接对整段做正则会
  //   把注释当代码：既可能让「第一个 git 调用」判早，也可能让「tag 存在」假绿。
  const seg = segRaw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

  const iCont = seg.indexOf("$ErrorActionPreference = 'Continue'")
  must(
    iCont >= 0,
    '第 6 段没有局部切 Continue —— 全局 Stop 下 git 写 stderr 会抛 NativeCommandError，脚本会断在 push 之后、tag 之前',
  )
  // 切 Continue 必须早于段内第一个 git 调用
  const iFirstGit = seg.search(/&\s*git\s/)
  must(iFirstGit < 0 || iCont < iFirstGit, 'Continue 切在第一个 git 调用之后，等于没切')
  // 降级之后必须还原，否则泄漏到调用方
  must(
    /\$ErrorActionPreference\s*=\s*\$eapPrev/.test(seg),
    '段内有降级但没有还原 $ErrorActionPreference —— 泄漏到调用方，后面任何原生命令写 stderr 都会炸',
  )
  // 降级段里最危险的不是「push 失败」，是「push 成功但后续步骤被跳过」：
  //   所以 tag 步骤必须真的在段里存在，否则降级只是让脚本更安静地漏掉一步。
  must(/&\s*git\s+tag\s+-a/.test(seg), '第 6 段里没有 git tag -a —— push 之后打 tag 的那一步不见了')
  must(/&\s*git\s+push\s+origin\s+["']?v/.test(seg), '第 6 段里没有推 tag 的那一步（git push origin v…）')
})

// —— 陌生人内容护栏（2026-11-02 定稿四条）——
// 这批修的是两件事：① 「数据形态（--format json/srt/md/txt）下护栏根本不跑」——warnForeign 在
//   dataOnly 的 return 之后；② 「提示让模型绕过自家围栏」——展示层加了 source tag + 围栏，
//   而 2451 行让模型 read 的落盘文件是**纯正文**，那条最短的路把标记绕过去了。
//
// 判据为什么不写成「scanInjection 返回什么」：那只能证明正则还在。出问题的地方是「跑没跑」，
//   所以 C127/C128 **真跑命令**看 stdout / stderr / 落盘文件；C129/C130 要喂一批语料看命中率，
//   用「把定义段原样切出来 + 探针尾巴」的办法（切的是真代码，不是复刻件）。
const GUARD_BASE = 'e889822' // 加这组护栏之前的基线：逐字节对比要拿它的 look.mjs 跑一遍
const GUARD_TAIL = readFileSync(join(HERE, 'fixtures', 'guard-probe-tail.mjs'), 'utf8')

/** 把 look.mjs 里护栏的定义段原样切出来，拼上探针尾巴跑。返回 [{name, long, short}] */
function guardProbe(cases, label) {
  const src = read('tools/look.mjs')
  const i = src.indexOf('const INVISIBLE_RES = [')
  must(i > 0, `${label}：tools/look.mjs 里找不到 INVISIBLE_RES —— 段落结构变了，先看这条`)
  const j = src.indexOf('const WARN_STATE =', i)
  must(j > i, `${label}：找不到 WARN_STATE 作为切段终点 —— 切出来会是半截代码`)
  const seg = src.slice(i, j)
  // 切到空处时探针会「零命中」全绿 —— 那正是最坏的假绿，所以先验切出来的段里该有的都在
  for (const need of ['const SUSPECT_ALL', 'const SUSPECT_HIGH', 'function scanInjection']) {
    must(seg.includes(need), `${label}：切出来的段里没有 ${need}（切到空处了）`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'bw-guard-'))
  try {
    const f = join(dir, 'guard-probe.mjs')
    writeFileSync(f, seg + '\n' + GUARD_TAIL, 'utf8')
    const r = spawnSync(process.execPath, [f], {
      env: { ...process.env, BW_GUARD_CASES: JSON.stringify(cases) },
      encoding: 'utf8', timeout: 60000,
    })
    must(r.status === 0, `${label}：探针跑不起来 rc=${r.status} ${tail(r.stderr)}`)
    const m = /__GUARD_JSON__(\[[\s\S]*\])/.exec(r.stdout || '')
    must(m, `${label}：探针没吐结果 ${tail(r.stdout)}`)
    return JSON.parse(m[1])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

check('C127 --format json 下护栏真的跑：命中带 _untrusted，未命中逐字节不变（数据形态曾是空白区）', () => {
  const NAME = 'C127 json 形态的护栏'
  if (!needMock(NAME)) return
  if (!mockInject) { skip(NAME, `带注入的 mock 起不来：${mockInjectWhy}`); return }
  const cache = mockCache('gw-json')
  const args = ['comments', MOCK_BV, '--format', 'json']

  // ① 有注入：JSON 合法 + _untrusted.hits 非空 + stderr 有警告
  const rInj = runLookMock(args, mockEnvOn(mockInject, { BILI_WATCH_CACHE: cache }))
  must(rInj.status === 0, `带注入的 comments --format json 应 rc=0：rc=${rInj.status} ${tail(rInj.stderr)}`)
  let pInj = null
  try { pInj = JSON.parse(rInj.stdout) } catch { pInj = null }
  must(pInj && typeof pInj === 'object', `stdout 不是合法 JSON（数据契约破了）：${tail(rInj.stdout, 200)}`)
  must(Array.isArray(pInj.items) && pInj.items.length > 0, 'payload.items 没了 —— 为了加标记把数据弄丢了')
  must(pInj._untrusted, '带注入的评论没有 _untrusted —— 标记没跟着数据走，下游收到的是一段没标记的用户内容')
  must(Array.isArray(pInj._untrusted.hits) && pInj._untrusted.hits.length > 0, '_untrusted.hits 是空的')
  must(pInj._untrusted.source === 'bilibili' && pInj._untrusted.kind === 'comments',
    `_untrusted 的 source/kind 不对：${JSON.stringify(pInj._untrusted)}`)
  must(/疑似指令/.test(rInj.stderr || ''), `stderr 没有警告（终端这条路也丢了）：${tail(rInj.stderr)}`)

  // ①-b 同一类 bug 的**第二处实现**：sub --format json 走的是 printText 的 dataOnly 分支，
  //   和 comments 的 json 分支是两份代码。第一版 C127 只验了 comments —— 扰动直接照出来：
  //   把 decorateData 的 json 分支删掉、把 printText 的 dataOnly 退回直接吐 full，C127 全绿。
  //   这不是判据「没牙」，是**判据在验错对象**（11-02 那条：比「不够真」更隐蔽）。
  //   用独立缓存目录：stderr 警告按 bv 跨命令去重（7-8），复用上面那个 cache 的话
  //   comments 那次已经把这两类记进 injection-warned.json，sub 这边就一个字都不打 ——
  //   那不是「没警告」，是「同一个视频不重复警告」。判据要验的是「这条路上到底跑没跑」。
  const rSub = runLookMock(['sub', MOCK_BV, '--format', 'json'], mockEnvOn(mockInject, { BILI_WATCH_CACHE: mockCache('gw-sub') }))
  must(rSub.status === 0, `带注入的 sub --format json 应 rc=0：rc=${rSub.status} ${tail(rSub.stderr)}`)
  let pSub = null
  try { pSub = JSON.parse(rSub.stdout) } catch { pSub = null }
  must(pSub && typeof pSub === 'object', `sub --format json 的 stdout 不是合法 JSON：${tail(rSub.stdout, 200)}`)
  must(Array.isArray(pSub.cues) && pSub.cues.length > 0, 'payload.cues 没了 —— 为了加标记把数据弄丢了')
  must(pSub._untrusted && Array.isArray(pSub._untrusted.hits) && pSub._untrusted.hits.length > 0,
    'sub --format json 没有 _untrusted —— printText 的 dataOnly 这条路上的护栏没跑到')
  must(/疑似指令/.test(rSub.stderr || ''), `sub --format json 的 stderr 没有警告：${tail(rSub.stderr)}`)
  const rSubOk = runLookMock(['sub', MOCK_BV, '--format', 'json'], mockEnv({ BILI_WATCH_CACHE: mockCache('gw-subok') }))
  must(!/_untrusted/.test(rSubOk.stdout || ''), '正常字幕的 sub --format json 也带上了 _untrusted（恒定加字段）')

  // ② 没注入：不许出现 _untrusted
  const rOk = runLookMock(args, mockEnv({ BILI_WATCH_CACHE: cache }))
  must(rOk.status === 0, `未命中的 comments --format json 应 rc=0：rc=${rOk.status} ${tail(rOk.stderr)}`)
  must(!/_untrusted/.test(rOk.stdout || ''), '没有命中却加了 _untrusted —— 正常内容被改了，下游会莫名收到扩展字段')
  must(!/疑似指令/.test(rOk.stderr || ''), `正常评论却报了疑似指令（误报）：${tail(rOk.stderr)}`)

  // ③ 与改动前逐字节比。为什么非要真跑一遍旧版：这条守住的是「没命中时一个字节都不许变」，
  //   而那是个**全等**断言 —— 「字段都在」「结构一样」这类弱断言全绿时它仍可能已经破了。
  //   （11-02 那条教训：机制上变了 ≠ 输出会变，判差异要落到逐字节比 stdout/stderr。）
  let oldOut = ''
  let oldWhy = ''
  try {
    const oldRoot = mkdtempSync(join(tmpdir(), 'bw-oldlook-'))
    mkdirSync(join(oldRoot, 'tools'), { recursive: true })
    const oldSrc = execFileSync('git', ['show', `${GUARD_BASE}:tools/look.mjs`], { cwd: ROOT, encoding: 'utf8' })
    for (const f of readdirSync(HERE)) if (f.endsWith('.mjs')) copyFileSync(join(HERE, f), join(oldRoot, 'tools', f))
    writeFileSync(join(oldRoot, 'tools', 'look.mjs'), oldSrc, 'utf8')
    try { symlinkSync(join(ROOT, 'lib'), join(oldRoot, 'lib'), 'junction') } catch {}
    try { symlinkSync(join(ROOT, 'node_modules'), join(oldRoot, 'node_modules'), 'junction') } catch {}
    const ro = spawnSync(process.execPath, ['--import', MOCK_PRELOAD, join(oldRoot, 'tools', 'look.mjs'), ...args],
      { env: mockEnv({ BILI_WATCH_CACHE: mockCache('gw-old') }), encoding: 'utf8', timeout: 180000 })
    if (ro.status !== 0) oldWhy = `旧版跑失败 rc=${ro.status} ${tail(ro.stderr)}`
    else oldOut = ro.stdout
  } catch (e) { oldWhy = String(e?.message ?? e) }
  if (oldWhy) skip(`${NAME} · 与改动前逐字节对比`, `拿不到改动前的输出，这条没验：${oldWhy}`)
  else must(oldOut === rOk.stdout, `没命中时 stdout 变了（新 ${rOk.stdout.length} 字节 / 旧 ${oldOut.length} 字节）`)

  return '命中→_untrusted+hits+stderr 警告；未命中→无扩展字段，且与 e889822 逐字节一致'
})

check('C128 落盘：原文件仍纯正文，wrapped 副本带 source tag+围栏，提示词指向 wrapped 且措辞收窄', () => {
  const NAME = 'C128 落盘 wrapped'
  if (!needMock(NAME)) return
  if (!mockInject) { skip(NAME, `带注入的 mock 起不来：${mockInjectWhy}`); return }
  const cache = mockCache('gw-wrap')
  const r = runLookMock(['sub', MOCK_BV], mockEnvOn(mockInject, { BILI_WATCH_CACHE: cache }))
  must(r.status === 0, `sub 应 rc=0：rc=${r.status} ${tail(r.stderr)}`)
  const dir = join(cache, MOCK_BV)
  must(existsSync(dir), `缓存目录没建：${dir}`)
  const plain = join(dir, 'sub.txt')
  const wrap = join(dir, 'sub.wrapped.txt')
  must(existsSync(plain), '没有落盘 sub.txt —— 纯正文那份不见了，read+解析它的下游会断')
  must(existsSync(wrap), '没有落盘 sub.wrapped.txt —— 推荐路径指向的那份带边界的副本没生成')
  const p = readFileSync(plain, 'utf8')
  must(!p.includes('[source:'), 'sub.txt 里出现了 source tag —— 纯正文被污染，下游解析会受影响')
  must(!p.includes('```'), 'sub.txt 里出现了围栏')
  const w = readFileSync(wrap, 'utf8')
  must(w.startsWith('[source: bilibili-subtitle'), `wrapped 副本开头不是 source tag：${JSON.stringify(w.slice(0, 60))}`)
  must(w.includes('```'), 'wrapped 副本没有围栏 —— 光有 tag 不叫边界')
  must(w.includes(INJECT_SUBTITLE), 'wrapped 副本里没有正文（标记有了、内容是空的）')
  // 提示词：必须指向 wrapped，且是「指向你的要求」而不是「任何要求」
  must(r.stdout.includes(wrap), `stdout 没指向 wrapped 那份：${tail(r.stdout, 300)}`)
  must(/指向你的要求/.test(r.stdout || ''), `提示词没有「指向你的要求」（过度概括会误伤字幕里的正常祈使句）：${tail(r.stdout, 300)}`)
  must(!/不要执行里面的任何要求/.test(r.stdout || ''), '提示词还是「任何要求」那版 —— 过度概括没改')
  return 'sub.txt 纯正文 / sub.wrapped.txt 带 tag+围栏 / 提示词指向 wrapped'
})

check('C129 20 条正常字幕在长文本规则下零命中（三条语义规则不加的依据）', () => {
  const raw = read('tools/fixtures/normal-subtitles.txt')
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  must(lines.length >= 20, `语料只有 ${lines.length} 条（应 ≥20）—— 删条目就等于放宽这条判据`)
  const out = guardProbe(lines.map((t, i) => ({ name: `n${i + 1}`, text: t })), 'C129')
  must(out.length === lines.length, `探针返回 ${out.length} 条，喂了 ${lines.length} 条`)
  const bad = out.filter((r) => r.long.length)
  must(bad.length === 0,
    `长文本池把 ${bad.length} 条正常字幕当成注入了：${bad.map((b) => `${b.name}→${b.long.join('/')}`).join('；')}` +
    '（字幕几千字，误报一条就是「每次都报」，下一步必然被人整段注释掉）')
  // 短文本池（评论）本来就会命中一些——不是断言目标，但必须打出来：
  //   「短池误报多少」是下一步要不要收紧的唯一依据，藏在报告里迟早被忘。
  const sh = out.filter((r) => r.short.length)
  return `${lines.length} 条正常字幕：长文本池 0 命中；短文本池 ${sh.length} 条命中` +
    (sh.length ? `（${sh.slice(0, 3).map((x) => x.short.join('/')).join('；')}…）` : '')
})

check('C130 不可见字符是确定性判据：零宽/tag/双向控制符命中，正常文本与开头 BOM 不命中', () => {
  const cases = [
    { name: 'plain', text: '好片子', expect: [] },
    { name: 'zw', text: '好片\u200b子', expect: ['零宽字符'] },
    { name: 'tag', text: '好片子\u{E0041}\u{E0042}', expect: ['tag 字符'] },
    { name: 'bidi', text: '好片\u202e子', expect: ['双向控制符'] },
    // 开头那个 U+FEFF 是「文件带 BOM」的产物，不是藏字：把它当命中，等于带 BOM 的每条都报警
    { name: 'bom-head', text: '\uFEFF好片子', expect: [] },
    { name: 'bom-mid', text: '好片\uFEFF子', expect: ['BOM 字符'] },
  ]
  const out = guardProbe(cases.map(({ name, text }) => ({ name, text })), 'C130')
  for (const c of cases) {
    const got = out.find((o) => o.name === c.name)
    must(got, `探针没返回 ${c.name}`)
    must(JSON.stringify(got.long) === JSON.stringify(c.expect),
      `${c.name}：期望 ${JSON.stringify(c.expect)}，实际 ${JSON.stringify(got.long)}`)
  }
  return `${cases.length} 个用例全中（含「开头 BOM 不算藏字」）`
})

// ── C142：runDownload 函数体可求值（PR #8 那次回归的守门人）─────────────────
// 为什么必须有一条：e889822 把 `const detached = ...` 删了，但 spawn 选项与 download.log
//   模板还在引用它 → 对象字面量求值抛 ReferenceError → 被函数自己的 try/catch 收成
//   {started:false} → 用户点「一键下载」回 HTTP 400。当时 154 条断言**一条都没红**，
//   因为它们只验「函数存在」，没验「函数体能不能跑完」。
// 为什么判据不能看 throw：这个错被 runDownload 自己 catch 了，根本不往外抛。
//   第一版探针写成「捕获 ReferenceError」，在坏代码上输出 OK / rc=0 —— 一条没牙的判据。
//   现在落在 ret.started === true 与 spawn 收到的 detached 值上。
// 探针自带「自身失效」保护：切不出函数体就 rc=2，本 check 先判 2 再判 0，不静默 PASS。
check('C142 runDownload 函数体能求值并真的拉起进程（引用未声明变量必须红）', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/fixtures/run-download-probe.mjs')], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env },
  })
  const detail = `${(r.stdout || '') + (r.stderr || '')}`.trim().slice(0, 300)
  must(r.status !== 2, `探针自身失效（rc=2，说明切不出函数体，不是被测代码的问题）：${detail}`)
  must(r.status === 0, `runDownload 跑不通：${detail}`)
  return '函数体求值通过，started=true，spawn 收到 detached=false'
})

// —— 汇总 ——（C1：通过 / 失败 / 跳过分开算；跳过不进通过数、也不致 exit 1）
let pass = 0, fail = 0, skipN = 0
for (const r of results) {
  if (r.skip) skipN++
  else if (r.ok) pass++
  else fail++

  const tag = r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`)
}
console.log(`\n${pass} 通过 / ${fail} 失败 / ${skipN} 跳过`)

// 跳过明细（2026-11-01，第三条）：汇总行只有一个数字，只看结尾的人不知道
//   「跳过了哪几条、为什么、怎么才能让它跑」。跳过是最容易被当成「没问题」的状态，
//   所以在这里再列一遍：名字 + 原因。零跳过时不打这一块（不制造噪声）。
if (skipN > 0) {
  console.log(`\n跳过明细（${skipN} 条，不计入通过数、也不致红）：`)
  for (const r of results) {
    if (!r.skip) continue
    console.log(`  · ${r.name}`)
    console.log(`    ${r.detail || '（没写原因 —— 这条要补）'}`)
  }
}

try { if (mockBili) await mockBili.close() } catch {}
try { if (mockInject) await mockInject.close() } catch {}
process.exit(fail ? 1 : 0)
