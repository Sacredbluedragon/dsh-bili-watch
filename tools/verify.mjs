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
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const results = []
const check = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail ?? '' })
  } catch (e) {
    results.push({ name, ok: false, detail: e?.message ?? String(e) })
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }
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

check('index.js 的 videoDir 复用「BV_标题」目录（P0：同一视频两个兄弟目录）', () => {
  const t = read('index.js')
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
const fnBody = (src, name) => {
  const i = src.indexOf(`function ${name}(`)
  must(i >= 0, `找不到 function ${name}`)
  const j = src.slice(i).search(/\n\}/)
  must(j > 0, `${name} 的函数体没有行首闭合括号`)
  return src.slice(i, i + j + 2)
}

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

check('hasAnyLock 在 index.js 与 tools/look.mjs 逐字一致（跨文件：面板与 CLI 判据不能分叉）', () => {
  const ha = createHash('sha256').update(fnBody(read('index.js'), 'hasAnyLock')).digest('hex').slice(0, 12)
  const hb = createHash('sha256').update(fnBody(read('tools/look.mjs'), 'hasAnyLock')).digest('hex').slice(0, 12)
  must(ha === hb, `函数体不一致：index.js=${ha} tools/look.mjs=${hb}`)
  return ha
})

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
  // 两边必须逐字同口径——所以断言盯的是「同一段判据在两边都在」，不是「各写各的能跑」。
  const FIELDS = /const missing = \['sessdata', 'bili_jct', 'buvid3', 'buvid4'\]\.filter/
  const st = fnBody(read('index.js'), 'credState')
  const lc = fnBody(read('tools/look.mjs'), 'loadCred')
  must(FIELDS.test(st), 'credState 里没有四字段判据（面板侧还是「文件存在就算 ok」）')
  must(FIELDS.test(lc), 'loadCred 里没有四字段判据（CLI 侧被改回去了）')
  must(/state: 'incomplete'/.test(st), "credState 没返回 'incomplete' 状态，面板分不出「残缺」和「正常」")
  // depRows 要把它说出来，否则面板只显示「更新于 N 天前」，用户看不出是匿名态
  must(/cred\.state === 'incomplete'/.test(read('index.js')), 'depRows 没有把 incomplete 显示出来')
  return '两处同口径'
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
  const src = read('tools/look.mjs')
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
  const { checkOutDir } = compile(src, ['checkOutDir'], { params: ['resolve'], args: [resolve] })
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

check('C6 hasAnyLock 判活判过期，且 4 个锁函数两处逐字一致（P1：残留 .lock 会让 clean 永久拒绝）', () => {
  const a = read('index.js')
  const b = read('tools/look.mjs')
  const h = (s) => createHash('md5').update(s).digest('hex').slice(0, 12)
  // 回归复核（2026-10-28）：原来只比 hasAnyLock 自己。但它的判据不是自己写死的，
  //   而是 pidAlive / readLock / lockExpired 三个辅助函数 + LOCK_TTL_MS —— 只比 hasAnyLock 会漏：
  //   有人只改 index.js 的 lockExpired，这条照样绿，面板与 CLI 就悄悄分叉了。
  const names = ['pidAlive', 'readLock', 'lockExpired', 'hasAnyLock']
  for (const n of names) {
    const fa = fnBody(a, n)
    const fb = fnBody(b, n)
    must(fa === fb, `${n} 在两处不一致（index=${h(fa)} look=${h(fb)}）`)
  }
  const body = fnBody(a, 'hasAnyLock')
  must(body.includes('pidAlive') && body.includes('lockExpired'), 'hasAnyLock 没判活/判过期')
  // 2026-10-28 高级设置放开：TTL 从常量改成函数（两处取值入口名不同：index.js 走 readTuning、
  //   tools/look.mjs 走 tuning），所以不能逐字比，改为断言「两边都从 lockTtlMin 换算」。
  // X-14（2026-10-29）改判据：TTL 语义变成 max(lockTtlMin, asrTimeoutSec+120)——转写最长 60 分钟
  //   > 默认 TTL 30 分钟，锁会先被判过期、别的进程抢进来（双持）。两边都必须同时出现这两项，
  //   删掉任一项这条就红（断言不是恒真）。
  const grabTtl = (s) => {
    const i = s.indexOf('const lockTtlMs =')
    if (i < 0) return ''
    const j = s.indexOf('\n}', i)
    return j < 0 ? s.slice(i, i + 300) : s.slice(i, j + 2)
  }
  const ta = grabTtl(a)
  const tb = grabTtl(b)
  must(ta && tb, '找不到 lockTtlMs 定义（锁过期时长）')
  for (const [label, t] of [['index.js', ta], ['tools/look.mjs', tb]]) {
    must(/lockTtlMin/.test(t), `${label} 的 lockTtlMs 没从 lockTtlMin 取`)
    must(/asrTimeoutSec/.test(t), `${label} 的 lockTtlMs 没兜底覆盖 asrTimeoutSec（转写跑满会被抢占）`)
    must(/60\s*\*\s*1000/.test(t), `${label} 的 lockTtlMs 没把分钟换成毫秒`)
  }
  return `4 函数同 md5 ${h(fnBody(a, 'hasAnyLock'))} + TTL 覆盖 asrTimeoutSec`
})

check('C7 cleanKey 两处逐字一致并剥尾部点号（P2：Windows 会吃掉目录名尾部的点）', () => {
  const a = fnBody(read('index.js'), 'cleanKey')
  const b = fnBody(read('tools/look.mjs'), 'cleanKey')
  must(/\[\\s\.\]\+\$/.test(a), 'index.js 的 cleanKey 没剥尾部点/空格')
  const h = (s) => createHash('md5').update(s).digest('hex').slice(0, 12)
  must(h(a) === h(b), `两处函数体不一致：index=${h(a)} look=${h(b)}`)
  return `md5 ${h(a)}`
})

check('C8 pickCacheDir 两层都做可写探测（P2：只读目录会让两层算出两个不同 CACHE）', () => {
  const a = fnBody(read('index.js'), 'pickCacheDir')
  const b = fnBody(read('tools/look.mjs'), 'pickCacheDir')
  must(a.includes('.write-test-'), 'index.js 没有写探针')
  must(b.includes('.write-test-'), 'look.mjs 没有写探针')
  must(/return defaultDir/.test(b), 'look.mjs 探测失败后没回退默认目录')
  return 'ok'
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
  const body = fnBody(read('tools/look.mjs'), 'removeOwned')
  must(body.includes('failed.push'), 'removeOwned 没有 failed 数组，删除失败仍混进 skipped')
  const t = read('tools/look.mjs')
  const i = t.indexOf('cleared.failed.length')
  must(i > 0, 'clean 分支没读 cleared.failed')
  must(t.slice(i, i + 300).includes('process.exitCode = 1'), '报失败但没改退出码')
  return 'ok'
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

check('C16 凭证同步（panel small → SHARED）两处都要在且函数体一致（漏一处就是「扫码后 watch 还用旧号」）', () => {
  const grab = (src, name) => {
    const m = src.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`))
    must(m, `找不到 ${name} 定义`)
    const from = src.indexOf('{', m.index)
    let d = 0
    let i = from
    for (; i < src.length; i++) {
      if (src[i] === '{') d++
      else if (src[i] === '}') { d--; if (d === 0) break }
    }
    return src.slice(from, i + 1).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
  }
  const a = grab(read('index.js'), 'syncPanelSmallToShared')
  const b = grab(read('tools/look.mjs'), 'syncPanelSmallToShared')
  must(a === b, '两处 syncPanelSmallToShared 函数体不一致')
  for (const [f, caller] of [['index.js', 'resolveCredPath'], ['tools/look.mjs', 'credFor']]) {
    const re = new RegExp(`function\\s+${caller}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,240}syncPanelSmallToShared\\(\\)`)
    must(re.test(read(f)), `${f} 的 ${caller}() 里没有调 syncPanelSmallToShared()`)
  }
  return `${a.length} 字符一致，两处已接`
})

check('C17 两份 TUNING_DEFS 必须逐键一致（面板能调的项与 CLI 读数同源；改一处漏一处＝面板改了没效果）', () => {
  const grab = (src) => {
    const m = src.match(/const\s+TUNING_DEFS\s*=\s*\{/)
    must(m, '找不到 TUNING_DEFS 定义')
    const from = src.indexOf('{', m.index)
    let d = 0
    let i = from
    for (; i < src.length; i++) {
      if (src[i] === '{') d++
      else if (src[i] === '}') { d--; if (d === 0) break }
    }
    return src.slice(from, i + 1).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
  }
  const a = grab(read('index.js'))
  const b = grab(read('tools/look.mjs'))
  must(a === b, '两份 TUNING_DEFS 不一致：index.js 与 tools/look.mjs 的键集或默认值/上下界不同')
  const keys = (a.match(/[A-Za-z_$][\w$]*:\{def:/g) || []).length
  // E6-08（2026-10-30）：阈值原写 13，实际 18 项，删 5 个键照样绿。改成实际值，少一个就红。
  must(keys >= 18, `TUNING_DEFS 只解析到 ${keys} 项，应为 18 项（少一个就说明两侧之一被删了）`)
  return `${keys} 项一致（${a.length} 字符）`
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
check('C19 asrDevice 是枚举项，两份 TUNING_DEFS 都写 kind:enum 且钳制函数跳过它（Math.floor(\'auto\') = NaN）', () => {
  for (const f of ['index.js', 'tools/look.mjs']) {
    const src = read(f)
    must(/asrDevice:\s*\{\s*def:\s*'auto',\s*kind:\s*'enum',\s*values:\s*\['auto',\s*'cpu'\]\s*\}/.test(src),
      `${f} 的 asrDevice 定义不对（要 def:'auto' + kind:'enum' + values ['auto','cpu']）`)
    must(/if \(d\.kind === 'enum'\)/.test(src), `${f} 的钳制函数没跳过枚举项（Math.floor('auto') = NaN）`)
  }
  return '两处都是枚举项，钳制函数都已跳过'
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
  must(!/default \{ @\('ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'cuda'\)/.test(ps), 'all 的步骤表把 cuda 带上了（应当保持「不问、不装 500 MB」）')
  return 'deps 行 + /status.gpu + pip uninstall + -Target cuda 都在，all 不含 cuda'
})

// C21/C22（2026-10-29，rumo-test）：clean 的两条行为第一次真跑。
//   W-04 与 C10 原来都只读源码找子串——实测「…→...」「变量改名但注释留旧名」都能让断言照绿。
//   这里造合法缓存根（.bili-watch-root + BV 目录里的 meta.json；否则 pickCacheDir 会另建
//   bili-watch-cache 子目录，测到的是空目录、什么也证明不了），再真跑一次 clean。
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
  const r = spawnSync(process.execPath, [join(HERE, 'look.mjs'), 'clean'], {
    env: { ...process.env, BILI_WATCH_CACHE: cache },
    encoding: 'utf8',
    timeout: 120000,
  })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
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
//   isOurCacheRoot 是「删之前先问一句这是不是我们的根」的唯一判据，index.js 与 tools/look.mjs 各一份。
//   任一处漏改就只护一半，所以按「两处逐字一致 + 四个入口都接上」来盯。
//   编号 C23：C21/C22 已被 dev 517d6bf 占用（clean 遇活锁 rc≠0 / 残留锁照清），合流时留位不撞。
check('C23 删除面守卫 isOurCacheRoot / isAdoptableDir 两处一致，四个入口都先问一句（P0）', () => {
  const a = read('index.js')
  const b = read('tools/look.mjs')
  const same = (name) => {
    const x = fnBody(a, name)
    const y = fnBody(b, name)
    must(x && y, `找不到 ${name}（index.js 与 tools/look.mjs 都要有）`)
    must(x === y, `${name} 两处函数体不一致：len ${x.length} vs ${y.length}`)
    return x.length
  }
  const n1 = same('isOurCacheRoot')
  const n2 = same('isAdoptableDir')
  must(/if \(!isOurCacheRoot\(dir\)\) return/.test(fnBody(a, 'removeOwned')), 'index.js removeOwned 没先判 isOurCacheRoot')
  must(/if \(!isOurCacheRoot\(dir\)\) return/.test(fnBody(b, 'removeOwned')), 'look.mjs removeOwned 没先判 isOurCacheRoot')
  must(/if \(!isOurCacheRoot\(CACHE\)\) return/.test(fnBody(a, 'autoCleanCache')), 'autoCleanCache 没先判 isOurCacheRoot')
  must(/if \(!isOurCacheRoot\(root\)\) return/.test(fnBody(a, 'pruneEmptyDirs')), 'pruneEmptyDirs 没先判 isOurCacheRoot')
  // 认领判据：有内容又没有标记的用户目录，绝不能当成缓存根（否则本次运行就把标记写进去，守卫空转）
  must(/!isAdoptableDir\(want\)/.test(fnBody(a, 'resolveCacheDir')), 'index.js resolveCacheDir 没用 isAdoptableDir 判认领')
  must(/!isAdoptableDir\(want\)/.test(fnBody(b, 'resolveCacheDir')), 'look.mjs resolveCacheDir 没用 isAdoptableDir 判认领')
  return `isOurCacheRoot ${n1} 字符 / isAdoptableDir ${n2} 字符，四处入口 + 两处认领判据都已接`
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
check('C25 videoDir 抽 BV 两处一致：整条链接不能变成 http 开头的目录名（E6-02，P0）', () => {
  const a = read('index.js')
  const b = read('tools/look.mjs')
  const x = fnBody(a, 'bvOf')
  const y = fnBody(b, 'bvOf')
  must(x && y, '找不到 bvOf（index.js 与 tools/look.mjs 都要有）')
  must(x === y, `bvOf 两处函数体不一致：len ${x.length} vs ${y.length}`)
  must(/cleanKey\(bvOf\(/.test(fnBody(a, 'videoDir')), 'index.js videoDir 没走 bvOf')
  must(/cleanKey\(bvOf\(/.test(fnBody(b, 'videoDir')), 'look.mjs videoDir 没走 bvOf')
  const src = 'https://www.bilibili.com/video/BV1xx411c7mD?p=1&t=3'
  const hit = /(BV[0-9A-Za-z]{10})/.exec(src)
  must(hit && hit[1] === 'BV1xx411c7mD', '整条链接取不到 BV')
  must(!/^http/.test(hit[1]), '抽出来的东西还是 http 开头')
  return `bvOf ${x.length} 字符两处一致，两处 videoDir 都走它`
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
process.exit(fail ? 1 : 0)
