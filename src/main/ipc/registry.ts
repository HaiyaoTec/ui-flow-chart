import { join } from 'node:path'
import { ipcMain, nativeImage, nativeTheme, shell, type BaseWindow } from 'electron'
import { CH, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc-contract'
import { getDevice } from '@shared/devices'
import { SESSION_ACTIVE, type FlowGraph, type FlowLane, type GraphPatch } from '@shared/types'
import { createAiClient } from '../ai'
import { GraphStore } from '../engine/graphStore'
import { preview } from '../engine/previewManager'
import { describeRefine, refineGraph } from '../engine/refine'
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
import { appInfo } from '../appInfo'
import { buildDiagnose } from '../diagnose'
import { log, stripPaths } from '../log'
import { getSettings, setSettings } from '../store/settings'
import { updater } from '../updater'
import { applyViewBackground, getUiView, themeBackground } from '../window'

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

export function registerIpc(getWindow: () => BaseWindow | null): void {
  // 窗口绑定不在这里做：ipcMain.handle 只能注册一次，而窗口可以重建
  // （macOS 关窗不退出进程，从 Dock 再打开是新窗口）。绑定见 index.ts 的 bindWindow。

  /* ------------------------------- 设置与凭证 ------------------------------- */
  handle(CH.settingsGet, () => getSettings())
  handle(CH.settingsSet, (patch) => setSettings(patch))
  handle(CH.themeSet, ({ theme }) => {
    // nativeTheme 是主题的唯一事实源：设了它，渲染进程里的
    // prefers-color-scheme 会跟着变，系统原生弹窗也一致
    nativeTheme.themeSource = theme
    const next = setSettings({ theme })
    // 窗口与界面视图的底色都要跟着换，否则缩放窗口时边缘会闪出另一套主题的颜色
    getWindow()?.setBackgroundColor(themeBackground())
    applyViewBackground()
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

    /*
     * 预览跟着项目走。
     *
     * 该项目已经有会话在跑时，它的页面正停在探索到的某个深层界面上——
     * 这时只把它切到前台，绝不重新打开：重开等于把登录态与滚动位置一起丢掉，
     * 会话下一步的动作就会打在一个完全不同的页面上。
     */
    if (sessions.has(id)) {
      await preview.setFront(id)
    } else {
      preview.ensure(id)
      void preview
        .open(id, meta.targetUrl, getDevice(meta.deviceId, meta.customDevice), partitionOf(meta.id))
        .catch(() => undefined)
    }

    // previewFront 恒为真：多会话之后不再有「预览被别的项目占着」这回事
    return { meta, graph: loadGraph(id), previewBound: true }
  })
  handle(CH.projectDelete, ({ id }) => {
    deleteProject(id)
  })
  handle(CH.projectClearSession, ({ id }) => clearProjectSession(id))

  /* --------------------------------- 会话 --------------------------------- */
  handle(CH.sessionStart, ({ projectId, goal, budgets }) => sessions.start(projectId, goal, budgets))
  handle(CH.sessionPause, ({ projectId }) => sessions.pause(projectId))
  handle(CH.sessionResume, ({ projectId }) => sessions.resume(projectId))
  handle(CH.sessionStop, ({ projectId }) => sessions.stop(projectId))
  handle(CH.sessionTakeoverStart, ({ projectId }) => sessions.takeoverStart(projectId))
  handle(CH.sessionTakeoverEnd, ({ projectId }) => sessions.takeoverEnd(projectId))
  handle(CH.sessionSnapshot, (req) => sessions.snapshot(req?.projectId))
  handle(CH.sessionList, () => sessions.list())

  /* --------------------------------- 预览 --------------------------------- */
  handle(CH.previewSetBounds, (b) => preview.setPaneBounds(b))
  handle(CH.previewSetVisible, ({ visible, withSnapshot }) => preview.setVisible(visible, withSnapshot))
  handle(CH.previewSetDevice, ({ deviceId, custom }) => preview.setDevice(getDevice(deviceId, custom)))
  handle(CH.previewNavigate, (input) => preview.navigate(input))
  handle(CH.previewProbe, () => preview.driver.probe())
  handle(CH.previewDiagnose, () => preview.diagnose())
  handle(CH.previewFreezeReady, ({ token }) => preview.noteFreezePainted(token))
  handle(CH.appInfo, () => appInfo())
  handle(CH.diagnoseExport, (opts) => buildDiagnose(opts))
  handle(CH.diagnoseClientError, ({ source, message, stack, componentStack }) => {
    // 堆栈里的本机绝对路径含用户名，落盘前先抹掉
    const detail = [stack, componentStack].filter((s): s is string => Boolean(s)).map(stripPaths).join('\n')
    log.error('renderer', [`${source}：${message}`, detail].filter(Boolean).join('\n'))
  })

  /**
   * 界面与预览的层级切换。
   *
   * 网页由 WebContentsView 绘制，界面自己也是一个 WebContentsView，谁在上由排序决定。
   * 自绘弹层展开时把界面提到最上层即可——纯排序，瞬时生效；关闭后把预览放回去恢复交互。
   */
  handle(CH.uiStack, ({ front }) => preview.setStackFront(front))

  /* --------------------------------- 更新 --------------------------------- */
  handle(CH.updateCheck, ({ manual }) => updater.check(Boolean(manual)))
  handle(CH.updateDownload, () => updater.download(true))
  handle(CH.updateInstall, ({ force }) => updater.install(Boolean(force)))

  /* --------------------------------- 图谱 --------------------------------- */
  /*
   * 一律由调用方显式指名项目：多会话下从「当前会话」反推目标项目会写错对象。
   *
   * 人工修正只在会话结束后进行：探索会话持有自己的内存图谱并随步落盘，
   * 与这里的独立 store 并行写同一份文件会互相覆盖。paused 也算未结束——
   * 恢复后的下一次落盘同样会把这里的修改抹掉。
   */
  const assertEditable = (projectId: string): void => {
    const state = sessions.snapshot(projectId).state
    if (SESSION_ACTIVE.includes(state)) throw new Error('探索会话尚未结束，请结束后再修改图谱')
  }

  /** 编辑后的全量补丁。命名、泳道、重排都可能动大半张图，增量发容易漏 */
  const fullPatch = (projectId: string, s: GraphStore, extra?: Partial<GraphPatch>): GraphPatch => ({
    projectId,
    updatedNodes: s.get().nodes.map((n) => ({ ...n })),
    updatedEdges: s.get().edges.map((e) => ({ ...e })),
    meta: s.get().meta,
    ...extra,
  })

  /** 人工修正过的字段记入 pinned，重新生成图谱时跳过 */
  const NODE_EDITABLE = ['title', 'lane', 'kind'] as const
  const EDGE_EDITABLE = ['label', 'type'] as const

  handle(CH.graphUpdateNode, ({ projectId, id, patch }) => {
    assertEditable(projectId)
    return withStore(projectId, (s) => {
      const node = s.get().nodes.find((n) => n.id === id)
      const keys = NODE_EDITABLE.filter((k) => patch[k] !== undefined)
      if (!node || !keys.length) throw new Error('界面不存在或没有可修改的字段')
      // 目标泳道可能是用户新建的
      const addedLanes: FlowLane[] = []
      if (typeof patch.lane === 'string') {
        const lane = s.ensureLane(patch.lane, typeof patch.laneTitle === 'string' && patch.laneTitle ? patch.laneTitle : patch.lane)
        if (lane) addedLanes.push(lane)
      }
      const applied: Record<string, unknown> = {}
      for (const k of keys) applied[k] = patch[k]
      s.updateNode(id, applied as never)
      node.pinned = [...new Set([...(node.pinned ?? []), ...keys])]
      // 人工定过名的界面不再是待整理态
      if (keys.includes('title')) node.draft = undefined
      const removedLaneIds = s.pruneEmptyLanes()
      s.relayout()
      return fullPatch(projectId, s, {
        addedLanes: addedLanes.length ? addedLanes : undefined,
        removedLaneIds: removedLaneIds.length ? removedLaneIds : undefined,
      })
    })
  })

  handle(CH.graphUpdateEdge, ({ projectId, id, patch }) => {
    assertEditable(projectId)
    return withStore(projectId, (s) => {
      const edge = s.get().edges.find((e) => e.id === id)
      const keys = EDGE_EDITABLE.filter((k) => patch[k] !== undefined)
      if (!edge || !keys.length) throw new Error('连线不存在或没有可修改的字段')
      const applied: Record<string, unknown> = {}
      for (const k of keys) applied[k] = patch[k]
      s.updateEdge(id, applied as never)
      edge.pinned = [...new Set([...(edge.pinned ?? []), ...keys])]
      return fullPatch(projectId, s)
    })
  })

  handle(CH.graphDeleteNode, ({ projectId, id }) => {
    assertEditable(projectId)
    return withStore(projectId, (s) => {
      const node = s.get().nodes.find((n) => n.id === id)
      if (!node) throw new Error('界面不存在')
      // 记入排除清单：被删界面再次被探索到也不复活
      s.exclude([node.signatureHash, ...(node.aliasSigs ?? [])])
      const removedEdgeIds = s
        .get()
        .edges.filter((e) => e.from === id || e.to === id)
        .map((e) => e.id)
      s.deleteNode(id)
      const removedLaneIds = s.pruneEmptyLanes()
      s.relayout()
      return fullPatch(projectId, s, {
        removedNodeIds: [id],
        removedEdgeIds: removedEdgeIds.length ? removedEdgeIds : undefined,
        removedLaneIds: removedLaneIds.length ? removedLaneIds : undefined,
      })
    })
  })

  handle(CH.graphDeleteEdge, ({ projectId, id }) => {
    assertEditable(projectId)
    return withStore(projectId, (s) => {
      const removed = s.removeEdges([id])
      if (!removed.length) throw new Error('连线不存在')
      s.relayout()
      return fullPatch(projectId, s, { removedEdgeIds: removed })
    })
  })

  handle(CH.graphUpdateLane, ({ projectId, id, title }) => {
    assertEditable(projectId)
    return withStore(projectId, (s) => {
      const lane = s.updateLane(id, { title: title.trim() || id })
      if (!lane) throw new Error('泳道不存在')
      return fullPatch(projectId, s, { updatedLanes: [{ ...lane }] })
    })
  })

  handle(CH.graphRelayout, ({ projectId }) => {
    assertEditable(projectId)
    return withStore(projectId, (s) => s.relayout())
  })

  /** 手动重新生成图谱：批量补齐语义并整理。人工修正过的字段一律保留 */
  handle(CH.graphRefine, async ({ projectId }) => {
    assertEditable(projectId)
    const meta = getProject(projectId)
    if (!meta) throw new Error('项目不存在')
    const ai = createAiClient(meta.aiProfileId)
    const store = new GraphStore(projectId, meta.targetUrl, meta.deviceId)
    const r = await refineGraph(store, ai, {
      onLog: (level, message) => (level === 'warn' ? log.warn : log.info)('refine', message),
    })
    store.save()
    return { summary: describeRefine(r), patch: { projectId, ...r.patch } }
  })

  /* --------------------------------- 导出 --------------------------------- */
  handle(CH.exportHtml, ({ projectId }) => exportProjectHtml(projectId))
  handle(CH.exportPng, ({ projectId, scale }) => exportProjectPng(projectId, scale))
  handle(CH.shellReveal, ({ path }) => {
    shell.showItemInFolder(path)
  })
  handle(CH.shellOpenExternal, ({ url }) => {
    // 只放行 http/https：file: 与自定义协议交给系统打开等于把本机能力开给页面
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接')
    void shell.openExternal(url)
  })

  registerTestHooks(getWindow)
}

/**
 * 测试专用通道，只有设置 UFC_TEST=1 才注册。
 * 用于在自动化里读取预览页内部状态、模拟人工操作，生产运行时完全不存在。
 */
function registerTestHooks(getWindow: () => BaseWindow | null): void {
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
  /** 注入更新状态，用于验证更新提示条与设置区块的各种形态 */
  ipcMain.handle('test:update-state', async (_e, patch: Record<string, unknown>) =>
    updater.injectForTest(patch as never)
  )
  ipcMain.handle('test:wait-stable', async () => preview.driver.waitStable())
  ipcMain.handle('test:graph', async (_e, projectId: string) => loadGraph(projectId))
  ipcMain.handle('test:preview-debug', async () => preview.debugInfo())
  /**
   * 抓一张存档图并回报尺寸与若干采样点的颜色。
   *
   * 「拍到半张骨架屏」「顶部一大片空白」这类问题，断言尺寸与像素才守得住；
   * 只看字节数是看不出画面对不对的。坐标按图像像素给。
   */
  ipcMain.handle('test:screenshot-probe', async (_e, points: Array<{ x: number; y: number }>) => {
    const shot = await preview.driver.screenshot()
    const img = nativeImage.createFromBuffer(shot.png)
    const { width, height } = img.getSize()
    const bmp = img.toBitmap() // BGRA
    const samples = (points ?? []).map(({ x, y }) => {
      const i = (Math.min(Math.max(0, y), height - 1) * width + Math.min(Math.max(0, x), width - 1)) * 4
      return { x, y, b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] }
    })
    return { width, height, bytes: shot.png.length, samples }
  })
  /** 当前谁在上。弹层能不能盖住网页全看它，而这件事截图断言不了 */
  ipcMain.handle('test:ui-stack', async () => ({ front: preview.stackFront() }))
  /** 主进程日志文件的末尾。用来验证异常真的落了盘，而不是只在控制台闪了一下 */
  ipcMain.handle('test:log-tail', async () => ({ file: log.file(), text: log.tail(64 * 1024) }))
  /** 走一次带静帧的存档抓图，验证「贴静帧 → 收回执 → 抬界面 → 抓图 → 复位」这条链 */
  ipcMain.handle('test:capture-archival', async () => {
    const shot = await preview.captureArchival(preview.frontProjectId())
    return { pngBytes: shot.png.length, freeze: preview.lastFreezeInfo() }
  })
  /** 界面视图有没有铺满内容区——铺不满就会在边缘露出底色，看着像黑边 */
  ipcMain.handle('test:ui-view-bounds', async () => {
    const w = getWindow()
    const v = getUiView()
    if (!w || !v) return null
    const [cw, ch] = w.getContentSize()
    return { view: v.getBounds(), content: { width: cw, height: ch } }
  })
  ipcMain.handle('test:resize-window', async (_e, d: { dw: number; dh: number }) => {
    const w = getWindow()
    if (!w) return null
    const b = w.getBounds()
    w.setBounds({ ...b, width: b.width + d.dw, height: b.height + d.dh })
    return w.getBounds()
  })
}
