/**
 * 主进程与渲染进程共用的数据模型。此文件禁止 import electron。
 */

/* ------------------------------- 设备与目标 ------------------------------- */

export interface DeviceSpec {
  id: string
  /** 展示名，如「iPhone 14 Pro Max」 */
  name: string
  kind: 'mobile' | 'tablet' | 'desktop'
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
  ts: string
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  label: string
  type: EdgeType
  createdBy: 'ai' | 'human'
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
}

export interface GraphPatch {
  addedLanes?: FlowLane[]
  addedNodes?: FlowNode[]
  addedEdges?: FlowEdge[]
  updatedNodes?: FlowNode[]
  removedNodeIds?: string[]
  meta?: FlowGraph['meta']
}

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
}

/* ------------------------------- 探索会话 -------------------------------- */

export type SessionState =
  | 'idle'
  | 'launching'
  | 'observing'
  | 'thinking'
  | 'acting'
  | 'paused'
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
}

export type SessionEvent =
  | { kind: 'state-changed'; from: SessionState; to: SessionState; reason?: string }
  | { kind: 'step-started'; step: number; url: string }
  | { kind: 'ai-request'; step: number }
  | { kind: 'ai-action'; step: number; action: AiAction }
  | { kind: 'action-failed'; step: number; error: string }
  | { kind: 'need-human'; reason: string; hint: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'budget'; snapshot: SessionSnapshot }
  | { kind: 'finished'; snapshot: SessionSnapshot }

/* --------------------------------- AI 动作 ------------------------------- */

export type AiActionKind = 'click' | 'fill' | 'scroll' | 'back' | 'done' | 'need_human'

export interface AiAction {
  action: AiActionKind
  /** ProbeElement.idx */
  targetIdx?: number
  value?: string
  scrollDelta?: number
  reason: string
  screen: {
    id: string
    title: string
    lane: string
    laneTitle?: string
    kind: NodeKind
  }
  edgeLabel: string
  needHumanReason?: 'login' | 'captcha' | 'payment' | 'other'
}

/** 每步发给 AI 的输入 */
export interface AiDecideInput {
  goal: string
  step: number
  budgets: { stepsLeft: number; aiCallsLeft: number }
  screenshotJpegBase64: string
  probe: ProbeResult
  knownLanes: FlowLane[]
  knownNodes: Array<{ id: string; title: string; lane: string }>
  currentNodeId: string | null
  /** 上一步的执行结果或失败反馈 */
  lastOutcome?: string
  /** 已知会导致回环、禁止再选的动作描述 */
  forbidden?: string[]
}

/* -------------------------------- 应用设置 ------------------------------- */

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  defaultDeviceId: string
  defaultGoal: string
  exportDir?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  defaultDeviceId: 'iphone-14-pro-max',
  defaultGoal: '走通注册与登录的完整流程，覆盖主干路径与关键的表单校验提示界面，并探索忘记密码等找回路径。',
}
