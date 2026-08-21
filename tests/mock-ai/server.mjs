// 脚本化的 AI 模拟服务，同时实现 OpenAI 与 Anthropic 两种协议的响应形状。
// 它按「当前页面 + 已推进到第几步」决定动作，而不是盲目按调用次数返回，
// 这样即使探索循环多跑或少跑一轮，脚本依然对得上。
//
//   node tests/mock-ai/server.mjs [port] [scenario] [录像文件]
//   scenario: normal | badjson | flaky | replay
//
// replay 模式用于回放用户回传的诊断包：不再自己决定动作，而是按录像里的顺序
// 把当时那一轮的决策原样吐回去。目标站要能访问，页面结构也要与当时一致，
// 对不上时会在控制台把差异打出来，而不是默默给出一个错位的动作。
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

// 注意别用 4190：它在 Chromium 的受限端口黑名单里（sieve），fetch 会直接以 bad port 失败
const PORT = Number(process.argv[2] || 4192)
const SCENARIO = process.argv[3] || 'normal'
const TAPE_FILE = process.argv[4] || ''

/**
 * 录像。
 *
 * 既接 ai.jsonl（项目目录里的原始录像），也接诊断包 JSON（用户回传的那个文件），
 * 因为作者手上多半只有后者。
 */
function loadTape(file) {
  const raw = readFileSync(file, 'utf8')
  const rows = raw.trimStart().startsWith('{')
    ? (JSON.parse(raw).ai ?? [])
    : raw.split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l))
  const usable = rows.filter((r) => r.kind === 'decide' && r.action)
  if (!usable.length) throw new Error('录像里没有可回放的决策。诊断包必须是「复现级」，基础级不含决策内容')
  return usable
}

const tape = SCENARIO === 'replay' ? loadTape(TAPE_FILE) : []
let tapeAt = 0

/** 每个页面推进到第几步 */
const progress = new Map()
/** 每个页面已经填过哪些字段 */
const filled = new Map()
let callCount = 0
/** ask 场景只提问一次，应答后走正常流程 */
let askAsked = false

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

  // ask 场景：起步先向用户确认探索方向，应答会出现在下一步的「上一步结果」里
  if (SCENARIO === 'ask' && (path === '/' || path.endsWith('index.html')) && !askAsked) {
    askAsked = true
    return {
      action: 'ask',
      reason: '有两条主路径，先确认用户想覆盖哪条',
      question: '优先探索哪条路径？',
      options: ['注册流程', '登录流程'],
    }
  }

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
    const phone = find(els, /手机号/)
    const pwd = find(els, /密码/)
    const submit = els.find((e) => e.tag.startsWith('button'))
    const notices = noticesOf(text)

    // 登录页只在提交时校验，提示不会因为填写而消失。
    // 所以要自己记住填过什么，否则会照着过期的提示反复重填。
    if (!filled.has(path)) filled.set(path, new Set())
    const done = filled.get(path)

    if (/手机号不能为空/.test(notices) && phone && !done.has('phone')) {
      done.add('phone')
      return {
        action: 'fill',
        targetIdx: phone.idx,
        value: '13800138000',
        reason: '补齐手机号',
        screen: screen('login-empty-submit', '登录·必填项未填校验', 'login', '登录', 'validation'),
        edgeLabel: '提交「登录」→ 系统校验失败',
      }
    }
    if (/密码不能为空/.test(notices) && pwd && !done.has('pwd')) {
      done.add('pwd')
      return {
        action: 'fill',
        targetIdx: pwd.idx,
        value: 'test123456',
        reason: '补齐密码',
        screen: screen('login-phone-filled', '登录·手机号已填', 'login', '登录'),
        edgeLabel: '输入手机号',
      }
    }
    return {
      action: 'click',
      targetIdx: submit ? submit.idx : 0,
      reason: '提交登录',
      screen: screen('login-init', '登录表单', 'login', '登录'),
      edgeLabel: '打开登录页',
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

/**
 * 收尾整理的两个问询。
 *
 * 必须在 callCount 自增之前分派：那个计数器是 badjson / flaky 的故障注入位置，
 * 多一类请求就会把注入点顶到别的调用上。
 * Anthropic 的 system 是顶层字段，extractUserText 读不到，所以优先按工具名判定。
 */
function reviewKind(body, text) {
  const tools = (body.tools ?? []).map((t) => t.name)
  if (tools.includes('classify_lanes') || /## 待归类的界面/.test(text)) return 'classify_lanes'
  if (tools.includes('review_edges') || /## 待审查的连线组/.test(text)) return 'review_edges'
  if (tools.includes('name_screens') || /## 待命名的界面/.test(text)) return 'name_screens'
  if (tools.includes('relabel_edges') || /## 待改写的连线/.test(text)) return 'relabel_edges'
  if (tools.includes('merge_screens') || /## 待判定的候选对/.test(text)) return 'merge_screens'
  return null
}

/** 从问询文本里解析节点块：两个空格的 id 行 + 四个空格的属性行 */
function parseNodeBlocks(text) {
  const blocks = []
  let cur = null
  for (const line of text.split(String.fromCharCode(10))) {
    const idm = line.match(/^ {2}(\S+)$/)
    if (idm) {
      cur = { nodeId: idm[1], url: '', notices: '' }
      blocks.push(cur)
      continue
    }
    const um = line.match(/^ {4}地址：(\S+)/)
    if (um && cur) cur.url = um[1]
    const nm = line.match(/^ {4}提示：(.*)/)
    if (nm && cur) cur.notices = nm[1]
  }
  return blocks
}

/**
 * 泳道划分应答（全局）。
 *
 * 按地址归入功能泳道；验证码页刻意归到新泳道（verify / 安全验证）——
 * 机械泳道与继承回落都给不出 verify，这样断言才能区分「AI 划分真的生效」与「只是回落顶上」。
 */
function laneFor(u) {
  if (/captcha/.test(u)) return { lane: 'verify', laneTitle: '安全验证' }
  if (/success\.html\?from=login/.test(u)) return { lane: 'login', laneTitle: '登录' }
  if (/login/.test(u)) return { lane: 'login', laneTitle: '登录' }
  if (/register|success/.test(u)) return { lane: 'register', laneTitle: '注册' }
  return { lane: 'entry', laneTitle: '入口' }
}

function classifyLanes(text) {
  return {
    assignments: parseNodeBlocks(text).map((b) => ({ nodeId: b.nodeId, ...laneFor(b.url), confidence: 'high' })),
  }
}

/** 命名应答：按地址与提示文案给规范名 */
function titleFor(b) {
  const u = b.url
  // success 的地址带 from=login / from=register，必须先于 login、register 判定
  if (/success/.test(u)) return { title: '操作成功', kind: 'normal' }
  if (/index/.test(u)) return { title: '首页', kind: 'normal' }
  if (/register/.test(u) && /手机号长度|手机号格式/.test(b.notices)) return { title: '注册·手机号格式校验', kind: 'validation' }
  if (/register/.test(u) && /两次输入的密码不一致/.test(b.notices)) return { title: '注册·确认密码校验', kind: 'validation' }
  if (/register/.test(u) && /密码不能为空/.test(b.notices)) return { title: '注册·必填项校验', kind: 'validation' }
  if (/register/.test(u)) return { title: '注册表单', kind: 'normal' }
  if (/login/.test(u) && /不能为空/.test(b.notices)) return { title: '登录·必填项校验', kind: 'validation' }
  if (/login/.test(u)) return { title: '登录表单', kind: 'normal' }
  if (/captcha/.test(u)) return { title: '安全验证·图形验证码', kind: 'normal' }
  if (/success/.test(u)) return { title: '操作成功', kind: 'normal' }
  return { title: '未识别界面', kind: 'normal' }
}

function nameScreens(text) {
  return { names: parseNodeBlocks(text).map((b) => ({ nodeId: b.nodeId, ...titleFor(b) })) }
}

/** 标注语义化应答：只改写指向校验提示界面的连线 */
function relabelEdges(text) {
  const labels = []
  for (const line of text.split(String.fromCharCode(10))) {
    const m = line.match(/^ {2}(\S+)｜.*｜现标注：([^｜]*)｜目标界面提示：(.*)$/)
    if (!m) continue
    const [, edgeId, cur, notice] = m
    if (/手机号长度|手机号格式/.test(notice)) labels.push({ edgeId, label: '输入手机号（过短）→ 系统校验失败：手机号格式' })
    else if (/两次输入的密码不一致/.test(notice)) labels.push({ edgeId, label: `${cur.trim()} → 系统校验失败：确认密码` })
    else if (/不能为空/.test(notice)) labels.push({ edgeId, label: `${cur.trim()} → 系统校验失败：必填项` })
  }
  return { labels }
}

/** 合并判定应答：一律不合并（注册页的多个校验态本来就不该合并） */
function mergeScreens(text) {
  const pairs = []
  for (const m of text.matchAll(/^ {2}(p\d+)（/gm)) pairs.push({ pairId: m[1], merge: false })
  return { pairs }
}

/** 审边应答：每组只留第一条 */
function reviewEdges(text) {
  const groups = []
  let cur = null
  for (const line of text.split(String.fromCharCode(10))) {
    const g = line.match(/^ {2}(g\d+)：/)
    if (g) {
      cur = { groupId: g[1], keep: [] }
      groups.push(cur)
      continue
    }
    const e = line.match(/^ {4}- ([^｜]+)｜/)
    if (e && cur && cur.keep.length === 0) cur.keep.push(e[1].trim())
  }
  return { groups: groups.filter((g) => g.keep.length) }
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
  /*
   * 只有 POST 才算一次问询。
   *
   * 探活用的是 GET，如果一并当成请求处理，回放的进度会被探活推着走一步——
   * 第一次真正的决策就已经错位了，而错位后的动作看上去仍然「合理」，
   * 极难发现。
   */
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, scenario: SCENARIO }))
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* 忽略 */
    }
    const text = extractUserText(body)
    const isAnthropic = req.url.includes('/messages')

    // 收尾问询先分派，不参与 callCount 的故障注入，也不打乱探索的进度计数
    const kind = reviewKind(body, text)
    if (kind) {
      if (SCENARIO === 'reviewfail') {
        const bad = isAnthropic
          ? { content: [{ type: 'text', text: '收尾整理失败（模拟）' }] }
          : { choices: [{ message: { content: '收尾整理失败（模拟）' } }] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(bad))
      }
      const out =
        kind === 'classify_lanes'
          ? classifyLanes(text)
          : kind === 'review_edges'
            ? reviewEdges(text)
            : kind === 'name_screens'
              ? nameScreens(text)
              : kind === 'relabel_edges'
                ? relabelEdges(text)
                : mergeScreens(text)
      const payload = isAnthropic
        ? { content: [{ type: 'tool_use', name: kind, input: out }], model: body.model }
        : { choices: [{ message: { content: JSON.stringify(out) } }], model: body.model }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(payload))
    }

    callCount += 1

    // 回放：按录像顺序返回当时的决策，并核对是不是走在同一条路上
    if (SCENARIO === 'replay') {
      if (tapeAt >= tape.length) {
        console.log(`[replay] 录像已放完（共 ${tape.length} 步），继续请求将返回 done`)
        const done = { action: 'done', reason: '录像已放完', screen: { id: 'replay-end', title: '回放结束', lane: 'replay', kind: 'normal' }, edgeLabel: '结束' }
        const payload = isAnthropic
          ? { content: [{ type: 'tool_use', name: 'decide_action', input: done }], model: body.model }
          : { choices: [{ message: { content: JSON.stringify(done) } }], model: body.model }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(payload))
      }
      const row = tape[tapeAt++]
      const nowUrl = currentUrl(text)
      const nowEls = parseElements(text).length
      // 对不上就说出来。回放本来就依赖目标站与当时一致，
      // 悄悄给一个错位的动作只会把人引到错误的结论上
      if (row.ask?.url && nowUrl && row.ask.url !== nowUrl) {
        console.log(`[replay] 第 ${tapeAt} 步地址对不上：录像 ${row.ask.url} · 当前 ${nowUrl}`)
      } else if (typeof row.ask?.elements === 'number' && row.ask.elements !== nowEls) {
        console.log(`[replay] 第 ${tapeAt} 步元素数对不上：录像 ${row.ask.elements} · 当前 ${nowEls}`)
      } else {
        console.log(`[replay] 第 ${tapeAt}/${tape.length} 步 · ${row.action.action}`)
      }
      const payload = isAnthropic
        ? { content: [{ type: 'tool_use', name: 'decide_action', input: row.action }], model: body.model }
        : { choices: [{ message: { content: JSON.stringify(row.action) } }], model: body.model }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(payload))
    }

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

server.listen(PORT, () =>
  console.log(`mock-ai (${SCENARIO}${SCENARIO === 'replay' ? ` · ${tape.length} 步录像` : ''}): http://localhost:${PORT}`)
)
