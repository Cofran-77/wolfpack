/**
 * 宿主无关的子进程启动包装器。
 * 核心层绝不依赖底层系统进程模块，所有进程由外部注入的 runtime 驱动。
 */

/**
 * 统一的进程启动辅助。
 *
 * @param {object} options
 * @param {object} options.runtime - 注入的宿主运行时（实现 spawn 契约）
 * @param {string[]} options.argv - 执行命令与参数数组
 * @param {string} [options.cwd] - 运行目录
 * @param {object} [options.stdio] - stdio 限制与 spill 配置
 * @param {AbortSignal} [options.signal] - 外部中止信号
 * @param {number} [options.timeoutMs] - 超时毫秒数（0 = 无限制）
 * @param {number} [options.graceMs] - 清理等待宽限
 * @returns {{
 *   handle: object,
 *   pid: number | undefined,
 *   done: Promise<{ exitCode: number | null, signal: string | null, error?: Error, timedOut: boolean, aborted: boolean }>,
 *   collected: {
 *     stdout?: { readFrom: (offset?: number) => { text: string, nextOffset: number, lossy: boolean, spillPath?: string } },
 *     stderr?: { readFrom: (offset?: number) => { text: string, nextOffset: number, lossy: boolean } },
 *   },
 *   terminate: () => Promise<void>,
 *   waitForExit: () => Promise<void>,
 * }}
 */
export function spawnProcess({
  runtime,
  argv,
  cwd = process.cwd(),
  stdio,
  signal,
  timeoutMs = 0,
  graceMs = 5_000,
}) {
  if (!runtime || typeof runtime.spawn !== 'function') {
    throw new Error('[wolfpack/spawn] 必须提供包含 spawn 方法的 runtime 实例')
  }

  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('[wolfpack/spawn] argv 必须是非空数组')
  }

  let timedOut = false
  let timer = undefined
  const controller = new AbortController()

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
  }

  const mergedSignal = timeoutMs > 0
    ? (signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
    : signal

  const handle = runtime.spawn({
    argv,
    cwd,
    stdio: stdio ?? {
      stdin: 'ignore',
      stdout: { maxBytes: 8 * 1024 * 1024, spill: { maxBytes: 50 * 1024 * 1024 } },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs,
    signal: mergedSignal,
  })

  const donePromise = (async () => {
    try {
      const outcome = await handle.done
      return {
        exitCode: outcome?.exitCode ?? null,
        signal: outcome?.signal ?? null,
        error: outcome?.error,
        timedOut,
        aborted: mergedSignal?.aborted === true,
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  })()

  const terminate = async () => {
    if (timer) clearTimeout(timer)
    if (typeof handle.terminate === 'function') {
      await handle.terminate()
    }
  }

  const waitForExit = async () => {
    if (typeof handle.waitForExit === 'function') {
      await handle.waitForExit()
    } else {
      await donePromise
    }
  }

  return {
    handle,
    pid: handle.pid,
    done: donePromise,
    collected: handle.collected,
    terminate,
    waitForExit,
  }
}
