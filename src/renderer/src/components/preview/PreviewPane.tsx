import { useCallback, useEffect, useRef, useState } from 'react'
import { DEVICE_PRESETS, getDevice } from '@shared/devices'
import { CH, type NavState, type PreviewDiagnosis } from '@shared/ipc-contract'
import { invoke, on } from '../../ipc'
import DevicePicker from '../DevicePicker'
import Icon from '../Icon'
import Select from '../Select'
import DeviceFrame from './DeviceFrame'
import './preview.css'

/** 缩放档位。指定倍数塞不下时会自动回落到自适应，所以列表可以给到 200% */
const ZOOM_OPTIONS = [
  { value: 'fit', label: '自适应' },
  { value: '2', label: '200%' },
  { value: '1.5', label: '150%' },
  { value: '1.25', label: '125%' },
  { value: '1', label: '100%' },
  { value: '0.75', label: '75%' },
  { value: '0.5', label: '50%' },
]

interface Props {
  initialUrl?: string
  /** 项目指定的设备。工作台里预览归项目所有，下拉框要显示项目真正在用的那台 */
  deviceId?: string
  /** 外部要求暂时藏起原生视图（例如正在拖动分栏） */
  suppressed?: boolean
  onDeviceChange?: (deviceId: string) => void
}

export default function PreviewPane({
  initialUrl = '',
  deviceId: boundDeviceId,
  suppressed = false,
  onDeviceChange,
}: Props) {
  const [deviceId, setDeviceId] = useState(boundDeviceId ?? DEVICE_PRESETS[0].id)
  const [url, setUrl] = useState(initialUrl)
  const [editingUrl, setEditingUrl] = useState(false)
  const [nav, setNav] = useState<NavState | null>(null)
  const [busy, setBusy] = useState(false)
  const [diag, setDiag] = useState<PreviewDiagnosis | null>(null)
  const [open, setOpen] = useState(() => localStorage.getItem('ufc.previewOpen') !== '0')
  const [zoom, setZoom] = useState<'fit' | number>(() => {
    const v = localStorage.getItem('ufc.previewZoom')
    return v && v !== 'fit' ? Number(v) : 'fit'
  })
  /** 屏幕占位区的实际显示宽度，用来算缩放比例 */
  const [shownWidth, setShownWidth] = useState(0)
  /** 机身是否被裁切 */
  const [cropped, setCropped] = useState(false)
  /** 催促 DeviceFrame 重报矩形的计数器 */
  const [reportNonce, setReportNonce] = useState(0)
  /** 原生视图当前是否被藏起来（藏起时屏幕区要给句说明，否则纯黑像是坏了） */
  const [viewHidden, setViewHidden] = useState(false)
  const [switching, setSwitching] = useState(false)
  /** 视图藏起时顶上的静帧 */
  const [frozen, setFrozen] = useState('')
  const device = getDevice(deviceId)
  const lastRect = useRef('')
  const alive = useRef(true)
  // onScreenRect 是稳定回调，取当前设备只能走 ref
  const deviceIdRef = useRef(deviceId)
  deviceIdRef.current = deviceId

  useEffect(
    () =>
      on(CH.evPreviewNav, (s) => {
        setNav(s)
        // 主进程刚重建过视图，它在等新矩形才肯显示。矩形可能一模一样、不会自然重报，
        // 这里主动催一次，免得白等兜底超时
        setReportNonce((n) => n + 1)
      }),
    []
  )

  /**
   * 地址栏跟随真实导航状态，与浏览器一致。
   *
   * 之前它只在挂载时取一次 initialUrl，切换项目时组件不会重新挂载，
   * 于是原生视图已经打开了新项目的网址，输入框还停在上一个项目的地址上。
   * 改为镜像 nav.url 后，切换项目、页面内跳转、后退都能自动跟上；
   * 用户正在输入时不覆盖，免得把人打断。
   */
  useEffect(() => {
    if (!editingUrl && nav?.url && nav.url !== 'about:blank') setUrl(nav.url)
  }, [nav?.url, editingUrl])

  // 项目换了设备，下拉框要跟着换。主进程在 project:open 时已经按项目设备打开了
  // 预览，这里只做显示同步，不再重复下发，否则会白白重载一次页面
  useEffect(() => {
    if (boundDeviceId) setDeviceId(boundDeviceId)
  }, [boundDeviceId])

  // 组件卸载时隐藏原生视图，避免它盖在别的页面上。
  // alive 必须在这里置回 true：StrictMode 下 effect 会「挂载→清理→再挂载」，
  // 只在清理里置 false 的话，第二次挂载后守卫永远是关的，视图再也藏不掉
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      void invoke(CH.previewSetVisible, { visible: false })
    }
  }, [])

  /**
   * 可见性只有一个出口：本区块展开、且外部没有要求暂时藏起来。
   *
   * 拖动分栏时必须藏：原生视图的位置要经 IPC 才更新，拖动过程中它会带着旧的
   * 宽度停留几帧，看起来就是网页越界压到了左边的画布上。
   */
  useEffect(() => {
    showView(open && !suppressed)
  }, [open, suppressed])

  /**
   * 卸载后不许再改原生视图的可见性。
   *
   * 设备下拉展开时会临时把视图藏起来（自绘弹层挡不住原生视图），
   * 关闭时再显示回来。但离开工作台是「父组件先清理、子组件后清理」，
   * 子组件那次"关闭弹层"的回调会在本组件收尾之后才到，
   * 把已经藏好的视图又亮出来——表现就是项目列表上多出一块白色色块。
   */
  /**
   * 切换原生视图的可见性。
   *
   * 藏起来之前先抓一张静帧顶上：视图一藏，露出的就是设备的黑屏底色，
   * 看着像预览崩了。有了静帧，观感是「画面定住」，弹层关掉又接着动。
   */
  const showView = (visible: boolean, snapshot = false) => {
    if (!alive.current) return
    if (visible) setFrozen('')
    setViewHidden(!visible)
    // 只有「会停留一会儿、且用户正盯着设备」的场景才抓静帧：抓图要一两百毫秒，
    // 拖动分栏、缩放窗口这类必须立刻隐藏的场景不能等它，否则拖影照样出现
    void invoke(CH.previewSetVisible, { visible, withSnapshot: !visible && snapshot })
      .then((r) => {
        if (alive.current && !visible && r.image) setFrozen(r.image)
      })
      .catch(() => undefined)
  }

  const onScreenRect = useCallback(
    (rect: { x: number; y: number; width: number; height: number; scale: number }) => {
      // 显示比例取自 scale 而不是裁切后的宽度，否则放大到超出面板时会算小
      setShownWidth(rect.scale * getDevice(deviceIdRef.current).width)
      const key = `${rect.x},${rect.y},${rect.width},${rect.height},${rect.scale.toFixed(4)}`
      if (key === lastRect.current) return
      lastRect.current = key
      void invoke(CH.previewSetBounds, rect)
    },
    []
  )

  function pickZoom(v: string) {
    const next = v === 'fit' ? 'fit' : Number(v)
    setZoom(next)
    localStorage.setItem('ufc.previewZoom', v)
  }

  /** 收起后原生视图必须一起藏起来，否则它会浮在下面的日志上（由上面的 effect 统一处理） */
  function toggleOpen(next: boolean) {
    setOpen(next)
    localStorage.setItem('ufc.previewOpen', next ? '1' : '0')
  }

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

  // 缩放＝屏幕实际显示宽度 ÷ 设备逻辑宽度，与主进程下发给 CDP 的 scale 同源
  const actual = shownWidth > 0 ? shownWidth / device.width : 0
  const zoomText = actual > 0 ? `${Math.round(actual * 100)}%` : ''

  /**
   * 换设备要重放全部 override 并重新加载，中间页面必然是空的。
   * 与其让用户盯着一片纯黑，不如先把视图藏起来、给句说明，加载完再显示。
   */
  async function changeDevice(id: string) {
    setDeviceId(id)
    onDeviceChange?.(id)
    setBusy(true)
    setSwitching(true)
    showView(false, true)
    try {
      await invoke(CH.previewSetDevice, { deviceId: id })
    } finally {
      setBusy(false)
      setSwitching(false)
      showView(open && !suppressed)
    }
  }

  return (
    <div className={`preview-pane${open ? '' : ' collapsed'}`}>
      {/* 与「探索日志」同一套：标题条即开关，右侧是缩放控制 */}
      <div className="pv-head">
        <button className="pv-head-toggle" onClick={() => toggleOpen(!open)} title={open ? '收起模拟设备' : '展开模拟设备'}>
          <Icon name={open ? 'caretDown' : 'caretUp'} size={14} />
          <span className="pv-head-title">模拟设备</span>
        </button>
        {open && (
          <>
            <Select
              className="zoom-select"
              value={String(zoom)}
              onChange={(v) => pickZoom(v)}
              options={ZOOM_OPTIONS.map((o) => ({
                value: o.value,
                label: o.value === 'fit' ? `自适应${zoomText ? ` ${zoomText}` : ''}` : o.label,
              }))}
              overlay
            />
          </>
        )}
      </div>

      <div className="preview-toolbar">
        <DevicePicker
          className="device-select"
          value={deviceId}
          disabled={busy}
          onChange={(id) => void changeDevice(id)}
          // 弹层压在原生视图上，展开期间把界面视图提到最上层
          overlay
        />
        <input
          className="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onFocus={() => setEditingUrl(true)}
          onBlur={() => setEditingUrl(false)}
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

      {/* 裁切状态只用于不参与布局的表现，不能反过来改变可用空间 */}
      <div className="preview-stage">
        <DeviceFrame
          device={device}
          zoom={zoom}
          onScreenRect={onScreenRect}
          onOverflowChange={setCropped}
          reportNonce={reportNonce}
          frozen={viewHidden ? frozen : ''}
          hint={viewHidden && !frozen ? (switching ? '正在切换设备…' : '预览已暂时隐藏') : ''}
        />
      </div>

      <div className={`preview-meta${cropped ? ' cropped' : ''}`}>
        <span>
          {device.width}×{device.height} @{device.deviceScaleFactor}x · {device.hasTouch ? '触摸' : '鼠标'}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nav?.url || '(未导航)'}
        </span>
        <button className="link-btn" onClick={() => void diagnose()} disabled={busy}>
          <Icon name="diagnose" size={13} />
          设备信息
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
