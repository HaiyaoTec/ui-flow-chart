import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDevice } from '@shared/devices'
import { renderHtml } from '@shared/canvas-core/render-html'
import type { ExportResult } from '@shared/ipc-contract'
import type { FlowGraph } from '@shared/types'
import { projectDir } from '../store/paths'
import { getProject } from '../store/projects'
import { readJson } from '../store/paths'

/** 导出自包含的单文件 HTML：把每个节点的缩略图内联成 data URI */
export function exportProjectHtml(projectId: string): ExportResult {
  const meta = getProject(projectId)
  if (!meta) throw new Error('项目不存在')
  const dir = projectDir(projectId)
  const graph = readJson<FlowGraph | null>(join(dir, 'graph.json'), null)
  if (!graph) throw new Error('该项目还没有图谱数据')

  const device = getDevice(meta.deviceId, meta.customDevice)

  const html = renderHtml(graph, {
    title: `${meta.name} · 功能流程画布`,
    subtitle: `${device.name} ${device.width}×${device.height}@${device.deviceScaleFactor}x`,
    device,
    imageSrc: (nodeId) => {
      const thumb = join(dir, 'screens', `${nodeId}.thumb.jpg`)
      if (!existsSync(thumb)) return null
      return `data:image/jpeg;base64,${readFileSync(thumb).toString('base64')}`
    },
  })

  const out = join(dir, 'flow-canvas.html')
  writeFileSync(out, html, 'utf8')
  return { path: out, bytes: Buffer.byteLength(html) }
}
