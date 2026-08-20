import type { SessionState } from '@shared/types'

/** 会话状态的中文名。项目列表与工作台共用，避免两处各写一套 */
export const STATE_LABEL: Record<SessionState, string> = {
  idle: '空闲',
  launching: '启动中',
  observing: '观察界面',
  thinking: 'AI 决策中',
  acting: '执行操作',
  paused: '已暂停',
  human_queued: '排队等待接管',
  awaiting_human: '等待人工',
  resuming: '恢复中',
  finishing: '收尾中',
  finished: '已完成',
  failed: '已中断',
}
