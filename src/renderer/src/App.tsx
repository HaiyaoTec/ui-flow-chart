import { useEffect, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import PreviewPane from './components/preview/PreviewPane'
import ThemeMenu from './components/ThemeMenu'
import { invoke, on } from './ipc'
import { useApp } from './state/store'
import ProjectsView from './views/ProjectsView'
import SettingsView from './views/SettingsView'
import WorkspaceView from './views/WorkspaceView'

type Tab = 'projects' | 'workspace' | 'preview' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('projects')
  const project = useApp((s) => s.project)
  const session = useApp((s) => s.session)
  const closeProject = useApp((s) => s.closeProject)
  const applyPatch = useApp((s) => s.applyPatch)
  const pushEvent = useApp((s) => s.pushEvent)
  const setSession = useApp((s) => s.setSession)

  // 订阅放在顶层：探索在主进程后台跑，用户离开工作台后
  // 状态与日志也要继续收，否则回到列表就看不见进度了
  useEffect(() => {
    const offPatch = on(CH.evGraphPatch, applyPatch)
    const offEvent = on(CH.evSession, pushEvent)
    void invoke(CH.sessionSnapshot).then(setSession)
    return () => {
      offPatch()
      offEvent()
    }
  }, [applyPatch, pushEvent, setSession])

  const waitingHuman = session?.state === 'awaiting_human'

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>UI Flow Chart</h1>
        <nav>
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
            <span className="emoji">📁</span>项目
          </button>
          <button
            className={tab === 'workspace' ? 'active' : ''}
            onClick={() => project && setTab('workspace')}
            disabled={!project}
          >
            <span className="emoji">🧭</span>工作台
            {waitingHuman && <span className="nav-dot" title="需要人工介入" />}
          </button>
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
            <span className="emoji">📱</span>真机预览
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            <span className="emoji">⚙️</span>AI 接口设置
          </button>
        </nav>

        <div className="spacer" />

        {project && (
          <div className="muted" style={{ fontSize: 11, padding: '0 6px 10px' }}>
            当前项目：{project.name}
          </div>
        )}
        <ThemeMenu />
      </aside>

      {tab === 'projects' && (
        <ProjectsView onOpened={() => setTab('workspace')} />
      )}
      {tab === 'workspace' && (
        <WorkspaceView
          onBack={() => {
            // 只离开工作台，不停探索——会话活在主进程里，继续在后台跑
            closeProject()
            setTab('projects')
          }}
        />
      )}
      {tab === 'preview' && <PreviewPane initialUrl="http://localhost:4173" />}
      {tab === 'settings' && <SettingsView />}
    </div>
  )
}
