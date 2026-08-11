import { randomUUID } from 'node:crypto'
import { app, type BrowserWindow } from 'electron'
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
export async function runExploreCheck(win: BrowserWindow, site: string, aiBase: string): Promise<void> {
  const out: Record<string, unknown> = {}
  let projectId = ''

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
      targetUrl: `${site}/index.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: '走通注册流程，覆盖手机号格式校验',
    })
    projectId = project.id

    await sessions.start(project.id)

    // 等到进入终态或需要人工
    const deadline = Date.now() + 120_000
    let snap: SessionSnapshot = sessions.snapshot()
    while (Date.now() < deadline) {
      snap = sessions.snapshot()
      if (['finished', 'failed', 'paused', 'awaiting_human'].includes(snap.state)) break
      await delay(500)
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
