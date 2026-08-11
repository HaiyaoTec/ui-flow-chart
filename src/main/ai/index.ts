import { resolveProfile } from '../store/credentials'
import { AnthropicProvider } from './anthropicProvider'
import { OpenAiProvider } from './openaiProvider'
import type { IAiClient } from './types'

export function createAiClient(profileId: string): IAiClient {
  const resolved = resolveProfile(profileId)
  if (!resolved) throw new Error(`找不到 AI 配置：${profileId}`)
  const { profile, apiKey } = resolved
  if (!apiKey) throw new Error(`AI 配置「${profile.name}」缺少可用的 API Key，请重新填写`)

  switch (profile.protocol) {
    case 'anthropic':
      return new AnthropicProvider(profile, apiKey)
    case 'openai':
    default:
      return new OpenAiProvider(profile, apiKey)
  }
}

export * from './types'
