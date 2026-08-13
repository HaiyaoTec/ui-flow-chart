import { join } from 'node:path'
import { app, BaseWindow, nativeTheme } from 'electron'
import { registerIpc } from './ipc/registry'
import { registerUfcProtocol, registerUfcSchemePrivileges } from './protocol'
import { getSettings, migrateSettings } from './store/settings'
import { updater } from './updater'
import { createMainWindow } from './window'

// 必须在 app ready 之前声明，之后再注册就晚了
registerUfcSchemePrivileges()

// 测试模式下把应用数据整体挪到临时目录：
// 否则自动化会改写用户真实的 settings.json 与 profiles.json
if (process.env.UFC_DATA_DIR) {
  app.setPath('userData', join(process.env.UFC_DATA_DIR, 'userData'))
} else if (!app.isPackaged) {
  // 开发模式的设置与密钥也要与安装版分开，否则两边会互相覆盖
  app.setPath('userData', `${app.getPath('userData')} (dev)`)
}

// 单实例：第二次启动时聚焦已有窗口。
// 自动化测试要能并行起多个实例，故在测试模式下跳过这道锁。
const singleInstance = process.env.UFC_TEST === '1' || app.requestSingleInstanceLock()

if (!singleInstance) {
  app.quit()
} else {
  let mainWindow: BaseWindow | null = null

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    registerUfcProtocol()
    // 启动就把上次选的主题装回去，避免开窗后闪一下再切
    // 先迁移本地数据，再读设置：跨版本升级后旧格式必须能被新代码读懂
    const migrateError = migrateSettings()
    if (migrateError) console.error('[migrate]', migrateError)
    nativeTheme.themeSource = getSettings().theme
    mainWindow = createMainWindow()
    registerIpc(() => mainWindow)
    void updater.start()

    if (process.env.UFC_EMULAB) {
      const { runEmulationLab } = await import('./emulation-lab')
      await runEmulationLab(mainWindow, process.env.UFC_EMULAB)
      return
    }

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
      if (BaseWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
