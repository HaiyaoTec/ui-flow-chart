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

/** 画布与预览的空间分配。人工接管时预览必须够大，否则根本点不动 */
type Layout = 'canvas' | 'split' | 'preview'

const LAYOUT_LABEL: Record<Layout, string> = {
  canvas: '画布为主',
  split: '左右均分',
  preview: '预览为主',
}

export default function WorkspaceView({ onBack }: { onBack: () => void }) {
  const { project, graph, session, logs, newNodeIds, setSession } = useApp()
  const [exporting, setExporting] = useState('')
  const [layout, setLayout] = useState<Layout>('canvas')
  // 用户手动调过布局后就不再自动切换，避免跟人抢方向盘
  const layoutPinned = useRef(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs.length])

  const state = session?.state ?? 'idle'

  // 进入等待人工时自动让位给预览，接管结束再还给画布
  useEffect(() => {
    if (layoutPinned.current) return
    setLayout(state === 'awaiting_human' ? 'preview' : 'canvas')
  }, [state])

  if (!project || !graph) return null

  const running = RUNNING.includes(state)
  const waitingHuman = state === 'awaiting_human'
  const device = getDevice(project.deviceId, project.customDevice)

  function pickLayout(next: Layout) {
    layoutPinned.current = true
    setLayout(next)
  }

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

        <span className="layout-switch">
          {(Object.keys(LAYOUT_LABEL) as Layout[]).map((k) => (
            <button key={k} className={layout === k ? 'on' : ''} onClick={() => pickLayout(k)}>
              {LAYOUT_LABEL[k]}
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

      <div className={`ws-body layout-${layout}`}>
        <div className="ws-canvas">
          <FlowCanvas graph={graph} projectId={project.id} device={device} newNodeIds={newNodeIds} />
        </div>

        <div className="ws-side">
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

