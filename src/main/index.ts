import { join } from 'node:path'
import { app, BaseWindow, nativeTheme } from 'electron'
import { preview } from './engine/previewManager'
import { sessions } from './engine/sessionManager'
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

  /**
   * 把预览与会话绑到当前窗口上。
   *
   * 每建一个窗口都要绑一次：macOS 上关窗不退出进程，从 Dock 再打开是新窗口，
   * 只在启动时绑一次的话，之后预览会挂在已销毁的窗口上——表现是打开项目后
   * 预览区永久空白、会话事件全丢，而且异常被吞掉，界面上看不出任何报错。
   */
  const bindWindow = (w: BaseWindow): void => {
    preview.bindWindow(w)
    sessions.bindWindow(w)
    w.once('closed', () => {
      preview.unbindWindow(w)
      sessions.unbindWindow(w)
      if (mainWindow === w) mainWindow = null
    })
  }

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
    bindWindow(mainWindow)
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

    // macOS：Dock 图标被点、且一个窗口都不剩时重新开窗
    app.on('activate', () => {
      if (BaseWindow.getAllWindows().length > 0) return
      mainWindow = createMainWindow()
      bindWindow(mainWindow)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
