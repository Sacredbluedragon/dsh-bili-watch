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
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const results = []
const check = (name, fn) => {
  const before = results.length
  try {
    const detail = fn()
    // 2026-10-30（WB-CN）：断言内部调了 skip() 再 return 时，这里不能再补一条 PASS——
    //   skip() 已经自己 push 过一笔，补进去就成了「同一条断言 SKIP + PASS 各一行」，
    //   通过数虚高 1（发布树的 C11 一直是这样：53 通过/3 跳过，真实是 52/3）。
    //   判据用「这一趟有没有新结果」，不猜名字——skip() 传的是短名，与 check 的全名对不上。
    if (results.length === before) results.push({ name, ok: true, detail: detail ?? '' })
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

check('C6 hasAnyLock 判活判过期，且 4 个锁函数两处一致（剥注释后比；P1：残留 .lock 会让 clean 永久拒绝）', () => {
  const a = read('index.js')
  const b = read('tools/look.mjs')
  const h = (s) => createHash('md5').update(s).digest('hex').slice(0, 12)
  // 回归复核（2026-10-28）：原来只比 hasAnyLock 自己。但它的判据不是自己写死的，
  //   而是 pidAlive / readLock / lockExpired 三个辅助函数 + LOCK_TTL_MS —— 只比 hasAnyLock 会漏：
  //   有人只改 index.js 的 lockExpired，这条照样绿，面板与 CLI 就悄悄分叉了。
  // #20（2026-10-30）：比之前先剥注释——改一行注释不算分叉，改一个字符算。
  const names = ['pidAlive', 'readLock', 'lockExpired', 'hasAnyLock']
  for (const n of names) {
    const fa = stripComments(fnBody(a, n))
    const fb = stripComments(fnBody(b, n))
    must(fa === fb, `${n} 在两处不一致（剥注释后 index=${h(fa)} look=${h(fb)}）`)
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

check('C7 cleanKey 两处一致并剥尾部点号（剥注释后比；P2：Windows 会吃掉目录名尾部的点）', () => {
  const a = stripComments(fnBody(read('index.js'), 'cleanKey'))
  const b = stripComments(fnBody(read('tools/look.mjs'), 'cleanKey'))
  must(/\[\\s\.\]\+\$/.test(a), 'index.js 的 cleanKey 没剥尾部点/空格')
  const h = (s) => createHash('md5').update(s).digest('hex').slice(0, 12)
  must(h(a) === h(b), `两处函数体不一致（剥注释后）：index=${h(a)} look=${h(b)}`)
  return `md5 ${h(a)}`
})

check('C8 pickCacheDir 两层都做可写探测，且两处返回同一形状（#18，P1：形状不同会让 CACHE 变成 [object Object]）', () => {
  const idx = read('index.js')
  const look = read('tools/look.mjs')
  const a = fnBody(idx, 'pickCacheDir')
  const b = fnBody(look, 'pickCacheDir')
  must(a.includes('.write-test-'), 'index.js 没有写探针')
  must(b.includes('.write-test-'), 'look.mjs 没有写探针')
  // #18（2026-10-30）：原来这条只查「有没有写探针」。可 pickCacheDir 在 index.js 返回
  //   { dir, fallback }、在 tools/look.mjs 返回字符串——改一侧另一侧就拿到 [object Object]，
  //   而断言照样绿。现在真跑两个分支，两边都必须返回同一个形状。
  const dir = mkdtempSync(join(tmpdir(), 'bw-c8-'))
  try {
    // 「父级是文件」的路径逼出 catch 分支：mkdir 必失败，与平台无关，也不用改权限
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const bad = join(blocker, 'cache')
    const good = join(dir, 'cache-ok')
    const mkIdx = (want) =>
      compile(idx, ['pickCacheDir'], {
        prelude: `const CACHE_MARK = '.bili-watch-root'\nfunction resolveCacheDir() { return ${JSON.stringify(want)} }`,
        params: ['join', 'process', 'homedir', 'mkdirSync', 'existsSync', 'writeFileSync', 'rmSync'],
        args: [join, { env: { DSH_HOME: join(dir, 'home') }, pid: 1 }, () => dir, mkdirSync, existsSync, writeFileSync, rmSync],
      }).pickCacheDir
    const mkLook = (want) =>
      compile(look, ['pickCacheDir'], {
        prelude: `const DSH_HOME = ${JSON.stringify(join(dir, 'home'))}\nconst CACHE_MARK = '.bili-watch-root'\nfunction resolveCacheDir() { return ${JSON.stringify(want)} }`,
        params: ['join', 'mkdirSync', 'existsSync', 'writeFileSync', 'rmSync', 'console', 'process'],
        args: [join, mkdirSync, existsSync, writeFileSync, rmSync, { error() {} }, { pid: 1 }],
      }).pickCacheDir
    for (const [label, mk] of [['index.js', mkIdx], ['tools/look.mjs', mkLook]]) {
      const ok = mk(good)()
      must(ok && typeof ok === 'object' && typeof ok.dir === 'string', `${label} 正常路径没返回 { dir }（拿到 ${JSON.stringify(ok)}）`)
      must(ok.fallback === null, `${label} 正常路径的 fallback 应为 null，实际 ${JSON.stringify(ok.fallback)}`)
      must(ok.dir === good, `${label} 正常路径返回的 dir 不对：${ok.dir}`)
      const fb = mk(bad)()
      must(fb && typeof fb === 'object' && typeof fb.dir === 'string', `${label} 回退分支没返回 { dir }（拿到 ${JSON.stringify(fb)}）`)
      must(fb.dir !== bad && Boolean(fb.fallback), `${label} 回退分支应换到默认根并给出 fallback 原因，实际 ${JSON.stringify(fb)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return '两层都写探针；正常/回退两个分支都返回 { dir, fallback }'
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
  const body = (src, name) => {
    const i = src.indexOf(`function ${name}(`)
    must(i >= 0, `找不到 ${name}`)
    return src.slice(i, src.indexOf('\n}', i) + 2)
  }
  const r1 = body(idx, 'resolveCredPath')
  const r2 = body(look, 'credFor')
  for (const [n, b] of [['resolveCredPath', r1], ['credFor', r2]]) {
    must(/SHARED_CRED/.test(b), `${n} 没有用 SHARED_CRED`)
    must(!/PANEL_/.test(b), `${n} 还在引用同机其它工具的凭证`)
  }
  // 删掉仲裁之后，「谁新用谁」的 mtime 比较不该再出现
  must(!/mtimeOf\(/.test(r2), 'credFor 里还留着 mtime 仲裁')
  must(/LEGACY_CRED/.test(r1) && /LEGACY_CRED/.test(r2), '两处都应保留 deps 旧路径的一次性迁移')

  // 真跑（不是查字符串）：造四种现场看 resolveCredPath 到底返回哪条、有没有把坏凭证搬过去。
  //   只查源码里有没有 SHARED_CRED 是纸老虎——把 if 改成恒假照样绿。
  const dir = mkdtempSync(join(tmpdir(), 'bw-c16-'))
  try {
    const shared = join(dir, 'bili-watch', 'credential.json')
    const legacy = join(dir, 'deps', 'credential.json')
    const { resolveCredPath } = compile(idx, ['resolveCredPath'], {
      prelude: `const SHARED_CRED = ${JSON.stringify(shared)}\nconst LEGACY_CRED = ${JSON.stringify(legacy)}`,
      params: ['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'dirname'],
      args: [existsSync, readFileSync, writeFileSync, mkdirSync, dirname],
    })
    // ① 两处都没有：只返回 SHARED 路径，不凭空造文件
    must(resolveCredPath() === shared, '① 两处都没有时应返回 SHARED 路径')
    must(!existsSync(shared), '① 只是算路径就创建了文件')
    // ② 旧位置凭证齐全：迁到 SHARED 并返回 SHARED，字段不能丢
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ sessdata: 's', bili_jct: 'j', buvid3: '3', buvid4: '4' }))
    must(resolveCredPath() === shared, '② 旧凭证齐全时没迁到 SHARED')
    must(existsSync(shared), '② 旧凭证齐全时没真的写 SHARED')
    const mig = JSON.parse(readFileSync(shared, 'utf8'))
    must(mig.sessdata === 's' && mig.buvid4 === '4', '② 迁移把字段弄丢了')
    // ③ 旧位置凭证残缺：继续用 LEGACY，不迁（半个凭证搬过去等于把登录态弄坏）
    rmSync(shared, { force: true })
    writeFileSync(legacy, JSON.stringify({ sessdata: 's' }))
    must(resolveCredPath() === legacy, '③ 旧凭证缺字段时应继续用 LEGACY，不迁')
    must(!existsSync(shared), '③ 旧凭证缺字段却还是写了 SHARED')
    // ④ SHARED 在就永远优先，哪怕 LEGACY 更新——这正是 B 方案要拿掉的「谁新用谁」
    writeFileSync(shared, JSON.stringify({ sessdata: 'new' }))
    writeFileSync(legacy, JSON.stringify({ sessdata: 'old', bili_jct: 'j', buvid3: '3', buvid4: '4' }))
    must(resolveCredPath() === shared, '④ SHARED 存在时不该回读 LEGACY（谁新用谁已拿掉）')
    must(JSON.parse(readFileSync(shared, 'utf8')).sessdata === 'new', '④ SHARED 被旧凭证覆盖了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return '两处都只认 SHARED（+ LEGACY 一次性迁移）；真跑四种现场都对，仲裁与跟随已删'
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

// #1（2026-10-30 E8 总表）：删除面有两个入口——用户点清理走 removeOwned，自动清理走 autoCleanCache → walkEntries
//   → isOwnedEntry。removeOwned 早就改成「名字 + meta.json」，isOwnedEntry 却还按 /^BV…/ 名字直接认领，
//   于是用户在缓存根放一个自己的 BV1234567890/ 会被自动清理连文件一起删。这条钉两件事：
//   ① 两处 isOwnedEntry 逐字一致且都问 isOwnBvDir；② 真造目录树，用户的 BV 目录必须不被认领。
check('C26 自动清理与手点清理同一认领判据：BV 目录必须有 meta.json 或为空（#1，P0：别按名字删）', () => {
  const a = read('index.js')
  const b = read('tools/look.mjs')
  const ea = fnBody(a, 'isOwnedEntry')
  const eb = fnBody(b, 'isOwnedEntry')
  must(ea === eb, 'isOwnedEntry 两处函数体不一致：len ' + ea.length + ' vs ' + eb.length)
  must(/return isOwnBvDir\(/.test(ea), 'isOwnedEntry 没走 isOwnBvDir（还在按名字认领）')
  must(!/\^BV\[0-9A-Za-z\]\{10\}\/i\.test\(first\)\)\s*return true/.test(ea), 'isOwnedEntry 里仍有「按名字直接 return true」')
  // 真跑（不只看字符串）
  const dir = mkdtempSync(join(tmpdir(), 'bw-c26-'))
  try {
    writeFileSync(join(dir, '.bili-watch-root'), '{}')
    mkdirSync(join(dir, 'BV1aaaaaaaaa'))
    writeFileSync(join(dir, 'BV1aaaaaaaaa', 'meta.json'), '{}')
    mkdirSync(join(dir, 'BV9999999999'))
    writeFileSync(join(dir, 'BV9999999999', 'mine.mp4'), 'x')
    mkdirSync(join(dir, 'BV1234567890extra'))
    writeFileSync(join(dir, 'BV1234567890extra', 'mine.mp4'), 'x')
    const { isOwnedEntry } = compile(a, ['isOwnBvDir', 'isOwnedEntry'], {
      prelude: 'const CACHE = ' + JSON.stringify(dir) + "\nconst OWN_CACHE_DIRS = new Set(['_logs','frames','sheets','sheet-tmp','substrip-tmp','_misc','asr','frames-dl','audio-dl','_hot'])",
      params: ['relative', 'join', 'existsSync', 'readdirSync'],
      args: [relative, join, existsSync, readdirSync],
    })
    must(isOwnedEntry(join(dir, 'BV1aaaaaaaaa')) === true, '有 meta.json 的 BV 目录没被认领（会漏删自己的）')
    must(isOwnedEntry(join(dir, 'BV9999999999')) === false, '用户自己的 BV 目录被认领了（自动清理会删里面的文件）')
    must(isOwnedEntry(join(dir, 'BV1234567890extra')) === false, 'BV 前缀陷阱被认领了（正则缺右边界）')
    return '两处一致且都问 isOwnBvDir；用户 BV 目录与前缀陷阱都不认领'
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
check('C34 符号链接口径统一：dirStat 两处、walkEntries 都按 lstat 计（E6-07，P1：已清理 MB 会虚高）', () => {
  const ents = [
    { name: 'a.txt', isDirectory: () => false, isFile: () => true },
    { name: 'link', isDirectory: () => false, isFile: () => false }, // 符号链接：两个 is* 都 false
  ]
  const readdirSync = () => ents
  // 文件 100 B、链接自身 7 B；stat 会跟到目标（9999 B）——用它就说明口径错了
  const lstatSync = (p) => ({ size: String(p).endsWith('link') ? 7 : 100, mtimeMs: 1 })
  const statSync = () => { throw new Error('用了 statSync（会跟到链接目标）') }
  for (const [label, src] of [['index.js', read('index.js')], ['tools/look.mjs', read('tools/look.mjs')]]) {
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
  return '两处 dirStat 都按 lstat 计链接；walkEntries 也用 lstat'
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
  const src = read('index.js')
  const dir = mkdtempSync(join(tmpdir(), 'bw-c38-'))
  try {
    const p = join(dir, 'deps-config.json')
    writeFileSync(p, '{ 坏掉的 json', 'utf8')
    const { readDepsCfgFile } = compile(src, ['readDepsCfgFile'], {
      prelude: 'let cfgWarning = null',
      params: ['readFileSync', 'renameSync', 'basename'],
      args: [readFileSync, renameSync, basename],
    })
    const j = readDepsCfgFile(p)
    must(j && typeof j === 'object' && !Array.isArray(j), '坏文件应退回默认对象，实际 ' + JSON.stringify(j))
    must(!existsSync(p), '坏文件还在原地——下次写回会把它覆盖掉')
    const baks = readdirSync(dir).filter((n) => n.includes('.broken-'))
    must(baks.length === 1, `没留下备份（目录里：${readdirSync(dir).join(', ') || '空'}）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // 三个读入口只剩一种行为：index.js 的 depsCfg 复用 readDepsCfgFile
  must(/function depsCfg\(\)[\s\S]{0,160}readDepsCfgFile/.test(src), 'index.js 的 depsCfg 没有复用 readDepsCfgFile——坏文件还是只打一句 warning')
  const look = read('tools/look.mjs')
  const i = look.indexOf('function readDepsCfg()')
  must(i > 0, '找不到 tools/look.mjs 的 readDepsCfg')
  must(/renameSync/.test(look.slice(i, i + 900)), 'tools/look.mjs 的 readDepsCfg 坏了不留档')
  return '坏文件改名留档 + 回默认值；index.js 与 tools/look.mjs 同口径'
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
    prelude: `const CACHE = 'X:/fake-cache'\nlet cacheStatAt = 0\nlet cacheStatVal = null`,
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
  must(!/cache:\s*\{\s*\.\.\.dirStat\(CACHE\)/.test(src), '/status 的 cache 那块还在直接 dirStat(CACHE)')
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
