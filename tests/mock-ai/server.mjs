// 脚本化的 AI 模拟服务，同时实现 OpenAI 与 Anthropic 两种协议的响应形状。
// 它按「当前页面 + 已推进到第几步」决定动作，而不是盲目按调用次数返回，
// 这样即使探索循环多跑或少跑一轮，脚本依然对得上。
//
//   node tests/mock-ai/server.mjs [port] [scenario]
//   scenario: normal | badjson | flaky
import { createServer } from 'node:http'

// 注意别用 4190：它在 Chromium 的受限端口黑名单里（sieve），fetch 会直接以 bad port 失败
const PORT = Number(process.argv[2] || 4192)
const SCENARIO = process.argv[3] || 'normal'

/** 每个页面推进到第几步 */
const progress = new Map()
let callCount = 0

/** 从提示文本里还原可交互元素清单 */
function parseElements(text) {
  const out = []
  for (const m of text.matchAll(/\[(\d+)\] <([^>]+)> (.*)/g)) {
    out.push({ idx: Number(m[1]), tag: m[2], label: m[3].trim() })
  }
  return out
}

function currentUrl(text) {
  const m = text.match(/当前地址：(\S+)/)
  return m ? m[1] : ''
}

function find(elements, re) {
  return elements.find((e) => re.test(e.label))
}

/** 提示文案行，用于按界面状态驱动 */
function noticesOf(text) {
  const m = text.match(/界面上的提示文案：(.*)/)
  return m ? m[1] : ''
}

/** 依据页面决定下一步 */
function decide(text) {
  const url = currentUrl(text)
  const els = parseElements(text)
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '') || '/'
  const step = progress.get(path) ?? 0
  progress.set(path, step + 1)

  const screen = (id, title, lane, laneTitle, kind = 'normal') => ({ id, title, lane, laneTitle, kind })

  if (path === '/' || path.endsWith('index.html')) {
    // 注册流程已经走过一轮就收敛，避免在首页与注册页之间来回打转
    if ((progress.get('/register.html') ?? 0) > 4) {
      return {
        action: 'done',
        reason: '注册流程已覆盖，没有更多值得探索的入口',
        screen: screen('home', '首页', 'entry', '入口'),
        edgeLabel: '返回首页',
      }
    }
    const reg = find(els, /注册/)
    return {
      action: 'click',
      targetIdx: reg ? reg.idx : 0,
      reason: '从首页进入注册流程',
      screen: screen('home', '首页', 'entry', '入口'),
      edgeLabel: '打开站点',
    }
  }

  if (path.endsWith('register.html')) {
    const phone = find(els, /手机号/)
    const pwd = els.find((e) => /6-20/.test(e.label))
    const confirm = els.find((e) => /再次输入/.test(e.label))
    const submit = els.find((e) => e.tag.startsWith('button'))
    const notices = noticesOf(text)

    // 依据界面上的提示文案决定下一步，而不是数调用次数——
    // 这样即使循环多跑几轮（重试、去重命中），脚本也不会错位。
    if (/长度需为/.test(notices)) {
      return {
        action: 'fill',
        targetIdx: phone.idx,
        value: '13800138000',
        reason: '手机号格式不合法，改填合法号码',
        screen: screen('register-phone-invalid', '手机号格式错误', 'register', '注册', 'validation'),
        edgeLabel: '输入手机号（过短）→ 系统校验失败',
      }
    }
    if (/两次输入的密码不一致/.test(notices) && confirm) {
      return {
        action: 'fill',
        targetIdx: confirm.idx,
        value: 'test123456',
        reason: '补齐确认密码',
        screen: screen('register-pwd-mismatch', '两次密码不一致', 'register', '注册', 'validation'),
        edgeLabel: '提交 → 系统校验失败：确认密码',
      }
    }
    if (/密码不能为空/.test(notices) && pwd) {
      return {
        action: 'fill',
        targetIdx: pwd.idx,
        value: 'test123456',
        reason: '补齐密码',
        screen: screen('register-empty-submit', '空表单提交校验', 'register', '注册', 'validation'),
        edgeLabel: '提交「注册」→ 系统校验失败',
      }
    }
    if (step === 0 && phone) {
      return {
        action: 'fill',
        targetIdx: phone.idx,
        value: '12',
        reason: '先用过短的手机号触发格式校验',
        screen: screen('register-init', '注册表单·初始态', 'register', '注册'),
        edgeLabel: '点击「注册」',
      }
    }
    if (submit) {
      return {
        action: 'click',
        targetIdx: submit.idx,
        reason: '提交注册表单',
        screen: screen('register-filled', '表单已填写', 'register', '注册'),
        edgeLabel: '修正后重试',
      }
    }
  }

  if (path.endsWith('login.html')) {
    const submit = els.find((e) => e.tag.startsWith('button'))
    return {
      action: 'click',
      targetIdx: submit ? submit.idx : 0,
      reason: '提交登录',
      screen: screen('login-init', '登录表单', 'login', '登录'),
      edgeLabel: '切换到登录',
    }
  }

  if (path.endsWith('captcha.html')) {
    return {
      action: 'need_human',
      needHumanReason: 'captcha',
      reason: '图形验证码需要真人识别',
      screen: screen('captcha', '安全验证·图形验证码', 'login', '登录'),
      edgeLabel: '提交登录 → 触发安全验证',
    }
  }

  if (path.endsWith('success.html')) {
    return {
      action: 'done',
      reason: '已到达成功页，主干路径覆盖完毕',
      screen: screen('success', '操作成功', 'register', '注册'),
      edgeLabel: '提交 → 注册成功',
    }
  }

  return {
    action: 'done',
    reason: '没有更多可探索的界面',
    screen: screen('unknown', '未识别界面', 'entry', '入口'),
    edgeLabel: '结束',
  }
}

function extractUserText(body) {
  // OpenAI 形状
  const msgs = body.messages ?? []
  const parts = []
  for (const m of msgs) {
    if (typeof m.content === 'string') parts.push(m.content)
    else if (Array.isArray(m.content)) for (const c of m.content) if (c.type === 'text') parts.push(c.text)
  }
  return parts.join('\n')
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    callCount += 1
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* 忽略 */
    }
    const text = extractUserText(body)
    const isAnthropic = req.url.includes('/messages')

    // 故障注入：第二次调用返回坏 JSON，验证解析重试与降级
    if (SCENARIO === 'badjson' && callCount === 2) {
      const payload = isAnthropic
        ? { content: [{ type: 'text', text: '这不是 JSON，只是一段解释文字。' }] }
        : { choices: [{ message: { content: '这不是 JSON，只是一段解释文字。' } }] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(payload))
    }
    if (SCENARIO === 'flaky' && callCount === 2) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: '模拟的服务端故障' } }))
    }

    const action = decide(text)
    const payload = isAnthropic
      ? { content: [{ type: 'tool_use', name: 'decide_action', input: action }], model: body.model }
      : { choices: [{ message: { content: JSON.stringify(action) } }], model: body.model }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
})

server.listen(PORT, () => console.log(`mock-ai (${SCENARIO}): http://localhost:${PORT}`))
