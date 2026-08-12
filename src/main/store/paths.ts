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
 * 项目工程根目录：Documents/UIFlowChart/projects。
 * 自动化测试必须指到临时目录，否则会往用户真实的项目列表里塞测试数据。
 */
export function projectsRoot(): string {
  const base = process.env.UFC_DATA_DIR ?? join(app.getPath('documents'), 'UIFlowChart')
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
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
