import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiAction, FlowGraph, GraphPatch, ProbeResult, ProjectMeta } from '@shared/types'

/*
 * 连线标注的对应关系测试。
 *
 * 提示词要求 AI 输出的 edgeLabel 是「上一步动作到当前屏的转移标注」——
 * 也就是说第 N 步的 edgeLabel 描述的是第 N-1 步动作引起的那次转移。
 * 引擎必须把它标在「上一屏 → 当前屏」的连线上；错一步的话，
 * 用户看到的就是「自动跳转：登录状态恢复」标在「首页 → 游戏详情」上这种图文不一致。
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
  title: path,
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
    review: async () => {
      throw new Error('本测试不涉及收尾审查')
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

const screen = (id: string, title: string): AiAction['screen'] => ({
  id,
  title,
  lane: 'main',
  laneTitle: '主流程',
  kind: 'normal',
})

describe('连线标注与截图的对应关系', () => {
  it('edgeLabel 描述的是到达当前屏的转移，必须标在上一屏指向当前屏的连线上', async () => {
    // /a --点击--> /b --点击--> /c；AI 按提示词语义在每步输出「我如何到达当前屏」
    const { deps } = makeDeps(
      ['/a', '/b', '/c'],
      [
        { action: 'click', targetIdx: 0, reason: 'x', screen: screen('a', '首页'), edgeLabel: '打开站点' },
        { action: 'click', targetIdx: 0, reason: 'x', screen: screen('b', '列表页'), edgeLabel: '点击「go/a」' },
        { action: 'done', reason: 'x', screen: screen('c', '详情页'), edgeLabel: '点击「go/b」' },
      ]
    )
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('edge-linear'), '走通', { maxSteps: 10 })
    await waitFor(() => session.snapshot().state === 'finished')

    const graph = graphOf('edge-linear')
    const ab = graph.edges.find((e) => e.from === 'a' && e.to === 'b')
    const bc = graph.edges.find((e) => e.from === 'b' && e.to === 'c')
    expect(ab, '首页到列表页必须有连线').toBeTruthy()
    expect(bc, '列表页到详情页必须有连线').toBeTruthy()
    expect(ab!.label, 'a→b 的标注应取自「到达 b 那一步」的 edgeLabel').toBe('点击「go/a」')
    expect(bc!.label, 'b→c 的标注应取自「到达 c 那一步」的 edgeLabel').toBe('点击「go/b」')
  })

  it('回到已知界面时同样用本步的 edgeLabel，且用新截图顶掉首访时的存档图', async () => {
    // /a --点击--> /b --点击--> /a（回到已知界面）
    const { deps, patches } = makeDeps(
      ['/a', '/b', '/a'],
      [
        { action: 'click', targetIdx: 0, reason: 'x', screen: screen('a', '首页'), edgeLabel: '打开站点' },
        { action: 'click', targetIdx: 0, reason: 'x', screen: screen('b', '列表页'), edgeLabel: '进入列表页' },
        { action: 'done', reason: 'x', screen: screen('a', '首页'), edgeLabel: '返回首页' },
      ]
    )
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('edge-revisit'), '走通', { maxSteps: 10 })
    await waitFor(() => session.snapshot().state === 'finished')

    const graph = graphOf('edge-revisit')
    const ba = graph.edges.find((e) => e.from === 'b' && e.to === 'a')
    expect(ba, '回到已知界面的转移必须有连线').toBeTruthy()
    expect(ba!.label, 'b→a 的标注应取自「回到 a 那一步」的 edgeLabel').toBe('返回首页')
    expect(ba!.type).toBe('link')

    /*
     * 首访时抓的图可能是半加载的（骨架屏、banner 空白），而节点截图只在首访写一次的话，
     * 这张残图会永久留存。重访时页面多半已经加载完整，必须用新图顶掉旧图。
     * 第 3 步（重访 a）抓的是第 3 张图，a 的存档就该是它。
     */
    const png = readFileSync(join(projectDir('edge-revisit'), 'screens', 'a.png'), 'utf8')
    expect(png, '重访已知界面后，存档图应替换为最新一次抓取').toBe('shot-3')

    // 画布靠 updatedNodes 补丁得知截图变了（URL 带 ts 版本参数），否则会一直显示缓存的旧图
    const updated = patches.flatMap((p) => p.updatedNodes ?? []).filter((n) => n.id === 'a')
    expect(updated.length, '截图刷新必须通过 updatedNodes 通知渲染侧').toBeGreaterThan(0)
  })
})
