import { MANUAL_LANE_ID, type FlowNode, type GraphPatch } from '@shared/types'
import { inheritLanes, planCleanup, type CleanupPlan } from './graphCleanup'
import type { GraphStore } from './graphStore'

export interface FinalizeResult {
  /** 丢弃的悬挂边与非法自环 */
  dropped: number
  /** 合并掉的重复连线 */
  merged: number
  /** 归位的人工接管节点 */
  moved: number
  /** 回收的空泳道 */
  prunedLanes: string[]
  /** 清理计划。其中的候选组供 AI 审阅 */
  plan: CleanupPlan
  patch: Omit<GraphPatch, 'projectId'>
}

/**
 * 探索收尾整理：确定性那一层。
 *
 * 只做三件不需要判断力的事——清掉悬挂边与非法自环、把重复连线收敛成一条、
 * 把人工接管期的节点按上下游继承到真实泳道。AI 那一层（归类与审边）叠在这之上，
 * 不可用时这里的结果照样成立。
 *
 * 顺序不可调换：写泳道 → 回收空泳道 → 重排 → 落盘。空泳道会占一整行卡片高度，
 * 必须在重排之前清掉；而改了泳道不重排，两张卡片会精确落在同一格上互相重叠。
 */
export interface AiVerdict {
  /** AI 归类的结果，已经过白名单裁剪 */
  lanes?: Map<string, string>
  /** 新泳道的中文名 */
  laneTitles?: Map<string, string>
  /** AI 判定可以删掉的重复连线 */
  dropEdgeIds?: string[]
  /** AI 改写的标注 */
  relabel?: Map<string, string>
}

export function finalizeGraph(store: GraphStore, ai?: AiVerdict): FinalizeResult {
  const graph = store.get()
  const laneOverrides = ai?.lanes

  /* A1 + A2：清边 */
  const plan = planCleanup(graph)
  const mergedIds = plan.merges.flatMap((m) => m.mergedIds)
  for (const m of plan.merges) store.updateEdge(m.keep.id, { label: m.keep.label, type: m.keep.type })
  // AI 只能在候选组里挑，挑剩的一并删掉；改写的标注也在这里落地
  for (const [id, label] of ai?.relabel ?? []) store.updateEdge(id, { label })
  const removedEdgeIds = store.removeEdges([...plan.dropIds, ...mergedIds, ...(ai?.dropEdgeIds ?? [])])

  /* A3：人工接管节点归位。调用方给了 AI 的结论就用它，没给就用继承值 */
  const inherited = inheritLanes(graph)
  const lanes = laneOverrides ?? inherited
  let moved = 0
  for (const [nodeId, lane] of lanes) {
    const node = graph.nodes.find((n) => n.id === nodeId)
    if (!node || node.lane === lane) continue
    // 目标泳道可能还不存在（AI 新建的）
    store.ensureLane(lane, ai?.laneTitles?.get(lane) ?? lane)
    store.updateNode(nodeId, { lane })
    moved += 1
  }

  /* C：回收 → 重排 → 落盘 */
  const prunedLanes = store.pruneEmptyLanes()
  store.relayout()

  const after = store.get()
  const patch: Omit<GraphPatch, 'projectId'> = {
    // 重排改写了全部坐标，增量发容易漏，直接整份下发
    updatedNodes: after.nodes.map((n) => ({ ...n }) as FlowNode),
    updatedEdges: plan.merges.map((m) => after.edges.find((e) => e.id === m.keep.id)).filter(Boolean) as never,
    removedEdgeIds,
    removedLaneIds: prunedLanes,
    meta: after.meta,
  }

  return { dropped: plan.dropIds.length, merged: mergedIds.length, moved, prunedLanes, plan, patch }
}

/** 还有没有节点留在人工接管泳道里。用于判断要不要发起 AI 归类 */
export function manualNodeIds(store: GraphStore): string[] {
  return store
    .get()
    .nodes.filter((n) => n.lane === MANUAL_LANE_ID)
    .map((n) => n.id)
}

/** 收尾整理的结果摘要，写进日志给用户看 */
export function describeFinalize(r: FinalizeResult): string {
  const parts: string[] = []
  if (r.merged) parts.push(`合并重复连线 ${r.merged} 条`)
  if (r.dropped) parts.push(`清除无效连线 ${r.dropped} 条`)
  if (r.moved) parts.push(`人工接管界面归位 ${r.moved} 个`)
  if (r.prunedLanes.length) parts.push(`回收空泳道 ${r.prunedLanes.length} 条`)
  return parts.length ? `已整理图谱：${parts.join('，')}` : '图谱无需整理'
}
