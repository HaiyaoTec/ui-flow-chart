import type {
  AiProfile,
  AiProfileMasked,
  AiTestResult,
  AppSettings,
  DeviceSpec,
  FlowGraph,
  GraphPatch,
  ProjectMeta,
  SessionBudgets,
  SessionEvent,
  SessionSnapshot,
} from './types'

/** 通道名常量：主/渲染两侧唯一事实源，避免字符串写错 */
export const CH = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  themeSet: 'theme:set',

  aiProfilesList: 'ai:profiles:list',
  aiProfileSave: 'ai:profiles:save',
  aiProfileDelete: 'ai:profiles:delete',
  aiTest: 'ai:test',

  projectCreate: 'project:create',
  projectList: 'project:list',
  projectOpen: 'project:open',
  projectDelete: 'project:delete',
  projectClearSession: 'project:clear-session-data',

  sessionStart: 'session:start',
  sessionPause: 'session:pause',
  sessionResume: 'session:resume',
  sessionStop: 'session:stop',
  sessionTakeoverStart: 'session:takeover:start',
  sessionTakeoverEnd: 'session:takeover:end',
  sessionSnapshot: 'session:snapshot',

  previewSetBounds: 'preview:set-bounds',
  previewSetVisible: 'preview:set-visible',
  previewSetDevice: 'preview:set-device',
  previewNavigate: 'preview:navigate',
  previewProbe: 'preview:probe',
  previewDiagnose: 'preview:diagnose',

  graphUpdateNode: 'graph:update-node',
  graphUpdateEdge: 'graph:update-edge',
  graphDeleteNode: 'graph:delete-node',
  graphRelayout: 'graph:relayout',

  exportHtml: 'export:html',
  exportPng: 'export:png',
  shellReveal: 'shell:reveal',

  // 主 → 渲染 事件
  evSession: 'session:event',
  evGraphPatch: 'graph:patch',
  evPreviewNav: 'preview:nav-state',
  evWatchShot: 'watch:shot',
} as const

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NavState {
  url: string
  loading: boolean
  canGoBack: boolean
  title: string
}

export interface ExportResult {
  path: string
  bytes: number
}

/** 设备模拟是否真的落到了页面上。数字直接摆出来，省得靠猜 */
export interface PreviewDiagnosis {
  deviceName: string
  deviceSize: string
  scale: number
  viewSize: string
  expectedViewSize: string
  boundsMatch: boolean
  pageInnerWidth: number
  pageScrollWidth: number
  uaApplied: boolean
  uaSample: string
  bodyClass: string
  ok: boolean
}

/** invoke 通道的请求/响应类型映射 */
export interface IpcInvokeMap {
  [CH.settingsGet]: { req: void; res: AppSettings }
  [CH.settingsSet]: { req: Partial<AppSettings>; res: AppSettings }
  [CH.themeSet]: { req: { theme: AppSettings['theme'] }; res: AppSettings }

  [CH.aiProfilesList]: { req: void; res: AiProfileMasked[] }
  [CH.aiProfileSave]: {
    req: { profile: Omit<AiProfile, 'createdAt' | 'updatedAt'>; apiKey?: string }
    res: AiProfileMasked
  }
  [CH.aiProfileDelete]: { req: { id: string }; res: void }
  [CH.aiTest]: { req: { profileId: string }; res: AiTestResult }

  [CH.projectCreate]: {
    req: { name: string; targetUrl: string; deviceId: string; customDevice?: DeviceSpec; aiProfileId: string; goal: string }
    res: ProjectMeta
  }
  [CH.projectList]: { req: void; res: ProjectMeta[] }
  [CH.projectOpen]: { req: { id: string }; res: { meta: ProjectMeta; graph: FlowGraph } }
  [CH.projectDelete]: { req: { id: string }; res: void }
  [CH.projectClearSession]: { req: { id: string }; res: void }

  [CH.sessionStart]: { req: { projectId: string; goal?: string; budgets?: Partial<SessionBudgets> }; res: SessionSnapshot }
  [CH.sessionPause]: { req: void; res: SessionSnapshot }
  [CH.sessionResume]: { req: void; res: SessionSnapshot }
  [CH.sessionStop]: { req: void; res: SessionSnapshot }
  [CH.sessionTakeoverStart]: { req: void; res: SessionSnapshot }
  [CH.sessionTakeoverEnd]: { req: void; res: SessionSnapshot }
  [CH.sessionSnapshot]: { req: void; res: SessionSnapshot }

  [CH.previewSetBounds]: { req: Bounds; res: void }
  [CH.previewSetVisible]: { req: { visible: boolean }; res: void }
  [CH.previewSetDevice]: { req: { deviceId: string; custom?: DeviceSpec }; res: void }
  [CH.previewNavigate]: { req: { url?: string; action?: 'back' | 'reload' }; res: void }
  [CH.previewProbe]: { req: void; res: unknown }
  [CH.previewDiagnose]: { req: void; res: PreviewDiagnosis }

  [CH.graphUpdateNode]: { req: { id: string; patch: Record<string, unknown> }; res: void }
  [CH.graphUpdateEdge]: { req: { id: string; patch: Record<string, unknown> }; res: void }
  [CH.graphDeleteNode]: { req: { id: string }; res: void }
  [CH.graphRelayout]: { req: void; res: FlowGraph }

  [CH.exportHtml]: { req: { projectId: string }; res: ExportResult }
  [CH.exportPng]: { req: { projectId: string; scale?: number }; res: ExportResult }
  [CH.shellReveal]: { req: { path: string }; res: void }
}

/** 主 → 渲染 事件类型映射 */
export interface IpcEventMap {
  [CH.evSession]: SessionEvent & { snapshot: SessionSnapshot }
  [CH.evGraphPatch]: GraphPatch
  [CH.evPreviewNav]: NavState
  [CH.evWatchShot]: { nodeId: string; file: string }
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap
