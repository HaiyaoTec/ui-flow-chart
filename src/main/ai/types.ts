import type { AiAction, AiDecideInput, AiTestResult } from '@shared/types'

/** 探索引擎依赖的 AI 抽象。真实 provider 与测试用 fake 都实现它 */
export interface IAiClient {
  readonly name: string
  decide(input: AiDecideInput, signal?: AbortSignal): Promise<AiAction>
  testConnection(signal?: AbortSignal): Promise<AiTestResult>
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'AiError'
  }
}

/** 1×1 透明像素 JPEG，用于连接测试时验证视觉通路 */
export const PIXEL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

export function withTimeout(ms: number, signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时（${ms}ms）`)), ms)
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
