#!/usr/bin/env node
/**
 * tools/fixtures/deps-delete-probe.mjs —— 删除面归属判据真跑探针
 *
 * 为什么单独一个文件：`removeOwned` 要在临时目录里造一整棵「伪缓存根」（标记文件 + 用户素材 +
 *   我们自己的产物），造完还要真删、真读回。这活儿直接写进 verify.mjs 会和 C77 那条「check()
 *   回调必须同步」打架（清理是同步的，但读回 + 断言组合起来太长，且要独占一个临时目录）。
 *   这里只输出 JSON，父进程 spawnSync 读。
 *
 * 缺陷现场（E02 P0，合并自 E02-01 + E02-02）：
 *   用户把缓存根指到一个自己的素材库，在 `frames/` 里放了一张 `1.jpg`，
 *   点「清除」→ 整棵 `frames/` 被删，`skipped` 还是空数组，用户不知道发生了什么。
 *   根因：`lib/cache-own.mjs` 的 `isOurChild()` **拿扩展名当归属证据**，
 *   `OUR_ENTRY_EXT` 含 `.jpg/.png/.mp4`，用户的 `1.jpg` 过判 → `whitelistDirIsOurs()`
 *   的 `list.every(isOurChild)` 全真 → `removeOwned` 整目录 `rmSync`。
 *
 * 两组断言，分两类（这一点必须写清，否则夹具本身就会变成纸老虎）：
 *   「defect」＝当前代码的缺陷：修好之前跑一次就该红，修好之后转绿。
 *     由 verify.mjs 的 C162 守住（它断言 defect 里每一条都不是 false）。
 *   「capability」＝修的时候最容易顺手弄坏的反向能力：
 *     混合目录还得整棵不动并说出原因、我们自己的产物还得清得掉。
 *     修法偏保守（一律不删）能让 defect 全绿，但会把 capability 弄红，
 *     所以两组必须同时成立才算修对。
 *
 * 2026-11-05 扩（`20261105-1457-DSH` 裁定）：
 *   · B 组补 `manifest.json` 的 `files` 记账，用于验证「书面记账」这条凭证；
 *     原 `0001.jpg` 不是任何真实产物（真实是 `<BV>-NN.jpg` / `f_*m*s.jpg` / `peek-NN.jpg`），
 *     补零帧序号那条弱凭证整条删掉，不许留在判据里。
 *   · 新增 F（顶层 BV 目录混用户文件，defect）、G（顶层 BV 目录纯产物，capability）。
 *   · 新增「逐目录覆盖」：`OWN_CACHE_DIRS` 十个成员每个都有一组。
 *     给得出凭证的五个 → provableDir（纯产物能清 / 混用户文件能活）；
 *     给不出凭证的五个 → unprovableDir（本轮不认领，用户文件必须活）。
 *     理由见交付的《逐目录凭证表》，**不为填表编规则**。
 *   · 新增 J 组（`20261105-1702-DSH` / `1658` P2-3）：J1 用户 `.obsidian.lock` /
 *     `notes.lock` 必须活、J2 我们自己的 `.lock` / `.meta-*.lock` / `.BV*-pN.lock` /
 *     `.write-test-*` 必须清得掉、J3 剥后缀后底名是空串 / 纯点的怪名字一律不认领。
 *     只测 J1 会让「一律不删」也全绿，J2 就是钉这条的反向能力。
 *
 * 用法：node tools/fixtures/deps-delete-probe.mjs     → stdout 输出一个 JSON
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { removeOwned } from '../../lib/cache-own.mjs'
import { CACHE_MARK } from '../../lib/consts.mjs'

const out = { defect: {}, capability: {}, notes: {} }
const tmp = mkdtempSync(join(tmpdir(), 'bw-del-'))
const BV = 'BV1xx411c7mD'

/** 造一棵「伪缓存根」：标记文件必须有，否则 removeOwned 第一道闸就全拒，测不到归属判据。 */
function makeRoot(name) {
  const root = join(tmp, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, CACHE_MARK), '{}', 'utf8')
  return root
}

/** 按相对路径写一个文件（自动建父目录）。 */
function put(root, rel, data = 'x') {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, data, 'utf8')
  return p
}

/**
 * 给得出凭证的目录：造两棵根。
 *   ① 只有我们的产物 → capability：整个目录必须被清掉（防「一律不删」的假绿）
 *   ② 我们的产物 + 用户 `1.jpg` → defect：用户文件必须活（防「按扩展名猜」）
 */
function provableDir(key, dirName, ours) {
  {
    const root = makeRoot(`root-${key}-ours`)
    const d = join(root, dirName)
    mkdirSync(d, { recursive: true })
    ours(root, d)
    const r = removeOwned(root)
    out.capability[`${key}_oursGone`] = !existsSync(d)
    out.notes[`${key}_ours`] = { files: r.files, skipped: r.skipped }
  }
  {
    const root = makeRoot(`root-${key}-mixed`)
    const d = join(root, dirName)
    mkdirSync(d, { recursive: true })
    ours(root, d)
    put(root, `${dirName}/1.jpg`, 'user-photo-in-mixed-dir')
    const r = removeOwned(root)
    out.defect[`${key}_userSurvived`] = existsSync(join(d, '1.jpg'))
    out.notes[`${key}_mixed`] = { files: r.files, skipped: r.skipped }
  }
}

/**
 * 给不出凭证的目录（本轮不认领）：造一棵根，放我们的产物 + 用户 `1.jpg`。
 *   defect：用户文件必须活（修好前按扩展名会被删，用来证明「从红变绿」）
 *   capability：整个目录必须还在（证明「不认领」不是「认领了但删失败」）
 */
function unprovableDir(key, dirName, ours) {
  const root = makeRoot(`root-${key}-unproven`)
  const d = join(root, dirName)
  mkdirSync(d, { recursive: true })
  ours(root, d)
  put(root, `${dirName}/1.jpg`, 'user-photo-in-unproven-dir')
  const r = removeOwned(root)
  out.defect[`${key}_userSurvived`] = existsSync(join(d, '1.jpg'))
  out.capability[`${key}_notClaimed`] = existsSync(d)
  out.notes[`${key}_unproven`] = { files: r.files, skipped: r.skipped }
}

try {
  // ── A（defect）：白名单目录里只有用户自己的图 ───────────────────────────────
  {
    const root = makeRoot('rootA')
    const frames = join(root, 'frames')
    mkdirSync(frames, { recursive: true })
    writeFileSync(join(frames, '1.jpg'), 'user-photo-bytes', 'utf8')
    const r = removeOwned(root)
    out.defect.A_userJpgSurvived = existsSync(join(frames, '1.jpg'))
    out.defect.A_skippedNamesFrames = (r.skipped || []).some((s) => String(s?.name || '').includes('frames'))
    out.notes.A = { skipped: r.skipped, files: r.files, bytes: r.bytes }
  }

  // ── B（capability）：纯我们自己的目录还得清得掉 ─────────────────────────────
  //   2026-11-05：`0001.jpg` / `0002.jpg` 刻意不改成真实命名，让它们**只能靠
  //   manifest.files 的书面记账**过判。补零帧序号那条弱凭证已从判据里删干净
  //   （DSH 1457 裁定），若它还在，这组就会变成「靠形状猜」而不是「靠记账」。
  {
    const root = makeRoot('rootB')
    const bv = join(root, 'frames', `${BV}-p1-2s`)
    mkdirSync(bv, { recursive: true })
    writeFileSync(join(bv, 'meta.json'), JSON.stringify({ bv: BV }), 'utf8')
    writeFileSync(join(bv, 'manifest.json'), JSON.stringify({ ok: true, files: ['0001.jpg', '0002.jpg'] }), 'utf8')
    writeFileSync(join(bv, '0001.jpg'), 'frame', 'utf8')
    writeFileSync(join(bv, '0002.jpg'), 'frame', 'utf8')
    const r = removeOwned(root)
    out.capability.B_ourBvDirGone = !existsSync(bv)
    out.capability.B_countedFiles = r.files >= 4
    out.notes.B = { skipped: r.skipped, files: r.files, bytes: r.bytes }
  }

  // ── C（defect）：BV 目录里混了用户文件，不能被整棵删 ───────────────────────
  {
    const root = makeRoot('rootC')
    const bv = join(root, 'frames', `${BV}-p1-2s`)
    mkdirSync(bv, { recursive: true })
    writeFileSync(join(bv, 'meta.json'), JSON.stringify({ bv: BV }), 'utf8')
    writeFileSync(join(bv, '1.jpg'), 'user-photo-in-our-dir', 'utf8')
    const r = removeOwned(root)
    out.defect.C_userFileInBvDirSurvived = existsSync(join(bv, '1.jpg'))
    out.notes.C = { skipped: r.skipped, files: r.files }
  }

  // ── D（capability）：白名单目录里混了非白名单文件 → 整棵不动且点名原因 ──────
  {
    const root = makeRoot('rootD')
    const frames = join(root, 'frames')
    mkdirSync(frames, { recursive: true })
    writeFileSync(join(frames, '1.psd'), 'user-psd', 'utf8')
    writeFileSync(join(frames, 'manifest.json'), '{}', 'utf8')
    const r = removeOwned(root)
    out.capability.D_dirUntouched = existsSync(join(frames, '1.psd'))
    // 1810 §四 把这句文案改成「暂不自动清理（内部文件名无法区分归属，需手动处理）」：
    //   旧正则只认那句误导措辞，会把本插件产物说成用户误放的东西。
    //   这里同步收窄成「点名 frames + 说清原因」两条件，不放宽成「只要有 why 就算」。
    out.capability.D_skippedExplains = (r.skipped || []).some(
      (s) => String(s?.name || '') === 'frames'
        && /暂不自动清理/.test(String(s?.why || ''))
        && /无法区分归属|需手动处理/.test(String(s?.why || '')),
    )
    out.notes.D = { skipped: r.skipped }
  }

  // ── E（capability）：不是我们的缓存根 → 一个文件都不动 ──────────────────────
  {
    const root = join(tmp, 'rootE')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '1.jpg'), 'no-mark-here', 'utf8')
    const r = removeOwned(root)
    out.capability.E_untouchedNoMark = existsSync(join(root, '1.jpg'))
    out.capability.E_skippedRoot = (r.skipped || []).length >= 1
    out.notes.E = { skipped: r.skipped }
  }

  // ── F（defect，1457 新增）：缓存根**顶层** BV 目录里混用户文件 ──────────────
  //   `isOwnBvDir` 原来「名字像 BV + 有 meta.json」就整棵删，A–E 全在 frames/ 里，覆盖不到。
  {
    const root = makeRoot('rootF')
    const bvDir = join(root, BV)
    mkdirSync(bvDir, { recursive: true })
    writeFileSync(join(bvDir, 'meta.json'), JSON.stringify({ bv: BV, files: [] }), 'utf8')
    writeFileSync(join(bvDir, '1.jpg'), 'user-photo-top-level', 'utf8')
    const r = removeOwned(root)
    out.defect.F_topLevelBvUserFileSurvived = existsSync(join(bvDir, '1.jpg'))
    out.defect.F_skippedNamesBvDir = (r.skipped || []).some((s) => String(s?.name || '').includes(BV))
    out.notes.F = { skipped: r.skipped, files: r.files }
  }

  // ── G（capability，1457 新增）：顶层 BV 目录纯产物照旧清得掉 ────────────────
  //   只有 `<BV>-01.jpg` + meta.json、**没有 manifest.json** —— 覆盖
  //   「writeManifest 写失败不抛」的真实缓存，证明没把功能收紧成一律不删。
  {
    const root = makeRoot('rootG')
    const bvDir = join(root, BV)
    mkdirSync(bvDir, { recursive: true })
    writeFileSync(join(bvDir, 'meta.json'), JSON.stringify({ bv: BV }), 'utf8')
    writeFileSync(join(bvDir, `${BV}-01.jpg`), 'frame', 'utf8')
    const r = removeOwned(root)
    out.capability.G_topLevelBvOursGone = !existsSync(bvDir)
    out.capability.G_countedFiles = r.files >= 2
    out.notes.G = { skipped: r.skipped, files: r.files }
  }

  // ── H（defect，1526 新增）：白名单目录里的点开头用户文件 ──────────────────
  //   DSH 的实测样本：`frames/` 里 `<BV>-01.jpg` + `.gitignore` + `.obsidian/app.json`
  //   → 旧 `startsWith('.')` 把后两个也判成我们的，整目录删掉、skipped 是空数组。
  {
    const root = makeRoot('rootH')
    const frames = join(root, 'frames')
    mkdirSync(frames, { recursive: true })
    put(root, `frames/${BV}-01.jpg`, 'our-frame')
    put(root, 'frames/.gitignore', 'user-gitignore')
    put(root, 'frames/.obsidian/app.json', '{"user":true}')
    const r = removeOwned(root)
    out.defect.H_dotUserFilesSurvived = existsSync(join(frames, '.gitignore'))
      && existsSync(join(frames, '.obsidian', 'app.json'))
    out.defect.H_skippedNamesFrames = (r.skipped || []).some(
      (s) => String(s?.name || '').includes('frames'),
    )
    out.notes.H = { skipped: r.skipped, files: r.files }
  }

  // ── I（capability，1526 新增）：我们自己的点开头产物照旧清得掉 ─────────────
  //   防「把点开头一律不认领」的假绿：锁文件留在缓存根会变成永久堵点
  //   （`lib/locks.mjs:8` 记着 2026-10-28 那次事故）。第四个 `<BV>-01.jpg.part`
  //   顺带验「剥 .part 后底层名字仍要过凭证」这条规则。
  {
    const root = makeRoot('rootI')
    const frames = join(root, 'frames')
    mkdirSync(frames, { recursive: true })
    put(root, `frames/${BV}-01.jpg`, 'our-frame')
    put(root, 'frames/.lock', '{}')
    put(root, 'frames/.write-test-123', '')
    put(root, `frames/${BV}-01.jpg.part`, 'partial')
    const r = removeOwned(root)
    out.capability.I_dotOursCleared = !existsSync(frames)
    out.capability.I_countedFiles = r.files >= 4
    out.notes.I = { skipped: r.skipped, files: r.files }
  }

  // ── J（1702 §四 / 1658 §三）：`.lock` 收窄后的缺陷态、反向能力、剥后缀边界 ──
  //   第 3 轮报的真回归：`isProvenDotName` 认任意 endsWith('.lock')，用户缓存根顶层
  //   的 `.obsidian.lock` 会被静默删掉且不进 skipped。收窄后必须既保住它（J1/J3），
  //   又不能把功能收成「一律不删」（J2）——只测前者的夹具全绿也能是纸老虎。
  {
    const root = makeRoot('rootJ1')
    put(root, '.obsidian.lock', 'user-obsidian-lock')
    put(root, 'frames/.obsidian.lock', 'user-obsidian-lock-in-frames')
    put(root, 'frames/notes.lock', 'user-notes-lock')
    put(root, 'frames/.lock', '{}')
    put(root, `frames/${BV}-01.jpg`, 'our-frame')
    const r = removeOwned(root)
    out.defect.J_topLevelDotUserSurvived = existsSync(join(root, '.obsidian.lock'))
    out.defect.J_dotUserInFramesSurvived = existsSync(join(root, 'frames', '.obsidian.lock'))
    out.defect.J_notesLockSurvived = existsSync(join(root, 'frames', 'notes.lock'))
    out.defect.J_skippedNamesTopLevelDot = (r.skipped || []).some(
      (s) => String(s?.name || '') === '.obsidian.lock',
    )
    out.defect.J_skippedNamesFrames = (r.skipped || []).some(
      (s) => String(s?.name || '').includes('frames'),
    )
    out.notes.J1 = { skipped: r.skipped, files: r.files }
  }

  {
    const root = makeRoot('rootJ2')
    const frames = join(root, 'frames')
    put(root, '.lock', '{}')
    put(root, '.meta-xxx.lock', '{}')
    put(root, '.write-test-123.lock', '')
    put(root, '.write-test-123', '')
    put(root, 'frames/.lock', '{}')
    put(root, 'frames/.meta-xxx.lock', '{}')
    put(root, `frames/.${BV}-p1.lock`, 'lock')       // tools/look.mjs:1057 真实锁名
    put(root, `frames/.${BV}.lock`, 'lock')          // tools/look.mjs:2082
    put(root, `frames/${BV}-01.jpg`, 'our-frame')
    put(root, `frames/${BV}-01.jpg.part`, 'partial')
    const r = removeOwned(root)
    out.capability.J_dotOursAtRootCleared = ['.lock', '.meta-xxx.lock', '.write-test-123.lock', '.write-test-123']
      .every((n) => !existsSync(join(root, n)))
    out.capability.J_framesOursGone = !existsSync(frames)
    out.capability.J_countedFiles = r.files >= 9
    out.notes.J2 = { skipped: r.skipped, files: r.files }
  }

  // J3：剥掉 `.lock` 后底名是空串 / 纯点 / 认不出的名字，一律不认领（1722 §四 点名项）。
  {
    const root = makeRoot('rootJ3')
    put(root, '..lock', 'user-dot-dot-lock')
    put(root, '.lock.lock', 'user-double-lock')
    put(root, '.gitignore', 'user-gitignore')
    const r = removeOwned(root)
    out.defect.J_oddDotLockSurvived = ['..lock', '.lock.lock', '.gitignore']
      .every((n) => existsSync(join(root, n)))
    out.notes.J3 = { skipped: r.skipped, files: r.files }
  }

  // ── 逐目录覆盖（`OWN_CACHE_DIRS` 十个成员，每个至少一组） ──────────────────
  //   产物名逐处 grep 自生产代码，来源行号写进《逐目录凭证表》。
  //   frames 由 A–D + 下面 Frames 组共同覆盖；其余九个按「给得出/给不出凭证」分两类。

  provableDir('Logs', '_logs', (r) => {
    // index.js:515 / tools/look.mjs:883 runsFile()；tools/look.mjs:3530 失败现场
    put(r, '_logs/runs.jsonl', '{}\n')
    put(r, '_logs/last-error.json', '{}')
  })

  provableDir('Frames', 'frames', (r) => {
    // tools/look.mjs:855 writeManifest({ files })；:838 `${bv}-NN.jpg`
    put(r, `frames/${BV}-p1-2s/manifest.json`, JSON.stringify({ ok: true, files: [`${BV}-01.jpg`] }))
    put(r, `frames/${BV}-p1-2s/${BV}-01.jpg`, 'frame')
  })

  provableDir('Sheets', 'sheets', (r) => {
    // tools/look.mjs:2013 / :2022 / :2084
    put(r, `sheets/${BV}-p1-3x3.jpg`, 'sheet')
    put(r, `sheets/${BV}-p1-3x3.manifest.json`, '{}')
    put(r, `sheets/${BV}-p1-substrip.jpg`, 'substrip')
  })

  provableDir('Misc', '_misc', (r) => {
    // tools/look.mjs:2427 WARN_STATE()
    put(r, '_misc/injection-warned.json', '{}')
  })

  provableDir('Asr', 'asr', (r) => {
    // tools/look.mjs:1050 / :1060 / :1149 / :1153
    put(r, `asr/${BV}-p1-123-model-abcdef12.txt`, 'transcript')
    put(r, `asr/${BV}-p1-123-model-abcdef12.txt.cues.json`, '[]')
    put(r, `asr/.${BV}-p1.lock`, 'lock')
  })

  unprovableDir('SheetTmp', 'sheet-tmp', (r) => {
    // tools/look.mjs:2004 / :2010 —— tmp 子目录里是 `%02d.jpg`，与用户 `01.jpg` 不可区分
    put(r, `sheet-tmp/.${BV}-3x3.lock`, 'lock')
    put(r, `sheet-tmp/${BV}-3x3/01.jpg`, 'cell')
  })

  unprovableDir('SubstripTmp', 'substrip-tmp', (r) => {
    // tools/look.mjs:2075 / :2081
    put(r, `substrip-tmp/.${BV}.lock`, 'lock')
    put(r, `substrip-tmp/${BV}/01.jpg`, 'cell')
  })

  unprovableDir('FramesDl', 'frames-dl', (r) => {
    // tools/look.mjs:3397-3399 —— 通用 URL 下载目录，内部文件名来自网络，不可枚举
    put(r, 'frames-dl/gen-0123456789/video.mp4', 'video')
  })

  unprovableDir('AudioDl', 'audio-dl', (r) => {
    // tools/look.mjs:3411-3413
    put(r, 'audio-dl/gen-0123456789/audio.m4a', 'audio')
  })

  unprovableDir('Hot', '_hot', (r) => {
    // 全仓 grep `_hot` 只有 consts 的常量与 trimForModel 的 tag 参数，**无任何落盘点**
    put(r, '_hot/hot.json', '{}')
  })

  // ── N / O（DSH 1848 §三）：正常产过文本的视频目录 ──────────────────────────
  //   现场见 §二 复现：`<BV>_text/` 里 meta.json + text.txt + text.wrapped.txt +
  //   text.<tag>.tool.txt。本版把「按扩展名猜」换成精确白名单后，text.txt /
  //   text.wrapped.txt 没有凭证 → isOwnBvDir 的 dirIsProvablyOurs 全或无失败 →
  //   整棵不动，用户点「清除缓存」看到「已清理 0 项」。
  //   注意 `.tool.txt` 按 §三 简写造会以点开头、落 isProvenDotName 而不认领；
  //   这里按 §二 复现用的真实文件名 text.mw0noulq4.tool.txt 造（过 /\.tool\.txt$/）。
  const textDir = `${BV}_text`
  const seedTextVideo = (root) => {
    put(root, `${textDir}/meta.json`, JSON.stringify({ bv: BV, title: 'x' }))
    put(root, `${textDir}/text.txt`, 'subtitle')
    put(root, `${textDir}/text.wrapped.txt`, 'wrapped')
    put(root, `${textDir}/text.mw0noulq4.tool.txt`, 'tool')
  }
  {
    const root = makeRoot('rootN')
    seedTextVideo(root)
    const r = removeOwned(root)
    out.capability.N_textVideoGone = !existsSync(join(root, textDir))
    out.notes.N = { files: r.files, skipped: r.skipped }
  }
  {
    // O（按 §三 字面）：同目录混一张用户 1.jpg → 整棵不动、skipped 点名。
    const root = makeRoot('rootO')
    seedTextVideo(root)
    put(root, `${textDir}/1.jpg`, 'user-photo')
    const r = removeOwned(root)
    out.defect.O_userJpgSurvived = existsSync(join(root, textDir, '1.jpg'))
    out.defect.O_dirUntouched = existsSync(join(root, textDir))
    out.defect.O_skippedNamesBvDir = (r.skipped || []).some((s) => String(s?.name || '') === textDir)
    out.notes.O = { files: r.files, skipped: r.skipped }
  }
  {
    // O2：同目录混一个用户自己的 `notes.txt`。
    //   §三 给的扰动②是「把正则放宽成 ^.*\.txt$ → O 红」，但 O 里混的是 1.jpg，
    //   不是 .txt，那个扰动打不红它。补这一棵同型目录，让同一扰动真正咬合
    //   「不许按 .txt 后缀通吃」这条本轮核心风险；扰动原始输出在交卷里如实报。
    const root = makeRoot('rootO2')
    seedTextVideo(root)
    put(root, `${textDir}/notes.txt`, 'user-own-notes')
    const r = removeOwned(root)
    out.defect.O2_userTxtSurvived = existsSync(join(root, textDir, 'notes.txt'))
    out.defect.O2_dirUntouched = existsSync(join(root, textDir))
    out.defect.O2_skippedNamesBvDir = (r.skipped || []).some((s) => String(s?.name || '') === textDir)
    out.notes.O2 = { files: r.files, skipped: r.skipped }
  }
  {
    // V（DSH 2114 追认 1，替代原来那条手工确认）：`view` 不是 printText 的 kind，
    //   cmdView 只调 writeMeta、全仓无 `view.txt` 落盘点。若把 view 留在 PROVEN_NAME_RE，
    //   这个目录会被当成「整棵都是我们的」删掉 —— 用户自己的 view.txt 一起没。
    //   造 BV 目录（meta.json 是正向凭证）+ 一个用户 view.txt，判据必须整棵不动。
    const root = makeRoot('rootV')
    const vDir = `${BV}_view`
    put(root, `${vDir}/meta.json`, JSON.stringify({ bv: BV, title: 'x' }))
    put(root, `${vDir}/view.txt`, 'user-view-note')
    const r = removeOwned(root)
    out.defect.V_viewTxtSurvived = existsSync(join(root, vDir, 'view.txt'))
    out.defect.V_dirUntouched = existsSync(join(root, vDir))
    out.defect.V_skippedNamesBvDir = (r.skipped || []).some((s) => String(s?.name || '') === vDir)
    out.notes.V = { files: r.files, skipped: r.skipped }
  }
} catch (e) {
  out.error = String(e?.stack || e)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

process.stdout.write(JSON.stringify(out))
// 2026-11-05：补退出码语义（字段一个没加、一个没改）。
//   原来只 write 不设 rc —— 12 条断言 false 也报 rc=0，扰动实验就会把「判据红」
//   记成「跑过了」。C162 读的是 JSON 字段，不受影响；0 全绿 / 1 有不符 / 2 探针自身坏，
//   与 deps-migrate-probe.mjs 的口径一致。
const defectOK = Object.entries(out.defect).every(([, v]) => v === true)
const capOK = Object.entries(out.capability).every(([, v]) => v === true)
process.exitCode = out.error ? 2 : (defectOK && capOK ? 0 : 1)
