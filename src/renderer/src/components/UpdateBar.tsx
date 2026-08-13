import { useEffect, useState } from 'react'
import { CH, type UpdateState } from '@shared/ipc-contract'
import { invoke, on } from '../ipc'
import { useDialog } from './Dialog'
import Icon from './Icon'
import './update-bar.css'

const DISMISS_KEY = 'ufc.updateDismissed'

/**
 * 更新提示条。
 *
 * 交互取自 Claude Code 桌面端：不弹窗、不抢焦点，只在界面底部出现一条窄条，
 * 说清楚「有新版本」和「怎么装」，随时可以关掉；关掉之后同一个版本不再打扰，
 * 出了更新的版本才会再出现。真正的开关与版本信息放在设置页。
 */
export default function UpdateBar() {
  const [st, setSt] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) ?? '')
  const dialog = useDialog()

  useEffect(() => on(CH.evUpdateState, setSt), [])
  useEffect(() => {
    void invoke(CH.updateCheck, { manual: false }).then(setSt)
  }, [])

  if (!st) return null
  // 只有「可更新」和「已下载」值得占用界面；检查中、已是最新都不出声
  const show = st.phase === 'available' || st.phase === 'downloading' || st.phase === 'downloaded'
  if (!show || dismissed === st.version) return null

  const close = () => {
    localStorage.setItem(DISMISS_KEY, st.version)
    setDismissed(st.version)
  }

  async function install() {
    if (!st) return
    if (st.busy) {
      const ok = await dialog.confirm({
        title: '探索进行中',
        message: '重启会中断当前探索，已抓到的界面不会丢失，但需要重新开始。确定现在重启更新吗？',
        confirmText: '仍然重启',
        danger: true,
      })
      if (!ok) return
    }
    await invoke(CH.updateInstall, { force: true })
  }

  return (
    <div className="update-bar">
      <Icon name="download" size={14} />
      {st.phase === 'available' && (
        <>
          <span className="grow">
            有新版本 <strong>{st.version}</strong> 可用
          </span>
          <button className="link-btn" onClick={() => void invoke(CH.updateDownload)}>
            下载
          </button>
        </>
      )}
      {st.phase === 'downloading' && (
        <>
          <span className="grow">
            正在下载 <strong>{st.version}</strong>
          </span>
          <span className="pct">{st.percent}%</span>
        </>
      )}
      {st.phase === 'downloaded' && (
        <>
          <span className="grow">
            <strong>{st.version}</strong> 已就绪
            {st.busy && <span className="muted">（探索结束后重启即可生效）</span>}
          </span>
          <button className="link-btn strong" onClick={() => void install()}>
            重启更新
          </button>
        </>
      )}
      <button className="link-btn" onClick={close} title="不再提示这个版本">
        ✕
      </button>
    </div>
  )
}
