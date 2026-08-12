import { join } from 'node:path'
import { ipcMain, Menu, nativeTheme, shell, type BrowserWindow } from 'electron'
import { CH, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc-contract'
import { getDevice } from '@shared/devices'
import { SESSION_HOLDS_PREVIEW, type FlowGraph } from '@shared/types'
import { createAiClient } from '../ai'
import { GraphStore } from '../engine/graphStore'
import { preview } from '../engine/previewManager'
import { sessions } from '../engine/sessionManager'
import { exportProjectHtml } from '../export/exportHtml'
import { exportProjectPng } from '../export/exportPng'
import { deleteProfile, listProfiles, saveProfile } from '../store/credentials'
import { projectDir, readJson } from '../store/paths'
import {
  clearProjectSession,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  partitionOf,
} from '../store/projects'
import { getSettings, setSettings } from '../store/settings'
import { themeBackground } from '../window'

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

/** 测试模式下预置的菜单选择结果，见 test:menu-pick */
let pendingMenuPick: string | null | undefined

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (win) {
    preview.bindWindow(win)
    sessions.bindWindow(win)
  }

  /* ------------------------------- 设置与凭证 ------------------------------- */
  handle(CH.settingsGet, () => getSettings())
  handle(CH.settingsSet, (patch) => setSettings(patch))
  handle(CH.themeSet, ({ theme }) => {
    // nativeTheme 是主题的唯一事实源：设了它，渲染进程里的
    // prefers-color-scheme 会跟着变，系统原生弹窗也一致
    nativeTheme.themeSource = theme
    const next = setSettings({ theme })
    // 窗口底色也要跟着换，否则缩放窗口时边缘会闪出另一套主题的颜色
    getWindow()?.setBackgroundColor(themeBackground())
    return next
  })

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
  handle(CH.projectOpen, async ({ id }) => {
    const meta = getProject(id)
    if (!meta) throw new Error('项目不存在')

    // 预览必须跟着项目走：换项目要换目标地址、设备与会话分区，
    // 否则右侧还停在上一个项目的页面和登录态上。
    // 但别的项目的会话正占着预览时不能抢——包括 paused：
    // 它一恢复就会接着在当前页面上操作，页面被换掉就等于把动作打到了别人身上。
    const busy = sessions.snapshot()
    const heldByOther = Boolean(busy.projectId) && busy.projectId !== id && SESSION_HOLDS_PREVIEW.includes(busy.state)
    if (!heldByOther) {
      void preview
        .open(meta.targetUrl, getDevice(meta.deviceId, meta.customDevice), partitionOf(meta.id))
        .catch(() => undefined)
    }

    // previewBound 交给界面提示：不然顶栏显示的是新项目，右侧却还是旧项目的页面，
    // 用户完全看不出预览没跟过来
    return { meta, graph: loadGraph(id), previewBound: !heldByOther }
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
  handle(CH.previewSetVisible, ({ visible, withSnapshot }) => preview.setVisible(visible, withSnapshot))
  handle(CH.previewSetDevice, ({ deviceId, custom }) => preview.setDevice(getDevice(deviceId, custom)))
  handle(CH.previewNavigate, (input) => preview.navigate(input))
  handle(CH.previewProbe, () => preview.driver.probe())
  handle(CH.previewDiagnose, () => preview.diagnose())

  /**
   * 压在预览视图上的下拉走系统菜单。
   *
   * 渲染进程画的弹层永远在 WebContentsView 之下；先前的做法是展开时把视图藏起来，
   * 但抓帧与隐藏都要时间，弹层已经出来了视图还在，就会被网页切掉一半，操作也发涩。
   * 菜单交给系统合成就没有这些问题，坐标用的是窗口内容区的 CSS 像素，与前端一致。
   */
  handle(CH.uiPopupMenu, ({ items, value, x, y }) => {
    // 系统菜单是 OS 画的，自动化点不到。测试模式下可以预置一个返回值，
    // 这样「点开下拉→选中→生效」这条链路仍然能被完整验证
    if (process.env.UFC_TEST === '1' && pendingMenuPick !== undefined) {
      const picked = pendingMenuPick
      pendingMenuPick = undefined
      return { value: picked }
    }
    const win = getWindow()
    if (!win) return { value: null }
    return new Promise<{ value: string | null }>((resolve) => {
      let picked: string | null = null
      const menu = Menu.buildFromTemplate(
        items.map((it) => ({
          label: it.hint ? `${it.label}   ${it.hint}` : it.label,
          type: 'checkbox' as const,
          checked: it.value === value,
          click: () => {
            picked = it.value
          },
        }))
      )
      menu.popup({
        window: win,
        x: Math.round(x),
        y: Math.round(y),
        callback: () => resolve({ value: picked }),
      })
    })
  })

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

  registerTestHooks(getWindow)
}

/**
 * 测试专用通道，只有设置 UFC_TEST=1 才注册。
 * 用于在自动化里读取预览页内部状态、模拟人工操作，生产运行时完全不存在。
 */
function registerTestHooks(getWindow: () => BrowserWindow | null): void {
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
  /** 预置下一次系统菜单的选择结果（null 表示取消） */
  ipcMain.handle('test:menu-pick', async (_e, value: string | null) => {
    pendingMenuPick = value
  })
  ipcMain.handle('test:wait-stable', async () => preview.driver.waitStable())
  ipcMain.handle('test:graph', async (_e, projectId: string) => loadGraph(projectId))
  ipcMain.handle('test:preview-debug', async () => preview.debugInfo())
  ipcMain.handle('test:resize-window', async (_e, d: { dw: number; dh: number }) => {
    const w = getWindow()
    if (!w) return null
    const b = w.getBounds()
    w.setBounds({ ...b, width: b.width + d.dw, height: b.height + d.dh })
    return w.getBounds()
  })
}
