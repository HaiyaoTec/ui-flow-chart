import { useEffect, useState } from 'react'
import Icon, { type IconName } from './Icon'
import Modal from './Modal'
import AiSettingsPanel from './AiSettingsPanel'
import DiagnoseSection from './DiagnoseSection'
import UpdateSection from './UpdateSection'
import './settings-modal.css'

export type SettingsSection = 'ai' | 'update' | 'diagnose'

const SECTIONS: Array<{
  key: SettingsSection
  label: string
  icon: IconName
  title: string
  subtitle: string
}> = [
  {
    key: 'ai',
    label: 'AI 接口',
    icon: 'settings',
    title: 'AI 接口',
    subtitle: '配置用于分析网站的 AI 模型。API Key 经系统安全存储加密后保存在本地，不会出现在界面与日志里。',
  },
  {
    key: 'update',
    label: '软件更新',
    icon: 'download',
    title: '软件更新',
    subtitle: '查看当前版本、手动检查，以及自动检查与后台下载的开关。',
  },
  {
    key: 'diagnose',
    label: '诊断与日志',
    icon: 'diagnose',
    title: '诊断与日志',
    subtitle: '把定位问题需要的信息导出成一个文件。内容分级，带什么、不带什么都摆在下面由你决定。',
  },
]

interface Props {
  open: boolean
  onClose: () => void
  /** 打开时定位到哪个板块 */
  section?: SettingsSection
}

/**
 * 设置面板：左栏分板块，右栏是内容。
 *
 * 板块会继续加（导出、快捷键等），一个弹窗一个板块的话入口会越堆越多，
 * 所以从一开始就做成可扩展的两栏面板，左下角菜单里的各项只决定进来时停在哪一栏。
 */
export default function SettingsModal({ open, onClose, section = 'ai' }: Props) {
  const [cur, setCur] = useState<SettingsSection>(section)

  // 每次打开都听调用方的：从「软件更新」进来就该停在更新那栏
  useEffect(() => {
    if (open) setCur(section)
  }, [open, section])

  const meta = SECTIONS.find((s) => s.key === cur) ?? SECTIONS[0]

  return (
    <Modal title="设置" open={open} onClose={onClose} width={880} height={560} chrome="panel">
      <div className="settings-panel">
        <nav className="settings-rail" aria-label="设置板块">
          <div className="rail-title">设置</div>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={cur === s.key ? 'on' : ''}
              aria-current={cur === s.key}
              onClick={() => setCur(s.key)}
            >
              <Icon name={s.icon} />
              <span className="grow">{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <div className="section-head">
            <h3>{meta.title}</h3>
            <div className="section-sub">{meta.subtitle}</div>
          </div>
          {cur === 'ai' && <AiSettingsPanel />}
          {cur === 'update' && <UpdateSection embedded />}
          {cur === 'diagnose' && <DiagnoseSection />}
        </div>
      </div>
    </Modal>
  )
}
