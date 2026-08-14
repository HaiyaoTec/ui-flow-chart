import { EDGE_LABEL_VERBS, type AiDecideInput } from '@shared/types'

/** 一次发给 AI 的元素清单上限，超出截断，避免长页面把 token 撑爆 */
export const MAX_ELEMENTS = 40

export const SYSTEM_PROMPT = `你是一个网站交互流程分析助手。你会看到某个网站当前界面的截图与可交互元素清单，需要决定下一步操作，以便把这个网站的功能路径逐屏走通并绘制成流程图。

工作方式：
- 每一步你只输出一个动作，动作会被真实执行，然后你会看到新的界面。
- 你要同时为「当前这一屏」命名，并为「上一步动作到这一屏的转移」写一句操作标注。
- 目标是覆盖主干路径与关键的表单校验提示界面，而不是遍历整站的所有页面。

命名要求：
- screen.id 用小写英文与连字符，语义化，如 register-init、login-empty-submit。
- screen.title 用中文规范名词，如「注册抽屉·初始态」「登录·必填项未填校验」。禁止口语化与比喻。
- screen.lane 是泳道 id，把同一功能域的界面归到一条泳道，如 entry / register / login / forgot。优先复用已有泳道。
- screen.kind：normal 正常态，validation 校验或错误提示态。

操作标注 edgeLabel 使用固定动词开头：${EDGE_LABEL_VERBS.join(' / ')}，后接具体对象，并保留界面原文按钮名。
例如：点击「Daftar」、输入手机号（8–13 位）、提交 → 系统校验失败：手机号格式。

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

  const laneLines = input.knownLanes.map((l) => `  ${l.id} — ${l.title}`)
  const nodeLines = input.knownNodes.slice(-30).map((n) => `  ${n.id} [${n.lane}] ${n.title}`)

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
    ``,
    `## 可交互元素（targetIdx 用方括号里的编号）`,
    ...elLines,
    omitted > 0 ? `  …另有 ${omitted} 个元素未列出，必要时先滚动` : ``,
    ``,
    `## 已建立的泳道`,
    laneLines.length ? laneLines.join('\n') : '  （还没有，请为当前界面创建第一条）',
    ``,
    `## 已记录的界面（最近 30 个）`,
    nodeLines.length ? nodeLines.join('\n') : '  （还没有）',
    input.currentNodeId ? `当前所在界面：${input.currentNodeId}` : '',
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
    screen: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '当前界面的语义化 id，小写英文加连字符' },
        title: { type: 'string', description: '当前界面的中文规范名称' },
        lane: { type: 'string', description: '泳道 id，优先复用已有的' },
        laneTitle: { type: 'string', description: '新建泳道时的中文名称' },
        kind: { type: 'string', enum: ['normal', 'validation'], description: '界面性质' },
      },
      required: ['id', 'title', 'lane', 'kind'],
    },
    edgeLabel: { type: 'string', description: '从上一屏到当前屏的操作标注' },
    needHumanReason: { type: 'string', enum: ['login', 'captcha', 'payment', 'other'] },
  },
  required: ['action', 'reason', 'screen', 'edgeLabel'],
} as const

/** 结构提示。OpenAI 侧没有强制工具调用，只能把 schema 写进提示词 */
export const jsonOnlyHint = (schema: unknown): string =>
  `只输出一个 JSON 对象，不要有任何解释文字或 markdown 代码块标记。对象结构：
${JSON.stringify(schema, null, 2)}`

export const JSON_ONLY_HINT = jsonOnlyHint(ACTION_JSON_SCHEMA)
