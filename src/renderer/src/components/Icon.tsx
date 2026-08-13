import {
  ArrowLeft,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Download,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  List,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Settings,
  Smartphone,
  Sparkles,
  Square,
  Waypoints,
  Sun,
  Trash2,
  type LucideIcon,
} from 'lucide-react'

/**
 * 图标统一走 Lucide（ISC 许可）。
 *
 * 选 SVG 组件而不是图标字体：字体要经 font-src 加载、有闪烁，
 * 而内联 SVG 用 currentColor 直接跟随主题色，离线可用，也不受 CSP 限制。
 * 这里做一层语义化映射，用意图命名而不是图形命名，换图标集时只改这一处。
 */
const ICONS = {
  projects: FolderOpen,
  preview: Smartphone,
  settings: Settings,
  device: Smartphone,
  screens: ImageIcon,
  /** 步数代表流程里走过的连接，用连接线图标比脚印贴切 */
  steps: Waypoints,
  aiCalls: Sparkles,
  delete: Trash2,
  viewCard: LayoutGrid,
  viewList: List,
  back: ArrowLeft,
  start: Play,
  pause: Pause,
  resume: Play,
  stop: Square,
  takeover: Hand,
  takeoverEnd: CheckCheck,
  exportHtml: FileText,
  exportPng: ImageIcon,
  open: Globe,
  reload: RotateCw,
  /** 设备信息：读的是当前模拟状态，不是「体检」，用信息图标更贴切 */
  diagnose: Info,
  warn: CircleAlert,
  themeLight: Sun,
  themeDark: Moon,
  themeSystem: Monitor,
  caretDown: ChevronDown,
  caretRight: ChevronRight,
  caretUp: ChevronUp,
  collapse: PanelLeftClose,
  expand: PanelLeftOpen,
  add: Plus,
  download: Download,
  edit: Pencil,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

interface Props {
  name: IconName
  size?: number
  className?: string
}

export default function Icon({ name, size = 15, className }: Props) {
  const Cmp = ICONS[name]
  return <Cmp size={size} strokeWidth={2} className={`icon ${className ?? ''}`} aria-hidden focusable={false} />
}
