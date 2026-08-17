import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiagnoseOptions, DiagnoseResult } from '@shared/ipc-contract'
import type { FlowGraph } from '@shared/types'
import { appInfo } from './appInfo'
import { preview } from './engine/previewManager'
import { sessions } from './engine/sessionManager'
import { log, stripPaths } from './log'
import { appDataDir, projectDir, readJson } from './store/paths'
import { getProject } from './store/projects'
import { getSettings } from './store/settings'
import { updater } from './updater'

/**
 * 诊断包。
 *
 * 应用是打包分发出去的，用户机器上出了问题，作者能拿到的只有截图。这里把
 * 定位一个缺陷真正需要的材料一次性收齐，让用户导出一个文件发回来。
 *
 * 三条约束决定了它的形态：
 *
 * 1. **不含任何图像。** 存档图是设备视口 × 像素比的 PNG（iPhone 档 1170×2532，
 *    单张 1–3 MB），跑满一个项目就是几百 MB，而常见的反馈渠道附件上限只有
 *    二十几 MB，用户根本发不出去。默认只带缩略图，且只带最近若干张。
 *    这一刀同时砍掉了最大的体积问题与最大的隐私面。
 * 2. **分级，而且用户看得见。** 脱敏与可复现天生冲突：剥掉目标地址就无法重放。
 *    所以不替用户做决定——基础级不含目标站的任何内容，复现级带上地址与界面标题，
 *    由用户自己勾，并把「包含了什么、排除了什么」原样写进包里。
 * 3. **凭证与登录态永不外带。** 密钥密文、会话分区、原始截图属于绝对排除项，
 *    任何级别都不出现。
 */

/** 主日志带多少：够覆盖一次探索的全过程，又不至于把包撑大 */
const LOG_TAIL_BYTES = 256 * 1024
/** 会话记录带多少条，从最新往回取 */
const MAX_RECORDS = 4000
/** 接管期控件事件带多少条 */
const MAX_EVENTS = 1000
/** 缩略图最多带几张 */
const MAX_SHOTS = 12

/** 只留 host。完整地址常带 token、订单号、手机号这类东西 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * 日志正文的脱敏。
 *
 * 三处都是实测踩出来的：
 * - AI 填表动作会把填进去的值写进日志文本
 * - AI 上游返回非预期内容时，错误对象里带着响应体的前两三百字符，
 *   第三方中转网关的错误体常含账号 id 与配额详情
 * - 日志正文里到处是完整地址（「已打开 …」「第 n 步 · …」）。字段层面把
 *   targetUrl 换成 host 是不够的——正文里那份照样会把 query 里的令牌带出去
 */
function scrubText(text: string, repro: boolean): string {
  const t = stripPaths(text)
    .replace(/="[^"]*"/g, '="…"')
    .replace(/(AI 调用失败：)[\s\S]*/, '$1（已略去上游响应内容）')
  return repro ? t : t.replace(/https?:\/\/[^\s'"）)]+/g, (u) => `${hostOf(u) || '…'}/…`)
}

/** 逐行读 jsonl，坏行跳过——诊断包不该因为一行残缺就整个导不出来 */
function readJsonl(file: string, max: number): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  const rows: Array<Record<string, unknown>> = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // 半行写入（进程被杀）时会出现，忽略即可
    }
  }
  return rows.slice(-max)
}

function scrubRecord(r: Record<string, unknown>, repro: boolean): Record<string, unknown> {
  const out = { ...r }
  if (typeof out.message === 'string') out.message = scrubText(out.message, repro)
  if (typeof out.reason === 'string') out.reason = scrubText(out.reason, repro)
  // run-start 里的目标地址只留 host，完整地址属于复现级
  if (typeof out.targetUrl === 'string' && !repro) {
    out.targetHost = hostOf(out.targetUrl)
    delete out.targetUrl
  }
  return out
}

/**
 * 接管期控件事件的脱敏。
 *
 * label 对非输入框元素取的是页面文案前 40 字符，而人工接管的触发场景恰恰是
 * 登录墙、验证码、支付页——点到的菜单项可能就是姓名或脱敏手机号。
 * 控件类型与顺序足够还原「用户做了哪几步」，文案不必带。
 */
function scrubEvent(e: Record<string, unknown>): Record<string, unknown> {
  const { label, value, ...rest } = e
  void label
  void value
  return rest
}

/** 图谱：结构与计数任何级别都带，页面内容只在复现级带 */
function scrubGraph(graph: FlowGraph, repro: boolean): Record<string, unknown> {
  return {
    counts: { lanes: graph.lanes.length, nodes: graph.nodes.length, edges: graph.edges.length },
    meta: { deviceId: graph.meta.deviceId, steps: graph.meta.steps, aiCalls: graph.meta.aiCalls, updatedAt: graph.meta.updatedAt },
    lanes: graph.lanes,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      lane: n.lane,
      col: n.col,
      sub: n.sub,
      kind: n.kind,
      createdBy: n.createdBy,
      signatureHash: n.signatureHash,
      ts: n.ts,
      urlHost: hostOf(n.url),
      // 以下三项都是目标站的原文：标题是 AI 起的界面名，note 是页面上的
      // 校验提示原文，probeSummary 是页面前若干个控件的文案
      ...(repro ? { title: n.title, url: n.url, note: n.note, probeSummary: n.probeSummary } : {}),
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      type: e.type,
      ts: e.ts,
      ...(repro ? { label: e.label } : {}),
    })),
  }
}

/** 最近若干张缩略图。原图一律不带，见文件头的说明 */
function collectShots(dir: string, graph: FlowGraph): { shots: Record<string, string>; note: string } {
  const shots: Record<string, string> = {}
  let skipped = 0
  const picked = graph.nodes.slice(-MAX_SHOTS)
  for (const n of picked) {
    const f = join(dir, 'screens', `${n.shot}.thumb.jpg`)
    if (!existsSync(f)) continue
    try {
      shots[n.id] = `data:image/jpeg;base64,${readFileSync(f).toString('base64')}`
    } catch {
      skipped += 1
    }
  }
  const dropped = graph.nodes.length - picked.length
  return {
    shots,
    note: `只带最近 ${picked.length} 张缩略图${dropped > 0 ? `，另有 ${dropped} 张未包含` : ''}${skipped ? `，${skipped} 张读取失败` : ''}；原始分辨率存档图一律不含`,
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 生成诊断包。
 *
 * 写进项目目录（没有指定项目时写应用数据目录），随后由界面调用系统文件管理器
 * 定位——与导出图谱走的是同一条路，不引入文件选择对话框。
 */
export function buildDiagnose(opts: DiagnoseOptions): DiagnoseResult {
  const repro = opts.level === 'repro'
  const meta = opts.projectId ? getProject(opts.projectId) : null
  const dir = meta ? projectDir(meta.id) : appDataDir()
  const graph = meta ? readJson<FlowGraph | null>(join(dir, 'graph.json'), null) : null
  const settings = getSettings()

  const included: string[] = ['应用版本与运行环境', '应用设置（不含默认目标描述）', '更新器状态', '预览几何自检', '会话状态快照', '主进程日志尾部']
  const excluded: string[] = [
    'AI 接口密钥与全部凭证',
    '目标站的登录态（会话分区）',
    '原始分辨率存档截图',
    '人工接管期的控件文案',
    'AI 上游返回的错误响应内容',
    '表单里填入的具体内容',
  ]

  const body: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    level: opts.level,
    app: appInfo(),
    settings: {
      theme: settings.theme,
      defaultDeviceId: settings.defaultDeviceId,
      autoCheckUpdate: settings.autoCheckUpdate,
      autoDownloadUpdate: settings.autoDownloadUpdate,
      // defaultGoal 剥掉：用户常把业务背景写进去
    },
    update: updater.current(),
    preview: preview.debugInfo(),
    session: sessions.snapshot(),
  }

  if (meta) {
    included.push('项目配置与最近一次运行摘要', '图谱结构与计数', '会话记录（session.jsonl）', '人工接管的控件事件（仅类型与顺序）')
    body.project = {
      id: meta.id,
      deviceId: meta.deviceId,
      customDevice: meta.customDevice,
      targetHost: hostOf(meta.targetUrl),
      lastRun: meta.lastRun,
      // 名称与完整地址属于目标站信息，只在复现级带
      ...(repro ? { name: meta.name, targetUrl: meta.targetUrl, goal: meta.goal } : {}),
    }
    body.records = readJsonl(join(dir, 'session.jsonl'), MAX_RECORDS).map((r) => scrubRecord(r, repro))
    body.events = readJsonl(join(dir, 'events.jsonl'), MAX_EVENTS).map(scrubEvent)
    if (graph) body.graph = scrubGraph(graph, repro)
  } else {
    excluded.push('项目相关的全部内容（本次未指定项目）')
  }

  if (repro) {
    included.push('目标站地址与项目目标', '界面标题、地址与页面校验提示原文')
  } else {
    excluded.push('目标站地址与界面标题（基础级不含目标站内容）')
  }

  if (opts.includeShots && graph) {
    const { shots, note } = collectShots(dir, graph)
    body.shots = shots
    body.shotsNote = note
    included.push(`界面缩略图（${Object.keys(shots).length} 张）`)
  } else {
    excluded.push('界面缩略图')
  }

  // 主日志同样要过一遍：预览崩溃自愈那条会带上崩溃前的完整地址
  body.mainLog = scrubText(log.tail(LOG_TAIL_BYTES), repro)
  body.included = included
  body.excluded = excluded

  const file = join(dir, `flow-diagnose-${stamp()}.json`)
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  log.info('diagnose', `已生成诊断包：${file}`)
  return { path: file, bytes: statSync(file).size, included, excluded }
}
