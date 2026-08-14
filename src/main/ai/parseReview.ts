import { z } from 'zod'
import { MANUAL_LANE_ID } from '@shared/types'
import { parseObjectWithSchema, parseWithSchema, slugify } from './parseAction'
import type { EdgeCandidateGroup } from '../engine/graphCleanup'

/* ------------------------------- 泳道归类 ------------------------------- */

export const LANE_CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      description: '每个待归类界面一条',
      items: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '待归类界面的 id，必须来自清单' },
          lane: { type: 'string', description: '泳道 id，优先复用已有的' },
          laneTitle: { type: 'string', description: '新建泳道时的中文名称' },
          confidence: { type: 'string', enum: ['high', 'low'], description: '拿不准就填 low' },
        },
        required: ['nodeId', 'lane'],
      },
    },
  },
  required: ['assignments'],
} as const

const laneAssignmentSchema = z.object({
  nodeId: z.string().min(1),
  lane: z.string().min(1).max(40).transform(slugify),
  laneTitle: z.string().max(40).optional(),
  confidence: z.enum(['high', 'low']).default('high'),
})

export const laneClassifySchema = z.object({
  assignments: z.array(laneAssignmentSchema).max(200),
})

export type LaneAssignment = z.infer<typeof laneAssignmentSchema>

/** AI 允许新建几条泳道。放开无限制的话，它会给每个界面都造一条 */
const MAX_NEW_LANES = 2

/**
 * 把 AI 的归类结果裁到安全范围内。
 *
 * 白名单在应用侧强制复检，不指望模型守规矩：只有候选集合里的节点能被移动，
 * 不能移回人工接管泳道，新建泳道有上限，拿不准的一律回落继承值。
 * 没出现在结果里的候选节点也回落——AI 漏答不该让节点留在临时泳道里。
 */
export function sanitizeLaneAssignments(
  raw: LaneAssignment[],
  candidates: string[],
  inherited: Map<string, string>,
  knownLanes: Set<string>
): { lanes: Map<string, string>; titles: Map<string, string>; rejected: number } {
  const allowed = new Set(candidates)
  const lanes = new Map<string, string>()
  const titles = new Map<string, string>()
  let rejected = 0
  let newLanes = 0

  for (const a of raw) {
    // 再规整一次：这一层是闸门，不假设上游一定跑过 schema 的 transform
    const lane = slugify(a.lane ?? '')
    if (!allowed.has(a.nodeId)) {
      rejected += 1
      continue
    }
    if (!lane || lane === MANUAL_LANE_ID || a.confidence === 'low') {
      rejected += 1
      continue
    }
    if (!knownLanes.has(lane)) {
      if (newLanes >= MAX_NEW_LANES) {
        rejected += 1
        continue
      }
      newLanes += 1
      titles.set(lane, a.laneTitle?.trim() || lane)
    }
    lanes.set(a.nodeId, lane)
  }

  // 漏答与被拒的都回落到继承值
  for (const id of candidates) {
    if (lanes.has(id)) continue
    const fallback = inherited.get(id)
    if (fallback) lanes.set(id, fallback)
  }

  return { lanes, titles, rejected }
}

export const parseLaneClassify = (raw: string) => parseWithSchema(raw, laneClassifySchema, '泳道归类')
export const parseLaneClassifyObject = (obj: unknown) => parseObjectWithSchema(obj, laneClassifySchema, '泳道归类')

/* -------------------------------- 连线审查 ------------------------------- */

export const EDGE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      description: '每一组连线一条。只能在组内选择要保留的，不能新增连线',
      items: {
        type: 'object',
        properties: {
          groupId: { type: 'string', description: '组编号，必须来自清单' },
          keep: {
            type: 'array',
            items: { type: 'string' },
            description: '要保留的连线 id，至少一条，必须来自该组成员',
          },
          label: { type: 'string', description: '可选：给保留下来的第一条连线换一个更准确的标注' },
          reason: { type: 'string' },
        },
        required: ['groupId', 'keep'],
      },
    },
  },
  required: ['groups'],
} as const

const groupDecisionSchema = z.object({
  groupId: z.string().min(1),
  keep: z.array(z.string().min(1)).min(1).max(4),
  label: z.string().max(120).optional(),
  reason: z.string().max(200).optional(),
})

export const edgeReviewSchema = z.object({
  groups: z.array(groupDecisionSchema).max(80),
})

export type GroupDecision = z.infer<typeof groupDecisionSchema>

export interface EdgeReviewOutcome {
  /** 要删掉的连线 id */
  dropIds: string[]
  /** 要改写标注的连线 */
  relabel: Map<string, string>
  rejected: number
}

/**
 * 把 AI 的审边结果裁到安全范围内。
 *
 * 结构上就不给它删坏图的机会：候选组按节点对互斥构造，跨组操作无从谈起；
 * keep 至少一条，所以一对节点之间不会被清空；schema 里没有新增字段，
 * 也没有 type 字段——类型由确定性层定，动作来源比文字判断可靠。
 */
export function sanitizeEdgeReview(raw: GroupDecision[], groups: EdgeCandidateGroup[]): EdgeReviewOutcome {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const dropIds: string[] = []
  const relabel = new Map<string, string>()
  let rejected = 0

  for (const d of raw) {
    const g = byId.get(d.groupId)
    if (!g) {
      rejected += 1
      continue
    }
    const members = new Set(g.members.map((m) => m.edgeId))
    const keep = d.keep.filter((id) => members.has(id))
    if (!keep.length) {
      // 一条都没选中：回落确定性默认（保留 members[0]），不动这一组
      rejected += 1
      continue
    }
    const kept = new Set(keep)
    for (const m of g.members) if (!kept.has(m.edgeId)) dropIds.push(m.edgeId)
    const newLabel = d.label?.trim()
    if (newLabel) relabel.set(keep[0], newLabel)
  }

  return { dropIds, relabel, rejected }
}

export const parseEdgeReview = (raw: string) => parseWithSchema(raw, edgeReviewSchema, '连线审查')
export const parseEdgeReviewObject = (obj: unknown) => parseObjectWithSchema(obj, edgeReviewSchema, '连线审查')
