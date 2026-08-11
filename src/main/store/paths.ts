import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** 应用数据根目录（配置、凭证） */
export function appDataDir(): string {
  const dir = app.getPath('userData')
  ensureDir(dir)
  return dir
}

/** 项目工程根目录：Documents/UIFlowChart/projects */
export function projectsRoot(): string {
  const dir = join(app.getPath('documents'), 'UIFlowChart', 'projects')
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
