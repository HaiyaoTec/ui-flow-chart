import { Component, type ErrorInfo, type ReactNode } from 'react'
import { CH } from '@shared/ipc-contract'
import { invoke } from '../ipc'
import './error-boundary.css'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  stack: string
}

/**
 * 界面崩溃的兜底。
 *
 * React 组件一抛错，整棵树会被卸载——用户看到的是纯色空白页，
 * 而主进程完全无感：探索照常在跑、记录照常在写，回头查什么都正常。
 * 在「用户只能发截图」的场景里，白屏是最难查的一类报障。
 *
 * 这里做两件事：把错误连同组件栈回传主进程落盘；给用户一个能看懂、
 * 能自救的界面，而不是一片空白。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? '' })
    void invoke(CH.diagnoseClientError, {
      source: '界面渲染出错',
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    }).catch(() => undefined)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <div className="crash-box">
          <h1>界面出错了</h1>
          <p>
            探索本身在主进程里运行，不受影响。重新加载界面即可继续；
            如果反复出现，请到「设置 → 诊断与日志」导出诊断包反馈。
          </p>
          <pre className="crash-detail mono">{`${error.name}: ${error.message}`}</pre>
          <div className="crash-acts">
            <button className="btn primary" onClick={() => window.location.reload()}>
              重新加载界面
            </button>
          </div>
        </div>
      </div>
    )
  }
}
