import { contextBridge, ipcRenderer } from 'electron'
import { CH, type EventChannel, type IpcEventMap, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc-contract'

const EVENT_CHANNELS: EventChannel[] = [CH.evSession, CH.evGraphPatch, CH.evPreviewNav, CH.evWatchShot]

const api = {
  invoke<C extends InvokeChannel>(channel: C, payload?: IpcInvokeMap[C]['req']): Promise<IpcInvokeMap[C]['res']> {
    return ipcRenderer.invoke(channel, payload)
  },
  on<C extends EventChannel>(channel: C, handler: (payload: IpcEventMap[C]) => void): () => void {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`未注册的事件通道: ${channel}`)
    const listener = (_e: unknown, payload: IpcEventMap[C]) => handler(payload)
    ipcRenderer.on(channel, listener as never)
    return () => ipcRenderer.removeListener(channel, listener as never)
  },
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
