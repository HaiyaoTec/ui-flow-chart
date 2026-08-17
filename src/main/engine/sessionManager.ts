import { Notification, type BaseWindow } from 'electron'
import { getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import {
  SESSION_HOLDS_PREVIEW,
  type SessionBudgets,
  type SessionSnapshot,
} from '@shared/types'
import { createAiClient } from '../ai'
import { log } from '../log'
import { getProject, partitionOf, touchProject, updateProjectRun } from '../store/projects'
import { ExplorerSession } from './ExplorerSession'
import { preview } from './previewManager'
import { getUiContents } from '../window'

/** 全局唯一的探索会话。同一时刻只允许一个项目在跑 */
class SessionManager {
  private session: ExplorerSession | null = null
  private win: BaseWindow | null = null

  bindWindow(win: BaseWindow): void {
    this.win = win
  }

  /** 窗口关闭时置空，等下一个窗口绑上来。不置空的话事件会一直发往已销毁的窗口 */
  unbindWindow(win: BaseWindow): void {
    if (this.win === win) this.win = null
  }

  private send(channel: string, payload: unknown): void {
    // 界面自己也是一个 WebContentsView，事件要发给它而不是窗口
    if (this.win && !this.win.isDestroyed()) getUiContents()?.send(channel, payload)
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
      /*
       * 停止原因只补不抹。
       *
       * lastRun 是单槽位覆盖写，而「继续」会带着空 reason 走一遍 state-changed：
       * 原先那次覆盖会把「已达步数上限」之类的触顶原因整个抹掉，
       * 用户若在此时关掉应用，为什么停的就永久丢了。
       */
      const prev = getProject(projectId)?.lastRun?.reason
      updateProjectRun(projectId, {
        state: snapshot.state,
        steps: snapshot.step,
        screens: snapshot.screens,
        aiCalls: snapshot.aiCalls,
        nodes,
        startedAt: snapshot.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reason: reason ?? snapshot.reason ?? prev,
      })
    } catch {
      // 落盘失败不该影响探索本身
    }
  }

  private ensure(projectId: string): ExplorerSession {
    const meta = getProject(projectId)
    if (!meta) throw new Error('项目不存在')

    // 会话与预览都是全局单例。直接覆盖 this.session 的话，上一个会话既停不下来、
    // 也再也拿不到引用，而它的 openTarget 还会把预览抢去自己的地址——
    // 两个项目的操作会打在同一个页面上。
    const cur = this.session?.snapshot()
    if (cur && cur.projectId && cur.projectId !== projectId && SESSION_HOLDS_PREVIEW.includes(cur.state)) {
      const name = getProject(cur.projectId)?.name ?? cur.projectId
      throw new Error(`「${name}」的探索尚未结束（${cur.state}），请先结束它再开始新的探索`)
    }

    const ai = createAiClient(meta.aiProfileId)
    this.session = new ExplorerSession({
      driver: preview.driver,
      ai,
      openTarget: async (url) => {
        await preview.open(url, getDevice(meta.deviceId, meta.customDevice), partitionOf(meta.id))
      },
      captureArchival: () => preview.captureArchival(),
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
      // 带上项目 id：渲染进程可能正开着另一个项目，补丁不能画错地方
      emitPatch: (patch) => this.send(CH.evGraphPatch, { projectId: meta.id, ...patch }),
    })
    return this.session
  }

  async start(projectId: string, goal?: string, budgets?: Partial<SessionBudgets>): Promise<SessionSnapshot> {
    const meta = getProject(projectId)
    if (!meta) throw new Error('项目不存在')
    // ensure 可能因为另一个项目还在跑而拒绝，先过它这关再动项目元数据
    const session = this.ensure(projectId)
    touchProject(projectId)
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

  /**
   * 没有会话时的控制指令也要留痕。
   *
   * 应用重启后会话只活在内存里、已经不存在了，这时用户点「继续」是彻底的空操作：
   * 会话记录写不了（没有 store），界面上也没有任何反馈。落一条主日志是这里
   * 唯一能留下的证据，否则事后完全看不出用户点过。
   */
  private noSession(op: string): SessionSnapshot {
    log.warn('session', `控制指令 ${op} 无处可发：当前没有活动会话`)
    return this.snapshot()
  }

  pause(): SessionSnapshot {
    return this.session?.pause() ?? this.noSession('pause')
  }
  resume(): SessionSnapshot {
    return this.session?.resume() ?? this.noSession('resume')
  }
  stop(): SessionSnapshot {
    return this.session?.stop() ?? this.noSession('stop')
  }
  async takeoverStart(): Promise<SessionSnapshot> {
    return (await this.session?.takeoverStart()) ?? this.noSession('takeover-start')
  }
  async takeoverEnd(): Promise<SessionSnapshot> {
    return (await this.session?.takeoverEnd()) ?? this.noSession('takeover-end')
  }
}

export const sessions = new SessionManager()
