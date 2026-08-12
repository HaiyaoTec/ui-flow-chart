import { useEffect, useState } from 'react'

interface Props {
  url: string
  size?: number
}

/**
 * 走主进程代取，不让渲染进程直连外网——
 * 渲染进程的 CSP 只允许 self/data/ufc，为了图标放开 https 不划算。
 */
function faviconUrl(url: string): string | null {
  try {
    return `ufc://favicon/${encodeURIComponent(new URL(url).origin)}`
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 由域名派生一个稳定的色相，保证同一站点每次都是同一个颜色 */
function hueOf(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  return h
}

/**
 * 项目标识：优先用目标站的 favicon，一眼认出是哪个站。
 * 取不到（本地测试站、站点没放 favicon、离线）时退回域名首字母色块，
 * 不留空洞也不刷屏报错。
 */
export default function SiteIcon({ url, size = 22 }: Props) {
  const [failed, setFailed] = useState(false)
  const src = faviconUrl(url)
  const host = hostOf(url)

  // 换项目时重置失败态，否则上一个站的失败会带到下一个
  useEffect(() => setFailed(false), [url])

  const style = { width: size, height: size, borderRadius: Math.round(size * 0.25) }

  if (!src || failed) {
    const hue = hueOf(host)
    return (
      <span
        className="site-icon fallback"
        style={{ ...style, background: `hsl(${hue} 55% 45%)`, fontSize: Math.round(size * 0.5) }}
        title={host}
      >
        {host.replace(/^www\./, '').charAt(0).toUpperCase() || '?'}
      </span>
    )
  }

  return (
    <img
      className="site-icon"
      style={style}
      src={src}
      alt=""
      title={host}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
