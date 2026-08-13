import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { migrateFile, type Migration } from './migrate'
import { appDataDir, readJson, writeJsonAtomic } from './paths'

const file = () => join(appDataDir(), 'settings.json')

/** 当前设置文件的结构版本。加字段不必升版；改字段含义或重命名才升 */
export const SETTINGS_SCHEMA = 1

type Stored = Partial<AppSettings> & { schemaVersion?: number }

const MIGRATIONS: Array<Migration<Stored>> = [
  // v0 → v1：0.2.0 引入自动更新，老配置里没有这两个开关，按默认值补齐
  {
    to: 1,
    run: (d) => ({
      autoCheckUpdate: DEFAULT_SETTINGS.autoCheckUpdate,
      autoDownloadUpdate: DEFAULT_SETTINGS.autoDownloadUpdate,
      ...d,
    }),
  },
]

/** 启动时跑一次。失败只记不抛——升级完打不开应用是最糟的结果 */
export function migrateSettings(): string | undefined {
  return migrateFile<Stored>(file(), {}, SETTINGS_SCHEMA, MIGRATIONS).failed
}

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Stored>(file(), {}) }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch, schemaVersion: SETTINGS_SCHEMA }
  writeJsonAtomic(file(), next)
  return next
}
