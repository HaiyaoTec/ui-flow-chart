import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEVICE_CATEGORIES, devicesByCategory, getDevice } from '@shared/devices'
import { CH } from '@shared/ipc-contract'
import type { DeviceCategory } from '@shared/types'
import { invoke } from '../ipc'
import Icon from './Icon'
import './device-picker.css'

interface Props {
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  className?: string
  /** 压在原生预览视图上时，展开期间要把界面视图提到最上层（同 Select） */
  overlay?: boolean
}

/**
 * 设备选择器：左栏分类、右栏机型。
 *
 * 预设有四十来条，平铺成一个长下拉要滚很久也难找；按 iPhone / Android / PC 端 / 平板
 * 分两级之后，常用机型都在两步之内。分类停留即展开，不用先点一下再点一下。
 */
export default function DevicePicker({ value, onChange, disabled, className, overlay = false }: Props) {
  const [open, setOpen] = useState(false)
  const [cat, setCat] = useState<DeviceCategory>('iphone')
  const [rect, setRect] = useState<{ left: number; top: number; drop: 'down' | 'up' } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const current = getDevice(value)
  const list = devicesByCategory(cat)

  function toggle(next: boolean) {
    if (disabled) return
    setOpen(next)
    if (overlay) void invoke(CH.uiStack, { front: next ? 'ui' : 'preview' })
    // 每次展开都从当前设备所在的分类开始，而不是上次翻到哪儿
    if (next) setCat(current.category ?? 'iphone')
  }

  function pick(id: string) {
    toggle(false)
    if (id !== value) onChange(id)
  }

  // 定位：优先向下展开，下方放不开就翻到上方；靠右时右对齐
  useLayoutEffect(() => {
    if (!open) return setRect(null)
    const measure = () => {
      const el = triggerRef.current
      if (!el) return
      const b = el.getBoundingClientRect()
      const below = window.innerHeight - b.bottom - 8
      const drop = below < POP_H && b.top > below ? 'up' : 'down'
      const left = Math.min(Math.max(8, b.left), window.innerWidth - POP_W - 8)
      setRect({ left, top: drop === 'down' ? b.bottom + 5 : b.top - 5, drop })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) toggle(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && toggle(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ufc-select${open ? ' open' : ''} ${className ?? ''}`}
        onClick={() => toggle(!open)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="val">{current.name}</span>
        <span className="hint">{`${current.width}×${current.height}`}</span>
        <Icon name="caretDown" size={15} className="caret" />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            className="device-pop"
            role="menu"
            style={{
              left: rect.left,
              ...(rect.drop === 'down' ? { top: rect.top } : { bottom: window.innerHeight - rect.top }),
            }}
          >
            <div className="cats" role="menu">
              {DEVICE_CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={cat === c.key ? 'on' : ''}
                  onMouseEnter={() => setCat(c.key)}
                  onClick={() => setCat(c.key)}
                  aria-haspopup="menu"
                  aria-expanded={cat === c.key}
                >
                  <span className="val">{c.label}</span>
                  <Icon name="caretRight" size={14} />
                </button>
              ))}
            </div>
            <div className="models" role="menu">
              {list.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={d.id === current.id}
                  className={d.id === current.id ? 'on' : ''}
                  onClick={() => pick(d.id)}
                >
                  {d.id === current.id ? <Icon name="check" size={14} className="tick" /> : <span className="tick" />}
                  <span className="val">{d.name}</span>
                  <span className="hint">{`${d.width} × ${d.height}`}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

/** 弹层尺寸写死，翻转判断要在渲染前就算出来 */
const POP_W = 460
const POP_H = 360
