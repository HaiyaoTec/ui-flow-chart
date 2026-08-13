/**
 * 全流程自检：内置测试站 + mock AI + 一整轮自动探索。
 *
 *   node scripts/explore-check.mjs [scenario]
 *
 * e2e 覆盖的是单点行为（设备模拟、坐标、可见性），这条链路验的是「AI 一步步把整个
 * 流程走完」，两者不重叠。原先是 PowerShell 脚本，macOS 上跑不起来，改成 Node：
 * 端口、进程、electron 二进制路径都由 Node 解决，不再依赖任何 shell。
 */
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const scenario = process.argv[2] ?? 'normal'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE_PORT = 4183
const AI_PORT = 4192

/** 构建失败必须立刻暴露，否则会拿旧产物跑出误导性的结果 */
const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
if (build.status !== 0) {
  console.error('构建失败，已中止：')
  console.error((build.stderr || build.stdout || '').split('\n').slice(-25).join('\n'))
  process.exit(1)
}

const child = (file, args) => spawn(process.execPath, args, { cwd: root, stdio: 'ignore' })
const site = child('site', [join(root, 'test-site/serve.mjs'), String(SITE_PORT)])
const ai = child('ai', [join(root, 'tests/mock-ai/server.mjs'), String(AI_PORT), scenario])

/** 等端口起来，比固定 sleep 稳 */
async function waitPort(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      await fetch(url)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return false
}

const kill = () => {
  site.kill()
  ai.kill()
}
process.on('exit', kill)
process.on('SIGINT', () => process.exit(130))

if (!(await waitPort(`http://localhost:${SITE_PORT}`))) {
  console.error('测试站没起来')
  process.exit(1)
}

const out = await new Promise((resolve) => {
  let buf = ''
  const app = spawn(electronPath, [root], {
    cwd: root,
    env: {
      ...process.env,
      UFC_TEST: '1',
      UFC_SELFCHECK_EXPLORE: '1',
      UFC_SCENARIO: scenario,
      UFC_SITE: `http://localhost:${SITE_PORT}`,
      UFC_AI: `http://localhost:${AI_PORT}/v1`,
    },
  })
  app.stdout.on('data', (d) => (buf += d))
  app.stderr.on('data', (d) => (buf += d))
  app.on('close', () => resolve(buf))
})

kill()

const line = out.split('\n').find((l) => l.includes('EXPLORE_RESULT'))
if (line) {
  console.log(line.split('EXPLORE_RESULT ')[1].trim())
} else {
  console.error('自检未产出结果，最后输出：')
  console.error(out.split('\n').slice(-40).join('\n'))
  process.exit(1)
}
