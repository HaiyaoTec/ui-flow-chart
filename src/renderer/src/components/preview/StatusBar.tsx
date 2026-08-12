import { useEffect, useState } from 'react'

interface Props {
  /** 状态栏宽度＝屏幕显示宽度 */
  width: number
  height: number
  /** 屏幕圆角，状态栏顶部两角要与机身对齐 */
  radius: number
  /** 灵动岛/刘海的尺寸 */
  islandW: number
  islandH: number
}

/**
 * iPhone 样式状态栏。
 *
 * 只能画在屏幕区之外：网页是主进程的 WebContentsView，属于原生层，
 * 永远盖在渲染进程的 HTML 之上，叠上去的状态栏根本看不见。
 * 因此外框在屏幕上方专门留出这一条，网页视口仍是完整的设备高度。
 */
export default function StatusBar({ width, height, radius, islandW, islandH }: Props) {
  const [time, setTime] = useState(() => clock())

  useEffect(() => {
    const t = window.setInterval(() => setTime(clock()), 20000)
    return () => window.clearInterval(t)
  }, [])

  // 真机上状态栏图标只有条高的三成左右，之前按 0.42 画得偏大
  const icon = Math.round(height * 0.3)

  return (
    <div
      className="status-bar"
      style={{ width, height, borderRadius: `${radius}px ${radius}px 0 0`, paddingInline: Math.round(width * 0.07) }}
    >
      <span className="sb-time" style={{ fontSize: Math.round(height * 0.34) }}>
        {time}
      </span>

      <span className="sb-island" style={{ width: islandW, height: islandH }} />

      <span className="sb-icons" style={{ gap: Math.round(height * 0.11) }}>
        {/* 信号：四格递增 */}
        <svg width={icon * 1.25} height={icon} viewBox="0 0 20 16" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={i * 5} y={12 - i * 4} width="3.4" height={4 + i * 4} rx="1.1" fill="currentColor" />
          ))}
        </svg>
        {/* Wi-Fi：三段弧 + 圆点 */}
        <svg width={icon * 1.15} height={icon} viewBox="0 0 18 16" fill="none" aria-hidden>
          <path d="M1 5.6a12 12 0 0 1 16 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M4.2 9a7.6 7.6 0 0 1 9.6 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="9" cy="12.6" r="1.7" fill="currentColor" />
        </svg>
        {/* 电量 */}
        <svg width={icon * 2} height={icon} viewBox="0 0 26 13" aria-hidden>
          <rect x="0.7" y="0.7" width="21" height="11.6" rx="3.4" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.2" />
          <rect x="2.4" y="2.4" width="15.5" height="8.2" rx="2" fill="currentColor" />
          <path d="M23.4 4.6v4a2.6 2.6 0 0 0 0-4Z" fill="currentColor" fillOpacity="0.5" />
        </svg>
      </span>
    </div>
  )
}

/** iOS 用 12 小时制且不补零 */
function clock(): string {
  const d = new Date()
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}`
}
