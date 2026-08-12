import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { session } from 'electron'
import type { DeviceSpec, ProjectMeta, ProjectRunSummary } from '@shared/types'
import { projectDir, projectsRoot, readJson, writeJsonAtomic } from './paths'

const metaFile = (id: string) => join(projectDir(id), 'project.json')

export function listProjects(): ProjectMeta[] {
  const root = projectsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readJson<ProjectMeta | null>(join(root, d.name, 'project.json'), null))
    .filter((m): m is ProjectMeta => m !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function createProject(input: {
  name: string
  targetUrl: string
  deviceId: string
  customDevice?: DeviceSpec
  aiProfileId: string
  goal: string
}): ProjectMeta {
  const id = randomUUID()
  const now = new Date().toISOString()
  const meta: ProjectMeta = { id, ...input, createdAt: now, updatedAt: now }
  writeJsonAtomic(metaFile(id), meta)
  return meta
}

export function getProject(id: string): ProjectMeta | null {
  return readJson<ProjectMeta | null>(metaFile(id), null)
}

export function touchProject(id: string): void {
  const meta = getProject(id)
  if (!meta) return
  writeJsonAtomic(metaFile(id), { ...meta, updatedAt: new Date().toISOString() })
}

/**
 * 记录最近一次探索的结果。
 * 会话状态活在内存里，退出应用就没了；项目列表要在没有活动会话时
 * 也能显示「已完成 / 已中断 / 未开始」，就得把结果落到项目元数据上。
 */
export function updateProjectRun(id: string, run: ProjectRunSummary): void {
  const meta = getProject(id)
  if (!meta) return
  writeJsonAtomic(metaFile(id), { ...meta, lastRun: run, updatedAt: new Date().toISOString() })
}

export function deleteProject(id: string): void {
  const dir = join(projectsRoot(), id)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** 每个项目独占一个会话分区，登录态互不串味 */
export function partitionOf(id: string): string {
  return `persist:project-${id}`
}

export async function clearProjectSession(id: string): Promise<void> {
  const s = session.fromPartition(partitionOf(id))
  await s.clearStorageData()
}
