import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiAction, FlowGraph, GraphPatch, ProbeResult, ProjectMeta } from '@shared/types'

/*
 * 结构层建图的正确性测试。
 *
 * 生成流程重划后，探索问询只输出动作；节点由引擎机械命名（带 draft 标记），
 * 连线标注由「上一步实际执行成功的动作」机械生成——标注与转移必须严格对应，
 * 且执行失败的动作不得污染下一条边。语义补齐由图谱生成阶段负责，不在本测试范围。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ufc-edge-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir, isPackaged: false },
}))

type Session = import('../../src/main/engine/ExplorerSession').ExplorerSession
type Deps = import('../../src/main/engine/ExplorerSession').SessionDeps

let ExplorerSession: typeof import('../../src/main/engine/ExplorerSession').ExplorerSession
let projectDir: (id: string) => string

beforeAll(async () => {
  ExplorerSession = (await import('../../src/main/engine/ExplorerSession')).ExplorerSession
  projectDir = (await import('../../src/main/store/paths')).projectDir
})

/** 每个路径一屏：url 与正文都不同，签名互不相同 */
const probeOf = (path: string): ProbeResult => ({
  url: `http://site.test${path}`,
  title: `页面${path}`,
  hasDialog: false,
  dialogClass: '',
  text: `page ${path} content`,
  elements: [
    {
      idx: 0,
      tag: 'button',
      type: '',
      text: `go${path}`,
      placeholder: '',
      name: 'next',
      rect: { x: 0, y: 0, w: 100, h: 40 },
      disabled: false,
    } as never,
  ],
  notices: [],
  iframeHosts: [],
  scrollY: 0,
  scrollHeight: 2000,
  viewportHeight: 800,
  bodyClass: '',
  scrollWidth: 390,
})

const metaOf = (id: string): ProjectMeta =>
  ({
    id,
    name: '边标注',
    targetUrl: 'http://site.test/a',
    deviceId: 'iphone-14-pro-max',
    aiProfileId: 'x',
    goal: '走通',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }) as ProjectMeta

const click: AiAction = { action: 'click', targetIdx: 0, reason: 'x' }
const done: AiAction = { action: 'done', reason: 'x' }

/** 按点击次数在给定路径序列上前进的假站点 + 按调用次序回答的假 AI */
function makeDeps(flow: string[], answers: AiAction[]): {
  deps: Deps
  patches: Array<Omit<GraphPatch, 'projectId'>>
} {
  let at = 0
  let call = 0
  let shotN = 0
  const patches: Array<Omit<GraphPatch, 'projectId'>> = []
  const driver = {
    installUserInputWatcher: async () => {},
    waitStable: async () => probeOf(flow[at]),
    probe: async () => probeOf(flow[at]),
    userInputAge: async () => null,
    clearUserInput: async () => {},
    canGoBack: () => false,
    scrollBy: async () => {},
    back: async () => {},
    tap: async () => {
      at = Math.min(at + 1, flow.length - 1)
    },
  }
  const ai = {
    name: 'fake',
    decide: async (): Promise<AiAction> => answers[Math.min(call++, answers.length - 1)],
    // 生成阶段的问询失败即回落，正好让图停在结构层，便于断言机械结果
    review: async () => {
      throw new Error('本测试不跑语义问询')
    },
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  }
  const deps: Deps = {
    driver: driver as never,
    ai: ai as never,
    isFront: () => true,
    openTarget: async () => {},
    // 每次抓图内容都不同，用于断言「哪一次的图」落了盘
    captureArchival: async () => {
      shotN += 1
      return { png: Buffer.from(`shot-${shotN}`), jpegBase64: Buffer.from(`thumb-${shotN}`).toString('base64') }
    },
    emit: () => {},
    emitPatch: (p) => patches.push(p),
  }
  return { deps, patches }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('等待超时')
}

const graphOf = (id: string): FlowGraph =>
  JSON.parse(readFileSync(join(projectDir(id), 'graph.json'), 'utf8')) as FlowGraph

const nodeAt = (g: FlowGraph, path: string) => g.nodes.find((n) => n.url === `http://site.test${path}`)

describe('结构层建图', () => {
  it('连线标注取自上一步实际执行的动作，节点带机械占位与 draft 标记', async () => {
    // /a --点击--> /b --点击--> /c
    const { deps } = makeDeps(['/a', '/b', '/c'], [click, click, done])
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('edge-linear'), '走通', { maxSteps: 10 })
    await waitFor(() => session.snapshot().state === 'finished')

    const graph = graphOf('edge-linear')
    const a = nodeAt(graph, '/a')
    const b = nodeAt(graph, '/b')
    const c = nodeAt(graph, '/c')
    expect(a && b && c, '三屏都要建出节点').toBeTruthy()

    // 占位命名：标题机械取自页面标题，draft 表示语义待补（本测试的语义问询全部回落）
    expect(a!.title).toBe('页面/a')
    expect(a!.draft, '语义未补齐的节点保持 draft').toBe(true)

    const ab = graph.edges.find((e) => e.from === a!.id && e.to === b!.id)
    const bc = graph.edges.find((e) => e.from === b!.id && e.to === c!.id)
    expect(ab!.label, 'a→b 的标注是「在 a 上执行的动作」').toBe('点击「go/a」')
    expect(bc!.label, 'b→c 的标注是「在 b 上执行的动作」').toBe('点击「go/b」')
  })

  it('回到已知界面时建 link 边、刷新存档图，轨迹逐步落盘', async () => {
    // /a --点击--> /b --点击--> /a（回到已知界面）
    const { deps, patches } = makeDeps(['/a', '/b', '/a'], [click, click, done])
    const session: Session = new ExplorerSession(deps)
    const snap = await session.start(metaOf('edge-revisit'), '走通', { maxSteps: 10 })
    await waitFor(() => session.snapshot().state === 'finished')

    const graph = graphOf('edge-revisit')
    const a = nodeAt(graph, '/a')
    const b = nodeAt(graph, '/b')
    const ba = graph.edges.find((e) => e.from === b!.id && e.to === a!.id)
    expect(ba, '回到已知界面的转移必须有连线').toBeTruthy()
    expect(ba!.label, 'b→a 的标注是「在 b 上执行的动作」').toBe('点击「go/b」')
    expect(ba!.type).toBe('link')

    // 首访的半加载图会被重访时的新图顶掉：第 3 步（重访 a）抓的是第 3 张图
    const png = readFileSync(join(projectDir('edge-revisit'), 'screens', `${a!.id}.png`), 'utf8')
    expect(png, '重访已知界面后，存档图应替换为最新一次抓取').toBe('shot-3')

    // 画布靠 updatedNodes 补丁得知截图变了（URL 带 ts 版本参数）
    const updated = patches.flatMap((p) => p.updatedNodes ?? []).filter((n) => n.id === a!.id)
    expect(updated.length, '截图刷新必须通过 updatedNodes 通知渲染侧').toBeGreaterThan(0)

    // 轨迹是图谱生成阶段的输入，每个动作步都要有记录
    const tracePath = join(projectDir('edge-revisit'), 'trace.jsonl')
    expect(existsSync(tracePath), '探索必须产出轨迹文件').toBe(true)
    const rows = readFileSync(tracePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.runId === snap.runId)
    expect(rows.length, '三步都要有轨迹记录').toBeGreaterThanOrEqual(3)
    expect(rows[0]).toMatchObject({ step: 1, action: 'click', ok: true, label: '点击「go/a」' })
    expect(rows[rows.length - 1]).toMatchObject({ action: 'done' })
  })
})
