import { app, BrowserWindow, nativeTheme } from 'electron'
import { registerIpc } from './ipc/registry'
import { registerUfcProtocol, registerUfcSchemePrivileges } from './protocol'
import { getSettings } from './store/settings'
import { createMainWindow } from './window'

// 必须在 app ready 之前声明，之后再注册就晚了
registerUfcSchemePrivileges()

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
    registerUfcProtocol()
    // 启动就把上次选的主题装回去，避免开窗后闪一下再切
    nativeTheme.themeSource = getSettings().theme
    mainWindow = createMainWindow()
    registerIpc(() => mainWindow)

    if (process.env.UFC_SELFCHECK) {
      const { runSelfCheck } = await import('./selfcheck')
      await runSelfCheck(mainWindow, process.env.UFC_SELFCHECK)
      return
    }
    if (process.env.UFC_SELFCHECK_EXPLORE === '1') {
      const { runExploreCheck } = await import('./selfcheckExplore')
      await runExploreCheck(
        mainWindow,
        process.env.UFC_SITE ?? 'http://localhost:4183',
        process.env.UFC_AI ?? 'http://localhost:4190/v1'
      )
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
