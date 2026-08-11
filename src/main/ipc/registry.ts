import { ipcMain, shell, type BrowserWindow } from 'electron'
import { CH, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc-contract'
import { createAiClient } from '../ai'
import { deleteProfile, listProfiles, saveProfile } from '../store/credentials'
import { getSettings, setSettings } from '../store/settings'

type Handler<C extends InvokeChannel> = (payload: IpcInvokeMap[C]['req']) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']

/** 统一注册，保证通道名与载荷类型都来自 ipc-contract */
function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, async (_e, payload) => fn(payload as IpcInvokeMap[C]['req']))
}

export function registerIpc(_getWindow: () => BrowserWindow | null): void {
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

  handle(CH.shellReveal, ({ path }) => {
    shell.showItemInFolder(path)
  })
}
