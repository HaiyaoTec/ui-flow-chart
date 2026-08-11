import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assignLayout, relayoutAll, UNPLACED } from '@shared/canvas-core/autoLayout'
import type { FlowEdge, FlowGraph, FlowLane, FlowNode, GraphPatch, NodeKind, ProbeResult } from '@shared/types'
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
    for (const n of this.graph.nodes) this.bySignature.set(n.signatureHash, n.id)
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

  /** 截图与缩略图落盘。缩略图在这一步就生成，导出时不必再压一次 */
  saveShot(nodeId: string, png: Buffer, jpegBase64: string): void {
    writeFileSync(join(this.dir, 'screens', `${nodeId}.png`), png)
    writeFileSync(join(this.dir, 'screens', `${nodeId}.thumb.jpg`), Buffer.from(jpegBase64, 'base64'))
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

  /** 每步事件追加落盘，供审计与崩溃后重放 */
  appendSession(entry: Record<string, unknown>): void {
    appendFileSync(join(this.dir, 'session.jsonl'), JSON.stringify({ t: Date.now(), ...entry }) + '\n', 'utf8')
  }

  /** 人工接管期的控件事件。只记控件标识，不含任何输入值 */
  appendEvents(entries: object[]): void {
    if (!entries.length) return
    appendFileSync(
      join(this.dir, 'events.jsonl'),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8'
    )
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
