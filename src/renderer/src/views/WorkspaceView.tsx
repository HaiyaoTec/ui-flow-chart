import { useEffect, useRef, useState } from 'react'
import { getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import FlowCanvas from '../components/canvas/FlowCanvas'
import { useDialog } from '../components/Dialog'
import Icon from '../components/Icon'
import PreviewPane from '../components/preview/PreviewPane'
import ProjectSwitcher from '../components/ProjectSwitcher'
import Select from '../components/Select'
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
const SPLITTER_W = 1
/** 预览宽到这个比例时，把日志压成一行，把纵向空间让给设备 */
const LOG_COLLAPSE_RATIO = 0.55

interface Props {
  onBack: () => void
  onSwitchProject: () => void
}

export default function WorkspaceView({ onBack, onSwitchProject }: Props) {
  const { project, graph, session: globalSession, logs, newNodeIds, previewBound, setSession } = useApp()
  const [otherRunningName, setOtherRunningName] = useState('')
  const dialog = useDialog()
  // 会话在主进程里是全局单例。别的项目在跑时，这里不能拿它的状态来渲染
  // ——否则工作台会显示成「正在探索」，按钮也变成暂停/结束，操作的却是另一个项目
  const session = globalSession?.projectId === project?.id ? globalSession : null
  const [exporting, setExporting] = useState('')
  const [previewWidth, setPreviewWidth] = useState(DEFAULT_PREVIEW)
  // 收起状态记在本地，下次进来还是上次的选择
  const [logOpen, setLogOpen] = useState(() => localStorage.getItem('ufc.logOpen') !== '0')
  const [dragging, setDragging] = useState(false)
  const [appVer, setAppVer] = useState('')
  // 用户自己调过分栏后就不再自动改，避免跟人抢方向盘
  const widthPinned = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs.length, logOpen])

  useEffect(() => localStorage.setItem('ufc.logOpen', logOpen ? '1' : '0'), [logOpen])

  useEffect(() => {
    void invoke(CH.appInfo)
      .then((i) => setAppVer(`v${i.version}`))
      .catch(() => undefined)
  }, [])

  // 提示里要能报出「是哪个项目占着预览」，光有 id 说不清
  useEffect(() => {
    if (previewBound || !globalSession?.projectId) return setOtherRunningName('')
    const owner = globalSession.projectId
    void invoke(CH.projectList).then((list) => setOtherRunningName(list.find((p) => p.id === owner)?.name ?? ''))
  }, [previewBound, globalSession?.projectId])

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

  if (!project || !graph) return null

  const running = RUNNING.includes(state)
  const waitingHuman = state === 'awaiting_human'
  const device = getDevice(project.deviceId, project.customDevice)
  const bodyWidth = bodyRef.current?.clientWidth ?? 0
  const logCollapsed = bodyWidth > 0 && previewWidth / bodyWidth >= LOG_COLLAPSE_RATIO

  async function start() {
    try {
      setSession(await invoke(CH.sessionStart, { projectId: project!.id, goal: project!.goal }))
    } catch (e) {
      // 最常见的是「另一个项目还在跑」——会话与预览都是全局单例，同一时刻只能有一个
      await dialog.alert({ title: '无法开始探索', message: e instanceof Error ? e.message : String(e) })
    }
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
      await dialog.alert({ title: '导出失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setExporting('')
    }
  }

  return (
    <div className="workspace">
      <div className="ws-bar">
        <ProjectSwitcher current={project} onSwitched={onSwitchProject} onBackToList={onBack} />
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



        {state === 'idle' || state === 'finished' || state === 'failed' ? (
          <button className="primary" onClick={start}>
            <Icon name="start" />
            开始探索
          </button>
        ) : null}
        {running && (
          <button onClick={() => void invoke(CH.sessionPause).then(setSession)}>
            <Icon name="pause" />
            暂停
          </button>
        )}
        {state === 'paused' && (
          <button className="primary" onClick={() => void invoke(CH.sessionResume).then(setSession)}>
            <Icon name="resume" />
            继续
          </button>
        )}
        {running && (
          <button onClick={() => void invoke(CH.sessionTakeoverStart).then(setSession)}>
            <Icon name="takeover" />
            我来接管
          </button>
        )}
        {waitingHuman && (
          <button className="primary" onClick={() => void invoke(CH.sessionTakeoverEnd).then(setSession)}>
            <Icon name="takeoverEnd" />
            结束接管
          </button>
        )}
        {(running || state === 'paused' || waitingHuman || state === 'finishing') && (
          <button className="danger" onClick={() => void invoke(CH.sessionStop).then(setSession)}>
            <Icon name="stop" />
            结束
          </button>
        )}
        {/* 导出是低频操作，两个并排的按钮太占位，收进一个菜单 */}
        <Select
          className="export-select"
          overlay
          triggerLabel={exporting ? '导出中…' : '导出'}
          value=""
          disabled={Boolean(exporting)}
          onChange={(v) => void doExport(v as 'html' | 'png')}
          options={[
            { value: 'html', label: '导出 HTML', hint: '单文件' },
            { value: 'png', label: '导出 PNG', hint: '整张画布' },
          ]}
        />
      </div>

      {/* 预览没跟过来时必须说清楚：顶栏已经是新项目，右侧却还是另一个项目的页面 */}
      {!previewBound && (
        <div className="notice-banner">
          <Icon name="warn" size={14} />
          <span>
            右侧预览仍属于正在探索的
            {otherRunningName ? `「${otherRunningName}」` : '另一个项目'}，本项目的页面暂不会显示。
            结束那边的探索后重新进入本项目即可。
          </span>
        </div>
      )}

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
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${SPLITTER_W}px ${previewWidth}px` }}
      >
        <div className="ws-canvas">
          <FlowCanvas graph={graph} projectId={project.id} device={device} newNodeIds={newNodeIds} />
        </div>

        <div
          className="ws-splitter"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            widthPinned.current = true
            setPreviewWidth(clampWidth(DEFAULT_PREVIEW))
          }}
          role="separator"
          aria-orientation="vertical"
          title="拖动调整画布与预览的占比，双击还原"
        />

        <div className={`ws-side${logOpen ? (logCollapsed ? ' log-collapsed' : '') : ' log-hidden'}`}>
          <PreviewPane initialUrl={project.targetUrl} deviceId={project.deviceId} suppressed={dragging} />

          <div className="ws-log-panel">
            <button className="ws-log-head" onClick={() => setLogOpen((v) => !v)} title={logOpen ? '收起日志' : '展开日志'}>
              <Icon name={logOpen ? 'caretDown' : 'caretUp'} size={14} />
              <span>探索日志</span>
              {/* 版本号钉在日志面板上：用户报障时截的多半就是这一块，
                  截图里带上版本，省掉「你装的哪个版本」这一轮往返 */}
              <span className="ws-log-ver mono">{appVer}</span>
              <span className="muted">{logs.length}</span>
            </button>
            {logOpen && (
              <div className="ws-log" ref={logRef}>
                {logs.length === 0 && <div className="muted" style={{ padding: '6px 4px', fontSize: 12 }}>还没有日志。</div>}
                {logs.map((l, i) => (
                  <div key={i} className={`log-line ${l.level}`}>
                    <span className="mono">{new Date(l.ts).toLocaleTimeString('zh-CN')}</span> {l.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

