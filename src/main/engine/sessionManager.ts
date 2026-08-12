import { Notification, type BrowserWindow } from 'electron'
import { getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import type { FlowEdge, FlowLane, FlowNode, SessionBudgets, SessionSnapshot } from '@shared/types'
import { createAiClient } from '../ai'
import { getProject, partitionOf, touchProject, updateProjectRun } from '../store/projects'
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

  /**
   * 探索是在后台跑的，用户可能已经切走或最小化了窗口。
   * 需要真人介入时必须主动叫人，否则会一直干等着。
   */
  private alertHuman(projectName: string, reason: string): void {
    this.notify(`${projectName} 需要你介入`, reason)
    if (this.win && !this.win.isDestroyed() && !this.win.isFocused()) {
      this.win.flashFrame(true)
      // 窗口一被聚焦就停掉任务栏闪烁
      this.win.once('focus', () => this.win?.flashFrame(false))
    }
  }

  private notify(title: string, body: string): void {
    if (process.env.UFC_TEST === '1') return
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    } catch {
      // 系统未开通知权限时忽略即可
    }
  }

  /** 把会话快照写进项目元数据，节点数从当前图谱里取 */
  private persistRun(projectId: string, snapshot: SessionSnapshot, reason?: string): void {
    try {
      const nodes = this.session?.graphNodeCount() ?? 0
      updateProjectRun(projectId, {
        state: snapshot.state,
        steps: snapshot.step,
        screens: snapshot.screens,
        aiCalls: snapshot.aiCalls,
        nodes,
        startedAt: snapshot.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reason: reason ?? snapshot.reason,
      })
    } catch {
      // 落盘失败不该影响探索本身
    }
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
      emit: (event, snapshot) => {
        this.send(CH.evSession, { ...event, snapshot })
        if (event.kind === 'need-human') this.alertHuman(meta.name, event.reason)
        if (event.kind === 'finished') this.notify(`${meta.name} 探索完成`, `共 ${snapshot.screens} 屏、${snapshot.step} 步`)
        // 状态每变一次就落盘一次：会话只活在内存里，
        // 不落盘的话退出应用后项目列表就再也不知道上次跑到哪了
        if (event.kind === 'state-changed' || event.kind === 'finished') {
          this.persistRun(meta.id, snapshot, event.kind === 'state-changed' ? event.reason : undefined)
        }
      },
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
