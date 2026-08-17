import { appendFileSync, mkdirSync, renameSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 主进程文件日志。
 *
 * 打包后的应用没有附着控制台，console 输出等于扔掉；而用户机器上出问题时，
 * 唯一能回传的就是文件。这里只做一件事：把日志稳稳地写进磁盘。
 *
 * 三条纪律：
 * 1. 任何写入失败一律吞掉。日志是旁路设施，绝不能因为磁盘满、目录只读、
 *    杀软锁文件而把调用方的流程带崩——探索主循环就曾因为 session.jsonl
 *    写失败在 catch 里二次抛出而静默死掉。
 * 2. 常规写入走缓冲 + 异步刷盘，不在主循环里同步写。
 * 3. 致命错误（未捕获异常）走同步写：进程马上就要退出，异步刷盘来不及。
 */

/** 单个日志文件的大小上限，超过就轮转 */
const MAX_BYTES = 2 * 1024 * 1024
/** 轮转保留份数（main.log + main.1.log） */
const KEEP = 1
/** 缓冲刷盘间隔 */
const FLUSH_MS = 300

type Level = 'info' | 'warn' | 'error'

let dir: string | null = null
let logFile = ''
let buffer: string[] = []
let timer: NodeJS.Timeout | null = null

/**
 * 解析日志目录。
 *
 * 必须懒解析：异常钩子要在 app ready 之前就挂上，而那时 getPath('logs')
 * 未必可用。拿不到就先留在内存缓冲里，等第一次拿到目录再一起落盘。
 */
function resolveDir(): string | null {
  if (dir) return dir
  try {
    const d = app.getPath('logs')
    mkdirSync(d, { recursive: true })
    dir = d
    logFile = join(d, 'main.log')
    return dir
  } catch {
    return null
  }
}

/** 超过上限就把当前文件挪成 .1，新日志从空文件开始 */
function rotate(): void {
  try {
    if (!existsSync(logFile) || statSync(logFile).size < MAX_BYTES) return
    renameSync(logFile, join(dir!, `main.${KEEP}.log`))
  } catch {
    // 轮转失败就继续往原文件里写，总比不写强
  }
}

function writeNow(lines: string[]): void {
  if (!lines.length) return
  if (!resolveDir()) {
    // 目录还拿不到：留在缓冲里等下一次。但不能无限涨，
    // 上限之外的丢弃，宁可少几行也不能把内存吃光
    buffer = [...lines, ...buffer].slice(0, 2000)
    return
  }
  try {
    rotate()
    appendFileSync(logFile, lines.join('\n') + '\n', 'utf8')
  } catch {
    // 见纪律 1
  }
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const lines = buffer
    buffer = []
    writeNow(lines)
  }, FLUSH_MS)
  // 只为刷日志而拖住进程退出是本末倒置
  timer.unref?.()
}

function format(level: Level, scope: string, message: string): string {
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
}

/** 把任意抛出物变成可读文本。堆栈里的本机绝对路径含用户名，落盘前先抹掉 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${stripPaths(e.stack ?? '')}`
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/**
 * 抹掉堆栈里的本机绝对路径。
 *
 * 打包后的路径形如 C:\Users\<用户名>\AppData\Local\Programs\... ——
 * 用户名本身就是个人信息，而定位缺陷只需要文件名与行号。
 */
export function stripPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s)]*?([^\\/\s)]+\.[a-z]+)/g, '…\\$1')
    .replace(/\/(?:[^\s/)]+\/)+([^\s/)]+\.[a-z]+)/g, '…/$1')
}

export const log = {
  info(scope: string, message: string): void {
    buffer.push(format('info', scope, message))
    schedule()
  },
  warn(scope: string, message: string): void {
    buffer.push(format('warn', scope, message))
    schedule()
  },
  error(scope: string, message: string, e?: unknown): void {
    buffer.push(format('error', scope, e === undefined ? message : `${message}\n${describeError(e)}`))
    schedule()
  },
  /** 致命错误：同步落盘。进程可能马上退出，缓冲刷不出去 */
  fatal(scope: string, message: string, e?: unknown): void {
    const lines = [...buffer, format('error', scope, e === undefined ? message : `${message}\n${describeError(e)}`)]
    buffer = []
    writeNow(lines)
  },
  /** 立刻把缓冲写出去。退出前、导出诊断包前调用 */
  flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const lines = buffer
    buffer = []
    writeNow(lines)
  },
  /** 日志文件路径。拿不到目录时返回空串 */
  file(): string {
    return resolveDir() ? logFile : ''
  },
  /** 读取日志末尾若干字节，供诊断包收集 */
  tail(bytes: number): string {
    log.flush()
    if (!resolveDir()) return ''
    try {
      const text = readFileSync(logFile, 'utf8')
      return text.length > bytes ? text.slice(-bytes) : text
    } catch {
      return ''
    }
  },
}

/**
 * electron-updater 需要的 logger 形状。
 *
 * 更新装不上是这类分发方式最高频的报障，而它的内部日志默认走 console——
 * 打包版等于全丢。接上之后，下载地址、校验失败、差量包对不上都能落盘。
 */
export const updaterLogger = {
  info: (m: unknown) => log.info('updater', String(m)),
  warn: (m: unknown) => log.warn('updater', String(m)),
  error: (m: unknown) => log.error('updater', String(m)),
  debug: (m: unknown) => log.info('updater', String(m)),
}
