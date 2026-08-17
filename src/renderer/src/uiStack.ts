import { CH } from '@shared/ipc-contract'
import { invoke } from './ipc'

/**
 * 「把界面提到网页之上」的持有计数。
 *
 * 预览网页由原生视图绘制，与界面同为窗口的子视图，谁在上由排序决定；
 * 自绘的弹层要盖住网页，就得把界面提上去。问题在于想提的不止一处——
 * 下拉、设备选择、弹窗都要提，而它们的生命周期互相交叠：
 * 谁都按「我关了就放回去」处理的话，下拉一关就会把仍然开着的弹窗压到网页底下。
 *
 * 所以只留一个出口：第一个持有者提上去，最后一个释放者放回来。
 */
let holders = 0

export function holdUiFront(): () => void {
  holders += 1
  if (holders === 1) void invoke(CH.uiStack, { front: 'ui' }).catch(() => undefined)
  let released = false
  return () => {
    // 同一个释放函数可能被调用两次（React 严格模式下的挂载—清理—再挂载），
    // 不设防的话计数会被扣穿，之后真正的持有者也压不住网页了
    if (released) return
    released = true
    holders -= 1
    if (holders === 0) void invoke(CH.uiStack, { front: 'preview' }).catch(() => undefined)
  }
}
