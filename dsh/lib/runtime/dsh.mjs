/**
 * DSH Cordis 宿主运行时适配器。
 * 包装 subprocess 服务，严格透传 spill 与沙箱语义。
 *
 * 只走 `ctx.get('subprocess')`：0.2.0 起 cordis 会对**未在 `inject` 里声明的服务**
 * 的属性访问直接抛错（`cannot get property "subprocess" without inject`），而本插件
 * 刻意不硬注入这些服务（缺服务时只想降级机制半、保住队长指令），所以属性访问必须避免。
 */

export class DshRuntime {
  /**
   * @param {object} ctxOrSubprocess - Cordis ctx 或 subprocess 服务实例
   */
  constructor(ctxOrSubprocess) {
    this.ctx = ctxOrSubprocess
    this.subprocess = typeof ctxOrSubprocess?.get === 'function'
      ? ctxOrSubprocess.get('subprocess')
      : ctxOrSubprocess
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
      ?? (typeof this.ctx?.get === 'function' ? this.ctx.get('subprocess') : this.ctx)
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
