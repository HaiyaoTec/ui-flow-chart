import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiAction, ProbeResult, ProjectMeta } from '@shared/types'

/*
 * 人工接管排队。
 *
 * 屏幕只有一块：后台会话判定需要人工时必须先进 human_queued 排队，
 * 不建录制器（否则 700ms 轮询在没人看的页面上空转、白耗 maxScreens 额度）、
 * 不计时长；拿到前台才转 awaiting_human 并开始录制；被抢占（用户切去别的项目）
 * 要降回排队，段落以 endedBy=preempted 落盘。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ufc-queue-'))
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

// 地址刻意不带 captcha 这类词：要测的是 AI 输出 need_human 的路径，
// 不能让 URL 启发式抢先触发（fake 页面永不变化，启发式会在接管结束后立刻再触发）
const probeOf = (): ProbeResult => ({
  url: 'http://site.test/step',
  title: '验证码',
  hasDialog: false,
  dialogClass: '',
  text: 'captcha page',
  elements: [
    {
      idx: 0,
      tag: 'button',
      type: '',
      text: '验证',
      placeholder: '',
      name: 'verify',
      rect: { x: 0, y: 0, w: 100, h: 40 },
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

const metaOf = (id: string): ProjectMeta =>
  ({
    id,
    name: '排队',
    targetUrl: 'http://site.test/step',
    deviceId: 'iphone-14-pro-max',
    aiProfileId: 'x',
    goal: '走通',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }) as ProjectMeta

function makeDeps(front: { value: boolean }): {
  deps: Deps
  states: string[]
  recorderInstalls: () => number
  captureCount: () => number
} {
  let evalCalls = 0
  let captures = 0
  let call = 0
  const states: string[] = []
  const driver = {
    installUserInputWatcher: async () => {},
    waitStable: async () => probeOf(),
    probe: async () => probeOf(),
    userInputAge: async () => null,
    clearUserInput: async () => {},
    canGoBack: () => false,
    scrollBy: async () => {},
    back: async () => {},
    tap: async () => {},
    // 录制器装事件探针、抽取事件都走这里：它被调用过 = 录制器启动过
    evalInPage: async (script: string) => {
      evalCalls += 1
      return script.includes('__ufcEvents') ? [] : true
    },
  }
  const ai = {
    name: 'fake',
    decide: async (): Promise<AiAction> => {
      call += 1
      if (call === 1)
        return {
          action: 'need_human',
          needHumanReason: 'captcha',
          reason: '验证码需要真人',
          screen: { id: 'cap', title: '验证码', lane: 'main', laneTitle: '主流程', kind: 'normal' },
          edgeLabel: '触发验证',
        }
      return {
        action: 'done',
        reason: '完成',
        screen: { id: 'cap', title: '验证码', lane: 'main', kind: 'normal' },
        edgeLabel: '验证通过',
      }
    },
    review: async () => {
      throw new Error('本测试不涉及收尾审查')
    },
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  }
  const deps: Deps = {
    driver: driver as never,
    ai: ai as never,
    isFront: () => front.value,
    openTarget: async () => {},
    captureArchival: async () => {
      captures += 1
      return { png: Buffer.from('x'), jpegBase64: 'eA==' }
    },
    emit: (e) => {
      if (e.kind === 'state-changed') states.push(e.to)
    },
    emitPatch: () => {},
  }
  return { deps, states, recorderInstalls: () => evalCalls, captureCount: () => captures }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await wait(25)
  }
  throw new Error('等待超时')
}

function takeoverRecords(id: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(join(projectDir(id), 'session.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.runId === runId && e.kind === 'takeover')
}

describe('人工接管排队', () => {
  it('后台会话先排队不录制，拿到前台才录，被抢占降回排队', { timeout: 20000 }, async () => {
    const front = { value: false }
    const { deps, recorderInstalls, captureCount } = makeDeps(front)
    const session: Session = new ExplorerSession(deps)
    const snap = await session.start(metaOf('queue-flow'), '走通', { maxSteps: 10 })
    const runId = snap.runId!

    // 后台会话需要人工：进排队，而不是直接开录
    await waitFor(() => session.snapshot().state === 'human_queued')
    const capturesQueued = captureCount()
    await wait(400)
    expect(session.snapshot().state, '没拿到屏幕前必须停在排队态').toBe('human_queued')
    expect(recorderInstalls(), '排队期不建录制器').toBe(0)
    expect(captureCount(), '排队期不抓图').toBe(capturesQueued)

    // 排队期不计时长
    const elapsed = session.snapshot().elapsedMs ?? 0
    await wait(300)
    expect(session.snapshot().elapsedMs ?? 0, '排队期间时长不走表').toBe(elapsed)

    // 用户打开该项目（预览切前台）：转入录制
    front.value = true
    await waitFor(() => session.snapshot().state === 'awaiting_human', 6000)
    await waitFor(() => recorderInstalls() > 0, 6000)

    // 用户切去别的项目（被抢占）：停录制、降回排队，段落要留痕
    front.value = false
    await waitFor(() => session.snapshot().state === 'human_queued', 6000)
    const seg1 = takeoverRecords('queue-flow', runId)
    expect(seg1.length, '被抢占的接管段落必须落盘').toBe(1)
    expect(seg1[0]).toMatchObject({ seq: 1, endedBy: 'preempted' })

    // 用户回来：再次进入录制
    front.value = true
    await waitFor(() => session.snapshot().state === 'awaiting_human', 6000)

    // 结束接管：回到探索并收尾
    await session.takeoverEnd()
    await waitFor(() => session.snapshot().state === 'finished', 8000)
    const seg2 = takeoverRecords('queue-flow', runId)
    expect(seg2.length, '两个接管段落都要留痕').toBe(2)
    expect(seg2[1]).toMatchObject({ seq: 2, endedBy: 'user' })
  })

  it('前台会话需要人工时直接进入录制，不经过排队', { timeout: 15000 }, async () => {
    const front = { value: true }
    const { deps, states } = makeDeps(front)
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('queue-front'), '走通', { maxSteps: 10 })

    await waitFor(() => session.snapshot().state === 'awaiting_human')
    expect(states, '前台会话不该出现排队态').not.toContain('human_queued')

    await session.takeoverEnd()
    await waitFor(() => session.snapshot().state === 'finished', 8000)
  })

  it('排队期点「结束接管」等于取消排队，AI 接着往下走', { timeout: 15000 }, async () => {
    const front = { value: false }
    const { deps, recorderInstalls } = makeDeps(front)
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('queue-cancel'), '走通', { maxSteps: 10 })

    await waitFor(() => session.snapshot().state === 'human_queued')
    await session.takeoverEnd()
    await waitFor(() => session.snapshot().state === 'finished', 8000)
    expect(recorderInstalls(), '取消排队的全程都不该建录制器').toBe(0)
  })
})
