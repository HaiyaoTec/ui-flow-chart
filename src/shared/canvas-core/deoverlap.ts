/**
 * 标注去重叠。
 *
 * 必须在浏览器里跑：用的是真实渲染出来的矩形，不估算中英文混排的文字宽度，
 * 字体差异也不会算错。函数刻意写成自包含的（不引用任何外部符号），
 * 这样导出的单文件 HTML 可以直接把它序列化成文本内联，与实时画布同源。
 *
 * 避让位移只写进 --dy，绝不覆写 top：
 * 早先是把首次看到的 top 缓存在 data-top 上当基线，此后每轮都拿这个过期值加位移写回。
 * 而标注 DOM 是按边 id 复用的，重新布局时 React 只改 style.top、不动 dataset，
 * 于是标注被永久钉在第一次布局的纵坐标上——泳道每多一行，它与连线就拉开约 838px，
 * 表现就是标注飘在大片空白里、跟连线完全对不上。
 * 现在 top/left 的所有权始终在渲染层，本函数只叠加偏移，因此也是幂等的。
 */
export function deoverlapLabels(): number {
  const els = Array.prototype.slice.call(document.querySelectorAll('.ufc-label')) as HTMLElement[]
  if (!els.length) return 0

  const EDGE = 8 // 世界左边界预留
  const FLIP = 16 // 翻边后标注左缘距通道线的距离，与 styles.ts 里的 translate 保持一致

  const items = els.map((e) => {
    const left = parseFloat(e.style.left)
    const w = e.offsetWidth
    const anchor = e.dataset.anchor || 'center'
    // 右端锚定的标注向左生长，宽度只有渲染之后才知道；越过世界左边界就翻到线的右侧，
    // 否则整条落到画布之外——SVG 会把负坐标的走线裁掉，标注是 HTML 不被裁，
    // 看上去就是「标注旁边没有线」
    const flip = anchor === 'end' && left - w < EDGE
    return { e, top: parseFloat(e.style.top), left, w, h: e.offsetHeight, anchor, flip }
  })

  const rect = (it: (typeof items)[number], dy: number) => {
    const left = it.flip
      ? it.left + FLIP
      : it.anchor === 'end'
        ? it.left - it.w
        : it.anchor === 'start'
          ? it.left
          : it.left - it.w / 2
    return { x1: left, x2: left + it.w, y1: it.top + dy - it.h / 2, y2: it.top + dy + it.h / 2 }
  }

  // 截图区作为固定障碍：标注可以压在卡片留白上，但不能压住截图
  const shots = (Array.prototype.slice.call(document.querySelectorAll('.ufc-card .ufc-shot')) as HTMLElement[]).map((s) => {
    const c = s.parentElement as HTMLElement
    return {
      x1: c.offsetLeft,
      x2: c.offsetLeft + c.offsetWidth,
      y1: c.offsetTop + s.offsetTop,
      y2: c.offsetTop + s.offsetTop + s.offsetHeight,
    }
  })

  type R = { x1: number; x2: number; y1: number; y2: number }
  const hit = (a: R, b: R) => a.x1 < b.x2 - 2 && b.x1 < a.x2 - 2 && a.y1 < b.y2 - 2 && b.y1 < a.y2 - 2

  items.sort((a, b) => a.top - b.top || a.left - b.left)
  const placed: R[] = []
  let moved = 0

  for (const it of items) {
    let dy = 0
    let ok = false
    for (let s = 0; s <= 44; s++) {
      // 交替上下试探，尽量停在原位附近：0, +8, -8, +16, -16 …
      dy = s === 0 ? 0 : (s % 2 ? 1 : -1) * Math.ceil(s / 2) * 8
      const r = rect(it, dy)
      if (!placed.some((p) => hit(p, r)) && !shots.some((p) => hit(p, r))) {
        ok = true
        break
      }
    }
    if (!ok) dy = 0
    if (dy) moved++
    // 每轮对每个元素无条件重写，上一轮的残留必然被清掉，不必先复位
    if (it.flip) it.e.dataset.flip = '1'
    else delete it.e.dataset.flip
    it.e.style.setProperty('--dy', dy + 'px')
    placed.push(rect(it, dy))
  }
  return moved
}
