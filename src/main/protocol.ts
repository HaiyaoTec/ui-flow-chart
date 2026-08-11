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
