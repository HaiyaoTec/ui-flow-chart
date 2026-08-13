import { contextBridge, ipcRenderer } from 'electron'
import { CH, type EventChannel, type IpcEventMap, type IpcInvokeMap, type InvokeChannel } from '@shared/ipc-contract'

const EVENT_CHANNELS: EventChannel[] = [CH.evSession, CH.evGraphPatch, CH.evPreviewNav, CH.evWatchShot, CH.evUpdateState]

const api = {
  /**
   * 运行平台。
   *
   * 界面上有几处必须按平台分叉，且都发生在首屏之前（滚动条样式），
   * 走 IPC 拿会晚一帧，所以直接从预加载同步暴露。
   */
  platform: process.platform,
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
