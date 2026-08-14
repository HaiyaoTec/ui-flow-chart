import type { AiAction, AiDecideInput, AiProfile, AiTestResult } from '@shared/types'
import { parseAction } from './parseAction'
import { buildUserText, JSON_ONLY_HINT, jsonOnlyHint, SYSTEM_PROMPT } from './prompt'
import { AiError, PIXEL_JPEG_BASE64, withTimeout, type IAiClient, type ReviewTask } from './types'

interface ChatChoice {
  message?: { content?: string | null }
  finish_reason?: string
}
interface ChatResponse {
  choices?: ChatChoice[]
  model?: string
  error?: { message?: string }
}

/** OpenAI 兼容协议：覆盖 OpenAI / DeepSeek / Qwen / Kimi / GLM / Ollama 及多数中转网关 */
export class OpenAiProvider implements IAiClient {
  readonly name = 'openai'
  /** 首次收到 400 且提示不支持 response_format 时置位，后续请求不再带该参数 */
  private jsonModeUnsupported = false

  constructor(
    private readonly profile: AiProfile,
    private readonly apiKey: string
  ) {}

  private endpoint(): string {
    const base = this.profile.baseUrl.replace(/\/+$/, '')
    // 允许用户填到 /v1 或填完整 endpoint
    if (/\/chat\/completions$/.test(base)) return base
    return `${base}/chat/completions`
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.profile.extraHeaders ?? {}),
    }
  }

  private async post(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<ChatResponse> {
    const t = withTimeout(timeoutMs, signal)
    try {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: t.signal,
      })
      const text = await res.text()
      let json: ChatResponse
      try {
        json = JSON.parse(text) as ChatResponse
      } catch {
        throw new AiError(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, res.status, res.status >= 500)
      }
      if (!res.ok) {
        const msg = json.error?.message ?? text.slice(0, 300)
        // 429 与 5xx 可重试
        throw new AiError(`HTTP ${res.status}：${msg}`, res.status, res.status === 429 || res.status >= 500)
      }
      return json
    } finally {
      t.done()
    }
  }

  private buildBody(input: AiDecideInput, forceJsonMode: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.profile.model,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\n${JSON_ONLY_HINT}` },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildUserText(input) },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${input.screenshotJpegBase64}`, detail: 'high' },
            },
          ],
        },
      ],
    }
    if (forceJsonMode) body.response_format = { type: 'json_object' }
    return body
  }

  /** 服务端不认 response_format 时降级重试一次。标志位是实例级的，两个入口共享 */
  private async postWithJsonFallback(
    bodyOf: (jsonMode: boolean) => unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const useJsonMode = !this.jsonModeUnsupported
    try {
      return await this.post(bodyOf(useJsonMode), timeoutMs, signal)
    } catch (e) {
      if (useJsonMode && e instanceof AiError && e.status === 400) {
        this.jsonModeUnsupported = true
        return this.post(bodyOf(false), timeoutMs, signal)
      }
      throw e
    }
  }

  async decide(input: AiDecideInput, signal?: AbortSignal): Promise<AiAction> {
    const json = await this.postWithJsonFallback((m) => this.buildBody(input, m), 90_000, signal)
    const content = json.choices?.[0]?.message?.content ?? ''
    if (!content.trim()) throw new AiError('模型返回空内容')
    return parseAction(content)
  }

  /**
   * 纯文本问询。不能复用 buildBody——它无条件拼一张截图，
   * 收尾整理要问的是一批已经录好的界面，带图既没必要又容易撑爆上下文。
   */
  async review<T>(task: ReviewTask<T>, signal?: AbortSignal): Promise<T> {
    const bodyOf = (jsonMode: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: this.profile.model,
        temperature: 0,
        max_tokens: task.maxTokens,
        messages: [
          { role: 'system', content: `${task.system}

${jsonOnlyHint(task.schema)}` },
          { role: 'user', content: task.user },
        ],
      }
      if (jsonMode) body.response_format = { type: 'json_object' }
      return body
    }
    const json = await this.postWithJsonFallback(bodyOf, task.timeoutMs, signal)
    const content = json.choices?.[0]?.message?.content ?? ''
    if (!content.trim()) throw new AiError('模型返回空内容')
    return task.parse(content)
  }

  async testConnection(signal?: AbortSignal): Promise<AiTestResult> {
    const started = Date.now()
    try {
      const json = await this.post(
        {
          model: this.profile.model,
          max_tokens: 32,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '这张图是纯色的 1×1 像素。只回答两个字：可见' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PIXEL_JPEG_BASE64}` } },
              ],
            },
          ],
        },
        30_000,
        signal
      )
      const echo = json.choices?.[0]?.message?.content?.trim() ?? ''
      return { ok: true, latencyMs: Date.now() - started, echo, vision: echo.length > 0 }
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
