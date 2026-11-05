#!/usr/bin/env node
/**
 * 本机身份项的**唯一**读取处：三源合并，供 check-public-text.mjs / check-release-leak.mjs 共用。
 *
 * 身份类字面量**不写死在源码里**，运行时从三个来源合并读（同 tools/verify.mjs 的 C33 口径）。
 *
 * 为什么必须动态读：
 *   ① 调用方会进公开仓库（发布树的 origin 是公开 GitHub 仓库）——
 *      把「防泄漏清单」本身写死在源码里，等于拿清单去泄漏真实身份。
 *   ② 调用方同时在 sync-release.ps1 的 $repoOnly 清单里（只进仓库、不进包），
 *      而 sync 的「仅仓库」那遍扫描用 $hardRules（本机身份）扫 repoOnly 文件。
 *      写死身份 = **闸门自己撞自己的闸门**：真跑 release.ps1 必然在 sync 阶段 exit 2。
 *      实测就是这条把 0.4.2 之后的所有发版全堵住了（闸门从那以后一次没真跑过）。
 *
 * 三个来源，**合并**（不是三选一 —— 少一个来源就少扫一类身份）：
 *   ① 环境变量 BILI_WATCH_LEAK_IDS（逗号/空白分隔）
 *   ② 仓库根 .leak-ids（一行一个，# 开头是注释，已 gitignore）
 *   ③ 环境里的用户名（USERNAME / USER）
 *
 * 三个来源都取不到时的口径：**放行，但必须明说少扫了什么** —— 不许静默通过。
 * 调用方输出里会打「身份项 0 个（…没扫）」，让人一眼看出昵称/mid 那两类没被覆盖。
 *
 * 取值门槛与 C33 一致：纯 ASCII 短名（<4）几乎必然误报（\busr\b 之类），
 * 中文昵称按 ≥2 字放宽。宁可少扫一项，也不要在别的机器上一跑就假红。
 *
 * 本模块只负责「读」，不含任何身份清单本身；两个调用方都 import 它，不许再抄第二份。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const LOCAL_USER = (process.env.USERNAME || process.env.USER || '').trim()
export const okId = (s) => s.length >= 4 || (/[^\x00-\x7F]/.test(s) && s.length >= 2)

/**
 * @param {string} repoRoot 要读 `.leak-ids` 的仓库根。调用方传自己的根，
 *   不要在这里写死路径：check-public-text 用脚本所在仓库，check-release-leak 用 --dir 指向的树。
 * @returns {{ LOCAL_USER: string, IDENTITY_IDS: string[], IDENTITY_WORDS: string[] }}
 */
export function readIdentity(repoRoot) {
  const fromEnv = String(process.env.BILI_WATCH_LEAK_IDS || '').split(/[,，\s]+/).filter(Boolean)
  let fromFile = []
  try {
    fromFile = readFileSync(join(repoRoot, '.leak-ids'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  } catch { /* 没有这个文件是正常情况（发布树、别人的机器） */ }
  const IDENTITY_IDS = [...new Set([...fromEnv, ...fromFile].map((s) => s.trim()).filter(okId))]
  const IDENTITY_WORDS = [...new Set([LOCAL_USER, ...IDENTITY_IDS].filter(okId))]
  return { LOCAL_USER, IDENTITY_IDS, IDENTITY_WORDS }
}
