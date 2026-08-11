import { z } from 'zod'
import type { AiAction } from '@shared/types'

export const actionSchema = z.object({
  action: z.enum(['click', 'fill', 'scroll', 'back', 'done', 'need_human']),
  targetIdx: z.number().int().nonnegative().optional(),
  value: z.string().max(200).optional(),
  scrollDelta: z.number().int().optional(),
  reason: z.string().min(1).max(500),
  screen: z.object({
    id: z
      .string()
      .min(1)
      .max(60)
      .transform((s) =>
        s
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
      ),
    title: z.string().min(1).max(80),
    lane: z
      .string()
      .min(1)
      .max(40)
      .transform((s) =>
        s
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
      ),
    laneTitle: z.string().max(40).optional(),
    kind: z.enum(['normal', 'validation']).default('normal'),
  }),
  edgeLabel: z.string().min(1).max(120),
  needHumanReason: z.enum(['login', 'captcha', 'payment', 'other']).optional(),
})

export class ActionParseError extends Error {
  constructor(
    message: string,
    readonly raw: string
  ) {
    super(message)
    this.name = 'ActionParseError'
  }
}

/**
 * 从模型输出里抠出 JSON 并校验。
 * 模型经常把 JSON 包在 markdown 代码块里、或前后带解释文字，这里逐层降级容错。
 */
export function parseAction(raw: string): AiAction {
  const candidates = extractJsonCandidates(raw)
  if (candidates.length === 0) throw new ActionParseError('输出中找不到 JSON 对象', raw)

  let lastErr: unknown
  for (const text of candidates) {
    try {
      const parsed = actionSchema.parse(JSON.parse(text))
      return normalize(parsed as AiAction)
    } catch (e) {
      lastErr = e
    }
  }
  const detail = lastErr instanceof z.ZodError ? lastErr.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(lastErr)
  throw new ActionParseError(`JSON 不符合动作结构：${detail}`, raw)
}

/** 已经是对象（Anthropic 强制工具调用的场景）时直接校验 */
export function parseActionObject(obj: unknown): AiAction {
  try {
    return normalize(actionSchema.parse(obj) as AiAction)
  } catch (e) {
    const detail = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(e)
    throw new ActionParseError(`工具调用参数不符合动作结构：${detail}`, JSON.stringify(obj))
  }
}

function normalize(a: AiAction): AiAction {
  const out = { ...a }
  if (out.action === 'scroll' && !out.scrollDelta) out.scrollDelta = 600
  if (out.action === 'need_human' && !out.needHumanReason) out.needHumanReason = 'other'
  if (!out.screen.id) out.screen.id = 'screen'
  return out
}

function extractJsonCandidates(raw: string): string[] {
  const out: string[] = []
  const text = raw.trim()

  // 1) 整体就是 JSON
  if (text.startsWith('{')) out.push(text)

  // 2) markdown 代码块
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const body = m[1].trim()
    if (body.startsWith('{')) out.push(body)
  }

  // 3) 第一个平衡的花括号片段（处理前后有解释文字的情况）
  const balanced = firstBalancedObject(text)
  if (balanced) out.push(balanced)

  return [...new Set(out)]
}

function firstBalancedObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}
