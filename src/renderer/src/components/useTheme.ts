import { useEffect, useState } from 'react'
import { CH } from '@shared/ipc-contract'
import type { AppSettings } from '@shared/types'
import { invoke } from '../ipc'

export type Theme = AppSettings['theme']

/**
 * 主题的读写与生效。
 *
 * 生效判定放在渲染进程：实测主进程设了 nativeTheme.themeSource='dark'
 * （shouldUseDarkColors 也确实是 true），已创建窗口里的 prefers-color-scheme
 * 却纹丝不动。所以选了具体主题就直接用，只有「跟随系统」才去查媒体查询。
 */
export function useTheme(): [Theme, (t: Theme) => Promise<void>] {
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    void invoke(CH.settingsGet).then((s) => setTheme(s.theme))
  }, [])

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

  const pick = async (t: Theme): Promise<void> => {
    setTheme(t)
    await invoke(CH.themeSet, { theme: t })
  }

  return [theme, pick]
}
