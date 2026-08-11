import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { deoverlapLabels } from '@shared/canvas-core/deoverlap'
import { CARD_W, computeLayout } from '@shared/canvas-core/layout'
import { routeEdges } from '@shared/canvas-core/routing'
import { CANVAS_CSS } from '@shared/canvas-core/styles'
import type { FlowGraph } from '@shared/types'
import { usePanZoom } from './usePanZoom'
import './canvas.css'

const KIND_LABEL: Record<string, string> = { normal: '正常态', validation: '校验态', manual: '人工录制' }

interface Props {
  graph: FlowGraph
  projectId: string
  device?: { width: number; height: number }
  /** 探索过程中新出现的节点，用于入场动画与自动跟随 */
  newNodeIds?: string[]
}

export default function FlowCanvas({ graph, projectId, device, newNodeIds = [] }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [labelsOn, setLabelsOn] = useState(true)
  const [follow, setFollow] = useState(true)
  const [hiddenLanes, setHiddenLanes] = useState<Set<string>>(new Set())
  const inited = useRef(false)

  const layout = useMemo(() => computeLayout(graph, device), [graph, device])
  const edges = useMemo(() => routeEdges(graph.edges, layout), [graph.edges, layout])
  const { zoom, zoomAt, fit, fitWidth, reset, focusNode } = usePanZoom(stageRef, worldRef)

  // 版面变化后立刻做一次去重叠；用真实渲染矩形判定，所以必须在布局阶段跑
  useLayoutEffect(() => {
    deoverlapLabels()
  }, [layout, edges, labelsOn])

  useEffect(() => {
    if (inited.current || layout.positions.size === 0) return
    inited.current = true
    fitWidth(layout.worldW)
  }, [layout.worldW, layout.positions.size, fitWidth])

  // 探索过程中自动跟到最新出现的界面
  useEffect(() => {
    if (!follow || newNodeIds.length === 0) return
    const last = newNodeIds[newNodeIds.length - 1]
    const el = worldRef.current?.querySelector<HTMLElement>(`.ufc-card[data-id="${CSS.escape(last)}"]`)
    if (el) focusNode(el)
  }, [newNodeIds, follow, focusNode])

  const toggleLane = (id: string) => {
    setHiddenLanes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const marker = (id: string) => (
    <marker
      key={id}
      id={`ufc-arrow-${id}`}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path className={`ufc-ah-${id}`} d="M0,0 L10,5 L0,10 z" />
    </marker>
  )

  const hidden = (laneId: string) => hiddenLanes.has(laneId)

  return (
    <div className="canvas-root">
      <style>{CANVAS_CSS}</style>

      <div className="canvas-toolbar">
        <button onClick={() => fit(layout.worldW, layout.worldH)}>全览</button>
        <button onClick={reset}>100%</button>
        <button onClick={() => zoomAt(0, 0, zoom * 1.25)}>＋</button>
        <span className="zoom mono">{Math.round(zoom * 100)}%</span>
        <button onClick={() => zoomAt(0, 0, zoom / 1.25)}>－</button>
        <label className="seg">
          <input type="checkbox" checked={labelsOn} onChange={(e) => setLabelsOn(e.target.checked)} />
          连线标注
        </label>
        <label className="seg">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          跟随新界面
        </label>
        <label className="seg">
          <input
            type="checkbox"
            onChange={(e) => document.body.classList.toggle('ufc-selectable', e.target.checked)}
          />
          可选文本
        </label>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {layout.positions.size} 屏 · {edges.length} 条连线
        </span>
      </div>

      <div className="canvas-lanes">
        {graph.lanes.map((l) => (
          <label key={l.id} className="seg">
            <input type="checkbox" checked={!hidden(l.id)} onChange={() => toggleLane(l.id)} />
            {l.title}
          </label>
        ))}
      </div>

      <div className="ufc-stage" ref={stageRef}>
        <div className="ufc-world" ref={worldRef} style={{ width: layout.worldW, height: layout.worldH }}>
          {layout.laneBoxes.map((b) => (
            <div
              key={b.lane.id}
              className={`ufc-lane ${hidden(b.lane.id) ? 'ufc-hidden' : ''}`}
              style={{ left: b.x, top: b.y, width: b.width, height: b.height }}
            >
              <div className="ufc-lane-title">
                {b.lane.title}
                {b.lane.subtitle && <span>{b.lane.subtitle}</span>}
              </div>
            </div>
          ))}

          <svg className="ufc-wires" width={layout.worldW} height={layout.worldH}>
            <defs>{['primary', 'branch', 'back', 'link'].map(marker)}</defs>
            {edges.map((e) => {
              const off = hidden(layout.positions.get(e.from)?.lane ?? '') || hidden(layout.positions.get(e.to)?.lane ?? '')
              return (
                <path
                  key={e.id}
                  className={`ufc-edge ${e.type} ${off ? 'ufc-hidden' : ''}`}
                  d={e.d}
                  markerEnd={`url(#ufc-arrow-${e.type})`}
                />
              )
            })}
          </svg>

          {[...layout.positions.values()].map((p) => {
            const n = p.node
            return (
              <div
                key={n.id}
                className={`ufc-card ${n.kind} ${newNodeIds.includes(n.id) ? 'is-new' : ''} ${hidden(n.lane) ? 'ufc-hidden' : ''}`}
                data-id={n.id}
                data-lane={n.lane}
                style={{ left: p.x, top: p.y, width: CARD_W }}
              >
                <div className="ufc-head">
                  <div className="ufc-row">
                    <span className="ufc-num">{layout.seqNo.get(n.id)}</span>
                    <span className="ufc-tag">{KIND_LABEL[n.kind] ?? n.kind}</span>
                  </div>
                  <div className="ufc-title">{n.title}</div>
                  {n.subtitle && <div className="ufc-sub">{n.subtitle}</div>}
                  {n.note && <div className="ufc-note">{n.note}</div>}
                </div>
                <div className="ufc-shot" style={{ height: layout.imgH }}>
                  <img src={`ufc://screens/${projectId}/${n.shot}.thumb.jpg`} alt={n.title} loading="lazy" />
                </div>
              </div>
            )
          })}

          {labelsOn &&
            edges.map((e) => {
              const off = hidden(layout.positions.get(e.from)?.lane ?? '') || hidden(layout.positions.get(e.to)?.lane ?? '')
              return (
                <div
                  key={`l-${e.id}`}
                  className={`ufc-label ${e.type} ${off ? 'ufc-hidden' : ''}`}
                  data-anchor={e.anchor}
                  style={{ left: e.lx, top: e.ly }}
                >
                  {e.label}
                </div>
              )
            })}
        </div>
      </div>

      {layout.positions.size === 0 && (
        <div className="canvas-empty">还没有界面。启动探索后，每发现一屏就会实时出现在这里。</div>
      )}
    </div>
  )
}
