#!/usr/bin/env node
/**
 * tools/fixtures/frames-probe.mjs —— waitManifest 真跑探针
 *
 * 为什么单独一个文件：waitManifest 是 async，而 verify.mjs 的 check() 回调是**同步**的
 *   （C77 之后明确禁止 async 回调：断言体跑不完却记一笔 PASS，是最隐蔽的一种假绿）。
 *   所以要真跑它，只能另起一个进程，父进程 spawnSync 读它的 JSON 输出。
 *
 * 三件事：
 *   ① 等待期间 manifest 出现 → 命中并把它交回去
 *   ② hit 永不成立 → 返回 null（调用方据此抛「等不到结果」）
 *   ③ 轮询次数等于 tries（不多不少——多等一轮就是白等一秒）
 *
 * sleep 是注入的假函数，不真等 1 秒，所以这个探针是秒级的。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { waitManifest, writeManifest } from '../../lib/frames.mjs'

const out = {}
const tmp = mkdtempSync(join(tmpdir(), 'bw-wait-'))
try {
  // ① 命中：第一次轮询前把 manifest 写进去
  const dir = join(tmp, 'ok')
  mkdirSync(dir, { recursive: true })
  let polls = 0
  const hit = await waitManifest(dir, (m) => Boolean(m?.ok) && m.frames >= 5, {
    tries: 5,
    pollMs: 1,
    sleep: async () => {
      polls++
      writeManifest(dir, { ok: true, frames: 5, times: [460] })
    },
  })
  out.hitFrames = hit?.frames ?? null
  out.hitTimes = hit?.times ?? null
  out.polls = polls

  // ② 不命中：hit 永远假 → null
  const dir2 = join(tmp, 'none')
  mkdirSync(dir2, { recursive: true })
  let n = 0
  const none = await waitManifest(dir2, () => false, {
    tries: 3,
    pollMs: 1,
    sleep: async () => { n++ },
  })
  out.none = none
  out.n = n

  // ③ manifest 出现得晚一点（第 2 轮才写）→ 第 2 轮命中，轮询次数必须正好是 2
  const dir3 = join(tmp, 'late')
  mkdirSync(dir3, { recursive: true })
  let late = 0
  const lateHit = await waitManifest(dir3, (m) => Boolean(m?.ok), {
    tries: 4,
    pollMs: 1,
    sleep: async () => {
      late++
      if (late === 2) writeManifest(dir3, { ok: true, frames: 9 })
    },
  })
  out.lateFrames = lateHit?.frames ?? null
  out.latePolls = late

  // ④ 已有的 manifest **不满足** hit（另一个实例只抽了一半：ok 但帧数不够）
  //   → 必须继续等，不能把它当成命中。这是「等他人」最容易写歪的一处：
  //   判据写成「目录里有 manifest 就算成了」，就会拿半截结果当完整结果。
  const dir4 = join(tmp, 'half')
  mkdirSync(dir4, { recursive: true })
  writeManifest(dir4, { ok: true, frames: 2 })
  let p4 = 0
  const half = await waitManifest(dir4, (m) => Boolean(m?.ok) && m.frames >= 5, {
    tries: 3,
    pollMs: 1,
    sleep: async () => { p4++ },
  })
  out.halfIsNull = half === null
  out.halfPolls = p4
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

process.stdout.write(JSON.stringify(out))
