import { MANUAL_LANE_ID, type FlowEdge, type FlowGraph, type FlowLane, type FlowNode, type ProbeResult } from '@shared/types'
import type { EdgeCandidateGroup } from '../engine/graphCleanup'
import {
  EDGE_REVIEW_SCHEMA,
  LANE_CLASSIFY_SCHEMA,
  MERGE_SCREENS_SCHEMA,
  NAME_SCREENS_SCHEMA,
  PLAN_SCHEMA,
  RELABEL_EDGES_SCHEMA,
  parseEdgeReview,
  parseEdgeReviewObject,
  parseLaneClassify,
  parseLaneClassifyObject,
  parseMergeScreens,
  parseMergeScreensObject,
  parseNameScreens,
  parseNameScreensObject,
  parsePlanEntries,
  parsePlanEntriesObject,
  parseRelabelEdges,
  parseRelabelEdgesObject,
  type EdgeRelabel,
  type GroupDecision,
  type LaneAssignment,
  type MergeDecision,
  type PlanEntryRaw,
  type ScreenName,
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
自动探索期间界面只按地址粗分了泳道，现在要按它们**实际属于哪个功能域**统一划分。

要求：
- 只做归类，不要修改界面标题，也不要新增或删除界面。
- 同一功能域的界面归到一条泳道。泳道 id 用小写英文与连字符，如 entry / register / login / forgot。
- 每个界面都给出结论；拿不准就把 confidence 填 low，系统会按已有归属回落。
- 新泳道给出中文 laneTitle；不要为单个界面单独建泳道。`

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

/* ------------------------------ 〇、探索计划 ----------------------------- */

const PLAN_SYSTEM = `你是网站交互流程探索的规划助手。
基于首屏的可交互元素，列出这次探索值得覆盖的功能入口清单。

要求：
- 每个入口是一个功能域（注册、登录、找回密码、商品浏览），不是同一功能的重复按钮。
- 按业务重要性排序，最多 8 个；探索会按这个顺序逐个覆盖。
- entryText 抄首屏元素的原文文案，供探索时定位入口；只依据清单里真实存在的元素，不要虚构。
- 纯说明性的链接（备案号、语言切换、外部合作方）不列。`

export function buildPlanTask(goal: string, probe: ProbeResult): ReviewTask<{ entries: PlanEntryRaw[] }> {
  const els = probe.elements.slice(0, 40).map((e) => {
    const label = e.text || e.placeholder || e.name || '(无文案)'
    return `  [${e.idx}] <${e.tag}> ${cut(label, 40)}`
  })
  const user = capText(
    ['## 探索目标', goal, '', '## 首屏地址', probe.url, '', '## 首屏可交互元素', ...els].join('\n')
  )
  return {
    name: 'plan_entries',
    description: '基于首屏产出探索计划',
    system: PLAN_SYSTEM,
    user,
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1200,
    timeoutMs: 45_000,
    parse: parsePlanEntries,
    parseObject: parsePlanEntriesObject,
  }
}

/* ------------------------------ 二、界面命名 ----------------------------- */

const NAME_SYSTEM = `你是网站交互流程图的整理助手。
自动探索期间界面标题只是机械取自页面文字，现在要给每个界面一个规范名称。

要求：
- title 用中文规范名词，如「注册表单·初始态」「登录·必填项未填校验」「游戏详情」。禁止口语化与比喻。
- 同类界面的命名格式保持一致；同一界面的不同状态用「·」分隔主体与状态。
- kind：normal 正常态；validation 校验或错误提示态（界面上出现校验、报错、拦截提示时）。
- 只命名清单里的界面，逐个给出结论。`

export function buildNameScreensTask(graph: FlowGraph, candidates: string[]): ReviewTask<{ names: ScreenName[] }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const inbound = new Map<string, FlowEdge>()
  for (const e of graph.edges) if (!inbound.has(e.to)) inbound.set(e.to, e)

  const blocks = candidates.map((id) => {
    const n = byId.get(id)!
    const els = (n.probeSummary?.elements ?? []).slice(0, MAX_ELEMENTS_PER_NODE).map((e) => cut(e, 20))
    const notices = n.probeSummary?.notices ?? []
    const arrive = inbound.get(id)
    return [
      `  ${n.id}`,
      `    页面文字：${cut(n.title, 60)}`,
      `    地址：${cut(n.url, 100)}`,
      arrive ? `    到达方式：${cut(arrive.label, 50)}（来自 ${cut(byId.get(arrive.from)?.title ?? arrive.from, 30)}）` : '',
      els.length ? `    元素：${els.join(' / ')}` : '',
      notices.length ? `    提示：${notices.map((x) => cut(x, 40)).join(' / ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })

  const user = capText(['## 待命名的界面', blocks.join('\n')].join('\n'))

  return {
    name: 'name_screens',
    description: '为探索到的界面给出规范名称与性质',
    system: NAME_SYSTEM,
    user,
    schema: NAME_SCREENS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2000,
    timeoutMs: 45_000,
    parse: parseNameScreens,
    parseObject: parseNameScreensObject,
  }
}

/* ----------------------------- 三、标注语义化 ---------------------------- */

const RELABEL_SYSTEM = `你是网站交互流程图的整理助手。
连线上的操作标注是执行动作时机械生成的（如「点击「Daftar」」），
现在结合两端界面把它们改写成带业务语义的标注。

要求：
- 动词开头，保留界面原文按钮名，如：点击「Daftar」进入注册、提交 → 系统校验失败：手机号格式。
- 到达校验或错误提示界面的连线，标注里写明校验点。
- 机械标注已经够准确的可以不改写，不出现在结果里即可。
- 只改写清单里的连线，不要新增或删除。`

export function buildRelabelEdgesTask(graph: FlowGraph, candidates: string[]): ReviewTask<{ labels: EdgeRelabel[] }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const picked = graph.edges.filter((e) => candidates.includes(e.id))

  const lines = picked.map((e) => {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    return `  ${e.id}｜${cut(from?.title ?? e.from, 26)} → ${cut(to?.title ?? e.to, 26)}｜现标注：${cut(e.label, 40)}${
      to?.probeSummary?.notices?.length ? `｜目标界面提示：${cut(to.probeSummary.notices.join(' / '), 40)}` : ''
    }`
  })

  const user = capText(['## 待改写的连线', ...lines].join('\n'))

  return {
    name: 'relabel_edges',
    description: '把机械生成的连线标注改写成业务语义标注',
    system: RELABEL_SYSTEM,
    user,
    schema: RELABEL_EDGES_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2000,
    timeoutMs: 45_000,
    parse: parseRelabelEdges,
    parseObject: parseRelabelEdgesObject,
  }
}

/* ----------------------------- 四、同界面合并 ---------------------------- */

const MERGE_SYSTEM = `你是网站交互流程图的整理助手。
同一个界面可能因为瞬时差异（弹层开合、轻微内容变化）被记成了两屏，
现在逐对判定候选对是否为同一界面。

要求：
- merge 为 true 表示两屏应合并为一个界面。拿不准一律填 false——错误的合并比冗余更难恢复。
- 标题、元素构成、提示文案基本一致才算同一界面；同一页面的不同表单状态（空表单与报错态）不算。
- 只判定清单里的候选对。`

export interface MergeCandidatePair {
  id: string
  keepId: string
  loserId: string
}

export function buildMergeScreensTask(
  graph: FlowGraph,
  pairs: MergeCandidatePair[]
): ReviewTask<{ pairs: MergeDecision[] }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const block = (id: string): string => {
    const n = byId.get(id)!
    const els = (n.probeSummary?.elements ?? []).slice(0, MAX_ELEMENTS_PER_NODE).map((e) => cut(e, 16))
    return `    ${n.id}：${cut(n.title, 40)}｜${els.join(' / ')}${
      n.probeSummary?.notices?.length ? `｜提示：${cut(n.probeSummary.notices.join(' / '), 40)}` : ''
    }`
  }
  const blocks = pairs.map((p) => [`  ${p.id}（地址相同）：`, block(p.keepId), block(p.loserId)].join('\n'))

  const user = capText(['## 待判定的候选对', blocks.join('\n')].join('\n'))

  return {
    name: 'merge_screens',
    description: '判定同地址的两屏是否为同一界面',
    system: MERGE_SYSTEM,
    user,
    schema: MERGE_SCREENS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1200,
    timeoutMs: 45_000,
    parse: parseMergeScreens,
    parseObject: parseMergeScreensObject,
  }
}

/* ------------------------------ 五、连线审查 ----------------------------- */

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
