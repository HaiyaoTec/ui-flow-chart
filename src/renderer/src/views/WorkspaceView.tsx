import { useEffect, useRef, useState } from 'react'
import { getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import FlowCanvas from '../components/canvas/FlowCanvas'
import PreviewPane from '../components/preview/PreviewPane'
import { invoke, on } from '../ipc'
import { useApp } from '../state/store'
import './workspace.css'

const RUNNING = ['launching', 'observing', 'thinking', 'acting', 'resuming']

export default function WorkspaceView({ onBack }: { onBack: () => void }) {
  const { project, graph, session, logs, newNodeIds, applyPatch, pushEvent, setSession } = useApp()
  const [exporting, setExporting] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offPatch = on(CH.evGraphPatch, applyPatch)
    const offEvent = on(CH.evSession, pushEvent)
    void invoke(CH.sessionSnapshot).then(setSession)
    return () => {
      offPatch()
      offEvent()
    }
  }, [applyPatch, pushEvent, setSession])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs.length])

  if (!project || !graph) return null

  const state = session?.state ?? 'idle'
  const running = RUNNING.includes(state)
  const waitingHuman = state === 'awaiting_human'
  const device = getDevice(project.deviceId, project.customDevice)

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
        <button onClick={onBack}>← 项目</button>
        <strong>{project.name}</strong>
        <span className="muted mono" style={{ fontSize: 11.5 }}>
          {project.targetUrl} · {device.name}
        </span>

        <span className={`state-chip ${state}`}>{stateLabel(state)}</span>
        {session && (
          <span className="muted" style={{ fontSize: 11.5 }}>
            {session.step}/{session.budgets.maxSteps} 步 · {session.aiCalls} 次调用 · {session.screens} 屏
          </span>
        )}

        <span className="grow" />

        {state === 'idle' || state === 'finished' || state === 'failed' ? (
          <button className="primary" onClick={start}>
            开始探索
          </button>
        ) : null}
        {running && <button onClick={() => void invoke(CH.sessionPause).then(setSession)}>暂停</button>}
        {state === 'paused' && (
          <button className="primary" onClick={() => void invoke(CH.sessionResume).then(setSession)}>
            继续
          </button>
        )}
        {running && <button onClick={() => void invoke(CH.sessionTakeoverStart).then(setSession)}>我来接管</button>}
        {waitingHuman && (
          <button className="primary" onClick={() => void invoke(CH.sessionTakeoverEnd).then(setSession)}>
            结束接管
          </button>
        )}
        {(running || state === 'paused' || waitingHuman) && (
          <button className="danger" onClick={() => void invoke(CH.sessionStop).then(setSession)}>
            结束
          </button>
        )}
        <button onClick={() => void doExport('html')} disabled={Boolean(exporting)}>
          {exporting === 'html' ? '导出中…' : '导出 HTML'}
        </button>
        <button onClick={() => void doExport('png')} disabled={Boolean(exporting)}>
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

      <div className="ws-body">
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

function stateLabel(s: string): string {
  const map: Record<string, string> = {
    idle: '空闲',
    launching: '启动中',
    observing: '观察界面',
    thinking: 'AI 决策中',
    acting: '执行操作',
    paused: '已暂停',
    awaiting_human: '等待人工',
    resuming: '恢复中',
    finishing: '收尾中',
    finished: '已完成',
    failed: '已中断',
  }
  return map[s] ?? s
}
