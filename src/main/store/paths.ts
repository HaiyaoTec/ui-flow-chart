import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** 应用数据根目录（配置、凭证） */
export function appDataDir(): string {
  const dir = app.getPath('userData')
  ensureDir(dir)
  return dir
}

/**
 * 项目工程根目录。
 *
 * 三条路径必须互不干扰：
 * - 自动化测试走 UFC_DATA_DIR 指定的临时目录，否则会往用户真实的项目列表里塞测试数据
 * - 开发模式单独用 -dev 后缀。这条是补的：早先开发与安装版共用同一个目录，
 *   调试时建的项目会原封不动出现在正式安装的应用里
 * - 安装版用不带后缀的目录，这才是用户真正的工程区
 *
 * macOS 上落在 userData 而不是 Documents：10.15 起 ~/Documents 受 TCC 保护，
 * 用户在授权框上点「不允许」，mkdir 就是 EPERM，项目相关功能会整片不可用；
 * 且未签名构建的授权按 cdhash 记录，每次更新都要重新授权一次。
 */
export function projectsRoot(): string {
  const home = app.isPackaged ? 'UIFlowChart' : 'UIFlowChart-dev'
  const docs = process.platform === 'darwin' ? app.getPath('userData') : app.getPath('documents')
  const base = process.env.UFC_DATA_DIR ?? join(docs, home)
  const dir = join(base, 'projects')
  ensureDir(dir)
  return dir
}

export function projectDir(projectId: string): string {
  const dir = join(projectsRoot(), projectId)
  ensureDir(dir)
  ensureDir(join(dir, 'screens'))
  return dir
}

export function ensureDir(dir: string): void {
  if (existsSync(dir)) return
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    // 权限错误要说人话：macOS 上拒绝过「文件与文件夹」授权就会走到这里，
    // 原始的 EPERM 报文对用户没有任何指导意义
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') throw new Error(`没有访问「${dir}」的权限，无法创建工程目录`)
    throw e
  }
}

/** 原子写：先写临时文件再 rename，避免进程中断留下半个 JSON */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
