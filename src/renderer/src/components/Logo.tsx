import './logo.css'

interface Props {
  size?: number
  /** 只要标记、不要字，侧边栏收起时用 */
  markOnly?: boolean
}

/**
 * 应用标识：F 字形标记 + 文字。
 *
 * 几何与应用图标（scripts/make-icon.mjs）同源——粗圆角笔画、斜向渐变、
 * 两笔交叠处提亮。这里用内联 SVG 而不是引 png：任何缩放与像素密度下都清晰，
 * 也不必为一个 22px 的标记多发一次请求。
 */
export default function Logo({ size = 24, markOnly = false }: Props) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden focusable="false">
        <defs>
          <linearGradient id="logoInk" x1="0.1" y1="0.1" x2="0.9" y2="0.9">
            <stop offset="0" stopColor="#4ae08c" />
            <stop offset="1" stopColor="#0e935c" />
          </linearGradient>
          <mask id="logoStem">
            <rect width="256" height="256" fill="black" />
            <path d="M84 62 L84 198" stroke="white" strokeWidth="46" strokeLinecap="round" fill="none" />
          </mask>
        </defs>
        <rect width="256" height="256" rx="58" fill="var(--panel-2)" />
        <g stroke="url(#logoInk)" strokeWidth="46" strokeLinecap="round" fill="none">
          <path d="M84 62 L194 62" />
          <path d="M84 126 L172 126" />
          <path d="M84 62 L84 198" />
        </g>
        {/* 交叠提亮：只在竖干范围内重画两道横 */}
        <g mask="url(#logoStem)" stroke="#9df7c4" strokeWidth="46" strokeLinecap="round" fill="none">
          <path d="M84 62 L194 62" />
          <path d="M84 126 L172 126" />
        </g>
      </svg>
      {!markOnly && <span className="logo-word">Flow Chart</span>}
    </span>
  )
}
