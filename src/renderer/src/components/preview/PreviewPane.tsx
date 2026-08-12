import { useCallback, useEffect, useRef, useState } from 'react'
import { DEVICE_PRESETS, getDevice } from '@shared/devices'
import { CH, type NavState, type PreviewDiagnosis } from '@shared/ipc-contract'
import { invoke, on } from '../../ipc'
import Icon from '../Icon'
import DeviceFrame from './DeviceFrame'
import './preview.css'

interface Props {
  initialUrl?: string
  onDeviceChange?: (deviceId: string) => void
}

export default function PreviewPane({ initialUrl = '', onDeviceChange }: Props) {
  const [deviceId, setDeviceId] = useState(DEVICE_PRESETS[0].id)
  const [url, setUrl] = useState(initialUrl)
  const [nav, setNav] = useState<NavState | null>(null)
  const [busy, setBusy] = useState(false)
  const [diag, setDiag] = useState<PreviewDiagnosis | null>(null)
  const device = getDevice(deviceId)
  const lastRect = useRef('')

  useEffect(() => on(CH.evPreviewNav, setNav), [])

  // 组件卸载时隐藏原生视图，避免它盖在别的页面上
  useEffect(() => {
    void invoke(CH.previewSetVisible, { visible: true })
    return () => {
      void invoke(CH.previewSetVisible, { visible: false })
    }
  }, [])

  const onScreenRect = useCallback((rect: { x: number; y: number; width: number; height: number }) => {
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
    if (key === lastRect.current) return
    lastRect.current = key
    void invoke(CH.previewSetBounds, rect)
  }, [])

  async function go() {
    if (!url.trim()) return
    const target = /^https?:\/\//.test(url) ? url : `http://${url}`
    setUrl(target)
    setBusy(true)
    try {
      await invoke(CH.previewNavigate, { url: target })
    } finally {
      setBusy(false)
    }
  }

  async function diagnose() {
    setBusy(true)
    try {
      setDiag(await invoke(CH.previewDiagnose))
    } finally {
      setBusy(false)
    }
  }

  /** 模拟没生效时的一键纠正：重放 override 并重载 */
  async function heal() {
    setBusy(true)
    try {
      await invoke(CH.previewSetDevice, { deviceId })
      await new Promise((r) => setTimeout(r, 1500))
      setDiag(await invoke(CH.previewDiagnose))
    } finally {
      setBusy(false)
    }
  }

  async function changeDevice(id: string) {
    setDeviceId(id)
    onDeviceChange?.(id)
    setBusy(true)
    try {
      await invoke(CH.previewSetDevice, { deviceId: id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="preview-pane">
      <div className="preview-toolbar">
        <select value={deviceId} onChange={(e) => void changeDevice(e.target.value)} disabled={busy}>
          {DEVICE_PRESETS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {d.width}×{d.height}@{d.deviceScaleFactor}x
            </option>
          ))}
        </select>
        <input
          className="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void go()}
          placeholder="http://localhost:4173"
        />
        <button onClick={() => void go()} disabled={busy}>
          <Icon name="open" />
          打开
        </button>
        <button
          onClick={() => void invoke(CH.previewNavigate, { action: 'back' })}
          disabled={!nav?.canGoBack}
          title="后退"
        >
          <Icon name="back" />
        </button>
        <button onClick={() => void invoke(CH.previewNavigate, { action: 'reload' })} title="刷新">
          <Icon name="reload" />
        </button>
      </div>

      <div className="preview-stage">
        <DeviceFrame device={device} onScreenRect={onScreenRect} />
      </div>

      <div className="preview-meta">
        <span>
          {device.width}×{device.height} @{device.deviceScaleFactor}x · {device.hasTouch ? '触摸' : '鼠标'}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nav?.url || '(未导航)'}
        </span>
        <button className="link-btn" onClick={() => void diagnose()} disabled={busy}>
          <Icon name="diagnose" size={13} />
          自检
        </button>
      </div>

      {diag && (
        <div className={`preview-diag ${diag.ok ? 'ok' : 'bad'}`}>
          <div className="row">
            <strong>
              <Icon name={diag.ok ? 'takeoverEnd' : 'warn'} size={14} />
              {diag.ok ? '设备模拟正常' : '设备模拟未完全生效'}
            </strong>
            <span className="grow" />
            {!diag.ok && (
              <button onClick={() => void heal()} disabled={busy}>
                重放模拟并刷新
              </button>
            )}
            <button className="link-btn" onClick={() => setDiag(null)}>
              收起
            </button>
          </div>
          <div className="diag-grid">
            <span>设备</span>
            <span>
              {diag.deviceName} · {diag.deviceSize}
            </span>
            <span>视图 / 应为</span>
            <span className={diag.boundsMatch ? '' : 'bad-v'}>
              {diag.viewSize} / {diag.expectedViewSize}（缩放 {diag.scale}）
            </span>
            <span>页面视口</span>
            <span className={diag.pageInnerWidth === device.width ? '' : 'bad-v'}>
              innerWidth {diag.pageInnerWidth} · scrollWidth {diag.pageScrollWidth}
            </span>
            <span>UA 已生效</span>
            <span className={diag.uaApplied ? '' : 'bad-v'}>
              {diag.uaApplied ? '是' : '否'} · {diag.uaSample}
            </span>
            {diag.bodyClass && (
              <>
                <span>body class</span>
                <span>{diag.bodyClass}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
