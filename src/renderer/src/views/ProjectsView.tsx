import { useEffect, useState } from 'react'
import { DEVICE_PRESETS } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import type { AiProfileMasked, ProjectMeta } from '@shared/types'
import { invoke } from '../ipc'
import { useApp } from '../state/store'

interface Props {
  onOpened: () => void
}

export default function ProjectsView({ onOpened }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [profiles, setProfiles] = useState<AiProfileMasked[]>([])
  const [name, setName] = useState('')
  const [targetUrl, setTargetUrl] = useState('')
  const [deviceId, setDeviceId] = useState(DEVICE_PRESETS[0].id)
  const [aiProfileId, setAiProfileId] = useState('')
  const [goal, setGoal] = useState('')
  const [error, setError] = useState('')
  const openProject = useApp((s) => s.openProject)

  const reload = async () => setProjects(await invoke(CH.projectList))

  useEffect(() => {
    void reload()
    void invoke(CH.aiProfilesList).then((list) => {
      setProfiles(list)
      if (list.length && !aiProfileId) setAiProfileId(list[0].id)
    })
    void invoke(CH.settingsGet).then((s) => setGoal((g) => g || s.defaultGoal))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create() {
    if (!name.trim()) return setError('请填写项目名称')
    if (!targetUrl.trim()) return setError('请填写目标网站地址')
    if (!aiProfileId) return setError('请先在「AI 接口设置」里配置一个模型')
    setError('')
    const url = /^https?:\/\//.test(targetUrl) ? targetUrl : `https://${targetUrl}`
    await invoke(CH.projectCreate, { name: name.trim(), targetUrl: url, deviceId, aiProfileId, goal })
    setName('')
    setTargetUrl('')
    await reload()
  }

  async function open(id: string) {
    const { meta, graph } = await invoke(CH.projectOpen, { id })
    openProject(meta, graph)
    onOpened()
  }

  async function remove(id: string) {
    await invoke(CH.projectDelete, { id })
    await reload()
  }

  return (
    <div className="main">
      <h2>项目</h2>
      <div className="sub">每个项目对应一个待分析的网站，拥有独立的会话分区与图谱工程目录。</div>

      <div className="card">
        <h3>新建项目</h3>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field grow">
            <span>项目名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：某站移动端注册登录" />
          </label>
          <label className="field grow">
            <span>目标网站</span>
            <input
              className="mono"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </label>
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field grow">
            <span>模拟设备</span>
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {DEVICE_PRESETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.width}×{d.height}@{d.deviceScaleFactor}x
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>AI 配置</span>
            <select value={aiProfileId} onChange={(e) => setAiProfileId(e.target.value)}>
              {profiles.length === 0 && <option value="">（尚未配置）</option>}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>探索目标</span>
          <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
          <div className="hint">写得越具体，AI 的探索路径越贴近你关注的功能。</div>
        </label>

        {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        <button className="primary" onClick={create}>
          创建项目
        </button>
      </div>

      <div className="card">
        <h3>已有项目</h3>
        {projects.length === 0 && <div className="empty">还没有项目。</div>}
        {projects.map((p) => (
          <div key={p.id} className="row" style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
            <div className="grow">
              <strong>{p.name}</strong>
              <div className="muted mono" style={{ fontSize: 11.5 }}>
                {p.targetUrl} · {p.deviceId} · 更新于 {new Date(p.updatedAt).toLocaleString('zh-CN')}
              </div>
            </div>
            <button className="primary" onClick={() => open(p.id)}>
              打开
            </button>
            <button className="danger" onClick={() => remove(p.id)}>
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
