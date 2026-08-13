import { copyFileSync, existsSync } from 'node:fs'
import { readJson, writeJsonAtomic } from './paths'

/**
 * 本地数据的版本迁移。
 *
 * 有了自动更新，用户会跨版本升级，本地文件必然出现「旧格式遇上新代码」。
 * 三条原则：
 * 1. 每个文件自带 schemaVersion，按顺序逐档迁移，不做跨版本的一步到位
 * 2. 动手之前先备份成 .bak，出问题还能人工捞回来
 * 3. 迁移失败不阻断启动——宁可退回默认值并留下日志，也不能让用户升级完打不开应用
 */
export interface Migration<T> {
  /** 迁移到的目标版本号 */
  to: number
  run: (data: T) => T
}

export interface Migrated<T> {
  data: T
  /** 实际执行过的迁移档位，供日志与测试断言 */
  applied: number[]
  failed?: string
}

interface Versioned {
  schemaVersion?: number
}

/**
 * 纯函数形式的迁移，便于单测：不碰文件系统。
 * from 缺省视为 0（历史文件没有版本号）。
 */
export function applyMigrations<T extends Versioned>(
  data: T,
  target: number,
  migrations: Array<Migration<T>>
): Migrated<T> {
  const applied: number[] = []
  let cur = { ...data }
  const from = cur.schemaVersion ?? 0
  if (from >= target) return { data: cur, applied }

  for (const m of [...migrations].sort((a, b) => a.to - b.to)) {
    if (m.to <= from || m.to > target) continue
    try {
      cur = { ...m.run(cur), schemaVersion: m.to }
      applied.push(m.to)
    } catch (e) {
      // 停在最后一个成功的档位上，把原因带出去
      return { data: cur, applied, failed: `迁移到 v${m.to} 失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { data: { ...cur, schemaVersion: target }, applied }
}

/** 读文件 → 迁移 → 有变更才回写，回写前先备份 */
export function migrateFile<T extends Versioned>(
  file: string,
  fallback: T,
  target: number,
  migrations: Array<Migration<T>>
): Migrated<T> {
  const raw = readJson<T>(file, fallback)
  const r = applyMigrations(raw, target, migrations)
  if (r.applied.length === 0) return r
  try {
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    writeJsonAtomic(file, r.data)
  } catch (e) {
    return { ...r, failed: `写回失败：${e instanceof Error ? e.message : String(e)}` }
  }
  return r
}
