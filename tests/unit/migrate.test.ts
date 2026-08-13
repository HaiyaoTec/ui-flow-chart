import { describe, expect, it } from 'vitest'
import { applyMigrations, type Migration } from '../../src/main/store/migrate'

interface Doc {
  schemaVersion?: number
  a?: number
  b?: number
  c?: number
}

const ms: Array<Migration<Doc>> = [
  { to: 1, run: (d) => ({ ...d, a: 1 }) },
  { to: 2, run: (d) => ({ ...d, b: 2 }) },
  { to: 3, run: (d) => ({ ...d, c: 3 }) },
]

describe('本地数据迁移', () => {
  it('没有版本号的旧文件从 0 开始逐档迁移', () => {
    const r = applyMigrations<Doc>({}, 3, ms)
    expect(r.applied).toEqual([1, 2, 3])
    expect(r.data).toMatchObject({ a: 1, b: 2, c: 3, schemaVersion: 3 })
  })

  it('只跑缺的那几档，不重复执行已完成的迁移', () => {
    const r = applyMigrations<Doc>({ schemaVersion: 2, a: 1, b: 2 }, 3, ms)
    expect(r.applied).toEqual([3])
    expect(r.data.schemaVersion).toBe(3)
  })

  it('已经是目标版本时什么都不做', () => {
    const r = applyMigrations<Doc>({ schemaVersion: 3 }, 3, ms)
    expect(r.applied).toEqual([])
  })

  it('版本比代码还新时不动它——降级运行不能把数据改坏', () => {
    const r = applyMigrations<Doc>({ schemaVersion: 9, a: 42 }, 3, ms)
    expect(r.applied).toEqual([])
    expect(r.data.a).toBe(42)
    expect(r.data.schemaVersion).toBe(9)
  })

  it('某一档抛错就停在上一档，并把原因带出来，不能丢掉已迁移的结果', () => {
    const boom: Array<Migration<Doc>> = [
      { to: 1, run: (d) => ({ ...d, a: 1 }) },
      {
        to: 2,
        run: () => {
          throw new Error('字段缺失')
        },
      },
      { to: 3, run: (d) => ({ ...d, c: 3 }) },
    ]
    const r = applyMigrations<Doc>({}, 3, boom)
    expect(r.applied).toEqual([1])
    expect(r.data).toMatchObject({ a: 1, schemaVersion: 1 })
    expect(r.data.c).toBeUndefined()
    expect(r.failed).toContain('v2')
  })
})
