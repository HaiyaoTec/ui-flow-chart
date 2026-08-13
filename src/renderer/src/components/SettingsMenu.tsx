import { useEffect, useRef, useState } from 'react'
import Icon, { type IconName } from './Icon'
import Modal from './Modal'
import AiSettingsPanel from './AiSettingsPanel'
import UpdateSection from './UpdateSection'
import { useTheme, type Theme } from './useTheme'
import './settings-menu.css'

const THEMES: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: 'light', label: '浅色', icon: 'themeLight' },
  { value: 'dark', label: '深色', icon: 'themeDark' },
  { value: 'system', label: '跟随系统', icon: 'themeSystem' },
]

/**
 * 左下角的统一设置入口。
 *
 * 三项设置（主题、AI 接口、软件更新）都收在这里：主题项就地展开子菜单，
 * 另外两项内容太多，塞进菜单会挤，改为开弹窗。
 * 这样侧边栏导航只留「做事」的入口（项目、真机预览），配置类的都归到角落里。
 */
export default function SettingsMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<'' | 'theme'>('')
  const [modal, setModal] = useState<'' | 'ai' | 'update'>('')
  const boxRef = useRef<HTMLDivElement>(null)
  const [theme, pickTheme] = useTheme()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function close() {
    setOpen(false)
    setSub('')
  }

  const current = THEMES.find((t) => t.value === theme) ?? THEMES[2]

  return (
    <>
      <div className="settings-menu" ref={boxRef}>
        <button
          className={`settings-trigger${open ? ' open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="设置"
        >
          <Icon name="settings" />
          {!compact && (
            <>
              <span className="grow">设置</span>
              <Icon name="caretRight" size={15} className="caret" />
            </>
          )}
        </button>

        {open && (
          <div className="settings-pop" role="menu">
            {/* 主题：就地展开子菜单，选完直接生效，不必再确认 */}
            <button
              className={`row${sub === 'theme' ? ' on' : ''}`}
              onClick={() => setSub((v) => (v === 'theme' ? '' : 'theme'))}
              aria-haspopup="menu"
              aria-expanded={sub === 'theme'}
            >
              <Icon name={current.icon} />
              <span className="grow">主题</span>
              <span className="hint">{current.label}</span>
              <Icon name={sub === 'theme' ? 'caretDown' : 'caretRight'} size={14} />
            </button>
            {sub === 'theme' && (
              <div className="settings-sub" role="menu">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    role="menuitemradio"
                    aria-checked={theme === t.value}
                    className={theme === t.value ? 'row on' : 'row'}
                    onClick={() => void pickTheme(t.value)}
                  >
                    <Icon name={t.icon} />
                    <span className="grow">{t.label}</span>
                  </button>
                ))}
              </div>
            )}

            <button
              className="row"
              onClick={() => {
                setModal('ai')
                close()
              }}
            >
              <Icon name="settings" />
              <span className="grow">AI 接口</span>
              <Icon name="caretRight" size={14} />
            </button>

            <button
              className="row"
              onClick={() => {
                setModal('update')
                close()
              }}
            >
              <Icon name="download" />
              <span className="grow">软件更新</span>
              <Icon name="caretRight" size={14} />
            </button>
          </div>
        )}
      </div>

      <Modal
        title="AI 接口设置"
        subtitle="配置用于分析网站的 AI 模型。API Key 经系统安全存储加密后保存在本地，不会出现在界面与日志里。"
        open={modal === 'ai'}
        onClose={() => setModal('')}
        width={820}
      >
        <AiSettingsPanel />
      </Modal>

      <Modal title="软件更新" open={modal === 'update'} onClose={() => setModal('')} width={640}>
        <UpdateSection embedded />
      </Modal>
    </>
  )
}
