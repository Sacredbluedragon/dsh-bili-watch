/**
 * C236b：三档 deleteMode 的唯一删除落点。
 *
 * 定案（14:30 段 §三）：默认 permanent 直删，不碰用户的回收站配额；
 * recycle 全走回收站；smart 只把显式清单里的重要文件送回收站，其余直删。
 * 手动 / 自动 / clean --all 三条路径都必须调这里，不许各自再写一份 rmSync。
 *
 * 三个失效面（设计约定 §五 C236b）：
 *   ① 无回收站卷 / 网络盘：API 抛异常 → 直删，但 fallback 明确记「永久删除」，由调用方说出来；
 *   ② 路径 > 260 字符：VB API 不支持长路径前缀 → 记 failed，绝不当成功；
 *   ③ 回收站按盘有容量上限：放不下就跳过并记 overflow，绝不静默降级成直删。
 *
 * 外部命令只经 lib/exec.mjs 起（边界守卫），平台判定只经 lib/platform.mjs。
 * 判据可以把 probe 注入进来，单独验「容量不足」这类本机造不出来的分支。
 */
import { rmSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { runExecFileSync } from './exec.mjs'
import { hostPlatform } from './platform.mjs'

export const DELETE_MODES = ['permanent', 'recycle', 'smart']
export const DEFAULT_DELETE_MODE = 'permanent'

/** 坏配置不许改变行为：只认三个字面量，其余一律回默认。 */
export function normalizeDeleteMode(v) {
  return DELETE_MODES.includes(v) ? v : DEFAULT_DELETE_MODE
}

/**
 * smart 档的「重要文件」是代码里的显式清单，不做任何启发式判断（设计约定 §3.1）。
 *   1. frames-dl/ 下原视频（重下耗流量）
 *   2. audio-dl/ 下音轨（重下再重抽）
 *   3. ASR 转写 *.txt（重转耗额度 + 几分钟）
 * 其余（frames/ jpg、sheet 产物、*-tmp/、meta.json）重跑命令就有，不进回收站。
 */
export function isImportant(rel) {
  const s = String(rel || '').replace(/\\/g, '/')
  const parts = s.split('/').filter(Boolean)
  if (parts.includes('frames-dl') || parts.includes('audio-dl')) return true
  return /\.txt$/i.test(s)
}

const RB_CS = 'using System;using System.Runtime.InteropServices;public static class RbQuery{[StructLayout(LayoutKind.Sequential)]public struct Info{public uint cbSize;public long i64Size;public long i64NumItems;}[DllImport("shell32.dll",CharSet=CharSet.Unicode)]public static extern int SHQueryRecycleBin(string root,ref Info info);}'

function psOut(lines) {
  const script = ["$ProgressPreference='SilentlyContinue'", "$ErrorActionPreference='Stop'", ...lines].join('\r\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const out = runExecFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  })
  return String(out || '').trim()
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** 卷根必须是「盘符 + 反斜杠」的完整形式；只给盘符会让 SHQueryRecycleBin 返回 hr≠0 和全空值。 */
export function volumeRoot(p) {
  const abs = resolve(p)
  if (hostPlatform() !== 'win32') return '/'
  return abs.slice(0, 2).toUpperCase() + '\\'
}

/**
 * SHQueryRecycleBin 的 i64NumItems / i64Size。
 * 返回 { ok, count, size, hr }；调用失败时 ok=false，调用方必须按「没查到」处理，不许当 0。
 */
export function recycleBinCount(p) {
  const root = volumeRoot(p)
  const q = [
    `Add-Type -TypeDefinition '${RB_CS}'`,
    '$i=New-Object RbQuery+Info; $i.cbSize=24',
    `$hr=[RbQuery]::SHQueryRecycleBin(${quote(root)},[ref]$i)`,
    'if($hr -ne 0){"ERR|"+$hr}else{"OK|"+$i.i64NumItems+"|"+$i.i64Size}',
  ]
  try {
    const line = psOut(q).split(/\r?\n/).pop() || ''
    const [tag, a, b] = line.split('|')
    if (tag !== 'OK') return { ok: false, count: 0, size: 0, hr: Number(a) || -1 }
    return { ok: true, count: Number(a), size: Number(b), hr: 0 }
  } catch (e) {
    return { ok: false, count: 0, size: 0, hr: -1, why: String(e?.message || e) }
  }
}

/**
 * 回收站按盘的容量上限（MB）与 NukeOnDelete。
 * 盘符经 Win32_Volume.DeviceID 里的 GUID 映射（设计约定 §五）。取不到返回 null = 不设闸。
 */
export function recycleBinCapacityMB(p) {
  const abs = resolve(p)
  const letter = abs.slice(0, 2).toUpperCase()
  const q = [
    `$v=Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -eq ${quote(letter)} } | Select-Object -First 1`,
    '$g=""',
    'if($v -and $v.DeviceID -match "\\{[0-9a-fA-F-]+\\}"){$g=$Matches[0]}',
    'if($g -eq ""){"NONE"}else{',
    `  $k="HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\"+$g`,
    '  $p=Get-ItemProperty -Path $k -ErrorAction SilentlyContinue',
    '  if($p){"OK|"+$p.MaxCapacity+"|"+$p.NukeOnDelete}else{"NONE"}',
    '}',
  ]
  try {
    const [tag, a, b] = (psOut(q).split(/\r?\n/).pop() || '').split('|')
    if (tag !== 'OK') return null
    // NukeOnDelete=1 时上限无意义；MaxCapacity 为 0 / 非数也当没查到。
    if (Number(b) === 1) return null
    const mb = Number(a)
    return Number.isFinite(mb) && mb > 0 ? mb : null
  } catch {
    return null
  }
}

/** 单个条目送回收站；目录与文件分别走 VB 的两个 API，用 Test-Path -PathType Container 分辨。 */
export function recycleOne(p) {
  const q = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$p=${quote(resolve(p))}`,
    'if(Test-Path -LiteralPath $p -PathType Container){',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
    '}else{',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
    '}',
    'if(Test-Path -LiteralPath $p){"STILL"}else{"OK"}',
  ]
  try {
    const line = psOut(q).split(/\r?\n/).pop() || ''
    return line === 'OK' ? { ok: true } : { ok: false, why: line || '回收站 API 没有确认删除' }
  } catch (e) {
    return { ok: false, why: String(e?.message || e) }
  }
}

/** 默认探针：真调本机 API。判据可整体替换成确定性桩。 */
export const defaultProbe = {
  binCount: recycleBinCount,
  capacityMB: recycleBinCapacityMB,
  recycle: recycleOne,
}

/**
 * 统一删除入口。entries: [{ path, name, bytes, files, rel }]。
 * 返回 { removed, bytes, failed, overflow:{count,bytes}, fallback, recycled, direct, mode }。
 *
 * probe 注入只用于判据隔离环境依赖；生产调用一律走 defaultProbe。
 */
export function deletePaths(entries, opts = {}) {
  const mode = normalizeDeleteMode(opts.mode)
  const probe = opts.probe || defaultProbe
  const root = opts.root || process.cwd()
  const result = {
    mode, removed: 0, bytes: 0, failed: [], overflow: { count: 0, bytes: 0 },
    fallback: [], recycled: [], direct: [],
  }
  const list = (Array.isArray(entries) ? entries : []).map((e) => ({
    ...e,
    rel: e.rel || relative(root, e.path).replace(/\\/g, '/'),
  }))

  // 容量闸：只有真要进回收站时才查，permanent 档一次 PowerShell 都不起。
  const wantRecycle = (e) => mode === 'recycle' || (mode === 'smart' && isImportant(e.rel))
  const targets = list.filter(wantRecycle)
  let room = Infinity
  if (targets.length) {
    const capMb = probe.capacityMB?.(targets[0].path)
    if (Number.isFinite(capMb) && capMb > 0) {
      const used = probe.binCount?.(targets[0].path)
      if (used?.ok) room = Math.max(0, capMb * 1048576 - used.size)
      else room = 0 // 查不到当前占用：不许盲目塞，按放不下跳过（不静默直删）
    }
  }

  for (const e of list) {
    const bytes = Number(e.bytes) || 0
    const recycle = wantRecycle(e)
    if (recycle && bytes > room) {
      // 放不下 → 跳过不删，记一笔。绝不降级成直删（设计约定 §3.2 / §六.5③）。
      result.overflow.count += 1
      result.overflow.bytes += bytes
      continue
    }
    if (recycle && resolve(e.path).length > 260) {
      // VB API 不支持长路径前缀；记 failed，不当成功（设计约定 §五 失效面 2）。
      result.failed.push({ name: e.name, why: '路径超过 260 字符，回收站 API 不支持，未删除' })
      continue
    }
    if (recycle) {
      const r = probe.recycle?.(e.path) || { ok: false, why: '没有回收站执行器' }
      if (r.ok) {
        result.recycled.push(e.name)
        room -= bytes
      } else {
        // 失效面 1：网络盘 / 无回收站卷 → 回落直删，但明确记「永久删除」，不许静默。
        try {
          rmSync(e.path, { recursive: true, force: true })
          result.fallback.push({ name: e.name, why: r.why, permanent: true })
          result.direct.push(e.name)
        } catch (err) {
          result.failed.push({ name: e.name, why: `回收站失败且直删失败：${String(err?.message || err)}` })
          continue
        }
      }
    } else {
      try {
        rmSync(e.path, { recursive: true, force: true })
        result.direct.push(e.name)
      } catch (err) {
        result.failed.push({ name: e.name, why: String(err?.message || err) })
        continue
      }
    }
    result.removed += 1
    result.bytes += bytes
  }
  return result
}

