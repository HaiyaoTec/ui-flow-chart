import { ipcMain, shell, type BrowserWindow } from 'electron'
import { CH, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc-contract'
import { getDevice } from '@shared/devices'
import { createAiClient } from '../ai'
import { preview } from '../engine/previewManager'
import { deleteProfile, listProfiles, saveProfile } from '../store/credentials'
import { getSettings, setSettings } from '../store/settings'

type Handler<C extends InvokeChannel> = (payload: IpcInvokeMap[C]['req']) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']

/** 统一注册，保证通道名与载荷类型都来自 ipc-contract */
function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, async (_e, payload) => fn(payload as IpcInvokeMap[C]['req']))
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (win) preview.bindWindow(win)

  handle(CH.settingsGet, () => getSettings())
  handle(CH.settingsSet, (patch) => setSettings(patch))

  handle(CH.aiProfilesList, () => listProfiles())
  handle(CH.aiProfileSave, ({ profile, apiKey }) => saveProfile(profile, apiKey))
  handle(CH.aiProfileDelete, ({ id }) => {
    deleteProfile(id)
  })
  handle(CH.aiTest, async ({ profileId }) => {
    try {
      return await createAiClient(profileId).testConnection()
    } catch (e) {
      return { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle(CH.previewSetBounds, (b) => preview.setPaneBounds(b))
  handle(CH.previewSetVisible, ({ visible }) => preview.setVisible(visible))
  handle(CH.previewSetDevice, ({ deviceId, custom }) => preview.setDevice(getDevice(deviceId, custom)))
  handle(CH.previewNavigate, (input) => preview.navigate(input))
  handle(CH.previewProbe, () => preview.driver.probe())

  handle(CH.shellReveal, ({ path }) => {
    shell.showItemInFolder(path)
  })

  registerTestHooks()
}

/**
 * 测试专用通道，只有设置 UFC_TEST=1 才注册。
 * 用于在自动化里读取预览页内部状态、模拟人工点击，生产运行时完全不存在。
 */
function registerTestHooks(): void {
  if (process.env.UFC_TEST !== '1') return

  ipcMain.handle('test:eval-preview', async (_e, script: string) =>
    preview.driver.attached ? preview.driver.evalInPage(script) : null
  )
  ipcMain.handle('test:tap', async (_e, p: { x: number; y: number }) => {
    await preview.driver.tap(p.x, p.y)
  })
  ipcMain.handle('test:fill', async (_e, p: { x: number; y: number; text: string }) => {
    await preview.driver.fillAt(p.x, p.y, p.text)
  })
  ipcMain.handle('test:screenshot', async () => {
    const shot = await preview.driver.screenshot()
    return { pngBytes: shot.png.length, jpegBase64Length: shot.jpegBase64.length }
  })
  ipcMain.handle('test:probe', async () => preview.driver.probe())
  ipcMain.handle('test:wait-stable', async () => preview.driver.waitStable())
}
