import { spawn as cpSpawn } from 'node:child_process'

import { killProcessTree, spawnProcess } from '../spawn.mjs'
import { setDefaultRuntime } from './registry.mjs'

/**
 * Node.js 宿主运行时适配器。
 *
 * 把仓库既有的 spawnProcess（进程树杀灭、流截断收集、超时、AbortSignal）
 * 包成一个可注入的 Runtime；**导入本模块即自动注入**，因此 CLI / MCP / 面板
 * 只需 `import '../src/runtime/node.mjs'` 一行，核心层就能拿到 Node 运行时。
 *
 * 这里也是「宿主专有外设」的落点：桌面通知（macOS 通知中心）属于宿主，不属于核心。
 */

export class NodeRuntime {
  /**
   * 启动子进程。
   *
   * @param {object} options
   * @returns {object} 与 src/spawn.mjs 的 spawnProcess 同契约
   */
  spawn(options) {
    return spawnProcess(options)
  }

  /**
   * 强力终止进程树。
   *
   * @param {number} pid
   */
  killTree(pid) {
    killProcessTree(pid)
  }
}

/**
 * 创建 Node 运行时。
 *
 * @returns {NodeRuntime}
 */
export function createNodeRuntime() {
  return new NodeRuntime()
}

/**
 * 把文本安全地塞进 AppleScript 字符串字面量。
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeAppleScript(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
}

/**
 * 宿主侧停滞通知器：写 stderr（人人可见）+ 可选桌面通知（macOS 通知中心）。
 *
 * @param {object} [options]
 * @param {boolean} [options.toast] - 是否弹桌面通知（默认关，避免打扰）
 * @param {Function} [options.spawnImpl] - 注入 spawn 实现（测试用）
 * @returns {(info: object) => void}
 */
export function createNodeStallNotifier({ toast = false, spawnImpl = cpSpawn } = {}) {
  return function notify(info) {
    const worker = info?.warning?.worker ?? info?.worker ?? '工人'
    const timeText = Math.max(1, Math.round((info?.warning?.silentMs ?? info?.silentMs ?? 0) / 60_000))
    const level = info?.warning?.level ?? 0
    const maxWarnings = info?.warning?.maxWarnings ?? 0
    const taskId = info?.taskId ?? '(未命名任务)'

    if (toast !== true) return
    if (process.platform !== 'darwin') return

    const title = `狼群：${worker} 疑似停滞`
    const message = `${taskId} 已 ${timeText} 分钟无进展（第 ${level}/${maxWarnings} 次）。不会自动终止。`
    try {
      const child = spawnImpl('osascript', [
        '-e',
        `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
      ], { stdio: 'ignore', detached: true, windowsHide: true })
      child.on?.('error', () => {})
      child.unref?.()
    } catch {
      // 通知失败不影响任何主流程
    }
  }
}

// 导入即注入：宿主入口只要 import 本模块，核心层就能拿到 Node 运行时。
setDefaultRuntime(new NodeRuntime())

export default {
  NodeRuntime,
  createNodeRuntime,
  createNodeStallNotifier,
}
