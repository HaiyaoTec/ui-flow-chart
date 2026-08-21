import type { AiAction, ProbeResult } from '@shared/types'

/**
 * 探索期的机械命名。
 *
 * 节点的标题、泳道、连线标注在探索期由这里确定性生成，画布即时可见；
 * 规范的语义命名由图谱生成阶段批量补齐并替换。机械结果的价值是「永远有、
 * 永远与页面对得上」，模型不可用时图谱照样成立。
 */

/** 界面的占位标题：优先页面标题，其次正文开头 */
export function placeholderTitle(probe: ProbeResult): string {
  const head = probe.text.split(' ').slice(0, 8).join(' ').trim()
  const base = (probe.title || '').trim() || head || probe.url
  const prefix = probe.hasDialog ? '弹窗·' : ''
  return `${prefix}${base}`.slice(0, 60)
}

/**
 * 界面的机械泳道：地址路径的首段。
 *
 * 只是让探索期的画布有可读的分区，不承担语义正确性——
 * 图谱生成阶段的泳道划分会整体重排。
 */
export function laneOfUrl(url: string): { id: string; title: string } {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? ''
    const id = seg
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return id ? { id, title: id } : { id: 'entry', title: '入口' }
  } catch {
    return { id: 'entry', title: '入口' }
  }
}

/** 动作执行成功后的机械连线标注，标在「当前屏 → 下一屏」的转移上 */
export function mechanicalEdgeLabel(action: AiAction, targetText?: string): string {
  switch (action.action) {
    case 'click':
      return targetText ? `点击「${targetText.slice(0, 30)}」` : '点击'
    case 'fill':
      return targetText ? `输入「${targetText.slice(0, 30)}」` : '输入'
    case 'scroll':
      return '滚动'
    case 'back':
      return '关闭返回'
    default:
      return ''
  }
}
