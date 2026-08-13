import { useEffect, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import type { AiProfileMasked, AiProtocol, AiTestResult, AppSettings } from '@shared/types'
import Icon from '../components/Icon'
import Modal from '../components/Modal'
import Select from '../components/Select'
import UpdateSection from '../components/UpdateSection'
import { invoke } from '../ipc'

const PROTOCOL_PRESETS: Record<AiProtocol, { label: string; baseUrl: string; model: string; hint: string }> = {
  openai: {
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    hint: '适用于 OpenAI、DeepSeek、Qwen、Kimi、GLM、Ollama 以及绝大多数中转网关。填到 /v1 即可。',
  },
  anthropic: {
    label: 'Anthropic Messages',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    hint: '直连 Claude 系列。使用强制工具调用输出结构化动作，稳定性更好。',
  },
}

const blank = (protocol: AiProtocol) => ({
  id: '',
  name: '',
  protocol,
  baseUrl: PROTOCOL_PRESETS[protocol].baseUrl,
  model: PROTOCOL_PRESETS[protocol].model,
})

export default function SettingsView() {
  const [profiles, setProfiles] = useState<AiProfileMasked[]>([])
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(blank('openai'))
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState('')
  const [result, setResult] = useState<(AiTestResult & { profileId: string }) | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const reload = async () => setProfiles(await invoke(CH.aiProfilesList))

  useEffect(() => {
    void reload()
    void invoke(CH.settingsGet).then(setSettingsState)
  }, [])

  const editing = Boolean(form.id)

  function startCreate() {
    setForm(blank('openai'))
    setApiKey('')
    setError('')
    setOpen(true)
  }

  function startEdit(p: AiProfileMasked) {
    setForm({ id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model })
    setApiKey('')
    setError('')
    setOpen(true)
  }

  async function save() {
    if (!form.name.trim()) return setError('请填写配置名称')
    if (!form.baseUrl.trim()) return setError('请填写 Base URL')
    if (!form.model.trim()) return setError('请填写模型名')
    if (!editing && !apiKey.trim()) return setError('新建配置必须填写 API Key')
    setSaving(true)
    setError('')
    try {
      await invoke(CH.aiProfileSave, { profile: form, apiKey: apiKey.trim() || undefined })
      await reload()
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function test(id: string) {
    setTesting(id)
    setResult(null)
    try {
      setResult({ ...(await invoke(CH.aiTest, { profileId: id })), profileId: id })
    } finally {
      setTesting('')
    }
  }

  async function remove(id: string) {
    await invoke(CH.aiProfileDelete, { id })
    await reload()
  }

  return (
    <div className="main">
      <div className="page-head">
        <div className="grow">
          <h2>AI 接口设置</h2>
          <div className="sub">
            配置用于分析网站的 AI 模型。API Key 经系统安全存储加密后保存在本地，不会出现在界面与日志里。
          </div>
        </div>
        <button className="primary" onClick={startCreate}>
          <Icon name="add" />
          新建配置
        </button>
      </div>

      <div className="card">
        {profiles.length === 0 && <div className="empty">还没有配置，点右上角「新建配置」开始。</div>}
        {profiles.map((p) => (
          <div key={p.id} className="profile-row">
            <div className="info">
              <div className="row" style={{ gap: 8 }}>
                <strong>{p.name}</strong>
                <span className="badge">{PROTOCOL_PRESETS[p.protocol].label}</span>
                {result?.profileId === p.id && (
                  <span className={`badge ${result.ok ? 'ok' : 'err'}`}>
                    {result.ok ? `连通 ${result.latencyMs}ms${result.vision ? ' · 视觉可用' : ''}` : '连接失败'}
                  </span>
                )}
              </div>
              <div className="meta mono">
                {p.baseUrl} · {p.model} · Key {p.keyMasked || '未设置'}
              </div>
              {result?.profileId === p.id && !result.ok && <div className="err-text">{result.error}</div>}
            </div>
            <div className="acts">
              <button onClick={() => void test(p.id)} disabled={Boolean(testing)}>
                <Icon name="diagnose" />
                {testing === p.id ? '测试中…' : '测试连接'}
              </button>
              <button onClick={() => startEdit(p)}>
                <Icon name="edit" />
                编辑
              </button>
              <button className="danger" onClick={() => void remove(p.id)}>
                <Icon name="delete" />
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {settings && (
        <div className="card">
          <h3>默认探索目标</h3>
          <label className="field">
            <span>新建项目时的默认目标描述</span>
            <textarea
              rows={3}
              value={settings.defaultGoal}
              onChange={(e) => setSettingsState({ ...settings, defaultGoal: e.target.value })}
              onBlur={() => void invoke(CH.settingsSet, { defaultGoal: settings.defaultGoal })}
            />
            <div className="hint">这段文字会作为 AI 探索时的任务说明，写得越具体，探索路径越贴近你的关注点。</div>
          </label>
        </div>
      )}

      <UpdateSection />

      <Modal
        title={editing ? '编辑配置' : '新建配置'}
        subtitle={PROTOCOL_PRESETS[form.protocol].hint}
        open={open}
        onClose={() => setOpen(false)}
        footer={
          <>
            {error && <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</span>}
            <span className="grow" />
            <button onClick={() => setOpen(false)}>取消</button>
            <button className="primary" onClick={save} disabled={saving}>
              {saving ? '保存中…' : editing ? '保存修改' : '创建'}
            </button>
          </>
        }
      >
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field grow">
            <span>配置名称</span>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：工作用 GPT-4o"
            />
          </label>
          <label className="field grow">
            <span>协议</span>
            <Select
              value={form.protocol}
              options={Object.entries(PROTOCOL_PRESETS).map(([k, v]) => ({ value: k, label: v.label }))}
              onChange={(v) => {
                const p = v as AiProtocol
                setForm({ ...form, protocol: p, baseUrl: PROTOCOL_PRESETS[p].baseUrl, model: PROTOCOL_PRESETS[p].model })
              }}
            />
          </label>
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field grow">
            <span>Base URL</span>
            <input className="mono" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label className="field grow">
            <span>模型名</span>
            <input className="mono" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
        </div>

        <label className="field">
          <span>API Key{editing ? '（留空表示不修改）' : ''}</span>
          <input
            className="mono"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing ? '••••••••' : 'sk-…'}
            autoComplete="off"
          />
          <div className="hint">模型需要支持看图，否则无法用于界面分析。保存后可点「测试连接」验证。</div>
        </label>
      </Modal>
    </div>
  )
}
