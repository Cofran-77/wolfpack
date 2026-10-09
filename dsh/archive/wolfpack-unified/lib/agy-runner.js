/**
 * agy-runner 兼容重导出薄壳 (≤ 2000 字节)。
 * 所有实现已收敛至 lib/core/**。
 */

import * as coreDel from './core/delegate.mjs'
import { createDshRuntime } from './runtime/dsh.mjs'

export const {
  abortActiveRun, checkClaimedFiles, diffArtifacts, fsSnapshot, gitStatusSet,
  isPathOutsideRoot, killRun, listActiveRuns, listLiveRuns, liveRunHandles,
  liveRuns, mapCheck, persistRaw, preflightAgy, resolveContinuation, takeArtifactSnapshot,
} = coreDel

export function startAgy(options = {}) {
  const runtime = options.runtime ?? (options.ctx ? createDshRuntime(options.ctx) : undefined)
  return coreDel.startAgy({ ...options, runtime })
}

export function runDelegateTask(options = {}) {
  const runtime = options.runtime ?? (options.ctx ? createDshRuntime(options.ctx) : undefined)
  return coreDel.runDelegateTask({ ...options, runtime })
}

export {
  buildAgyArgv, DEFAULT_AGY_PRINT_TIMEOUT_MS, DEFAULT_AGY_SCHEMA, DEFAULT_TASK_TIMEOUT_MS,
  DIAGNOSTIC_MAX_BYTES, DIGEST_MAX_CHARS, extractConversationId, extractDurationMs,
  extractUsage, isCapacityError, mapAgyResult, MAX_SPILL_BYTES, MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES, normalizeRelPath, parseStructuredReport, reconcileClaimedArtifacts,
} from './core/worker/agy.mjs'

export {
  DEFAULT_GRACE_MS, DEFAULT_VERIFY_TIMEOUT_MS, defaultShellArgv, evaluateBaseline,
  extractFailureSignals, FAILURE_SIGNAL_LIMIT, runVerify,
} from './core/verify.mjs'

export { resolveDeadline } from './core/config.mjs'
export { truncateBytes, truncateChars } from './core/digest.mjs'
