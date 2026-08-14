import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DialogProvider } from './components/Dialog'
import './theme.css'

// 平台标在根元素上：滚动条这类外观必须按平台分叉，而 CSS 里问不到平台。
// 要在首屏之前写好，否则会先按默认样式画一帧
document.documentElement.setAttribute('data-platform', window.api.platform)

/*
 * 第一次按 Tab 之前不画焦点圈。
 *
 * 冷启动时 Chromium 会把焦点自动落到第一个可聚焦元素上（侧边栏的收起按钮），
 * 并且因为「不是鼠标点出来的」判定为 focus-visible，于是应用一打开就挂着一枚
 * 焦点圈，焦点不挪走就一直在，点一下它反倒像是点出来的。
 * 试过挂载后 blur 掉，但自动聚焦发生在 React 首次渲染之后，时机对不上；
 * 用标记位更稳：键盘用户按下的第一个 Tab 就把圈打开，鼠标用户始终看不到。
 */
const markKeyboard = (e: KeyboardEvent): void => {
  if (e.key !== 'Tab') return
  document.documentElement.setAttribute('data-kb', '')
  window.removeEventListener('keydown', markKeyboard)
}
window.addEventListener('keydown', markKeyboard)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </React.StrictMode>
)
