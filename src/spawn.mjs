import { spawn as cpSpawn, spawnSync } from 'node:child_process'

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
      // Unix: 尝试给进程组发信号，兜底直接杀自身
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

/**
 * 唯一的子进程启动包装器。
 * 统一处理进程树杀灭、流截断收集、超时与 AbortSignal 控制。
 *
 * @param {object} options
 * @param {string[]} options.argv - 执行命令与参数数组
 * @param {string} [options.cwd] - 运行目录
 * @param {Record<string, string|undefined>} [options.env] - 环境变量合并
 * @param {AbortSignal} [options.signal] - 外部中止信号
 * @param {number} [options.timeoutMs] - 超时毫秒数（0 = 无限制）
 * @param {number} [options.graceMs] - 清理等待宽限
 * @param {number} [options.maxStdoutBytes] - stdout 缓冲上限（默认 8MB）
 * @param {number} [options.maxStderrBytes] - stderr 缓冲上限（默认 1MB）
 * @returns {{
 *   child: import('node:child_process').ChildProcess,
 *   pid: number | undefined,
 *   done: Promise<{ exitCode: number | null, signal: string | null, error?: Error, timedOut: boolean, aborted: boolean }>,
 *   collected: { stdout: { text: string, bytes: number, truncated: boolean }, stderr: { text: string, bytes: number, truncated: boolean } },
 *   terminate: () => Promise<void>,
 *   waitForExit: () => Promise<void>
 * }}
 */
export function spawnProcess({
  argv,
  cwd = process.cwd(),
  env = process.env,
  signal,
  timeoutMs = 0,
  graceMs = 5_000,
  maxStdoutBytes = 8 * 1024 * 1024,
  maxStderrBytes = 1024 * 1024,
}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('[wolfpack/spawn] argv 必须是非空数组')
  }

  const [cmd, ...args] = argv
  const stdoutChunks = []
  let stdoutBytes = 0
  let stdoutTruncated = false

  const stderrChunks = []
  let stderrBytes = 0
  let stderrTruncated = false

  let timedOut = false
  let aborted = false
  let timeoutTimer = undefined

  const timeoutController = new AbortController()
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      timeoutController.abort()
    }, timeoutMs)
    timeoutTimer.unref?.()
  }

  const mergedSignal = signal
    ? (timeoutMs > 0 ? AbortSignal.any([signal, timeoutController.signal]) : signal)
    : (timeoutMs > 0 ? timeoutController.signal : undefined)

  let child
  try {
    child = cpSpawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
  } catch (err) {
    // 同步抛出错误（例如命令参数非法）
    clearTimeout(timeoutTimer)
    const emptyDone = Promise.resolve({
      exitCode: null,
      signal: null,
      error: err,
      timedOut: false,
      aborted: false,
    })
    return {
      child: null,
      pid: undefined,
      done: emptyDone,
      collected: {
        stdout: { text: '', bytes: 0, truncated: false },
        stderr: { text: '', bytes: 0, truncated: false },
      },
      terminate: async () => {},
      waitForExit: async () => {},
    }
  }

  const pid = child.pid

  if (child.stdout) {
    child.stdout.on('data', chunk => {
      if (stdoutBytes < maxStdoutBytes) {
        const remaining = maxStdoutBytes - stdoutBytes
        if (chunk.length <= remaining) {
          stdoutChunks.push(chunk)
          stdoutBytes += chunk.length
        } else {
          stdoutChunks.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
          stdoutTruncated = true
        }
      } else {
        stdoutTruncated = true
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
          stderrTruncated = true
        }
      } else {
        stderrTruncated = true
      }
    })
  }

  const abortListener = () => {
    aborted = true
    killProcessTree(pid)
  }

  if (mergedSignal) {
    if (mergedSignal.aborted) {
      abortListener()
    } else {
      mergedSignal.addEventListener('abort', abortListener, { once: true })
    }
  }

  let spawnError = undefined
  child.on('error', err => {
    spawnError = err
  })

  let resolveDone
  const donePromise = new Promise(resolve => {
    resolveDone = resolve
  })

  child.on('close', (exitCode, exitSignal) => {
    clearTimeout(timeoutTimer)
    if (mergedSignal) {
      mergedSignal.removeEventListener('abort', abortListener)
    }

    resolveDone({
      exitCode,
      signal: exitSignal,
      error: spawnError,
      timedOut,
      aborted: aborted || (signal?.aborted === true),
    })
  })

  const terminate = async () => {
    clearTimeout(timeoutTimer)
    killProcessTree(pid)
    try {
      child.kill('SIGKILL')
    } catch {}
    // 等待退出
    await Promise.race([
      donePromise,
      new Promise(r => setTimeout(r, Math.min(graceMs, 2000))),
    ])
  }

  const waitForExit = async () => {
    await donePromise
  }

  const collected = {
    get stdout() {
      const buf = Buffer.concat(stdoutChunks)
      return {
        text: buf.toString('utf8'),
        bytes: stdoutBytes,
        truncated: stdoutTruncated,
      }
    },
    get stderr() {
      const buf = Buffer.concat(stderrChunks)
      return {
        text: buf.toString('utf8'),
        bytes: stderrBytes,
        truncated: stderrTruncated,
      }
    },
  }

  return {
    child,
    pid,
    done: donePromise,
    collected,
    terminate,
    waitForExit,
  }
}
