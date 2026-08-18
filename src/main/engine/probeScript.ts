/**
 * 注入页面执行的探针。以字符串形式保存，通过 executeJavaScript 送进目标页。
 *
 * 从既有实现移植并做了两处升级：
 * 1. 可交互元素改为带 idx 的清单——AI 用 idx 指目标，执行器按同一枚举顺序重查元素，
 *    顺序对不上就判为 stale 并重新探针，避免点错。
 * 2. 增加 iframeHosts，用于识别验证码/支付这类探针读不到的跨域盲区。
 */
export const PROBE_SCRIPT = `(() => {
  const isVis = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  }
  const txt = (el) => ((el && el.innerText) || '').replace(/\\s+/g, ' ').trim()
  const zIndexOf = (el) => {
    let z = 0
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const v = parseInt(getComputedStyle(n).zIndex, 10)
      if (!Number.isNaN(v)) z = Math.max(z, v)
    }
    return z
  }

  // 顶层弹窗优先：有弹窗时把探测范围收敛进去，避免把背后页面的控件也报上来
  const dialogSel = '[role="dialog"],[class*="modal" i],[class*="Modal"],[class*="dialog" i],[class*="Dialog"],[class*="popup" i],[class*="Popup"],[class*="drawer" i],[class*="Drawer"]'
  const cands = [...document.querySelectorAll(dialogSel)].filter(isVis).filter((el) => el.getBoundingClientRect().height > 120)
  const withCtrl = cands.filter((el) => el.querySelector('input,button'))
  const pool = withCtrl.length ? withCtrl : cands
  const inner = pool.filter((el, _i, arr) => !arr.some((o) => o !== el && el.contains(o)))
  const ranked = (inner.length ? inner : pool).sort((a, b) => zIndexOf(a) - zIndexOf(b) || txt(a).length - txt(b).length)
  const top = ranked.length ? ranked[ranked.length - 1] : null
  const scope = top || document.body

  const SEL = 'a,button,input,textarea,select,label,[role="button"],[role="tab"],[role="checkbox"],[onclick]'
  const seen = new Set()
  const elements = []
  for (const el of scope.querySelectorAll(SEL)) {
    if (!isVis(el)) continue
    // 纯说明性的 <label> 不是可交互控件。把它报上去会让「手机号」这类词
    // 优先匹配到标签而不是输入框，填写就会落到一个没有 value 的元素上。
    if (el.tagName === 'LABEL' && !el.querySelector('input,select,textarea')) continue
    // 控件套控件时只取最内层，避免同一个按钮报两遍
    if ([...seen].some((s) => s.contains(el))) continue
    const r = el.getBoundingClientRect()
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const label = txt(el).slice(0, 60)
    const ph = (el.getAttribute('placeholder') || '').slice(0, 60)
    const name = (el.getAttribute('name') || el.id || '').slice(0, 40)
    if (!label && !ph && !name && tag !== 'input' && tag !== 'select' && tag !== 'textarea') continue
    seen.add(el)
    elements.push({
      idx: elements.length,
      tag,
      type,
      text: label,
      placeholder: ph,
      name,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      checked: type === 'checkbox' || type === 'radio' ? Boolean(el.checked) : undefined,
    })
    if (elements.length >= 120) break
  }

  // 偏红色系的叶子文本 = 校验/错误提示
  const notices = [...scope.querySelectorAll('*')]
    .filter((el) => el.children.length === 0 && isVis(el))
    .filter((el) => {
      const m = getComputedStyle(el).color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/)
      if (!m) return false
      return +m[1] > 150 && +m[2] < 120 && +m[3] < 120
    })
    .map(txt)
    .filter(Boolean)

  const iframeHosts = [...document.querySelectorAll('iframe')]
    .filter(isVis)
    .map((f) => {
      try { return new URL(f.src, location.href).host } catch { return '' }
    })
    .filter((h) => h && h !== location.host)

  return {
    url: location.href,
    title: document.title,
    hasDialog: !!top,
    dialogClass: top ? String(top.className).slice(0, 160) : '',
    text: txt(scope).slice(0, 1500),
    elements,
    notices: [...new Set(notices)].slice(0, 12),
    iframeHosts: [...new Set(iframeHosts)].slice(0, 8),
    scrollY: Math.round(scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    viewportHeight: innerHeight,
    bodyClass: String(document.body.className).slice(0, 120),
    scrollWidth: document.documentElement.scrollWidth,
  }
})()`

/**
 * 等这一屏真的画出来了再往下走。
 *
 * 原先只等 document.images 里 complete 为假的那些，漏了三类常见情况：
 * - 已经 complete 但还没解码完的图，画面上仍是空的
 * - 懒加载：视口外的图根本不该等，视口内的才要等
 * - 字体未就位时文字不渲染（font-display: block），拍到的是一片空白
 *
 * 最后统一等两帧：样式与布局都落定、合成器出过一帧，这时抓图才拿得到完整画面。
 */
export const WAIT_PAINT_SCRIPT = `(async () => {
  const vh = innerHeight
  const vw = innerWidth
  const near = (i) => {
    const r = i.getBoundingClientRect()
    // 稍微放宽一屏：滚动类动作之后紧接着就要抓图，边缘的图也算数
    return r.bottom > -vh && r.top < vh * 2 && r.right > -vw && r.left < vw * 2
  }
  const imgs = [...document.images].filter(near)
  const waitOne = (i) => {
    if (i.decode) return i.decode().catch(() => undefined)
    if (i.complete) return Promise.resolve()
    return new Promise((r) => { i.onload = i.onerror = r })
  }
  await Promise.race([
    Promise.all([
      document.fonts && document.fonts.ready ? document.fonts.ready.catch(() => undefined) : Promise.resolve(),
      ...imgs.map(waitOne),
    ]),
    new Promise((r) => setTimeout(r, 3000)),
  ])
  // 视图被遮住或不可见时 rAF 可能一直不触发，必须给上限——
  // 抓图路径上任何一个无界的等待都会把整轮探索卡死
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise((r) => setTimeout(r, 400)),
  ])
  return true
})()`
