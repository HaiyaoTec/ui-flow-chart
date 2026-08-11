import { join } from 'node:path'
import { ipcMain, shell, type BrowserWindow } from 'electron'
import { CH, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc-contract'
import { getDevice } from '@shared/devices'
import type { FlowGraph } from '@shared/types'
import { createAiClient } from '../ai'
import { GraphStore } from '../engine/graphStore'
import { preview } from '../engine/previewManager'
import { sessions } from '../engine/sessionManager'
import { exportProjectHtml } from '../export/exportHtml'
import { exportProjectPng } from '../export/exportPng'
import { deleteProfile, listProfiles, saveProfile } from '../store/credentials'
import { projectDir, readJson } from '../store/paths'
import { clearProjectSession, createProject, deleteProject, getProject, listProjects } from '../store/projects'
import { getSettings, setSettings } from '../store/settings'

type Handler<C extends InvokeChannel> = (
  payload: IpcInvokeMap[C]['req']
) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']

/** 统一注册，保证通道名与载荷类型都来自 ipc-contract */
function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, async (_e, payload) => fn(payload as IpcInvokeMap[C]['req']))
}

const emptyGraph = (targetUrl: string, deviceId: string): FlowGraph => ({
  version: 1,
  meta: { targetUrl, deviceId, steps: 0, aiCalls: 0, updatedAt: new Date().toISOString() },
  lanes: [],
  nodes: [],
  edges: [],
})

function loadGraph(projectId: string): FlowGraph {
  const meta = getProject(projectId)
  return readJson<FlowGraph>(
    join(projectDir(projectId), 'graph.json'),
    emptyGraph(meta?.targetUrl ?? '', meta?.deviceId ?? '')
  )
}

/** 图谱的人工修正走独立的 store 实例，避免与运行中的会话抢同一份内存 */
function withStore<T>(projectId: string, fn: (s: GraphStore) => T): T {
  const meta = getProject(projectId)
  if (!meta) throw new Error('项目不存在')
  const store = new GraphStore(projectId, meta.targetUrl, meta.deviceId)
  const r = fn(store)
  store.save()
  return r
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (win) {
    preview.bindWindow(win)
    sessions.bindWindow(win)
  }

  /* ------------------------------- 设置与凭证 ------------------------------- */
  handle(CH.settingsGet, () => getSettings())
  handle(CH.settingsSet, (patch) => setSettings(patch))

  handle(CH.aiProfilesList, () => listProfiles())
  handle(CH.aiProfileSave, ({ profile, apiKey }) => saveProfile(profile, apiKey))
  handle(CH.aiProfileDelete, ({ id }) => {
    deleteProfile(id)
  })
  handle(CH.aiTest, async ({ profileId }) => {
    try {
      return await createAiClient(profileId).testConnection()
    } catch (e) {
      return { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /* --------------------------------- 项目 --------------------------------- */
  handle(CH.projectCreate, (input) => createProject(input))
  handle(CH.projectList, () => listProjects())
  handle(CH.projectOpen, ({ id }) => {
    const meta = getProject(id)
    if (!meta) throw new Error('项目不存在')
    return { meta, graph: loadGraph(id) }
  })
  handle(CH.projectDelete, ({ id }) => {
    deleteProject(id)
  })
  handle(CH.projectClearSession, ({ id }) => clearProjectSession(id))

  /* --------------------------------- 会话 --------------------------------- */
  handle(CH.sessionStart, ({ projectId, goal, budgets }) => sessions.start(projectId, goal, budgets))
  handle(CH.sessionPause, () => sessions.pause())
  handle(CH.sessionResume, () => sessions.resume())
  handle(CH.sessionStop, () => sessions.stop())
  handle(CH.sessionTakeoverStart, () => sessions.takeoverStart())
  handle(CH.sessionTakeoverEnd, () => sessions.takeoverEnd())
  handle(CH.sessionSnapshot, () => sessions.snapshot())

  /* --------------------------------- 预览 --------------------------------- */
  handle(CH.previewSetBounds, (b) => preview.setPaneBounds(b))
  handle(CH.previewSetVisible, ({ visible }) => preview.setVisible(visible))
  handle(CH.previewSetDevice, ({ deviceId, custom }) => preview.setDevice(getDevice(deviceId, custom)))
  handle(CH.previewNavigate, (input) => preview.navigate(input))
  handle(CH.previewProbe, () => preview.driver.probe())

  /* --------------------------------- 图谱 --------------------------------- */
  handle(CH.graphUpdateNode, ({ id, patch }) => {
    const pid = sessions.snapshot().projectId
    if (!pid) throw new Error('没有已打开的项目')
    withStore(pid, (s) => s.updateNode(id, patch as never))
  })
  handle(CH.graphUpdateEdge, ({ id, patch }) => {
    const pid = sessions.snapshot().projectId
    if (!pid) throw new Error('没有已打开的项目')
    withStore(pid, (s) => s.updateEdge(id, patch as never))
  })
  handle(CH.graphDeleteNode, ({ id }) => {
    const pid = sessions.snapshot().projectId
    if (!pid) throw new Error('没有已打开的项目')
    withStore(pid, (s) => s.deleteNode(id))
  })
  handle(CH.graphRelayout, () => {
    const pid = sessions.snapshot().projectId
    if (!pid) throw new Error('没有已打开的项目')
    return withStore(pid, (s) => s.relayout())
  })

  /* --------------------------------- 导出 --------------------------------- */
  handle(CH.exportHtml, ({ projectId }) => exportProjectHtml(projectId))
  handle(CH.exportPng, ({ projectId, scale }) => exportProjectPng(projectId, scale))
  handle(CH.shellReveal, ({ path }) => {
    shell.showItemInFolder(path)
  })

  registerTestHooks()
}

/**
 * 测试专用通道，只有设置 UFC_TEST=1 才注册。
 * 用于在自动化里读取预览页内部状态、模拟人工操作，生产运行时完全不存在。
 */
function registerTestHooks(): void {
  if (process.env.UFC_TEST !== '1') return

  ipcMain.handle('test:eval-preview', async (_e, script: string) =>
    preview.driver.attached ? preview.driver.evalInPage(script) : null
  )
  ipcMain.handle('test:tap', async (_e, p: { x: number; y: number }) => {
    await preview.driver.tap(p.x, p.y)
  })
  ipcMain.handle('test:fill', async (_e, p: { x: number; y: number; text: string }) => {
    await preview.driver.fillAt(p.x, p.y, p.text)
  })
  ipcMain.handle('test:screenshot', async () => {
    const shot = await preview.driver.screenshot()
    return { pngBytes: shot.png.length, jpegBase64Length: shot.jpegBase64.length }
  })
  ipcMain.handle('test:probe', async () => preview.driver.probe())
  ipcMain.handle('test:wait-stable', async () => preview.driver.waitStable())
  ipcMain.handle('test:graph', async (_e, projectId: string) => loadGraph(projectId))
}
