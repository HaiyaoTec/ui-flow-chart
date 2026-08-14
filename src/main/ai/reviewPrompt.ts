import { MANUAL_LANE_ID, type FlowGraph, type FlowLane, type FlowNode } from '@shared/types'
import type { EdgeCandidateGroup } from '../engine/graphCleanup'
import {
  EDGE_REVIEW_SCHEMA,
  LANE_CLASSIFY_SCHEMA,
  parseEdgeReview,
  parseEdgeReviewObject,
  parseLaneClassify,
  parseLaneClassifyObject,
  type GroupDecision,
  type LaneAssignment,
} from './parseReview'
import type { ReviewTask } from './types'

/*
 * 收尾整理的两个问询。
 *
 * 都走纯文本：分类要用的信息（标题、地址、校验提示、操作串）本来就是结构化文字，
 * 比截图更好使；几十张图的 token 与超时也不可控，而且视觉通路不可用的配置同样要能跑。
 *
 * 上限都写死在这里：模型的上下文有限，宁可少问一些、把没问到的交给确定性回落，
 * 也不要发一个会被截断的请求——截断的 JSON 解析必然失败，等于白花一次调用。
 */

const MAX_CLASSIFY_NODES = 60
const MAX_REFERENCE_PER_LANE = 4
const MAX_ELEMENTS_PER_NODE = 8
const MAX_GROUPS = 40
const MAX_MEMBERS_PER_GROUP = 6
const MAX_TOTAL_CHARS = 24000

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 超长就砍尾，并在末尾说明砍了多少——让日志能看出问询是不是被削过 */
export function capText(text: string, max = MAX_TOTAL_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n（内容过长，已截断 ${text.length - max} 字）`
}

/* ------------------------------ 一、泳道归类 ----------------------------- */

const LANE_SYSTEM = `你是网站交互流程图的整理助手。
用户在自动探索卡住时人工接管操作了一段，这段期间录到的界面暂时放在「人工接管」里，
现在要按它们**实际属于哪个功能域**归入真实泳道。

要求：
- 只做归类，不要修改界面标题，也不要新增或删除界面。
- 优先复用已有泳道。泳道 id 用小写英文与连字符，如 entry / register / login / forgot。
- 每个界面都给出结论；拿不准就把 confidence 填 low，系统会回落到它上游界面所在的泳道。
- 新泳道最多两条，只有确实出现了新的功能域才建。`

function nodeBlock(n: FlowNode, upstream?: { lane: string; title: string }): string {
  const els = (n.probeSummary?.elements ?? []).slice(0, MAX_ELEMENTS_PER_NODE).map((e) => cut(e, 20))
  const notices = n.probeSummary?.notices ?? []
  return [
    `  ${n.id}`,
    `    标题：${cut(n.title, 60)}`,
    `    地址：${cut(n.url, 100)}`,
    n.note ? `    操作：${cut(n.note, 80)}` : '',
    upstream ? `    上游界面：${cut(upstream.title, 40)} [${upstream.lane}]` : '    上游界面：（无）',
    els.length ? `    元素：${els.join(' / ')}` : '',
    notices.length ? `    提示：${notices.map((x) => cut(x, 40)).join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildLaneClassifyTask(
  graph: FlowGraph,
  candidates: string[],
  inherited: Map<string, string>
): ReviewTask<{ assignments: LaneAssignment[] }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const laneTitle = new Map(graph.lanes.map((l: FlowLane) => [l.id, l.title]))

  const laneLines = graph.lanes
    .filter((l) => l.id !== MANUAL_LANE_ID)
    .map((l) => `  ${l.id} — ${l.title}`)

  // 参考样本：每条泳道给几个已归类的界面，让 AI 看得出各泳道装的是什么
  const refs: string[] = []
  for (const lane of graph.lanes) {
    if (lane.id === MANUAL_LANE_ID) continue
    const sample = graph.nodes.filter((n) => n.lane === lane.id).slice(0, MAX_REFERENCE_PER_LANE)
    for (const n of sample) refs.push(`  ${n.id} [${lane.id}] ${cut(n.title, 40)}`)
  }

  const picked = candidates.slice(0, MAX_CLASSIFY_NODES)
  const blocks = picked.map((id) => {
    const n = byId.get(id)!
    const upLane = inherited.get(id)
    const up = upLane ? { lane: upLane, title: laneTitle.get(upLane) ?? upLane } : undefined
    return nodeBlock(n, up)
  })

  const user = capText(
    [
      '## 已有泳道',
      laneLines.length ? laneLines.join('\n') : '  （还没有，请为这些界面建立第一条）',
      '',
      '## 参考：已归类的界面',
      refs.length ? refs.join('\n') : '  （无）',
      '',
      '## 待归类的界面',
      blocks.join('\n'),
      picked.length < candidates.length ? `\n（还有 ${candidates.length - picked.length} 个界面未列出，将按上游泳道归类）` : '',
    ].join('\n')
  )

  return {
    name: 'classify_lanes',
    description: '把人工接管期间录到的界面按实际功能归入泳道',
    system: LANE_SYSTEM,
    user,
    schema: LANE_CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2000,
    // 收尾不该让用户干等，比每步决策的 90 秒短一半
    timeoutMs: 45_000,
    parse: parseLaneClassify,
    parseObject: parseLaneClassifyObject,
  }
}

/* ------------------------------ 二、连线审查 ----------------------------- */

const EDGE_SYSTEM = `你是网站交互流程图的整理助手。
自动探索时同一个操作可能被反复记录，同一对界面之间因此挂了多条含义重复的连线。
现在要在每一组里挑出**真正需要保留**的连线。

要求：
- 只能在组内的连线里选择，不能新增连线，也不能跨组操作。
- 每组至少保留一条。若这几条确实表示不同的操作路径（例如「点击登录」与「点击注册」），就都保留。
- 若几条表达的是同一个操作，只留信息量最大、措辞最规范的那一条。
- 需要时可以给保留下来的第一条换一个更准确的标注，用「动词 + 目标」的写法。`

export function buildEdgeReviewTask(
  graph: FlowGraph,
  groups: EdgeCandidateGroup[]
): ReviewTask<{ groups: GroupDecision[] }> {
  const title = new Map(graph.nodes.map((n) => [n.id, n.title]))
  const picked = groups.slice(0, MAX_GROUPS)

  const blocks = picked.map((g) => {
    const members = g.members.slice(0, MAX_MEMBERS_PER_GROUP)
    const lines = members.map(
      (m) => `    - ${m.edgeId}｜${cut(m.label, 60)}｜类型 ${m.type}｜来源 ${m.createdBy === 'ai' ? '自动' : '人工'}`
    )
    return [
      `  ${g.id}：${cut(title.get(g.from) ?? g.from, 30)} → ${cut(title.get(g.to) ?? g.to, 30)}`,
      ...lines,
    ].join('\n')
  })

  const user = capText(
    [
      '## 待审查的连线组',
      blocks.join('\n'),
      picked.length < groups.length ? `\n（还有 ${groups.length - picked.length} 组未列出，将保留各组的第一条）` : '',
    ].join('\n')
  )

  return {
    name: 'review_edges',
    description: '在每组重复连线里挑出需要保留的',
    system: EDGE_SYSTEM,
    user,
    schema: EDGE_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2000,
    timeoutMs: 45_000,
    parse: parseEdgeReview,
    parseObject: parseEdgeReviewObject,
  }
}
