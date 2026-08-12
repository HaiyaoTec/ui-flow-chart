import { create } from 'zustand'
import type { FlowGraph, GraphPatch, ProjectMeta, SessionEvent, SessionSnapshot } from '@shared/types'

export interface LogLine {
  ts: number
  level: 'info' | 'warn' | 'error'
  text: string
}

interface AppState {
  project: ProjectMeta | null
  graph: FlowGraph | null
  session: SessionSnapshot | null
  logs: LogLine[]
  /** 最近新增的节点，供画布做入场动画与自动跟随 */
  newNodeIds: string[]
  /** 预览是否已经切到当前项目。false 表示仍被另一个项目的会话占着 */
  previewBound: boolean

  openProject: (meta: ProjectMeta, graph: FlowGraph, previewBound?: boolean) => void
  closeProject: () => void
  applyPatch: (patch: GraphPatch) => void
  setSession: (s: SessionSnapshot) => void
  pushEvent: (e: SessionEvent & { snapshot: SessionSnapshot }) => void
  clearLogs: () => void
}

const MAX_LOGS = 300

export const useApp = create<AppState>((set) => ({
  project: null,
  graph: null,
  session: null,
  logs: [],
  newNodeIds: [],
  previewBound: true,

  openProject: (project, graph, previewBound = true) =>
    set({ project, graph, newNodeIds: [], logs: [], previewBound }),
  closeProject: () =>
    set({ project: null, graph: null, session: null, logs: [], newNodeIds: [], previewBound: true }),

  applyPatch: (patch) =>
    set((s) => {
      if (!s.graph) return s
      // 后台项目也在产出补丁，落到当前打开的项目上就是静默污染图谱
      if (patch.projectId && patch.projectId !== s.project?.id) return s
      const graph: FlowGraph = {
        ...s.graph,
        lanes: [...s.graph.lanes],
        nodes: [...s.graph.nodes],
        edges: [...s.graph.edges],
        meta: patch.meta ?? s.graph.meta,
      }
      for (const l of patch.addedLanes ?? []) if (!graph.lanes.some((x) => x.id === l.id)) graph.lanes.push(l)
      // 节点可能因为自动布局而带回新坐标，按 id 覆盖式合并
      for (const n of [...(patch.addedNodes ?? []), ...(patch.updatedNodes ?? [])]) {
        const i = graph.nodes.findIndex((x) => x.id === n.id)
        if (i >= 0) graph.nodes[i] = n
        else graph.nodes.push(n)
      }
      for (const e of patch.addedEdges ?? []) if (!graph.edges.some((x) => x.id === e.id)) graph.edges.push(e)
      if (patch.removedNodeIds?.length) {
        const gone = new Set(patch.removedNodeIds)
        graph.nodes = graph.nodes.filter((n) => !gone.has(n.id))
        graph.edges = graph.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to))
      }
      const added = (patch.addedNodes ?? []).map((n) => n.id)
      return { graph, newNodeIds: added.length ? added : s.newNodeIds }
    }),

  setSession: (session) => set({ session }),

  pushEvent: (e) =>
    set((s) => {
      // 会话状态是全局的（同一时刻只有一个会话），项目列表要靠它显示状态，所以照单全收；
      // 但日志属于具体项目，别的项目的日志不能混进当前工作台
      if (s.project && e.snapshot.projectId !== s.project.id) return { session: e.snapshot }

      const logs = [...s.logs]
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
      return { session: e.snapshot, logs: logs.slice(-MAX_LOGS) }
    }),

  clearLogs: () => set({ logs: [] }),
}))
