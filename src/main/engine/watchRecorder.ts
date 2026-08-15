import type { FlowEdge, FlowLane, FlowNode, GraphPatch, ProbeResult } from '@shared/types'
import type { GraphStore } from './graphStore'
import { delay, type PageDriver } from './PageDriver'
import { signatureHash } from './signature'

/**
 * 页面内的事件记录器。
 * 只记录事件类型与被操作控件的标识（文案 / name / placeholder），
 * 绝不读取 value——人工接管时输入的密码等内容不会离开目标页。
 */
const EVENT_RECORDER = `(() => {
  if (window.__ufcRecorderInstalled) return true
  window.__ufcRecorderInstalled = true
  window.__ufcEvents = []
  const label = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label')
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim()
    return (aria || t || (el.getAttribute && el.getAttribute('placeholder')) || '').slice(0, 40)
  }
  const rec = (type, target) => {
    const el = (target && target.closest && target.closest('button,a,label,input,textarea,select,[role="button"]')) || target
    if (!el || !el.tagName) return
    window.__ufcEvents.push({
      t: Date.now(),
      type,
      tag: el.tagName.toLowerCase(),
      inputType: el.tagName === 'INPUT' ? el.getAttribute('type') || 'text' : '',
      name: (el.getAttribute && (el.getAttribute('name') || el.id)) || '',
      placeholder: (el.getAttribute && el.getAttribute('placeholder')) || '',
      label: el.tagName === 'INPUT' ? '' : label(el),
    })
    if (window.__ufcEvents.length > 500) window.__ufcEvents.splice(0, 200)
  }
  document.addEventListener('click', (e) => rec('click', e.target), true)
  document.addEventListener('change', (e) => rec('change', e.target), true)
  document.addEventListener('submit', (e) => rec('submit', e.target), true)
  return true
})()`

const DRAIN_EVENTS = `(() => { const e = window.__ufcEvents || []; window.__ufcEvents = []; return e })()`

export interface WatchEvent {
  type: string
  tag: string
  inputType: string
  name: string
  placeholder: string
  label: string
}

export interface WatchResult {
  lanes: FlowLane[]
  nodes: FlowNode[]
  edges: FlowEdge[]
  lastNodeId: string | null
  lastProbe: ProbeResult | null
}

/**
 * 人工接管期的被动录制：界面每发生一次实质变化就截图入库。
 * 沿用「连续两次签名一致才算稳定」的双确认，滤掉倒计时跳秒、轮播这类噪声。
 */
export class WatchRecorder {
  private running = false
  private lastSig: string | null = null
  private pendingSig: string | null = null

  constructor(
    private readonly driver: PageDriver,
    private readonly store: GraphStore,
    private readonly opts: {
      lane: string
      laneTitle: string
      onPatch: (patch: Omit<GraphPatch, 'projectId'>) => void
      /** 抓存档图。与探索期同源，抓图时会用静帧顶住屏幕区 */
      capture: () => Promise<{ png: Buffer; jpegBase64: string }>
      maxScreens: number
    }
  ) {}

  async install(): Promise<void> {
    await this.driver.evalInPage(EVENT_RECORDER).catch(() => undefined)
  }

  /** 从 fromNodeId 起接管，返回接管期新增的节点与边 */
  async run(fromNodeId: string | null, shouldStop: () => boolean): Promise<WatchResult> {
    this.running = true
    this.lastSig = null
    this.pendingSig = null

    const lanes: FlowLane[] = []
    const nodes: FlowNode[] = []
    const edges: FlowEdge[] = []
    let prevNodeId = fromNodeId
    let lastProbe: ProbeResult | null = null
    let count = 0

    await this.install()

    while (this.running && !shouldStop() && count < this.opts.maxScreens) {
      let probe: ProbeResult
      try {
        probe = await this.driver.probe()
      } catch {
        // 导航中途探针会失败，等下一轮；顺带补装记录器（页面换了就丢了）
        await delay(700)
        await this.install()
        continue
      }
      lastProbe = probe
      const sig = signatureHash(probe)

      if (sig !== this.lastSig && sig === this.pendingSig) {
        const events = ((await this.driver.evalInPage(DRAIN_EVENTS).catch(() => [])) as WatchEvent[]) ?? []
        this.store.appendEvents(events)

        const existing = this.store.findBySignature(sig)
        let nodeId: string
        if (existing) {
          nodeId = existing.id
        } else {
          const lane = this.store.ensureLane(this.opts.lane, this.opts.laneTitle)
          if (lane) lanes.push(lane)
          const node = this.store.addNode({
            id: `manual-${count + 1}`,
            signatureHash: sig,
            lane: this.opts.lane,
            kind: probe.notices.length ? 'validation' : 'manual',
            title: titleFrom(probe),
            note: describeEvents(events),
            url: probe.url,
            createdBy: 'human',
            probe,
          })
          const shot = await this.opts.capture()
          this.store.saveShot(node.id, shot.png, shot.jpegBase64)
          nodes.push(node)
          nodeId = node.id
        }

        if (prevNodeId && prevNodeId !== nodeId) {
          const edge = this.store.addEdge(prevNodeId, nodeId, describeEvents(events) || '人工操作', 'branch', 'human')
          if (edge) edges.push(edge)
        }
        prevNodeId = nodeId
        this.lastSig = sig
        count += 1

        this.store.layoutAndSave()
        this.opts.onPatch({ addedLanes: lanes.splice(0), addedNodes: nodes.slice(-1), addedEdges: edges.slice(-1) })
      }

      this.pendingSig = sig
      await delay(700)
    }

    this.running = false
    return { lanes, nodes, edges, lastNodeId: prevNodeId, lastProbe }
  }

  stop(): void {
    this.running = false
  }
}

function titleFrom(p: ProbeResult): string {
  const head = p.text.split(' ').slice(0, 8).join(' ').trim()
  const prefix = p.hasDialog ? '弹窗态' : '页面态'
  return `${prefix}：${head || p.title || p.url}`.slice(0, 60)
}

/** 把控件事件序列翻成一句操作标注。只用控件文案，不含输入值 */
function describeEvents(events: WatchEvent[]): string {
  if (!events.length) return ''
  const parts = events.slice(-4).map((e) => {
    const target = e.label || e.placeholder || e.name || e.tag
    if (e.type === 'click') return `点击「${target}」`
    if (e.type === 'change') return `输入${target ? `「${target}」` : ''}`
    if (e.type === 'submit') return '提交'
    return e.type
  })
  return [...new Set(parts)].join(' · ').slice(0, 100)
}
