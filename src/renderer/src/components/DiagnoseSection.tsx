import { useEffect, useState } from 'react'
import { CH, type AppInfo, type DiagnoseResult } from '@shared/ipc-contract'
import { invoke } from '../ipc'
import { useDialog } from './Dialog'
import Icon from './Icon'
import { useApp } from '../state/store'

/**
 * 诊断与日志。
 *
 * 应用装在用户机器上，出问题时作者拿不到任何数据，只能靠用户发截图——
 * 而截图里既没有版本号，也没有异常堆栈，更看不出当时的会话状态。
 * 这里把定位一个缺陷需要的材料一次收齐，导出成一个文件。
 *
 * 界面上刻意把「带什么、不带什么」全部摆出来，而不是一句「已脱敏请放心」：
 * 目标站地址、界面标题这些东西带不带，只有用户自己判断得了。
 */
export default function DiagnoseSection() {
  const project = useApp((s) => s.project)
  const dialog = useDialog()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [repro, setRepro] = useState(false)
  const [shots, setShots] = useState(false)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<DiagnoseResult | null>(null)

  useEffect(() => {
    void invoke(CH.appInfo).then(setInfo).catch(() => undefined)
  }, [])

  async function exportPack(): Promise<void> {
    setBusy(true)
    try {
      const r = await invoke(CH.diagnoseExport, {
        projectId: project?.id,
        level: repro ? 'repro' : 'basic',
        includeShots: shots,
      })
      setLast(r)
    } catch (e) {
      await dialog.alert({ title: '导出失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="profile-row">
        <div className="info">
          <div className="row" style={{ gap: 8 }}>
            <strong>当前版本 {info?.version ?? '—'}</strong>
            <span className="badge">
              {info ? `${info.platform}-${info.arch}` : ''}
            </span>
          </div>
          <div className="meta">
            {info ? `Electron ${info.electron} · Chromium ${info.chrome} · ${info.os}` : '正在读取运行环境…'}
          </div>
        </div>
      </div>

      <div className="diag-opts">
        <label className="diag-opt">
          <input type="checkbox" checked={repro} onChange={(e) => setRepro(e.target.checked)} />
          <span>
            <strong>包含复现所需的信息</strong>
            <em>目标站地址、界面标题与页面校验提示原文。不勾选时诊断包不含目标站的任何内容。</em>
          </span>
        </label>
        <label className="diag-opt">
          <input type="checkbox" checked={shots} onChange={(e) => setShots(e.target.checked)} />
          <span>
            <strong>包含界面缩略图</strong>
            <em>最近 12 张，低分辨率。原始分辨率存档图任何情况下都不包含。</em>
          </span>
        </label>
      </div>

      <div className="profile-row">
        <div className="info">
          <div className="meta">
            {project ? `将导出当前项目「${project.name}」的诊断信息` : '当前没有打开项目，将只导出应用级别的信息'}
          </div>
        </div>
        <div className="acts">
          <button className="primary" disabled={busy} onClick={() => void exportPack()}>
            <Icon name="exportHtml" />
            {busy ? '正在生成…' : '导出诊断包'}
          </button>
        </div>
      </div>

      {last && (
        <div className="diag-result">
          <div className="row" style={{ gap: 8 }}>
            <strong>已生成</strong>
            <span className="badge ok">{(last.bytes / 1024).toFixed(0)} KB</span>
            <button onClick={() => void invoke(CH.shellReveal, { path: last.path })}>
              <Icon name="open" />
              在文件夹中显示
            </button>
          </div>
          <div className="diag-lists">
            <div>
              <div className="diag-cap">包含</div>
              <ul>
                {last.included.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="diag-cap">不包含</div>
              <ul className="off">
                {last.excluded.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
