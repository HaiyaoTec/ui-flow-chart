/**
 * 主进程与渲染进程共用的数据模型。此文件禁止 import electron。
 */

/* ------------------------------- 设备与目标 ------------------------------- */

/** 设备选择菜单的分类 */
export type DeviceCategory = 'iphone' | 'android' | 'pc' | 'tablet'

export interface DeviceSpec {
  id: string
  /** 展示名，如「iPhone 16 Pro」 */
  name: string
  kind: 'mobile' | 'tablet' | 'desktop'
  /** 归到哪个分类下；自定义设备没有，按 kind 归并 */
  category?: DeviceCategory
  /** CSS 像素视口 */
  width: number
  height: number
  deviceScaleFactor: number
  userAgent: string
  /** Sec-CH-UA 用。不带它的话即使改了 UA，客户端提示仍会暴露真实 Chromium */
  userAgentMetadata?: UserAgentMetadata
  hasTouch: boolean
  isMobile: boolean
}

export interface UserAgentMetadata {
  brands: Array<{ brand: string; version: string }>
  fullVersion?: string
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
}

/* --------------------------------- AI 配置 -------------------------------- */

export type AiProtocol = 'openai' | 'anthropic'

export interface AiProfile {
  id: string
  name: string
  protocol: AiProtocol
  /** 形如 https://api.openai.com/v1 或 https://api.anthropic.com */
  baseUrl: string
  model: string
  /** 附加请求头，用于中转网关 */
  extraHeaders?: Record<string, string>
  createdAt: string
  updatedAt: string
}

/** 传给渲染进程的形态：密钥只出掩码 */
export interface AiProfileMasked extends AiProfile {
  keyMasked: string
  hasKey: boolean
}

export interface AiTestResult {
  ok: boolean
  latencyMs: number
  /** 模型回声，验证 key/model 通路 */
  echo?: string
  /** 视觉通路是否可用（发了 1×1 像素图） */
  vision?: boolean
  error?: string
}

/* --------------------------------- 探针结果 ------------------------------- */

/** 可交互元素。idx 是 AI 指定目标的唯一凭据，执行器按同一枚举顺序重查 */
export interface ProbeElement {
  idx: number
  tag: string
  type: string
  text: string
  placeholder: string
  name: string
  /** CSS 像素，相对视口 */
  rect: { x: number; y: number; w: number; h: number }
  disabled: boolean
  checked?: boolean
}

export interface ProbeResult {
  url: string
  title: string
  /** 顶层弹窗存在时，探针范围收敛到弹窗内 */
  hasDialog: boolean
  dialogClass: string
  /** 可见文本摘要，截断 */
  text: string
  elements: ProbeElement[]
  /** 偏红色系的校验/错误文案 */
  notices: string[]
  /** 跨域 iframe 的 host 清单，用于识别验证码/支付等探针盲区 */
  iframeHosts: string[]
  scrollY: number
  scrollHeight: number
  viewportHeight: number
  bodyClass: string
  scrollWidth: number
}

/* ---------------------------------- 图谱 ---------------------------------- */

export type NodeKind = 'normal' | 'validation' | 'manual'
export type EdgeType = 'primary' | 'branch' | 'back' | 'link'

export interface FlowLane {
  id: string
  title: string
  /** 印尼语等原文标题，可选 */
  subtitle?: string
}

export interface FlowNode {
  id: string
  /** 界面签名哈希，节点去重键 */
  signatureHash: string
  /** 合并进来的其他界面签名。命中任何一个都视为本界面，防止合并后的界面被再次建出 */
  aliasSigs?: string[]
  lane: string
  col: number
  sub: number
  kind: NodeKind
  title: string
  subtitle?: string
  note?: string
  url: string
  createdBy: 'ai' | 'human'
  /** screens/ 下的文件名（不含扩展名） */
  shot: string
  probeSummary?: {
    elements: string[]
    notices: string[]
    hasDialog: boolean
  }
  /** 语义未整理：标题与泳道还是探索期的机械占位，等图谱生成阶段补齐 */
  draft?: boolean
  /** 人工修正过的字段名。重新生成图谱时这些字段跳过，不被自动结果覆盖 */
  pinned?: string[]
  ts: string
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  label: string
  type: EdgeType
  createdBy: 'ai' | 'human'
  /** 人工修正过的字段名。重新生成图谱时这些字段跳过 */
  pinned?: string[]
  ts: string
}

export interface FlowGraph {
  version: 1
  meta: {
    targetUrl: string
    deviceId: string
    steps: number
    aiCalls: number
    updatedAt: string
  }
  lanes: FlowLane[]
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** 人工删除的界面签名。再次探索到也不复活 */
  excluded?: string[]
}

export interface GraphPatch {
  /** 补丁归属的项目。会话在后台跑，渲染进程可能正开着别的项目，必须据此过滤 */
  projectId?: string
  addedLanes?: FlowLane[]
  addedNodes?: FlowNode[]
  addedEdges?: FlowEdge[]
  /** 泳道重命名等就地修改 */
  updatedLanes?: FlowLane[]
  updatedNodes?: FlowNode[]
  removedNodeIds?: string[]
  /** 收尾整理：改写连线的标注与类型 */
  updatedEdges?: FlowEdge[]
  /** 收尾整理：合并重复连线后要去掉的那些 */
  removedEdgeIds?: string[]
  /** 收尾整理：回收空泳道。泳道原先只有创建没有删除 */
  removedLaneIds?: string[]
  meta?: FlowGraph['meta']
}

/** 人工接管期的临时泳道。收尾整理会把这批节点归到真实的功能泳道 */
export const MANUAL_LANE_ID = 'manual'
export const MANUAL_LANE_TITLE = '人工接管'

/** 连线标注固定词表，prompt 引导 AI 使用，避免口语化表述 */
export const EDGE_LABEL_VERBS = [
  '点击',
  '输入',
  '选择',
  '提交',
  '系统校验失败',
  '系统提示',
  '自动跳转',
  '关闭返回',
  '修正后重试',
  '滚动',
] as const

/* --------------------------------- 项目 ---------------------------------- */

export interface ProjectMeta {
  id: string
  name: string
  targetUrl: string
  deviceId: string
  customDevice?: DeviceSpec
  aiProfileId: string
  goal: string
  createdAt: string
  updatedAt: string
  /** 最近一次探索的结果快照，供项目列表在没有活动会话时也能显示状态 */
  lastRun?: ProjectRunSummary
}

export interface ProjectRunSummary {
  state: SessionState
  steps: number
  screens: number
  aiCalls: number
  /** 图谱里的节点数，代表这次探索沉淀了多少界面 */
  nodes: number
  startedAt: string
  updatedAt: string
  reason?: string
}

/* ------------------------------- 探索会话 -------------------------------- */

/**
 * 「还在跑」的会话状态。
 *
 * 原先这个常量叫「占着预览」，一个概念混了两件事：谁在跑、谁占着屏幕。
 * 多会话之后两者必须分开——好几个会话可以同时在跑，屏幕却只有一块，
 * 谁在前台由 PreviewHost 说了算。paused 也算在跑：它随时会被恢复。
 */
export const SESSION_ACTIVE: SessionState[] = [
  'launching',
  'observing',
  'thinking',
  'acting',
  'paused',
  'asking',
  'human_queued',
  'awaiting_human',
  'resuming',
  'finishing',
]

/**
 * human_queued 与 awaiting_human 的分界是「有没有拿到屏幕」：
 * 屏幕只有一块，后台会话判定需要人工时先排队（human_queued，不建录制器、不计时长），
 * 用户打开该项目、预览切到前台后才转 awaiting_human 并开始录制。
 */
export type SessionState =
  | 'idle'
  | 'launching'
  | 'observing'
  | 'thinking'
  | 'acting'
  | 'paused'
  /** 等待用户回答结构化提问。不占屏幕、不建录制器，与 awaiting_human 区分 */
  | 'asking'
  | 'human_queued'
  | 'awaiting_human'
  | 'resuming'
  | 'finishing'
  | 'finished'
  | 'failed'

export interface SessionBudgets {
  maxSteps: number
  maxDurationMs: number
  maxAiCalls: number
  maxScreens: number
}

export const DEFAULT_BUDGETS: SessionBudgets = {
  maxSteps: 60,
  maxDurationMs: 20 * 60 * 1000,
  maxAiCalls: 80,
  maxScreens: 300,
}

export interface SessionSnapshot {
  projectId: string | null
  state: SessionState
  step: number
  aiCalls: number
  screens: number
  startedAt: string | null
  budgets: SessionBudgets
  /** 暂停/等待人工的原因 */
  reason?: string
  lastError?: string
  currentNodeId?: string
  /** 本次运行的标识。诊断记录按它切分运行，界面上不展示 */
  runId?: string
  /** 本轮实际在跑的时长，暂停与人工接管期间不计 */
  elapsedMs?: number
  /** asking 状态下待回答的问题，界面据此渲染问题卡片 */
  ask?: AskRequest
  /** 探索计划与各入口的覆盖状态，界面据此渲染计划条 */
  plan?: ExplorePlan
}

export type SessionEvent =
  | { kind: 'state-changed'; from: SessionState; to: SessionState; reason?: string }
  | { kind: 'step-started'; step: number; url: string }
  | { kind: 'ai-request'; step: number }
  | { kind: 'ai-action'; step: number; action: AiAction }
  | { kind: 'action-failed'; step: number; error: string }
  | { kind: 'need-human'; reason: string; hint: string }
  | { kind: 'ask'; ask: AskRequest }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'budget'; snapshot: SessionSnapshot }
  | { kind: 'finished'; snapshot: SessionSnapshot }

/* --------------------------------- AI 动作 ------------------------------- */

export type AiActionKind = 'click' | 'fill' | 'scroll' | 'back' | 'done' | 'need_human' | 'ask'

/**
 * 结构化提问。模型只缺一条信息或一个决定时向用户提问（测试账号、
 * 短信验证码转述、分支取舍），用户在会话面板上作答即可，不必接触页面；
 * 必须真人在页面上操作的环节仍走 need_human 整屏接管。
 */
export interface AskRequest {
  question: string
  /** 候选选项，点击即提交 */
  options?: string[]
  /** 允许自由输入 */
  allowInput?: boolean
  /** 应答属于敏感信息（验证码等）：只在内存中交给模型使用，落盘一律脱敏 */
  sensitive?: boolean
}

export interface AiAction {
  action: AiActionKind
  /** ProbeElement.idx */
  targetIdx?: number
  value?: string
  scrollDelta?: number
  reason: string
  /** ask 动作的问题内容 */
  question?: string
  options?: string[]
  allowInput?: boolean
  sensitive?: boolean
  /**
   * 旧版探索问询要求模型同时命名当前界面。生成流程重划后节点由引擎机械命名、
   * 图谱生成阶段批量补齐语义，这两个字段不再使用；保留声明是为了旧决策录像能照常回放。
   */
  screen?: {
    id: string
    title: string
    lane: string
    laneTitle?: string
    kind: NodeKind
  }
  edgeLabel?: string
  needHumanReason?: 'login' | 'captcha' | 'payment' | 'other'
}

/** 每步发给 AI 的输入。探索问询只负责选动作，不再携带图谱语义上下文 */
export interface AiDecideInput {
  goal: string
  step: number
  budgets: { stepsLeft: number; aiCallsLeft: number }
  screenshotJpegBase64: string
  probe: ProbeResult
  /** 当前子任务：探索计划里正在覆盖的入口，如「注册流程」 */
  subtask?: string
  /** 当前界面此前被访问过几次，用于提示模型换方向 */
  visitCount?: number
  /** 上一步的执行结果或失败反馈 */
  lastOutcome?: string
  /** 已知会导致回环、禁止再选的动作描述 */
  forbidden?: string[]
}

/* ------------------------------- 探索计划 -------------------------------- */

/**
 * 探索计划：基于首屏产出的功能入口清单。
 * 每个入口是一个子任务，探索按序逐个覆盖；把「探索这个网站」的开放目标
 * 收敛为「完成当前入口的覆盖」，模型每步的目标因此是明确的。
 */
export interface ExplorePlanEntry {
  id: string
  /** 功能入口名称，如「注册流程」 */
  title: string
  /** 首屏上入口元素的文案，提示模型从哪里进入 */
  entryText?: string
  status: 'pending' | 'active' | 'covered' | 'abandoned'
}

export interface ExplorePlan {
  entries: ExplorePlanEntry[]
}

/* --------------------------------- 轨迹 ---------------------------------- */

/**
 * 探索轨迹的一步。只追加、不修改，是图谱生成阶段的输入；
 * 与 session.jsonl（状态审计）、ai.jsonl（调用录像）分工，互不替代。
 */
export interface TraceStep {
  t: number
  runId: string
  step: number
  url: string
  /** 界面签名，截图按它存储，轨迹不重复存图 */
  sig: string
  /** 这一步落到的节点与是否新建 */
  nodeId: string
  isNew: boolean
  /**
   * 本步执行的动作与结果。need_human / done / ask 也记；
   * offsite（离开目标站点被回退）与 entry-switch（切换计划入口）是引擎步，不建图
   */
  action: AiActionKind | 'offsite' | 'entry-switch'
  targetText?: string
  ok?: boolean
  outcome?: string
}

/* -------------------------------- 应用设置 ------------------------------- */

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  defaultDeviceId: string
  defaultGoal: string
  exportDir?: string
  /** 启动后与每 30 分钟自动检查新版本 */
  autoCheckUpdate: boolean
  /** 发现新版本后自动在后台下载（不自动重启） */
  autoDownloadUpdate: boolean
  /** 探索前先暂停，确认（可调整）探索计划后再开始 */
  confirmPlan: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  // 默认跟随操作系统
  theme: 'system',
  autoCheckUpdate: true,
  autoDownloadUpdate: true,
  // 默认自动开跑：强制确认会拉长启动路径，需要把关计划的用户在设置里打开
  confirmPlan: false,
  defaultDeviceId: 'iphone-14-pro-max',
  defaultGoal: '走通注册与登录的完整流程，覆盖主干路径与关键的表单校验提示界面，并探索忘记密码等找回路径。',
}
