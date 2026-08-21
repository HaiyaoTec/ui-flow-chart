import { z } from 'zod'
import type { AiAction } from '@shared/types'

/**
 * 探索问询的输出结构。界面命名与连线标注已移到图谱生成阶段，
 * 这里只剩动作本身；模型多输出的字段（旧版的 screen / edgeLabel）会被剥掉。
 */
export const actionSchema = z.object({
  action: z.enum(['click', 'fill', 'scroll', 'back', 'done', 'need_human', 'ask']),
  targetIdx: z.number().int().nonnegative().optional(),
  value: z.string().max(200).optional(),
  scrollDelta: z.number().int().optional(),
  reason: z.string().min(1).max(500),
  needHumanReason: z.enum(['login', 'captcha', 'payment', 'other']).optional(),
  question: z.string().max(300).optional(),
  options: z.array(z.string().min(1).max(60)).max(4).optional(),
  allowInput: z.boolean().optional(),
  sensitive: z.boolean().optional(),
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

const detailOf = (e: unknown): string =>
  e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(e)

/**
 * 从模型输出里抠出 JSON 并按 schema 校验。
 *
 * 模型经常把 JSON 包在 markdown 代码块里、或前后带解释文字，这里逐层降级容错。
 * 泛型化是为了让收尾整理的两个任务（归类、审边）共用同一套抽取与降级，
 * 不必各写一遍。
 */
export function parseWithSchema<S extends z.ZodTypeAny>(raw: string, schema: S, label: string): z.output<S> {
  const candidates = extractJsonCandidates(raw)
  if (candidates.length === 0) throw new ActionParseError(`${label}：输出中找不到 JSON 对象`, raw)

  let lastErr: unknown
  for (const text of candidates) {
    try {
      return schema.parse(JSON.parse(text))
    } catch (e) {
      lastErr = e
    }
  }
  throw new ActionParseError(`${label}：JSON 不符合结构——${detailOf(lastErr)}`, raw)
}

/** 已经是对象（强制工具调用的场景）时直接校验 */
export function parseObjectWithSchema<S extends z.ZodTypeAny>(obj: unknown, schema: S, label: string): z.output<S> {
  try {
    return schema.parse(obj)
  } catch (e) {
    throw new ActionParseError(`${label}：工具调用参数不符合结构——${detailOf(e)}`, JSON.stringify(obj))
  }
}

export function parseAction(raw: string): AiAction {
  return normalize(parseWithSchema(raw, actionSchema, '动作') as AiAction)
}

/** 已经是对象（Anthropic 强制工具调用的场景）时直接校验 */
export function parseActionObject(obj: unknown): AiAction {
  return normalize(parseObjectWithSchema(obj, actionSchema, '动作') as AiAction)
}

/** 泳道 id 的口径与动作 schema 里的 transform 保持一致 */
export const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')

function normalize(a: AiAction): AiAction {
  const out = { ...a }
  if (out.action === 'scroll' && !out.scrollDelta) out.scrollDelta = 600
  if (out.action === 'need_human' && !out.needHumanReason) out.needHumanReason = 'other'
  if (out.action === 'ask') {
    // 没有问题的提问没法答，退化为整屏接管；没给选项又不许输入的同理放开输入
    if (!out.question?.trim()) {
      out.action = 'need_human'
      out.needHumanReason ??= 'other'
    } else if (!out.options?.length && !out.allowInput) {
      out.allowInput = true
    }
  }
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
