// c524 夹具配套 patch：--require 预加载，改 fs 后 syncBuiltinESMExports 让 ESM 静态 import 绑到 patch。
// 场景由 PATCH_MODE 环境变量给：enospc / short / tamper / ok
const fs = require('fs')
const mode = process.env.PATCH_MODE || 'ok'
if (mode === 'enospc' || mode === 'short' || mode === 'tamper') {
  fs.linkSync = function () { const e = new Error('ENOTSUP (injected)'); e.code = 'ENOTSUP'; throw e }
  const orig = fs.writeSync
  fs.writeSync = function (fd, buf, offset, length, position) {
    const want = length == null ? buf.length : length
    if (mode === 'tamper') {
      // 写入「完整长度」但内容是错的（全 X）→ 返回值 = want（通过短写检查），
      // 只有「写完逐字节核对」才能抓住。删掉核对就会 archived=1 但盘上是坏档。
      const bad = Buffer.alloc(want, 0x58)
      return orig(fd, bad, 0, want, position)
    }
    const n = Math.min(3, want)
    const r = orig(fd, buf, offset == null ? 0 : offset, n, position)
    if (mode === 'enospc') { const e = new Error('ENOSPC (injected)'); e.code = 'ENOSPC'; throw e }
    return r // 短写：正常返回 3 字节，不抛错
  }
}
require('module').syncBuiltinESMExports()
