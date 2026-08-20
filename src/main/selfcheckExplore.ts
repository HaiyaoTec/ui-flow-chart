import { randomUUID } from 'node:crypto'
import { app, type BaseWindow } from 'electron'
import { MANUAL_LANE_ID, type FlowGraph, type SessionSnapshot } from '@shared/types'
import { delay } from './engine/PageDriver'
import { preview } from './engine/previewManager'
import { sessions } from './engine/sessionManager'
import { saveProfile } from './store/credentials'
import { createProject, deleteProject } from './store/projects'
import { projectDir, readJson } from './store/paths'
import { join } from 'node:path'

/**
 * 图谱该长什么样。
 *
 * 这条自检以前只把图谱打印出来给人看，改坏了也不会有人发现。
 * 收尾整理引入之后更需要断言：它会改泳道、删边、重排坐标，
 * 任何一处出错都表现为「图看起来怪怪的」，肉眼很难第一时间归因。
 */
function checkGraph(graph: FlowGraph | null, state: string, takeover: boolean, aiReview: boolean): string[] {
  const fail: string[] = []
  if (state !== 'finished') fail.push(`会话未进入 finished：${state}`)
  if (!graph) {
    fail.push('没有产出图谱')
    return fail
  }

  if (takeover) {
    /*
     * 录制内容钉死：验证码页与验证成功页各一屏。
     *
     * 早先只断言「录到过人工界面」，模拟点击与录制器 700ms 轮询的相位不同时，
     * success 有时由录制器录、有时由 AI 步建，两次运行产出不同图谱且都能通过。
     * 现在自检等到两屏都入库才结束接管（见 runExploreCheck），这里按定数断言。
     */
    const human = graph.nodes.filter((n) => n.createdBy === 'human')
    if (human.length !== 2) fail.push(`人工接管期应录到恰好 2 屏，实际 ${human.length} 屏`)
    if (!human.some((n) => n.url.includes('captcha'))) fail.push('没有录到验证码界面')
    if (!human.some((n) => n.url.includes('success'))) fail.push('没有录到验证成功界面')

    // 这两条与 AI 无关：确定性层的继承回落单独就该把节点挪出临时泳道
    if (graph.lanes.some((l) => l.id === MANUAL_LANE_ID)) fail.push('收尾后仍存在人工接管泳道')
    if (graph.nodes.some((n) => n.lane === MANUAL_LANE_ID)) fail.push('仍有节点留在人工接管泳道')

    /*
     * mock AI 刻意把 manual-1 归到 verify——继承值是 login，两者不同，
     * 因此 verify 在不在就能区分「AI 归类真的生效」与「只是继承回落顶上了」。
     * reviewfail 场景反过来：AI 返回垃圾，verify 不该出现，但上面两条仍须成立。
     */
    const hasVerify = graph.lanes.some((l) => l.id === 'verify')
    if (aiReview && !hasVerify) fail.push('AI 归类未生效：没有出现 verify 泳道')
    if (!aiReview && hasVerify) fail.push('AI 返回不可解析时不该采信它的归类结果')
  }

  if (!takeover) {
    /*
     * 边标注的对应关系：mock AI 在「手机号格式错误」那一屏输出的 edgeLabel 是
     * 「输入手机号（过短）→ 系统校验失败」，按提示词约定它描述的是到达该屏的转移，
     * 必须标在指向该屏的连线上。标注错位一步时，这条边上会是上一步的动作词。
     */
    const toInvalid = graph.edges.find((e) => e.to === 'register-phone-invalid')
    if (!toInvalid) fail.push('缺少指向校验态界面的连线，本轮没验到边标注')
    else if (!/系统校验失败/.test(toInvalid.label)) fail.push(`校验态入边的标注错位：${toInvalid.label}`)
  }

  const pairs = new Map<string, number>()
  for (const e of graph.edges) pairs.set(`${e.from}->${e.to}`, (pairs.get(`${e.from}->${e.to}`) ?? 0) + 1)
  const over = [...pairs].filter(([, n]) => n > 1)
  if (over.length) fail.push(`同一对界面之间仍有多条连线：${over.map(([k, n]) => `${k}×${n}`).join('、')}`)

  const cells = graph.nodes.filter((n) => n.col >= 0).map((n) => `${n.lane}#${n.col}#${n.sub}`)
  if (new Set(cells).size !== cells.length) fail.push('重排后存在坐标重叠的卡片')

  const ids = new Set(graph.nodes.map((n) => n.id))
  const dangling = graph.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))
  if (dangling.length) fail.push(`存在悬挂连线 ${dangling.length} 条`)

  return fail
}

/**
 * 全流程自检：mock AI + 内置测试站，跑一整轮自动探索并打印图谱结果。
 *   UFC_SELFCHECK_EXPLORE=1 UFC_SITE=http://localhost:4183 UFC_AI=http://localhost:4190/v1
 */
export async function runExploreCheck(win: BaseWindow, site: string, aiBase: string): Promise<void> {
  const out: Record<string, unknown> = {}
  let projectId = ''
  /*
   * takeover 场景从登录页起步，会撞上验证码并转人工。
   * reviewfail 也走这条路：只有产出了人工接管节点，收尾才会真的去问 AI，
   * 那条场景要验的正是「AI 答不上来时回落继承值」。
   */
  const scenario = process.env.UFC_SCENARIO ?? 'normal'
  const takeover = scenario === 'takeover' || scenario === 'reviewfail'
  const aiReview = scenario !== 'reviewfail'

  try {
    preview.bindWindow(win)
    sessions.bindWindow(win)
    await preview.setPaneBounds({ x: 0, y: 0, width: 430, height: 932 })

    const profile = saveProfile(
      { id: randomUUID(), name: 'mock', protocol: 'openai', baseUrl: aiBase, model: 'mock-model' },
      'mock-key'
    )

    const project = createProject({
      name: '自检项目',
      targetUrl: takeover ? `${site}/login.html` : `${site}/index.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: takeover ? '走通登录流程' : '走通注册流程，覆盖手机号格式校验',
    })
    projectId = project.id

    await sessions.start(project.id)

    const waitFor = async (states: string[], ms: number): Promise<SessionSnapshot> => {
      const end = Date.now() + ms
      let s = sessions.snapshot(projectId)
      while (Date.now() < end) {
        s = sessions.snapshot(projectId)
        if (states.includes(s.state)) break
        await delay(400)
      }
      return s
    }

    // 步数会随页面时序浮动，收尾整理又要多两次 AI 往返，等宽一点，免得把「还在跑」误判成失败
    let snap = await waitFor(['finished', 'failed', 'paused', 'awaiting_human'], 180_000)

    if (takeover && snap.state === 'awaiting_human') {
      out.needHuman = snap.reason

      const humanNodes = (): number => {
        const g = readJson<FlowGraph | null>(join(projectDir(project.id), 'graph.json'), null)
        return g ? g.nodes.filter((n) => n.createdBy === 'human').length : 0
      }
      const waitHumanNodes = async (count: number, ms: number): Promise<boolean> => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          if (humanNodes() >= count) return true
          await delay(300)
        }
        return false
      }

      /*
       * 与录制器按「已录屏数」同步，而不是按固定时长。
       *
       * 录制器靠「连续两次探针签名一致」才认一屏（两轮各 700ms）。早先这里固定停
       * 2 秒再动手，能保证验证码页入库；但点掉验证码之后什么时候结束接管全凭运气——
       * success 页有时录到、有时录不到，连续两次自检会产出不同的图谱，
       * 而两种结果的断言都能通过，抖动因此是隐形的。
       * 改为：验证码页入库后才动手，成功页也入库后才结束接管，录制内容成为定数。
       */
      out.captchaRecorded = await waitHumanNodes(1, 15_000)

      /*
       * 模拟真人：在验证码页按对图形（脚本无法从截图判断，必须真人操作）。
       *
       * 要重试：转入等待人工的那一刻页面未必已经渲染出按钮，点空一次就会一直卡在
       * 等待人工上——这条自检现在要决定退出码，不能靠运气。
       */
      for (let i = 0; i < 10 && !preview.driver.currentUrl().includes('success'); i++) {
        const pt = (await preview.driver.evalInPage(
          `(() => { const b = document.querySelectorAll('#shapes button')[2]
             if (!b) return null
             const r = b.getBoundingClientRect()
             return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
        ).catch(() => null)) as { x: number; y: number } | null
        if (pt) {
          await preview.driver.tap(pt.x, pt.y)
          await delay(1200)
        } else {
          await delay(600)
        }
      }
      out.afterHumanUrl = preview.driver.currentUrl()
      out.successRecorded = await waitHumanNodes(2, 15_000)

      await sessions.takeoverEnd(projectId)
      snap = await waitFor(['finished', 'failed', 'paused'], 60_000)
      out.afterTakeover = { state: snap.state, step: snap.step, screens: snap.screens }
    }
    out.session = { state: snap.state, step: snap.step, aiCalls: snap.aiCalls, screens: snap.screens, reason: snap.reason }

    const graph = readJson<FlowGraph | null>(join(projectDir(project.id), 'graph.json'), null)
    out.graph = graph
      ? {
          lanes: graph.lanes.map((l) => l.id),
          nodes: graph.nodes.map((n) => ({ id: n.id, lane: n.lane, col: n.col, sub: n.sub, kind: n.kind, title: n.title })),
          edges: graph.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, type: e.type })),
        }
      : null

    out.assertions = { failed: checkGraph(graph, snap.state, takeover, aiReview) }

    // 结束时页面上的表单状态，便于定位「为什么提交没通过」
    out.finalPage = await preview.driver
      .evalInPage(
        `(() => ({
           url: location.href,
           values: [...document.querySelectorAll('input')].map(i => ({ ph: i.placeholder, len: (i.value||'').length })),
           errors: [...document.querySelectorAll('.err')].map(e => e.textContent).filter(Boolean),
         }))()`
      )
      .catch((e) => ({ error: String(e) }))

    // 逐步的地址轨迹，便于定位「走到哪一步偏了」
    const { readFileSync, existsSync } = await import('node:fs')
    const jl = join(projectDir(project.id), 'session.jsonl')
    if (existsSync(jl)) {
      out.trace = readFileSync(jl, 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>
          } catch {
            return null
          }
        })
        .filter((x): x is Record<string, unknown> => x !== null)
        .filter((x) => x.kind === 'log')
        .map((x) => x.message)
        .slice(-40)
    }

    // 导出验证
    const { exportProjectHtml } = await import('./export/exportHtml')
    const html = exportProjectHtml(project.id)
    out.exportHtml = { bytes: html.bytes, hasImages: html.bytes > 20000 }
  } catch (e) {
    out.fatal = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
  } finally {
    console.log('EXPLORE_RESULT ' + JSON.stringify(out))
    if (projectId && process.env.UFC_KEEP !== '1') deleteProject(projectId)
    preview.destroy()
    app.exit(0)
  }
}
