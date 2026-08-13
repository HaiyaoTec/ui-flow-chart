import { useEffect, useRef, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import type { AppSettings } from '@shared/types'
import { invoke } from '../ipc'
import Icon, { type IconName } from './Icon'
import './theme-menu.css'

type Theme = AppSettings['theme']

const OPTIONS: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: 'light', label: '浅色', icon: 'themeLight' },
  { value: 'dark', label: '深色', icon: 'themeDark' },
  { value: 'system', label: '跟随系统', icon: 'themeSystem' },
]

/**
 * 主题切换。
 *
 * 实际生效靠主进程的 nativeTheme.themeSource——设了它，渲染进程的
 * prefers-color-scheme 会跟着变。这里只负责把系统当前的深浅态
 * 映射到 data-theme，以及让用户选。
 */
export default function ThemeMenu({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>('system')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void invoke(CH.settingsGet).then((s) => setTheme(s.theme))
  }, [])

  /**
   * 主题由渲染进程自己判定。
   *
   * 实测：主进程设了 nativeTheme.themeSource='dark'（shouldUseDarkColors 也确实是 true），
   * 已经创建好的窗口里 prefers-color-scheme 却纹丝不动。所以不能把它当作唯一事实源——
   * 选了具体主题就直接用，只有「跟随系统」才去查媒体查询。
   */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'system' ? mq.matches : theme === 'dark'
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function pick(v: Theme) {
    setTheme(v)
    setOpen(false)
    await invoke(CH.themeSet, { theme: v })
  }

  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[2]

  return (
    <div className="theme-menu" ref={boxRef}>
      {/* 收起态只留图标，标签退到 title */}
      <button
        className="theme-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`主题：${current.label}`}
      >
        <Icon name={current.icon} />
        {!compact && (
          <>
            <span className="grow">{current.label}</span>
            <span className="caret">›</span>
          </>
        )}
      </button>

      {open && (
        <div className="theme-pop" role="menu">
          {OPTIONS.map((o) => (
            <button key={o.value} role="menuitemradio" aria-checked={theme === o.value} onClick={() => void pick(o.value)}>
              <Icon name={o.icon} />
              <span className="grow">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
