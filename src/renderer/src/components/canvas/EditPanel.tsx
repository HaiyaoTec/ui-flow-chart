import { useEffect, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import type { EdgeType, FlowGraph, GraphPatch, NodeKind } from '@shared/types'
import { useDialog } from '../Dialog'
import { invoke } from '../../ipc'

/** 新建泳道在下拉里的哨兵值 */
const NEW_LANE = '__new__'

const KIND_OPTIONS: Array<{ value: NodeKind; label: string }> = [
  { value: 'normal', label: '正常态' },
  { value: 'validation', label: '校验态' },
]

const EDGE_TYPE_OPTIONS: Array<{ value: EdgeType; label: string }> = [
  { value: 'primary', label: '主干' },
  { value: 'branch', label: '分支' },
  { value: 'back', label: '返回' },
  { value: 'link', label: '关联' },
]

/** 画布上的选中态：界面卡片支持多选（Ctrl/Cmd 追加），连线单选 */
export type Selection = { kind: 'node'; ids: string[] } | { kind: 'edge'; id: string }

interface Props {
  projectId: string
  graph: FlowGraph
  selected: Selection
  onPatch: (patch: GraphPatch) => void
  /** 以某个界面为起点进入连线模式 */
  onStartLink: (fromId: string) => void
  onClose: () => void
}

/**
 * 图谱修订面板。选中界面卡片或连线标注后出现，改动即存：
 * 每次保存走主进程的编辑通道，被改过的字段记入 pinned，重新生成图谱不覆盖。
 * 多选（≥2 个界面）时变成合并面板。
 */
export default function EditPanel({ projectId, graph, selected, onPatch, onStartLink, onClose }: Props) {
  const dialog = useDialog()
  const nodeIds = selected.kind === 'node' ? selected.ids : []
  const node = nodeIds.length === 1 ? graph.nodes.find((n) => n.id === nodeIds[0]) : undefined
  const multi = nodeIds.length > 1 ? nodeIds.map((id) => graph.nodes.find((n) => n.id === id)).filter((n) => !!n) : []
  const edge = selected.kind === 'edge' ? graph.edges.find((e) => e.id === selected.id) : undefined
  const [keepId, setKeepId] = useState('')

  const [title, setTitle] = useState('')
  const [lane, setLane] = useState('')
  const [newLaneTitle, setNewLaneTitle] = useState('')
  const [kind, setKind] = useState<NodeKind>('normal')
  const [label, setLabel] = useState('')
  const [edgeType, setEdgeType] = useState<EdgeType>('primary')
  const [busy, setBusy] = useState(false)

  // 切换选中对象时重置表单为对象当前值
  useEffect(() => {
    if (node) {
      setTitle(node.title)
      setLane(node.lane)
      setKind(node.kind === 'validation' ? 'validation' : 'normal')
      setNewLaneTitle('')
    }
    if (edge) {
      setLabel(edge.label)
      setEdgeType(edge.type)
    }
    if (multi.length) setKeepId((prev) => (nodeIds.includes(prev) ? prev : nodeIds[0]))
    // 依赖用序列化的选中标识：ids 数组每次渲染都是新引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.kind, nodeIds.join(','), selected.kind === 'edge' ? selected.id : '', node, edge])

  if (!node && !edge && !multi.length) return null

  async function run(fn: () => Promise<GraphPatch>): Promise<void> {
    setBusy(true)
    try {
      onPatch(await fn())
    } catch (e) {
      await dialog.alert({ title: '修改失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function saveNode(): Promise<void> {
    const laneId = lane === NEW_LANE ? newLaneTitle.trim() : lane
    if (!title.trim() || !laneId) return
    await run(() =>
      invoke(CH.graphUpdateNode, {
        projectId,
        id: node!.id,
        patch: {
          title: title.trim(),
          lane:
            lane === NEW_LANE
              ? newLaneTitle
                  .trim()
                  .toLowerCase()
                  .replace(/[^a-z0-9一-龥-]+/g, '-')
                  .replace(/^-+|-+$/g, '') || 'lane'
              : lane,
          laneTitle: lane === NEW_LANE ? newLaneTitle.trim() : undefined,
          kind,
        },
      })
    )
  }

  async function deleteNode(): Promise<void> {
    const ok = await dialog.confirm({
      title: '删除界面',
      message: `删除「${node!.title}」及其全部连线。这个界面即使再次被探索到也不会重新出现，确定删除？`,
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    await run(() => invoke(CH.graphDeleteNode, { projectId, id: node!.id }))
    onClose()
  }

  async function mergeSelected(): Promise<void> {
    const keeper = graph.nodes.find((n) => n.id === keepId)
    if (!keeper) return
    const ok = await dialog.confirm({
      title: '合并界面',
      message: `把选中的 ${nodeIds.length} 个界面合并为「${keeper.title}」，其余界面的连线并入它。可撤销。`,
      confirmText: '合并',
    })
    if (!ok) return
    await run(() =>
      invoke(CH.graphMergeNodes, { projectId, keepId, mergeIds: nodeIds.filter((id) => id !== keepId) })
    )
    onClose()
  }

  async function saveEdge(): Promise<void> {
    if (!label.trim()) return
    await run(() => invoke(CH.graphUpdateEdge, { projectId, id: edge!.id, patch: { label: label.trim(), type: edgeType } }))
  }

  async function deleteEdge(): Promise<void> {
    const ok = await dialog.confirm({
      title: '删除连线',
      message: `删除「${edge!.label}」这条连线？`,
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    await run(() => invoke(CH.graphDeleteEdge, { projectId, id: edge!.id }))
    onClose()
  }

  return (
    <div className="ufc-editpanel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ufc-editpanel-head">
        <strong>{multi.length ? `合并 ${multi.length} 个界面` : node ? '修订界面' : '修订连线'}</strong>
        <button className="ufc-editpanel-close" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      {multi.length > 0 && (
        <>
          <span className="muted" style={{ fontSize: 12 }}>
            Ctrl/Cmd 点选可继续增减。合并后其余界面的连线并入保留的界面，被并界面不再出现。
          </span>
          <label>
            保留的界面
            <select value={keepId} onChange={(e) => setKeepId(e.target.value)}>
              {multi.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
          <div className="ufc-editpanel-actions">
            <span className="grow" />
            <button className="primary" disabled={busy || !keepId} onClick={() => void mergeSelected()}>
              合并
            </button>
          </div>
        </>
      )}

      {node && (
        <>
          <label>
            名称
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          </label>
          <label>
            泳道
            <select value={lane} onChange={(e) => setLane(e.target.value)}>
              {graph.lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
              <option value={NEW_LANE}>新建泳道…</option>
            </select>
          </label>
          {lane === NEW_LANE && (
            <label>
              新泳道名称
              <input value={newLaneTitle} onChange={(e) => setNewLaneTitle(e.target.value)} maxLength={40} />
            </label>
          )}
          <label>
            性质
            <select value={kind} onChange={(e) => setKind(e.target.value as NodeKind)}>
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => onStartLink(node.id)} title="以本界面为起点，点击目标界面建立连线">
            从此界面新建连线
          </button>
          <div className="ufc-editpanel-actions">
            <button className="danger" disabled={busy} onClick={() => void deleteNode()}>
              删除
            </button>
            <span className="grow" />
            <button className="primary" disabled={busy || !title.trim()} onClick={() => void saveNode()}>
              保存
            </button>
          </div>
        </>
      )}

      {edge && (
        <>
          <label>
            标注
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
          </label>
          <label>
            类型
            <select value={edgeType} onChange={(e) => setEdgeType(e.target.value as EdgeType)}>
              {EDGE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="ufc-editpanel-actions">
            <button className="danger" disabled={busy} onClick={() => void deleteEdge()}>
              删除
            </button>
            <span className="grow" />
            <button className="primary" disabled={busy || !label.trim()} onClick={() => void saveEdge()}>
              保存
            </button>
          </div>
        </>
      )}
    </div>
  )
}
