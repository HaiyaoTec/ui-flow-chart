import { release, version } from 'node:os'
import { app } from 'electron'
import type { AppInfo } from '@shared/ipc-contract'

/**
 * 应用版本与运行环境。
 *
 * 界面上、诊断包里都要用同一份：用户报障时第一件要核对的就是版本，
 * 而这三样（版本、平台架构、系统版本）恰好是最常导致「本机复现不了」的变量。
 */
export function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    // Windows 上 release() 是 10.0.26200 这类内核号，version() 才是可读名称
    os: `${version()} (${release()})`,
  }
}
