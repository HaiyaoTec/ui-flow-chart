import { useEffect, useRef, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import type { AppSettings } from '@shared/types'
import { invoke } from '../ipc'
import './theme-menu.css'

type Theme = AppSettings['theme']

const OPTIONS: Array<{ value: Theme; label: string; icon: string }> = [
  { value: 'light', label: '浅色', icon: '☀️' },
  { value: 'dark', label: '深色', icon: '🌙' },
  { value: 'system', label: '跟随系统', icon: '💻' },
]

/**
 * 主题切换。
 *
 * 实际生效靠主进程的 nativeTheme.themeSource——设了它，渲染进程的
 * prefers-color-scheme 会跟着变。这里只负责把系统当前的深浅态
 * 映射到 data-theme，以及让用户选。
 */
export default function ThemeMenu() {
  const [theme, setTheme] = useState<Theme>('system')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void invoke(CH.settingsGet).then((s) => setTheme(s.theme))
  }, [])

  // 无论是用户切换还是系统自己变，都以 prefers-color-scheme 为准落到 data-theme
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light')
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

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
      <button className="theme-trigger" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span className="icon emoji">{current.icon}</span>
        <span className="grow">{current.label}</span>
        <span className="caret">›</span>
      </button>

      {open && (
        <div className="theme-pop" role="menu">
          {OPTIONS.map((o) => (
            <button key={o.value} role="menuitemradio" aria-checked={theme === o.value} onClick={() => void pick(o.value)}>
              <span className="icon emoji">{o.icon}</span>
              <span className="grow">{o.label}</span>
              {theme === o.value && <span className="check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
