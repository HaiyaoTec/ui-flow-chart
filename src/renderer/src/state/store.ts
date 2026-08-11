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

  openProject: (meta: ProjectMeta, graph: FlowGraph) => void
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

  openProject: (project, graph) => set({ project, graph, newNodeIds: [], logs: [] }),
  closeProject: () => set({ project: null, graph: null, session: null, logs: [], newNodeIds: [] }),

  applyPatch: (patch) =>
    set((s) => {
      if (!s.graph) return s
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
