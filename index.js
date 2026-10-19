/**
 * dsh-bili-watch —— B 站「看内容」的命令与工具入口。
 *
 * 为什么单独做插件：看视频的动作是固定的（取字幕 / 转写 / 抽帧 OCR），
 * 让人敲 /bili 少花推理 token；同时注册一个 bili_watch 工具，模型自己也能调，
 * 不会因为「只做了命令」而变成没人调度。
 *
 * 两侧执行同一份 lookup：spawn 插件自带的只读工具
 *   <插件目录>\tools\look.mjs
 * 只读、默认匿名：不修改任何业务状态文件，可反复调用。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOOK = join(HERE, 'tools', 'look.mjs')
const COMMANDS = ['search', 'hot', 'peek', 'view', 'sub', 'comments', 'danmaku', 'asr', 'frames', 'sheet', 'substrip', 'ocr', 'text', 'login', 'clean']

const name = 'dsh-bili-watch'
const inject = ['commands', 'tools']

function runLook(args, { timeoutMs = 1_200_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (res) => {
      if (done) return
      done = true
      resolve(res)
    }
    let child
    try {
      child = spawn(process.execPath, [LOOK, ...args], { windowsHide: true })
    } catch (e) {
      finish({ code: -1, out: '', err: `启动失败：${e?.message ?? e}` })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish({ code: -2, out: out.trim(), err: (err + '\n[超时]').trim() })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ code: -1, out: out.trim(), err: String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, out: out.trim(), err: err.trim() })
    })
  })
}

/** 把 "text BV1xx --cred path --step 2" 拆成 { command, bv, extra }。 */
function parseCommandLine(raw) {
  const tokens = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const command = tokens.shift()
  const bv = tokens.length && !tokens[0].startsWith('--') ? tokens.shift() : ''
  const extra = []
  let step = ''
  let cred = ''
  while (tokens.length) {
    const t = tokens.shift()
    if (t === '--step' && tokens.length) {
      step = tokens.shift()
      extra.push('--step', step)
    } else if (t === '--p' && tokens.length) {
      extra.push('--p', tokens.shift())
    } else if (t === '--cred' && tokens.length) {
      cred = tokens.shift()
      extra.push('--cred', cred)
    } else if (t === '--days' && tokens.length) {
      extra.push('--days', tokens.shift())
    } else if (t === '--limit' && tokens.length) {
      extra.push('--limit', tokens.shift())
    } else if (t === '--order' && tokens.length) {
      extra.push('--order', tokens.shift())
    } else if (t === '--grid' && tokens.length) {
      extra.push('--grid', tokens.shift())
    } else if (t === '--out' && tokens.length) {
      extra.push('--out', tokens.shift())
    } else if (t === '--ffmpeg' && tokens.length) {
      extra.push('--ffmpeg', tokens.shift())
    } else if (t === '--fresh' || t === '--ocr' || t === '--poll' || t === '--check' || t === '--fast' || t === '--scene' || t === '--mark-seen') {
      extra.push(t)
    }
    // 其余 token 直接丢弃（命令本身不接受别的参数）
  }
  return { command, bv, extra, step, cred }
}

async function lookup({ command, bv, extra = [] }) {
  if (!command || !COMMANDS.includes(command)) {
    return { ok: false, text: `用法：/bili <${COMMANDS.join('|')}> <BV> [--step 2] [--cred 凭证路径]` }
  }
  if (!['clean', 'login', 'hot'].includes(command) && !bv) {
    return { ok: false, text: `缺少 BV 号，用法：/bili ${command} <BV>` }
  }
  const args =
    command === 'clean'
      ? ['clean']
      : command === 'login'
        ? ['login', ...extra]
        : command === 'hot'
          ? ['hot', ...extra]
          : [command, bv, ...extra]
  const r = await runLook(args)
  const text = (r.out || r.err || '').trim() || '（没有输出）'
  return { ok: r.code === 0, text }
}

function apply(ctx) {
  // ① 斜杠命令：人敲，确定性执行，不花推理 token
  ctx.commands.register({
    definitionId: 'dsh-bili-watch',
    name: 'bili',
    description: '看 B 站视频内容：字幕 → 本地转写 → 抽帧 OCR，输出最可信的一份文本',
    input: {
      hint: '<search 关键词|hot|peek|view|sub|comments|danmaku|asr|frames|sheet|substrip|ocr|text|login|clean> [BV] [--p N] [--step 2] [--days 3] [--order pubdate|click] [--cred 凭证路径] [--fast] [--scene] [--grid 3x3]',
    },
    handler: async (invocation) => {
      const { command, bv, extra } = parseCommandLine(invocation?.rawInput)
      const r = await lookup({ command, bv, extra })
      return { kind: r.ok ? 'success' : 'error', text: r.text }
    },
  })

  // ② 同名工具：模型可调，需要看视频时自己来，不依赖用户敲命令
  //    必须用 defineTool 包一层：ctx.tools.register 收的是编译好的 tool 对象，
  //    直接传 options 会让发往模型的 parameters 变成 null（报 INVALID_REQUEST: schema must be type "object"）。
  ctx.tools.register(defineTool({
    name: 'bili_watch',
    description:
      '用户给出 B 站视频链接 / BV 号，要我看、总结、判断这条视频讲了什么、有没有坑、值不值得看时使用。读取一个 B 站视频的内容材料（只读、匿名）。优先级：字幕 → 本地 ASR 转写 → 抽帧 OCR。command=peek 最便宜：只拿标题/简介/热评 + 均匀 5 帧，用来先判断是口播还是画面，再决定走 text 还是 ocr；command=text 会按优先级自动降级并返回最可信的一份文本（推荐）；view=元数据与热评；comments=评论区；asr=强制本地转写；frames=抽帧（可加 ocr=true 顺带识别画面文字）；ocr=抽帧并识别画面文字；sub=只要字幕；search=按关键词搜视频（配 days 可只留最近 N 天发布的，结果按播放量降序，用来看「这几天有什么值得看」）；hot=综合热门榜（B 站按热度排的前 N 条）；danmaku=弹幕热区（观众在哪一段反应最集中，判断名场面在哪）；sheet=把 N 帧拼成九宫格一张图（看图省 token）；substrip=把底部字幕逐段竖拼成一张图（硬字幕视频最省）。多 P 视频用 p 指定第几个分P（默认 P1）。拿到文本后由你负责理解与总结。',
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: ['search', 'hot', 'peek', 'view', 'sub', 'comments', 'danmaku', 'asr', 'frames', 'sheet', 'substrip', 'ocr', 'text'],
        description: '要看哪一类材料；想要「讲了什么」的原料用 text，想先看有什么可看的用 search/hot。',
      },
      keyword: {
        type: 'string',
        description: 'command=search 时的搜索关键词（如「DeepSeek」「AI 编程」）。',
      },
      days: {
        type: 'number',
        description: 'command=search 时只保留最近 N 天发布的（再按播放量降序）；不传则不限时间。',
      },
      bv: { type: 'string', description: 'BV 号（如 BV1xx411c7mD），或直接贴 B 站分享链接（https://www.bilibili.com/video/BV.../?...），会自动提取 BV 号。search/hot 不需要。' },
      p: {
        type: 'number',
        description: '多 P 视频的分P序号（1 起）；不传默认 P1。',
      },
      step: {
        type: 'number',
        description: '抽帧间隔秒数（frames/ocr/text 用）；不传则按视频时长自适应（长视频更疏，省 CPU）。',
      },
      ocr: {
        type: 'boolean',
        description: 'command=frames 时是否顺带识别画面文字。',
      },
      fast: {
        type: 'boolean',
        description: 'command=text 时跳过本地转写，字幕拿不到就直接抽帧 OCR（画面类视频更快）。',
      },
      scene: {
        type: 'boolean',
        description: 'command=frames 时按画面变化点抽帧（吸附到变化最多的时刻，比等间隔更准，默认关）。',
      },
      grid: {
        type: 'string',
        description: 'command=sheet 时的格子，如 3x3 或 4x4（默认 3x3）。',
      },
      limit: {
        type: 'number',
        description: 'command=search 时最多返回几条（默认 10）、command=hot 时取前 N 条（默认 10）。',
      },
      cred: {
        type: 'string',
        description: '可选的 B 站凭证 JSON 路径（只在 command=sub/text 时需要；不传就匿名，匿名拿不到 AI 字幕轨）。',
      },
    },
    output: {
      // 注意：DSH 的 output.schema 是「author-facing spec」，编译时 allowRequired=false，
      // 写 required（无论属性级还是顶层数组）会抛 JsonSchemaError: unsupported JSON schema。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '执行是否成功' },
          text: { type: 'string', description: '输出文本' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '').slice(0, 24000) }],
    },
    execute: async (args) => {
      const extra = []
      if (typeof args.p === 'number' && Number.isInteger(args.p) && args.p > 0) extra.push('--p', String(args.p))
      if (typeof args.step === 'number' && Number.isFinite(args.step) && args.step > 0) extra.push('--step', String(args.step))
      if (args.ocr) extra.push('--ocr')
      if (args.fast) extra.push('--fast')
      if (args.scene) extra.push('--scene')
      if (typeof args.grid === 'string' && args.grid.trim()) extra.push('--grid', args.grid.trim())
      if (typeof args.days === 'number' && args.days > 0) extra.push('--days', String(Math.floor(args.days)))
      if (args.command === 'hot') {
        if (typeof args.limit === 'number' && args.limit > 0) extra.push('--limit', String(Math.floor(args.limit)))
        const r = await lookup({ command: 'hot', bv: '', extra })
        return { ok: r.ok, text: r.text }
      }
      if (typeof args.limit === 'number' && args.limit > 0) extra.push('--limit', String(Math.floor(args.limit)))
      if (typeof args.cred === 'string' && args.cred.trim()) extra.push('--cred', args.cred.trim())
      const target = args.command === 'search' ? String(args.keyword ?? '').trim() : String(args.bv ?? '').trim()
      if (args.command === 'search' && !target) return { ok: false, text: 'search 需要 keyword 参数（要搜什么词）' }
      if (!target) return { ok: false, text: '缺少 BV 号或分享链接' }
      const r = await lookup({ command: args.command, bv: target, extra })
      return { ok: r.ok, text: r.text }
    },
  }))
}

export { apply, inject, name }
