// C237 会话坐标现抽器。判据与基线生成器共用同一份口径，不许各抄一遍 listTargets。
//
// 口径与 scripts/check-release-leak.mjs::listTargets 逐条对齐：
//   package.json / README.md / LICENSE 三个默认项（先判存在）+ package.json.files
//   展开（目录只取一层文件）；前 8192 字节含 NUL 视为二进制跳过；读不出来单独点名。
//
// RESIDUE_KINDS 是「缺陷定义」（1255 段列的五类形态），不是守卫实现。守卫实现只有
// scripts/_rules.mjs::COLLAB_RULES 一份，两个文本闸共用。两份不必逐字相同，但判据
// 会真跑要求「本表抽到的每一行，两道闸都必须点名」——规则覆盖不全就会红，
// 这是同源性的运行时证明，比抄一份正则更能挡住「改了守卫没改判据」。
import fs from 'node:fs'
import path from 'node:path'

// 裸扫不带 \b：中文紧贴时 \b 在三种正则引擎下结论不一致（见审查标准 §三）。
export const RESIDUE_KINDS = Object.freeze([
  ['批次名', /0\.\d+(?:\.\d+)?\s*[A-Za-z]\s*桶/],
  ['段号', /\d{4}\s*段/],
  ['本版', /本版/],
  ['报告里', /报告里/],
  ['写进报告', /写[进到入]报告|交付报告/],
])

// 同族新变体：形取自基线行，逐字不同。1255 段说「新变体我会给」但后续段没给，
// 本批自造，写进 C237 报告。每条都必须能被 RESIDUE_KINDS 认出（确属同族）。
export const NOVEL = Object.freeze([
  '// 0.5.0 A 桶第三批：面板原来只显示命令与时间',
  '// 2410 段 §三：低分辨率抽帧仍走同一条路径',
  '// 本版收口范围：只做配置项',
  '// 报告里补充说明，不默默不做',
  '// 写进交付报告（插词形态）',
  '// 0.4.10 C 桶第 2 批：默认值提示',
])

export function listPackageTexts(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const out = new Set()
  for (const d of ['package.json', 'README.md', 'LICENSE']) {
    if (fs.existsSync(path.join(root, d))) out.add(d)
  }
  for (const entry of pkg.files || []) {
    const p = path.join(root, entry)
    if (!fs.existsSync(p)) continue
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        const rel = `${entry.replace(/\/$/, '')}/${f}`
        if (fs.statSync(path.join(root, rel)).isFile()) out.add(rel)
      }
    } else out.add(entry)
  }
  const texts = []
  const skipped = []
  for (const rel of [...out].sort()) {
    let buf
    try { buf = fs.readFileSync(path.join(root, rel)) } catch { skipped.push(rel); continue }
    if (buf.subarray(0, 8192).includes(0)) continue
    texts.push({ rel, text: buf.toString('utf8') })
  }
  return { texts, skipped, all: [...out].sort() }
}

/** @returns {{rows: Array<{file:string,line:number,kinds:string[],text:string}>, textCount:number, skipped:string[]}} */
export function collectRows(root) {
  const { texts, skipped } = listPackageTexts(root)
  const rows = []
  for (const { rel, text } of texts) {
    text.split('\n').forEach((line, i) => {
      const kinds = RESIDUE_KINDS
        .filter(([, re]) => { re.lastIndex = 0; return re.test(line) })
        .map(([n]) => n)
      if (kinds.length) rows.push({ file: rel, line: i + 1, kinds, text: line.trim() })
    })
  }
  return { rows, textCount: texts.length, skipped }
}

/** 变体必须同族、且不是基线原行；否则「新变体」会退化成重写旧样本。 */
export function novelCheck(rows) {
  const baselineTexts = new Set(rows.map((r) => r.text))
  return NOVEL.map((text) => ({
    text,
    sameFamily: RESIDUE_KINDS.some(([, re]) => { re.lastIndex = 0; return re.test(text) }),
    notInBaseline: !baselineTexts.has(text),
  }))
}
