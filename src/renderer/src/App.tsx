import { useState } from 'react'
import SettingsView from './views/SettingsView'

type Tab = 'projects' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('settings')

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>UI Flow Chart</h1>
        <nav>
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
            项目
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            AI 接口设置
          </button>
        </nav>
        <div className="spacer" />
        <div className="muted" style={{ fontSize: 11, padding: '0 6px' }}>
          AI 驱动的网站功能路径分析
        </div>
      </aside>

      {tab === 'settings' ? (
        <SettingsView />
      ) : (
        <div className="main">
          <h2>项目</h2>
          <div className="sub">项目管理将在下一个里程碑接入。</div>
        </div>
      )}
    </div>
  )
}
