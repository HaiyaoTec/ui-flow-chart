import { create } from 'zustand'
import type { FlowGraph, GraphPatch, ProjectMeta, SessionEvent, SessionSnapshot } from '@shared/types'
import { mergePatch } from '@shared/mergePatch'

export interface LogLine {
  ts: number
  level: 'info' | 'warn' | 'error'
  text: string
}

interface AppState {
  project: ProjectMeta | null
  graph: FlowGraph | null
  /**
   * 会话快照按项目分桶。
   *
   * 原先只有一个槽位：多个项目同时探索时，谁的事件后到就把谁的状态写进去，
   * 工作台顶栏与项目列表会随事件频率来回抖。
   */
  sessions: Record<string, SessionSnapshot>
  /** 日志同样按项目分桶，切回去还能看到之前那一段 */
  logsByProject: Record<string, LogLine[]>
  /** 最近新增的节点，供画布做入场动画与自动跟随 */
  newNodeIds: string[]
  /** 预览是否已经切到当前项目。false 表示仍被另一个项目的会话占着 */
  previewBound: boolean

  openProject: (meta: ProjectMeta, graph: FlowGraph, previewBound?: boolean) => void
  closeProject: () => void
  applyPatch: (patch: GraphPatch) => void
  setSession: (s: SessionSnapshot) => void
  setSessions: (list: SessionSnapshot[]) => void
  pushEvent: (e: SessionEvent & { snapshot: SessionSnapshot }) => void
  clearLogs: () => void
}

/** 某个项目此刻的会话快照。没有就是没在跑 */
export function sessionOf(s: AppState, projectId?: string | null): SessionSnapshot | null {
  return projectId ? (s.sessions[projectId] ?? null) : null
}

/** 正在跑的项目标识。项目列表与侧边栏据此显示实时状态 */
export function liveProjectIds(s: AppState): string[] {
  return Object.entries(s.sessions)
    .filter(([, v]) => v.state !== 'idle' && v.state !== 'finished' && v.state !== 'failed')
    .map(([id]) => id)
}

const MAX_LOGS = 300

export const useApp = create<AppState>((set) => ({
  project: null,
  graph: null,
  sessions: {},
  logsByProject: {},
  newNodeIds: [],
  previewBound: true,

  // 日志不再随开关项目清空：另一个项目可能正在后台跑，回头切过去要看得到
  openProject: (project, graph, previewBound = true) => set({ project, graph, newNodeIds: [], previewBound }),
  closeProject: () => set({ project: null, graph: null, newNodeIds: [], previewBound: true }),

  applyPatch: (patch) =>
    set((s) => {
      if (!s.graph) return s
      // 后台项目也在产出补丁，落到当前打开的项目上就是静默污染图谱
      if (patch.projectId && patch.projectId !== s.project?.id) return s
      const graph = mergePatch(s.graph, patch)
      // 只有真正新增的节点才触发「跟随新界面」，收尾整理下发的全量 updatedNodes 不该让画布跳走
      const added = (patch.addedNodes ?? []).map((n) => n.id)
      return { graph, newNodeIds: added.length ? added : s.newNodeIds }
    }),

  setSession: (session) =>
    set((s) => (session.projectId ? { sessions: { ...s.sessions, [session.projectId]: session } } : s)),

  setSessions: (list) =>
    set((s) => {
      const next = { ...s.sessions }
      for (const snap of list) if (snap.projectId) next[snap.projectId] = snap
      return { sessions: next }
    }),

  pushEvent: (e) =>
    set((s) => {
      const pid = e.snapshot.projectId
      // 没有归属的事件无处安放。多会话之后每条事件都应当带着自己的项目
      if (!pid) return s
      const sessions = { ...s.sessions, [pid]: e.snapshot }

      const logs = [...(s.logsByProject[pid] ?? [])]
      const add = (level: LogLine['level'], text: string) => logs.push({ ts: Date.now(), level, text })

      switch (e.kind) {
        case 'state-changed':
          add('info', `状态：${e.from} → ${e.to}${e.reason ? `（${e.reason}）` : ''}`)
          break
        case 'step-started':
          add('info', `第 ${e.step} 步 · ${e.url}`)
          break
        case 'ai-action':
          add('info', `AI 决策：${e.action.action}${e.action.targetIdx !== undefined ? ` #${e.action.targetIdx}` : ''} — ${e.action.reason}`)
          break
        case 'action-failed':
          add('warn', `动作失败：${e.error}`)
          break
        case 'need-human':
          add('warn', `需要人工介入：${e.reason}`)
          break
        case 'log':
          add(e.level, e.message)
          break
        case 'finished':
          add('info', '探索结束')
          break
        default:
          break
      }
      return { sessions, logsByProject: { ...s.logsByProject, [pid]: logs.slice(-MAX_LOGS) } }
    }),

  clearLogs: () =>
    set((s) => (s.project ? { logsByProject: { ...s.logsByProject, [s.project.id]: [] } } : s)),
}))
