import { afterEach, describe, expect, it } from 'vitest'
import { deoverlapLabels } from '../../src/shared/canvas-core/deoverlap'

/**
 * 标注避让层的两条不变量。
 *
 * 回归背景：这个函数原先把首次看到的 top 缓存在 data-top 上当基线，此后每轮都拿
 * 这个过期值加位移写回 style.top。而标注 DOM 是按边 id 复用的，重新布局时渲染层
 * 只改 style.top、不动 dataset，于是标注被永久钉在第一次布局的纵坐标上——
 * 泳道每多一行就与连线拉开约一屏，表现为标注飘在大片空白里。
 *
 * 这层逻辑住在 DOM 回写上，几何用例锁不住它。项目里没有 jsdom，
 * 这里搭一个极小的替身：函数只用到 querySelectorAll、dataset、style 与 offset 尺寸，
 * 够覆盖「基线取自渲染层」与「幂等」这两条——正是本次改动的不变量。
 */

interface FakeEl {
  dataset: Record<string, string | undefined>
  style: {
    left: string
    top: string
    _props: Record<string, string>
    setProperty(k: string, v: string): void
  }
  offsetWidth: number
  offsetHeight: number
  className: string
}

function el(left: number, top: number, w = 0, h = 0): FakeEl {
  const props: Record<string, string> = {}
  return {
    dataset: {},
    style: {
      left: `${left}px`,
      top: `${top}px`,
      _props: props,
      setProperty(k, v) {
        props[k] = v
      },
    },
    offsetWidth: w,
    offsetHeight: h,
    className: 'ufc-label',
  }
}

function install(labels: FakeEl[]): void {
  ;(globalThis as unknown as { document: unknown }).document = {
    querySelectorAll: (sel: string) => (sel === '.ufc-label' ? labels : []),
  }
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
})

describe('标注避让', () => {
  it('基线始终取自渲染层写入的 top，不做跨帧缓存', () => {
    const a = el(100, 200)
    install([a])
    deoverlapLabels()
    expect(a.dataset.top, '不应再往 dataset 上缓存基线').toBeUndefined()

    // 模拟重新布局：渲染层把标注挪到新位置
    a.style.top = '1038px'
    deoverlapLabels()
    // 避让层只写偏移，绝不覆写 top；新位置必须原样保留
    expect(a.style.top).toBe('1038px')
    expect(a.style._props['--dy']).toBe('0px')
  })

  it('连续调用不累积偏移', () => {
    const a = el(100, 200)
    const b = el(100, 200)
    install([a, b])
    deoverlapLabels()
    const first = [a.style._props['--dy'], b.style._props['--dy']]
    deoverlapLabels()
    deoverlapLabels()
    expect([a.style._props['--dy'], b.style._props['--dy']]).toEqual(first)
    expect(a.style.top).toBe('200px')
    expect(b.style.top).toBe('200px')
  })
})
