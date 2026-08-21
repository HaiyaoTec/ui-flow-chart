import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assignLayout, relayoutAll, UNPLACED } from '@shared/canvas-core/autoLayout'
import type { FlowEdge, FlowGraph, FlowLane, FlowNode, GraphPatch, NodeKind, ProbeResult } from '@shared/types'
import { log } from '../log'
import { projectDir, readJson, writeJsonAtomic } from '../store/paths'

const emptyGraph = (targetUrl: string, deviceId: string): FlowGraph => ({
  version: 1,
  meta: { targetUrl, deviceId, steps: 0, aiCalls: 0, updatedAt: new Date().toISOString() },
  lanes: [],
  nodes: [],
  edges: [],
})

/**
 * 图谱的持有者：内存里维护当前图，每次变更原子落盘，并把增量补丁交给调用方广播。
 * 画布只吃增量，不做全量重绘。
 */
export class GraphStore {
  private graph: FlowGraph
  private readonly dir: string
  private bySignature = new Map<string, string>()

  constructor(
    private readonly projectId: string,
    targetUrl: string,
    deviceId: string
  ) {
    this.dir = projectDir(projectId)
    this.graph = readJson<FlowGraph>(join(this.dir, 'graph.json'), emptyGraph(targetUrl, deviceId))
    this.graph.meta.targetUrl = targetUrl
    this.graph.meta.deviceId = deviceId
    for (const n of this.graph.nodes) {
      this.bySignature.set(n.signatureHash, n.id)
      // 合并进来的别名签名同样指向本节点，防止被合并的界面再次被建出
      for (const s of n.aliasSigs ?? []) this.bySignature.set(s, n.id)
    }
  }

  get(): FlowGraph {
    return this.graph
  }

  findBySignature(hash: string): FlowNode | undefined {
    const id = this.bySignature.get(hash)
    return id ? this.graph.nodes.find((n) => n.id === id) : undefined
  }

  hasEdge(from: string, to: string, label: string): boolean {
    return this.graph.edges.some((e) => e.from === from && e.to === to && e.label === label)
  }

  /** id 冲突时自动加后缀，保证节点 id 唯一 */
  private uniqueNodeId(base: string): string {
    let id = base || 'screen'
    let n = 2
    while (this.graph.nodes.some((x) => x.id === id)) id = `${base}-${n++}`
    return id
  }

  ensureLane(id: string, title: string): FlowLane | null {
    if (this.graph.lanes.some((l) => l.id === id)) return null
    const lane: FlowLane = { id, title: title || id }
    this.graph.lanes.push(lane)
    return lane
  }

  addNode(input: {
    id: string
    signatureHash: string
    lane: string
    kind: NodeKind
    title: string
    note?: string
    url: string
    createdBy: 'ai' | 'human'
    probe?: ProbeResult
  }): FlowNode {
    const node: FlowNode = {
      id: this.uniqueNodeId(input.id),
      signatureHash: input.signatureHash,
      lane: input.lane,
      // 坐标由 assignLayout 在建边之后统一分配
      col: UNPLACED,
      sub: UNPLACED,
      kind: input.kind,
      title: input.title,
      note: input.note,
      url: input.url,
      createdBy: input.createdBy,
      shot: '',
      probeSummary: input.probe
        ? {
            elements: input.probe.elements.slice(0, 20).map((e) => e.text || e.placeholder || e.name || e.tag),
            notices: input.probe.notices,
            hasDialog: input.probe.hasDialog,
          }
        : undefined,
      ts: new Date().toISOString(),
    }
    node.shot = node.id
    this.graph.nodes.push(node)
    this.bySignature.set(node.signatureHash, node.id)
    return node
  }

  addEdge(from: string, to: string, label: string, type: FlowEdge['type'], createdBy: 'ai' | 'human'): FlowEdge | null {
    if (from === to && type !== 'back') return null
    if (this.hasEdge(from, to, label)) return null
    const edge: FlowEdge = {
      id: `e${this.graph.edges.length + 1}-${Date.now().toString(36)}`,
      from,
      to,
      label,
      type,
      createdBy,
      ts: new Date().toISOString(),
    }
    this.graph.edges.push(edge)
    return edge
  }

  /**
   * 截图与缩略图落盘。缩略图在这一步就生成，导出时不必再压一次。
   *
   * 空内容一律不写：0 字节的 png 在画布与导出里都是一个坏掉的图，
   * 而文件存在会让人以为「拍到了、只是内容不对」，比缺图更难查。
   */
  saveShot(nodeId: string, png: Buffer, jpegBase64: string): void {
    if (png.length) writeFileSync(join(this.dir, 'screens', `${nodeId}.png`), png)
    if (jpegBase64) writeFileSync(join(this.dir, 'screens', `${nodeId}.thumb.jpg`), Buffer.from(jpegBase64, 'base64'))
  }

  updateMeta(patch: Partial<FlowGraph['meta']>): void {
    this.graph.meta = { ...this.graph.meta, ...patch, updatedAt: new Date().toISOString() }
  }

  updateNode(id: string, patch: Partial<FlowNode>): FlowNode | null {
    const n = this.graph.nodes.find((x) => x.id === id)
    if (!n) return null
    Object.assign(n, patch, { id: n.id })
    return n
  }

  updateEdge(id: string, patch: Partial<FlowEdge>): FlowEdge | null {
    const e = this.graph.edges.find((x) => x.id === id)
    if (!e) return null
    Object.assign(e, patch, { id: e.id })
    return e
  }

  updateLane(id: string, patch: Partial<FlowLane>): FlowLane | null {
    const l = this.graph.lanes.find((x) => x.id === id)
    if (!l) return null
    Object.assign(l, patch, { id: l.id })
    return l
  }

  /* ------------------------------ 排除与合并 ------------------------------ */

  /** 界面签名是否在人工删除的排除清单里。命中就不再为它建节点 */
  isExcluded(sig: string): boolean {
    return this.graph.excluded?.includes(sig) ?? false
  }

  /** 把签名记入排除清单。人工删除节点时调用，被删界面再探索到也不复活 */
  exclude(sigs: string[]): void {
    const set = new Set(this.graph.excluded ?? [])
    for (const s of sigs) if (s) set.add(s)
    this.graph.excluded = [...set]
  }

  /**
   * 把 loser 合并进 keeper：连线整体重定向、签名转为 keeper 的别名、节点删除。
   * 重定向后可能出现的重复连线交给确定性清理层收敛，这里不做去重。
   */
  mergeNodes(keeperId: string, loserId: string): boolean {
    const keeper = this.graph.nodes.find((n) => n.id === keeperId)
    const loser = this.graph.nodes.find((n) => n.id === loserId)
    if (!keeper || !loser || keeperId === loserId) return false

    for (const e of this.graph.edges) {
      if (e.from === loserId) e.from = keeperId
      if (e.to === loserId) e.to = keeperId
    }
    keeper.aliasSigs = [...new Set([...(keeper.aliasSigs ?? []), loser.signatureHash, ...(loser.aliasSigs ?? [])])]
    for (const s of keeper.aliasSigs) this.bySignature.set(s, keeperId)
    this.graph.nodes = this.graph.nodes.filter((n) => n.id !== loserId)
    return true
  }

  /** 按 id 批量删边，返回真正删掉的那些。收尾整理合并重复连线时用 */
  removeEdges(ids: string[]): string[] {
    if (!ids.length) return []
    const gone = new Set(ids)
    const hit = this.graph.edges.filter((e) => gone.has(e.id)).map((e) => e.id)
    if (hit.length) this.graph.edges = this.graph.edges.filter((e) => !gone.has(e.id))
    return hit
  }

  /**
   * 回收没有任何节点的泳道，返回被回收的 id。
   *
   * 空泳道会画成一整行卡片高的虚线框，还占着泳道开关。
   * 图上一个节点都没有时什么都不做——那是空项目，不是「泳道空了」。
   */
  pruneEmptyLanes(): string[] {
    if (!this.graph.nodes.length) return []
    const used = new Set(this.graph.nodes.map((n) => n.lane))
    const gone = this.graph.lanes.filter((l) => !used.has(l.id)).map((l) => l.id)
    if (gone.length) this.graph.lanes = this.graph.lanes.filter((l) => used.has(l.id))
    return gone
  }

  deleteNode(id: string): void {
    this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id)
    this.graph.edges = this.graph.edges.filter((e) => e.from !== id && e.to !== id)
    for (const [sig, nid] of this.bySignature) if (nid === id) this.bySignature.delete(sig)
  }

  /** 建边之后调用：为新节点分配坐标并落盘，返回坐标发生变化的节点 */
  layoutAndSave(): FlowNode[] {
    const changed = assignLayout(this.graph)
    this.save()
    return changed
  }

  relayout(): FlowGraph {
    relayoutAll(this.graph)
    this.save()
    return this.graph
  }

  save(): void {
    this.graph.meta.updatedAt = new Date().toISOString()
    writeJsonAtomic(join(this.dir, 'graph.json'), this.graph)
  }

  /**
   * 追加落盘，写失败一律吞掉。
   *
   * 这里绝不能抛：调用方 appendSession 就挂在探索主循环的日志路径上，
   * 而主循环的 catch 块里还会再写一次日志。磁盘满或目录只读时，
   * 异常会在 catch 块内二次抛出 → loop() 返回被拒绝的 Promise →
   * 调用方是 void 调用、没有兜底 → 探索静默停住，磁盘上一行记录都没有。
   */
  private appendSafe(file: string, text: string): void {
    try {
      appendFileSync(join(this.dir, file), text, 'utf8')
    } catch (e) {
      log.error('graphStore', `写入 ${file} 失败`, e)
    }
  }

  /** 每步事件追加落盘，供审计与崩溃后重放 */
  appendSession(entry: Record<string, unknown>): void {
    this.appendSafe('session.jsonl', JSON.stringify({ t: Date.now(), ...entry }) + '\n')
  }

  /** 探索轨迹追加落盘。只追加不修改，是图谱生成阶段的输入 */
  appendTrace(entry: Record<string, unknown>): void {
    this.appendSafe('trace.jsonl', JSON.stringify({ t: Date.now(), ...entry }) + '\n')
  }

  /**
   * AI 决策录像。
   *
   * 每一步问了什么（只记可核对的要点，不记截图与完整提示词）、答了什么，
   * 按顺序追加。有了它，本机可以把当时那一整轮探索原样重放一遍——
   * 探索走偏这类问题光看图谱结果是判断不出来的，得看它当时依据什么做的决定。
   */
  appendAi(entry: Record<string, unknown>): void {
    this.appendSafe('ai.jsonl', JSON.stringify({ t: Date.now(), ...entry }) + '\n')
  }

  /** 人工接管期的控件事件。只记控件标识，不含任何输入值 */
  appendEvents(entries: object[], meta?: Record<string, unknown>): void {
    if (!entries.length) return
    // 段落标记逐条合并：这个文件同样是多轮平铺追加的，
    // 不带标记就分不出某条事件属于哪一轮的第几次接管
    this.appendSafe('events.jsonl', entries.map((e) => JSON.stringify({ ...meta, ...e })).join('\n') + '\n')
  }

  patchOf(lanes: FlowLane[], nodes: FlowNode[], edges: FlowEdge[]): GraphPatch {
    return {
      addedLanes: lanes.length ? lanes : undefined,
      addedNodes: nodes.length ? nodes : undefined,
      addedEdges: edges.length ? edges : undefined,
      meta: this.graph.meta,
    }
  }

  get id(): string {
    return this.projectId
  }
}
