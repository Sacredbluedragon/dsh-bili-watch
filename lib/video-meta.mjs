// 0.4.9 A5：六处 json / text 出口共用的视频元信息。
// 为什么抽出来：模型靠「键集合」判断两次拿到的是不是同一个东西；六处手写同一份字面量，
// 只要有一处漏一个键，那一处的 video 就会和别处形状不同，而谁也不会收到报错。
// 分 P 信息 p / pages 必须保留 —— 它们是分 P 视频里唯一能定位「这是第几个 P」的字段。
// 注意：cuesToMd 的入参（带 lan，无 p/pages）与 comments payload（带 count/items）
// 是另外两种形状，不要塞进这里。
export function videoMeta(bv, v) {
  return {
    bv,
    title: v.title,
    up: v.owner,
    dur: v.dur,
    p: v.p,
    pages: v.pages,
  }
}
