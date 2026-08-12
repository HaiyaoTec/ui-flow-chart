import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DeviceSpec } from '@shared/types'

interface Props {
  device: DeviceSpec
  /** 屏幕占位区的矩形变化时回调，主进程据此摆放 WebContentsView */
  onScreenRect: (rect: { x: number; y: number; width: number; height: number }) => void
}

/** 外框装饰占掉的空间：左右内边距、上下内边距 + 底部 home 条 */
const CHROME = {
  mobile: { x: 24, y: 38 },
  tablet: { x: 32, y: 32 },
  desktop: { x: 0, y: 30 },
}

/**
 * 设备外框。中间那块是纯占位——真正的网页由主进程的 WebContentsView 浮在其上，
 * 所以所有装饰只能画在四周，不能盖住屏幕区。
 *
 * 屏幕尺寸用 JS 按可用空间与设备宽高比算出来，不靠 CSS aspect-ratio：
 * 嵌套 flex 里 aspect-ratio 的解析结果不稳定，实测会被拉成容器宽度。
 */
export default function DeviceFrame({ device, onScreenRect }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const isPhone = device.kind === 'mobile'

  const measure = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    // 容器还没完成布局时 clientWidth/Height 是 0，此时算出来的是个假尺寸。
    // 一旦把它上报出去，主进程就会把原生视图摆到错误的小矩形上，
    // 表现为网页跑到设备外框之外。宁可先不报，等真实尺寸到位。
    if (box.clientWidth < 80 || box.clientHeight < 80) return
    const chrome = CHROME[device.kind]
    const availW = Math.max(60, box.clientWidth - chrome.x)
    const availH = Math.max(60, box.clientHeight - chrome.y)
    // 以设备宽高比为准，取能塞进可用区域的最大尺寸
    const ratio = device.width / device.height
    let h = availH
    let w = h * ratio
    if (w > availW) {
      w = availW
      h = w / ratio
    }
    setSize({ width: Math.round(w), height: Math.round(h) })
  }, [device.kind, device.width, device.height])

  useLayoutEffect(() => {
    measure()
    const box = boxRef.current
    if (!box) return
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [measure])

  /**
   * 把屏幕占位区的视口矩形上报给主进程。
   *
   * 关键点：原生视图是按窗口坐标摆放的，所以**位置**变化和尺寸变化一样要上报。
   * 而 ResizeObserver 只在尺寸变化时触发——右侧面板是固定宽度列，窗口变宽时
   * 它只平移不改尺寸，观察器一声不吭，视图就会留在原地，看起来像是错位。
   * 因此除了尺寸观察，还要盯着位置变化。
   */
  useEffect(() => {
    const el = screenRef.current
    if (!el || size.width === 0) return

    let last = ''
    const report = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 80 || r.height < 80) return
      const rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
      if (key === last) return
      last = key
      onScreenRect(rect)
    }

    report()
    const raf = requestAnimationFrame(report)
    window.addEventListener('resize', report)
    // 低频兜底：面板平移、侧栏折叠、滚动等都不会触发 ResizeObserver，
    // 这里只在矩形真的变了才发 IPC，代价可以忽略
    const timer = window.setInterval(report, 200)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', report)
      window.clearInterval(timer)
    }
  }, [size, onScreenRect, device.id])

  return (
    <div className="device-box" ref={boxRef}>
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
          <div className="browser-bar" style={{ width: size.width }}>
            <span className="dot r" />
            <span className="dot y" />
            <span className="dot g" />
          </div>
        )}
        <div className="screen" ref={screenRef} style={{ width: size.width, height: size.height }} />
        {isPhone && <div className="home-bar" />}
      </div>
    </div>
  )
}
