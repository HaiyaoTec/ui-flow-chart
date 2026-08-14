import type { AiAction, AiDecideInput, AiTestResult } from '@shared/types'

/**
 * 一次结构化的纯文本问询。
 *
 * 收尾整理要问两件事（把人工接管的界面归到哪条泳道、同一对界面之间该留哪几条线），
 * 两件事的输入输出都不一样，但走的通道是同一条：纯文本 + 强制 JSON 结构。
 * 因此给 IAiClient 加的是一个通用能力，而不是两个专用方法。
 */
export interface ReviewTask<T> {
  /** 工具名兼日志名。必须与动作调用的工具名区分开 */
  name: string
  description: string
  system: string
  user: string
  /** Anthropic 当 tool 的 input_schema；OpenAI 拼进提示词 */
  schema: Record<string, unknown>
  maxTokens: number
  timeoutMs: number
  /** 解析并校验。失败抛 ActionParseError */
  parse: (raw: string) => T
  parseObject: (obj: unknown) => T
}

/** 探索引擎依赖的 AI 抽象。真实 provider 与测试用 fake 都实现它 */
export interface IAiClient {
  readonly name: string
  decide(input: AiDecideInput, signal?: AbortSignal): Promise<AiAction>
  /** 纯文本的结构化问询，用于探索收尾的图谱整理 */
  review<T>(task: ReviewTask<T>, signal?: AbortSignal): Promise<T>
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
