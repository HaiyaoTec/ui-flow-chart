import { useState } from 'react'
import PreviewPane from './components/preview/PreviewPane'
import { useApp } from './state/store'
import ProjectsView from './views/ProjectsView'
import SettingsView from './views/SettingsView'
import WorkspaceView from './views/WorkspaceView'

type Tab = 'projects' | 'workspace' | 'preview' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('projects')
  const project = useApp((s) => s.project)
  const closeProject = useApp((s) => s.closeProject)

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>UI Flow Chart</h1>
        <nav>
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
            项目
          </button>
          <button
            className={tab === 'workspace' ? 'active' : ''}
            onClick={() => project && setTab('workspace')}
            disabled={!project}
          >
            工作台
          </button>
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
            真机预览
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            AI 接口设置
          </button>
        </nav>
        <div className="spacer" />
        {project && (
          <div className="muted" style={{ fontSize: 11, padding: '0 6px 8px' }}>
            当前项目：{project.name}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11, padding: '0 6px' }}>
          AI 驱动的网站功能路径分析
        </div>
      </aside>

      {tab === 'projects' && <ProjectsView onOpened={() => setTab('workspace')} />}
      {tab === 'workspace' && (
        <WorkspaceView
          onBack={() => {
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
