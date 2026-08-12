import { useEffect, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import Icon from './components/Icon'
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
          {/* 工作台不占独立入口：项目卡点进去就是工作台，标题栏可切项目 */}
          <button
            className={tab === 'projects' || tab === 'workspace' ? 'active' : ''}
            onClick={() => setTab(project ? 'workspace' : 'projects')}
          >
            <Icon name="projects" />
            项目
            {waitingHuman && <span className="nav-dot" title="需要人工介入" />}
          </button>
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
            <Icon name="preview" />
            真机预览
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            <Icon name="settings" />
            AI 接口设置
          </button>
        </nav>

        <div className="spacer" />

        {/* 只用一条分隔线把导航区与设置区分开，不做背景色区分 */}
        <div className="sidebar-foot">
          <div className="sidebar-foot-label">设置</div>
          <ThemeMenu />
        </div>
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
          onSwitchProject={() => setTab('workspace')}
        />
      )}
      {tab === 'preview' && <PreviewPane initialUrl="http://localhost:4173" />}
      {tab === 'settings' && <SettingsView />}
    </div>
  )
}
