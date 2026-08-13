import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
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

  /*
   * 超大画布按比例降采样，避免超出窗口尺寸上限。
   *
   * capturePage 出的是物理像素位图，倍率取自窗口所在显示器的缩放比例，且不可指定；
   * 而 MAX_DIM 与窗口尺寸都是 DIP。不把它算进去的话，Retina（固定 2 倍）与 Windows
   * 的 125%/150% 缩放下，导出图的实际像素会成倍放大、体积翻几番，上限也形同虚设。
   * scale 也必须参与取小：写在 min 外面时，scale>1 会顶破上限，窗口却仍被夹住，
   * 结果是内容被裁掉而不是降采样。
   */
  const sf = screen.getPrimaryDisplay().scaleFactor || 1
  const fit = Math.min(1, scale, MAX_DIM / (size.width * sf), MAX_DIM / (size.height * sf))
  const winW = Math.max(400, Math.round(size.width * fit))
  const winH = Math.max(300, Math.round(size.height * fit))

  const win = new BrowserWindow({
    width: winW,
    height: winH,
    // 不设的话 width/height 含窗口框架，内容区比要的小一圈，右下角被裁掉
    useContentSize: true,
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
    // 画布过大或还没出帧时拿到的是空位图，不拦就会写出一个 0 字节的 png
    if (image.isEmpty()) throw new Error('截图失败：画布过大或渲染尚未完成')
    const out = join(dir, 'flow-canvas.png')
    const png = image.toPNG()
    writeFileSync(out, png)
    if (!existsSync(out)) throw new Error('截图写入失败')
    return { path: out, bytes: png.length }
  } finally {
    win.destroy()
  }
}
