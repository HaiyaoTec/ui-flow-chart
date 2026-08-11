import type { BrowserWindow } from 'electron'
import { getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import type { FlowEdge, FlowLane, FlowNode, SessionBudgets, SessionSnapshot } from '@shared/types'
import { createAiClient } from '../ai'
import { getProject, partitionOf, touchProject } from '../store/projects'
import { ExplorerSession } from './ExplorerSession'
import { preview } from './previewManager'

/** 全局唯一的探索会话。同一时刻只允许一个项目在跑 */
class SessionManager {
  private session: ExplorerSession | null = null
  private win: BrowserWindow | null = null

  bindWindow(win: BrowserWindow): void {
    this.win = win
  }

  private send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  private ensure(projectId: string): ExplorerSession {
    const meta = getProject(projectId)
    if (!meta) throw new Error('项目不存在')

    const ai = createAiClient(meta.aiProfileId)
    this.session = new ExplorerSession({
      driver: preview.driver,
      ai,
      openTarget: async (url) => {
        await preview.open(url, getDevice(meta.deviceId, meta.customDevice), partitionOf(meta.id))
      },
      emit: (event, snapshot) => this.send(CH.evSession, { ...event, snapshot }),
      emitPatch: (lanes: FlowLane[], nodes: FlowNode[], edges: FlowEdge[]) =>
        this.send(CH.evGraphPatch, { addedLanes: lanes, addedNodes: nodes, addedEdges: edges }),
    })
    return this.session
  }

  async start(projectId: string, goal?: string, budgets?: Partial<SessionBudgets>): Promise<SessionSnapshot> {
    const meta = getProject(projectId)
    if (!meta) throw new Error('项目不存在')
    touchProject(projectId)
    const session = this.ensure(projectId)
    return session.start(meta, goal ?? meta.goal, budgets)
  }

  snapshot(): SessionSnapshot {
    return (
      this.session?.snapshot() ?? {
        projectId: null,
        state: 'idle',
        step: 0,
        aiCalls: 0,
        screens: 0,
        startedAt: null,
        budgets: { maxSteps: 60, maxDurationMs: 1200000, maxAiCalls: 80, maxScreens: 300 },
      }
    )
  }

  pause(): SessionSnapshot {
    return this.session?.pause() ?? this.snapshot()
  }
  resume(): SessionSnapshot {
    return this.session?.resume() ?? this.snapshot()
  }
  stop(): SessionSnapshot {
    return this.session?.stop() ?? this.snapshot()
  }
  async takeoverStart(): Promise<SessionSnapshot> {
    return (await this.session?.takeoverStart()) ?? this.snapshot()
  }
  async takeoverEnd(): Promise<SessionSnapshot> {
    return (await this.session?.takeoverEnd()) ?? this.snapshot()
  }
}

export const sessions = new SessionManager()
