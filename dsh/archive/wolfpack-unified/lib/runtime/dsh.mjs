/**
 * DSH Cordis 宿主运行时适配器。
 * 包装 ctx.subprocess，严格透传 spill 与沙箱语义。
 */

export class DshRuntime {
  /**
   * @param {object} ctxOrSubprocess - Cordis ctx 或 ctx.subprocess 实例
   */
  constructor(ctxOrSubprocess) {
    this.ctx = ctxOrSubprocess
    this.subprocess = ctxOrSubprocess?.subprocess
      ?? (typeof ctxOrSubprocess?.get === 'function' ? ctxOrSubprocess.get('subprocess') : ctxOrSubprocess)
  }

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
   *     stdout?: { readFrom: (offset?: number) => { text: string, nextOffset: number, lossy: boolean, spillPath?: string } },
   *     stderr?: { readFrom: (offset?: number) => { text: string, nextOffset: number, lossy: boolean } },
   *   },
   *   terminate: () => Promise<void> | void,
   *   waitForExit?: () => Promise<void> | void,
   *   pid?: number,
   * }}
   */
  spawn({ argv, cwd, stdio, graceMs, signal }) {
    const subprocess = this.subprocess
      ?? (typeof this.ctx?.get === 'function' ? this.ctx.get('subprocess') : this.ctx?.subprocess)
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      throw new Error('wolfpack: subprocess 服务不可用，无法执行子进程')
    }
    return subprocess.spawn({
      argv,
      cwd,
      stdio,
      graceMs,
      signal,
    })
  }
}

export function createDshRuntime(ctxOrSubprocess) {
  return new DshRuntime(ctxOrSubprocess)
}

export default {
  DshRuntime,
  createDshRuntime,
}
