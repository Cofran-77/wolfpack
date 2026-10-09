import { resolveRuntime } from './registry.mjs'

/**
 * DSH（Cordis）宿主运行时适配器：把 ctx.subprocess 的句柄适配成仓库内核使用的契约。
 *
 * 内核只需要 `{ spawn(options) -> { pid, done, collected.stdout.text, terminate } }`，
 * 因此这里把宿主句柄的 `collected.stdout.readFrom(offset)` 归一成 `.text`。
 * 宿主沙箱与 spill 语义原样透传，绝不在适配层做二次解释。
 */

/**
 * 把宿主句柄适配成内核契约。
 *
 * @param {object} handle
 * @returns {object}
 */
export function adaptHandle(handle) {
  const readStdout = offset => {
    const chunk = handle?.collected?.stdout?.readFrom?.(offset)
    return {
      text: typeof chunk?.text === 'string' ? chunk.text : '',
      bytes: typeof chunk?.nextOffset === 'number' ? chunk.nextOffset : 0,
      truncated: chunk?.lossy === true,
      ...(chunk?.spillPath === undefined ? {} : { spillPath: chunk.spillPath }),
    }
  }
  const readStderr = offset => {
    const chunk = handle?.collected?.stderr?.readFrom?.(offset)
    return {
      text: typeof chunk?.text === 'string' ? chunk.text : '',
      bytes: typeof chunk?.nextOffset === 'number' ? chunk.nextOffset : 0,
      truncated: chunk?.lossy === true,
    }
  }

  return {
    pid: handle?.pid,
    done: handle?.done ?? Promise.resolve({ exitCode: null, signal: null }),
    collected: {
      get stdout() {
        return readStdout(0)
      },
      get stderr() {
        return readStderr(0)
      },
    },
    terminate: async () => {
      await handle?.terminate?.()
    },
    waitForExit: async () => {
      if (typeof handle?.waitForExit === 'function') await handle.waitForExit()
      else await handle?.done
    },
  }
}

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
   * 启动子进程（沙箱与 spill 由宿主决定）。
   *
   * @param {object} options
   * @returns {object}
   */
  spawn({ argv, cwd, stdio, graceMs, signal }) {
    const subprocess = this.subprocess
      ?? this.ctx?.subprocess
      ?? (typeof this.ctx?.get === 'function' ? this.ctx.get('subprocess') : undefined)
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      throw new Error('wolfpack: subprocess 服务不可用，无法执行子进程')
    }
    return adaptHandle(subprocess.spawn({ argv, cwd, stdio, graceMs, signal }))
  }

  /**
   * 进程树终止交给宿主内核纳管；没有宿主能力时退回不做事（绝不假装杀掉）。
   *
   * @param {number} pid
   */
  killTree(pid) {
    const subprocess = this.subprocess ?? this.ctx?.subprocess
    if (typeof subprocess?.killTree === 'function') {
      subprocess.killTree(pid)
    }
  }
}

/**
 * 创建 DSH 运行时；ctx 为空时不抛错，交给核心层自行回退。
 *
 * @param {object} ctxOrSubprocess
 * @returns {DshRuntime}
 */
export function createDshRuntime(ctxOrSubprocess) {
  return new DshRuntime(ctxOrSubprocess)
}

export { resolveRuntime }

export default {
  DshRuntime,
  createDshRuntime,
  adaptHandle,
}
