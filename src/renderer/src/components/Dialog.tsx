import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import Modal from './Modal'

interface ConfirmOptions {
  title: string
  /** 正文，允许多行 */
  message: string
  confirmText?: string
  cancelText?: string
  /** 危险操作用红色主按钮 */
  danger?: boolean
}

interface DialogApi {
  confirm: (o: ConfirmOptions) => Promise<boolean>
  alert: (o: Omit<ConfirmOptions, 'danger' | 'cancelText'>) => Promise<void>
}

const Ctx = createContext<DialogApi | null>(null)

/**
 * 应用内的确认/提示弹窗。
 *
 * 不用 window.confirm / window.alert：那是 Chromium 画的系统对话框，
 * 字体、圆角、按钮排布都跟应用无关，深色主题下尤其突兀——它永远是浅色的。
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<(ConfirmOptions & { kind: 'confirm' | 'alert' }) | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const close = useCallback((ok: boolean) => {
    setOpts(null)
    resolver.current?.(ok)
    resolver.current = null
  }, [])

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (o) =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve
          setOpts({ ...o, kind: 'confirm' })
        }),
      alert: (o) =>
        new Promise<void>((resolve) => {
          resolver.current = () => resolve()
          setOpts({ ...o, kind: 'alert' })
        }),
    }),
    []
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <Modal
        title={opts?.title ?? ''}
        open={Boolean(opts)}
        onClose={() => close(false)}
        width={440}
        footer={
          <>
            <span className="grow" />
            {/* 默认落点给安全的那个按钮：破坏性操作聚焦「取消」，回车不该直接把东西删掉 */}
            {opts?.kind === 'confirm' && (
              <button data-autofocus={opts?.danger ? '' : undefined} onClick={() => close(false)}>
                {opts?.cancelText ?? '取消'}
              </button>
            )}
            <button
              className={opts?.danger ? 'danger-solid' : 'primary'}
              data-autofocus={opts?.danger ? undefined : ''}
              onClick={() => close(true)}
            >
              {opts?.confirmText ?? '确定'}
            </button>
          </>
        }
      >
        <div className="dialog-msg">{opts?.message}</div>
      </Modal>
    </Ctx.Provider>
  )
}

export function useDialog(): DialogApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useDialog 必须在 DialogProvider 内使用')
  return api
}
