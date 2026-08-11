import { useEffect, useState } from 'react'
import { DEVICE_PRESETS } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import type { AiProfileMasked, ProjectMeta } from '@shared/types'
import Modal from '../components/Modal'
import { invoke } from '../ipc'
import { useApp } from '../state/store'
import { STATE_LABEL } from './stateLabel'

interface Props {
  onOpened: () => void
}

export default function ProjectsView({ onOpened }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [profiles, setProfiles] = useState<AiProfileMasked[]>([])
  const [defaultGoal, setDefaultGoal] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', targetUrl: '', deviceId: DEVICE_PRESETS[0].id, aiProfileId: '', goal: '' })

  const openProject = useApp((s) => s.openProject)
  const session = useApp((s) => s.session)

  const reload = async () => setProjects(await invoke(CH.projectList))

  useEffect(() => {
    void reload()
    void invoke(CH.aiProfilesList).then(setProfiles)
    void invoke(CH.settingsGet).then((s) => setDefaultGoal(s.defaultGoal))
  }, [])

  // 后台探索会不断改动项目的更新时间，列表跟着刷新
  useEffect(() => {
    if (!session || session.state === 'idle') return
    const t = setInterval(reload, 4000)
    return () => clearInterval(t)
  }, [session?.state])

  function startCreate() {
    setForm({
      name: '',
      targetUrl: '',
      deviceId: DEVICE_PRESETS[0].id,
      aiProfileId: profiles[0]?.id ?? '',
      goal: defaultGoal,
    })
    setError('')
    setOpen(true)
  }

  async function create() {
    if (!form.name.trim()) return setError('请填写项目名称')
    if (!form.targetUrl.trim()) return setError('请填写目标网站地址')
    if (!form.aiProfileId) return setError('请先在「AI 接口设置」里配置一个模型')
    setSaving(true)
    setError('')
    try {
      const url = /^https?:\/\//.test(form.targetUrl) ? form.targetUrl : `https://${form.targetUrl}`
      await invoke(CH.projectCreate, { ...form, name: form.name.trim(), targetUrl: url })
      await reload()
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function openOne(id: string) {
    const { meta, graph } = await invoke(CH.projectOpen, { id })
    openProject(meta, graph)
    onOpened()
  }

  async function remove(id: string) {
    if (session?.projectId === id && session.state !== 'idle' && session.state !== 'finished') {
      alert('该项目正在探索中，请先结束后再删除。')
      return
    }
    await invoke(CH.projectDelete, { id })
    await reload()
  }

  /** 当前会话归属于该项目时，展示实时状态 */
  const statusOf = (id: string) => (session?.projectId === id && session.state !== 'idle' ? session : null)

  return (
    <div className="main">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h2>项目</h2>
          <div className="sub">每个项目对应一个待分析的网站，拥有独立的会话分区与图谱工程目录。</div>
        </div>
        <button className="primary" onClick={startCreate}>
          创建项目
        </button>
      </div>

      <div className="card">
        {projects.length === 0 && <div className="empty">还没有项目，点右上角「创建项目」开始。</div>}
        {projects.map((p) => {
          const st = statusOf(p.id)
          const needHuman = st?.state === 'awaiting_human'
          return (
            <div
              key={p.id}
              className={`row project-row${needHuman ? ' need-human' : ''}`}
              style={{ padding: '12px 0', borderTop: '1px solid var(--line)' }}
            >
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <strong>{p.name}</strong>
                  {st && <span className={`state-chip ${st.state}`}>{STATE_LABEL[st.state] ?? st.state}</span>}
                  {st && (
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {st.step}/{st.budgets.maxSteps} 步 · {st.screens} 屏
                    </span>
                  )}
                </div>
                <div className="muted mono" style={{ fontSize: 11.5 }}>
                  {p.targetUrl} · {p.deviceId} · 更新于 {new Date(p.updatedAt).toLocaleString('zh-CN')}
                </div>
                {needHuman && <div className="need-human-tip">需要你介入：{st?.reason}</div>}
              </div>
              <button className={needHuman ? 'primary' : ''} onClick={() => void openOne(p.id)}>
                {needHuman ? '去处理' : st ? '查看进度' : '打开'}
              </button>
              <button className="danger" onClick={() => void remove(p.id)}>
                删除
              </button>
            </div>
          )
        })}
      </div>

      <Modal
        title="创建项目"
        subtitle="填好之后可以在工作台里随时调整探索目标"
        open={open}
        onClose={() => setOpen(false)}
        footer={
          <>
            {error && <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</span>}
            <span className="grow" />
            <button onClick={() => setOpen(false)}>取消</button>
            <button className="primary" onClick={create} disabled={saving}>
              {saving ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field grow">
            <span>项目名称</span>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：某站移动端注册登录"
            />
          </label>
          <label className="field grow">
            <span>目标网站</span>
            <input
              className="mono"
              value={form.targetUrl}
              onChange={(e) => setForm({ ...form, targetUrl: e.target.value })}
              placeholder="https://example.com"
            />
          </label>
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field grow">
            <span>模拟设备</span>
            <select value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
              {DEVICE_PRESETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.width}×{d.height}@{d.deviceScaleFactor}x
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>AI 配置</span>
            <select value={form.aiProfileId} onChange={(e) => setForm({ ...form, aiProfileId: e.target.value })}>
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
          <textarea rows={3} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
          <div className="hint">写得越具体，AI 的探索路径越贴近你关注的功能。</div>
        </label>
      </Modal>
    </div>
  )
}
