import { useCallback, useEffect, useRef, useState } from 'react'

interface View {
  k: number
  x: number
  y: number
}

/**
 * 画布平移缩放。
 * transform 直接写 DOM，不走 React 状态——拖拽时每帧 setState 会掉帧。
 * 仅把缩放比例同步回 React 供工具栏显示。
 */
export function usePanZoom(stageRef: React.RefObject<HTMLDivElement | null>, worldRef: React.RefObject<HTMLDivElement | null>) {
  const view = useRef<View>({ k: 1, x: 40, y: 68 })
  const [zoom, setZoom] = useState(1)
  const spaceDown = useRef(false)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; id: number } | null>(null)

  const apply = useCallback(() => {
    const w = worldRef.current
    if (!w) return
    const { k, x, y } = view.current
    w.style.transform = `translate(${x}px,${y}px) scale(${k})`
    setZoom(k)
  }, [worldRef])

  const zoomAt = useCallback(
    (cx: number, cy: number, nk: number) => {
      const v = view.current
      const k = Math.max(0.05, Math.min(4, nk))
      v.x = cx - ((cx - v.x) * k) / v.k
      v.y = cy - ((cy - v.y) * k) / v.k
      v.k = k
      apply()
    },
    [apply]
  )

  const fit = useCallback(
    (worldW: number, worldH: number) => {
      const stage = stageRef.current
      if (!stage) return
      const pad = 64
      const k = Math.min((stage.clientWidth - pad * 2) / worldW, (stage.clientHeight - pad * 2) / worldH)
      view.current = { k, x: (stage.clientWidth - worldW * k) / 2, y: (stage.clientHeight - worldH * k) / 2 }
      apply()
    },
    [apply, stageRef]
  )

  const fitWidth = useCallback(
    (worldW: number) => {
      const stage = stageRef.current
      if (!stage) return
      const pad = 40
      const k = Math.max(0.42, Math.min(1, (stage.clientWidth - pad * 2) / worldW))
      view.current = { k, x: pad, y: 68 }
      apply()
    },
    [apply, stageRef]
  )

  const reset = useCallback(() => {
    view.current = { k: 1, x: 40, y: 80 }
    apply()
  }, [apply])

  /** 把某个节点移到视野中央 */
  const focusNode = useCallback(
    (el: HTMLElement, targetK?: number) => {
      const stage = stageRef.current
      if (!stage) return
      const k = targetK ?? Math.min(2, Math.max(view.current.k, 0.6))
      view.current = {
        k,
        x: stage.clientWidth / 2 - (el.offsetLeft + el.offsetWidth / 2) * k,
        y: stage.clientHeight / 2 - (el.offsetTop + el.offsetHeight / 2) * k,
      }
      apply()
    },
    [apply, stageRef]
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, view.current.k * Math.exp(-e.deltaY * 0.0016))
    }
    const onDragStart = (e: Event) => e.preventDefault()

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return
      const target = e.target as HTMLElement
      if (target.closest('a')) return
      // 开启「可选文本」后，在卡片文字上按下交给浏览器做选择；中键与空格仍强制平移
      if (document.body.classList.contains('ufc-selectable') && e.button === 0 && !spaceDown.current && target.closest('.ufc-head'))
        return
      e.preventDefault()
      drag.current = { sx: e.clientX, sy: e.clientY, ox: view.current.x, oy: view.current.y, id: e.pointerId }
      stage.classList.add('grabbing')
      try {
        stage.setPointerCapture(e.pointerId)
      } catch {
        /* 某些情况下捕获会失败，忽略即可 */
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.id) return
      view.current.x = d.ox + (e.clientX - d.sx)
      view.current.y = d.oy + (e.clientY - d.sy)
      apply()
    }
    const endDrag = () => {
      if (drag.current) {
        try {
          stage.releasePointerCapture(drag.current.id)
        } catch {
          /* 忽略 */
        }
      }
      drag.current = null
      stage.classList.remove('grabbing')
    }
    /*
     * 空格是画布的平移修饰键，但监听挂在 window 上，输入框里的空格也会冒泡上来。
     * 不判来源就 preventDefault 的话，工作台里的地址栏、AI 配置弹窗都打不出空格，
     * 复选框的空格切换也一并失效。
     */
    const editable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null
      return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName))
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || editable(e.target)) return
      spaceDown.current = true
      e.preventDefault()
    }
    // 抬起一律清位：按下时在画布、松开时焦点已经跑到输入框的话，
    // 加了同样的守卫就会把 spaceDown 永久留在 true
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceDown.current = false
    }

    stage.addEventListener('wheel', onWheel, { passive: false })
    stage.addEventListener('dragstart', onDragStart)
    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointermove', onPointerMove)
    stage.addEventListener('pointerup', endDrag)
    stage.addEventListener('pointercancel', endDrag)
    stage.addEventListener('lostpointercapture', endDrag)
    window.addEventListener('blur', endDrag)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('dragstart', onDragStart)
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointermove', onPointerMove)
      stage.removeEventListener('pointerup', endDrag)
      stage.removeEventListener('pointercancel', endDrag)
      stage.removeEventListener('lostpointercapture', endDrag)
      window.removeEventListener('blur', endDrag)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [apply, stageRef, zoomAt])

  return { zoom, apply, zoomAt, fit, fitWidth, reset, focusNode, view }
}
