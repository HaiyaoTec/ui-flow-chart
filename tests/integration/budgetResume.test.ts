import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiAction, ProbeResult, ProjectMeta, SessionSnapshot } from '@shared/types'

/*
 * 会话状态机跑在主进程里，但它本身不碰 Electron——只有存储路径与日志模块会。
 * 把这两处替身掉，就能在 vitest 里驱动完整的状态机，
 * 比起端到端拉起整个应用，时序确定得多。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ufc-budget-'))
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

const probe = (url: string): ProbeResult => ({
  url,
  title: '页面',
  hasDialog: false,
  dialogClass: '',
  text: '正文',
  elements: [{ index: 0, tag: 'button', role: 'button', text: '下一步', visible: true, rect: { x: 0, y: 0, w: 10, h: 10 } } as never],
  notices: [],
  iframeHosts: [],
  scrollY: 0,
  scrollHeight: 2000,
  viewportHeight: 800,
  bodyClass: '',
  scrollWidth: 390,
})

const meta: ProjectMeta = {
  id: 'budget-test',
  name: '预算',
  targetUrl: 'http://localhost/0',
  deviceId: 'iphone-14-pro-max',
  aiProfileId: 'x',
  goal: '走两步',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
} as ProjectMeta

/** 每一步都换个地址，好让每步都算一屏新界面 */
function makeDeps(): { deps: Deps; states: string[] } {
  let n = 0
  const states: string[] = []
  const driver = {
    installUserInputWatcher: async () => {},
    waitStable: async () => probe(`http://localhost/${n++}`),
    userInputAge: () => Number.POSITIVE_INFINITY,
    clearUserInput: async () => {},
    canGoBack: () => false,
    scrollBy: async () => {},
    back: async () => {},
  }
  const ai = {
    name: 'fake',
    // 一直滚动：不改变页面结构，纯粹推进步数
    decide: async (): Promise<AiAction> => ({
      action: 'scroll',
      screen: { id: `screen-${n}`, title: `界面 ${n}`, lane: 'main', laneTitle: '主流程', kind: 'normal' },
      edgeLabel: '滚动',
      reason: '继续看',
      scrollDelta: 600,
    }),
    review: async () => {
      throw new Error('本测试不涉及收尾审查')
    },
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  }
  const deps: Deps = {
    driver: driver as never,
    ai: ai as never,
    openTarget: async () => {},
    captureArchival: async () => ({ png: Buffer.alloc(0), jpegBase64: '' }),
    emit: (e) => {
      if (e.kind === 'state-changed') states.push(`${e.from}>${e.to}`)
    },
    emitPatch: () => {},
  }
  return { deps, states }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await wait(20)
  }
  throw new Error('等待超时')
}

/** 读取本轮的会话记录 */
function records(runId: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(projectDir(meta.id), 'session.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.runId === runId)
}

describe('预算触顶与继续', () => {
  it('触顶后点继续必须真的能继续，而不是立刻又暂停', async () => {
    const { deps, states } = makeDeps()
    const session: Session = new ExplorerSession(deps)
    let snap: SessionSnapshot = await session.start(meta, '走两步', { maxSteps: 2, maxAiCalls: 50 })
    const runId = snap.runId!
    expect(runId, '每轮运行都要有标识').toBeTruthy()

    await waitFor(() => session.snapshot().state === 'paused')
    snap = session.snapshot()
    expect(snap.reason, '触顶原因要带上阈值').toBe('已达步数上限（2 步）')
    const stepsAtStop = snap.step

    /*
     * 核心断言。
     *
     * 缺陷态下 resume 只清暂停标志，计数与时长基线一个都不动，
     * 主循环重新进来第一件事就是再查一次预算，返回同一个原因，立刻又暂停——
     * 状态序列里会立刻出现一次 observing>paused，步数一步都不涨。
     */
    session.resume()
    states.length = 0
    await waitFor(() => session.snapshot().step > stepsAtStop, 5000)
    expect(states.filter((s) => s === 'observing>paused'), '继续之后不该马上又暂停').toEqual([])

    // 再给一轮之后，仍然会在同样的额度处停下——预算本身没有被架空
    await waitFor(() => session.snapshot().state === 'paused')
    expect(session.snapshot().step, '第二轮同样只跑两步').toBe(stepsAtStop + 2)

    const rows = records(runId)
    const runStart = rows.find((r) => r.kind === 'run-start')
    expect(runStart?.budgets, '预算配置必须落盘，否则事后没有阈值可对照').toMatchObject({ maxSteps: 2 })
    expect(runStart).toHaveProperty('carriedScreens')

    const stops = rows.filter((r) => r.kind === 'budget-stop')
    expect(stops.length, '两次触顶都要留下结构化记录').toBe(2)
    expect(stops[0]).toMatchObject({ which: 'steps', value: 2, limit: 2 })
    // 四项用量一并记下：短路顺序只报第一项，其余三项离上限多远得靠这里
    expect(stops[0].used).toMatchObject({ step: 2 })
    expect(stops[0]).toHaveProperty('elapsedMs')

    const resumes = rows.filter((r) => r.kind === 'control' && r.op === 'resume')
    expect(resumes.length, '「继续」这个动作本身必须留痕').toBe(1)
    expect(resumes[0]).toMatchObject({ accepted: true, stateBefore: 'paused' })

    session.stop()
  })

  it('被忽略的控制指令也要留痕', async () => {
    const { deps } = makeDeps()
    const session: Session = new ExplorerSession(deps)
    const snap = await session.start(meta, 'x', { maxSteps: 1 })
    await waitFor(() => session.snapshot().state === 'paused')

    // 已经暂停了还再点暂停：过去是彻底的空操作，事后看不出用户点过
    session.pause()
    const rows = records(snap.runId!)
    const ignored = rows.filter((r) => r.kind === 'control' && r.op === 'pause' && r.accepted === false)
    expect(ignored.length, '无效的暂停点击要记下来').toBe(1)
    expect(ignored[0]).toMatchObject({ stateBefore: 'paused' })

    session.stop()
  })

  it('时长只累计实际在跑的时间，暂停期间不走表', async () => {
    const { deps } = makeDeps()
    const session: Session = new ExplorerSession(deps)
    await session.start(meta, 'x', { maxSteps: 1 })
    await waitFor(() => session.snapshot().state === 'paused')

    const a = session.snapshot().elapsedMs ?? 0
    await wait(300)
    const b = session.snapshot().elapsedMs ?? 0
    expect(b, '暂停期间时长不该增长').toBe(a)

    session.stop()
  })
})
