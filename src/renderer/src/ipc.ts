import type { EventChannel, IpcEventMap, IpcInvokeMap, InvokeChannel } from '@shared/ipc-contract'

export function invoke<C extends InvokeChannel>(channel: C, payload?: IpcInvokeMap[C]['req']): Promise<IpcInvokeMap[C]['res']> {
  return window.api.invoke(channel, payload)
}

export function on<C extends EventChannel>(channel: C, handler: (payload: IpcEventMap[C]) => void): () => void {
  return window.api.on(channel, handler)
}
