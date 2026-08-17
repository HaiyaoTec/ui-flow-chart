import { useEffect, useRef, type ReactNode } from 'react'
import { holdUiFront } from '../uiStack'
import './modal.css'

/**
 * 打开中的弹窗栈。
 *
 * 弹窗可以叠：创建项目时从「AI 配置」里跳去加配置，就是两层。
 * 每层都监听 Esc 的话一次按键会把两层一起关掉，所以只让栈顶那层响应。
 */
const openStack: symbol[] = []

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
}

/** Tab 焦点陷阱：弹窗是模态的，焦点跑到底下的界面上就成了「看得见按不着」 */
function trapTab(root: HTMLElement | null, e: KeyboardEvent): void {
  if (!root) return
  const list = focusables(root)
  if (list.length === 0) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

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
  const cardRef = useRef<HTMLDivElement>(null)

  /*
   * 弹窗打开期间把界面提到网页之上。
   *
   * 预览网页是原生视图，永远画在 HTML 之上；在真机预览页打开设置面板时，
   * 手机那一块会直接压在面板上，面板右半边被盖住看不全。
   */
  useEffect(() => {
    if (!open) return
    return holdUiFront()
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = idRef.current as symbol
    openStack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return
      if (e.key === 'Escape') return onClose()
      if (e.key === 'Tab') trapTab(cardRef.current, e)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = openStack.lastIndexOf(id)
      if (i >= 0) openStack.splice(i, 1)
    }
  }, [open, onClose])

  /*
   * 打开时把焦点移进来。
   *
   * 不移的话焦点还停在触发弹窗的那个后台按钮上：回车会把它再按一遍——
   * 删除项目那种场景就是又弹一次确认框，而先前那个 Promise 永远挂着。
   * 落点优先取标了 autoFocus 的元素，其次是第一个可聚焦控件。
   */
  useEffect(() => {
    if (!open) return
    const card = cardRef.current
    if (!card) return
    const prev = document.activeElement as HTMLElement | null
    // 表单里的 autoFocus 在提交阶段就生效了，比这里早，别把它抢走
    if (!card.contains(document.activeElement)) {
      const list = focusables(card)
      const target =
        card.querySelector<HTMLElement>('[data-autofocus]') ??
        // 关闭按钮排在最前，但它不该是默认落点
        list.find((el) => !el.classList.contains('modal-close')) ??
        list[0]
      target?.focus()
    }
    return () => prev?.focus?.()
  }, [open])

  if (!open) return null

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={cardRef}
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
