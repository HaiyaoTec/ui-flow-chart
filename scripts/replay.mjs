/**
 * 回放用户回传的诊断包。
 *
 *   node scripts/replay.mjs <诊断包.json> [--port 4195]
 *
 * 做的事：把诊断包里的目标地址、设备与 AI 决策录像取出来，在临时数据目录里
 * 建好项目，让 AI 请求打到本地的回放服务上，然后拉起应用并自动开始探索。
 * 于是当时那一轮的每一个决策会按原顺序重新作用到真实站点上，
 * 作者能看着流程图一步步长出来，而不是只对着结果猜。
 *
 * 前提：诊断包必须是「复现级」——基础级不含决策内容与目标地址，回放不了。
 * 目标站也要能访问，且结构与当时相差不大；对不上时回放服务会把差异打到控制台。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const portArg = args.indexOf('--port')
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4195

if (!file) {
  console.error('用法：node scripts/replay.mjs <诊断包.json> [--port 4195]')
  process.exit(1)
}

const pack = JSON.parse(readFileSync(file, 'utf8'))
const targetUrl = pack.project?.targetUrl
const deviceId = pack.project?.deviceId ?? 'iphone-14-pro-max'
const tape = (pack.ai ?? []).filter((r) => r.kind === 'decide' && r.action)

if (!targetUrl) {
  console.error('这个诊断包不含目标地址，说明导出时选的是基础级，回放不了。')
  console.error('请让用户在「设置 → 诊断与日志」里勾上「包含复现所需的信息」重新导出。')
  process.exit(1)
}
if (!tape.length) {
  console.error('这个诊断包里没有 AI 决策录像，回放不了。')
  process.exit(1)
}

console.log(`目标站：${targetUrl}`)
console.log(`设备：${deviceId}`)
console.log(`录像：${tape.length} 步 · 应用版本 ${pack.app?.version ?? '未知'} · ${pack.app?.platform ?? ''}`)

// 回放服务：按录像顺序把当时的决策吐回来
const ai = spawn(process.execPath, [join(root, 'tests/mock-ai/server.mjs'), String(PORT), 'replay', file], {
  cwd: root,
  stdio: 'inherit',
})
process.on('exit', () => ai.kill())
process.on('SIGINT', () => process.exit(130))

async function waitPort(url, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      await fetch(url)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return false
}

await waitPort(`http://localhost:${PORT}`)

/*
 * 数据目录用临时目录：回放会建项目、下发 AI 配置、写图谱，
 * 落到作者自己的工程区里就会把真实项目搅乱。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ufc-replay-'))
const app = await electron.launch({
  args: [root],
  env: { ...process.env, UFC_TEST: '1', UFC_DATA_DIR: dataDir },
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')

const ipc = (channel, payload) =>
  win.evaluate(([c, p]) => window.api.invoke(c, p), [channel, payload])

const profile = await ipc('ai:profiles:save', {
  profile: { id: '', name: '回放', protocol: 'openai', baseUrl: `http://localhost:${PORT}/v1`, model: 'replay' },
  apiKey: 'replay',
})
const project = await ipc('project:create', {
  name: `回放 ${new Date().toISOString().slice(0, 16)}`,
  targetUrl,
  deviceId,
  customDevice: pack.project?.customDevice,
  aiProfileId: profile.id,
  goal: pack.project?.goal ?? '回放',
})

// 界面上的日志面板照常滚动，这里把同一份日志也打到控制台，便于对照录像
await win.evaluate(() => {
  window.api.on('session:event', (e) => {
    if (e.kind === 'log') console.log(`[会话] ${e.message}`)
    if (e.kind === 'state-changed') console.log(`[状态] ${e.from} → ${e.to}${e.reason ? `（${e.reason}）` : ''}`)
  })
})
win.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[会话]') || t.startsWith('[状态]')) console.log(t)
})

/*
 * 打开项目与开始探索之间必须等页面真正落地。
 *
 * 两者都会去打开目标站，抢在一起的话后一次会把前一次的导航掐掉，
 * 表现为一上来就 ERR_ABORTED、探索直接判失败。真人操作时中间隔着好几秒，
 * 这个竞争碰不到，脚本必须自己等。
 */
await ipc('project:open', { id: project.id })
const settled = Date.now() + 20000
for (;;) {
  const dbg = await ipc('test:preview-debug').catch(() => null)
  if (dbg?.visible || Date.now() > settled) break
  await new Promise((r) => setTimeout(r, 250))
}
// 落地之后再留一拍给首屏渲染，避免第一步观察到的是空白页
await new Promise((r) => setTimeout(r, 1200))

await ipc('session:start', { projectId: project.id })

console.log('\n回放已开始。窗口保持打开，Ctrl+C 结束。\n')
