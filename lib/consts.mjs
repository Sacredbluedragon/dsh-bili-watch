/**
 * lib/consts.mjs —— 两个进程必须**完全一致**的只读常量
 *
 * 为什么单独一个模块（2026-10-31 切片 1）：
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
 * 2026-10-31 切片 2 搬进来：`isOwnBvDir` / `isOurCacheRoot` / `removeOwned` / `dirStat` /
 * 迁移逻辑都在判它，而原来 index.js 与 tools/look.mjs 各写一份。
 * 这个值是「身份凭证」——两边写岔了，就会出现「面板认、CLI 不认」的缓存根。
 */
export const CACHE_MARK = '.bili-watch-root'

/**
 * 缓存根下面这些子目录是我们自己建的，清理时可以直接按名字整棵删。
 * 不在这里的目录（`BV*` 视频目录、用户自己的素材目录）必须逐条判归属，见 cache-own.mjs。
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
