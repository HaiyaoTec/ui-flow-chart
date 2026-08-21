import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiAction, AiDecideInput, ProbeResult, ProjectMeta } from '@shared/types'

/*
 * 结构化提问（ask）与接管段局部生成。
 *
 * 模型只缺一条信息时向用户提问，用户作答即可继续，不必接触页面；
 * 敏感应答（验证码）只在内存里交给模型，落盘一律脱敏。
 * 每段人工接管结束立即对该段录制的界面做局部图谱生成，不等探索收尾。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ufc-ask-'))
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
  scrollHeight: 1000,
  viewportHeight: 800,
  bodyClass: '',
  scrollWidth: 390,
})

const metaOf = (id: string): ProjectMeta =>
  ({
    id,
    name: '提问',
    targetUrl: 'http://site.test/step',
    deviceId: 'iphone-14-pro-max',
    aiProfileId: 'x',
    goal: '走通',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }) as ProjectMeta

function makeDeps(
  answers: AiAction[],
  reviewReply?: (name: string) => unknown
): {
  deps: Deps
  states: string[]
  decideInputs: AiDecideInput[]
  calls: string[]
  advance: () => void
} {
  let at = 0
  let call = 0
  const flow = ['/step', '/next']
  const states: string[] = []
  const decideInputs: AiDecideInput[] = []
  const calls: string[] = []
  const driver = {
    installUserInputWatcher: async () => {},
    waitStable: async () => probeOf(flow[at]),
    probe: async () => probeOf(flow[at]),
    userInputAge: async () => null,
    clearUserInput: async () => {},
    canGoBack: () => false,
    scrollBy: async () => {},
    back: async () => {},
    tap: async () => {},
    evalInPage: async (script: string) => (script.includes('__ufcEvents') ? [] : true),
  }
  const ai = {
    name: 'fake',
    decide: async (input: AiDecideInput): Promise<AiAction> => {
      decideInputs.push(input)
      calls.push('decide')
      return answers[Math.min(call++, answers.length - 1)]
    },
    review: async (task: { name: string }) => {
      calls.push(`review:${task.name}`)
      const out = reviewReply?.(task.name)
      if (out === undefined) throw new Error(`模拟失败：${task.name}`)
      return out
    },
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  }
  const deps: Deps = {
    driver: driver as never,
    ai: ai as never,
    isFront: () => true,
    openTarget: async () => {},
    captureArchival: async () => ({ png: Buffer.from('x'), jpegBase64: 'eA==' }),
    emit: (e) => {
      if (e.kind === 'state-changed') states.push(e.to)
    },
    emitPatch: () => {},
  }
  return { deps, states, decideInputs, calls, advance: () => (at = Math.min(at + 1, flow.length - 1)) }
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

function fileText(id: string, file: string): string {
  const p = join(projectDir(id), file)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

const askAction: AiAction = {
  action: 'ask',
  reason: '需要验证码',
  question: '请转述手机收到的短信验证码',
  allowInput: true,
  sensitive: true,
}

describe('结构化提问', () => {
  it('敏感应答只交给模型：下一步输入里可见，任何落盘记录都不含原文', { timeout: 15000 }, async () => {
    const { deps, decideInputs } = makeDeps([askAction, { action: 'done', reason: '完成' }])
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('ask-sensitive'), '走通', { maxSteps: 10 })

    await waitFor(() => session.snapshot().state === 'asking')
    const snap = session.snapshot()
    expect(snap.ask?.question, '快照要携带问题内容供界面渲染').toBe('请转述手机收到的短信验证码')
    expect(snap.ask?.allowInput).toBe(true)

    // 提问期不计时长
    const elapsed = session.snapshot().elapsedMs ?? 0
    await wait(300)
    expect(session.snapshot().elapsedMs ?? 0, '等待回答期间时长不走表').toBe(elapsed)

    session.answerAsk('9527')
    await waitFor(() => session.snapshot().state === 'finished', 8000)

    const last = decideInputs[decideInputs.length - 1]
    expect(last.lastOutcome, '应答要作为上一步结果交给模型').toContain('9527')

    for (const file of ['session.jsonl', 'trace.jsonl']) {
      expect(fileText('ask-sensitive', file), `${file} 不得包含敏感应答原文`).not.toContain('9527')
    }
  })

  it('非敏感的选项应答正常落盘，作答后模型接着往下走', { timeout: 15000 }, async () => {
    const { deps, decideInputs } = makeDeps([
      { action: 'ask', reason: '选账号', question: '用哪个测试账号？', options: ['demo_user', 'guest'] },
      { action: 'done', reason: '完成' },
    ])
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('ask-option'), '走通', { maxSteps: 10 })

    await waitFor(() => session.snapshot().state === 'asking')
    expect(session.snapshot().ask?.options).toEqual(['demo_user', 'guest'])
    session.answerAsk('demo_user')
    await waitFor(() => session.snapshot().state === 'finished', 8000)

    expect(decideInputs[decideInputs.length - 1].lastOutcome).toContain('demo_user')
    expect(fileText('ask-option', 'session.jsonl'), '非敏感应答照常落盘可审计').toContain('demo_user')
  })

  it('提问期间点「我来接管」转入整屏接管，问题作废', { timeout: 15000 }, async () => {
    const { deps, states } = makeDeps([askAction, { action: 'done', reason: '完成' }])
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('ask-takeover'), '走通', { maxSteps: 10 })

    await waitFor(() => session.snapshot().state === 'asking')
    await session.takeoverStart('用户改为亲自操作')
    await waitFor(() => session.snapshot().state === 'awaiting_human', 5000)
    expect(session.snapshot().ask, '转接管后问题要清掉').toBeUndefined()

    await session.takeoverEnd()
    await waitFor(() => session.snapshot().state === 'finished', 8000)
    expect(states).toContain('asking')
    expect(states).toContain('awaiting_human')
  })
})

describe('接管段局部生成', () => {
  it('每段接管结束立即对该段界面做命名与归位，不等探索收尾', { timeout: 20000 }, async () => {
    const { deps, calls, advance } = makeDeps(
      [
        { action: 'need_human', needHumanReason: 'captcha', reason: '需要真人' },
        { action: 'done', reason: '完成' },
      ],
      (name) => {
        if (name === 'name_screens') return { names: [{ nodeId: 'manual-1', title: '安全验证', kind: 'normal' }] }
        if (name === 'classify_lanes')
          return { assignments: [{ nodeId: 'manual-1', lane: 'verify', laneTitle: '安全验证', confidence: 'high' }] }
        if (name === 'merge_screens') return { pairs: [] }
        if (name === 'relabel_edges') return { labels: [] }
        return undefined
      }
    )
    const session: Session = new ExplorerSession(deps)
    await session.start(metaOf('ask-segment'), '走通', { maxSteps: 10 })

    await waitFor(() => session.snapshot().state === 'awaiting_human', 5000)
    // 模拟人工操作换到了新页面，录制器双确认后把它录成 manual-1
    advance()
    await waitFor(() => calls.length > 0 && fileText('ask-segment', 'graph.json').includes('manual-1'), 8000)
    await session.takeoverEnd()
    await waitFor(() => session.snapshot().state === 'finished', 10000)

    // 局部生成必须发生在探索收尾（最后一次决策）之前
    const firstNaming = calls.indexOf('review:name_screens')
    const lastDecide = calls.lastIndexOf('decide')
    expect(firstNaming, '接管段结束就该发起命名问询').toBeGreaterThanOrEqual(0)
    expect(firstNaming, '局部生成先于探索收尾').toBeLessThan(lastDecide)

    const graph = JSON.parse(fileText('ask-segment', 'graph.json')) as {
      nodes: Array<{ id: string; title: string; lane: string; draft?: boolean }>
    }
    const manual = graph.nodes.find((n) => n.id === 'manual-1')
    expect(manual?.title, '接管段界面已被命名').toBe('安全验证')
    expect(manual?.lane, '接管段界面已归位').toBe('verify')
    expect(manual?.draft ?? false).toBe(false)
  })
})
