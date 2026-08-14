import { useEffect, useState } from 'react'
import { DEFAULT_DEVICE_ID, getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import type {
  AiProfileMasked,
  ProjectMeta,
  ProjectRunSummary,
  SessionSnapshot,
  SessionState,
} from '@shared/types'
import DevicePicker from '../components/DevicePicker'
import { useDialog } from '../components/Dialog'
import Icon from '../components/Icon'
import Modal from '../components/Modal'
import Select from '../components/Select'
import SettingsModal from '../components/SettingsModal'
import SiteIcon from '../components/SiteIcon'
import { invoke } from '../ipc'
import { useApp } from '../state/store'
import { STATE_LABEL } from './stateLabel'

interface Props {
  onOpened: () => void
}

/** 列表要显示的状态：有活动会话就用实时的，否则回落到上次探索的落盘结果 */
interface StatusView {
  state: SessionState
  steps: number
  screens: number
  aiCalls: number
  nodes?: number
  reason?: string
}

function liveOrLast(live: SessionSnapshot | null, last?: ProjectRunSummary): StatusView | null {
  if (live) {
    return {
      state: live.state,
      steps: live.step,
      screens: live.screens,
      aiCalls: live.aiCalls,
      reason: live.reason,
    }
  }
  if (!last) return null
  return { ...last }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day < 7) return `${day} 天前`
  return d.toLocaleDateString('zh-CN')
}

export default function ProjectsView({ onOpened }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [profiles, setProfiles] = useState<AiProfileMasked[]>([])
  const [defaultGoal, setDefaultGoal] = useState('')
  const [open, setOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  // 布局偏好记在本地，下次进来还是上次选的
  const [view, setView] = useState<'card' | 'list'>(
    () => (localStorage.getItem('ufc.projectView') as 'card' | 'list') ?? 'card'
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [form, setForm] = useState({ name: '', targetUrl: '', deviceId: DEFAULT_DEVICE_ID, aiProfileId: '', goal: '' })

  const openProject = useApp((s) => s.openProject)
  const session = useApp((s) => s.session)
  const dialog = useDialog()

  /*
   * 列表拉取失败要说出来。
   *
   * 早先是 void reload() 不接错误：工程目录没有访问权限时（macOS 拒绝过
   * 「文件与文件夹」授权就是这种情况）只会是一个未捕获的 Promise rejection，
   * 用户看到的是一个正常的空列表，完全不知道出了什么事。
   */
  const reload = async () => {
    try {
      setProjects(await invoke(CH.projectList))
      setListError('')
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reload()
    void invoke(CH.aiProfilesList).then(setProfiles)
    void invoke(CH.settingsGet).then((s) => setDefaultGoal(s.defaultGoal))
  }, [])

  useEffect(() => localStorage.setItem('ufc.projectView', view), [view])

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
      deviceId: DEFAULT_DEVICE_ID,
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
    const { meta, graph, previewBound } = await invoke(CH.projectOpen, { id })
    openProject(meta, graph, previewBound)
    onOpened()
  }

  async function remove(id: string) {
    if (session?.projectId === id && session.state !== 'idle' && session.state !== 'finished') {
      await dialog.alert({ title: '无法删除', message: '该项目正在探索中，请先结束后再删除。' })
      return
    }
    const p = projects.find((x) => x.id === id)
    const ok = await dialog.confirm({
      title: `删除项目「${p?.name ?? id}」？`,
      message: '工程目录（含全部截图与图谱）会一并删除，且不可恢复。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await invoke(CH.projectDelete, { id })
    await reload()
  }

  /** 当前会话归属于该项目时，展示实时状态 */
  const statusOf = (id: string) => (session?.projectId === id && session.state !== 'idle' ? session : null)

  return (
    <div className="main">
      <div className="page-head">
        <div className="grow">
          <h2>项目</h2>
          <div className="sub">每个项目对应一个待分析的网站，拥有独立的会话分区与图谱工程目录。</div>
        </div>
        <button className="primary" onClick={startCreate}>
          <Icon name="add" />
          创建项目
        </button>
      </div>

      {listError ? (
        <div className="card">
          <div className="empty">读取项目列表失败：{listError}</div>
        </div>
      ) : projects.length === 0 ? (
        <div className="card">
          <div className="empty">还没有项目，点右上角「创建项目」开始。</div>
        </div>
      ) : (
        <>
          {/* 布局切换属于列表自身的显示选项，放在列表上沿、弱化处理 */}
          <div className="list-toolbar">
            <span className="muted">共 {projects.length} 个项目</span>
            <span className="grow" />
            <span className="view-switch">
              <button className={view === 'card' ? 'on' : ''} onClick={() => setView('card')} title="卡片布局">
                <Icon name="viewCard" size={14} />
              </button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="列表布局">
                <Icon name="viewList" size={14} />
              </button>
            </span>
          </div>

          <div className={`project-list ${view}`}>
            {projects.map((p) => {
            const live = statusOf(p.id)
            // 有活动会话就显示实时状态，否则回落到上次探索的落盘结果
            const status = liveOrLast(live, p.lastRun)
            const needHuman = status?.state === 'awaiting_human'
            // 走 getDevice 而不是直接 find：老项目里存的是改版前的设备 id
            const device = getDevice(p.deviceId)
            return (
              <div
                key={p.id}
                className={`project-card${needHuman ? ' need-human' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => void openOne(p.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && void openOne(p.id)}
                title="点击进入项目"
              >
                <SiteIcon url={p.targetUrl} size={view === 'card' ? 30 : 22} />

                <div className="pc-main">
                  <div className="pc-title">
                    <strong>{p.name}</strong>
                    <span className={`state-chip ${status?.state ?? 'idle'}`}>
                      {status ? STATE_LABEL[status.state] ?? status.state : '未开始'}
                    </span>
                    {live && <span className="live-dot" title="正在后台运行" />}
                  </div>

                  <div className="pc-url mono" title={p.targetUrl}>
                    {p.targetUrl}
                  </div>

                  <div className="pc-facts">
                    <span>
                      <Icon name="device" size={13} />
                      {device ? device.name : p.deviceId}
                    </span>
                    {status && (
                      <>
                        <span>
                          <Icon name="screens" size={13} />
                          {status.nodes ?? status.screens} 屏
                        </span>
                        <span>
                          <Icon name="steps" size={13} />
                          {status.steps} 步
                        </span>
                        <span>
                          <Icon name="aiCalls" size={13} />
                          {status.aiCalls} 次 AI 调用
                        </span>
                      </>
                    )}
                    <span className="pc-time">{formatTime(p.updatedAt)}</span>
                  </div>

                  {needHuman && <div className="need-human-tip">需要你介入：{status?.reason}</div>}
                </div>

                  {/* 整块卡片可点，这里只留破坏性操作，并挡住冒泡免得误入项目 */}
                  <div className="pc-actions" onClick={(e) => e.stopPropagation()}>
                    {needHuman && <span className="pc-cta">去处理 ›</span>}
                    <button
                      className="pc-del"
                      onClick={() => void remove(p.id)}
                      title="删除项目及其图谱工程目录"
                      aria-label="删除项目"
                    >
                      <Icon name="delete" size={14} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

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
            <DevicePicker value={form.deviceId} onChange={(v) => setForm({ ...form, deviceId: v })} />
          </label>
          <label className="field grow">
            <span>AI 配置</span>
            <Select
              value={form.aiProfileId}
              onChange={(v) => setForm({ ...form, aiProfileId: v })}
              placeholder="（尚未配置）"
              options={profiles.map((p) => ({ value: p.id, label: p.name, hint: p.model }))}
              emptyAction={{
                label: '新建 AI 配置',
                hint: '还没有 AI 配置，探索需要先接一个模型。',
                onSelect: () => setAiOpen(true),
              }}
            />
          </label>
        </div>

        <label className="field">
          <span>探索目标</span>
          <textarea rows={3} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
          <div className="hint">写得越具体，AI 的探索路径越贴近你关注的功能。</div>
        </label>
      </Modal>

      {/* 从「AI 配置」空态跳过来的：关掉之后把新加的配置取回来，
          原来没选的话直接替用户选上，回到创建表单就能接着填 */}
      <SettingsModal
        open={aiOpen}
        section="ai"
        onClose={() => {
          setAiOpen(false)
          void invoke(CH.aiProfilesList).then((list) => {
            setProfiles(list)
            setForm((f) => (f.aiProfileId || list.length === 0 ? f : { ...f, aiProfileId: list[0].id }))
          })
        }}
      />
    </div>
  )
}
