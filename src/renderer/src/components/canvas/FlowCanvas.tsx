import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { deoverlapLabels } from '@shared/canvas-core/deoverlap'
import { CARD_W, computeLayout } from '@shared/canvas-core/layout'
import { routeEdges } from '@shared/canvas-core/routing'
import { CANVAS_CSS } from '@shared/canvas-core/styles'
import { CH } from '@shared/ipc-contract'
import type { FlowGraph, GraphPatch } from '@shared/types'
import { useDialog } from '../Dialog'
import { invoke } from '../../ipc'
import EditPanel, { type Selection } from './EditPanel'
import { usePanZoom } from './usePanZoom'
import './canvas.css'

const KIND_LABEL: Record<string, string> = { normal: '正常态', validation: '校验态', manual: '人工录制' }

interface Props {
  graph: FlowGraph
  projectId: string
  device?: { width: number; height: number }
  /** 探索过程中新出现的节点，用于入场动画与自动跟随 */
  newNodeIds?: string[]
  /** 会话结束后可修订：选中卡片与标注进行编辑 */
  editable?: boolean
  /** 修订产生的补丁交给上层合并进图谱 */
  onPatch?: (patch: GraphPatch) => void
}

export default function FlowCanvas({ graph, projectId, device, newNodeIds = [], editable = false, onPatch }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [labelsOn, setLabelsOn] = useState(true)
  const [follow, setFollow] = useState(true)
  const [hiddenLanes, setHiddenLanes] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Selection | null>(null)
  const [renamingLane, setRenamingLane] = useState<{ id: string; title: string } | null>(null)
  /** 连线模式：已选定起点，等待点击目标界面 */
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const dialog = useDialog()
  const inited = useRef(false)

  // 会话重新开跑（不可编辑）时清掉选中态
  useEffect(() => {
    if (!editable) {
      setSelected(null)
      setRenamingLane(null)
      setLinkFrom(null)
    }
  }, [editable])

  // Esc 退出连线模式
  useEffect(() => {
    if (!linkFrom) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLinkFrom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [linkFrom])

  async function completeLink(toId: string): Promise<void> {
    const fromId = linkFrom!
    setLinkFrom(null)
    if (toId === fromId) return
    try {
      const patch = await invoke(CH.graphAddEdge, { projectId, from: fromId, to: toId })
      onPatch?.(patch)
      // 建完直接选中新连线，紧接着就能改标注与类型
      const created = patch.addedEdges?.[0]
      if (created) setSelected({ kind: 'edge', id: created.id })
    } catch (e) {
      await dialog.alert({ title: '新建连线失败', message: e instanceof Error ? e.message : String(e) })
    }
  }

  async function renameLane(): Promise<void> {
    const target = renamingLane
    setRenamingLane(null)
    if (!target) return
    const current = graph.lanes.find((l) => l.id === target.id)
    const title = target.title.trim()
    if (!current || !title || title === current.title) return
    try {
      onPatch?.(await invoke(CH.graphUpdateLane, { projectId, id: target.id, title }))
    } catch {
      // 会话状态变化等失败场景：保持原名即可，无需打断
    }
  }

  const layout = useMemo(() => computeLayout(graph, device), [graph, device])
  const edges = useMemo(() => routeEdges(graph.edges, layout), [graph.edges, layout])
  const isEmpty = layout.positions.size === 0
  const { zoom, zoomAt, fit, fitWidth, reset, focusNode } = usePanZoom(stageRef, worldRef, {
    // 平移手势会吃掉原生 click，点选由手势层在「按下抬起无位移」时合成
    onTap: (target, ev) => {
      if (!editable) return
      const card = target.closest('.ufc-card') as HTMLElement | null
      if (card?.dataset.id) {
        const id = card.dataset.id
        // 连线模式下点卡片就是选目标
        if (linkFrom) {
          void completeLink(id)
          return
        }
        // Ctrl / Cmd 追加或移出多选（仅界面卡片）
        const multi = ev.ctrlKey || ev.metaKey
        setSelected((prev) => {
          if (multi && prev?.kind === 'node') {
            const ids = prev.ids.includes(id) ? prev.ids.filter((x) => x !== id) : [...prev.ids, id]
            return ids.length ? { kind: 'node', ids } : null
          }
          return { kind: 'node', ids: [id] }
        })
        return
      }
      const label = target.closest('.ufc-label') as HTMLElement | null
      if (label?.dataset.id) {
        const id = label.dataset.id
        setSelected({ kind: 'edge', id })
        return
      }
      setSelected(null)
    },
  })

  // 版面变化后立刻做一次去重叠；用真实渲染矩形判定，所以必须在布局阶段跑。
  // 泳道显隐也要重跑：可见标注的集合变了，而 layout/edges 的引用没变，
  // 不加这条依赖的话，重新显示出来的标注从没参与过碰撞判定
  useLayoutEffect(() => {
    deoverlapLabels()
  }, [layout, edges, labelsOn, hiddenLanes])

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
    <div className={`canvas-root${editable ? ' editable' : ''}`}>
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

      {/* 没有泳道时这一整条是空的，别留一条空白占位 */}
      {graph.lanes.length > 0 && (
        <div className="canvas-lanes">
          {graph.lanes.map((l) =>
            renamingLane?.id === l.id ? (
              <input
                key={l.id}
                className="lane-rename"
                autoFocus
                value={renamingLane.title}
                maxLength={40}
                onChange={(e) => setRenamingLane({ id: l.id, title: e.target.value })}
                onBlur={() => void renameLane()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void renameLane()
                  if (e.key === 'Escape') setRenamingLane(null)
                }}
              />
            ) : (
              <label
                key={l.id}
                className="seg"
                // 会话结束后双击泳道名进入重命名
                onDoubleClick={() => editable && setRenamingLane({ id: l.id, title: l.title })}
                title={editable ? '双击重命名' : undefined}
              >
                <input type="checkbox" checked={!hidden(l.id)} onChange={() => toggleLane(l.id)} />
                {l.title}
              </label>
            )
          )}
        </div>
      )}

      <div className="ufc-stage" ref={stageRef}>
        <div className="ufc-world" ref={worldRef} style={{ width: layout.worldW, height: layout.worldH }}>
          {/* 图谱为空时不画泳道框，否则会出现一个空的灰色方块 */}
          {isEmpty ? null : layout.laneBoxes.map((b) => (
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
                className={`ufc-card ${n.kind} ${newNodeIds.includes(n.id) ? 'is-new' : ''} ${hidden(n.lane) ? 'ufc-hidden' : ''} ${
                  selected?.kind === 'node' && selected.ids.includes(n.id) ? 'is-selected' : ''
                } ${linkFrom === n.id ? 'is-link-source' : ''}`}
                data-id={n.id}
                data-lane={n.lane}
                style={{ left: p.x, top: p.y, width: CARD_W }}
              >
                <div className="ufc-head">
                  <div className="ufc-row">
                    <span className="ufc-num">{layout.seqNo.get(n.id)}</span>
                    <span className="ufc-tag">{KIND_LABEL[n.kind] ?? n.kind}</span>
                    {n.draft && <span className="ufc-tag">未整理</span>}
                  </div>
                  <div className="ufc-title">{n.title}</div>
                  {n.subtitle && <div className="ufc-sub">{n.subtitle}</div>}
                  {n.note && <div className="ufc-note">{n.note}</div>}
                </div>
                <div className="ufc-shot" style={{ height: layout.imgH }}>
                  {/* ts 作版本参数：重访已知界面会用新图顶掉半加载的首图，URL 不变的话浏览器不会重新取 */}
                  <img
                    src={`ufc://screens/${projectId}/${n.shot}.thumb.jpg?t=${encodeURIComponent(n.ts)}`}
                    alt={n.title}
                    loading="lazy"
                  />
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
                  className={`ufc-label ${e.type} ${off ? 'ufc-hidden' : ''} ${
                    selected?.kind === 'edge' && selected.id === e.id ? 'is-selected' : ''
                  }`}
                  data-anchor={e.anchor}
                  data-id={e.id}
                  // 标注宽度封顶到 300px，超出部分省略，完整文本靠 title 补上
                  title={e.label}
                  style={{ left: e.lx, top: e.ly }}
                >
                  {e.label}
                </div>
              )
            })}
        </div>
      </div>

      {isEmpty && <div className="canvas-empty">还没有界面。启动探索后，每发现一屏就会实时出现在这里。</div>}

      {linkFrom && <div className="link-hint">正在新建连线：点击目标界面完成，Esc 取消</div>}

      {editable && selected && onPatch && !linkFrom && (
        <EditPanel
          projectId={projectId}
          graph={graph}
          selected={selected}
          onPatch={onPatch}
          onStartLink={(id) => {
            setLinkFrom(id)
            setSelected(null)
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
