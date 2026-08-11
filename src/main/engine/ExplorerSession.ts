import {
  DEFAULT_BUDGETS,
  type AiAction,
  type FlowEdge,
  type FlowLane,
  type FlowNode,
  type ProbeResult,
  type ProjectMeta,
  type SessionBudgets,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
} from '@shared/types'
import type { IAiClient } from '../ai/types'
import { ActionParseError } from '../ai/parseAction'
import { GraphStore } from './graphStore'
import { delay, type PageDriver } from './PageDriver'
import { signatureHash } from './signature'
import { WatchRecorder } from './watchRecorder'

export interface SessionDeps {
  driver: PageDriver
  ai: IAiClient
  /** 打开目标站并铺好设备模拟 */
  openTarget: (url: string) => Promise<void>
  emit: (event: SessionEvent, snapshot: SessionSnapshot) => void
  emitPatch: (lanes: FlowLane[], nodes: FlowNode[], edges: FlowEdge[]) => void
}

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
    this.reason = undefined
    this.lastError = undefined
    this.currentNodeId = null
    this.lastOutcome = ''
    this.stopRequested = false
    this.pauseRequested = false
    this.takeoverRequested = false
    this.visits.clear()
    this.sigHistory = []
    this.screenFails.clear()
    this.screenActions.clear()
    this.forbidden = []
    this.noProgress = 0
    this.staleRounds = 0
    this.fallbackStreak = 0

    this.setState('launching')
    void this.loop()
    return this.snapshot()
  }

  pause(): SessionSnapshot {
    if (this.isRunning()) {
      this.pauseRequested = true
      // 掐断在途的 AI 请求，不必等它慢慢超时
      this.abort?.abort(new Error('用户暂停'))
    }
    return this.snapshot()
  }

  resume(): SessionSnapshot {
    if (this.state === 'paused') {
      this.pauseRequested = false
      this.reason = undefined
      this.setState('observing')
      void this.loop()
    }
    return this.snapshot()
  }

  stop(): SessionSnapshot {
    this.stopRequested = true
    this.watcher?.stop()
    this.abort?.abort(new Error('用户结束'))
    return this.snapshot()
  }

  /** 进入人工接管：放开输入屏蔽，转为被动录制 */
  async takeoverStart(reasonText = '用户主动接管'): Promise<SessionSnapshot> {
    if (this.state === 'awaiting_human') return this.snapshot()
    this.takeoverRequested = true
    this.reason = reasonText
    this.abort?.abort(new Error('转人工接管'))
    return this.snapshot()
  }

  async takeoverEnd(): Promise<SessionSnapshot> {
    // 用标志位而不是只调 watcher.stop()：结束请求可能早于录制器创建，
    // 那时 stop() 是空操作，会话就永远停在等待人工上
    this.takeoverEndRequested = true
    this.watcher?.stop()
    return this.snapshot()
  }

  private isRunning(): boolean {
    return !['idle', 'paused', 'finished', 'failed'].includes(this.state)
  }

  /* --------------------------------- 主循环 -------------------------------- */

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
        if (budgetStop) return this.toPaused(budgetStop)

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
              this.deps.emitPatch([], [], [edge])
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
          shot = await this.deps.driver.screenshot()
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
          return this.toFinished()
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
            return this.toFinished()
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

      this.toFinished()
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.log('error', `探索中断：${this.lastError}`)
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
      this.deps.emitPatch(lanes, nodes, edges)
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
      try {
        return await this.deps.ai.decide(
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
      } catch (e) {
        if (this.pauseRequested || this.stopRequested || this.takeoverRequested) return null
        if (e instanceof ActionParseError) {
          lastErr = e.message
          this.log('warn', `AI 输出解析失败（第 ${attempt + 1} 次）：${e.message}`)
          continue
        }
        const msg = e instanceof Error ? e.message : String(e)
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
    this.setState('awaiting_human', this.reason)
    await this.deps.driver.clearUserInput()

    this.watcher = new WatchRecorder(this.deps.driver, store, {
      lane: 'manual',
      laneTitle: '人工接管',
      maxScreens: Math.max(1, this.budgets.maxScreens - this.screens),
      onPatch: (lanes, nodes, edges) => this.deps.emitPatch(lanes, nodes, edges),
    })

    const stopWatch = () => this.takeoverEndRequested || this.stopRequested
    const result = await this.watcher.run(this.currentNodeId, stopWatch)
    this.watcher = null

    this.screens += result.nodes.length
    if (result.lastNodeId) this.currentNodeId = result.lastNodeId

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

  private checkBudget(): string | null {
    if (this.step >= this.budgets.maxSteps) return `已达步数上限（${this.budgets.maxSteps} 步）`
    if (this.aiCalls >= this.budgets.maxAiCalls) return `已达 AI 调用上限（${this.budgets.maxAiCalls} 次）`
    if (this.screens >= this.budgets.maxScreens) return `已达截图数上限（${this.budgets.maxScreens} 张）`
    if (this.startedAt && Date.now() - new Date(this.startedAt).getTime() > this.budgets.maxDurationMs)
      return '已达时长上限'
    return null
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
    this.store?.appendSession({ kind: 'state', from, to: next, reason, step: this.step })
    this.emit({ kind: 'state-changed', from, to: next, reason })
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.store?.appendSession({ kind: 'log', level, message, step: this.step })
    this.emit({ kind: 'log', level, message })
  }

  private emit(event: SessionEvent): void {
    this.deps.emit(event, this.snapshot())
  }
}

