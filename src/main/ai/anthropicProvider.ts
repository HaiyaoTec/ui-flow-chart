import type { AiAction, AiDecideInput, AiProfile, AiTestResult } from '@shared/types'
import { parseAction, parseActionObject } from './parseAction'
import { ACTION_JSON_SCHEMA, buildUserText, SYSTEM_PROMPT } from './prompt'
import { AiError, PIXEL_JPEG_BASE64, withTimeout, type IAiClient } from './types'

interface AnthropicContent {
  type: string
  text?: string
  name?: string
  input?: unknown
}
interface AnthropicResponse {
  content?: AnthropicContent[]
  model?: string
  error?: { message?: string }
}

const TOOL_NAME = 'decide_action'

/** Anthropic Messages 协议。用强制工具调用拿结构化输出，比解析文本 JSON 稳得多 */
export class AnthropicProvider implements IAiClient {
  readonly name = 'anthropic'

  constructor(
    private readonly profile: AiProfile,
    private readonly apiKey: string
  ) {}

  private endpoint(): string {
    const base = this.profile.baseUrl.replace(/\/+$/, '')
    if (/\/messages$/.test(base)) return base
    if (/\/v1$/.test(base)) return `${base}/messages`
    return `${base}/v1/messages`
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...(this.profile.extraHeaders ?? {}),
    }
  }

  private async post(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<AnthropicResponse> {
    const t = withTimeout(timeoutMs, signal)
    try {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: t.signal,
      })
      const text = await res.text()
      let json: AnthropicResponse
      try {
        json = JSON.parse(text) as AnthropicResponse
      } catch {
        throw new AiError(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, res.status, res.status >= 500)
      }
      if (!res.ok) {
        const msg = json.error?.message ?? text.slice(0, 300)
        throw new AiError(`HTTP ${res.status}：${msg}`, res.status, res.status === 429 || res.status >= 500)
      }
      return json
    } finally {
      t.done()
    }
  }

  async decide(input: AiDecideInput, signal?: AbortSignal): Promise<AiAction> {
    const json = await this.post(
      {
        model: this.profile.model,
        max_tokens: 1200,
        temperature: 0.1,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: TOOL_NAME,
            description: '给出本步要执行的动作，以及当前界面的命名与转移标注',
            input_schema: ACTION_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildUserText(input) },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: input.screenshotJpegBase64 },
              },
            ],
          },
        ],
      },
      90_000,
      signal
    )

    const toolUse = json.content?.find((c) => c.type === 'tool_use' && c.name === TOOL_NAME)
    if (toolUse?.input) return parseActionObject(toolUse.input)

    // 模型未走工具（少见，多见于中转网关不支持 tools）时退回文本解析
    const text = json.content?.map((c) => c.text ?? '').join('\n') ?? ''
    if (!text.trim()) throw new AiError('模型既未返回工具调用也未返回文本')
    return parseAction(text)
  }

  async testConnection(signal?: AbortSignal): Promise<AiTestResult> {
    const started = Date.now()
    try {
      const json = await this.post(
        {
          model: this.profile.model,
          max_tokens: 32,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '这张图是纯色的 1×1 像素。只回答两个字：可见' },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PIXEL_JPEG_BASE64 } },
              ],
            },
          ],
        },
        30_000,
        signal
      )
      const echo = (json.content ?? []).map((c) => c.text ?? '').join('').trim()
      return { ok: true, latencyMs: Date.now() - started, echo, vision: echo.length > 0 }
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
