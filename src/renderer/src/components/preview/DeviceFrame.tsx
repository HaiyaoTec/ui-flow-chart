import { useEffect, useRef } from 'react'
import type { DeviceSpec } from '@shared/types'

interface Props {
  device: DeviceSpec
  /** 屏幕占位区的矩形变化时回调，主进程据此摆放 WebContentsView */
  onScreenRect: (rect: { x: number; y: number; width: number; height: number }) => void
}

/**
 * 设备外框。中间那块是纯占位——真正的网页由主进程的 WebContentsView 浮在其上，
 * 所以所有装饰只能画在四周，不能盖住屏幕区。
 */
export default function DeviceFrame({ device, onScreenRect }: Props) {
  const screenRef = useRef<HTMLDivElement>(null)
  const isPhone = device.kind === 'mobile'

  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      onScreenRect({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    // 布局变化后（如侧栏折叠）位置也会变，用滚动与动画帧兜一次
    const t = setTimeout(report, 150)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      clearTimeout(t)
    }
  }, [onScreenRect, device.id])

  return (
    <div className={`device-frame ${device.kind}`}>
      {isPhone && (
        <>
          <div className="notch" />
          <div className="side-btn power" />
          <div className="side-btn vol-up" />
          <div className="side-btn vol-down" />
        </>
      )}
      {device.kind === 'desktop' && (
        <div className="browser-bar">
          <span className="dot r" />
          <span className="dot y" />
          <span className="dot g" />
        </div>
      )}
      <div className="screen" ref={screenRef} />
      {isPhone && <div className="home-bar" />}
    </div>
  )
}
