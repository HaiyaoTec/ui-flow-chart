import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { AiProfile, AiProfileMasked } from '@shared/types'
import { appDataDir, readJson, writeJsonAtomic } from './paths'

/** 落盘形态：密钥永远以 safeStorage 加密后的 base64 存在 */
interface StoredProfile extends AiProfile {
  encryptedKey?: string
}

const file = () => join(appDataDir(), 'profiles.json')
const load = (): StoredProfile[] => readJson<StoredProfile[]>(file(), [])
const save = (list: StoredProfile[]) => writeJsonAtomic(file(), list)

function mask(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

function toMasked(p: StoredProfile): AiProfileMasked {
  let keyMasked = ''
  if (p.encryptedKey) {
    try {
      keyMasked = mask(decryptKey(p.encryptedKey))
    } catch {
      // 换机拷贝配置等场景解密会失败，视为未配置并引导重填，不做明文回退
      keyMasked = '（无法解密，请重新填写）'
    }
  }
  const { encryptedKey: _drop, ...rest } = p
  return { ...rest, keyMasked, hasKey: Boolean(p.encryptedKey) }
}

function encryptKey(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统未提供安全存储能力，无法保存 API Key')
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptKey(encoded: string): string {
  return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
}

export function listProfiles(): AiProfileMasked[] {
  return load().map(toMasked)
}

export function saveProfile(input: Omit<AiProfile, 'createdAt' | 'updatedAt'>, apiKey?: string): AiProfileMasked {
  const list = load()
  const now = new Date().toISOString()
  const idx = list.findIndex((p) => p.id === input.id)
  const id = input.id || randomUUID()

  if (idx >= 0) {
    const prev = list[idx]
    list[idx] = {
      ...prev,
      ...input,
      id,
      updatedAt: now,
      // 未传 apiKey 表示不改动已有密钥
      encryptedKey: apiKey ? encryptKey(apiKey) : prev.encryptedKey,
    }
    save(list)
    return toMasked(list[idx])
  }

  const created: StoredProfile = {
    ...input,
    id,
    createdAt: now,
    updatedAt: now,
    encryptedKey: apiKey ? encryptKey(apiKey) : undefined,
  }
  list.push(created)
  save(list)
  return toMasked(created)
}

export function deleteProfile(id: string): void {
  save(load().filter((p) => p.id !== id))
}

/** 仅主进程内部使用：取出可用的明文密钥，绝不经 IPC 外流 */
export function resolveProfile(id: string): { profile: AiProfile; apiKey: string } | null {
  const stored = load().find((p) => p.id === id)
  if (!stored) return null
  const { encryptedKey, ...profile } = stored
  if (!encryptedKey) return { profile, apiKey: '' }
  try {
    return { profile, apiKey: decryptKey(encryptedKey) }
  } catch {
    return { profile, apiKey: '' }
  }
}
