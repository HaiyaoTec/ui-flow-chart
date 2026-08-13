import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DialogProvider } from './components/Dialog'
import './theme.css'

// 平台标在根元素上：滚动条这类外观必须按平台分叉，而 CSS 里问不到平台。
// 要在首屏之前写好，否则会先按默认样式画一帧
document.documentElement.setAttribute('data-platform', window.api.platform)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </React.StrictMode>
)
