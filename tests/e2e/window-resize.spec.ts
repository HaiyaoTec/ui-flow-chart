import { expect, test } from '@playwright/test'
import { ipc, launchApp } from './helpers'

/**
 * 窗口缩放后界面视图必须铺满内容区。
 *
 * 界面现在是窗口的子视图（BaseWindow + WebContentsView），不再自动跟随窗口尺寸。
 * 只要它比内容区小一圈，边缘就会露出底色——用户看到的就是右侧或下方的黑边。
 */
test('缩放窗口后界面视图始终铺满内容区', async () => {
  const { app, window } = await launchApp()
  try {
    const read = () =>
      ipc<{ view: { width: number; height: number }; content: { width: number; height: number } } | null>(
        window,
        'test:ui-view-bounds'
      )

    /*
     * 最底层必须垫着一块纯色底板。
     *
     * BaseWindow 自己没有内容，setBackgroundColor 只存值、没有图层去画；
     * 拖动边框时新露出的区域会显出窗口的黑底。底板是不含 WebContents 的 View，
     * 由合成器直接画，不存在「等渲染进程出帧」，所以那条区域才是主题色。
     */
    const stack = await app.evaluate(({ BaseWindow }) => {
      const kids = BaseWindow.getAllWindows()[0].contentView.children
      return { kinds: kids.map((v) => v.constructor.name), first: kids[0]?.getBounds() }
    })
    expect(stack.kinds[0], '最底层应当是纯色底板 View').toBe('View')
    expect(stack.first!.width, '底板要留足冗余，拖拽期间不必跟着改尺寸').toBeGreaterThan(4000)

    for (const d of [
      { dw: 180, dh: 0 },
      { dw: 0, dh: 140 },
      { dw: -120, dh: -90 },
      { dw: 60, dh: 60 },
    ]) {
      await ipc(window, 'test:resize-window', d)
      await window.waitForTimeout(600)
      const r = await read()
      expect(r, '拿不到界面视图的尺寸').not.toBeNull()
      expect(r!.view.width, `宽度未铺满：视图 ${r!.view.width} / 内容区 ${r!.content.width}`).toBe(r!.content.width)
      expect(r!.view.height, `高度未铺满：视图 ${r!.view.height} / 内容区 ${r!.content.height}`).toBe(r!.content.height)
    }
  } finally {
    await app.close()
  }
})
