import { join } from 'node:path'
import { app, BaseWindow, nativeTheme } from 'electron'
import { preview } from './engine/previewManager'
import { sessions } from './engine/sessionManager'
import { registerIpc } from './ipc/registry'
import { log } from './log'
import { registerUfcProtocol, registerUfcSchemePrivileges } from './protocol'
import { getSettings, migrateSettings } from './store/settings'
import { updater } from './updater'
import { createMainWindow } from './window'

/*
 * 异常钩子必须排在所有初始化之前。
 *
 * 早先主进程一个兜底都没有：ready 之前抛错、或者哪个 void 出去的 Promise
 * 被拒绝，应用就静默停在原地，磁盘上一行记录都没有——而用户能给的只有截图。
 * 这两条不接管流程，只负责留痕，随后照旧交给默认行为。
 */
process.on('uncaughtException', (e) => {
  log.fatal('main', '未捕获的异常', e)
})
process.on('unhandledRejection', (e) => {
  log.fatal('main', '未处理的 Promise 拒绝', e)
})

// 必须在 app ready 之前声明，之后再注册就晚了
registerUfcSchemePrivileges()

// 测试模式下把应用数据整体挪到临时目录：
// 否则自动化会改写用户真实的 settings.json 与 profiles.json
if (process.env.UFC_DATA_DIR) {
  app.setPath('userData', join(process.env.UFC_DATA_DIR, 'userData'))
  // 日志目录要一并挪走。macOS 的 logs 默认在 ~/Library/Logs 下，
  // 不跟随 userData，不显式指定的话自动化会往用户真实日志目录里写
  app.setPath('logs', join(process.env.UFC_DATA_DIR, 'logs'))
} else if (!app.isPackaged) {
  // 开发模式的设置与密钥也要与安装版分开，否则两边会互相覆盖
  app.setPath('userData', `${app.getPath('userData')} (dev)`)
  app.setPath('logs', join(app.getPath('userData'), 'logs'))
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

  /*
   * 子进程非正常退出。
   *
   * 预览页崩溃另有专门的自愈路径（见 PageDriver），这里兜的是别的：
   * GPU 进程、工具进程、以及界面视图自己。它们挂掉时应用往往还"活着"，
   * 只是某一块不动了，不留痕的话事后完全无从判断。
   */
  app.on('child-process-gone', (_e, d) => {
    log.error('main', `子进程退出：type=${d.type} reason=${d.reason} exitCode=${d.exitCode}`)
  })

  void app.whenReady().then(async () => {
    log.info('main', `启动 ${app.getVersion()} · ${process.platform}-${process.arch} · Electron ${process.versions.electron}`)
    registerUfcProtocol()
    // 启动就把上次选的主题装回去，避免开窗后闪一下再切
    // 先迁移本地数据，再读设置：跨版本升级后旧格式必须能被新代码读懂
    const migrateError = migrateSettings()
    if (migrateError) log.error('migrate', migrateError)
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

  // 退出前把缓冲里的日志写出去，否则最后几行——往往正是出问题那几行——会丢
  app.on('before-quit', () => log.flush())
}
