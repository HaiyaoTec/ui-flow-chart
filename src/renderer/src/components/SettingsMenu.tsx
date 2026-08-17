import { useEffect, useRef, useState } from 'react'
import Icon, { type IconName } from './Icon'
import SettingsModal, { type SettingsSection } from './SettingsModal'
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
 * 主题就地向右展开子菜单，选完直接生效；AI 接口与软件更新内容多，
 * 进的是同一个两栏设置面板，菜单项只决定进去停在哪一栏。
 * 这样侧边栏导航只留「做事」的入口（项目、真机预览），配置类的都归到角落里。
 */
export default function SettingsMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<'' | 'theme'>('')
  const [panel, setPanel] = useState<SettingsSection | ''>('')
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
            {/* 主题：向右展开子菜单，选完直接生效，不必再确认 */}
            <div className="settings-item" onMouseEnter={() => setSub('theme')}>
              <button
                className={`row${sub === 'theme' ? ' on' : ''}`}
                onClick={() => setSub('theme')}
                aria-haspopup="menu"
                aria-expanded={sub === 'theme'}
              >
                <Icon name={current.icon} />
                <span className="grow">主题</span>
                <span className="hint">{current.label}</span>
                <Icon name="caretRight" size={14} />
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
                      {theme === t.value && <Icon name="check" size={14} className="tick" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 指到别的项就收起子菜单——菜单与触发项之间留了间隙，
                靠移入其他项来关闭比靠移出来关闭稳，斜着走过去不会中途消失 */}
            <button
              className="row"
              onMouseEnter={() => setSub('')}
              onClick={() => {
                setPanel('ai')
                close()
              }}
            >
              <Icon name="settings" />
              <span className="grow">AI 接口</span>
              <Icon name="caretRight" size={14} />
            </button>

            <button
              className="row"
              onMouseEnter={() => setSub('')}
              onClick={() => {
                setPanel('update')
                close()
              }}
            >
              <Icon name="download" />
              <span className="grow">软件更新</span>
              <Icon name="caretRight" size={14} />
            </button>

            <button
              className="row"
              onMouseEnter={() => setSub('')}
              onClick={() => {
                setPanel('diagnose')
                close()
              }}
            >
              <Icon name="diagnose" />
              <span className="grow">诊断与日志</span>
              <Icon name="caretRight" size={14} />
            </button>
          </div>
        )}
      </div>

      <SettingsModal open={panel !== ''} section={panel || 'ai'} onClose={() => setPanel('')} />
    </>
  )
}
