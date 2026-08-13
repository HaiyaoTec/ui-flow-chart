import { useEffect, useRef, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import type { ProjectMeta } from '@shared/types'
import { invoke } from '../ipc'
import { useApp } from '../state/store'
import { STATE_LABEL } from '../views/stateLabel'
import Icon from './Icon'
import SiteIcon from './SiteIcon'
import './project-switcher.css'

interface Props {
  current: ProjectMeta
  /** 切换完成后的回调，用于把视图留在工作台 */
  onSwitched: () => void
  /** 回到项目列表 */
  onBackToList: () => void
}

/** 工作台标题即项目切换器，省掉「先退回列表再进另一个项目」这一步 */
export default function ProjectSwitcher({ current, onSwitched, onBackToList }: Props) {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const boxRef = useRef<HTMLDivElement>(null)
  const openProject = useApp((s) => s.openProject)
  const session = useApp((s) => s.session)

  useEffect(() => {
    if (!open) return
    void invoke(CH.projectList).then(setProjects)
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function pick(id: string) {
    setOpen(false)
    if (id === current.id) return
    const { meta, graph, previewBound } = await invoke(CH.projectOpen, { id })
    openProject(meta, graph, previewBound)
    onSwitched()
  }

  return (
    <div className="proj-switch" ref={boxRef}>
      <button
        className={`proj-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="切换项目"
      >
        <SiteIcon url={current.targetUrl} size={22} />
        <strong>{current.name}</strong>
        <Icon name="caretDown" size={16} className="caret" />
      </button>

      {open && (
        <div className="proj-pop" role="menu">
          <div className="proj-pop-list">
            {/* 与项目条目同排列，固定在第一项，不单独占一行布局 */}
            <button className="to-list" onClick={onBackToList}>
              <Icon name="projects" size={18} />
              <span className="grow">
                <span className="nm">返回项目列表</span>
              </span>
            </button>
            <div className="proj-pop-sep" />

            {projects.map((p) => {
              const isLive = session?.projectId === p.id && session.state !== 'idle'
              const state = isLive ? session!.state : p.lastRun?.state
              return (
                <button key={p.id} onClick={() => void pick(p.id)} className={p.id === current.id ? 'on' : ''}>
                  <SiteIcon url={p.targetUrl} size={18} />
                  <span className="grow">
                    <span className="nm">{p.name}</span>
                    <span className="u mono">{p.targetUrl}</span>
                  </span>
                  {/* 当前项目不再额外画勾：右边已经有「已完成」这类状态徽标，
                      两个符号挤在一起谁都看不清。选中态改用左侧色条 + 加粗标题表达 */}
                  {state && <span className={`state-chip ${state}`}>{STATE_LABEL[state] ?? state}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
