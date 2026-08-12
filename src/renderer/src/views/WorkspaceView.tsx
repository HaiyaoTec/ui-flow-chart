import { useEffect, useRef, useState } from 'react'
import { getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import FlowCanvas from '../components/canvas/FlowCanvas'
import PreviewPane from '../components/preview/PreviewPane'
import { invoke } from '../ipc'
import { useApp } from '../state/store'
import { STATE_LABEL } from './stateLabel'
import './workspace.css'

const RUNNING = ['launching', 'observing', 'thinking', 'acting', 'resuming']

/** 两侧的最小可用宽度：低于这个值画布看不清、预览点不动 */
const MIN_CANVAS = 320
const MIN_PREVIEW = 300
const DEFAULT_PREVIEW = 460
/** 分栏本身占的宽度，夹取时要一并扣掉，否则画布会比最小宽度再少这一条 */
const SPLITTER_W = 8
/** 预览宽到这个比例时，把日志压成一行，把纵向空间让给设备 */
const LOG_COLLAPSE_RATIO = 0.55

type Preset = 'canvas' | 'split' | 'preview'

const PRESET_LABEL: Record<Preset, string> = {
  canvas: '画布为主',
  split: '左右均分',
  preview: '预览为主',
}

export default function WorkspaceView({ onBack }: { onBack: () => void }) {
  const { project, graph, session, logs, newNodeIds, setSession } = useApp()
  const [exporting, setExporting] = useState('')
  const [previewWidth, setPreviewWidth] = useState(DEFAULT_PREVIEW)
  const [dragging, setDragging] = useState(false)
  // 用户自己调过分栏后就不再自动改，避免跟人抢方向盘
  const widthPinned = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs.length])

  const state = session?.state ?? 'idle'

  /** 把宽度夹在两侧最小宽度之间，容器太窄时优先保证预览可用 */
  const clampWidth = (w: number): number => {
    const total = bodyRef.current?.clientWidth ?? 0
    if (!total) return Math.max(MIN_PREVIEW, w)
    const max = Math.max(MIN_PREVIEW, total - MIN_CANVAS - SPLITTER_W)
    return Math.min(Math.max(w, MIN_PREVIEW), max)
  }

  // 进入等待人工时自动把空间让给预览，接管结束再还回画布
  useEffect(() => {
    if (widthPinned.current) return
    const total = bodyRef.current?.clientWidth ?? 0
    setPreviewWidth(state === 'awaiting_human' && total ? clampWidth(total) : DEFAULT_PREVIEW)
  }, [state])

  // 窗口变化时重新夹一次，避免窗口变窄后画布被挤没
  useEffect(() => {
    const onResize = () => setPreviewWidth((w) => clampWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startX = e.clientX
    const startW = previewWidth
    widthPinned.current = true
    setDragging(true)
    const onMove = (ev: PointerEvent) => setPreviewWidth(clampWidth(startW - (ev.clientX - startX)))
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function applyPreset(p: Preset) {
    widthPinned.current = true
    const total = bodyRef.current?.clientWidth ?? 0
    if (p === 'canvas') setPreviewWidth(clampWidth(DEFAULT_PREVIEW))
    else if (p === 'split') setPreviewWidth(clampWidth(total / 2))
    else setPreviewWidth(clampWidth(total))
  }

  if (!project || !graph) return null

  const running = RUNNING.includes(state)
  const waitingHuman = state === 'awaiting_human'
  const device = getDevice(project.deviceId, project.customDevice)
  const bodyWidth = bodyRef.current?.clientWidth ?? 0
  const logCollapsed = bodyWidth > 0 && previewWidth / bodyWidth >= LOG_COLLAPSE_RATIO

  async function start() {
    setSession(await invoke(CH.sessionStart, { projectId: project!.id, goal: project!.goal }))
  }

  async function doExport(kind: 'html' | 'png') {
    setExporting(kind)
    try {
      const r =
        kind === 'html'
          ? await invoke(CH.exportHtml, { projectId: project!.id })
          : await invoke(CH.exportPng, { projectId: project!.id })
      await invoke(CH.shellReveal, { path: r.path })
    } catch (e) {
      alert(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting('')
    }
  }

  return (
    <div className="workspace">
      <div className="ws-bar">
        <button onClick={onBack} title="返回项目列表，探索会继续在后台运行">
          <span className="emoji">⬅️</span>项目
        </button>
        <strong>{project.name}</strong>
        <span className="muted mono" style={{ fontSize: 11.5 }}>
          {project.targetUrl} · {device.name}
        </span>

        <span className={`state-chip ${state}`}>{STATE_LABEL[state] ?? state}</span>
        {session && (
          <span className="muted" style={{ fontSize: 11.5 }}>
            {session.step}/{session.budgets.maxSteps} 步 · {session.aiCalls} 次调用 · {session.screens} 屏
          </span>
        )}

        <span className="grow" />

        <span className="layout-switch" title="快捷分配，也可以直接拖动中间的分栏">
          {(Object.keys(PRESET_LABEL) as Preset[]).map((k) => (
            <button key={k} onClick={() => applyPreset(k)}>
              {PRESET_LABEL[k]}
            </button>
          ))}
        </span>


        {state === 'idle' || state === 'finished' || state === 'failed' ? (
          <button className="primary" onClick={start}>
            <span className="emoji">▶️</span>开始探索
          </button>
        ) : null}
        {running && (
          <button onClick={() => void invoke(CH.sessionPause).then(setSession)}>
            <span className="emoji">⏸️</span>暂停
          </button>
        )}
        {state === 'paused' && (
          <button className="primary" onClick={() => void invoke(CH.sessionResume).then(setSession)}>
            <span className="emoji">▶️</span>继续
          </button>
        )}
        {running && (
          <button onClick={() => void invoke(CH.sessionTakeoverStart).then(setSession)}>
            <span className="emoji">✋</span>我来接管
          </button>
        )}
        {waitingHuman && (
          <button className="primary" onClick={() => void invoke(CH.sessionTakeoverEnd).then(setSession)}>
            <span className="emoji">✅</span>结束接管
          </button>
        )}
        {(running || state === 'paused' || waitingHuman) && (
          <button className="danger" onClick={() => void invoke(CH.sessionStop).then(setSession)}>
            <span className="emoji">⏹️</span>结束
          </button>
        )}
        <button onClick={() => void doExport('html')} disabled={Boolean(exporting)}>
          <span className="emoji">📄</span>
          {exporting === 'html' ? '导出中…' : '导出 HTML'}
        </button>
        <button onClick={() => void doExport('png')} disabled={Boolean(exporting)}>
          <span className="emoji">🖼️</span>
          {exporting === 'png' ? '导出中…' : '导出 PNG'}
        </button>
      </div>

      {waitingHuman && (
        <div className="takeover-banner">
          <strong>已交给你操作</strong>
          <span>{session?.reason}</span>
          <span className="muted">
            请在右侧预览窗口中手动完成这一步，期间界面每变化一次都会自动截图入库；完成后点击「结束接管」，AI 会接着往下走。
            输入内容不会被记录，也不会发给模型。
          </span>
        </div>
      )}

      <div
        className={`ws-body${dragging ? ' dragging' : ''}`}
        ref={bodyRef}
        style={{ gridTemplateColumns: `minmax(0, 1fr) 8px ${previewWidth}px` }}
      >
        <div className="ws-canvas">
          <FlowCanvas graph={graph} projectId={project.id} device={device} newNodeIds={newNodeIds} />
        </div>

        <div
          className="ws-splitter"
          onPointerDown={startDrag}
          onDoubleClick={() => applyPreset('canvas')}
          role="separator"
          aria-orientation="vertical"
          title="拖动调整画布与预览的占比，双击还原"
        >
          <span />
        </div>

        <div className={`ws-side${logCollapsed ? ' log-collapsed' : ''}`}>
          <PreviewPane initialUrl={project.targetUrl} />
          <div className="ws-log" ref={logRef}>
            {logs.length === 0 && <div className="muted" style={{ padding: 10, fontSize: 12 }}>还没有日志。</div>}
            {logs.map((l, i) => (
              <div key={i} className={`log-line ${l.level}`}>
                <span className="mono">{new Date(l.ts).toLocaleTimeString('zh-CN')}</span> {l.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

