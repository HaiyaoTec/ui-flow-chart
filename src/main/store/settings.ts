import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { appDataDir, readJson, writeJsonAtomic } from './paths'

const file = () => join(appDataDir(), 'settings.json')

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>(file(), {}) }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  writeJsonAtomic(file(), next)
  return next
}
