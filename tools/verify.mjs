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
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync, copyFileSync, openSync, closeSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 2026-10-31 切片 1：被测函数搬进 lib/ 之后，断言可以直接 import 真跑——
//   不必再「读整份源码 → 正则抠函数体 → new Function 重编译」三件套。
//   这不是「放松」：原来的 C7/C25 是「比两处函数体是否相等」，只证明两边写得一样，不证明写得对；
//   现在是喂对抗输入看输出。函数被改坏时，旧断言只会在「两处不同步」时红，新断言会在「行为错了」时红。
import { cleanKey, bvOf } from '../lib/keys.mjs'
// 2026-10-31 切片 2：锁判据与「目录能不能认领」搬进 lib/ 之后，C6/C23 也改成 import 真跑。
import { hasAnyLock, isAdoptableDir, lockExpired, pidAlive, readLock } from '../lib/locks.mjs'
import { isOwnBvDir, isOwnedEntry, isOurCacheRoot } from '../lib/cache-own.mjs'
// 2026-10-31 切片 3：调优表 / 钳制 / TTL 换算只剩 lib/tuning.mjs 一份，断言直接 import 真跑。
import { lockTtlMsOf, normalizeTuning } from '../lib/tuning.mjs'
// 2026-10-31 切片 3-C：runs.jsonl 的轮转 + 追加搬进 lib/runs.mjs，这里真跑四种现场。
import { appendJsonLine } from '../lib/runs.mjs'
// 2026-10-31 切片 3-B：坏配置留档 + 回默认值的行为只剩 lib/config.mjs 一份，C38 直接 import 真跑。
import { readJsonOrBackup } from '../lib/config.mjs'
// 2026-10-31 切片 4：缓存根的状态搬进 lib/cache-path.mjs。这里只 import 两个**无状态**的动作
//   （路径推导 / 落盘探测）真跑；有状态的那半（initCachePath / cacheDir）必须另起进程验——
//   本进程一旦 init 过，C65 的「未初始化必抛」就永远绿不起来了。
import { pickCacheDir, resolveCacheDir } from '../lib/cache-path.mjs'
// 2026-10-31 切片 5：凭证的位置 / 四字段判据 / 旧路径迁移只剩 lib/cred.mjs 一份，C16 直接 import 真跑。
import { adoptLegacyCred, credPaths, missingCredFields, readCred } from '../lib/cred.mjs'
import { claimRoute, releaseRoute, claimedPaths } from '../lib/route-claim.mjs'
import { checkOutDir } from './cli-io.mjs'
// 2026-10-31 切片 9 第一步：media 的两个原语搬进 lib/media.mjs，C81/C82 直接 import 真跑。
// 切片 9 第二步：四个纯判据（parseAtTimes / atDirTag / framesCacheHit / autoStep）与
//   downloadTo / cachedMp4 / sceneTimes / pickEvenly 也搬过去了，于是 C44/C47 从
//   「读 look.mjs → 正则抠函数体 → new Function 重编译」改成直接 import 真跑。
import {
  atDirTag, autoStep, cachedMp4, downloadTo, ffExec, findFfmpeg,
  framesCacheHit, parseAtTimes, pickEvenly, sceneTimes,
} from '../lib/media.mjs'
// 2026-10-31 切片 10：cache 层（目录 / manifest / 等他人）搬进 lib/frames.mjs；
//   抢锁放锁搬进 lib/locks.mjs 的 makeLocks。C47/C87/C88 直接 import 真跑。
import { ensureDir, framesDirName, listJpgs, readManifest, shotsDirName, waitManifest, writeManifest } from '../lib/frames.mjs'
import { makeLocks } from '../lib/locks.mjs'
// 2026-10-31 三审：C90 的三条守卫需要 logRun（切片 5）与缓存根推导（切片 4）的真跑。
import { logRun } from '../lib/runs.mjs'
import { defaultCacheRoot } from '../lib/cache-path.mjs'
// 2026-11-01（DSH 00:44 P0-3）：must 也跟着 makeChecker 搬进 check-run.mjs。
//   它是 700 多处断言的失败信号，却原来只是本文件的局部常量——外面碰不到，也就没有一条断言验过它。
//   C77 现在 import 同一个绑定，直接喂 false 验「必须抛」。**别在这里再写一份**（那就又成了「验的不是用的」）。
import { makeChecker, must } from './check-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const results = []
// 2026-10-31 切片 8（DSH 18:48）：执行器搬进 tools/check-run.mjs，就为了让它**自己可被断言**——
//   它是「所有断言是否真跑」的唯一开关，原来却是唯一没有断言的代码。C77 直接 import 它喂 async 回调。
const check = makeChecker(results)
// must 从 ./check-run.mjs import（2026-11-01 P0-3）。它原来就在这一行，是文件局部常量。
// 依赖网络的断言默认跳过：网络抖动不该让守卫变红（静态断言永远可跑）。VERIFY_ONLINE=1 才联网验。
// C1（2026-10-27 批次8）：skip 以前记成 ok:true——汇总把跳过当通过，「8/8 通过」是虚的。
//   现在记成 ok:false + skip:true，汇总时单独数跳过，不再混进通过数，也不算失败。
const skip = (name, why) => results.push({ name, ok: false, skip: true, detail: why })
const online = process.env.VERIFY_ONLINE === "1"

// —— 静态断言 ——
check('版本号不是 0.2.22（P0：sync-release 会把新版覆盖成旧版）', () => {
  const v = JSON.parse(read('package.json')).version
  must(v !== '0.2.22', `package.json version=${v}`)
  return v
})

check('--fresh 的删除在 tryLock 之后（P0：锁外删会删掉别人的 .lock）', () => {
  const t = read('tools/look.mjs')
  const iLock = t.indexOf('await tryLock(dir)')
  const iFresh = t.indexOf("if (fresh && !outDir) {\n      for (const e of readdirSync(dir))")
  must(iLock > 0, '找不到 tryLock')
  must(iFresh > 0, '找不到锁内的 fresh 清理块')
  must(iFresh > iLock, 'fresh 清理出现在 tryLock 之前')
  must(!t.includes('if (fresh && !outDir && existsSync(dir)) rmSync'), '锁外那份 rmSync 还在')
  return `lock@${iLock} < fresh@${iFresh}`
})

check('lib/cache-path.mjs 的 videoDir 复用「BV_标题」目录（P0：同一视频两个兄弟目录）', () => {
  // 2026-10-31 切片 4：videoDir 搬进 lib/cache-path.mjs（它读缓存根，而缓存根住在那边），
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
// 2026-10-31（切片 0.1）：**取到了不等于取对了**。这个函数有两个洞，都会返回一段
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
  const i = src.indexOf(`function ${name}(`)
  must(i >= 0, `找不到 function ${name}`)
  const j = src.slice(i).search(/\n\}/)
  must(j > 0, `${name} 的函数体没有行首闭合括号`)
  const body = src.slice(i, i + j + 2)
  const isAsync = /async\s$/.test(src.slice(Math.max(0, i - 6), i))
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

// 2026-10-31 切片 2：原来这里还有一条「hasAnyLock 在 index.js 与 tools/look.mjs 逐字一致」的哈希断言。
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
  // 2026-10-31 切片 5：四字段清单搬进 lib/cred.mjs 的 CRED_FIELDS——原来「两边各写一段字面量、
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
// 每一条对应一处本轮修掉的问题。原则同前：断言要盯「调用面」而不是「点位」——
// 例如 W-27 的 ffmpeg 不许只断言某一个调用行，否则明天新增一条命令忘了传照样绿。

check('C1 失败原因不再写 stdout（P1：--format json 时错误行会让 JSON.parse 直接失败）', () => {
  const t = read('tools/look.mjs')
  const bad = t.match(/console\.log\(\s*['"`]✗/g) || []
  must(bad.length === 0, `还有 ${bad.length} 处 console.log('✗ …') 走 stdout`)
  const good = t.match(/console\.error\(\s*['"`]✗/g) || []
  must(good.length >= 19, `console.error('✗ …') 只有 ${good.length} 处，少于本轮的 19 处`)
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
  // 2026-10-31 切片 7：checkOutDir 搬进 tools/cli-io.mjs，于是这条从「compile 抽函数体」
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
  // 2026-10-31 切片 2：4 个函数搬进 lib/locks.mjs，原来「两处函数体逐字一致」的判据作废（只剩一份）。
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

    // ⑥ TTL 换算：算式收在 lib/tuning.mjs 的 lockTtlMsOf（切片 3）。
    //   按 DSH 2026-10-31 16:14 的判据：**同一份配置，两个入口算出的 TTL 必须完全相同**。
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
  // 2026-10-31 切片 1：原来是「比两处函数体的 md5」——那是结构断言，函数搬进 lib/ 后必然失效，
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
  // 2026-10-31 切片 4：pickCacheDir 只剩 lib/cache-path.mjs 一份（原来两个入口各一份，靠本条的
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
  const a = read('index.js')
  const b = read('tools/look.mjs')
  const iA = a.indexOf('const KNOWN_FLAGS')
  const iB = b.indexOf('const KNOWN_FLAGS')
  must(iA >= 0 && iB >= 0, '找不到 KNOWN_FLAGS')
  must(a.slice(iA, iA + 700).includes("'--asr-max'"), 'index.js 的 KNOWN_FLAGS 缺 --asr-max')
  must(b.slice(iB, iB + 700).includes("'asr-max'"), 'look.mjs 的 KNOWN_FLAGS 缺 asr-max')
  return 'ok'
})

check('C10 clean 把「删除失败」与「不是我们的数据」分开报（P2：原来 EPERM 被说成「没动」且 rc=0）', () => {
  // 2026-10-31 切片 2：removeOwned 搬进 lib/cache-own.mjs，「删除失败」与「不是我们的数据」分开报这件事
  //   只剩一处实现；后半段仍盯 look.mjs 的 clean 分支（读 cleared.failed 并改退出码）。
  //
  // 前半段改真跑（反向验证 R7 抓出来的）：原来只断言「函数体里出现过 failed.push」——
  //   三个分支里删掉两处它照样绿，牙不齐。现在用一个会抛错的假 fs，看它把「删不掉」记进
  //   failed 还是混进 skipped，并且这条条目不能被算成「已清理」。
  //
  // 2026-10-31 切片 3（DSH 16:14 要求）：先试「真占用」，造不出来才用假 fs。
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

  // DSH 16:14：Windows 上删被占用文件常见的是 EBUSY 不是 EPERM。生产代码 catch 一切错误，
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
  // 2026-10-31 切片 5：迁移判据搬进 lib/cred.mjs 之后，两个入口只剩「拿结果」这一步。
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
  // 2026-10-31 切片 3：原来这里比「index.js 与 tools/look.mjs 两份表逐键一致」。
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
  // 2026-10-31 切片 3：表从两份变一份，检查对象从「两个文件」变成「lib 一处 + 真跑」。
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
  const ps = read('scripts/fetch-deps.ps1')
  must(/'cuda'/.test(ps), 'fetch-deps.ps1 没有 cuda target')
  must(!/default \{ @\('ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'cuda'\)/.test(ps), 'all 的步骤表把 cuda 带上了（应当保持「不问、不装 1.4 GB」）')
  return 'deps 行 + /status.gpu + pip uninstall + -Target cuda 都在，all 不含 cuda'
})

// C21/C22（2026-10-29，rumo-test）：clean 的两条行为第一次真跑。
//   W-04 与 C10 原来都只读源码找子串——实测「…→...」「变量改名但注释留旧名」都能让断言照绿。
//   这里造合法缓存根（.bili-watch-root + BV 目录里的 meta.json；否则 pickCacheDir 会另建
//   bili-watch-cache 子目录，测到的是空目录、什么也证明不了），再真跑一次 clean。
// 2026-10-31 切片 4 补丁（DSH 17:26 复核抓到的脆断言）：C64 断的是「默认缓存根」，但它的 env 是
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
//   2026-10-31 切片 2：它和 isAdoptableDir 都搬进 lib/（各只剩一份），「两处逐字一致」不再是判据——
//   改成「真跑判据 + 钉住四个入口都还在调用」。剩下要防的不再是「两份分叉」，而是
//   「改 lib 时把判据改坏」与「重构调用点时把闸拆了」。
//   编号 C23：C21/C22 已被 dev 517d6bf 占用（clean 遇活锁 rc≠0 / 残留锁照清），合流时留位不撞。
check('C23 删除面守卫真跑：根标记 / 认领判据都对，四个入口都先问一句（P0）', () => {
  const a = read('index.js')
  // 2026-10-31 切片 4：look.mjs 侧不再单独读——认领判据只剩 lib/cache-path.mjs 一份，在下面真跑。
  // 2026-10-31 切片 2：isOurCacheRoot 已搬进 lib/cache-own.mjs（只剩一份），「两处一致」作废——改成真跑。
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
  // 2026-10-31 切片 2：isAdoptableDir 已搬进 lib/locks.mjs（只剩一份），改成真跑四种目录形态。
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
  // 2026-10-31 切片 2：removeOwned 搬进 lib/cache-own.mjs，闸还在不在要看 lib 那份（不再看两个入口）。
  must(/if \(!isOurCacheRoot\(dir\)\) return/.test(fnBody(own, 'removeOwned')), 'removeOwned 没先判 isOurCacheRoot（删之前不问这是不是我们的根）')
  must(/if \(!isOurCacheRoot\(cacheDir\(\)\)\) return/.test(fnBody(a, 'autoCleanCache')), 'autoCleanCache 没先判 isOurCacheRoot')
  must(/if \(!isOurCacheRoot\(root\)\) return/.test(fnBody(a, 'pruneEmptyDirs')), 'pruneEmptyDirs 没先判 isOurCacheRoot')
  // 认领判据：有内容又没有标记的用户目录，绝不能当成缓存根（否则本次运行就把标记写进去，守卫空转）
  // 2026-10-31 切片 4：resolveCacheDir 搬进 lib/cache-path.mjs（只剩一份）。结构上钉「还在用
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
  // 2026-10-31 切片 1：原来比「两处 bvOf 函数体相等」，再手工跑一次正则——
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
  // 2026-10-31 切片 4：videoDir 搬进 lib/cache-path.mjs，两处变一处——盯那份唯一实现
  must(/cleanKey\(bvOf\(/.test(fnBody(read('lib/cache-path.mjs'), 'videoDir')), 'lib/cache-path.mjs 的 videoDir 没走 bvOf')
  return `${cases.length} 条输入 + 端到端不落 http 名 + videoDir 走 bvOf`
})

// #1（2026-10-30 E8 总表）：删除面有两个入口——用户点清理走 removeOwned，自动清理走 autoCleanCache → walkEntries
//   → isOwnedEntry。removeOwned 早就改成「名字 + meta.json」，isOwnedEntry 却还按 /^BV…/ 名字直接认领，
//   于是用户在缓存根放一个自己的 BV1234567890/ 会被自动清理连文件一起删。
//   2026-10-31 切片 2：两个入口的实现搬进 lib/cache-own.mjs，物理上只剩一份——「两处一致」不再需要断言，
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
check('C30 fetch-deps.ps1 只应有一份（在 scripts/）+ Test-PyVersion 收 3.14（E8 #6）', () => {
  const b = join(ROOT, 'scripts', 'fetch-deps.ps1')
  must(existsSync(b), 'scripts/fetch-deps.ps1 不存在——插件调的就是这一份')
  must(
    !existsSync(join(ROOT, 'fetch-deps.ps1')),
    '根目录又出现了 fetch-deps.ps1：插件只调 scripts/ 那份，多一份就是第二个真相源，请删掉或移进备份',
  )
  const body = read('scripts/fetch-deps.ps1')
  // 判据承重点：Test-PyVersion 的版本正则必须收到 3.14
  const m = /function Test-PyVersion[\s\S]*?return \(\$v -match '([^']+)'\)/.exec(body)
  must(m, '找不到 Test-PyVersion 的版本正则')
  must(/1\[0-4\]/.test(m[1]), `Test-PyVersion 的正则仍是 ${m[1]}——3.14 会被硬拒（实测 3.14.6 的 venv 里 onnxruntime 1.31.1 可用）`)
  must(!/3\.14 没有 onnxruntime 的 wheel/.test(body), '脚本里还留着「3.14 没有 onnxruntime 的 wheel」这句已被实测推翻的话')
  return `判据 ${m[1]} 已收 3.14；全仓只有 scripts/ 一份（${readFileSync(b).length} B）`
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
  // 2026-10-31 切片 2：dirStat 搬进 lib/cache-own.mjs，只剩一处实现——「两处口径统一」不再是判据，
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
  // 2026-10-31 切片 3-B：行为搬进 lib/config.mjs，直接 import 真跑（返回 {value, problem}）。
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
    // 切片 4：cacheStat 里读的是 cacheDir()（缓存根状态搬进 lib 之后，本文件不再有 CACHE 值）
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
  // KNOWN_FLAGS 加了 no-time
  const flagsLine = src.match(/const KNOWN_FLAGS = new Set\(\[([^\]]+)\]\)/)
  must(flagsLine && flagsLine[1].includes("'no-time'"), 'KNOWN_FLAGS 里没有 no-time')
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
  // 切片 9 第二步：parseAtTimes 搬进 lib/media.mjs，直接从 import 的那份真跑（不再 compile 抠函数体）。
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
  // KNOWN_FLAGS 加了 at
  const flagsLine = src.match(/const KNOWN_FLAGS = new Set\(\[([^\]]+)\]\)/)
  must(flagsLine && flagsLine[1].includes("'at'"), 'KNOWN_FLAGS 里没有 at')
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
  // 切片 9 第二步：atDirTag / framesCacheHit 搬进 lib/media.mjs，直接 import 真跑。
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
  // 2026-10-31 切片 10：manifest 读写搬进 lib/frames.mjs —— 直接 import 真跑。
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
  // 6. --fresh 删得掉 at 产物（files 里只认 <bv>-NN.jpg 时，f_7m40s.jpg 永远删不掉）
  const producedLine = fnBody(b, 'grabFrames').split('\n').find((l) => l.includes('const produced'))
  must(producedLine && producedLine.includes('f_'), 'manifest.files 没把 at 产物（f_12m30s.jpg）算进去——--fresh 删不掉旧时刻帧')
  return `atDirTag([460])=${d460} ≠ ${d750}；times 不等不命中、零帧不命中、无 times 的老 manifest 非 at 仍命中；manifest 往返 times=${JSON.stringify(backTimes)}`
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
check('C54 两个安装脚本的 pip 版本约束一致（issue #6 坑 4：av 19 会让 faster-whisper 1.2.1 抛 TypeError）', () => {
  const shPath = join(ROOT, 'scripts/fetch-deps.sh')
  if (!existsSync(shPath)) {
    // 2026-10-31：原来这句写「发布树不含 scripts/fetch-deps.sh（只留开发态）」——是错的。
    //   发布树有 scripts/ 目录（sync-release 会复制），files 里也列了这两个脚本。
    //   写错的后果不是这条断言坏，是读代码的人以为「两个发布件没被检查」，
    //   正好与「检查面必须等于发布面」那条教训相反。
    skip('C54 两个安装脚本的 pip 版本约束一致', '找不到 scripts/fetch-deps.sh（仓库结构变了？）')
    return 'ok'
  }
  const sh = read('scripts/fetch-deps.sh')
  const ps = read('scripts/fetch-deps.ps1')
  const pins = ['faster-whisper==1.2.1', 'av==15.1.0', 'ctranslate2==4.8.3', 'rapidocr-onnxruntime==1.2.3']
  const missSh = pins.filter((p) => !sh.includes(p))
  const missPs = pins.filter((p) => !ps.includes(p))
  must(missSh.length === 0, `fetch-deps.sh 缺版本约束：${missSh.join('、')}——不锁 av 会装到 19，decode_audio() 抛 TypeError`)
  must(missPs.length === 0, `fetch-deps.ps1 缺版本约束：${missPs.join('、')}`)
  // 光有 av==15.1.0 不够，还得防「另外又写了一处裸 av 或 av>=19」把它们盖掉。
  //   只看真正会执行的行（含 ensure_venv 的调用行）——注释里本来就要提「av 19 会炸」，
  //   连注释一起扫会把这条守卫变成报警器。
  const callLines = sh.split('\n').filter((l) => l.includes('ensure_venv') && !l.trim().startsWith('#'))
  must(callLines.length >= 2, `fetch-deps.sh 里 ensure_venv 的调用行只找到 ${callLines.length} 行（应有 asr 与 ocr 各一处以上）`)
  for (const l of callLines) {
    const bareAv = /(^|[\s"'])av(["'\s]|$)/.test(l)
    const av19 = /av[><]=?\s*19|av==19/.test(l)
    must(!bareAv, `fetch-deps.sh 的调用行里有裸 av（没带版本约束）：${l.trim()}`)
    must(!av19, `fetch-deps.sh 的调用行把 av 放到了 19：${l.trim()}`)
  }
  return 'ok'
})

// —— issue #6 / #5 的 Linux 修复（2026-10-31）——
// 本机没有 WSL，Linux 分支只能靠「mock 掉 curl / tar / python3，真跑函数体」来验。
// 全量 14 个用例 / 39 条断言在 tools/fixtures/fetch-deps-sh.test.sh；
// 这里只放门禁能承受的几条（每条 1 个子进程），断言落在产物上，不是源码字符串。
//
// ⚠️ 那个 fixture **不进 verify**：跑一遍要 190 秒（大头是 13 个 mock python 建 venv 的用例），
//   塞进来会把 34 秒的门禁拖到 4 分钟，没人愿意跑就等于没有门禁。
//   代价是它会悄悄过期 —— 2026-10-31 深入审查时发现它的用例 3 还在按**旧判据**
//   （包内 deps「存在」就用包内）断言，判据收紧后一直红着没人知道。
//   所以：**只要改了 scripts/fetch-deps.sh，手工跑一次**
//     bash tools/fixtures/fetch-deps-sh.test.sh
//   它失败时退出码非 0（末尾 `[ "$fail" -eq 0 ]`），别看 `| tail` 的退出码。

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

// C55（2026-10-31，issue #6 坑 1）：脚本的 deps 目录必须与运行时同一套三级解析。
//   原来写死 DEPS="$ROOT/deps"，而插件启动过一次后运行时读的是包外 —— 脚本把 yt-dlp
//   下到包内，面板永远「不可用」。用无效 target（会走 case 的 * 分支 exit 2）来验，
//   这样一次网络请求都不发，只看它选了哪个目录、mkdir 了哪个目录。
check('C55 fetch-deps.sh 的 deps 目录三级解析，与运行时同一套（issue #6 坑 1）', () => {
  const shPath = join(ROOT, 'scripts', 'fetch-deps.sh')
  if (!existsSync(shPath)) {
    skip('C55 fetch-deps.sh 的 deps 目录三级解析', '找不到 scripts/fetch-deps.sh（仓库结构变了？）')
    return 'ok'
  }
  const bash = findBash()
  if (!bash) {
    skip('C55 fetch-deps.sh 的 deps 目录三级解析', '本机没有可用的 bash')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c55-'))
  try {
    const pkg = join(tmp, 'pkg')
    const home = join(tmp, 'home')
    mkdirSync(join(pkg, 'scripts'), { recursive: true })
    copyFileSync(shPath, join(pkg, 'scripts', 'fetch-deps.sh'))
    const sh = join(pkg, 'scripts', 'fetch-deps.sh')
    const run = (extra) => spawnSync(bash, [sh, 'badtarget'], {
      env: { ...process.env, DSH_HOME: home, ...extra },
      encoding: 'utf8', timeout: 60000,
    })
    // ① 包外存在 → 用包外
    mkdirSync(join(home, 'bili-watch', 'deps'), { recursive: true })
    const a = run({})
    must(/来源：包外/.test(a.stderr), `包外 deps 已存在时没选包外：${(a.stderr || '').slice(0, 200)}`)
    // ② BILI_WATCH_DEPS 优先
    const explicit = join(tmp, 'explicit')
    const b = run({ BILI_WATCH_DEPS: explicit })
    must(/来源：BILI_WATCH_DEPS/.test(b.stderr), `BILI_WATCH_DEPS 没生效：${(b.stderr || '').slice(0, 200)}`)
    must(existsSync(explicit), 'BILI_WATCH_DEPS 指向的目录没被创建——说明脚本没往那儿装')
    // ③ 包外不存在、包内**已有内容** → 仍用包内（运行时 index.js:185 的例外）
    const tmp2 = mkdtempSync(join(tmpdir(), 'bw-c55b-'))
    try {
      mkdirSync(join(tmp2, 'pkg', 'scripts'), { recursive: true })
      mkdirSync(join(tmp2, 'pkg', 'deps'), { recursive: true })
      // 必须真放一个文件：这条分支判的是「有内容」不是「存在」。
      //   原来这里只建空目录，靠旧代码「只判存在」蒙过去——判据一收紧就露馅了。
      writeFileSync(join(tmp2, 'pkg', 'deps', 'yt-dlp'), 'x')
      copyFileSync(shPath, join(tmp2, 'pkg', 'scripts', 'fetch-deps.sh'))
      const c = spawnSync(bash, [join(tmp2, 'pkg', 'scripts', 'fetch-deps.sh'), 'badtarget'], {
        env: { ...process.env, DSH_HOME: join(tmp2, 'home') },
        encoding: 'utf8', timeout: 60000,
      })
      must(/来源：包内/.test(c.stderr), `包内已有 deps、包外没有时没选包内：${(c.stderr || '').slice(0, 200)}`)
      must(!existsSync(join(tmp2, 'home', 'bili-watch', 'deps')), '包内已有 deps 时不该再建包外空目录（会让人以为装到别处了）')
    } finally { rmSync(tmp2, { recursive: true, force: true }) }
    // ③b 包内 deps 存在但**是空的** → 必须用包外。
    //   这是复核时抓出来的真 bug：.ps1 用 Test-Path 判「存在」，index.js:185 用
    //   readdirSync().length > 0 判「有内容」。只跟 .ps1 对齐的话，包内空目录会让脚本
    //   装进包内、运行时读包外 —— 坑 1 原样复发，而且更难发现（目录是「对的那个名字」）。
    const tmp4 = mkdtempSync(join(tmpdir(), 'bw-c55d-'))
    try {
      mkdirSync(join(tmp4, 'pkg', 'scripts'), { recursive: true })
      mkdirSync(join(tmp4, 'pkg', 'deps'), { recursive: true }) // 空目录，里面什么都没有
      copyFileSync(shPath, join(tmp4, 'pkg', 'scripts', 'fetch-deps.sh'))
      const e = spawnSync(bash, [join(tmp4, 'pkg', 'scripts', 'fetch-deps.sh'), 'badtarget'], {
        env: { ...process.env, DSH_HOME: join(tmp4, 'home') },
        encoding: 'utf8', timeout: 60000,
      })
      must(/来源：包外/.test(e.stderr), `包内 deps 是空目录时应该用包外（index.js:185 判的是「有内容」不是「存在」）：${(e.stderr || '').slice(0, 200)}`)
      must(existsSync(join(tmp4, 'home', 'bili-watch', 'deps')), '包内空目录时没建包外 deps 目录')
    } finally { rmSync(tmp4, { recursive: true, force: true }) }
    // ④ 包外和包内都没有 → 用包外（不往包里写）
    const tmp3 = mkdtempSync(join(tmpdir(), 'bw-c55c-'))
    try {
      mkdirSync(join(tmp3, 'pkg', 'scripts'), { recursive: true })
      copyFileSync(shPath, join(tmp3, 'pkg', 'scripts', 'fetch-deps.sh'))
      const d = spawnSync(bash, [join(tmp3, 'pkg', 'scripts', 'fetch-deps.sh'), 'badtarget'], {
        env: { ...process.env, DSH_HOME: join(tmp3, 'home') },
        encoding: 'utf8', timeout: 60000,
      })
      must(/来源：包外/.test(d.stderr), `干净安装时没选包外：${(d.stderr || '').slice(0, 200)}`)
      must(existsSync(join(tmp3, 'home', 'bili-watch', 'deps')), '干净安装时没建包外 deps 目录')
      must(!existsSync(join(tmp3, 'pkg', 'deps')), '干净安装时不该往插件包目录里建 deps')
    } finally { rmSync(tmp3, { recursive: true, force: true }) }
    // ③c Windows 侧同一个坑：fetch-deps.ps1 原来也用 Test-Path 判「存在」，
    //   而 index.js:185 判「有内容」。只修 .sh 就是「只修了一半」——
    //   同一段逻辑在两个文件里各一份，改一份等于制造不一致。
    let ps1Note = ''
    const ps1 = join(ROOT, 'scripts', 'fetch-deps.ps1')
    const pwsh = findPowerShell()
    if (existsSync(ps1) && pwsh) {
      const tmp5 = mkdtempSync(join(tmpdir(), 'bw-c55e-'))
      try {
        mkdirSync(join(tmp5, 'pkg', 'scripts'), { recursive: true })
        mkdirSync(join(tmp5, 'pkg', 'deps'), { recursive: true }) // 空目录
        copyFileSync(ps1, join(tmp5, 'pkg', 'scripts', 'fetch-deps.ps1'))
        const r = spawnSync(pwsh, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(tmp5, 'pkg', 'scripts', 'fetch-deps.ps1'),
          '-Target', 'all', '-DryRun', '-Gpu', 'no',
        ], {
          env: { ...process.env, DSH_HOME: join(tmp5, 'home'), BILI_WATCH_DEPS: '' },
          encoding: 'utf8', timeout: 180000,
        })
        const out = (r.stdout || '') + (r.stderr || '')
        must(/来源：包外（\$DSH_HOME\\bili-watch\\deps，新建）/.test(out),
          `.ps1 在包内 deps 是空目录时没选包外（与 index.js:185 分叉）：${out.slice(0, 400)}`)
        ps1Note = '；ps1 同款分支已真跑'
      } finally { rmSync(tmp5, { recursive: true, force: true }) }
    } else {
      ps1Note = '；ps1 侧未验（本机没有 PowerShell）'
    }
    // ⑤ where：只回答「装到哪」，且**不建目录**。
    //   为什么要它：README 的 Linux GPU 段要按脚本自己解析的路径去找 .venv-asr/bin/pip，
    //   而 deps 可能在 $DSH_HOME / BILI_WATCH_DEPS 两处。之前只能让用户跑一次 all
    //   （顺带下 40 MB ffmpeg + 两个 venv + 464 MB 模型）就为了看一行路径。
    //   不建目录是硬要求：顺手建一个空的包外目录，会让「包内 deps 已有内容」的机器
    //   下次改用那个空目录（第 41 行判的是「存在」），等于把已有 venv 和模型丢掉。
    const tmp6 = mkdtempSync(join(tmpdir(), 'bw-c55f-'))
    try {
      mkdirSync(join(tmp6, 'pkg', 'scripts'), { recursive: true })
      copyFileSync(shPath, join(tmp6, 'pkg', 'scripts', 'fetch-deps.sh'))
      const home6 = join(tmp6, 'home')
      const w = spawnSync(bash, [join(tmp6, 'pkg', 'scripts', 'fetch-deps.sh'), 'where'], {
        env: { ...process.env, DSH_HOME: home6, BILI_WATCH_DEPS: '' },
        encoding: 'utf8', timeout: 60000,
      })
      must(w.status === 0, `where 没正常退出（rc=${w.status}）：${(w.stderr || '').slice(0, 200)}`)
      const want = join(home6, 'bili-watch', 'deps')
      // 本机是 Git Bash：DSH_HOME 传进去是 Windows 路径（C:\...），脚本直接拼 /bili-watch/deps
      //   就成了混合分隔符。真 Linux 上不会有这问题，比较前统一成 / 即可。
      const norm = (s) => s.replace(/\\/g, '/')
      must(norm(w.stdout.trim()) === norm(want),
        `where 打印的路径不对（stdout 必须只有路径、不带提示行）：期望 ${want}，实际 ${JSON.stringify(w.stdout.trim())}`)
      must(/来源：包外/.test(w.stderr), 'where 的路径来源提示没走 stderr（会污染 $(...) 捕获）')
      must(!existsSync(want), 'where 不该创建 deps 目录（会让「包内已有内容」的机器改用空目录）')
    } finally { rmSync(tmp6, { recursive: true, force: true }) }
    return '包外 / BILI_WATCH_DEPS / 包内例外 / 包内空目录 / 干净安装 / where 六条分支都按运行时（index.js:178-189）的口径' + ps1Note
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// C56（2026-10-31，issue #6 坑 2）：ffmpeg 要真下载，且解压前必须 tar -t 预校验。
//   镜像给 HTML 错误页时 curl 可能照样 exit 0，直接解压会得到一堆垃圾或半截目录。
//   这里用假 curl 喂一段 HTML，断言：拦住 + 把拿到的内容打出来 + 不落坏文件。
check('C56 fetch-deps.sh 的 ffmpeg 下载有 tar -t 预校验，HTML 错误页会被拦住（issue #6 坑 2）', () => {
  const shPath = join(ROOT, 'scripts', 'fetch-deps.sh')
  if (!existsSync(shPath)) {
    skip('C56 ffmpeg 下载的 tar -t 预校验', '找不到 scripts/fetch-deps.sh（仓库结构变了？）')
    return 'ok'
  }
  const bash = findBash()
  if (!bash) {
    skip('C56 ffmpeg 下载的 tar -t 预校验', '本机没有可用的 bash')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c56-'))
  try {
    mkdirSync(join(tmp, 'pkg', 'scripts'), { recursive: true })
    mkdirSync(join(tmp, 'home', 'bili-watch', 'deps'), { recursive: true })
    mkdirSync(join(tmp, 'bin'), { recursive: true })
    copyFileSync(shPath, join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'))
    // 假 curl：往 -o 目标写一段 HTML，然后 exit 0（这正是镜像错误页的样子）
    const fakeCurl = join(tmp, 'bin', 'curl')
    writeFileSync(fakeCurl, [
      '#!/bin/sh',
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      `printf '<!DOCTYPE html><html><body>404 Not Found</body></html>' > "$out"`,
      'exit 0',
      '',
    ].join('\n'))
    // 同时 mock tar：本机 Git Bash 的 tar 调不到 xz，会走「缺 xz 解压器」那条分支，
    //   测不到「HTML 被当成压缩包」这个真场景。假 tar 只认 xz 魔数，其余一律拒绝（与真 tar 同行为）。
    const fakeTar = join(tmp, 'bin', 'tar')
    writeFileSync(fakeTar, [
      '#!/bin/sh',
      'mode=""; f=""; dest=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -tJf) mode=t; f="$2"; shift 2 ;;',
      '    -xJf) mode=x; f="$2"; shift 2 ;;',
      '    -C) dest="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'magic=$(head -c 6 "$f" 2>/dev/null | od -An -tx1 | tr -d " \\n")',
      'case "$magic" in',
      '  fd377a585a00*) ;;',
      '  *) echo "tar: This does not look like a tar archive" >&2; exit 2 ;;',
      'esac',
      'if [ "$mode" = "t" ]; then echo "ffmpeg-x-static/ffmpeg"; echo "ffmpeg-x-static/ffprobe"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'))
    spawnSync('chmod', ['+x', fakeCurl], { timeout: 15000 })
    spawnSync('chmod', ['+x', fakeTar], { timeout: 15000 })
    const r = spawnSync(bash, [join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'), 'ffmpeg'], {
      // PATH 里必须用正斜杠：Windows 的 C://...//bin 带冒号，Git Bash 会把它当路径分隔符切碎
      env: { ...process.env, DSH_HOME: join(tmp, 'home'), PATH: join(tmp, 'bin').replace(/\\/g, '/') + ':' + (process.env.PATH || '') },
      encoding: 'utf8', timeout: 120000,
    })
    const err = r.stderr || ''
    must(/不是有效的 \.tar\.xz/.test(err), `HTML 错误页没被拦住：${err.slice(0, 300)}`)
    must(/DOCTYPE html/.test(err), `没把拿到的内容打出来（只说「下载失败」没法排障）：${err.slice(0, 300)}`)
    must(!existsSync(join(tmp, 'home', 'bili-watch', 'deps', 'ffmpeg')), 'HTML 被当成压缩包解出了 ffmpeg——预校验失效')
    return 'HTML 错误页被 tar -t 拦住，前 200 字节已打印，没落坏文件'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// C57（2026-10-31，issue #6 坑 3）：venv 不依赖 ensurepip。
//   Ubuntu 26.04 的 python3.14 没带 ensurepip，`python3 -m venv` 直接失败；脚本要能
//   降级到 --without-pip + get-pip.py，且引导失败时**不留半成品 venv**、直接说清该装什么。
//   这里真跑 bootstrap_pip：给一个总是失败的 python，curl 也失败，断言报错内容。
check('C57 venv 引导不依赖 ensurepip，取不到 get-pip 时说清该装什么（issue #6 坑 3）', () => {
  const shPath = join(ROOT, 'scripts', 'fetch-deps.sh')
  if (!existsSync(shPath)) {
    skip('C57 venv 引导不依赖 ensurepip', '找不到 scripts/fetch-deps.sh（仓库结构变了？）')
    return 'ok'
  }
  const sh = read('scripts/fetch-deps.sh')
  must(/--without-pip/.test(sh), 'ensure_venv 没有 --without-pip 降级路径')
  must(/get-pip\.py/.test(sh), '没有 get-pip.py 引导')
  const bash = findBash()
  if (!bash) {
    skip('C57 venv 引导不依赖 ensurepip', '本机没有可用的 bash（静态部分已过）')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c57-'))
  try {
    const script = [
      'set -uo pipefail',
      `DEPS="${tmp.replace(/\\/g, '/')}"`,
      'PY_INDEX=https://pypi.org/simple',
      `eval "$(sed -n '/^bootstrap_pip()/,/^}/p' "${shPath.replace(/\\/g, '/')}")"`,
      'curl() { return 22; }', // 模拟离线/被墙，get-pip.py 取不到
      'FALSE_BIN="$(command -v false)"',
      'if bootstrap_pip "$FALSE_BIN"; then echo "RC=0"; else echo "RC=1"; fi',
      '',
    ].join('\n')
    const r = spawnSync(bash, ['-c', script], { encoding: 'utf8', timeout: 60000 })
    const out = (r.stdout || '') + (r.stderr || '')
    must(/RC=1/.test(r.stdout || ''), `bootstrap_pip 在没有 pip 也没有 get-pip 时应该失败：${out.slice(0, 300)}`)
    must(/取不到 get-pip\.py/.test(out), `没报「取不到 get-pip.py」：${out.slice(0, 300)}`)
    must(/apt install python3-pip/.test(out), `没告诉用户该手工装什么（Debian/Ubuntu 是 apt install python3-pip）：${out.slice(0, 300)}`)
  } finally { rmSync(tmp, { recursive: true, force: true }) }

  // —— 第二个真跑：ensure_venv 删半成品（2026-11-01，DSH 00:44 P1-2）——
  //
  //   上面那段只 eval 了 bootstrap_pip。而「已删除半成品」这两句在 **ensure_venv** 里
  //   （scripts/fetch-deps.sh:303 / :309）—— 原来这里有一条断言拿 bootstrap_pip 的输出去验它，
  //   并且写成 `/已删除半成品/.test(out) || /已删除半成品/.test(sh)`：右半边永远成立（脚本源码里
  //   当然有这句话），于是**这条断言从来没有红过，也永远不可能红**。
  //   这不是「判据不够真」，是**判据在验错的对象**——本批抓到的最典型的纸老虎。
  //
  //   现在真跑一次 ensure_venv：假 python3 只会建目录（建出来的 bin/python 是个永远 exit 1 的
  //   假解释器），于是它必然走「venv 建好了但装不上 pip」那条路。验两件事：
  //     ① 输出里有「已删除半成品」
  //     ② 那个半成品目录**真的被删了**（这才是 DSH 说的「真跑删一次」，光有文案不算）
  // 先确认这台机器的 python3 是**真解释器**（2026-11-01，DSH 01:09 派的第二条）。
  //   Windows 的 App Execution Alias 会在 PATH 里放一个 python3 桩：能执行、打一行
  //   「Python was not found; run without arguments to install from the Microsoft Store」、
  //   **退出码 0**、什么都不做。任何「python3 存在就真跑」的断言都会在它身上翻车，
  //   而且看起来像代码坏了。判据用 `-c "print(1)"` 的输出，**不能用退出码**（桩的退出码也是 0）。
  const pyProbe = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15000 })
  if (String(pyProbe.stdout || '').trim() !== '1') {
    const ver = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 15000 })
    const verText = (String(ver.stdout || '') + String(ver.stderr || '')).trim()
    skip('C57 venv 引导不依赖 ensurepip',
      `本机 python3 不是真解释器（--version: ${verText.slice(0, 90) || '无输出'}），ensure_venv 那段真跑跳过`)
    return 'ok'
  }

  const tmp2 = mkdtempSync(join(tmpdir(), 'bw-c57b-'))
  try {
    const slash = (p) => p.replace(/\\/g, '/')
    const deps2 = join(tmp2, 'deps')
    mkdirSync(deps2, { recursive: true })
    const venvDir = join(deps2, '.venv-fake')
    const script2 = [
      'set -uo pipefail',
      `DEPS="${slash(deps2)}"`,
      'PY_INDEX=https://pypi.org/simple',
      // 假 python3 用 **shell 函数**，不用可执行文件（2026-11-01 实测）：
      //   在 Git Bash / MSYS 里，一个没有 .exe 后缀、也没有执行位的脚本，`command -v` 能找到，
      //   但**执行时会失败**——于是 ensure_venv 悄悄用回了系统的真 python3，
      //   而我上一版还以为是「假 python3 生效」。自检把这件事揭出来了：
      //   那一版走的是「pip install numpy 联网失败 → 删半成品」这条偶然路径，
      //   两条断言碰巧都满足 —— 假绿。
      //   shell 函数没有执行位问题，且**优先级高于 PATH 里的外部命令**，这是最稳的覆盖方式。
      'python3() {',
      '  if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
      '    shift 2',
      '    d=""',
      '    for a in "$@"; do d="$a"; done',
      '    [ -n "$d" ] || return 1',
      '    mkdir -p "$d/bin"',
      '    printf "#!/bin/sh\\nexit 1\\n" > "$d/bin/python"',
      '    return 0',
      '  fi',
      '  return 1',
      '}',
      `eval "$(sed -n '/^bootstrap_pip()/,/^}/p' "${slash(shPath)}")"`,
      `eval "$(sed -n '/^ensure_venv()/,/^}/p' "${slash(shPath)}")"`,
      // 取不到 get-pip → bootstrap_pip 必失败 → 走删半成品那条路。
      // 打一个标记：**走对分支一定会调 curl**。上一版因为假 python3 没生效、venv 里自带 pip，
      // bootstrap_pip 第一句就返回 0、根本没走到 curl，改去联网 pip install（失败后碰巧删了目录），
      // 两条断言都满足 —— 假绿。这条标记把「走的是哪条路」也钉住了。
      'curl() { echo "CURL_CALLED" >&2; return 22; }',
      // 自检（2026-11-01，DSH 01:09）：假 python3 必须真的被执行到。
      //   这台机器的 PATH 前置在个别 shell / 文件系统下可能不生效，这时 ensure_venv 会去用**系统**
      //   的 python3 —— 而 Windows 的 App Execution Alias 会在 PATH 里放一个桩：能执行、打一行
      //   「Python was not found…install from the Microsoft Store」、**退出码 0**、什么都不做。
      //   桩「建 venv 成功」但不建任何东西，于是后面的「半成品目录应该被删掉」必红——
      //   看起来像代码坏了，其实是环境不具备。自检不过一律 skip，不记 FAIL。
      'PROBE="$DEPS/.stub-probe"',
      // 自检只认「假 python3 有没有把 venv 目录建出来」，**不要求 $PROBE/bin/python 可执行**——
      //   那个假解释器本来就是个 exit 1 的壳，能不能执行不影响本用例（我们就是要它装不上 pip）。
      'if python3 -m venv "$PROBE" >/dev/null 2>&1 && [ -d "$PROBE/bin" ]; then echo "STUB_OK=yes"; else echo "STUB_OK=no"; fi',
      'rm -rf "$PROBE"',
      `ensure_venv "${slash(venvDir)}" numpy || true`,
      `[ -e "${slash(venvDir)}" ] && echo "HALF_DIR=yes" || echo "HALF_DIR=no"`,
      '',
    ].join('\n')
    const r2 = spawnSync(bash, ['-c', script2], { encoding: 'utf8', timeout: 60000 })
    const out2 = (r2.stdout || '') + (r2.stderr || '')
    if (!/STUB_OK=yes/.test(r2.stdout || '')) {
      // 假 python3 没被用上 —— 环境问题，不是代码问题。如实跳过，不制造假红。
      const ver = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 15000 })
      const verText = (String(ver.stdout || '') + String(ver.stderr || '')).trim()
      skip('C57 venv 引导不依赖 ensurepip',
        `本机的假 python3 没被调用（PATH 前置没生效）；系统 python3 --version = ${verText.slice(0, 80) || '无输出'}。真跑部分跳过`)
      return 'ok'
    }
    must(/CURL_CALLED/.test(out2), `没走到「取不到 get-pip.py」那条路（venv 里自带 pip？那本用例的前提就不成立）：${out2.slice(0, 400)}`)
    must(/已删除半成品/.test(out2), `venv 装不上 pip 时没打「已删除半成品」：${out2.slice(0, 400)}`)
    must(/HALF_DIR=no/.test(r2.stdout || ''), `半成品目录还在——下次会以为装好了、永远不重装：${out2.slice(0, 400)}`)
  } finally { rmSync(tmp2, { recursive: true, force: true }) }

  return '降级路径在；取不到 get-pip 时报 RC=1 并给出 apt install python3-pip；ensure_venv 真跑一次：半成品被删、有提示'
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
    // 2026-11-01（DSH 00:44 P1-8）：原来是裸 `return '静态判据全过（本机没有 python，…）'`，
    //   执行器把它记成一笔 PASS —— 「本机没跑」就这样变成了「验过了」，通过数虚高。
    //   正解照 C55：先 skip() 记一笔（不算通过也不算失败），再 return。
    skip('C58 GPU 探测跨平台', '本机没有 python，Linux 分支没真跑（结构判据已过）')
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
check('C59 面板「GPU 运行库」的下载按钮不是死按钮：后端放行 cuda，两个脚本都有 cuda 分支（issue #5）', () => {
  const idx = read('index.js')
  const body = fnBody(idx, 'runDownload')
  const m = body.match(/const allowed = \[([^\]]*)\]/)
  must(m, 'runDownload 里找不到 allowed 白名单')
  const allowed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  must(allowed.includes('cuda'), `allowed 不含 cuda（面板的 GPU 行会点出「不支持的依赖」）：${allowed.join('/')}`)

  const sh = read('scripts/fetch-deps.sh')
  // 分支必须真接到函数上，不是只有个 case 标签
  must(/^\s*cuda\)\s*fetch_cuda\s*;;/m.test(sh), 'fetch-deps.sh 没有 cuda 分支（或没接 fetch_cuda）')
  const fn = sh.slice(sh.indexOf('fetch_cuda()'))
  must(/pip install nvidia-cublas-cu12/.test(fn), 'fetch_cuda 没装 nvidia-cublas-cu12')
  must(/--probe-gpu/.test(fn), 'fetch_cuda 装完没跑 --probe-gpu 校验（pip 装成功 ≠ 能加载）')

  const ps1 = read('scripts/fetch-deps.ps1')
  must(/'cuda'/.test(ps1), 'fetch-deps.ps1 的 Target 枚举里没有 cuda')

  // 真跑：没有 .venv-asr 时必须立刻失败并指路，不许去碰网络
  const bash = findBash()
  if (!bash) {
    // 2026-11-01（P1-8）：同 C58，裸 return 会被记成 PASS。改成 skip()。
    skip('C59 面板 GPU 运行库下载按钮', '本机没有 bash，真跑部分没做（结构判据已过）')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c59-'))
  try {
    mkdirSync(join(tmp, 'pkg', 'scripts'), { recursive: true })
    copyFileSync(join(ROOT, 'scripts', 'fetch-deps.sh'), join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'))
    const home = join(tmp, 'home')
    const r = spawnSync(bash, [join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'), 'cuda'], {
      env: { ...process.env, DSH_HOME: home, BILI_WATCH_DEPS: '' },
      encoding: 'utf8', timeout: 60000,
    })
    must(r.status === 1, `没有 ASR 环境时 cuda 分支应 exit 1（别默默成功）：rc=${r.status} ${(r.stderr || '').slice(0, 200)}`)
    must(/先跑 bash scripts\/fetch-deps\.sh asr/.test(r.stderr || ''),
      `没告诉用户先装 ASR 环境：${(r.stderr || '').slice(0, 200)}`)
    must(!/pip install/.test((r.stdout || '') + (r.stderr || '')), '没有 ASR 环境却已经开始 pip install 了')
    return '后端 allowed 含 cuda；sh 的 cuda 分支真跑（无 venv → exit 1 并指路，零网络）；ps1 枚举含 cuda'
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
check('C60 诊断路径不许被 SIGPIPE 打断：`| head` + pipefail 会让脚本 141 静默退出（深入审查）', () => {
  const bash = findBash()
  const shPath = join(ROOT, 'scripts', 'fetch-deps.sh')
  if (!bash || !existsSync(shPath)) {
    skip('C60 诊断路径不许被 SIGPIPE 打断', '本机没有 bash 或找不到 scripts/fetch-deps.sh')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c60-'))
  try {
    mkdirSync(join(tmp, 'pkg', 'scripts'), { recursive: true })
    mkdirSync(join(tmp, 'home', 'bili-watch', 'deps'), { recursive: true })
    mkdirSync(join(tmp, 'bin'), { recursive: true })
    copyFileSync(shPath, join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'))
    // 假 curl：写 xz 魔数（fd 37 7a 58 5a 00），让预校验放行到「看清单」那一步
    const fakeCurl = join(tmp, 'bin', 'curl')
    writeFileSync(fakeCurl, [
      '#!/bin/sh',
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      "printf '\\375\\067\\172\\130\\132\\000' > \"$out\"",
      'exit 0',
      '',
    ].join('\n'))
    // 假 tar：认 xz 魔数，-t 模式吐 6000 项（没有任何 ffmpeg/ffprobe）。
    //   6000 项是为了让 printf 写满管道缓冲 —— 只有输出大于缓冲，head 提前退出
    //   才会真的让上游收到 SIGPIPE。项数太少时 printf 一次写完，测不出问题。
    const fakeTar = join(tmp, 'bin', 'tar')
    writeFileSync(fakeTar, [
      '#!/bin/sh',
      'mode=""; f=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -tJf) mode=t; f="$2"; shift 2 ;;',
      '    -xJf) mode=x; f="$2"; shift 2 ;;',
      '    -C) shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'magic=$(head -c 6 "$f" 2>/dev/null | od -An -tx1 | tr -d " \\n")',
      'case "$magic" in',
      '  fd377a585a00*) ;;',
      '  *) echo "tar: This does not look like a tar archive" >&2; exit 2 ;;',
      'esac',
      'if [ "$mode" = "t" ]; then',
      '  i=0',
      '  while [ $i -lt 6000 ]; do echo "ffmpeg-x-static/filler-$i"; i=$((i+1)); done',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'))
    spawnSync('chmod', ['+x', fakeCurl, fakeTar], { timeout: 15000 })
    const r = spawnSync(bash, [join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'), 'ffmpeg'], {
      env: { ...process.env, DSH_HOME: join(tmp, 'home'), PATH: join(tmp, 'bin').replace(/\\/g, '/') + ':' + (process.env.PATH || '') },
      encoding: 'utf8', timeout: 120000,
    })
    const err = r.stderr || ''
    must(r.status !== 141, '脚本以 141（SIGPIPE）退出——诊断路径被 `| head` 打断了，用户看不到任何原因')
    must(r.status === 1, `缺 ffmpeg/ffprobe 时应 exit 1，实际 ${r.status}：${err.slice(0, 300)}`)
    must(/归档里没有/.test(err), `没打印「归档里没有 ffmpeg ffprobe」：${err.slice(0, 300)}`)
    // 清单只打 10 行，不能把 6000 行全倒出来
    const filler = (err.match(/filler-\d+/g) || []).length
    must(filler === 10, `诊断只该列前 10 项，实际列了 ${filler} 项`)
    return '6000 项清单下仍然 exit 1 并打印前 10 项（没有 141、没有倒满屏）'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// C61（2026-10-31，深入审查抓出）：ffmpeg 装完必须真跑一次 `-version` 才敢说「✓」。
//   E1-01 同族：原来 `cp` 成功就打印 `✓ $DEPS/ffmpeg`，`-version` 只是「顺手打一行、失败也无所谓」。
//   但运行时（look.mjs 的 resolveFfmpeg）会真试跑 `-version`，跑不起来就判「没装 ffmpeg」——
//   于是脚本说装好了、面板说没装，两边对不上。文件在 ≠ 能用。
//   这里用假 tar 造两种解压结果：能跑的 ffmpeg（必须 ✓ 且带版本号）、跑不起来的（必须报错 exit 1）。
check('C61 ffmpeg 装完要真跑一次 -version：文件在 ≠ 能用（E1-01 同族，深入审查）', () => {
  const bash = findBash()
  const shPath = join(ROOT, 'scripts', 'fetch-deps.sh')
  if (!bash || !existsSync(shPath)) {
    skip('C61 ffmpeg 装完要真跑一次 -version', '本机没有 bash 或找不到 scripts/fetch-deps.sh')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c61-'))
  try {
    mkdirSync(join(tmp, 'pkg', 'scripts'), { recursive: true })
    mkdirSync(join(tmp, 'bin'), { recursive: true })
    copyFileSync(shPath, join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'))
    const fakeCurl = join(tmp, 'bin', 'curl')
    writeFileSync(fakeCurl, [
      '#!/bin/sh',
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      "printf '\\375\\067\\172\\130\\132\\000' > \"$out\"",
      'exit 0',
      '',
    ].join('\n'))
    // 假 tar：-t 列两项（含 ffmpeg + ffprobe，过预校验）；-x 按 FAKE_MODE 造出能跑 / 跑不起来的 ffmpeg
    const fakeTar = join(tmp, 'bin', 'tar')
    writeFileSync(fakeTar, [
      '#!/bin/sh',
      'mode=""; f=""; dest=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -tJf) mode=t; f="$2"; shift 2 ;;',
      '    -xJf) mode=x; f="$2"; shift 2 ;;',
      '    -C) dest="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'magic=$(head -c 6 "$f" 2>/dev/null | od -An -tx1 | tr -d " \\n")',
      'case "$magic" in',
      '  fd377a585a00*) ;;',
      '  *) echo "tar: This does not look like a tar archive" >&2; exit 2 ;;',
      'esac',
      'if [ "$mode" = "t" ]; then echo "pkg/ffmpeg"; echo "pkg/ffprobe"; exit 0; fi',
      'mkdir -p "$dest/pkg"',
      // ffmpeg 的内容由调用方通过 FAKE_FFMPEG_BODY 传进来。
      //   别在这层套 printf 转义：`\"` 要穿过 JS 字符串 → 假 tar 的双引号 → printf 的格式串，
      //   三层转义叠起来极易生成一个语法错误的脚本，而失败现象是「跑不起来」，看起来像被测代码的问题。
      'printf "%s" "$FAKE_FFMPEG_BODY" > "$dest/pkg/ffmpeg"',
      'printf "#!/bin/sh\\nexit 0\\n" > "$dest/pkg/ffprobe"',
      'chmod +x "$dest/pkg/ffmpeg" "$dest/pkg/ffprobe"',
      'exit 0',
      '',
    ].join('\n'))
    spawnSync('chmod', ['+x', fakeCurl, fakeTar], { timeout: 15000 })
    const runIt = (tag, body) => spawnSync(bash, [join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'), 'ffmpeg'], {
      env: {
        ...process.env,
        DSH_HOME: join(tmp, tag),
        FAKE_FFMPEG_BODY: body,
        PATH: join(tmp, 'bin').replace(/\\/g, '/') + ':' + (process.env.PATH || ''),
      },
      encoding: 'utf8', timeout: 120000,
    })
    // A：能跑的 ffmpeg → 成功，且提示里带真版本号（证明真跑过，不是只 cp）
    const a = runIt('home-a', '#!/bin/sh\necho "ffmpeg version 9.9-static (fake)"\n')
    must(a.status === 0, `ffmpeg 能跑时应 exit 0，实际 ${a.status}：[out]${a.stdout || ''}[err]${a.stderr || ''}`)
    must(/ffmpeg version 9\.9-static \(fake\)/.test(a.stdout + a.stderr),
      `✓ 提示里没有真版本号——说明没真跑 -version：${(a.stdout || '').slice(0, 200)}`)
    // B：文件放下了但跑不起来 → 必须失败并说清，不许打 ✓
    const b = runIt('home-b', '#!/bin/sh\nexit 1\n')
    must(b.status === 1, `ffmpeg 跑不起来时应 exit 1（不许默默成功），实际 ${b.status}`)
    must(/ffmpeg -version 跑不起来/.test(b.stderr || ''), `没报「跑不起来」：${(b.stderr || '').slice(0, 300)}`)
    must(!/✓/.test(b.stdout || ''), `跑不起来却打了 ✓：${(b.stdout || '').slice(0, 200)}`)
    return '能跑的 ffmpeg → ✓ 且带真版本号；跑不起来的 → exit 1 并说清（不再由 cp 退出码推导成功）'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
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

// 2026-10-31 切片 3-C：appendRunLine 的轮转与追加搬进 lib/runs.mjs，两个入口各一行调用。
//   搬之前这段逻辑没有任何断言（grep appendRunLine 在 verify.mjs 里是 0 条）——
//   也就是说「日志无限涨」「写日志把调用搞挂」两条都不设防。搬进 lib 正好补上。
check('C63 appendJsonLine 真跑：自动建目录、满 2000 行 / 5 MB 轮转成 .1、写失败不抛（切片 3-C）', () => {
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

// ── 切片 4：缓存根的**状态与时序**（2026-10-31）────────────────────────────
// DSH 2026-10-31 16:58 定的三条硬要求，这里逐条落成断言：
//   ① 真起两个进程，比对 stdout/stderr 里的**实际路径**——不比源码；
//   ② 删掉初始化调用必须红，而且要红在「路径不对」；
//   ③ 未初始化就调 cacheDir() 必须抛。
// 为什么这一片不能沿用前三个切片的 compile 套路：那三片搬的是纯函数（输入 → 输出），
//   抽出来跑等价于真跑；这一片搬的是可变模块状态 + 「谁先调」，compile 抽不出状态，抽出来的
//   函数体看着对、跑起来照样错——正是 DSH 说的「唯一一步 compile 会骗人」。
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

check('C64 两个入口各起真进程，算出同一个缓存根（切片 4：状态与时序 compile 验不出来）', () => {
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
  //   自定义场景再按需补回来——否则跑的人 shell 里带着这个变量就一定假红（DSH 2026-10-31 踩到）。
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

check('C65 未初始化就调 cacheDir() 必须抛，且点名 initCachePath（切片 4：不许返回「看着能用」的默认值）', () => {
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

check('C66 缓存根的状态与推导只剩 lib/cache-path.mjs 一份（切片 4：两个入口都不许再自己存 CACHE）', () => {
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

// ── 切片 4 补丁：面板侧 logRun 落盘的真跑证据（2026-10-31）────────────────────
// 切片 4 收尾时留了一处「靠推断」：index.js 侧 logRun → videoDir → runsFile() 这条链只验了
//   CLI 那半边（CLI 跑一条坏命令 → runs.jsonl 有行），面板侧从没真跑过。
//   DSH 17:26 指出的手法与 C64 同源：probe 里真调 apply()，拿它注册的 handler，喂一条必失败的命令。
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

check('C67 面板侧 logRun 真写盘：跑一条必失败的命令，runs.jsonl 有行、BV 目录有 last-error.json（切片 4 唯一「靠推断」的那处）', () => {
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

// ── 切片 5：凭证的位置与迁移（2026-10-31）────────────────────────────────
// 验收「凭证路径两入口一致」不能只靠读源码：路径是算出来的，两个进程各算一次才是证据。
// 这里走 /status 的真实路径（credState → resolveCredPath → adoptLegacyCred），
// 用「旧 deps 凭证有没有被搬到 $DSH_HOME」这个副作用来判断它算到了哪——面板侧不打印路径
// （/status 里那份是遮罩过的），所以只能看落点。
check('C68 面板侧的凭证也认 lib 的路径：旧 deps 凭证被迁到 $DSH_HOME，旧文件不删（切片 5）', () => {
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

// ── 切片 5 的判据 #2：两个入口的同名函数必须归零（可执行化）────────────
// 计划里写的是「同名 23 → 0」。实测收到 1（ensureCache），它不是逻辑重复：
//   两侧各 1 行，只差「pushWarn(maskAbs(...))」与「console.error(...)」——这是 lib 不产文案的必然结果
//   （面板要进 /status.warnings，CLI 要打 ASCII 前缀的 stderr）。
// 所以判据不追求字面 0，而是把「允许剩下哪些」写成白名单，并约束它的体量：
//   以后谁再复制粘贴一个函数过去，这条立刻红——这正是切片 5 要守的。
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

check('C69 两个入口的同名顶层函数只剩文案薄壳：白名单之外一个都不许有（切片 5 的判据 #2）', () => {
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

// ── 切片 6 前置：apply(ctx) / 路由 / sendJson 在 78 条断言里出现 0 次（2026-10-31）──
// DSH 18:02 派的活：先在**没有任何断言覆盖**的这段代码上补三条真跑，再动刀。
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
  // 分支四：写端点 /cache/clear 真跑（DSH 18:24：这六条会删用户文件，不该一直靠人工审）。
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

check('C70 /status 真跑：apply() 注册的 handler 喂进去，回 200 + ok:true + 面板要的字段一个不少（切片 6 前置）', () => {
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

check('C71 sendJson 三个分支真跑：200 带 Content-Type、ok:false 走 404、抛错兜底 500（切片 6 前置）', () => {
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

check('C72 claimRoute 真跑：同路径重复 apply 只注册一次，dispose 后必须能再注册（切片 6 前置，T41-P0-1）', () => {
  const d = routeProbe()
  // ② 同进程再 apply 一次（fiber 重放）：必须被挡住，否则同一个路径挂两个 handler
  must(d.afterTwice === 1, `同一路径 apply 两次注册了 ${d.afterTwice} 个——claimRoute 没挡住重放，两个 handler 会抢同一个 res`)
  // ③ dispose 之后必须能重新注册：不 release 的话重放后路由永久 404（原注释写的正是这个坑）
  must(!d.disposeErr, `apply() 返回的 dispose 抛错了：${d.disposeErr}`)
  must(d.afterDispose === 2, `dispose 之后重新 apply 没有重新注册（共 ${d.afterDispose} 个）——releaseRoute 没执行，重放后这条路由永久 404`)
  return `apply×2 → 1 个注册；dispose 后再 apply → ${d.afterDispose} 个（release 生效）`
})

// 切片 6 把 apply(ctx) 从 429 行拆成 5 个子系统 + 8 行调度。这条断言盯两件事：
//   ① apply 本身不许再长回去（上限 120 是 DSH 定的）；
//   ② 五个子系统必须还在、必须有实质内容，且 apply 真的调它们——
//      否则「拆」可以靠「把内容删掉」通过，那不是拆。
check('C73 apply(ctx) 只剩调度：五个子系统各在其位，加起来的量级没缩水（切片 6：429 → 8 行）', () => {
  const fn = topFunctions(read('index.js'))
  must(fn.has('apply'), '找不到 apply')
  const body = fn.get('apply')
  const la = codeLines(body)
  // 判据一律打在 codeLines 上，不打在原函数体上：R13 第一版就是这么假绿的——
  //   把 `registerTool(ctx)` 注释掉，`/registerTool\(ctx\)/` 仍然匹配到那行注释，
  //   于是「不接线」也能全绿。注释里提到的名字不算接线。
  const code = la.join('\n')
  must(la.length <= 120, `apply 又长回来了：${la.length} 行（上限 120，切片 6 已拆成调度）`)
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
  //   而 DSH 18:02 点名的第三支「不同路径不冲突」黑盒根本测不到（面板只有一个路径）。
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

check('C76 /cache/clear 真跑：删本插件的 BV 目录、不碰用户自己放的文件、skipped 里点名（DSH 18:24）', () => {
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

// ── C78：jget 的五个特殊分支（切片 8 搬进 lib/bili-api.mjs 时的真跑证据）──────
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
  return '412 / HTML / -352 / -999 / 5xx 重试两次 / 404 全对，diag 七次'
})

// ── C79：verify-todo 的 fnBody（预处理函数）自检 ─────────────────────────
// DSH 18:48 定的规矩：**凡是「先预处理再匹配」的断言，预处理函数本身要有用例**（B5 那次
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
  return 'export 认、ghost 不认、截断在行首 } 之前'
})

// ── C81/C82：ffExec 与 findFfmpeg 真起进程（切片 9 第一步，DSH 20:05 点名）─────────
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
//   成功下载那两条，任何一支被搬丢、被改坏，基线一个字都不会变。切片 9 第二步把 downloadTo
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
    skip('C86 sceneTimes 真起 ffmpeg', '本机找不到 ffmpeg（PATH / BILI_WATCH_FFMPEG / deps 都没有）——跳过不算通过')
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

  // ⑥ must 自己必须会抛（2026-11-01，DSH 00:44 P0-3）
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

  // ⑧ 抛出物转不成字符串时，执行器也不许崩（2026-11-01，DSH 00:44 P1-7）
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

check('C80 fetch-deps.ps1 的 py 版本回退链不会被 $ErrorActionPreference=Stop 掐断（issue #7）', () => {
  // issue #7 的 P0：全局 $ErrorActionPreference='Stop'（:63），而 py 启动器探测「没装的版本」时
  //   往 stderr 写 [ERROR] No runtime installed that matches 3.x。Stop 下原生命令写 stderr 会抛
  //   NativeCommandError —— 第一个候选 3.13 就炸，回退链一次都没走到。
  //   本机 py -0 只有 3.14.6，实测：修复前直接抛、修复后逐级跳过并拿到 3.14.6。
  // 同一个坑同文件里有过第二处（GPU 探测那段 ±520 行），那次只修了一处，所以再钉一条结构断言。
  const src = read('scripts/fetch-deps.ps1')
  // fnBody 只认 JS 的 function NAME( 写法；PowerShell 写的是 function NAME {，行首 } 收尾，自己抽。
  const psBody = (n) => {
    const i0 = src.indexOf(String.fromCharCode(102) + "unction " + n)
    if (i0 < 0) return ""
    const j0 = src.slice(i0).indexOf(String.fromCharCode(10) + "}")
    return j0 < 0 ? "" : src.slice(i0, i0 + j0 + 2)
  }
  const body = psBody('Get-SystemPython')
  must(body.length > 200, `Get-SystemPython 抽出来只有 ${body.length} 字符`)

  const iCont = body.indexOf("$ErrorActionPreference = 'Continue'")
  const iLoop = body.indexOf("foreach ($v in @('3.13'")
  must(iCont >= 0, 'Get-SystemPython 里没有临时切 Continue —— Stop 下 py 探测没装的版本会抛、整条回退链断掉')
  must(iLoop > iCont, 'Continue 必须切在 py 候选循环之前，切在后面等于没切')
  must(/finally\s*\{[\s\S]{0,120}\$ErrorActionPreference\s*=\s*\$eapProbe/.test(body), '有 finally 但没有恢复 $ErrorActionPreference —— 泄漏到调用方，后面任何原生命令写 stderr 都会炸')
  // 跳过时要让用户看得出是「版本没有」而不是「网络问题」
  must(body.includes('不可用'), '跳过候选时没有说明原因（应打「py -3.x 不可用（退出码 N），试下一个版本」）')

  // 真跑：把函数体抠出来拼成最小脚本，Stop 下调用一次，不许抛。
  //   py 不存在时只跑结构断言（本机与 CI 都可能没有 py 启动器）。
  const py = spawnSync('powershell.exe', ['-NoProfile', '-Command', "if (Get-Command py -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }"], { encoding: 'utf8', timeout: 15000 })
  if (!String(py.stdout || '').includes('yes')) {
    // 2026-11-01（P1-8）：同上，裸 return 记成 PASS。改成 skip()。
    skip('C80 fetch-deps.ps1 的 py 回退链', '本机没有 py 启动器，真跑部分没做（结构判据已过）')
    return 'ok'
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c80-'))
  const ps1 = join(tmp, 'probe.ps1')
  // 只要 Get-SystemPython 需要的 Test-PyVersion 一并带上
  const prelude = psBody('Test-PyVersion')
  const script = `$ErrorActionPreference = 'Stop'\n${prelude}\n${body}\n$r = Get-SystemPython\nWrite-Output ("OK|" + $r)\n`
  writeFileSync(ps1, '\uFEFF' + script, 'utf8')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8', timeout: 60000 })
  rmSync(tmp, { recursive: true, force: true })
  const out = String(r.stdout || '') + String(r.stderr || '')
  must(r.status === 0, `Stop 下调 Get-SystemPython 退出码 ${r.status}（回退链又被掐断了）：${out.slice(0, 300)}`)
  must(/OK\|/.test(out), `没拿到解释器路径：${out.slice(0, 300)}`)
  must(!/NativeCommandError|Unhandled/i.test(out), `输出里还有未捕获异常：${out.slice(0, 300)}`)
  return `结构 + 真跑都过（${(out.match(/OK\|([^\n]+)/) || [])[1] || '?'}）`
})

// ── C87/C88：切片 10 的 cache 层（目录 / manifest / 等他人）与锁工厂，真跑 ──────
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
    // TTL 传的是**取值函数**：每次抢锁现取，改配置下一把生效
    const locks = makeLocks({ ttlMs: () => ttlSeen })
    // tryLockSync 是同步版（tryLock 是 async，见下面的子进程探针）
    const l1 = locks.tryLockSync(dir)
    must(l1 && l1.f, '第一次抢锁失败')
    must(existsSync(l1.f), '抢到锁但锁文件不在')
    const body = JSON.parse(readFileSync(l1.f, 'utf8'))
    must(body.ttlMs === 7, `锁体里的 ttl 是 ${body.ttlMs}，应是现取的 7`)
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
    ttlSeen = 99
    const l4 = locks.tryLockSync(dir)
    must(l4 && JSON.parse(readFileSync(l4.f, 'utf8')).ttlMs === 99, 'TTL 不是现取的（改配置后仍写旧值）')
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

// ── C89：切片 11 的三稿复制提示词（正文逐字节一致 + 按钮位置 + 不带内部东西）──────
// DSH 21:05 的验收是「把三个按钮实际复制出的文本各贴一份原样出来」——靠人眼比不行，
// 改成可执行断言：把 client.js 里 `const COPY_XXX = String.raw`...`` 当浏览器里那样求值，
// 与审查文件里的三个代码块逐字节比。任何人改了稿子忘了同步、或改坏了转义，这条都会红。
check('C89 三稿复制提示词：正文与审查文件逐字节一致、三稿互斥、按钮在对应区块、无内部编号', () => {
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
  // ① 与审查文件逐字节一致（审查文件不在仓库里 → 拿不到时跳过这一项，其余照查）
  const mdPath = join(ROOT, '..', '..', '项目', 'bili-watch', '审查', '20261031-复制提示词三稿.md')
  let mdNote = '审查文件不在（不在本仓库内，跳过逐字节比对）'
  if (existsSync(mdPath)) {
    const mdBlocks = [...readFileSync(mdPath, 'utf8').matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1])
    must(mdBlocks.length === 3, `审查文件里代码块是 ${mdBlocks.length} 个，应为 3 个`)
    names.forEach((n, i) => {
      must(texts[n] === mdBlocks[i],
        `${n} 与审查文件第 ${i + 1} 段不一致（${texts[n].length} B vs ${mdBlocks[i].length} B）——正文改了要同步`)
    })
    mdNote = '三段都与审查文件逐字节一致'
  }
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
  // ⑥ 按钮位置：稿一稿二在「遇到问题」区，稿三在「面板打不开」区（DSH 21:58 的结构建议）
  const secDeps = cli.slice(cli.indexOf("'遇到问题'"), cli.indexOf("'面板打不开'"))
  const secPanel = cli.slice(cli.indexOf("'面板打不开'"), cli.indexOf("'抽帧缓存'"))
  must(secDeps.includes('text: COPY_DEPS') && secDeps.includes('text: COPY_ASR'),
    '稿一稿二的按钮不在「遇到问题」区里')
  must(!secDeps.includes('text: COPY_PANEL'), '稿三的按钮混进了「遇到问题」区')
  must(secPanel.includes('text: COPY_PANEL'), '稿三的按钮不在「面板打不开」区里')
  must(cli.indexOf("'遇到问题'") > cli.indexOf("'运行依赖'"), '「遇到问题」区跑到「运行依赖」区前面了')
  must(cli.indexOf("'遇到问题'") < cli.indexOf("'抽帧缓存'"), '「遇到问题」区跑到「抽帧缓存」区后面了')
  // 按钮标签必须是**症状本身**，三稿不能同名 ——
  //   DSH 21:58 原话：「统一叫『复制排查提示词』等于把三稿当一份用，正是参考实现踩过的坑」。
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

// ── C90：三审抓出的三条 P0 的守卫（2026-10-31 三审 / 切片 4、5）──────────────────
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
    //  切片 5 把它变成实参后求值点跑到调用点（try 之外）→ 面板侧 index.js 的
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
// C69 只查「同名顶层 function」——但切片 8/9 搬完之后的薄壳大多是
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
// 现场：切片 5 把 [cred] 提示绑在 a.moved 上，于是「新位置写不了 → 退回用 deps/ 里那份旧凭证」
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
  // 2026-11-01（DSH 00:44 P1-8）：C58 / C59 / C80 原来是「工具不在就 return 一句说明」。
  //   执行器收下那个字符串，记成一笔 **PASS** —— 「本机没跑」被算成「验过了」：
  //   通过数虚高，而且**越缺依赖的机器看起来越绿**（缺 python 的 CI 反而全过）。
  //   正解是 C55 的写法：先 skip() 记一笔（不算通过也不算失败），再 return。
  //
  //   这条守卫只扫一种形状：`if` 取反一个标识符之后直接跟 `return '...'`。
  //   多行形状（`if (!String(x).includes(...)) { return '...' }`）它扫不到 —— 那种要人看，
  //   本批 C80 那处就是多行形状，是我手改的。
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
  // 2026-11-01（DSH 00:44 P1-5）：`OWN_CACHE_DIRS.has(name)` 原来一票通过——**只看名字**。
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

// ── C94：fetch-deps.sh 两处「判断反了」的 P2（2026-11-01，DSH 派单，两条都本机复现过）──
//   ① `printf '%s\n' "$list" | grep -Eq …`：grep -q 一命中就退出，上游 printf 还在灌几千行
//      → SIGPIPE → pipefail 把整条管道判成 141 → `||` 把 miss 写上 →「官方静态包」被报成
//      「归档里没有 ffmpeg ffprobe」并 exit 1（本机实测命中场景 rc=141）。
//   ② `ver="$(… -version 2>&1 | sed -n '1p' || true)"`：2>&1 让 stderr 上的报错也算「有输出」，
//      `|| true` 又抹掉 ffmpeg 的退出码 —— 装坏了照样打 ✓（本机假 ffmpeg 复现）。
//   光看源码形状不够（缩进/引号一改就漏），这里按**真实顺序**真跑脚本：ffmpeg/ffprobe 在清单
//   前两行 + 6000 行填充（必须大于管道缓冲，printf 才写不完），解出来的 ffmpeg 用假脚本替身。
check('C94 fetch-deps.sh：清单判断不吃 SIGPIPE(141)、ffmpeg 真跑只认它自己的退出码（P2 两条）', () => {
  const bash = findBash()
  const shPath = join(ROOT, 'scripts', 'fetch-deps.sh')
  if (!bash || !existsSync(shPath)) {
    skip('C94 fetch-deps.sh 两处 P2', '本机没有 bash 或找不到 scripts/fetch-deps.sh')
    return 'ok'
  }
  const sh = read('scripts/fetch-deps.sh')
  // 只看代码行：注释里写着「原来写 `… 2>&1 | sed`」这种反例，按全文匹配会把注释当代码判
  const shCode = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  // 源码层（先拦最容易回退的形态，比真跑更快给出「改回哪儿了」）
  const pipeGrep = shCode.split('\n').filter((l) => /printf/.test(l) && /\|/.test(l) && /grep\s+-[A-Za-z]*q/.test(l))
  must(pipeGrep.length === 0,
    '还在用 `printf … | grep -q` 判清单：grep 命中即退出会让 printf 吃 SIGPIPE（pipefail 下 rc=141，判断反）。改用 here-string → ' + (pipeGrep[0] || '').trim())
  must(!/"\$DEPS\/ffmpeg"\s+-version\s+2>&1/.test(shCode),
    'ffmpeg -version 那次又把 2>&1 加回来了：stderr 上的报错会被当成「有输出 = 成功」')
  must(/rc=\$\?/.test(shCode) && /\[ "\$rc" -ne 0 \]/.test(shCode),
    'ffmpeg 真跑没把自己的退出码收进 $rc 再判 —— 退出码必须来自 ffmpeg 本身，不能来自 sed/管道')
  const tmp = mkdtempSync(join(tmpdir(), 'bw-c94-'))
  try {
    mkdirSync(join(tmp, 'pkg', 'scripts'), { recursive: true })
    mkdirSync(join(tmp, 'bin'), { recursive: true })
    copyFileSync(shPath, join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'))
    const fakeCurl = join(tmp, 'bin', 'curl')
    writeFileSync(fakeCurl, [
      '#!/bin/sh',
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      "printf '\\375\\067\\172\\130\\132\\000' > \"$out\"",
      'exit 0',
      '',
    ].join('\n'))
    // 假 tar：-t 先吐 ffmpeg/ffprobe（**顺序是关键**：命中在前，grep 才会提前退出，
    //   printf 才写不完 → 老写法必 141），再吐 6000 行填充；-x 按 $FAKE_FFMPEG_BODY 造 ffmpeg。
    const fakeTar = join(tmp, 'bin', 'tar')
    writeFileSync(fakeTar, [
      '#!/bin/sh',
      'mode=""; f=""; dest=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -tJf) mode=t; f="$2"; shift 2 ;;',
      '    -xJf) mode=x; f="$2"; shift 2 ;;',
      '    -C) dest="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'magic=$(head -c 6 "$f" 2>/dev/null | od -An -tx1 | tr -d " \\n")',
      'case "$magic" in',
      '  fd377a585a00*) ;;',
      '  *) echo "tar: This does not look like a tar archive" >&2; exit 2 ;;',
      'esac',
      'if [ "$mode" = "t" ]; then',
      '  echo "ffmpeg-x-static/ffmpeg"',
      '  echo "ffmpeg-x-static/ffprobe"',
      '  i=0',
      '  while [ $i -lt 6000 ]; do echo "ffmpeg-x-static/doc/filler-$i"; i=$((i+1)); done',
      '  exit 0',
      'fi',
      'mkdir -p "$dest/ffmpeg-x-static"',
      'printf "%s" "$FAKE_FFMPEG_BODY" > "$dest/ffmpeg-x-static/ffmpeg"',
      'printf "#!/bin/sh\\nexit 0\\n" > "$dest/ffmpeg-x-static/ffprobe"',
      'chmod +x "$dest/ffmpeg-x-static/ffmpeg" "$dest/ffmpeg-x-static/ffprobe"',
      'exit 0',
      '',
    ].join('\n'))
    spawnSync('chmod', ['+x', fakeCurl, fakeTar], { timeout: 15000 })
    const runIt = (tag, body) => spawnSync(bash, [join(tmp, 'pkg', 'scripts', 'fetch-deps.sh'), 'ffmpeg'], {
      env: {
        ...process.env,
        DSH_HOME: join(tmp, tag),
        FAKE_FFMPEG_BODY: body,
        PATH: join(tmp, 'bin').replace(/\\/g, '/') + ':' + (process.env.PATH || ''),
      },
      encoding: 'utf8', timeout: 120000,
    })
    // A：清单里有 ffmpeg（前两行）+ 6000 行填充 → 必须走到底并打 ✓。
    //   老写法在这里被 SIGPIPE 打成「归档里没有 ffmpeg ffprobe」+ exit 1。
    const a = runIt('home-a', '#!/bin/sh\necho "ffmpeg version 9.9-static (fake)"\n')
    must(a.status === 0, `清单里明明有 ffmpeg，脚本却 exit ${a.status}（SIGPIPE 让判断反了）：[err]${(a.stderr || '').slice(0, 300)}`)
    must(!/归档里没有/.test(a.stderr || ''),
      '误报「归档里没有 ffmpeg ffprobe」—— grep 命中后 printf 吃 SIGPIPE（141）被当成「不命中」')
    must(/✓ .*ffmpeg version 9\.9-static \(fake\)/.test(a.stdout || ''),
      `没打带版本的 ✓：${(a.stdout || '').slice(0, 300)}`)
    // B：ffmpeg 文件在、但跑起来往 stderr 报错并 exit 127 → 必须 exit 1、不许打 ✓。
    //   老写法把 stderr 那行错误当成「版本号」，打 ✓ 并 exit 0。
    const b = runIt('home-b', '#!/bin/sh\necho "ffmpeg: error while loading shared libraries: libavdevice.so.61" >&2\nexit 127\n')
    must(b.status === 1, `坏 ffmpeg 应 exit 1，实际 ${b.status}（2>&1 把 stderr 当成了成功证据）`)
    must(/ffmpeg -version 跑不起来/.test(b.stderr || ''), `没报「跑不起来」：${(b.stderr || '').slice(0, 300)}`)
    must(/rc=127/.test(b.stderr || ''), `失败提示里没带 ffmpeg 自己的退出码：${(b.stderr || '').slice(0, 300)}`)
    must(!/✓/.test(b.stdout || ''), `坏 ffmpeg 却打了 ✓：${(b.stdout || '').slice(0, 300)}`)
    return '6000 行清单命中 → ✓（不是 141 假的「没有」）；坏 ffmpeg → exit 1 带 rc=127（不再靠 stderr 输出判成功）'
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// —— 延迟异步检测（2026-11-01，DSH 00:44 P1-6）——
//
//   C77 的 thenable 守卫只看 `fn()` 的**返回值**：`check('X', async () => …)` 返回 Promise，拦得住。
//   但这一种拦不住：回调**同步返回 undefined**，异步体是它自己起的——
//       check('X', () => { setTimeout(() => { must(false, '…') }, 0) })
//   异步体在 check() 返回之后才跑：它记的结果要么赶在汇总之前（偶发、看运气），要么赶不上
//   （永远不显示）；里面要是抛错，直接 uncaughtException 把进程带走，一条汇总都不打。
//
//   做法照 DSH 给的第二个选项：汇总之前让出两轮事件循环（setImmediate + setTimeout 0），
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
process.exit(fail ? 1 : 0)
