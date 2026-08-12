import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DeviceSpec } from '@shared/types'
import StatusBar from './StatusBar'

interface Props {
  device: DeviceSpec
  /** 'fit' 为按可用空间自适应，数字为按真实比例呈现（塞不下就裁切） */
  zoom?: 'fit' | number
  /** 机身是否被裁切，用于上层调整周边留白与边缘处理 */
  onOverflowChange?: (overflow: boolean) => void
  /** 屏幕占位区的可见矩形变化时回调，主进程据此摆放 WebContentsView */
  onScreenRect: (rect: { x: number; y: number; width: number; height: number; scale: number }) => void
}

/** 状态栏高度占屏幕显示宽度的比例，取自真机（430 宽对约 50 高） */
const STATUS_RATIO = 0.115

/**
 * 外框装饰占掉的空间，按屏幕显示宽度的比例给出。
 *
 * 必须与 frameMetrics 的比例严格对应：早先这里写的是固定像素（18/34），
 * 实际装饰（状态栏 11.5% + 上下边框 4.4% + home 条 2.2% + 外圈 3.2%）远不止那么多，
 * 于是机身比容器高出一截，被 overflow:hidden 从上下两端切掉——
 * 表现就是手机顶部与底部各出现一条「异常的白边」，底部导航条被拦腰截断。
 */
const CHROME_RATIO = {
  mobile: { x: 0.076, y: 0.213 },
  tablet: { x: 0.076, y: 0.076 },
  desktop: { x: 0, y: 0 },
}
/**
 * 只算真正占布局的部分（不含外圈光晕——它是 box-shadow，不参与布局）。
 * 自适应取尺寸时用上面那份带光晕的比例，留出余量；
 * 判断「放不放得下」必须用这份，否则会把明明放得下的机身判成溢出，
 * 于是从居中变成靠左，看着像贴边了。
 */
const LAYOUT_RATIO = {
  mobile: { x: 0.044, y: 0.181 },
  tablet: { x: 0.044, y: 0.044 },
  desktop: { x: 0, y: 0 },
}
/** 桌面档的浏览器标题栏是固定高度 */
const DESKTOP_BAR = 30

/**
 * 按屏幕实际显示宽度算出外框各项尺寸。
 * 全部用比例而非固定像素——预览缩小时固定圆角会把手机啃成圆角矩形。
 * 比例参考真机后再收一档：圆角与边框都让位给网页显示面积。
 */
function frameMetrics(kind: 'mobile' | 'tablet' | 'desktop', w: number) {
  const radiusRatio = kind === 'mobile' ? 0.095 : kind === 'tablet' ? 0.028 : 0
  const bezel = kind === 'desktop' ? 0 : Math.max(3, Math.round(w * 0.022))
  const screenRadius = Math.round(w * radiusRatio)
  return {
    bezel,
    screenRadius,
    frameRadius: screenRadius + bezel,
    ring: Math.max(2, Math.round(w * 0.016)),
    notchW: Math.round(w * 0.29),
    notchH: Math.max(4, Math.round(w * 0.065)),
    homeW: Math.round(w * 0.35),
    btnW: Math.max(2, Math.round(w * 0.012)),
  }
}

/**
 * 设备外框。中间那块是纯占位——真正的网页由主进程的 WebContentsView 浮在其上，
 * 所以所有装饰只能画在四周，不能盖住屏幕区。
 *
 * 屏幕尺寸用 JS 按可用空间与设备宽高比算出来，不靠 CSS aspect-ratio：
 * 嵌套 flex 里 aspect-ratio 的解析结果不稳定，实测会被拉成容器宽度。
 */
export default function DeviceFrame({ device, zoom = 'fit', onScreenRect, onOverflowChange }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  /**
   * 两个方向分别记是否超出可用区。渲染期间读 ref 拿到的是上一帧尺寸，必须存成状态。
   * 分方向是因为对齐方式也要分方向：放得下的那一轴居中，放不下的那一轴靠起点，
   * 这样既不浪费空间，又能保住最该看见的顶部与左侧。
   */
  const [overflow, setOverflow] = useState({ x: false, y: false })
  const isPhone = device.kind === 'mobile'

  const measure = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    // 容器还没完成布局时 clientWidth/Height 是 0，此时算出来的是个假尺寸。
    // 一旦把它上报出去，主进程就会把原生视图摆到错误的小矩形上，
    // 表现为网页跑到设备外框之外。宁可先不报，等真实尺寸到位。
    if (box.clientWidth < 80 || box.clientHeight < 80) return
    const chrome = CHROME_RATIO[device.kind]
    const barH = device.kind === 'desktop' ? DESKTOP_BAR : 0
    const availW = box.clientWidth
    const availH = Math.max(60, box.clientHeight - barH)
    // 以设备宽高比为准，取能塞进可用区域的最大尺寸。
    // 装饰是按屏幕宽度等比的，所以要连同装饰一起解方程：
    // 宽向 w·(1+chrome.x) ≤ 可用宽；纵向 h + chrome.y·w ≤ 可用高。
    // 先算宽再减装饰的话，机身一定会撑出容器，然后被切掉边缘。
    const ratio = device.width / device.height
    let h = availH / (1 + chrome.y * ratio)
    let w = h * ratio
    const maxW = availW / (1 + chrome.x)
    if (w > maxW) {
      w = maxW
      h = w / ratio
    }
    // 指定了倍数就按真实比例呈现，哪怕比可用区大——超出的部分由上报矩形时裁掉，
    // 原生视图始终被限制在预览区内，不会盖到画布上
    if (typeof zoom === 'number') {
      w = device.width * zoom
      h = device.height * zoom
    }
    setSize({ width: Math.round(w), height: Math.round(h) })
    const layout = LAYOUT_RATIO[device.kind]
    setOverflow({
      x: w * (1 + layout.x) > box.clientWidth + 1,
      y: h + layout.y * w + barH > box.clientHeight + 1,
    })
  }, [device.kind, device.width, device.height, zoom])

  useEffect(() => onOverflowChange?.(overflow.x || overflow.y), [overflow.x, overflow.y, onOverflowChange])

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
      // 与舞台可见区求交：指定倍数时设备框可能比面板大，直接上报会让原生视图
      // 盖到画布和日志上。裁掉的部分就是看不见的部分，缩放本身不受影响。
      const stage = boxRef.current?.parentElement?.getBoundingClientRect()
      const left = Math.max(r.left, stage?.left ?? r.left)
      const top = Math.max(r.top, stage?.top ?? r.top)
      const right = Math.min(r.right, stage?.right ?? r.right)
      const bottom = Math.min(r.bottom, stage?.bottom ?? r.bottom)
      const rect = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
        // 缩放由渲染进程说了算：裁切后的矩形算不出正确的比例
        scale: size.width / device.width,
      }
      if (rect.width < 80 || rect.height < 80) return
      const key = `${rect.x},${rect.y},${rect.width},${rect.height},${rect.scale.toFixed(4)}`
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

  // 外框的圆角、边框、装饰都按屏幕实际显示宽度等比缩放。
  // 写死 46px 圆角的话，预览一缩小手机就被「啃」成了圆角矩形。
  // 比例参考真机：iPhone 屏幕圆角约为宽度的 13%，机身边框约 3%。
  const metrics = frameMetrics(device.kind, size.width)

  return (
    <div
      className="device-box"
      ref={boxRef}
      data-overflow-x={overflow.x ? '1' : undefined}
      data-overflow-y={overflow.y ? '1' : undefined}
    >
      <div
        className={`device-frame ${device.kind}`}
        style={
          {
            '--bezel': `${metrics.bezel}px`,
            '--screen-radius': `${metrics.screenRadius}px`,
            '--frame-radius': `${metrics.frameRadius}px`,
            '--ring': `${metrics.ring}px`,
            '--notch-w': `${metrics.notchW}px`,
            '--notch-h': `${metrics.notchH}px`,
            '--home-w': `${metrics.homeW}px`,
            '--btn-w': `${metrics.btnW}px`,
          } as React.CSSProperties
        }
      >
        {isPhone && (
          <>
            <div className="side-btn power" />
            <div className="side-btn vol-up" />
            <div className="side-btn vol-down" />
          </>
        )}
        {/* 状态栏连同灵动岛一起画在屏幕上方的独立条里——盖在屏幕上的话会被原生视图挡住 */}
        {isPhone && size.width > 0 && (
          <StatusBar
            width={size.width}
            height={Math.round(size.width * STATUS_RATIO)}
            radius={metrics.screenRadius}
            islandW={metrics.notchW}
            islandH={metrics.notchH}
          />
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
