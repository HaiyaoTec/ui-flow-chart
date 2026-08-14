import './logo.css'

interface Props {
  size?: number
  /** 只要标记、不要字 */
  markOnly?: boolean
}

/**
 * 应用标识：F 字形标记 + 文字。
 *
 * 字形与应用图标（scripts/make-icon.mjs）一致，但配色反过来：图标那套是浅底绿笔，
 * 512px 下很清楚，缩到侧边栏的 22px 就成了一团浅色——笔画只剩 4px，
 * 浅绿压在浅灰底上几乎看不出形状。这里改成绿底白笔，小尺寸下对比度足够。
 * 用内联 SVG 而不是引 png：任何缩放与像素密度下都清晰。
 */
export default function Logo({ size = 24, markOnly = false }: Props) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden focusable="false">
        <defs>
          <linearGradient id="logoInk" x1="0.1" y1="0.1" x2="0.9" y2="0.9">
            <stop offset="0" stopColor="#3fd485" />
            <stop offset="1" stopColor="#0b8250" />
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="58" fill="url(#logoInk)" />
        {/* 小尺寸下笔画要更粗、留白要更足，否则三笔糊成一块 */}
        <g stroke="#ffffff" strokeWidth="40" strokeLinecap="round" fill="none">
          <path d="M92 70 L186 70" />
          <path d="M92 128 L166 128" />
          <path d="M92 70 L92 190" />
        </g>
      </svg>
      {!markOnly && <span className="logo-word">Flow Chart</span>}
    </span>
  )
}
