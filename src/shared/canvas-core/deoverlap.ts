/**
 * 标注去重叠。
 *
 * 必须在浏览器里跑：用的是真实渲染出来的矩形，不估算中英文混排的文字宽度，
 * 字体差异也不会算错。函数刻意写成自包含的（不引用任何外部符号），
 * 这样导出的单文件 HTML 可以直接把它序列化成文本内联，与实时画布同源。
 */
export function deoverlapLabels(): number {
  const els = Array.prototype.slice.call(document.querySelectorAll('.ufc-label')) as HTMLElement[]
  if (!els.length) return 0

  const items = els.map((e) => {
    if (!e.dataset.top) e.dataset.top = String(parseFloat(e.style.top))
    return {
      e,
      top: parseFloat(e.dataset.top),
      left: parseFloat(e.style.left),
      w: e.offsetWidth,
      h: e.offsetHeight,
      anchor: e.dataset.anchor || 'center',
    }
  })

  const rect = (it: (typeof items)[number], dy: number) => {
    const left = it.anchor === 'end' ? it.left - it.w : it.anchor === 'start' ? it.left : it.left - it.w / 2
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
    it.e.style.top = it.top + dy + 'px'
    placed.push(rect(it, dy))
  }
  return moved
}
