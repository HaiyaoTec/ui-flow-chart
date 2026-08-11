import { app, BrowserWindow } from 'electron'
import { registerIpc } from './ipc/registry'
import { createMainWindow } from './window'

// 单实例：第二次启动时聚焦已有窗口。
// 自动化测试要能并行起多个实例，故在测试模式下跳过这道锁。
const singleInstance = process.env.UFC_TEST === '1' || app.requestSingleInstanceLock()

if (!singleInstance) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    mainWindow = createMainWindow()
    registerIpc(() => mainWindow)

    if (process.env.UFC_SELFCHECK) {
      const { runSelfCheck } = await import('./selfcheck')
      await runSelfCheck(mainWindow, process.env.UFC_SELFCHECK)
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
