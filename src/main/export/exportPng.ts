import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'
import { getDevice } from '@shared/devices'
import { worldSizeOf } from '@shared/canvas-core/render-html'
import type { ExportResult } from '@shared/ipc-contract'
import type { FlowGraph } from '@shared/types'
import { projectDir, readJson } from '../store/paths'
import { getProject } from '../store/projects'
import { exportProjectHtml } from './exportHtml'

const MAX_DIM = 8000

/** 用隐藏窗口加载导出的 HTML，全览后整幅截图 */
export async function exportProjectPng(projectId: string, scale = 1): Promise<ExportResult> {
  const meta = getProject(projectId)
  if (!meta) throw new Error('项目不存在')
  const dir = projectDir(projectId)
  const graph = readJson<FlowGraph | null>(join(dir, 'graph.json'), null)
  if (!graph) throw new Error('该项目还没有图谱数据')

  // 先确保 HTML 是最新的
  const { path: htmlPath } = exportProjectHtml(projectId)
  const device = getDevice(meta.deviceId, meta.customDevice)
  const size = worldSizeOf(graph, device)

  // 超大画布按比例降采样，避免超出窗口尺寸上限
  const fit = Math.min(1, MAX_DIM / size.width, MAX_DIM / size.height) * scale
  const winW = Math.max(400, Math.round(size.width * fit))
  const winH = Math.max(300, Math.round(size.height * fit))

  const win = new BrowserWindow({
    width: Math.min(winW, MAX_DIM),
    height: Math.min(winH, MAX_DIM),
    show: false,
    webPreferences: { offscreen: false },
  })

  try {
    await win.loadURL(pathToFileURL(htmlPath).href)
    // 让画布铺满整个窗口
    await win.webContents.executeJavaScript(
      `(() => { const w = document.getElementById('ufc-world')
         w.style.transform = 'translate(0,0) scale(${fit})'
         document.getElementById('ufc-bar').style.display = 'none'
         document.getElementById('ufc-legend').style.display = 'none'
         document.getElementById('ufc-hint').style.display = 'none'
         return true })()`,
      true
    )
    await new Promise((r) => setTimeout(r, 1200))
    const image = await win.webContents.capturePage()
    const out = join(dir, 'flow-canvas.png')
    writeFileSync(out, image.toPNG())
    if (!existsSync(out)) throw new Error('截图写入失败')
    return { path: out, bytes: image.toPNG().length }
  } finally {
    win.destroy()
  }
}
