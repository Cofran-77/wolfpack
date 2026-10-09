/**
 * 狼群模式 — DSH 宿主停滞监控与通知适配层。
 *
 * 核心文件活跃度采样与判定已收敛至 lib/core/stall-monitor.mjs。
 * 本模块负责 DSH 宿主专有的系统 Toast 通知生成与注入。
 */

export {
  DEFAULT_STALL_POLL_MS,
  DEFAULT_STALL_WARNINGS,
  DEFAULT_STALL_WINDOW_MS,
  defaultStoreRoot,
  stallWindowMs,
  stallMaxWarnings,
  stallPollMs,
  stallToastEnabled,
  resolveStallConfig,
  sampleProgress,
  stallDecision,
  appendStallRecord,
  createStallMonitor,
} from './core/stall-monitor.mjs'

import { defaultShellArgv } from './core/verify.mjs'
import { createDshRuntime } from './runtime/dsh.mjs'

/**
 * 系统通知用的 PowerShell 脚本（WinForms 气泡）。
 *
 * @param {string} title
 * @param {string} message
 * @returns {string}
 */
export function stallToastScript(title, message) {
  const quote = value => `'${String(value).replace(/'/g, "''")}'`
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Warning',
    '$n.Visible = $true',
    `$n.ShowBalloonTip(15000, ${quote(title)}, ${quote(message)}, [System.Windows.Forms.ToolTipIcon]::Warning)`,
    'Start-Sleep -Seconds 16',
    '$n.Dispose()',
  ].join('; ')
}

/**
 * 创建 DSH 专用的系统 Toast 注入器。
 *
 * @param {object} [ctx] - Cordis 上下文
 * @returns {(params: object) => void}
 */
export function createDshToastNotifier(ctx) {
  return function dshToastNotifier({ title, message, warning, taskId, conversationId, cwd, runtime, config }) {
    if (config?.stall?.toast === false || process.platform !== 'win32' || !cwd) return
    const rt = runtime ?? (ctx ? createDshRuntime(ctx) : undefined)
    if (!rt || typeof rt.spawn !== 'function') return
    try {
      const spawned = rt.spawn({
        argv: [
          ...defaultShellArgv(),
          stallToastScript(title, message),
        ],
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
        graceMs: config?.graceMs ?? 5000,
      })
      Promise.resolve(spawned?.done).catch(() => {})
    } catch {}
  }
}
