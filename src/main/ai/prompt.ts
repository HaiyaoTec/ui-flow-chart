import type { AiDecideInput } from '@shared/types'

/** 一次发给 AI 的元素清单上限，超出截断，避免长页面把 token 撑爆 */
export const MAX_ELEMENTS = 40

/**
 * 探索问询只做一件事：从元素清单里选下一步动作。
 *
 * 界面命名、泳道归属、连线标注全部移到图谱生成阶段批量补齐——那时全站结构已知，
 * 归类一致性更好；探索期的单步任务因此收敛为封闭选择，对模型能力的要求显著降低。
 */
export const SYSTEM_PROMPT = `你是一个网站交互流程探索助手。你会看到某个网站当前界面的截图与可交互元素清单，需要决定下一步操作，以便把这个网站的功能路径逐屏走通。界面的命名与整理由后续流程完成，你只负责走对路。

工作方式：
- 每一步你只输出一个动作，动作会被真实执行，然后你会看到新的界面。
- 目标是覆盖主干路径与关键的表单校验提示界面，而不是遍历整站的所有页面。
- 同一界面反复出现说明在绕圈，换一个没试过的入口，或用 back 退出。

填写表单时使用明显的测试数据，禁止编造真实的个人身份信息、真实手机号或邮箱。
遇到需要真人介入才能推进的环节（登录墙、图形验证码、短信/邮件验证码、支付），输出 need_human 并说明原因，不要尝试绕过。
当主干路径与关键校验态已覆盖，或没有值得继续探索的新界面时，输出 done。`

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 构造每步的用户提示文本。不累积对话历史，状态全靠这段摘要携带 */
export function buildUserText(input: AiDecideInput): string {
  const els = input.probe.elements.slice(0, MAX_ELEMENTS)
  const elLines = els.map((e) => {
    const label = e.text || e.placeholder || e.name || '(无文案)'
    const flags = [e.disabled ? '禁用' : '', e.checked === true ? '已勾选' : e.checked === false ? '未勾选' : '']
      .filter(Boolean)
      .join(' ')
    return `  [${e.idx}] <${e.tag}${e.type ? ':' + e.type : ''}> ${truncate(label, 40)}${flags ? ` (${flags})` : ''}`
  })
  const omitted = input.probe.elements.length - els.length

  return [
    `## 探索目标`,
    input.goal,
    ``,
    `## 当前状态`,
    `第 ${input.step} 步；剩余步数 ${input.budgets.stepsLeft}，剩余 AI 调用 ${input.budgets.aiCallsLeft}`,
    `当前地址：${input.probe.url}`,
    `页面标题：${input.probe.title}`,
    input.probe.hasDialog ? `当前有弹窗，元素清单已收敛到弹窗内` : `当前无弹窗`,
    input.probe.notices.length ? `界面上的提示文案：${input.probe.notices.join(' / ')}` : ``,
    input.probe.iframeHosts.length ? `页面含跨域 iframe：${input.probe.iframeHosts.join(', ')}（探针无法读取其内部）` : ``,
    `滚动位置 ${Math.round(input.probe.scrollY)} / ${Math.round(input.probe.scrollHeight - input.probe.viewportHeight)}`,
    input.visitCount && input.visitCount > 1 ? `这个界面已经是第 ${input.visitCount} 次出现，优先选没试过的入口或退出` : ``,
    ``,
    `## 可交互元素（targetIdx 用方括号里的编号）`,
    ...elLines,
    omitted > 0 ? `  …另有 ${omitted} 个元素未列出，必要时先滚动` : ``,
    ``,
    input.lastOutcome ? `## 上一步结果\n${input.lastOutcome}` : '',
    input.forbidden?.length ? `\n## 禁止再选的动作（会导致回环）\n${input.forbidden.map((f) => `  - ${f}`).join('\n')}` : '',
    ``,
    `请决定下一步动作。`,
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** AiAction 的 JSON Schema，Anthropic 用作 tool input schema，OpenAI 用作提示内的结构说明 */
export const ACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['click', 'fill', 'scroll', 'back', 'done', 'need_human'],
      description: '本步要执行的动作',
    },
    targetIdx: { type: 'integer', description: 'click 与 fill 必填，取自可交互元素清单的编号' },
    value: { type: 'string', description: 'fill 时要输入的测试数据' },
    scrollDelta: { type: 'integer', description: 'scroll 时的纵向滚动像素，正数向下' },
    reason: { type: 'string', description: '选择该动作的简要理由' },
    needHumanReason: { type: 'string', enum: ['login', 'captcha', 'payment', 'other'] },
  },
  required: ['action', 'reason'],
} as const

/** 结构提示。OpenAI 侧没有强制工具调用，只能把 schema 写进提示词 */
export const jsonOnlyHint = (schema: unknown): string =>
  `只输出一个 JSON 对象，不要有任何解释文字或 markdown 代码块标记。对象结构：
${JSON.stringify(schema, null, 2)}`

export const JSON_ONLY_HINT = jsonOnlyHint(ACTION_JSON_SCHEMA)
