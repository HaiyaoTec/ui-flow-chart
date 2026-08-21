import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MANUAL_LANE_ID, MANUAL_LANE_TITLE } from '../../src/shared/types'

/*
 * 图谱生成阶段（refine）的行为测试。
 *
 * 三条主线：语义批量补齐（命名、泳道、标注、合并）真的落到图上；
 * 人工修正过的字段（pinned）不被自动结果覆盖；
 * 模型全部失败时按确定性规则回落，结构完整、流程不中断。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ufc-refine-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir, isPackaged: false },
}))

type Store = import('../../src/main/engine/graphStore').GraphStore

let GraphStore: typeof import('../../src/main/engine/graphStore').GraphStore
let refineGraph: typeof import('../../src/main/engine/refine').refineGraph

beforeAll(async () => {
  GraphStore = (await import('../../src/main/engine/graphStore')).GraphStore
  refineGraph = (await import('../../src/main/engine/refine')).refineGraph
})

/** 探索结构层的最小图：两屏同地址（合并候选）+ 一屏列表页，机械泳道与机械标注 */
function seedStore(id: string): { store: Store; edgeIds: string[] } {
  const store = new GraphStore(id, 'http://x/a.html', 'dev')
  store.ensureLane('a', 'a')
  store.ensureLane('b', 'b')
  const n1 = store.addNode({
    id: 's1',
    signatureHash: 'sig1',
    lane: 'a',
    kind: 'normal',
    title: '页面a',
    url: 'http://x/a.html',
    createdBy: 'ai',
  })
  n1.draft = true
  const n2 = store.addNode({
    id: 's2',
    signatureHash: 'sig2',
    lane: 'a',
    kind: 'normal',
    title: '页面a候选',
    url: 'http://x/a.html',
    createdBy: 'ai',
  })
  n2.draft = true
  const n3 = store.addNode({
    id: 's3',
    signatureHash: 'sig3',
    lane: 'b',
    kind: 'normal',
    title: '页面b',
    url: 'http://x/b.html',
    createdBy: 'ai',
  })
  n3.draft = true
  const e1 = store.addEdge('s1', 's3', '点击「列表」', 'primary', 'ai')!
  const e2 = store.addEdge('s1', 's2', '点击「刷新」', 'primary', 'ai')!
  store.layoutAndSave()
  return { store, edgeIds: [e1.id, e2.id] }
}

/** 按问询类型给出结构化应答的假模型 */
function fakeAi(reply: (name: string) => unknown) {
  return {
    name: 'fake',
    decide: async () => {
      throw new Error('本测试不涉及探索问询')
    },
    review: async (task: { name: string }) => {
      const out = reply(task.name)
      if (out === undefined) throw new Error(`模拟失败：${task.name}`)
      return out
    },
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  }
}

describe('图谱生成阶段', () => {
  it('命名、合并、泳道、标注批量落图，机械泳道被整体重排回收', async () => {
    const { store, edgeIds } = seedStore('refine-full')
    const ai = fakeAi((name) => {
      if (name === 'name_screens')
        return {
          names: [
            { nodeId: 's1', title: '首页', kind: 'normal' },
            { nodeId: 's2', title: '首页', kind: 'normal' },
            { nodeId: 's3', title: '列表页', kind: 'normal' },
          ],
        }
      if (name === 'merge_screens') return { pairs: [{ pairId: 'p1', merge: true }] }
      if (name === 'classify_lanes')
        return {
          assignments: [
            { nodeId: 's1', lane: 'home', laneTitle: '首页域', confidence: 'high' },
            { nodeId: 's3', lane: 'list', laneTitle: '列表域', confidence: 'high' },
          ],
        }
      if (name === 'relabel_edges') return { labels: [{ edgeId: edgeIds[0], label: '点击「列表」进入列表页' }] }
      return undefined
    })

    const r = await refineGraph(store, ai as never)
    const g = store.get()

    // 命名生效，draft 清除
    const s1 = g.nodes.find((n) => n.id === 's1')!
    const s3 = g.nodes.find((n) => n.id === 's3')!
    expect(s1.title).toBe('首页')
    expect(s3.title).toBe('列表页')
    expect(g.nodes.some((n) => n.draft), '语义补齐后不该再有待整理节点').toBe(false)

    // 同地址合并：s2 并入 s1，签名转为别名，指向 s2 的边成了非法自环被清掉
    expect(g.nodes.find((n) => n.id === 's2')).toBeUndefined()
    expect(s1.aliasSigs).toContain('sig2')
    expect(store.findBySignature('sig2')?.id, '被合并界面的签名要指回保留节点').toBe('s1')
    expect(g.edges.map((e) => e.id)).toEqual([edgeIds[0]])
    expect(r.patch.removedNodeIds).toContain('s2')

    // 泳道划分生效，机械泳道整体回收
    expect(s1.lane).toBe('home')
    expect(s3.lane).toBe('list')
    expect(g.lanes.map((l) => l.id).sort()).toEqual(['home', 'list'])
    expect(g.lanes.find((l) => l.id === 'home')?.title).toBe('首页域')

    // 标注语义化生效
    expect(g.edges[0].label).toBe('点击「列表」进入列表页')
    expect(r.stats).toMatchObject({ named: 3, mergedNodes: 1, relabeled: 1 })
  })

  it('人工修正过的字段不参与问询、不被覆盖', async () => {
    const { store } = seedStore('refine-pinned')
    const s1 = store.get().nodes.find((n) => n.id === 's1')!
    s1.title = '用户改的名'
    s1.lane = 'custom'
    s1.pinned = ['title', 'lane']
    s1.draft = undefined
    store.ensureLane('custom', '自定义')
    store.save()

    // 模型执意给 s1 命名与归类：白名单会把不在候选里的结论剔掉
    const ai = fakeAi((name) => {
      if (name === 'name_screens')
        return { names: [{ nodeId: 's1', title: '模型的名', kind: 'normal' }, { nodeId: 's2', title: '首页' }, { nodeId: 's3', title: '列表页' }] }
      if (name === 'merge_screens') return { pairs: [] }
      if (name === 'classify_lanes')
        return { assignments: [{ nodeId: 's1', lane: 'home', laneTitle: '首页域', confidence: 'high' }] }
      if (name === 'relabel_edges') return { labels: [] }
      return undefined
    })

    const r = await refineGraph(store, ai as never)
    const g = store.get()
    const after = g.nodes.find((n) => n.id === 's1')!
    expect(after.title, '人工改过的标题不被自动命名覆盖').toBe('用户改的名')
    expect(after.lane, '人工改过的泳道不被自动划分覆盖').toBe('custom')
    expect(r.stats.pinnedKept).toBeGreaterThan(0)
  })

  it('问询全部失败时按确定性规则回落：draft 保留、人工接管节点仍归位', async () => {
    const store = new GraphStore('refine-fallback', 'http://x/login.html', 'dev')
    store.ensureLane('login', 'login')
    store.ensureLane(MANUAL_LANE_ID, MANUAL_LANE_TITLE)
    const s1 = store.addNode({
      id: 's1',
      signatureHash: 'sigL',
      lane: 'login',
      kind: 'normal',
      title: '登录页',
      url: 'http://x/login.html',
      createdBy: 'ai',
    })
    s1.draft = true
    const m1 = store.addNode({
      id: 'manual-1',
      signatureHash: 'sigM',
      lane: MANUAL_LANE_ID,
      kind: 'manual',
      title: '页面态：验证码',
      url: 'http://x/captcha.html',
      createdBy: 'human',
    })
    m1.draft = true
    store.addEdge('s1', 'manual-1', '人工操作', 'branch', 'human')
    store.layoutAndSave()

    const ai = fakeAi(() => undefined)
    await refineGraph(store, ai as never)
    const g = store.get()

    expect(g.nodes.find((n) => n.id === 's1')?.draft, '命名失败时保留待整理标记，可再次生成').toBe(true)
    expect(g.nodes.find((n) => n.id === 'manual-1')?.lane, '归类失败也要按继承把接管节点归位').toBe('login')
    expect(g.lanes.some((l) => l.id === MANUAL_LANE_ID), '人工接管泳道必须回收').toBe(false)
  })
})
