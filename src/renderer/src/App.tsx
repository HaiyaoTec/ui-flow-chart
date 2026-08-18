import { useEffect, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import Icon from './components/Icon'
import Logo from './components/Logo'
import PreviewPane from './components/preview/PreviewPane'
import SettingsMenu from './components/SettingsMenu'
import UpdateBar from './components/UpdateBar'
import { invoke, on } from './ipc'
import { useApp } from './state/store'
import ProjectsView from './views/ProjectsView'
import WorkspaceView from './views/WorkspaceView'

type Tab = 'projects' | 'workspace' | 'preview'

export default function App() {
  const [tab, setTab] = useState<Tab>('projects')
  const [navOpen, setNavOpen] = useState(() => localStorage.getItem('ufc.navOpen') !== '0')
  const project = useApp((s) => s.project)
  const sessions = useApp((s) => s.sessions)
  const closeProject = useApp((s) => s.closeProject)
  const applyPatch = useApp((s) => s.applyPatch)
  const pushEvent = useApp((s) => s.pushEvent)
  const setSessions = useApp((s) => s.setSessions)

  // 订阅放在顶层：探索在主进程后台跑，用户离开工作台后
  // 状态与日志也要继续收，否则回到列表就看不见进度了
  useEffect(() => {
    const offPatch = on(CH.evGraphPatch, applyPatch)
    const offEvent = on(CH.evSession, pushEvent)
    void invoke(CH.sessionList).then(setSessions)
    return () => {
      offPatch()
      offEvent()
    }
  }, [applyPatch, pushEvent, setSessions])

  useEffect(() => localStorage.setItem('ufc.navOpen', navOpen ? '1' : '0'), [navOpen])

  // 任一会话在等人就亮：多个项目可以同时跑，红点是「有事要你处理」而不是某一个项目
  const waitingHuman = Object.values(sessions).some((s) => s.state === 'awaiting_human')

  return (
    <div className="app">
      <aside className={`sidebar${navOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-head">
          {/* 收起后这一行只剩 40px 可用，标记与折叠按钮挤不下，
              标记会被裁成一条绿边；收起态就只留折叠按钮 */}
          {navOpen && (
            <h1>
              <Logo size={22} />
            </h1>
          )}
          <button
            className="nav-toggle"
            onClick={() => setNavOpen((v) => !v)}
            title={navOpen ? '收起侧边栏' : '展开侧边栏'}
            aria-label={navOpen ? '收起侧边栏' : '展开侧边栏'}
          >
            <Icon name={navOpen ? 'collapse' : 'expand'} size={16} />
          </button>
        </div>
        {/* 收起时只留图标，文案退到 title 里 */}
        <nav>
          {/* 工作台不占独立入口：项目卡点进去就是工作台，标题栏可切项目 */}
          <button
            className={tab === 'projects' || tab === 'workspace' ? 'active' : ''}
            onClick={() => setTab(project ? 'workspace' : 'projects')}
            title="项目"
          >
            <Icon name="projects" />
            {navOpen && '项目'}
            {waitingHuman && <span className="nav-dot" title="需要人工介入" />}
          </button>
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')} title="真机预览">
            <Icon name="preview" />
            {navOpen && '真机预览'}
          </button>
        </nav>

        <div className="spacer" />

        {/* 配置类的三项（主题 / AI 接口 / 软件更新）都收在这一个入口里，
            与上方导航之间只用一条分隔线区分，不做背景色区分 */}
        <div className="sidebar-foot">
          <SettingsMenu compact={!navOpen} />
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

      {/* 更新提示常驻，不随页面切换消失；它自己决定该不该出现 */}
      <UpdateBar />
    </div>
  )
}
