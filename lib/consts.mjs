/**
 * lib/consts.mjs —— 两个进程必须**完全一致**的只读常量
 *
 * 为什么单独一个模块（2026-10-31）：
 *   index.js（DSH 进程内）与 tools/look.mjs（CLI 子进程）各有一份同名同值的常量。
 *   分开写的成本不是「多几行」，而是「改一处要记得改两处」——漏了就出现「面板认这个目录
 *   是我们写的、CLI 不认」，于是同一个缓存根，面板清得干净、CLI 清不干净（或反过来）。
 *   搬到这里后物理上只有一份。
 *
 * 只放**只读**常量。可变状态（CACHE / CACHE_READY / cfgWarning）不放这里，
 * 见 cache-path.mjs 与 config.mjs —— 那些必须走显式 init，不能靠模块加载顺序。
 */

/**
 * 缓存根标记文件。只有我们自己写过这个文件，才认「这个目录已经是缓存根」。
 *
 * 2026-10-31 搬进来：`isOwnBvDir` / `isOurCacheRoot` / `removeOwned` / `dirStat` /
 * 迁移逻辑都在判它，而原来 index.js 与 tools/look.mjs 各写一份。
 * 这个值是「身份凭证」——两边写岔了，就会出现「面板认、CLI 不认」的缓存根。
 */
export const CACHE_MARK = '.bili-watch-root'

/**
 * 缓存根下面这些子目录是我们自己建的，清理时可以直接按名字整棵删。
 * 不在这里的目录（`BV*` 视频目录、用户自己的素材目录）必须逐条判归属，见 cache-own.mjs。
 *
 * 两份清单互指（0.4.15 判定层收敛）：本集合是**白名单 / 可认领可删清单**，data 语义一字未改；
 * `lib/cache-own.mjs` 的 `UNPROVABLE_DIRS` 是**黑名单 / 给不出正向凭证即不可认领清单**。
 * 交集正好 5 项（sheet-tmp / substrip-tmp / frames-dl / audio-dl / _hot），语义相反；
 * **交集以 `UNPROVABLE_DIRS`（不可认领）为准**：本集合这 5 项不按名字认领，实际由
 * `dirIsProvablyOurs` 的 UNPROVABLE 优先级与 `removeOwned` 的 URL 屏蔽兜底。
 * 声明处看着冗余，实为两套授权语义，勿当成重复清单删掉其中一份。
 */
export const OWN_CACHE_DIRS = new Set([
  '_logs',
  'frames',
  'sheets',
  'sheet-tmp',
  'substrip-tmp',
  '_misc',
  'asr',
  'frames-dl',
  'audio-dl',
  '_hot',
])

/**
 * 工具层长文本截断落盘名的**唯一精确形状**。
 *
 * 落盘点只有 index.js 的 trimForModel()：
 *   `${tag}.${Date.now().toString(36)}${seq}.tool.txt`，tag 是命令名（或 'hot' / 默认 'out'），
 *   时间戳段是 36 进制小写字母数字。用户随手建的「笔记.tool.txt」没有中间那段时间戳，
 *   过不了这条正则 —— 这正是 F-01 的区分点。
 *
 * tag 段字符集对齐 index.js:100 的 sanitizer `[^\w.-]` 剥除后剩下的形状：
 *   `[A-Za-z0-9_.-]`。0.4.15 收紧时第一段写成 `[a-z]` 开头，把我们自己真会写出来的
 *   `2view`（数字开头）、`v.ew`（含点）、`--head`（横线开头）、`_view`（下划线开头）
 *   也挡在正凭证之外，历史残留的这类文件整棵清不掉。这里按 sanitizer 产出集放宽第一段，
 *   但强形状不动：仍必须是「tag 段 + 6 位以上 36 进制时间戳段 + .tool.txt」。
 *   中文 tag（`我的重要笔记`）不在字符集内；`notes.tool.txt` / `x.tool.txt` 没有 6 位以上
 *   时间戳段，仍然 false。
 *
 * 大小写刻意敏感（不带 `i`）：生产写盘三处恒小写——扩展名是 index.js:111 模板字面量
 *   `.tool.txt`；时间戳段是 `Date.now().toString(36)` 与自增 seq `.toString(36)`，36 进制
 *   输出恒小写；tag 取自命令名（COMMANDS 全集小写单词）/ `hot` / 默认 `out`。`.TOOL.TXT`
 *   或大写时间戳段不可能是本插件写出来的产物，认进可删清单只会扩大误删面。去掉 `i` 后
 *   三个调用方一律更保守：cache-own.mjs 逐条凭证与 `.part` 剥后缀校验、keys.mjs 的 URL
 *   目录内容校验，遇到大写形状都认不出 → 落 foreign/skipped，不删。
 *
 * 为什么不放成 `\.tool\.txt$` 后缀通吃：旧判据把用户文件也当正凭证，会无授权删除（P0）。
 * 为什么不放成「一律不认」：C162 的 capability 现场证明 `<BV>_text/` 里的
 * `text.<tag>.tool.txt` 是真产物，去掉凭证会让整棵 BV 目录清不掉（0.4.10 重演）。
 * 两个进程（面板 / CLI）共用这一份，不许各写一份。
 */
export const PROVEN_TOOL_TXT_RE = /^[A-Za-z0-9_.-]+\.[0-9a-z]{6,}\.tool\.txt$/

/**
 * 浏览器 UA 与 Referer —— **两个入口与 lib 的请求层必须逐字相同**。
 *
 * 2026-11-01（0.4.1 第 1 条）搬进来：原来 `index.js` 与 `tools/look.mjs` 各写一份、逐字相同；
 * `lib/bili-api.mjs` 的 jget 默认请求头也要它俩，而 lib 不能反向 import 入口。
 * 一起合并的还有 look.mjs 的 `REF_VIDEO` —— 它与 `REF` 的值一直完全一样（都是站点根），
 * 两份同值常量就是「改一处忘另一处」的入口（早就踩过的老坑）。
 *
 * 不带 Cookie：匿名 buvid3 要读 `deps/.anon-buvid3` 并依赖落盘时机，属于入口的知识，
 * 见 tools/look.mjs 的 `H`；lib 这边只保证「不传头也有个像样的头」。
 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 站点根 Referer。B 站接口不带 Referer 会被当爬虫（412 的常见诱因之一）。 */
export const REF = 'https://www.bilibili.com/'
