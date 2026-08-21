import type { FlowNode, GraphPatch } from '@shared/types'
import {
  sanitizeEdgeRelabels,
  sanitizeLaneAssignments,
  sanitizeMergeDecisions,
  sanitizeScreenNames,
} from '../ai/parseReview'
import {
  buildLaneClassifyTask,
  buildMergeScreensTask,
  buildNameScreensTask,
  buildRelabelEdgesTask,
  type MergeCandidatePair,
} from '../ai/reviewPrompt'
import type { IAiClient, ReviewTask } from '../ai/types'
import { finalizeGraph, type AiVerdict } from './finalize'
import { inheritLanes } from './graphCleanup'
import type { GraphStore } from './graphStore'
import { laneOfUrl } from './naming'

/**
 * 图谱生成阶段。
 *
 * 探索期只产出结构层（签名去重的界面、连接关系、机械标注），这里批量补齐语义：
 * 界面命名、泳道划分、标注语义化、同界面合并——四类互相独立的问询，
 * 任何一类失败都按确定性规则回落，已有结果不受影响。输入始终是当前图谱，
 * 输出覆盖语义层，因此可以随时重跑；人工修正过的字段（pinned）一律跳过。
 */

const NAME_BATCH = 10
const RELABEL_MAX = 40
const MERGE_MAX_PAIRS = 20
/** 全局泳道划分允许的新泳道数，比接管归位的上限宽 */
const GLOBAL_MAX_NEW_LANES = 6

export interface RefineOptions {
  /** 跳过全部模型问询，只做确定性整理（停止与崩溃路径） */
  skipAi?: boolean
  /**
   * 只处理这些节点：接管段的局部生成。命名与泳道候选限定于此，
   * 合并与标注语义化跳过（那是全局问题，留给收尾的全局生成）。
   */
  scope?: string[]
  /** 每次问询前创建新的中断信号 */
  signalOf?: () => AbortSignal
  /** 用户是否已要求停止；true 时放弃剩余问询 */
  shouldStop?: () => boolean
  /** 是否还允许发起问询（预算控制） */
  canCall?: () => boolean
  /** 每次真正发出问询时回调，调用方计入 aiCalls */
  onAiCall?: () => void
  onLog?: (level: 'info' | 'warn', message: string) => void
}

export interface RefineStats {
  named: number
  laned: number
  relabeled: number
  mergedNodes: number
  mergedEdges: number
  droppedEdges: number
  prunedLanes: number
  /** 因人工修正而跳过自动生成的字段数 */
  pinnedKept: number
  /** 各类问询里被约束校验剔除的条数 */
  rejected: number
}

export interface RefineResult {
  stats: RefineStats
  patch: Omit<GraphPatch, 'projectId'>
}

/** 同界面合并的候选键：地址去掉易变的查询参数与 hash */
function urlKeyOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

export async function refineGraph(store: GraphStore, ai: IAiClient, opts: RefineOptions = {}): Promise<RefineResult> {
  const stats: RefineStats = {
    named: 0,
    laned: 0,
    relabeled: 0,
    mergedNodes: 0,
    mergedEdges: 0,
    droppedEdges: 0,
    prunedLanes: 0,
    pinnedKept: 0,
    rejected: 0,
  }

  const ask = async <T>(task: ReviewTask<T>, what: string): Promise<T | null> => {
    if (opts.skipAi || opts.shouldStop?.()) return null
    if (opts.canCall && !opts.canCall()) return null
    opts.onAiCall?.()
    try {
      return await ai.review(task, opts.signalOf?.())
    } catch (e) {
      opts.onLog?.('warn', `${what}未完成：${e instanceof Error ? e.message : String(e)}，已按确定性规则回落`)
      return null
    }
  }

  stats.pinnedKept = store
    .get()
    .nodes.reduce((n, x) => n + (x.pinned?.length ?? 0), 0) +
    store.get().edges.reduce((n, x) => n + (x.pinned?.length ?? 0), 0)

  const inScope = (id: string): boolean => !opts.scope || opts.scope.includes(id)

  /* ---------- 一、界面命名。draft 且标题未被人工锁定的节点，分批 ---------- */
  {
    const graph = store.get()
    const targets = graph.nodes.filter((n) => n.draft && !n.pinned?.includes('title') && inScope(n.id)).map((n) => n.id)
    for (let i = 0; i < targets.length; i += NAME_BATCH) {
      const batch = targets.slice(i, i + NAME_BATCH)
      const out = await ask(buildNameScreensTask(graph, batch), '界面命名')
      if (!out) continue
      const s = sanitizeScreenNames(out.names, batch)
      stats.rejected += s.rejected
      for (const [id, v] of s.names) {
        const node = graph.nodes.find((n) => n.id === id)
        if (!node) continue
        const patch: Partial<FlowNode> = { title: v.title, draft: undefined }
        if (v.kind && !node.pinned?.includes('kind')) patch.kind = v.kind
        store.updateNode(id, patch)
        stats.named += 1
      }
    }
  }

  /* ---------- 二、同界面合并。同地址、不同签名的相邻对，逐对判定 ---------- */
  const removedNodeIds: string[] = []
  if (!opts.scope) {
    const graph = store.get()
    const byUrl = new Map<string, FlowNode[]>()
    for (const n of graph.nodes) {
      const key = urlKeyOf(n.url)
      byUrl.set(key, [...(byUrl.get(key) ?? []), n])
    }
    const pairs: MergeCandidatePair[] = []
    for (const list of byUrl.values()) {
      if (list.length < 2) continue
      const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      for (let i = 0; i + 1 < sorted.length && pairs.length < MERGE_MAX_PAIRS; i++) {
        const a = sorted[i]
        const b = sorted[i + 1]
        // 人工修正过的界面不参与自动合并——错误合并比冗余更难恢复
        if (a.pinned?.length || b.pinned?.length) continue
        // 保留先建的（编号小的），语义标注它更可能已经有
        pairs.push({ id: `p${pairs.length + 1}`, keepId: a.id, loserId: b.id })
      }
    }
    if (pairs.length) {
      const out = await ask(buildMergeScreensTask(graph, pairs), '同界面合并')
      if (out) {
        const s = sanitizeMergeDecisions(out.pairs, pairs.map((p) => p.id))
        stats.rejected += s.rejected
        for (const p of pairs) {
          if (!s.merge.has(p.id)) continue
          // 前一对合并可能已把本对的一端并掉，跳过即可，下次重生成继续收敛
          if (store.mergeNodes(p.keepId, p.loserId)) {
            removedNodeIds.push(p.loserId)
            stats.mergedNodes += 1
          }
        }
      }
    }
  }

  /* ---------- 三、泳道划分。全部未锁定泳道的节点，全局一次 ---------- */
  const verdict: AiVerdict = {}
  {
    const graph = store.get()
    const candidates = graph.nodes.filter((n) => !n.pinned?.includes('lane') && inScope(n.id)).map((n) => n.id)
    if (candidates.length) {
      // 回落值：人工接管节点沿连线继承，其余按机械泳道保持现状
      const inherited = inheritLanes(graph)
      const fallback = new Map<string, string>()
      for (const n of graph.nodes) fallback.set(n.id, inherited.get(n.id) ?? (n.lane || laneOfUrl(n.url).id))
      const known = new Set(graph.lanes.map((l) => l.id))
      const out = await ask(buildLaneClassifyTask(graph, candidates, fallback), '泳道划分')
      if (out) {
        const s = sanitizeLaneAssignments(out.assignments, candidates, fallback, known, GLOBAL_MAX_NEW_LANES)
        stats.rejected += s.rejected
        verdict.lanes = s.lanes
        verdict.laneTitles = s.titles
      } else {
        // 问询失败也要把人工接管节点归位，不能让它们留在临时泳道
        verdict.lanes = fallback
      }
    }
  }

  /* ---------- 四、标注语义化。未锁定标注的连线，上限之内一批 ---------- */
  if (!opts.scope) {
    const graph = store.get()
    const targets = graph.edges
      .filter((e) => !e.pinned?.includes('label'))
      .slice(0, RELABEL_MAX)
      .map((e) => e.id)
    if (targets.length) {
      const out = await ask(buildRelabelEdgesTask(graph, targets), '标注语义化')
      if (out) {
        const s = sanitizeEdgeRelabels(out.labels, targets)
        stats.rejected += s.rejected
        verdict.relabel = s.relabel
        stats.relabeled = s.relabel.size
      }
    }
  }

  /* ---------- 五、确定性收尾：清边、泳道落地、回收空泳道、重排、落盘 ---------- */
  const fin = finalizeGraph(store, verdict)
  stats.laned = fin.moved
  stats.mergedEdges = fin.merged
  stats.droppedEdges = fin.dropped
  stats.prunedLanes = fin.prunedLanes.length

  const after = store.get()
  const patch: Omit<GraphPatch, 'projectId'> = {
    // 命名、合并、泳道、重排都动过节点与连线，整份下发，增量发容易漏
    updatedNodes: after.nodes.map((n) => ({ ...n })),
    updatedEdges: after.edges.map((e) => ({ ...e })),
    removedNodeIds: removedNodeIds.length ? removedNodeIds : undefined,
    removedEdgeIds: fin.patch.removedEdgeIds,
    removedLaneIds: fin.patch.removedLaneIds,
    meta: after.meta,
  }

  return { stats, patch }
}

/** 生成结果摘要，写进日志给用户看 */
export function describeRefine(r: RefineResult): string {
  const s = r.stats
  const parts: string[] = []
  if (s.named) parts.push(`命名界面 ${s.named} 个`)
  if (s.laned) parts.push(`归位泳道 ${s.laned} 处`)
  if (s.relabeled) parts.push(`语义化标注 ${s.relabeled} 条`)
  if (s.mergedNodes) parts.push(`合并同界面 ${s.mergedNodes} 组`)
  if (s.mergedEdges) parts.push(`合并重复连线 ${s.mergedEdges} 条`)
  if (s.droppedEdges) parts.push(`清除无效连线 ${s.droppedEdges} 条`)
  if (s.prunedLanes) parts.push(`回收空泳道 ${s.prunedLanes} 条`)
  if (s.pinnedKept) parts.push(`人工修正保留 ${s.pinnedKept} 处`)
  return parts.length ? `图谱生成完成：${parts.join('，')}` : '图谱生成完成：无需调整'
}
