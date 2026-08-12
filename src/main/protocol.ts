import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { protocol } from 'electron'
import { projectDir } from './store/paths'

export const UFC_SCHEME = 'ufc'

/** 必须在 app ready 之前调用 */
export function registerUfcSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: UFC_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
    },
  ])
}

/**
 * ufc://screens/<projectId>/<file>
 * 截图不走 IPC 传 base64，改用自定义协议直接给 <img src> 用，
 * 既不放开 webSecurity，也避免把几百 KB 的图在进程间来回搬。
 */
export function registerUfcProtocol(): void {
  protocol.handle(UFC_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host === 'favicon') return serveFavicon(url)
      if (url.host !== 'screens') return new Response('not found', { status: 404 })

      const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean)
      if (parts.length !== 2) return new Response('bad path', { status: 400 })
      const [projectId, file] = parts
      if (normalize(file).includes('..')) return new Response('forbidden', { status: 403 })

      const abs = join(projectDir(projectId), 'screens', file)
      if (!existsSync(abs)) return new Response('not found', { status: 404 })

      const buf = await readFile(abs)
      const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
      return new Response(buf, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } })
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })
}

/** 站点图标的内存缓存。null 表示这个站取不到，别反复去撞 */
const faviconCache = new Map<string, { body: Buffer; type: string } | null>()

/**
 * ufc://favicon/<encodeURIComponent(origin)>
 *
 * 由主进程代取站点图标，而不是让渲染进程直连外网：
 * 渲染进程的 CSP 只允许 self/data/ufc，放开 https 等于给它开了任意远程图片，
 * 既扩大攻击面也带来指纹追踪风险。这里代取顺带做缓存与超时。
 */
async function serveFavicon(url: URL): Promise<Response> {
  const origin = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^https?:\/\//.test(origin)) return new Response('bad origin', { status: 400 })

  if (faviconCache.has(origin)) {
    const hit = faviconCache.get(origin)
    if (!hit) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(hit.body), {
      headers: { 'Content-Type': hit.type, 'Cache-Control': 'max-age=86400' },
    })
  }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(new URL('/favicon.ico', origin), { signal: ctrl.signal }).finally(() =>
      clearTimeout(timer)
    )
    if (!res.ok) throw new Error(String(res.status))
    const type = res.headers.get('content-type') ?? 'image/x-icon'
    if (!type.startsWith('image/')) throw new Error('not an image')
    const body = Buffer.from(await res.arrayBuffer())
    if (!body.length) throw new Error('empty')

    faviconCache.set(origin, { body, type })
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400' },
    })
  } catch {
    // 取不到就记下来，渲染侧会退回首字母色块
    faviconCache.set(origin, null)
    return new Response('not found', { status: 404 })
  }
}
