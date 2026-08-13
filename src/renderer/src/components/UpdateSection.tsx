import { useEffect, useState } from 'react'
import { CH, type UpdateState } from '@shared/ipc-contract'
import type { AppSettings } from '@shared/types'
import { invoke, on } from '../ipc'
import Icon from './Icon'

const PHASE_TEXT: Record<UpdateState['phase'], string> = {
  idle: '',
  checking: '正在检查…',
  'up-to-date': '已是最新版本',
  available: '发现新版本',
  downloading: '正在下载',
  downloaded: '新版本已就绪，重启后生效',
  error: '检查失败',
}

/**
 * 更新区块：版本信息、两个开关、手动检查。
 * embedded=true 时去掉卡片外壳与标题——它在弹窗里，那两样由 Modal 提供。
 */
export default function UpdateSection({ embedded = false }: { embedded?: boolean }) {
  const [st, setSt] = useState<UpdateState | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => on(CH.evUpdateState, setSt), [])
  useEffect(() => {
    void invoke(CH.updateCheck, { manual: false }).then(setSt)
    void invoke(CH.settingsGet).then(setSettings)
  }, [])

  const patch = async (p: Partial<AppSettings>) => setSettings(await invoke(CH.settingsSet, p))

  const busyPhase = st?.phase === 'checking' || st?.phase === 'downloading'

  return (
    <div className={embedded ? '' : 'card'}>
      {!embedded && <h3>软件更新</h3>}

      <div className="profile-row">
        <div className="info">
          <div className="row" style={{ gap: 8 }}>
            <strong>当前版本 {st?.currentVersion ?? '—'}</strong>
            {st && st.phase !== 'idle' && (
              <span className={`badge ${st.phase === 'error' ? 'err' : st.phase === 'available' || st.phase === 'downloaded' ? 'ok' : ''}`}>
                {PHASE_TEXT[st.phase]}
                {st.phase === 'downloading' ? ` ${st.percent}%` : ''}
                {st.phase === 'available' || st.phase === 'downloaded' ? ` ${st.version}` : ''}
              </span>
            )}
          </div>
          <div className="meta">
            {st?.phase === 'error' ? st.error : '通过 GitHub Release 分发，更新包由应用自行下载与校验。'}
          </div>
        </div>
        <div className="acts">
          {st?.phase === 'available' && (
            <button onClick={() => void invoke(CH.updateDownload)}>
              <Icon name="download" />
              下载
            </button>
          )}
          {st?.phase === 'downloaded' && (
            <button className="primary" disabled={st.busy} title={st.busy ? '探索进行中，结束后才能重启' : ''} onClick={() => void invoke(CH.updateInstall, {})}>
              重启更新
            </button>
          )}
          <button disabled={busyPhase} onClick={() => void invoke(CH.updateCheck, { manual: true }).then(setSt)}>
            检查更新
          </button>
        </div>
      </div>

      {settings && (
        <>
          <label className="seg" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={settings.autoCheckUpdate}
              onChange={(e) => void patch({ autoCheckUpdate: e.target.checked })}
            />
            自动检查新版本
          </label>
          <label className="seg" style={{ marginLeft: 8 }}>
            <input
              type="checkbox"
              checked={settings.autoDownloadUpdate}
              disabled={!settings.autoCheckUpdate}
              onChange={(e) => void patch({ autoDownloadUpdate: e.target.checked })}
            />
            后台自动下载（不会自动重启）
          </label>
        </>
      )}
    </div>
  )
}
