/**
 * Node.js 宿主运行时适配器。
 * 使用 node:child_process 驱动子进程，并实现等价的落盘 spill 与进程树管理。
 */

import { spawn as cpSpawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setDefaultRuntime } from '../core/delegate.mjs'

/**
 * 强力终止进程及其子进程树（跨平台）。
 *
 * @param {number} [pid]
 */
export function killProcessTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {
    // 忽略目标进程已消亡的异常
  }
}

export class NodeRuntime {
  /**
   * 启动子进程。
   *
   * @param {object} options
   * @param {string[]} options.argv
   * @param {string} [options.cwd]
   * @param {object} [options.stdio]
   * @param {number} [options.graceMs]
   * @param {AbortSignal} [options.signal]
   * @returns {{
   *   done: Promise<{ exitCode: number | null, signal: string | null, error?: Error }>,
   *   collected: {
   *     stdout: { readFrom: (offset?: number) => { text: string, nextOffset: number, lossy: boolean, spillPath?: string } },
   *     stderr: { readFrom: (offset?: number) => { text: string, nextOffset: number, lossy: boolean } },
   *   },
   *   terminate: () => Promise<void>,
   *   waitForExit: () => Promise<void>,
   *   pid: number | undefined,
   * }}
   */
  spawn({
    argv,
    cwd = process.cwd(),
    stdio,
    graceMs = 5000,
    signal,
  }) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error('wolfpack: argv 必须是非空数组')
    }

    const [cmd, ...args] = argv

    // 解析 stdio 限制与 spill 配置
    const maxStdoutBytes = typeof stdio?.stdout?.maxBytes === 'number'
      ? stdio.stdout.maxBytes
      : 8 * 1024 * 1024
    const maxStderrBytes = typeof stdio?.stderr?.maxBytes === 'number'
      ? stdio.stderr.maxBytes
      : 1024 * 1024

    const spillConfig = stdio?.stdout?.spill
    const maxSpillBytes = typeof spillConfig?.maxBytes === 'number'
      ? spillConfig.maxBytes
      : 50 * 1024 * 1024

    let spillPath = undefined
    let spillBytesWritten = 0
    if (spillConfig) {
      const spillDir = join(tmpdir(), 'wolfpack-spill')
      try {
        mkdirSync(spillDir, { recursive: true })
        spillPath = join(spillDir, `spill-${Date.now()}-${randomUUID()}.log`)
      } catch {
        spillPath = undefined
      }
    }

    const stdoutChunks = []
    let stdoutBytes = 0
    let stdoutLossy = false

    const stderrChunks = []
    let stderrBytes = 0
    let stderrLossy = false

    let child
    try {
      child = cpSpawn(cmd, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      const emptyDone = Promise.resolve({
        exitCode: null,
        signal: null,
        error: err,
      })
      return {
        pid: undefined,
        done: emptyDone,
        collected: {
          stdout: {
            readFrom: () => ({ text: '', nextOffset: 0, lossy: false, spillPath }),
          },
          stderr: {
            readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
          },
        },
        terminate: async () => {},
        waitForExit: async () => {},
      }
    }

    const pid = child.pid

    if (child.stdout) {
      child.stdout.on('data', chunk => {
        // 1. 写入落盘 spill
        if (spillPath && spillBytesWritten < maxSpillBytes) {
          try {
            const remaining = maxSpillBytes - spillBytesWritten
            const toWrite = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
            appendFileSync(spillPath, toWrite)
            spillBytesWritten += toWrite.length
          } catch {
            // 忽略落盘写异常
          }
        }

        // 2. 内存缓冲
        if (stdoutBytes < maxStdoutBytes) {
          const remaining = maxStdoutBytes - stdoutBytes
          if (chunk.length <= remaining) {
            stdoutChunks.push(chunk)
            stdoutBytes += chunk.length
          } else {
            stdoutChunks.push(chunk.subarray(0, remaining))
            stdoutBytes += remaining
            stdoutLossy = true
          }
        } else {
          stdoutLossy = true
        }
      })
    }

    if (child.stderr) {
      child.stderr.on('data', chunk => {
        if (stderrBytes < maxStderrBytes) {
          const remaining = maxStderrBytes - stderrBytes
          if (chunk.length <= remaining) {
            stderrChunks.push(chunk)
            stderrBytes += chunk.length
          } else {
            stderrChunks.push(chunk.subarray(0, remaining))
            stderrBytes += remaining
            stderrLossy = true
          }
        } else {
          stderrLossy = true
        }
      })
    }

    let spawnError = undefined
    child.on('error', err => {
      spawnError = err
    })

    let resolveDone
    const donePromise = new Promise(resolve => {
      resolveDone = resolve
    })

    const terminate = async () => {
      if (pid) {
        killProcessTree(pid)
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      await Promise.race([
        donePromise,
        new Promise(r => setTimeout(r, Math.min(graceMs, 2000))),
      ])
    }

    const abortListener = () => {
      terminate()
    }

    if (signal) {
      if (signal.aborted) {
        abortListener()
      } else {
        signal.addEventListener('abort', abortListener, { once: true })
      }
    }

    child.on('close', (exitCode, exitSignal) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener)
      }
      resolveDone({
        exitCode,
        signal: exitSignal,
        error: spawnError,
      })
    })

    const collected = {
      stdout: {
        readFrom(offset = 0) {
          const buf = Buffer.concat(stdoutChunks)
          const text = buf.toString('utf8', offset)
          return {
            text,
            nextOffset: stdoutBytes,
            lossy: stdoutLossy,
            ...(spillPath ? { spillPath } : {}),
          }
        },
      },
      stderr: {
        readFrom(offset = 0) {
          const buf = Buffer.concat(stderrChunks)
          const text = buf.toString('utf8', offset)
          return {
            text,
            nextOffset: stderrBytes,
            lossy: stderrLossy,
          }
        },
      },
    }

    return {
      pid,
      done: donePromise,
      collected,
      terminate,
      waitForExit: async () => {
        await donePromise
      },
    }
  }
}

export function createNodeRuntime() {
  return new NodeRuntime()
}

// 自动向核心层注入宿主无关的 Node.js 运行时作为未显式传参时的默认运行时
setDefaultRuntime(new NodeRuntime())

export default {
  NodeRuntime,
  createNodeRuntime,
  killProcessTree,
}
