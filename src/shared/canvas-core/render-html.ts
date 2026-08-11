import type { FlowGraph } from '../types'
import { deoverlapLabels } from './deoverlap'
import { computeLayout, CARD_W, HEAD_H } from './layout'
import { routeEdges } from './routing'
import { CANVAS_CSS } from './styles'

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const KIND_LABEL: Record<string, string> = {
  normal: '正常态',
  validation: '校验态',
  manual: '人工录制',
}

export interface RenderOptions {
  title: string
  /** nodeId → data:image/jpeg;base64,… 或相对路径 */
  imageSrc: (nodeId: string) => string | null
  device?: { width: number; height: number }
  subtitle?: string
}

/**
 * 生成自包含的单文件 HTML。
 * 几何、样式、去重叠都取自与实时画布相同的模块——deoverlapLabels 直接序列化成文本内联，
 * 从根上杜绝「导出结果和界面上看到的不一样」。
 */
export function renderHtml(graph: FlowGraph, opts: RenderOptions): string {
  const device = opts.device ?? { width: 430, height: 932 }
  const layout = computeLayout(graph, device)
  const edges = routeEdges(graph.edges, layout)
  const { imgH, worldW, worldH, positions, laneBoxes, seqNo } = layout

  const lanesHtml = laneBoxes
    .map(
      (b) =>
        `<div class="ufc-lane" data-lane="${esc(b.lane.id)}" style="left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px">
  <div class="ufc-lane-title">${esc(b.lane.title)}${b.lane.subtitle ? `<span>${esc(b.lane.subtitle)}</span>` : ''}</div>
</div>`
    )
    .join('\n')

  const cardsHtml = [...positions.values()]
    .map((p) => {
      const n = p.node
      const src = opts.imageSrc(n.id)
      const shot = src
        ? `<img src="${esc(src)}" alt="${esc(n.title)}" loading="lazy">`
        : `<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">（无截图）</div>`
      return `<div class="ufc-card ${esc(n.kind)}" data-id="${esc(n.id)}" data-lane="${esc(n.lane)}" style="left:${p.x}px;top:${p.y}px;width:${CARD_W}px">
  <div class="ufc-head">
    <div class="ufc-row"><span class="ufc-num">${esc(seqNo.get(n.id) ?? '')}</span><span class="ufc-tag">${esc(KIND_LABEL[n.kind] ?? n.kind)}</span></div>
    <div class="ufc-title">${esc(n.title)}</div>
    ${n.subtitle ? `<div class="ufc-sub">${esc(n.subtitle)}</div>` : ''}
    ${n.note ? `<div class="ufc-note">${esc(n.note)}</div>` : ''}
  </div>
  <div class="ufc-shot" style="height:${imgH}px">${shot}</div>
</div>`
    })
    .join('\n')

  const marker = (id: string) =>
    `<marker id="ufc-arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ufc-ah-${id}" d="M0,0 L10,5 L0,10 z"/></marker>`

  const wires = `<svg class="ufc-wires" width="${worldW}" height="${worldH}">
  <defs>${marker('primary')}${marker('branch')}${marker('back')}${marker('link')}</defs>
  ${edges.map((e) => `<path class="ufc-edge ${esc(e.type)}" d="${e.d}" marker-end="url(#ufc-arrow-${esc(e.type)})"/>`).join('\n')}
</svg>`

  const labels = edges
    .map(
      (e) =>
        `<div class="ufc-label ${esc(e.type)}"${e.anchor ? ` data-anchor="${e.anchor}"` : ''} style="left:${e.lx}px;top:${e.ly}px">${esc(e.label)}</div>`
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
:root{--bg:#12141a;--panel:#1a1d25;--panel-2:#232733;--grid:#1b1e26;--fg:#e8eaf0;--muted:#8f97a8;
  --line:#2a2f3a;--accent:#2ecc71;--branch:#f0a04b;--back:#7aa2f7;--link:#b48ead}
:root[data-theme="light"]{--bg:#f4f5f8;--panel:#fff;--panel-2:#eef0f5;--grid:#e6e8ee;--fg:#1a1d25;
  --muted:#5d6577;--line:#d8dbe4;--accent:#18995a;--branch:#c46a10;--back:#3b6dd8;--link:#8a5c86}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);
  font:14px/1.5 "PingFang SC","Microsoft YaHei",-apple-system,Segoe UI,sans-serif}
${CANVAS_CSS}
#ufc-bar{position:fixed;left:12px;top:12px;right:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;
  padding:9px 12px;border-radius:12px;background:color-mix(in srgb,var(--panel) 88%,transparent);
  border:1px solid var(--line);backdrop-filter:blur(8px);z-index:10}
#ufc-bar h1{font-size:14px;margin:0 8px 0 0;font-weight:700}
#ufc-bar .meta{font-size:12px;color:var(--muted)}
button{font:inherit;font-size:12px;color:var(--fg);background:var(--panel-2);border:1px solid var(--line);
  border-radius:8px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}
#ufc-zoom{min-width:56px;text-align:center;font:600 12px/1.6 ui-monospace,Consolas,monospace}
#ufc-legend{position:fixed;right:12px;bottom:12px;padding:10px 12px;border-radius:12px;z-index:10;
  background:color-mix(in srgb,var(--panel) 88%,transparent);border:1px solid var(--line);font-size:12px}
#ufc-legend div{display:flex;align-items:center;gap:8px;margin:3px 0}
#ufc-legend i{width:26px;border-top-width:2px;border-top-style:solid;display:inline-block}
#ufc-hint{position:fixed;left:12px;bottom:12px;font-size:12px;color:var(--muted);z-index:10}
</style>
</head>
<body>
<div id="ufc-bar">
  <h1>${esc(opts.title)}</h1>
  <span class="meta">${esc(opts.subtitle ?? '')} · ${positions.size} 屏 · ${edges.length} 条连线</span>
  <button id="ufc-fit">全览 (F)</button>
  <button id="ufc-reset">100% (0)</button>
  <button id="ufc-zin">＋</button><span id="ufc-zoom">100%</span><button id="ufc-zout">－</button>
  <button id="ufc-theme">浅色</button>
</div>
<div class="ufc-stage" id="ufc-stage"><div class="ufc-world" id="ufc-world" style="width:${worldW}px;height:${worldH}px">
${lanesHtml}
${wires}
${cardsHtml}
${labels}
</div></div>
<div id="ufc-legend">
  <div><i style="border-color:var(--accent)"></i>主干路径</div>
  <div><i style="border-color:var(--branch);border-top-style:dashed"></i>分支 / 校验</div>
  <div><i style="border-color:var(--back);border-top-style:dotted"></i>修正后重试</div>
  <div><i style="border-color:var(--link);border-top-style:dashed"></i>界面等价跳转</div>
</div>
<div id="ufc-hint">任意处拖拽平移（中键 / 空格 + 拖拽同样可用）· 滚轮缩放 · 双击卡片聚焦 · F 全览 · 0 复位</div>
<script>
${deoverlapLabels.toString()}
deoverlapLabels()
if (document.fonts && document.fonts.ready) document.fonts.ready.then(deoverlapLabels)

const world = document.getElementById('ufc-world'), stage = document.getElementById('ufc-stage')
const W = ${worldW}, H = ${worldH}
let k = 1, x = 0, y = 0, spaceDown = false
const apply = () => { world.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + k + ')'
  document.getElementById('ufc-zoom').textContent = Math.round(k * 100) + '%' }
function fit(){ const p = 64; k = Math.min((innerWidth-p*2)/W,(innerHeight-p*2)/H); x = (innerWidth-W*k)/2; y = (innerHeight-H*k)/2; apply() }
function fitWidth(){ const p = 40; k = Math.max(.42, Math.min(1,(innerWidth-p*2)/W)); x = p; y = 68; apply() }
function reset(){ k = 1; x = 40; y = 80; apply() }
function zoomAt(cx, cy, nk){ nk = Math.max(.05, Math.min(4, nk)); x = cx-(cx-x)*nk/k; y = cy-(cy-y)*nk/k; k = nk; apply() }

stage.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, k*Math.exp(-e.deltaY*0.0016)) }, {passive:false})
let drag = null
stage.addEventListener('dragstart', e => e.preventDefault())
stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return
  if (e.target.closest('a')) return
  e.preventDefault()
  drag = { sx: e.clientX, sy: e.clientY, ox: x, oy: y, id: e.pointerId }
  stage.classList.add('grabbing')
  try { stage.setPointerCapture(e.pointerId) } catch (err) {}
})
stage.addEventListener('pointermove', e => { if (!drag || e.pointerId !== drag.id) return
  x = drag.ox + (e.clientX - drag.sx); y = drag.oy + (e.clientY - drag.sy); apply() })
const endDrag = () => { if (drag) { try { stage.releasePointerCapture(drag.id) } catch (e) {} } drag = null; stage.classList.remove('grabbing') }
stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag)
stage.addEventListener('lostpointercapture', endDrag); addEventListener('blur', endDrag)
stage.addEventListener('dblclick', e => { const c = e.target.closest('.ufc-card'); if (!c) return
  const nk = Math.min(3, Math.min(innerWidth/(c.offsetWidth+160), innerHeight/(c.offsetHeight+160)))
  k = nk; x = innerWidth/2-(c.offsetLeft+c.offsetWidth/2)*k; y = innerHeight/2-(c.offsetTop+c.offsetHeight/2)*k; apply() })
addEventListener('keydown', e => {
  if (e.key === ' ') { spaceDown = true; e.preventDefault(); return }
  if (e.key === 'f' || e.key === 'F') fit()
  if (e.key === '0') reset()
})
addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false })
document.getElementById('ufc-fit').onclick = fit
document.getElementById('ufc-reset').onclick = reset
document.getElementById('ufc-zin').onclick = () => zoomAt(innerWidth/2, innerHeight/2, k*1.25)
document.getElementById('ufc-zout').onclick = () => zoomAt(innerWidth/2, innerHeight/2, k/1.25)
document.getElementById('ufc-theme').onclick = (e) => {
  const light = document.documentElement.getAttribute('data-theme') !== 'light'
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark')
  e.target.textContent = light ? '深色' : '浅色'
}
window.ufcFit = fit
fitWidth()
</script>
</body></html>`
}

/** 导出 PNG 时，隐藏窗口需要知道世界尺寸 */
export function worldSizeOf(graph: FlowGraph, device?: { width: number; height: number }): { width: number; height: number } {
  const l = computeLayout(graph, device)
  return { width: l.worldW, height: l.worldH }
}

export { CARD_W, HEAD_H }
