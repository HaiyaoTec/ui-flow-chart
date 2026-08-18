import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.', isPackaged: false, getVersion: () => '0.0.0' } }))

const { retryDelay, canAutoDownload, bumpFailure } = await import('../../src/main/updater')

/**
 * 自动下载的失败退避。
 *
 * 检查间隔缩到 30 分钟之后，这条就成了必需品：下载失败后状态是 error，
 * 它拦不住下一次检查再触发一遍下载，而那是一个上百兆的包——
 * 网不稳或按流量计费的用户会被反复拉。
 */
describe('自动下载的失败退避', () => {
  it('10 分钟起步逐次翻倍，封顶 4 小时', () => {
    const min = 60_000
    expect(retryDelay(1) / min).toBe(10)
    expect(retryDelay(2) / min).toBe(20)
    expect(retryDelay(3) / min).toBe(40)
    // 封顶之后就相当于回到从前那个 4 小时的检查节奏
    expect(retryDelay(9) / min).toBe(240)
    expect(retryDelay(99) / min).toBe(240)
    // 次数不合法时按第一次算，别退避出个负数或零
    expect(retryDelay(0)).toBe(retryDelay(1))
  })

  it('同一个版本连续失败会越退越久', () => {
    const t0 = 1_000_000
    const one = bumpFailure(null, '1.2.3', t0)
    expect(one).toMatchObject({ version: '1.2.3', attempts: 1 })
    expect(one.nextAt - t0).toBe(retryDelay(1))

    const two = bumpFailure(one, '1.2.3', t0)
    expect(two.attempts).toBe(2)
    expect(two.nextAt - t0).toBe(retryDelay(2))
  })

  it('换了版本从头算：新包与旧包失败与否没有关系', () => {
    const old = bumpFailure(null, '1.2.3', 0)
    const fresh = bumpFailure(old, '1.3.0', 0)
    expect(fresh).toMatchObject({ version: '1.3.0', attempts: 1 })
    expect(canAutoDownload(old, '1.3.0', 0), '新版本不该被旧版本的失败挡住').toBe(true)
  })

  it('退避期内不自动下载，到点放行', () => {
    const t0 = 1_000_000
    const fail = bumpFailure(null, '1.2.3', t0)
    expect(canAutoDownload(fail, '1.2.3', t0 + 1), '刚失败就重试等于没退避').toBe(false)
    expect(canAutoDownload(fail, '1.2.3', fail.nextAt - 1)).toBe(false)
    expect(canAutoDownload(fail, '1.2.3', fail.nextAt), '到点要放行').toBe(true)
  })

  it('没有失败记录时一律放行', () => {
    expect(canAutoDownload(null, '1.2.3', 0)).toBe(true)
  })
})
