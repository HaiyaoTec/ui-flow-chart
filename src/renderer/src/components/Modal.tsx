import { useEffect, useRef, type ReactNode } from 'react'
import './modal.css'

/**
 * 打开中的弹窗栈。
 *
 * 弹窗可以叠：创建项目时从「AI 配置」里跳去加配置，就是两层。
 * 每层都监听 Esc 的话一次按键会把两层一起关掉，所以只让栈顶那层响应。
 */
const openStack: symbol[] = []

interface Props {
  title: string
  subtitle?: string
  open: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  height?: number
  /**
   * panel：面板式弹窗，不画标题栏、正文不留内边距，由内容自己排版（设置面板的左栏要通到顶）。
   * 关闭按钮改为浮在右上角，title 仍用于无障碍标签。
   */
  chrome?: 'default' | 'panel'
}

export default function Modal({
  title,
  subtitle,
  open,
  onClose,
  children,
  footer,
  width = 640,
  height,
  chrome = 'default',
}: Props) {
  const idRef = useRef<symbol | null>(null)
  idRef.current ??= Symbol('modal')

  useEffect(() => {
    if (!open) return
    const id = idRef.current as symbol
    openStack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openStack[openStack.length - 1] === id) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = openStack.lastIndexOf(id)
      if (i >= 0) openStack.splice(i, 1)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${chrome === 'panel' ? ' modal-panel' : ''}`}
        style={{ width, height }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {chrome === 'default' ? (
          <>
            <div className="modal-head">
              <div>
                <h3>{title}</h3>
                {subtitle && <div className="modal-sub">{subtitle}</div>}
              </div>
              <button className="modal-close" onClick={onClose} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="modal-body">{children}</div>
          </>
        ) : (
          <>
            <button className="modal-close floating" onClick={onClose} aria-label="关闭">
              ✕
            </button>
            {children}
          </>
        )}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
