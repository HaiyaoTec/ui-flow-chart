import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import './select.css'

export interface SelectOption {
  value: string
  label: string
  /** 次要说明，显示在标签右侧 */
  hint?: string
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
  /** 弹层开合时通知外部。预览区要靠它临时隐藏原生视图，否则弹层会被盖住 */
  onOpenChange?: (open: boolean) => void
}

/**
 * 全局统一的下拉组件。
 *
 * 不用原生 select：它的选项列表由系统绘制，方角、系统蓝高亮，
 * 与项目切换器、主题菜单那套弹层对不上，深色主题下尤其突兀。
 *
 * 弹层挂到 body 上并用 fixed 定位——预览工具栏是 overflow:hidden，
 * 弹窗表单也有自己的滚动容器，挂在原位会被裁掉。
 */
export default function Select({
  value,
  options,
  onChange,
  disabled,
  placeholder = '请选择',
  className,
  onOpenChange,
}: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; drop: 'down' | 'up' } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)

  const current = options.find((o) => o.value === value)

  function toggle(next: boolean) {
    if (disabled) return
    openRef.current = next
    setOpen(next)
    onOpenChange?.(next)
    if (next) setActive(Math.max(0, options.findIndex((o) => o.value === value)))
  }

  function pick(v: string) {
    toggle(false)
    if (v !== value) onChange(v)
  }

  // 定位：优先向下展开，下方放不开就翻到上方
  useLayoutEffect(() => {
    if (!open) return setRect(null)
    const measure = () => {
      const el = triggerRef.current
      if (!el) return
      const b = el.getBoundingClientRect()
      const wanted = Math.min(options.length * 38 + 10, 320)
      const below = window.innerHeight - b.bottom - 8
      const drop = below < wanted && b.top > below ? 'up' : 'down'
      // 触发器可能被挤得很窄（预览工具栏），弹层得给选项留出可读宽度
      const width = Math.min(Math.max(b.width, 260), window.innerWidth - 16)
      // 靠右的触发器要改成右对齐，否则弹层会顶出窗口
      const left = Math.min(Math.max(8, b.left), window.innerWidth - width - 8)
      setRect({
        left,
        top: drop === 'down' ? b.bottom + 5 : b.top - 5,
        width,
        drop,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) toggle(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return toggle(false)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const o = options[active]
        if (o) pick(o.value)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, active, options])

  // 卸载时若弹层还开着，得补一次「已关闭」，否则外部（原生视图）会一直藏着。
  // 但没开过就绝不通知——那会在离开页面时把该藏的东西又亮出来
  useEffect(
    () => () => {
      if (openRef.current) onOpenChange?.(false)
    },
    []
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ufc-select${open ? ' open' : ''} ${className ?? ''}`}
        onClick={() => toggle(!open)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="val">{current?.label ?? placeholder}</span>
        {current?.hint && <span className="hint">{current.hint}</span>}
        <Icon name="caretDown" size={15} className="caret" />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            className="ufc-select-pop"
            role="listbox"
            style={{
              left: rect.left,
              width: rect.width,
              ...(rect.drop === 'down'
                ? { top: rect.top, maxHeight: `calc(100vh - ${rect.top + 10}px)` }
                : { bottom: window.innerHeight - rect.top, maxHeight: `${rect.top - 10}px` }),
            }}
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`${o.value === value ? 'on' : ''}${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                <span className="val">{o.label}</span>
                {o.hint && <span className="hint">{o.hint}</span>}
                {o.value === value && <span className="check">✓</span>}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
