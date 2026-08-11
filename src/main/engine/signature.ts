import { createHash } from 'node:crypto'
import type { ProbeResult } from '@shared/types'

/**
 * 界面签名：判定两次探针看到的是不是同一个界面。
 * 只取结构性特征，不含随机内容（榜单数字、倒计时等），否则同一界面会被反复判为新界面。
 */
export function signatureOf(p: ProbeResult): string {
  const parts = [
    stripVolatile(p.url),
    p.hasDialog ? 'dlg' : '-',
    p.dialogClass,
    p.elements.map((e) => `${e.tag}:${e.type}:${e.name}:${e.placeholder}:${normalizeText(e.text)}:${e.checked ?? ''}`).join('|'),
    p.notices.map(normalizeText).join('|'),
    normalizeText(p.text.slice(0, 400)),
  ]
  return parts.join('')
}

export function signatureHash(p: ProbeResult): string {
  return createHash('sha1').update(signatureOf(p)).digest('hex').slice(0, 16)
}

/** 去掉数字与时间，避免倒计时、金额、榜单刷新导致签名抖动 */
function normalizeText(s: string): string {
  return s
    .replace(/\d+([.,:]\d+)*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 去掉易变的查询参数与 hash */
function stripVolatile(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}
