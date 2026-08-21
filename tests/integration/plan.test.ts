import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiAction, AiDecideInput, FlowGraph, ProbeResult, ProjectMeta } from '@shared/types'

/*
 * 探索计划与偏离处理。
 *
 * 规划阶段基于首屏产出功能入口清单，探索按序逐个覆盖：done 表示当前入口
 * 覆盖完毕，系统回到入口锚点取下一个，全部覆盖完才真正收尾。
 * 偏离的两条确定性判定：离开目标站点域名立即回退且不建图；
 * 连续多步无新界面时当前入口标记放弃、换下一个入口。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ufc-plan-'))
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

const probeOf = (url: string): ProbeResult => ({
  url,
  title: `页面${new URL(url).pathname}`,
  hasDialog: false,
  dialogClass: '',
  text: `content of ${url}`,
  elements: [
    {
      idx: 0,
      tag: 'a',
      type: '',
      text: '注册',
      placeholder: '',
      name: 'reg',
      rect: { x: 0, y: 0, w: 100, h: 40 },
      disabled: false,
    } as never,
    {
      idx: 1,
      tag: 'a',
      type: '',
      text: '登录',
      placeholder: '',
      name: 'login',
      rect: { x: 0, y: 60, w: 100, h: 40 },
      disabled: false,
    } as never,
  ],
  notices: [],
  iframeHosts: [],
  scrollY: 0,
  scrollHeight: 1000,
  viewportHeight: 800,
  bodyClass: '',
  scrollWidth: 390,
})

const HOME = 'http://site.test/home'

const metaOf = (id: string): ProjectMeta =>
  ({
    id,
    name: '计划',
    targetUrl: HOME,
    deviceId: 'iphone-14-pro-max',
    aiProfileId: 'x',
    goal: '走通',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }) as ProjectMeta

/** 可编排的假站点：tap 按脚本换页，goto 直接跳转 */
function makeDeps(opts: {
  tapTo?: (from: string, step: number) => string
  answers: AiAction[]
  planReply?: unknown
  confirmPlan?: boolean
}): {
  deps: Deps
  decideInputs: AiDecideInput[]
  gotoCalls: string[]
  url: () => string
} {
  let current = HOME
  let taps = 0
  let call = 0
  const decideInputs: AiDecideInput[] = []
  const gotoCalls: string[] = []
  const driver = {
    installUserInputWatcher: async () => {},
    waitStable: async () => probeOf(current),
    probe: async () => probeOf(current),
    userInputAge: async () => null,
    clearUserInput: async () => {},
    canGoBack: () => false,
    scrollBy: async () => {},
    back: async () => {},
    goto: async (u: string) => {
      gotoCalls.push(u)
      current = u
    },
    tap: async () => {
      taps += 1
      current = opts.tapTo?.(current, taps) ?? current
    },
    evalInPage: async () => true,
  }
  const ai = {
    name: 'fake',
    decide: async (input: AiDecideInput): Promise<AiAction> => {
      decideInputs.push(input)
      return opts.answers[Math.min(call++, opts.answers.length - 1)]
    },
    review: async (task: { name: string }) => {
      if (task.name === 'plan_entries' && opts.planReply !== undefined) return opts.planReply
      throw new Error(`模拟失败：${task.name}`)
    },
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  }
  const deps: Deps = {
    driver: driver as never,
    ai: ai as never,
    isFront: () => true,
    confirmPlan: () => opts.confirmPlan ?? false,
    openTarget: async () => {},
    captureArchival: async () => ({ png: Buffer.from('x'), jpegBase64: 'eA==' }),
    emit: () => {},
    emitPatch: () => {},
  }
  return { deps, decideInputs, gotoCalls, url: () => current }
}

async function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('等待超时')
}

const graphOf = (id: string): FlowGraph =>
  JSON.parse(readFileSync(join(projectDir(id), 'graph.json'), 'utf8')) as FlowGraph

const click = (idx: number): AiAction => ({ action: 'click', targetIdx: idx, reason: 'x' })
const done: AiAction = { action: 'done', reason: '当前入口覆盖完毕' }

const PLAN_REPLY = {
  entries: [
    { title: '注册流程', entryText: '注册' },
    { title: '登录流程', entryText: '登录' },
  ],
}

describe('探索计划', () => {
  it('done 表示当前入口覆盖完毕：回到锚点取下一个入口，全部覆盖完才收尾', { timeout: 15000 }, async () => {
    // 入口 1：home --点击注册--> /reg，done；入口 2：home --点击登录--> /login，done
    const { deps, decideInputs, gotoCalls } = makeDeps({
      tapTo: (from) => (from === HOME ? (gotoCalls.length ? 'http://site.test/login' : 'http://site.test/reg') : from),
      answers: [click(0), done, click(1), done],
      planReply: PLAN_REPLY,
    })
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('plan-flow'), '走通', { maxSteps: 20 })
    await waitFor(() => session.snapshot().state === 'finished', 12000)

    const snap = session.snapshot()
    expect(snap.plan?.entries.map((e) => e.status), '两个入口都要覆盖完').toEqual(['covered', 'covered'])
    expect(gotoCalls, '切换入口时要回到入口锚点').toContain(HOME)

    // 每步问询要携带当前子任务
    const withSubtask = decideInputs.filter((i) => i.subtask)
    expect(withSubtask.length).toBeGreaterThan(0)
    expect(decideInputs[0].subtask).toBe('注册流程')
    expect(decideInputs[decideInputs.length - 1].subtask).toBe('登录流程')

    // 两个入口的界面都建了图
    const g = graphOf('plan-flow')
    expect(g.nodes.some((n) => n.url.endsWith('/reg'))).toBe(true)
    expect(g.nodes.some((n) => n.url.endsWith('/login'))).toBe(true)
  })

  it('规划问询失败时回落为自由探索，流程照常走完', { timeout: 15000 }, async () => {
    const { deps, decideInputs } = makeDeps({
      answers: [done],
      planReply: undefined,
    })
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('plan-fallback'), '走通', { maxSteps: 10 })
    await waitFor(() => session.snapshot().state === 'finished', 8000)

    expect(session.snapshot().plan, '规划失败就没有计划').toBeUndefined()
    expect(decideInputs[0].subtask).toBeUndefined()
  })

  it('连续多步无新界面时当前入口标记放弃，换下一个入口', { timeout: 20000 }, async () => {
    // 入口 1 点了不换页（原地打转）；引擎按停滞判定放弃它，切到入口 2
    const { deps } = makeDeps({
      tapTo: (from, taps) => (taps > 6 && from === HOME ? 'http://site.test/login' : from),
      answers: [click(0), click(0), click(0), click(0), click(0), click(0), click(1), done],
      planReply: PLAN_REPLY,
    })
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('plan-stall'), '走通', { maxSteps: 30 })
    await waitFor(() => session.snapshot().state === 'finished', 16000)

    const statuses = session.snapshot().plan?.entries.map((e) => e.status)
    expect(statuses?.[0], '停滞的入口标记为已放弃').toBe('abandoned')
    expect(statuses?.[1], '后续入口照常覆盖').toBe('covered')
  })
})

describe('探索前确认计划', () => {
  it('开关开启时规划完先暂停，调整计划后点继续才开始探索', { timeout: 15000 }, async () => {
    const { deps, decideInputs } = makeDeps({
      tapTo: () => 'http://site.test/login',
      answers: [click(1), done],
      planReply: PLAN_REPLY,
      confirmPlan: true,
    })
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('plan-confirm'), '走通', { maxSteps: 10 })

    // 规划完成即暂停，一步都没探
    await waitFor(() => session.snapshot().state === 'paused')
    const snap = session.snapshot()
    expect(snap.plan?.entries.length).toBe(2)
    expect(snap.reason).toContain('确认')
    expect(decideInputs.length, '确认前不该发出任何探索问询').toBe(0)

    // 用户调整：删掉注册流程、只留登录流程
    const edited = session.updatePlan([{ title: '登录流程', entryText: '登录' }])
    expect(edited.plan?.entries.map((e) => e.title)).toEqual(['登录流程'])

    session.resume()
    await waitFor(() => session.snapshot().state === 'finished', 8000)
    expect(decideInputs[0].subtask, '探索按调整后的计划进行').toBe('登录流程')
    expect(session.snapshot().plan?.entries.map((e) => e.status)).toEqual(['covered'])
  })

  it('探索进行中的计划编辑被拒绝', { timeout: 15000 }, async () => {
    const { deps } = makeDeps({ answers: [done], planReply: PLAN_REPLY })
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('plan-edit-reject'), '走通', { maxSteps: 10 })
    // 无确认开关：直接开跑。运行期（非 paused）的编辑不该生效
    const before = session.snapshot().plan?.entries.map((e) => e.title)
    session.updatePlan([{ title: '乱改' }])
    const after = session.snapshot().plan?.entries.map((e) => e.title)
    expect(after, '非暂停态的计划编辑不生效').toEqual(before)
    await waitFor(() => session.snapshot().state === 'finished', 8000)
  })

  it('暂停态点结束要把会话真正收束，而不是永远停在暂停上', { timeout: 15000 }, async () => {
    const { deps } = makeDeps({ answers: [done], planReply: PLAN_REPLY, confirmPlan: true })
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('plan-stop'), '走通', { maxSteps: 10 })
    await waitFor(() => session.snapshot().state === 'paused')

    session.stop()
    await waitFor(() => session.snapshot().state === 'finished', 8000)
  })
})

describe('偏离处理', () => {
  it('离开目标站点域名立即回退，站外界面不建图、轨迹留痕', { timeout: 15000 }, async () => {
    // 第一次点击被外链拉走；回退后第二次点击进入正常页面
    const { deps, url } = makeDeps({
      tapTo: (from, taps) => (taps === 1 ? 'http://evil.example/trap' : taps === 2 ? 'http://site.test/reg' : from),
      answers: [click(0), click(0), done],
      planReply: PLAN_REPLY,
    })
    const session: Session = new ExplorerSession(deps)
    const snap = await session.start(metaOf('plan-offsite'), '走通', { maxSteps: 20 })
    await waitFor(() => session.snapshot().state === 'finished', 12000)

    // canGoBack 为 false，回退走导航回锚点
    expect(url().startsWith('http://site.test'), '结束时必须回到目标站').toBe(true)

    const g = graphOf('plan-offsite')
    expect(g.nodes.some((n) => n.url.includes('evil.example')), '站外界面不得建图').toBe(false)

    const tracePath = join(projectDir('plan-offsite'), 'trace.jsonl')
    const rows = existsSync(tracePath)
      ? readFileSync(tracePath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((r) => r.runId === snap.runId)
      : []
    expect(rows.some((r) => r.action === 'offsite'), '偏离段要在轨迹里留痕').toBe(true)
  })
})
