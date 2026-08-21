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
  sessionAnswerAsk: 'session:answer-ask',
  sessionSnapshot: 'session:snapshot',
  sessionList: 'session:list',

  previewSetBounds: 'preview:set-bounds',
  previewSetVisible: 'preview:set-visible',
  previewSetDevice: 'preview:set-device',
  previewNavigate: 'preview:navigate',
  previewProbe: 'preview:probe',
  previewDiagnose: 'preview:diagnose',
  /** 静帧已经贴到屏幕区上了。主进程等到这一声再把界面提上来，否则会先露出底板 */
  previewFreezeReady: 'preview:freeze-ready',
  /** 界面侧的未捕获错误。界面白屏时主进程照常在跑，不回报就一点痕迹都没有 */
  diagnoseClientError: 'diagnose:client-error',
  /** 应用版本与运行环境。用户报障时第一件要问的就是版本，界面上得能看见 */
  appInfo: 'app:info',
  /** 导出诊断包 */
  diagnoseExport: 'diagnose:export',
  uiStack: 'ui:stack',

  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  graphUpdateNode: 'graph:update-node',
  graphUpdateEdge: 'graph:update-edge',
  graphDeleteNode: 'graph:delete-node',
  graphDeleteEdge: 'graph:delete-edge',
  graphUpdateLane: 'graph:update-lane',
  graphRelayout: 'graph:relayout',
  graphRefine: 'graph:refine',

  exportHtml: 'export:html',
  exportPng: 'export:png',
  shellReveal: 'shell:reveal',
  shellOpenExternal: 'shell:open-external',

  // 主 → 渲染 事件
  evSession: 'session:event',
  evGraphPatch: 'graph:patch',
  evPreviewNav: 'preview:nav-state',
  evWatchShot: 'watch:shot',
  /** 抓存档图期间用静帧顶替屏幕区，image 为空表示撤掉 */
  evPreviewFreeze: 'preview:freeze',
  evUpdateState: 'update:state',
} as const

/**
 * 应用内更新的状态。
 *
 * busy 表示探索会话正占着预览，此时不能重启安装。
 * manualOnly 表示这个安装包只能手动更新（未签名的 macOS 包即是）：
 * 检查新版本照常，但下载与安装由用户到 Release 页自行完成。
 */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'
  version: string
  notes: string
  percent: number
  error: string
  currentVersion?: string
  busy?: boolean
  manualOnly?: boolean
  /** manualOnly 时给出的下载页地址 */
  downloadUrl?: string
}

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

/**
 * 诊断包的采集范围。
 *
 * 脱敏与可复现天生冲突：剥掉目标地址就无法重放。所以级别由用户自己选，
 * 而不是替他决定——basic 不含目标站的任何内容，repro 带上地址与界面标题。
 */
export interface DiagnoseOptions {
  projectId?: string
  level: 'basic' | 'repro'
  /** 是否带界面缩略图。原始分辨率存档图任何级别都不带 */
  includeShots?: boolean
}

export interface DiagnoseResult extends ExportResult {
  /** 包里实际带了什么、刻意排除了什么。原样写进包里，也回给界面展示 */
  included: string[]
  excluded: string[]
}

/** 应用版本与运行环境 */
export interface AppInfo {
  version: string
  platform: string
  arch: string
  electron: string
  chrome: string
  os: string
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
  [CH.projectOpen]: {
    req: { id: string }
    /** previewBound=false 表示预览仍被另一个项目的会话占着，界面要提示 */
    res: { meta: ProjectMeta; graph: FlowGraph; previewBound: boolean }
  }
  [CH.projectDelete]: { req: { id: string }; res: void }
  [CH.projectClearSession]: { req: { id: string }; res: void }

  [CH.sessionStart]: { req: { projectId: string; goal?: string; budgets?: Partial<SessionBudgets> }; res: SessionSnapshot }
  /*
   * 会话控制一律指名道姓。
   *
   * 多个项目可以同时探索，「当前会话」这个概念不再成立——不带标识的话，
   * 用户在 A 的工作台上点暂停，停的可能是 B。
   */
  [CH.sessionPause]: { req: { projectId: string }; res: SessionSnapshot }
  [CH.sessionResume]: { req: { projectId: string }; res: SessionSnapshot }
  [CH.sessionStop]: { req: { projectId: string }; res: SessionSnapshot }
  [CH.sessionTakeoverStart]: { req: { projectId: string }; res: SessionSnapshot }
  [CH.sessionTakeoverEnd]: { req: { projectId: string }; res: SessionSnapshot }
  /** 回答会话面板上的结构化提问 */
  [CH.sessionAnswerAsk]: { req: { projectId: string; answer: string }; res: SessionSnapshot }
  [CH.sessionSnapshot]: { req: { projectId?: string }; res: SessionSnapshot }
  /** 全部在跑的会话。项目列表与侧边栏据此显示「哪些在探索」 */
  [CH.sessionList]: { req: void; res: SessionSnapshot[] }

  /** scale 由渲染进程给出：手动放大时矩形是裁切过的，主进程反推不出比例 */
  [CH.previewSetBounds]: { req: Bounds & { scale?: number }; res: void }
  /**
   * withSnapshot：隐藏之前先抓一张静帧一并返回。
   * 必须在主进程里连着做——分成两次调用的话隐藏会先执行，
   * 对已经隐藏的视图截图只会失败，占位就退化成一片黑。
   */
  [CH.previewSetVisible]: { req: { visible: boolean; withSnapshot?: boolean }; res: { image: string } }
  [CH.previewSetDevice]: { req: { deviceId: string; custom?: DeviceSpec }; res: void }
  [CH.previewNavigate]: { req: { url?: string; action?: 'back' | 'reload' }; res: void }
  [CH.previewProbe]: { req: void; res: unknown }
  [CH.previewDiagnose]: { req: void; res: PreviewDiagnosis }
  [CH.previewFreezeReady]: { req: { token: number }; res: void }
  [CH.appInfo]: { req: void; res: AppInfo }
  [CH.diagnoseExport]: { req: DiagnoseOptions; res: DiagnoseResult }
  [CH.diagnoseClientError]: {
    req: { source: string; message: string; stack?: string; componentStack?: string }
    res: void
  }
  /**
   * 界面与预览的层级切换。
   *
   * 网页由 WebContentsView 绘制，与界面同为窗口的子视图；谁在上由排序决定。
   * 自绘弹层要盖住预览时，把界面提到最上层即可——纯排序操作，瞬时生效，
   * 既不用隐藏预览、也不用抓帧顶替。
   */
  [CH.uiStack]: { req: { front: 'ui' | 'preview' }; res: void }

  /** manual=true：无论结果都要给用户反馈；自动检查安静失败 */
  [CH.updateCheck]: { req: { manual?: boolean }; res: UpdateState }
  [CH.updateDownload]: { req: void; res: UpdateState }
  /** force=true 才允许在探索进行中重启（会中断探索） */
  [CH.updateInstall]: { req: { force?: boolean }; res: UpdateState }

  // 图谱编辑显式指名项目：多会话下从「当前会话」反推目标项目会写错对象。
  // 都返回增量补丁，调用方 applyPatch 即可；被人工修改的字段会记入 pinned，重新生成不覆盖
  [CH.graphUpdateNode]: { req: { projectId: string; id: string; patch: Record<string, unknown> }; res: GraphPatch }
  [CH.graphUpdateEdge]: { req: { projectId: string; id: string; patch: Record<string, unknown> }; res: GraphPatch }
  [CH.graphDeleteNode]: { req: { projectId: string; id: string }; res: GraphPatch }
  [CH.graphDeleteEdge]: { req: { projectId: string; id: string }; res: GraphPatch }
  [CH.graphUpdateLane]: { req: { projectId: string; id: string; title: string }; res: GraphPatch }
  [CH.graphRelayout]: { req: { projectId: string }; res: FlowGraph }
  /** 重新生成图谱：批量补齐语义并整理。探索会话未结束时拒绝 */
  [CH.graphRefine]: { req: { projectId: string }; res: { summary: string; patch: GraphPatch } }

  [CH.exportHtml]: { req: { projectId: string }; res: ExportResult }
  [CH.exportPng]: { req: { projectId: string; scale?: number }; res: ExportResult }
  [CH.shellReveal]: { req: { path: string }; res: void }
  /** 只放行 http/https，其余协议一律拒绝 */
  [CH.shellOpenExternal]: { req: { url: string }; res: void }
}

/** 主 → 渲染 事件类型映射 */
export interface IpcEventMap {
  [CH.evSession]: SessionEvent & { snapshot: SessionSnapshot }
  [CH.evGraphPatch]: GraphPatch
  [CH.evPreviewNav]: NavState
  [CH.evWatchShot]: { nodeId: string; file: string }
  [CH.evPreviewFreeze]: { image: string; token: number }
  [CH.evUpdateState]: UpdateState
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap
