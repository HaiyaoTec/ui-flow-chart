import { randomUUID } from 'node:crypto'
import {
  DEFAULT_BUDGETS,
  MANUAL_LANE_ID,
  MANUAL_LANE_TITLE,
  type AiAction,
  type FlowEdge,
  type FlowLane,
  type FlowNode,
  type GraphPatch,
  type ProbeResult,
  type ProjectMeta,
  type SessionBudgets,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
} from '@shared/types'
import type { IAiClient, ReviewTask } from '../ai/types'
import { ActionParseError } from '../ai/parseAction'
import { sanitizeEdgeReview, sanitizeLaneAssignments } from '../ai/parseReview'
import { buildEdgeReviewTask, buildLaneClassifyTask } from '../ai/reviewPrompt'
import { describeFinalize, finalizeGraph, type AiVerdict } from './finalize'
import { inheritLanes, planCleanup } from './graphCleanup'
import { GraphStore } from './graphStore'
import { log } from '../log'
import { delay, type PageDriver, type Screenshot } from './PageDriver'
import { signatureHash } from './signature'
import { WatchRecorder } from './watchRecorder'

export interface SessionDeps {
  driver: PageDriver
  ai: IAiClient
  /** 打开目标站并铺好设备模拟 */
  openTarget: (url: string) => Promise<void>
  /** 抓存档图。走预览管理器而不是 driver：抓图期间要用静帧顶住屏幕区 */
  captureArchival: () => Promise<Screenshot>
  emit: (event: SessionEvent, snapshot: SessionSnapshot) => void
  /** 增量补丁。收一个 patch 对象而不是三个数组：收尾整理还要送更新与删除 */
  emitPatch: (patch: Omit<GraphPatch, 'projectId'>) => void
}

/** 计时状态：只有这些状态算「正在跑」，暂停与等人期间时长不走表 */
const RUNNING_STATES: SessionState[] = ['launching', 'observing', 'thinking', 'acting', 'resuming', 'finishing']

type BudgetKey = 'steps' | 'aiCalls' | 'screens' | 'duration'
type ControlOp = 'pause' | 'resume' | 'stop' | 'takeover-start' | 'takeover-end'

const MAX_PARSE_RETRY = 2
const MAX_SAME_SCREEN_FAILS = 3
const MAX_ACTIONS_PER_SCREEN = 5
const MAX_VISITS_PER_SIGNATURE = 4
const NO_PROGRESS_LIMIT = 6

/** 第三方验证码服务的域名特征，命中即可确信 */
const CAPTCHA_IFRAME = /captcha|recaptcha|hcaptcha|turnstile|geetest|arkoselabs/i
/** URL 路径特征 */
const CAPTCHA_URL = /captcha|challenge|verify-human/i
const PAYMENT_HINTS = /paypal|stripe|checkout|payment|收银台/i

/**
 * 刻意不做正文关键词匹配。
 * 「图形验证」「验证码」这类词在正常页面的说明文字里也很常见，
 * 一匹配就会把普通表单误判成需要真人介入。AI 能看到截图，
 * 判断「这是不是一道人机验证」比正则准得多，交给它输出 need_human 即可；
 * 启发式只负责 AI 看不见的部分：跨域 iframe 与 URL 特征。
 */

/**
 * 探索会话状态机。
 *
 * 每一步都是「观察 → 去重 → 决策 → 执行」的闭环，状态活在主进程里，
 * 渲染进程只负责展示与下指令，界面刷新或崩溃都不会打断探索。
 */
export class ExplorerSession {
  private state: SessionState = 'idle'
  private project: ProjectMeta | null = null
  private store: GraphStore | null = null

  /** 当前图谱的节点数，供项目列表展示「沉淀了多少界面」 */
  graphNodeCount(): number {
    return this.store?.get().nodes.length ?? 0
  }
  private budgets: SessionBudgets = DEFAULT_BUDGETS
  private goal = ''
  private step = 0
  private aiCalls = 0
  private screens = 0
  private startedAt: string | null = null
  private reason?: string
  private lastError?: string

  private currentNodeId: string | null = null
  private lastOutcome = ''
  private abort: AbortController | null = null
  private stopRequested = false
  private pauseRequested = false
  private takeoverRequested = false
  private takeoverEndRequested = false
  /** 本轮是否已经收尾整理过。loop 的正常出口与 catch 分支都会调，只许跑一次 */
  private finalizeDone = false
  private watcher: WatchRecorder | null = null

  /** 签名 → 访问次数，用于循环检测 */
  private visits = new Map<string, number>()
  private sigHistory: string[] = []
  private screenFails = new Map<string, number>()
  private screenActions = new Map<string, number>()
  private forbidden: string[] = []
  private noProgress = 0
  private staleRounds = 0
  private fallbackStreak = 0

  /**
   * 本次运行的标识。
   *
   * session.jsonl 是追加文件，同一个项目跑多少轮都平铺在里面。没有它，
   * 事后只能靠「出现 launching」「step 归零」去猜运行边界，跨轮的耗时算不准。
   */
  private runId = ''
  /** 之前各个运行区段累计的时长 */
  private runMsBefore = 0
  /** 当前运行区段的起点；0 表示此刻不在跑 */
  private segmentAt = 0
  /**
   * 四项预算的起算点。
   *
   * 预算的语义是「这一轮连续探索花多少」，而不是「这个项目历史上花了多少」：
   * - screens 的初值是图谱里已有的节点数，不减去起算点的话，
   *   二次探索一开始就贴着上限，还会报出「已达截图数上限（300 张）」这种
   *   让人以为本轮抓了 300 张的说法
   * - 用户点「继续」等于明确表示「再给一轮」，把起算点推到当前值，
   *   「继续」才真的能继续
   */
  private base = { step: 0, aiCalls: 0, screens: 0, ms: 0 }
  /** 人工接管区间的起点与序号，用于把接管段落标进记录 */
  private takeoverAt = 0
  private takeoverSeq = 0

  constructor(private readonly deps: SessionDeps) {}

  /* ------------------------------- 对外接口 ------------------------------- */

  snapshot(): SessionSnapshot {
    return {
      projectId: this.project?.id ?? null,
      state: this.state,
      step: this.step,
      aiCalls: this.aiCalls,
      screens: this.screens,
      startedAt: this.startedAt,
      budgets: this.budgets,
      reason: this.reason,
      lastError: this.lastError,
      currentNodeId: this.currentNodeId ?? undefined,
      runId: this.runId || undefined,
      elapsedMs: this.elapsedMs(),
    }
  }

  /**
   * 本轮实际在跑的时长。
   *
   * 只累计运行区段：暂停与人工接管期间不计。原先直接拿墙钟减开始时间，
   * 接管着改十分钟验证码，回来一跑就直接触顶。
   */
  private elapsedMs(): number {
    return this.runMsBefore + (this.segmentAt ? Date.now() - this.segmentAt : 0)
  }

  /** 相对本轮起算点的四项用量 */
  private used(): { step: number; aiCalls: number; screens: number; ms: number } {
    return {
      step: this.step - this.base.step,
      aiCalls: this.aiCalls - this.base.aiCalls,
      screens: this.screens - this.base.screens,
      ms: this.elapsedMs() - this.base.ms,
    }
  }

  async start(project: ProjectMeta, goal: string, budgets?: Partial<SessionBudgets>): Promise<SessionSnapshot> {
    if (this.isRunning()) return this.snapshot()

    this.project = project
    this.goal = goal || project.goal
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets }
    this.store = new GraphStore(project.id, project.targetUrl, project.deviceId)
    this.step = 0
    this.aiCalls = 0
    this.screens = this.store.get().nodes.length
    this.startedAt = new Date().toISOString()
    this.runId = `r${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    this.runMsBefore = 0
    this.segmentAt = 0
    this.takeoverAt = 0
    this.takeoverSeq = 0
    // 截图数的起算点是图谱里已有的节点数，见 base 的说明
    this.base = { step: 0, aiCalls: 0, screens: this.screens, ms: 0 }
    this.reason = undefined
    this.lastError = undefined
    this.currentNodeId = null
    this.lastOutcome = ''
    this.stopRequested = false
    this.pauseRequested = false
    this.takeoverRequested = false
    this.finalizeDone = false
    this.visits.clear()
    this.sigHistory = []
    this.screenFails.clear()
    this.screenActions.clear()
    this.forbidden = []
    this.noProgress = 0
    this.staleRounds = 0
    this.fallbackStreak = 0

    // 预算配置必须落盘：它只活在内存里，而事后判断「时长触顶」时
    // 没有阈值可对照，连这一轮到底给了多少额度都无从考证
    this.record({
      kind: 'run-start',
      targetUrl: project.targetUrl,
      deviceId: project.deviceId,
      budgets: this.budgets,
      carriedScreens: this.screens,
    })
    this.setState('launching')
    void this.runLoop()
    return this.snapshot()
  }

  pause(): SessionSnapshot {
    // 收尾是终端流程，「待会儿接着跑」在这里没有意义
    const accepted = this.state !== 'finishing' && this.isRunning()
    this.control('pause', accepted)
    if (accepted) {
      this.pauseRequested = true
      // 掐断在途的 AI 请求，不必等它慢慢超时
      this.abort?.abort(new Error('用户暂停'))
    }
    return this.snapshot()
  }

  resume(): SessionSnapshot {
    const accepted = this.state === 'paused'
    this.control('resume', accepted)
    if (accepted) {
      this.pauseRequested = false
      this.reason = undefined
      /*
       * 「继续」= 再给一轮完整预算。
       *
       * 原先这里只清了暂停标志：四项计数与时长基线一个都不动，
       * 主循环重新进来第一件事就是再查一次预算，返回同一个原因，立刻又暂停。
       * 触顶之后这个按钮是假的，只能重开一轮。
       *
       * 顺便复位三个「卡住」计数：那几个是「AI 连续没进展」的判据，
       * 用户既然手动介入过，上一轮的连续性已经不成立了。
       */
      this.base = { step: this.step, aiCalls: this.aiCalls, screens: this.screens, ms: this.elapsedMs() }

      this.fallbackStreak = 0
      this.noProgress = 0
      this.staleRounds = 0
      this.screenFails.clear()
      this.setState('observing')
      void this.runLoop()
    }
    return this.snapshot()
  }

  stop(): SessionSnapshot {
    this.control('stop', true)
    this.stopRequested = true
    this.watcher?.stop()
    this.abort?.abort(new Error('用户结束'))
    return this.snapshot()
  }

  /** 进入人工接管：放开输入屏蔽，转为被动录制 */
  async takeoverStart(reasonText = '用户主动接管'): Promise<SessionSnapshot> {
    const accepted = this.state !== 'awaiting_human'
    this.control('takeover-start', accepted, reasonText)
    if (!accepted) return this.snapshot()
    this.takeoverRequested = true
    this.reason = reasonText
    this.abort?.abort(new Error('转人工接管'))
    return this.snapshot()
  }

  async takeoverEnd(): Promise<SessionSnapshot> {
    // 用标志位而不是只调 watcher.stop()：结束请求可能早于录制器创建，
    // 那时 stop() 是空操作，会话就永远停在等待人工上
    this.control('takeover-end', this.state === 'awaiting_human')
    this.takeoverEndRequested = true
    this.watcher?.stop()
    return this.snapshot()
  }

  private isRunning(): boolean {
    return !['idle', 'paused', 'finished', 'failed'].includes(this.state)
  }

  /* --------------------------------- 主循环 -------------------------------- */

  /**
   * 主循环的唯一入口。
   *
   * loop() 自己有 try/catch，但 catch 块里还要写日志、发事件、做收尾，
   * 这几步同样可能抛。真抛出来就是一个没人接的被拒 Promise：
   * 会话停在原状态、界面上什么都不显示、磁盘上也没有记录。
   * 这层兜底保证无论如何都留下痕迹，并把会话明确置为失败。
   */
  private async runLoop(): Promise<void> {
    try {
      await this.loop()
    } catch (e) {
      log.error('session', '探索主循环异常退出', e)
      this.lastError = e instanceof Error ? e.message : String(e)
      try {
        this.setState('failed', '主循环异常退出')
      } catch {
        // 连状态都写不进去时，主日志里那条已经够定位了
      }
    }
  }

  private async loop(): Promise<void> {
    const store = this.store
    const project = this.project
    if (!store || !project) return

    try {
      if (this.state === 'launching') {
        await this.deps.openTarget(project.targetUrl)
        this.log('info', `已打开 ${project.targetUrl}`)
      }

      while (!this.stopRequested) {
        if (this.pauseRequested) return this.toPaused('用户暂停')
        if (this.takeoverRequested) {
          await this.runTakeover()
          if (this.stopRequested) break
          continue
        }
        const budgetStop = this.checkBudget()
        if (budgetStop) return this.toPausedByBudget(budgetStop)

        /* ---------- 观察 ---------- */
        this.setState('observing')
        this.step += 1
        await this.deps.driver.installUserInputWatcher()
        const probe = await this.deps.driver.waitStable()
        this.emit({ kind: 'step-started', step: this.step, url: probe.url })
        this.log(
          'info',
          `第 ${this.step} 步 · ${probe.url} · ${probe.elements.length} 个可交互元素` +
            (probe.notices.length ? ` · 提示：${probe.notices.join(' / ')}` : '')
        )

        /* ---------- 去重与建图 ---------- */
        const sig = signatureHash(probe)
        const visited = (this.visits.get(sig) ?? 0) + 1
        this.visits.set(sig, visited)
        this.sigHistory.push(sig)
        if (this.sigHistory.length > 12) this.sigHistory.shift()

        const known = store.findBySignature(sig)
        if (known) {
          if (this.currentNodeId && this.currentNodeId !== known.id) {
            const edge = store.addEdge(this.currentNodeId, known.id, this.pendingEdgeLabel || '自动跳转', 'link', 'ai')
            if (edge) {
              store.layoutAndSave()
              this.deps.emitPatch({ addedEdges: [edge] })
            }
          }
          this.currentNodeId = known.id
          this.noProgress += 1
        }

        /* ---------- 接管判定：用户动手了就让位 ---------- */
        const userAge = await this.deps.driver.userInputAge()
        if (userAge !== null && userAge < 8000) {
          await this.deps.driver.clearUserInput()
          this.takeoverRequested = true
          this.reason = '检测到你在预览窗口中操作，已转为人工接管'
          this.emit({ kind: 'need-human', reason: this.reason, hint: '完成后点击「结束接管」，AI 会接着往下走' })
          continue
        }

        /* ---------- 启发式接管判定 ---------- */
        const heuristic = this.detectHumanNeeded(probe)
        if (heuristic) {
          this.takeoverRequested = true
          this.reason = heuristic
          this.emit({ kind: 'need-human', reason: heuristic, hint: '请在预览窗口中手动完成，然后点击「结束接管」' })
          continue
        }

        /* ---------- 决策 ---------- */
        this.setState('thinking')
        // 截图失败不该让整轮探索崩掉：没有图也能靠探针结构继续决策，
        // 大不了这一屏在画布上缺张缩略图
        let shot: { png: Buffer; jpegBase64: string } | null = null
        try {
          shot = await this.deps.captureArchival()
        } catch (e) {
          this.log('warn', `截图失败，本步改用纯结构决策：${e instanceof Error ? e.message : String(e)}`)
        }
        const action = await this.decideWithRetry(probe, shot?.jpegBase64 ?? '')
        if (!action) {
          // 连续兜底两次仍拿不到可用动作，交回给人
          if (++this.fallbackStreak >= 2) return this.toPaused('AI 连续多次未能给出可执行的动作')
          await this.deps.driver.scrollBy(600)
          continue
        }
        this.fallbackStreak = 0
        this.emit({ kind: 'ai-action', step: this.step, action })
        this.log(
          'info',
          `　动作 ${action.action}${action.targetIdx !== undefined ? ` #${action.targetIdx}` : ''}` +
            `${action.value ? `="${action.value}"` : ''} · 命名「${action.screen.title}」· ${action.reason}`
        )

        /* ---------- 落图 ---------- */
        const placed = this.applyScreen(probe, shot, action, known)
        if (placed.isNew) {
          // 有进展就把这一屏的动作配额与停滞计数清零，
          // 否则一个界面用光配额后会永久卡在「强制回退」上
          this.noProgress = 0
          this.staleRounds = 0
          this.screenActions.delete(sig)
        }

        if (action.action === 'done') {
          this.log('info', `AI 判定探索完成：${action.reason}`)
          return await this.finalizeAndFinish()
        }
        if (action.action === 'need_human') {
          this.takeoverRequested = true
          this.reason = `AI 请求人工介入（${action.needHumanReason ?? 'other'}）：${action.reason}`
          this.emit({ kind: 'need-human', reason: this.reason, hint: '请在预览窗口中手动完成，然后点击「结束接管」' })
          continue
        }

        /* ---------- 循环与配额检查 ---------- */
        if (visited > MAX_VISITS_PER_SIGNATURE || this.isOscillating()) {
          this.forbid(`在「${action.screen.title}」上重复执行 ${action.edgeLabel}`)
          this.log('warn', '检测到界面回环，已提示 AI 避开该动作')
        }
        const acted = (this.screenActions.get(sig) ?? 0) + 1
        this.screenActions.set(sig, acted)
        if (acted > MAX_ACTIONS_PER_SCREEN) {
          // 只有真的能退才退。入口页退无可退，硬退会变成原地打转的死循环，
          // 这时改为把该界面标记为已穷尽，交给 AI 换个方向或收敛。
          if (this.deps.driver.canGoBack()) {
            this.log('warn', '同一界面尝试的动作过多，强制回退')
            await this.deps.driver.back()
            continue
          }
          this.forbid(`界面「${action.screen.title}」上的可选动作已尝试多次，请换一个入口或输出 done`)
          this.log('warn', '同一界面动作已穷尽，且无法回退')
        }
        if (this.noProgress >= NO_PROGRESS_LIMIT) {
          this.forbid('连续多步没有发现新界面，请考虑收敛或输出 done')
          this.noProgress = 0
          this.staleRounds += 1
          // 反复提示仍无进展说明已经探完了，主动收敛，别耗到步数上限
          if (this.staleRounds >= 2) {
            this.log('info', '连续多轮没有发现新界面，判定探索已收敛')
            return await this.finalizeAndFinish()
          }
        }

        /* ---------- 执行 ---------- */
        this.setState('acting')
        const ok = await this.execute(action, probe)
        if (!ok) {
          const fails = (this.screenFails.get(sig) ?? 0) + 1
          this.screenFails.set(sig, fails)
          if (fails >= MAX_SAME_SCREEN_FAILS) {
            this.takeoverRequested = true
            this.reason = '同一界面上连续多次动作执行失败'
            this.emit({ kind: 'need-human', reason: this.reason, hint: '请手动推进一步后结束接管' })
          }
        } else {
          this.screenFails.delete(sig)
        }
        // 自动化产生的指针/键盘事件也会落进用户输入探测器，动作做完就清掉，
        // 否则下一轮会把自己的操作误判成「用户想接管」
        await this.deps.driver.clearUserInput()
        store.updateMeta({ steps: this.step, aiCalls: this.aiCalls })
        store.save()
        this.emit({ kind: 'budget', snapshot: this.snapshot() })
      }

      await this.finalizeAndFinish()
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.log('error', `探索中断：${this.lastError}`)
      // 崩溃也把图收拾一遍，但不覆盖 failed 状态：用户得知道这轮是断掉的
      this.runFinalize()
      this.setState('failed', this.lastError)
    }
  }

  /* ------------------------------ 各阶段实现 ------------------------------ */

  private pendingEdgeLabel = ''

  /** 把当前界面写进图谱，必要时新建节点与连线 */
  private applyScreen(
    probe: ProbeResult,
    shot: { png: Buffer; jpegBase64: string } | null,
    action: AiAction,
    known: FlowNode | undefined
  ): { isNew: boolean; nodeId: string } {
    const store = this.store!
    const sig = signatureHash(probe)
    const lanes: FlowLane[] = []
    const nodes: FlowNode[] = []
    const edges: FlowEdge[] = []

    let nodeId: string
    let isNew = false

    if (known) {
      nodeId = known.id
    } else {
      const lane = store.ensureLane(action.screen.lane, action.screen.laneTitle || action.screen.lane)
      if (lane) lanes.push(lane)
      const node = store.addNode({
        id: action.screen.id,
        signatureHash: sig,
        lane: action.screen.lane,
        kind: action.screen.kind,
        title: action.screen.title,
        note: probe.notices.length ? probe.notices.join(' / ') : undefined,
        url: probe.url,
        createdBy: 'ai',
        probe,
      })
      if (shot) store.saveShot(node.id, shot.png, shot.jpegBase64)
      nodes.push(node)
      nodeId = node.id
      isNew = true
      this.screens += 1
    }

    if (this.currentNodeId && this.currentNodeId !== nodeId) {
      const type = this.classifyEdge(action, probe)
      const edge = store.addEdge(this.currentNodeId, nodeId, this.pendingEdgeLabel || action.edgeLabel, type, 'ai')
      if (edge) edges.push(edge)
    }

    this.currentNodeId = nodeId
    // 本步的标注属于「当前动作导致的下一次转移」，先存着，下一轮建边时用
    this.pendingEdgeLabel = action.edgeLabel

    if (lanes.length || nodes.length || edges.length) {
      store.layoutAndSave()
      this.deps.emitPatch({ addedLanes: lanes, addedNodes: nodes, addedEdges: edges })
    }
    return { isNew, nodeId }
  }

  private classifyEdge(action: AiAction, probe: ProbeResult): FlowEdge['type'] {
    if (probe.notices.length) return 'branch'
    if (action.action === 'back') return 'back'
    if (action.screen.kind === 'validation') return 'branch'
    return 'primary'
  }

  /** 解析失败时把错误附回去重试，仍不行则返回 null 交给兜底 */
  private async decideWithRetry(probe: ProbeResult, jpeg: string): Promise<AiAction | null> {
    const store = this.store!
    let lastErr = ''

    for (let attempt = 0; attempt <= MAX_PARSE_RETRY; attempt++) {
      if (this.pauseRequested || this.stopRequested || this.takeoverRequested) return null
      this.abort = new AbortController()
      this.aiCalls += 1
      this.emit({ kind: 'ai-request', step: this.step })
      const askedAt = Date.now()
      /*
       * 录像的输入侧只记可核对的要点：地址、界面签名、元素个数、可选动作数。
       * 截图与完整提示词一概不记——前者体积上不可行，后者是页面原文，
       * 而回放时这些本来就会由当时的页面重新产生，记下来只为对齐时能核对。
       */
      const ask = {
        step: this.step,
        attempt,
        url: probe.url,
        sig: signatureHash(probe),
        elements: probe.elements.length,
        notices: probe.notices.length,
        forbidden: this.forbidden.length,
      }
      try {
        const action = await this.deps.ai.decide(
          {
            goal: this.goal,
            step: this.step,
            budgets: {
              stepsLeft: Math.max(0, this.budgets.maxSteps - this.step),
              aiCallsLeft: Math.max(0, this.budgets.maxAiCalls - this.aiCalls),
            },
            screenshotJpegBase64: jpeg,
            probe,
            knownLanes: store.get().lanes,
            knownNodes: store.get().nodes.map((n) => ({ id: n.id, title: n.title, lane: n.lane })),
            currentNodeId: this.currentNodeId,
            lastOutcome: [this.lastOutcome, lastErr && `上一次输出无法解析：${lastErr}，请严格按结构重新输出`]
              .filter(Boolean)
              .join('\n'),
            forbidden: this.forbidden,
          },
          this.abort.signal
        )
        store.appendAi({ runId: this.runId, kind: 'decide', ms: Date.now() - askedAt, ask, action })
        return action
      } catch (e) {
        if (this.pauseRequested || this.stopRequested || this.takeoverRequested) return null
        if (e instanceof ActionParseError) {
          lastErr = e.message
          store.appendAi({ runId: this.runId, kind: 'parse-error', ms: Date.now() - askedAt, ask, error: e.message })
          this.log('warn', `AI 输出解析失败（第 ${attempt + 1} 次）：${e.message}`)
          continue
        }
        const msg = e instanceof Error ? e.message : String(e)
        store.appendAi({ runId: this.runId, kind: 'call-error', ms: Date.now() - askedAt, ask, error: msg })
        this.log('warn', `AI 调用失败：${msg}`)
        if (attempt === MAX_PARSE_RETRY) throw e
        await delay(1200 * (attempt + 1))
      } finally {
        this.abort = null
      }
    }
    return null
  }

  /** 按 idx 重查元素后执行动作。枚举顺序对不上说明界面变了，判为失败让 AI 重看 */
  private async execute(action: AiAction, probe: ProbeResult): Promise<boolean> {
    const driver = this.deps.driver
    try {
      switch (action.action) {
        case 'click':
        case 'fill': {
          const target = probe.elements.find((e) => e.idx === action.targetIdx)
          if (!target) {
            this.fail(`找不到编号为 ${action.targetIdx} 的元素`)
            return false
          }
          if (target.disabled) {
            this.fail(`元素「${target.text || target.placeholder || target.name}」处于禁用态`)
            return false
          }
          const fresh = await driver.probe()
          const same = fresh.elements.find((e) => e.idx === action.targetIdx)
          if (!same || same.tag !== target.tag || same.name !== target.name) {
            this.fail('界面在决策与执行之间发生了变化，已重新观察')
            return false
          }
          const cx = same.rect.x + same.rect.w / 2
          const cy = same.rect.y + same.rect.h / 2
          if (action.action === 'click') {
            await driver.tap(cx, cy)
            this.lastOutcome = `已点击「${same.text || same.placeholder || same.name}」`
          } else {
            const wrote = await driver.fillAt(cx, cy, action.value ?? '', {
              name: same.name || undefined,
              placeholder: same.placeholder || undefined,
            })
            await driver.blurActive()
            if (!wrote) {
              this.fail(`未能把内容写入「${same.placeholder || same.name || same.text}」`)
              return false
            }
            this.lastOutcome = `已在「${same.placeholder || same.name || same.text}」中填入测试数据`
          }
          return true
        }
        case 'scroll':
          await driver.scrollBy(action.scrollDelta ?? 600)
          this.lastOutcome = '已滚动页面'
          return true
        case 'back':
          await driver.back()
          this.lastOutcome = '已返回上一页'
          return true
        default:
          return true
      }
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  /** 人工接管：放开输入屏蔽，被动录制直到用户结束 */
  private async runTakeover(): Promise<void> {
    const store = this.store!
    this.takeoverRequested = false
    this.takeoverEndRequested = false
    const reasonSource = this.reason
    this.takeoverAt = Date.now()
    this.takeoverSeq += 1
    const seq = this.takeoverSeq
    this.setState('awaiting_human', this.reason)
    await this.deps.driver.clearUserInput()

    this.watcher = new WatchRecorder(this.deps.driver, store, {
      lane: MANUAL_LANE_ID,
      laneTitle: MANUAL_LANE_TITLE,
      // 剩余额度按本轮起算点算，否则二次探索时这里会算成负数并被夹到 1
      maxScreens: Math.max(1, this.budgets.maxScreens - (this.screens - this.base.screens)),
      onPatch: (patch) => this.deps.emitPatch(patch),
      capture: () => this.deps.captureArchival(),
      // 控件事件与会话记录要能对上：哪一轮、第几次接管
      meta: { runId: this.runId, takeoverSeq: seq },
    })

    const stopWatch = () => this.takeoverEndRequested || this.stopRequested
    const result = await this.watcher.run(this.currentNodeId, stopWatch)
    this.watcher = null

    this.screens += result.nodes.length
    if (result.lastNodeId) this.currentNodeId = result.lastNodeId

    /*
     * 接管区间落盘。
     *
     * 三种退出路径过去产生的记录一模一样（都只有一条 resuming），
     * 事后分不出是用户点了结束、被整体停止，还是录制器自己抓满了额度——
     * 而最后那种恰恰意味着用户还在操作、系统单方面停了录制。
     */
    this.record({
      kind: 'takeover',
      seq,
      startedAt: this.takeoverAt,
      endedAt: Date.now(),
      endedBy: this.stopRequested ? 'stop' : this.takeoverEndRequested ? 'user' : 'max-screens',
      reasonSource,
      nodesAdded: result.nodes.length,
    })
    this.takeoverAt = 0

    // 把人工完成的事情告诉 AI，让它接着往下走
    const done = result.nodes.map((n) => n.note).filter(Boolean).join('；')
    this.lastOutcome = `人工接管完成${done ? `：${done}` : ''}。当前界面已变化，请基于新界面继续。`
    this.reason = undefined
    await this.deps.driver.clearUserInput()
    this.setState('resuming')
    await delay(400)
    this.setState('observing')
  }

  /* --------------------------------- 工具 --------------------------------- */

  private detectHumanNeeded(probe: ProbeResult): string | null {
    if (probe.iframeHosts.some((h) => CAPTCHA_IFRAME.test(h))) return '页面包含第三方验证码 iframe，需要真人完成'
    if (CAPTCHA_URL.test(new URL(probe.url, 'http://x').pathname)) return '已进入验证页面，需要真人完成'
    if (PAYMENT_HINTS.test(probe.url)) return '已进入支付相关页面，交由真人处理'
    return null
  }

  /** A→B→A→B 形式的震荡 */
  private isOscillating(): boolean {
    const h = this.sigHistory
    if (h.length < 4) return false
    const [a, b, c, d] = h.slice(-4)
    return a === c && b === d && a !== b
  }

  private forbid(text: string): void {
    if (!this.forbidden.includes(text)) this.forbidden.push(text)
    if (this.forbidden.length > 6) this.forbidden.shift()
  }

  /**
   * 预算检查。
   *
   * 四项是短路顺序，同时触顶只会报第一项——所以触顶记录里要把四项的用量
   * 全带上，否则事后只知道「步数到了」，不知道其余三项当时离上限还有多远。
   * 时长那一项过去连阈值都不报，现在统一写成「用量／上限」。
   */
  private checkBudget(): { which: BudgetKey; used: number; limit: number; text: string } | null {
    const u = this.used()
    const b = this.budgets
    if (u.step >= b.maxSteps)
      return { which: 'steps', used: u.step, limit: b.maxSteps, text: `已达步数上限（${b.maxSteps} 步）` }
    if (u.aiCalls >= b.maxAiCalls)
      return { which: 'aiCalls', used: u.aiCalls, limit: b.maxAiCalls, text: `已达 AI 调用上限（${b.maxAiCalls} 次）` }
    if (u.screens >= b.maxScreens)
      return { which: 'screens', used: u.screens, limit: b.maxScreens, text: `已达截图数上限（${b.maxScreens} 张）` }
    if (u.ms > b.maxDurationMs)
      return {
        which: 'duration',
        used: u.ms,
        limit: b.maxDurationMs,
        text: `已达时长上限（${Math.round(b.maxDurationMs / 60000)} 分钟）`,
      }
    return null
  }

  /** 预算触顶。四项用量一并落盘，事后才判定得了是哪一项、离上限多远 */
  private toPausedByBudget(stop: { which: BudgetKey; used: number; limit: number; text: string }): void {
    const u = this.used()
    this.record({
      kind: 'budget-stop',
      which: stop.which,
      value: stop.used,
      limit: stop.limit,
      used: u,
      budgets: this.budgets,
      elapsedMs: this.elapsedMs(),
    })
    this.toPaused(stop.text)
  }

  private fail(msg: string): void {
    this.lastOutcome = `上一步动作未能执行：${msg}`
    this.log('warn', `　动作失败：${msg}`)
    this.emit({ kind: 'action-failed', step: this.step, error: msg })
  }

  private toPaused(reason: string): void {
    this.reason = reason
    this.pauseRequested = false
    this.setState('paused', reason)
    this.log('info', `已暂停：${reason}`)
  }

  /**
   * 收尾整理 + 收束会话。
   *
   * 对外契约：**绝不 reject**。它是从 loop 的 try 里 await 的，一旦抛出就会掉进
   * catch 被判成 failed——一次成功的探索会显示成「已中断」。
   */
  private async finalizeAndFinish(): Promise<void> {
    this.setState('finishing')
    const verdict = await this.askAiToReview().catch(() => undefined)
    this.runFinalize(verdict)
    this.toFinished()
  }

  /**
   * 收尾的 AI 那一层：把人工接管的界面归类、在重复连线里挑该留的。
   *
   * 两件事分两次问：输入完全不同，一次失败不该拖累另一次，而且两个小请求
   * 比一个大请求更不容易被 max_tokens 截断。
   * 全程失败即回落——确定性层已经把八成的事情做完了，这里只是锦上添花，
   * 所以不重试、超时也比每步决策短一半。
   */
  private async askAiToReview(): Promise<AiVerdict | undefined> {
    const store = this.store
    if (!store || this.stopRequested) return undefined
    // 预算耗尽后仍允许收尾用两次，否则「跑满额度 → 结束」这条最常见的路径永远享受不到整理
    if (this.aiCalls > this.budgets.maxAiCalls + 8) return undefined

    const graph = store.get()
    const verdict: AiVerdict = {}

    const candidates = graph.nodes.filter((n) => n.lane === MANUAL_LANE_ID).map((n) => n.id)
    const inherited = inheritLanes(graph)
    if (candidates.length) {
      const known = new Set(graph.lanes.map((l) => l.id).filter((id) => id !== MANUAL_LANE_ID))
      const out = await this.runReview(buildLaneClassifyTask(graph, candidates, inherited), '归类')
      if (out) {
        const s = sanitizeLaneAssignments(out.assignments, candidates, inherited, known)
        verdict.lanes = s.lanes
        verdict.laneTitles = s.titles
        if (s.rejected) this.log('warn', `归类结果有 ${s.rejected} 条不符合约束，已按上游泳道归类`)
      }
    }

    const groups = planCleanup(graph).groups
    if (groups.length && !this.stopRequested) {
      const out = await this.runReview(buildEdgeReviewTask(graph, groups), '连线审查')
      if (out) {
        const s = sanitizeEdgeReview(out.groups, groups)
        verdict.dropEdgeIds = s.dropIds
        verdict.relabel = s.relabel
        if (s.rejected) this.log('warn', `连线审查有 ${s.rejected} 组不符合约束，已保留原状`)
      }
    }

    return verdict
  }

  /** 单次收尾问询。失败只记一行日志，绝不向上抛 */
  private async runReview<T>(task: ReviewTask<T>, what: string): Promise<T | null> {
    // 接管期 this.abort 是 null，不挂上去的话用户点结束要干等到超时
    this.abort = new AbortController()
    this.aiCalls += 1
    try {
      return await this.deps.ai.review(task, this.abort.signal)
    } catch (e) {
      this.log('warn', `收尾${what}未完成：${e instanceof Error ? e.message : String(e)}，已按确定性规则整理`)
      return null
    } finally {
      this.abort = null
    }
  }

  /**
   * 确定性收尾。整个包在 try 里：图整理失败也不该让一轮成功的探索显示成中断。
   * 只跑一次——loop 的正常出口与 catch 分支都会调它。
   */
  private runFinalize(verdict?: AiVerdict): void {
    if (this.finalizeDone || !this.store) return
    this.finalizeDone = true
    try {
      const r = finalizeGraph(this.store, verdict)
      this.log('info', describeFinalize(r))
      if (r.merged || r.dropped) {
        this.store.appendSession({ kind: 'cleanup', merged: r.merged, dropped: r.dropped, moved: r.moved })
      }
      this.deps.emitPatch(r.patch)
    } catch (e) {
      this.log('warn', `图谱整理未完成：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private toFinished(): void {
    this.store?.updateMeta({ steps: this.step, aiCalls: this.aiCalls })
    this.store?.save()
    this.setState('finished')
    this.emit({ kind: 'finished', snapshot: this.snapshot() })
  }

  private setState(next: SessionState, reason?: string): void {
    const from = this.state
    this.state = next
    if (reason) this.reason = reason
    /*
     * 时长只在运行区段里走表。
     *
     * 挂在状态机上而不是散在各处：暂停、人工接管、收尾、结束都要正确开合，
     * 逐处去加迟早漏一个，而漏掉的那一个就是「明明没在跑，时长却在涨」。
     */
    const wasRunning = RUNNING_STATES.includes(from)
    const nowRunning = RUNNING_STATES.includes(next)
    if (wasRunning && !nowRunning && this.segmentAt) {
      this.runMsBefore += Date.now() - this.segmentAt
      this.segmentAt = 0
    } else if (!wasRunning && nowRunning) {
      this.segmentAt = Date.now()
    }
    this.record({ kind: 'state', from, to: next, reason, step: this.step })
    this.emit({ kind: 'state-changed', from, to: next, reason })
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.record({ kind: 'log', level, message, step: this.step })
    this.emit({ kind: 'log', level, message })
  }

  /**
   * 控制指令审计。
   *
   * 被忽略的调用同样要记：用户点「继续」而会话不在暂停态、或者应用重启后
   * 会话已经不存在，这两种情况过去零痕迹。而「点了继续但什么都没发生」
   * 恰恰是需要事后区分的——是指令没被接受，还是接受了又立刻停下。
   */
  private control(op: ControlOp, accepted: boolean, note?: string): void {
    this.record({ kind: 'control', op, accepted, stateBefore: this.state, note })
    log.info('session', `控制指令 ${op}${accepted ? '' : '（被忽略）'} · 当前状态 ${this.state}`)
  }

  /** 所有落盘记录的唯一出口：统一带上运行标识，多轮记录才切得开 */
  private record(entry: Record<string, unknown>): void {
    this.store?.appendSession({ runId: this.runId, ...entry })
  }

  private emit(event: SessionEvent): void {
    this.deps.emit(event, this.snapshot())
  }
}

