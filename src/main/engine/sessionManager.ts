import { Notification, type BaseWindow } from 'electron'
import { getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import {
  DEFAULT_BUDGETS,
  SESSION_ACTIVE,
  type SessionBudgets,
  type SessionSnapshot,
} from '@shared/types'
import { createAiClient } from '../ai'
import { log } from '../log'
import { getProject, partitionOf, touchProject, updateProjectRun } from '../store/projects'
import { getSettings } from '../store/settings'
import { ExplorerSession } from './ExplorerSession'
import { preview } from './previewManager'
import { getUiContents } from '../window'

/**
 * 同时可以跑几个项目。
 *
 * 上限不是按 CPU 定的：后台会话的渲染进程并不会被降频（实测隐藏视图里
 * requestAnimationFrame 照常跑满帧），所以卡点在内存与抓图吞吐——
 * 四个几乎空白的页面已占约 900MB，真实站点每个渲染进程 150–400MB；
 * 而存档抓图在合成器那一侧本来就是串行的，并发只会互相等。
 */
const MAX_CONCURRENT = 3

/** 探索会话的持有者。一个项目至多一个会话，多个项目可以同时跑 */
class SessionManager {
  private sessions = new Map<string, ExplorerSession>()
  private win: BaseWindow | null = null
  /** 任务栏闪烁的 focus 监听是否已挂。窗口级只挂一个，见 alertHuman */
  private flashListening = false

  bindWindow(win: BaseWindow): void {
    this.win = win
  }

  /** 窗口关闭时置空，等下一个窗口绑上来。不置空的话事件会一直发往已销毁的窗口 */
  unbindWindow(win: BaseWindow): void {
    if (this.win === win) {
      this.win = null
      this.flashListening = false
    }
  }

  private send(channel: string, payload: unknown): void {
    // 界面自己也是一个 WebContentsView，事件要发给它而不是窗口
    if (this.win && !this.win.isDestroyed()) getUiContents()?.send(channel, payload)
  }

  /**
   * 探索是在后台跑的，用户可能已经切走或最小化了窗口。
   * 需要真人介入时必须主动叫人，否则会一直干等着。
   *
   * 多个项目同时在等时通知合并成一条「N 个项目在等你接管」——
   * 各弹一条的话每条各挂一个 focus 监听，用户聚焦一次会把后续告警的闪烁一起清掉。
   */
  private alertHuman(projectName: string, reason: string): void {
    const waiting = this.waitingHumanNames()
    waiting.add(projectName)
    if (waiting.size > 1) this.notify(`${waiting.size} 个项目在等你接管`, [...waiting].join('、'))
    else this.notify(`${projectName} 需要你介入`, reason)

    if (this.win && !this.win.isDestroyed() && !this.win.isFocused()) {
      this.win.flashFrame(true)
      // 窗口级只挂一个 focus 监听，聚焦后停掉任务栏闪烁
      if (!this.flashListening) {
        this.flashListening = true
        this.win.once('focus', () => {
          this.win?.flashFrame(false)
          this.flashListening = false
        })
      }
    }
  }

  /** 正在等人（排队、录制中或等回答）的项目名 */
  private waitingHumanNames(): Set<string> {
    const names = new Set<string>()
    for (const [id, s] of this.sessions) {
      const st = s.snapshot().state
      if (st === 'awaiting_human' || st === 'human_queued' || st === 'asking') names.add(getProject(id)?.name ?? id)
    }
    return names
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
      const nodes = this.sessions.get(projectId)?.graphNodeCount() ?? 0
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

  /** 正在跑的会话数。终态的会话不占名额 */
  private activeCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (SESSION_ACTIVE.includes(s.snapshot().state)) n += 1
    return n
  }

  activeProjectIds(): string[] {
    return [...this.sessions.entries()]
      .filter(([, s]) => SESSION_ACTIVE.includes(s.snapshot().state))
      .map(([id]) => id)
  }

  has(projectId: string): boolean {
    return this.sessions.has(projectId)
  }

  private ensure(projectId: string): ExplorerSession {
    const meta = getProject(projectId)
    if (!meta) throw new Error('项目不存在')

    /*
     * 一个项目至多一个会话。
     *
     * 这不只是产品约束：会话分区按项目派生，同一分区上如果挂两个 PageDriver，
     * Session 级的请求头钩子会被后来者替换，先来的那个页面会带上别人的 UA。
     * 用不变量挡住，比事后去兼容便宜得多。
     */
    const exist = this.sessions.get(projectId)
    if (exist && SESSION_ACTIVE.includes(exist.snapshot().state)) return exist

    if (!exist && this.activeCount() >= MAX_CONCURRENT) {
      const names = this.activeProjectIds()
        .map((id) => getProject(id)?.name ?? id)
        .join('、')
      throw new Error(`同时探索的项目最多 ${MAX_CONCURRENT} 个，当前在跑：${names}。请先结束其中一个`)
    }

    const ai = createAiClient(meta.aiProfileId)
    const session = new ExplorerSession({
      driver: preview.ensure(meta.id).driver,
      ai,
      // 人工接管只有前台才能进行：屏幕上显示的是不是本项目由 PreviewHost 说了算
      isFront: () => preview.frontProjectId() === meta.id,
      confirmPlan: () => getSettings().confirmPlan,
      openTarget: async (url) => {
        await preview.open(meta.id, url, getDevice(meta.deviceId, meta.customDevice), partitionOf(meta.id))
      },
      captureArchival: () => preview.captureArchival(meta.id),
      emit: (event, snapshot) => {
        this.send(CH.evSession, { ...event, snapshot })
        if (event.kind === 'need-human') this.alertHuman(meta.name, event.reason)
        // 提问同样要主动叫人：探索在后台跑，不提醒就会一直干等
        if (event.kind === 'ask') this.alertHuman(meta.name, `需要你回答：${event.ask.question}`)
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
    this.sessions.set(projectId, session)
    return session
  }

  async start(projectId: string, goal?: string, budgets?: Partial<SessionBudgets>): Promise<SessionSnapshot> {
    const meta = getProject(projectId)
    if (!meta) throw new Error('项目不存在')
    // ensure 可能因为另一个项目还在跑而拒绝，先过它这关再动项目元数据
    const session = this.ensure(projectId)
    touchProject(projectId)
    return session.start(meta, goal ?? meta.goal, budgets)
  }

  /** 某个项目的会话快照。不指名时给出「哪个都不是」的空态 */
  snapshot(projectId?: string): SessionSnapshot {
    const s = projectId ? this.sessions.get(projectId) : null
    return s?.snapshot() ?? idleSnapshot(projectId ?? null)
  }

  /** 全部会话的快照。项目列表与侧边栏据此显示哪些在探索 */
  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshot())
  }

  /**
   * 指名的会话不存在时也要留痕。
   *
   * 应用重启后会话只活在内存里、已经不存在了，这时用户点「继续」是彻底的空操作：
   * 会话记录写不了（没有 store），界面上也没有任何反馈。落一条主日志是这里
   * 唯一能留下的证据，否则事后完全看不出用户点过。
   */
  private noSession(op: string, projectId: string): SessionSnapshot {
    log.warn('session', `控制指令 ${op} 无处可发：${projectId} 没有活动会话`)
    return idleSnapshot(projectId)
  }

  pause(projectId: string): SessionSnapshot {
    return this.sessions.get(projectId)?.pause() ?? this.noSession('pause', projectId)
  }
  resume(projectId: string): SessionSnapshot {
    return this.sessions.get(projectId)?.resume() ?? this.noSession('resume', projectId)
  }
  stop(projectId: string): SessionSnapshot {
    return this.sessions.get(projectId)?.stop() ?? this.noSession('stop', projectId)
  }
  async takeoverStart(projectId: string): Promise<SessionSnapshot> {
    return (await this.sessions.get(projectId)?.takeoverStart()) ?? this.noSession('takeover-start', projectId)
  }
  async takeoverEnd(projectId: string): Promise<SessionSnapshot> {
    return (await this.sessions.get(projectId)?.takeoverEnd()) ?? this.noSession('takeover-end', projectId)
  }
  answerAsk(projectId: string, answer: string): SessionSnapshot {
    return this.sessions.get(projectId)?.answerAsk(answer) ?? this.noSession('ask-answer', projectId)
  }
  updatePlan(projectId: string, entries: Array<{ title: string; entryText?: string; status?: string }>): SessionSnapshot {
    return this.sessions.get(projectId)?.updatePlan(entries) ?? this.noSession('plan-edit', projectId)
  }

  /** 停掉全部会话。应用内更新要重启时用 */
  stopAll(): void {
    for (const s of this.sessions.values()) s.stop()
  }
}

/** 「这个项目此刻没有会话」的统一表达 */
function idleSnapshot(projectId: string | null): SessionSnapshot {
  return {
    projectId,
    state: 'idle',
    step: 0,
    aiCalls: 0,
    screens: 0,
    startedAt: null,
    budgets: DEFAULT_BUDGETS,
  }
}

export const sessions = new SessionManager()
