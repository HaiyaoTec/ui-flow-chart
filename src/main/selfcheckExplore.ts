import { randomUUID } from 'node:crypto'
import { app, type BaseWindow } from 'electron'
import type { FlowGraph, SessionSnapshot } from '@shared/types'
import { delay } from './engine/PageDriver'
import { preview } from './engine/previewManager'
import { sessions } from './engine/sessionManager'
import { saveProfile } from './store/credentials'
import { createProject, deleteProject } from './store/projects'
import { projectDir, readJson } from './store/paths'
import { join } from 'node:path'

/**
 * 全流程自检：mock AI + 内置测试站，跑一整轮自动探索并打印图谱结果。
 *   UFC_SELFCHECK_EXPLORE=1 UFC_SITE=http://localhost:4183 UFC_AI=http://localhost:4190/v1
 */
export async function runExploreCheck(win: BaseWindow, site: string, aiBase: string): Promise<void> {
  const out: Record<string, unknown> = {}
  let projectId = ''
  // takeover 场景从登录页起步，会撞上验证码并转人工
  const takeover = process.env.UFC_SCENARIO === 'takeover'

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
      let s = sessions.snapshot()
      while (Date.now() < end) {
        s = sessions.snapshot()
        if (states.includes(s.state)) break
        await delay(400)
      }
      return s
    }

    let snap = await waitFor(['finished', 'failed', 'paused', 'awaiting_human'], 120_000)

    if (takeover && snap.state === 'awaiting_human') {
      out.needHuman = snap.reason
      // 模拟真人：在验证码页按对图形（脚本无法从截图判断，必须真人操作）
      const pt = (await preview.driver.evalInPage(
        `(() => { const b = document.querySelectorAll('#shapes button')[2]
           if (!b) return null
           const r = b.getBoundingClientRect()
           return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
      )) as { x: number; y: number } | null
      if (pt) {
        await preview.driver.tap(pt.x, pt.y)
        await delay(2500)
      }
      out.afterHumanUrl = preview.driver.currentUrl()

      await sessions.takeoverEnd()
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
