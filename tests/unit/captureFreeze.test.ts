import { describe, expect, it, vi } from 'vitest'
import { CH } from '@shared/ipc-contract'

// previewManager 的依赖链会拉进 electron 与真实窗口模块，单测里全部替身
vi.mock('electron', () => ({
  nativeImage: {},
  session: { fromPartition: () => ({}) },
  WebContentsView: class {},
}))

const uiView = { id: 'ui' }
const sent: { channel: string; payload: unknown }[] = []
const ui = {
  send: (channel: string, payload: unknown) => {
    sent.push({ channel, payload })
  },
}
vi.mock('../../src/main/window', () => ({
  getUiContents: () => ui,
  getUiView: () => uiView,
}))

const { PreviewManager } = await import('../../src/main/engine/previewManager')

/** 记录层级变化：谁被挂到最后就是谁在最上层 */
function makeWin(order: string[]): unknown {
  return {
    isDestroyed: () => false,
    on: () => {},
    off: () => {},
    contentView: {
      removeChildView: () => {},
      addChildView: (v: { id: string }) => order.push(v.id),
    },
  }
}

type Hooks = { onCapture?: () => void; frame?: string }

function setup(hooks: Hooks = {}): {
  pm: InstanceType<typeof PreviewManager>
  order: string[]
  ack: () => Promise<void>
} {
  const order: string[] = []
  sent.length = 0
  const pm = new PreviewManager()
  pm.bindWindow(makeWin(order) as never)
  const driver = {
    id: 'preview',
    view: { id: 'preview' },
    attached: true,
    isVisible: () => true,
    capturePreviewFrame: async () => hooks.frame ?? 'AAAA',
    screenshot: async () => {
      hooks.onCapture?.()
      return { png: Buffer.alloc(0), jpegBase64: 'shot' }
    },
  }
  ;(pm as unknown as { driver: unknown }).driver = driver
  // 渲染进程的回执：等静帧真的发出来，再按主进程给的令牌回报
  const ack = async (): Promise<void> => {
    for (let i = 0; i < 50 && !sent.length; i += 1) await new Promise((r) => setTimeout(r, 5))
    const first = sent.find((e) => e.channel === CH.evPreviewFreeze)
    pm.noteFreezePainted((first?.payload as { token: number }).token)
  }
  return { pm, order, ack }
}

describe('抓存档图期间的静帧', () => {
  it('先贴静帧再抬界面，抓完放回预览并撤掉静帧', async () => {
    const steps: string[] = []
    const { pm, order, ack } = setup({ onCapture: () => steps.push('screenshot') })
    const p = pm.captureArchival()
    // 回执之前不许抬界面，否则露出的是界面自己的屏幕底板
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    expect(sent[0].channel).toBe(CH.evPreviewFreeze)
    expect((sent[0].payload as { image: string }).image).toMatch(/^data:image\/jpeg;base64,/)

    await ack()
    const shot = await p
    expect(shot.jpegBase64).toBe('shot')
    expect(steps).toEqual(['screenshot'])
    // 界面先上、预览后回
    expect(order).toEqual(['ui', 'preview'])
    // 收尾撤掉静帧
    expect((sent.at(-1)?.payload as { image: string }).image).toBe('')
  })

  it('渲染进程不回执时按超时继续，不把抓图卡住', async () => {
    const { pm, order } = setup()
    const shot = await pm.captureArchival()
    expect(shot.jpegBase64).toBe('shot')
    expect(order).toEqual(['ui', 'preview'])
  })

  it('抓图途中有弹层抬起界面时，收尾不把预览放回去盖住它', async () => {
    let pm!: InstanceType<typeof PreviewManager>
    const ctx = setup({ onCapture: () => pm.setStackFront('ui') })
    pm = ctx.pm
    const p = ctx.pm.captureArchival()
    await ctx.ack()
    await p
    // 自己抬的那次 + 弹层抬的那次，没有把预览放回去的动作
    expect(ctx.order).toEqual(['ui', 'ui'])
  })

  it('视图不可见时不做静帧，直接抓图', async () => {
    const { pm, order } = setup()
    ;(pm as unknown as { driver: { isVisible: () => boolean } }).driver.isVisible = () => false
    await pm.captureArchival()
    expect(sent).toEqual([])
    expect(order).toEqual([])
  })
})
