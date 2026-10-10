import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { loadConfig, resolveDeadline } from './config.mjs'
import { defaultActiveRuns, RunsLedger, TaskBusyError } from './ledger.mjs'
import { isProcessAlive, readLiveRecord, removeLiveRecord, writeLiveRecord } from './live.mjs'
import { defaultShellArgv, evaluateBaseline, runVerify } from './verify.mjs'
import { getWorker, resolveWorkerSelection } from './worker/index.mjs'
import { readHealthState, updateHealthState, recordWorkerOutcome, snapshotHealth } from './worker/health.mjs'
import { classifyFaultKind } from './worker/faults.mjs'
import { buildAgyArgv, extractConversationId, extractDurationMs, extractUsage, mapAgyResult, parseAgyJson } from './worker/agy.mjs'
import { createStallMonitor, appendStallRecord } from './stall-monitor.mjs'
import { toLosslessJson } from './lossless.mjs'

/**
 * 进程级活运行句柄表。按 task_id 索引。
 * @type {Map<string, { taskId: string, runId: string, startedAt: number, round: number, continuing: boolean, dispose: () => Promise<void>, terminate?: () => Promise<void>, kill?: (note?: string, ledger?: object) => Promise<void>, resultPromise?: Promise<any> }>}
 */
export const liveRunHandles = new Map()
export const liveRuns = liveRunHandles

/**
 * 列出当前所有活运行（供面板或 RPC 查看）。
 *
 * @returns {Array<{ task_id: string, round: number, startedAt: number, status: 'running', verdict: null, changedFileCount: 0, durationMs: number, totalTokens: null }>}
 */
export function listLiveRuns() {
  const now = Date.now()
  return [...liveRunHandles.values()].map(h => ({
    task_id: h.taskId,
    round: h.round || 1,
    startedAt: h.startedAt,
    status: 'running',
    verdict: null,
    changedFileCount: 0,
    totalTokens: null,
    durationMs: now - h.startedAt,
  }))
}

export function listActiveRuns() {
  const now = Date.now()
  return [...liveRunHandles.values()].map(h => ({
    taskId: h.taskId,
    runId: h.runId,
    startedAt: h.startedAt,
    round: h.round || 1,
    continuing: h.continuing || false,
    elapsedMs: now - h.startedAt,
  }))
}

/**
 * 终止指定 task_id 的活运行。
 *
 * @param {string} taskId
 * @param {RunsLedger} [ledger]
 * @param {object} [config]
 * @returns {Promise<{ ok: boolean, taskId: string, runId?: string, reason?: string }>}
 */
export async function abortActiveRun(taskId, ledger, config) {
  const handle = liveRunHandles.get(taskId)
  if (handle !== undefined) {
    try {
      if (typeof handle.kill === 'function') {
        await handle.kill('aborted-by-panel', ledger)
      } else if (typeof handle.dispose === 'function') {
        await handle.dispose()
      } else if (typeof handle.terminate === 'function') {
        await handle.terminate()
      }

      if (handle.resultPromise) {
        await handle.resultPromise.catch(() => {})
      }

      const rawDir = config?.rawDir || loadConfig().rawDir
      await removeLiveRecord(rawDir, taskId).catch(() => {})
      return { ok: true, taskId, runId: handle.runId }
    } catch (err) {
      console.warn('[wolfpack] abortActiveRun error (ignored):', err)
      return { ok: false, taskId, reason: err?.message || String(err) }
    }
  }

  // 查不到进程内登记，查磁盘 live 登记文件（跨进程杀）
  const rawDir = config?.rawDir || loadConfig().rawDir
  const fileRecord = await readLiveRecord(rawDir, taskId)
  if (!fileRecord) {
    return { ok: false, taskId, reason: `task_id "${taskId}" 当前没有正在运行的 agy（可能已经结束）` }
  }

  const pidAlive = isProcessAlive(fileRecord.pid)
  const workerAlive = fileRecord.workerPid ? isProcessAlive(fileRecord.workerPid) : false

  if (!pidAlive && !workerAlive) {
    await removeLiveRecord(rawDir, taskId).catch(() => {})
    return { ok: false, taskId, reason: '该运行已结束' }
  }

  try {
    if (fileRecord.workerPid && workerAlive) {
      try { process.kill(fileRecord.workerPid, 'SIGKILL') } catch {}
    }
    if (fileRecord.pid && pidAlive) {
      try { process.kill(fileRecord.pid, 'SIGKILL') } catch {}
    }
    await removeLiveRecord(rawDir, taskId).catch(() => {})
    if (ledger) {
      await ledger.record({
        taskId,
        stopReason: 'aborted',
        note: 'killed-cross-process',
        changedFilesDetermined: false,
      })
    }
    return { ok: true, taskId, runId: fileRecord.runId }
  } catch (err) {
    return { ok: false, taskId, reason: err?.message || String(err) }
  }
}

export async function killRun(taskId, ledger, config) {
  return abortActiveRun(taskId, ledger, config)
}

let defaultRuntime = undefined

export function setDefaultRuntime(rt) {
  defaultRuntime = rt
}

export function getDefaultRuntime() {
  return defaultRuntime
}

/**
 * 辅助获取适配后的 Runtime 对象。未注入时默认使用注入的宿主无关 node runtime。
 * 绝不隐式回退到任何特定宿主（如 DSH）的运行时。
 */
export function resolveRuntime(runtimeOrCtx) {
  if (runtimeOrCtx && typeof runtimeOrCtx.spawn === 'function') {
    return runtimeOrCtx
  }
  return defaultRuntime
}

/**
 * 拍摄 git 状态快照。
 *
 * @param {object} runtimeOrCtx
 * @param {string} cwd
 * @param {AbortSignal} [signal]
 * @param {number} [graceMs]
 * @returns {Promise<Set<string>|undefined>}
 */
export async function gitStatusSet(runtimeOrCtx, cwd = process.cwd(), signal, graceMs = 5000) {
  const rt = resolveRuntime(runtimeOrCtx)
  if (!rt || typeof rt.spawn !== 'function') return undefined

  try {
    const handle = rt.spawn({
      argv: ['git', 'status', '--porcelain'],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 * 1024 },
        stderr: { maxBytes: 16 * 1024 },
      },
      graceMs,
      signal,
    })

    const outcome = await handle.done
    if (outcome?.exitCode !== 0 || outcome?.error) {
      return undefined
    }

    const text = handle.collected?.stdout?.readFrom(0)?.text || ''
    const files = new Set()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const rest = line.slice(3).trim()
      const arrow = rest.lastIndexOf(' -> ')
      const p = arrow === -1 ? rest : rest.slice(arrow + 4)
      files.add(p.replace(/^"|"$/g, ''))
    }
    return files
  } catch {
    return undefined
  }
}

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.dsh',
  '.vscode',
  '.idea',
  'dist',
  'build',
  '.turbo',
  '.next',
  '.cache',
])

/**
 * 在没有 git 时的文件系统快照（记录相对路径 -> {mtimeMs, size}）。
 *
 * @param {string} cwd
 * @param {{maxFiles?: number}} [options]
 * @returns {Promise<Map<string, {mtimeMs: number, size: number}>|undefined>}
 */
export async function fsSnapshot(cwd = process.cwd(), { maxFiles = 10_000 } = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  try {
    const s = await stat(cwd)
    if (!s.isDirectory()) return undefined
  } catch {
    return undefined
  }

  const snapshot = new Map()

  async function walk(dir, rel) {
    if (snapshot.size >= maxFiles) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (snapshot.size >= maxFiles) break
      const name = entry.name
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue
        const subRel = rel === '' ? name : `${rel}/${name}`
        await walk(join(dir, name), subRel)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const filePath = join(dir, name)
        const fileRel = (rel === '' ? name : `${rel}/${name}`).replace(/\\/g, '/')
        try {
          const st = await stat(filePath)
          snapshot.set(fileRel, {
            mtimeMs: st.mtimeMs,
            size: st.size,
          })
        } catch {
          // 忽略无权限或已删除文件
        }
      }
    }
  }

  try {
    await walk(cwd, '')
    return snapshot
  } catch {
    return undefined
  }
}

/**
 * 拍摄工作区产物快照：优先 git，非 git 目录回退到文件系统快照。
 *
 * @param {object} runtimeOrCtx
 * @param {string} [cwd]
 * @param {AbortSignal} [signal]
 * @param {number} [graceMs]
 * @returns {Promise<{kind: 'git', data: Set<string>, root: string} | {kind: 'fs', data: Map<string, {mtimeMs: number, size: number}>, root: string} | undefined>}
 */
export async function takeArtifactSnapshot(runtimeOrCtx, cwd = process.cwd(), signal, graceMs = 5000) {
  const git = await gitStatusSet(runtimeOrCtx, cwd, signal, graceMs)
  if (git !== undefined) {
    return { kind: 'git', data: git, root: cwd }
  }
  const fs = await fsSnapshot(cwd)
  if (fs !== undefined) {
    return { kind: 'fs', data: fs, root: cwd }
  }
  return undefined
}

/**
 * 计算前后快照差集。
 *
 * @param {Set<string>|Map<string, {mtimeMs: number, size: number}>|{kind: string, data: any}|undefined} before
 * @param {Set<string>|Map<string, {mtimeMs: number, size: number}>|{kind: string, data: any}|undefined} after
 * @returns {{ determined: boolean, changed: boolean, summary: string, files: string[], root?: string }}
 */
export function diffArtifacts(before, after) {
  const root = after?.root ?? before?.root
  if (after === undefined) {
    return { determined: false, changed: false, summary: '', files: [], root }
  }

  // 1. git 快照（Set 或 { kind: 'git', data: Set }）
  if (after instanceof Set || after?.kind === 'git') {
    const afterSet = after instanceof Set ? after : after.data
    const baseSet = (before instanceof Set ? before : before?.data) ?? new Set()
    const files = [...afterSet].filter(file => !baseSet.has(file))
    files.sort()
    return {
      determined: true,
      changed: files.length > 0,
      summary: files.length === 0 ? '' : `${files.length} 个文件：${files.slice(0, 10).join(', ')}`,
      files,
      root,
    }
  }

  // 2. 文件系统快照（Map 或 { kind: 'fs', data: Map }）
  if (after instanceof Map || after?.kind === 'fs') {
    const afterMap = after instanceof Map ? after : after.data
    const baseMap = (before instanceof Map ? before : before?.data) ?? new Map()
    const changed = []
    for (const [file, info] of afterMap) {
      const prev = baseMap.get(file)
      if (!prev || prev.mtimeMs !== info.mtimeMs || prev.size !== info.size) {
        changed.push(file)
      }
    }
    for (const file of baseMap.keys()) {
      if (!afterMap.has(file)) {
        changed.push(file)
      }
    }
    changed.sort()
    return {
      determined: changed.length > 0,
      changed: changed.length > 0,
      summary: changed.length === 0 ? '' : `${changed.length} 个文件：${changed.slice(0, 10).join(', ')}`,
      files: changed,
      root,
    }
  }

  return { determined: false, changed: false, summary: '', files: [], root }
}

/**
 * 判定文件是否逃逸出工作区根。
 *
 * @param {string} filePath
 * @param {string} root
 * @returns {boolean}
 */
export function isPathOutsideRoot(filePath, root) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false
  const norm = filePath.replace(/\\/g, '/')
  if (norm.startsWith('../') || norm === '..' || norm.includes('/../')) return true
  if (!root) return isAbsolute(filePath)
  try {
    const resolvedRoot = resolve(root)
    const resolvedTarget = resolve(root, filePath)
    const rel = relative(resolvedRoot, resolvedTarget)
    if (isAbsolute(rel)) return true
    if (rel.startsWith('..') || rel === '..') return true
    return false
  } catch {
    return true
  }
}

/**
 * 检查声称改动与探测改动。
 *
 * @param {string[]|undefined} claimedFiles
 * @param {string} cwd
 * @returns {{ outsideFiles: string[], isOutside: boolean }}
 */
export function checkClaimedFiles(claimedFiles, cwd) {
  if (!Array.isArray(claimedFiles)) return { outsideFiles: [], isOutside: false }
  const outside = []
  for (const f of claimedFiles) {
    if (isPathOutsideRoot(f, cwd)) {
      outside.push(f)
    }
  }
  return { outsideFiles: outside, isOutside: outside.length > 0 }
}

/**
 * 决定本轮是续跑还是冷启动。
 *
 * @param {object} params
 * @param {object} params.config
 * @param {object} [params.previous]
 * @param {boolean} [params.forceFresh]
 * @returns {{ conversationId: string | undefined, round: number, continuing: boolean, freshReason: string | undefined }}
 */
export function resolveContinuation({ config, previous, forceFresh, workerName }) {
  const round = (previous?.round ?? 0) + 1
  const priorId = typeof previous?.conversationId === 'string' && previous.conversationId !== ''
    ? previous.conversationId
    : undefined

  if (config.continuation === 'never') {
    return { conversationId: undefined, round, continuing: false, freshReason: 'continuation-disabled' }
  }
  if (forceFresh === true) {
    return { conversationId: undefined, round, continuing: false, freshReason: 'forced-fresh' }
  }
  if (!priorId) {
    return { conversationId: undefined, round, continuing: false, freshReason: undefined }
  }

  // 硬轮数上限
  if (typeof config.maxRoundsPerTask === 'number' && config.maxRoundsPerTask > 0 && (previous?.round ?? 0) >= config.maxRoundsPerTask) {
    return { conversationId: undefined, round, continuing: false, freshReason: `max-rounds(${config.maxRoundsPerTask})` }
  }

  // 累计 token 预算
  const budget = config.continuationTokenBudget
  const used = typeof previous?.totalTokens === 'number' && Number.isFinite(previous.totalTokens) ? previous.totalTokens : 0
  if (typeof budget === 'number' && budget > 0 && used >= budget) {
    return {
      conversationId: undefined,
      round,
      continuing: false,
      freshReason: `token-budget(已用 ${used} ≥ ${budget})`,
    }
  }

  // 未知用量兜底轮数
  const unknownCap = typeof config.unknownUsageRoundCap === 'number' ? config.unknownUsageRoundCap : 20
  const missingRounds = typeof previous?.usageMissingRounds === 'number' ? previous.usageMissingRounds : 0
  if (unknownCap > 0 && missingRounds >= unknownCap) {
    return {
      conversationId: undefined,
      round,
      continuing: false,
      freshReason: `unknown-usage-round-cap(${unknownCap})`,
    }
  }

  // 工人变更：绝不复用另一个工人的会话 ID（会话 ID 只在各自 CLI 里有效）
  const previousWorker = typeof previous?.worker === 'string' && previous.worker !== ''
    ? previous.worker
    : undefined
  if (previousWorker && workerName && previousWorker !== workerName) {
    return {
      conversationId: undefined,
      round,
      continuing: false,
      freshReason: `worker-changed(${previousWorker}→${workerName})`,
    }
  }

  return { conversationId: priorId, round, continuing: true, freshReason: undefined }
}

/**
 * 规范化命令列表。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeCommands(value) {
  if (Array.isArray(value)) {
    return value.filter(c => typeof c === 'string' && c.trim() !== '')
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return [value.trim()]
  }
  return []
}

/**
 * 保存原始 JSON 输出至磁盘。
 *
 * @param {string} baseDir
 * @param {string} taskId
 * @param {number} round
 * @param {string} raw
 * @returns {Promise<string|undefined>}
 */
export async function persistRaw(baseDir, taskId, round, raw) {
  if (!baseDir || !raw) return undefined
  const safe = String(taskId ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
  const targetDir = baseDir.endsWith('raw') ? baseDir : join(baseDir, 'raw')
  const path = join(targetDir, `${safe}-r${round}-${Date.now()}.json`)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, raw, 'utf8')
    return path
  } catch (error) {
    console.warn('wolfpack: 原始输出落盘失败', path, error)
    return undefined
  }
}

/**
 * 停滞监控支持。
 */
function startStallMonitor({ config, runtime, taskId, conversationId, cwd, toastNotifier }) {
  if (!config?.stallStoreRoot) {
    return { start: () => {}, stop: () => {}, snapshot: () => ({ warnings: 0 }) }
  }
  const stall = config.stall ?? {}
  const monitor = createStallMonitor({
    storeRoot: config.stallStoreRoot,
    conversationIds: conversationId === undefined ? [] : [conversationId],
    windowMs: stall.windowMs,
    maxWarnings: stall.maxWarnings,
    pollMs: stall.pollMs,
    onWarning: warning => reportStall({ config, runtime, cwd, taskId, conversationId, warning, toastNotifier }),
    onError: message => {
      try { console.warn(`[wolfpack] ${message}`) } catch {}
    },
  })
  monitor.start()
  return monitor
}

export async function reportStall({ config, runtime, cwd, taskId, conversationId, warning, toastNotifier }) {
  const minutes = Math.max(1, Math.round(warning.silentMs / 60_000))
  const label = taskId === undefined ? '(未命名任务)' : taskId
  const last = warning.level >= warning.maxWarnings
  const line = `[wolfpack] 疑似停滞 ${warning.level}/${warning.maxWarnings}：`
    + `${label} 已 ${minutes} 分钟没有任何进展。`
    + (last
      ? '此后不再报警；**不会自动终止**——要停请自己中断（Esc / 停会话）。'
      : '继续观察中，不会被自动终止。')
  try {
    console.warn(line)
  } catch {}

  const title = '狼群：agy 疑似停滞'
  const message = `${label} 已 ${minutes} 分钟无进展（第 ${warning.level}/${warning.maxWarnings} 次）。不会自动终止。`

  const record = {
    at: Date.now(),
    taskId,
    conversationId,
    level: warning.level,
    maxWarnings: warning.maxWarnings,
    silentMs: warning.silentMs,
    action: 'warn-only',
  }

  if (config?.stallLogPath) {
    await appendStallRecord(config.stallLogPath, record)
  }

  const notifier = toastNotifier
    ?? config?.stallToastNotifier
    ?? config?.toastNotifier
    ?? config?.stallToast
    ?? config?.stall?.toastNotifier
    ?? config?.stall?.notifier

  if (typeof notifier === 'function') {
    try {
      notifier({
        title,
        message,
        line,
        warning,
        taskId,
        conversationId,
        cwd,
        runtime,
        config,
        minutes,
        record,
      })
    } catch {}
  }
}

/**
 * 启动 agy 并返回运行句柄（供 AgyProvider 与委派工具共用）。
 *
 * @param {object} params
 * @param {object} [params.runtime]
 * @param {object} [params.ctx]
 * @param {object} params.config
 * @param {string} params.taskId
 * @param {string} [params.cwd]
 * @param {string} params.task
 * @param {AbortSignal} [params.signal]
 * @param {boolean} [params.forceFresh]
 * @param {ActiveRunRegistry} [params.registry]
 * @returns {Promise<{
 *   taskId: string,
 *   runId: string,
 *   startedAt: number,
 *   round: number,
 *   continuing: boolean,
 *   result: Promise<any>,
 *   dispose: () => Promise<void>,
 *   kill: (note?: string, ledger?: object) => Promise<void>,
 * }>}
 */
export async function startAgy({
  runtime,
  ctx,
  config,
  taskId,
  cwd = process.cwd(),
  task,
  signal,
  forceFresh,
  registry = defaultActiveRuns,
  deadline: explicitDeadline,
  toastNotifier,
}) {
  const rt = resolveRuntime(runtime ?? config?.runtime ?? ctx)
  if (!rt || typeof rt.spawn !== 'function') {
    throw new Error('wolfpack: subprocess 服务不可用，无法启动子进程')
  }

  if (typeof config?.agyUnavailable === 'string' && config.agyUnavailable !== '') {
    throw new Error(
      `wolfpack/agy: agy 不可用（挂载期预检未通过）：${config.agyUnavailable}。`
      + '本次委派没有启动任何进程，也没有消耗配额；'
      + '修好 agy（或把 WOLFPACK_AGY 指向正确的可执行文件）之后再派。',
    )
  }

  const runId = randomUUID()
  const active = registry ?? config?.activeRuns ?? defaultActiveRuns
  const claimed = taskId === undefined ? false : (active.claim(taskId, runId), true)

  const theLedger = config.ledger ?? (config.ledgerPath ? new RunsLedger(config.ledgerPath, config) : undefined)
  const previous = theLedger && taskId !== undefined ? await theLedger.latest(taskId) : undefined

  let killed = false
  let killNote = undefined
  let targetLedger = theLedger

  const deadline = explicitDeadline ?? resolveDeadline(config.timeoutMs)
  const graceMs = config.graceMs ?? 5_000

  let timedOut = false
  const timeoutController = new AbortController()
  const timer = deadline === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true
        timeoutController.abort()
      }, deadline)
  timer?.unref?.()

  const mergedSignal = deadline === undefined
    ? signal
    : (signal === undefined ? timeoutController.signal : AbortSignal.any([signal, timeoutController.signal]))

  const before = await takeArtifactSnapshot(rt, cwd, mergedSignal, graceMs)

  // 工人健康台账与工人挑选
  const healthPath = config.workerHealth?.filePath
  const healthEnabled = config.workerHealth?.enabled !== false && typeof healthPath === 'string' && healthPath !== ''
  const healthState = healthEnabled ? await readHealthState(healthPath) : undefined
  const previousWorker = previous?.worker
  const selection = resolveWorkerSelection({ config, previousWorker, health: healthState })
  const worker = getWorker(selection.name)

  const continuation = resolveContinuation({ config, previous, forceFresh, workerName: worker.name })

  const argv = worker.buildArgv(config, {
    task,
    sessionId: continuation.conversationId,
    timeoutMs: config.taskTimeoutMs,
  })

  const handle = rt.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxStdoutBytes ?? (8 * 1024 * 1024), spill: { maxBytes: config.maxSpillBytes ?? (256 * 1024 * 1024) } },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs,
    signal: mergedSignal,
  })

  const stall = startStallMonitor({
    config,
    runtime: rt,
    taskId,
    conversationId: continuation.conversationId,
    cwd,
    toastNotifier: toastNotifier ?? config?.stallToastNotifier ?? config?.toastNotifier ?? config?.stallToast,
  })

  const startedAt = Date.now()

  const dispose = async () => {
    if (timer) clearTimeout(timer)
    if (typeof handle.terminate === 'function') {
      await handle.terminate()
    }
    if (typeof handle.waitForExit === 'function') {
      await handle.waitForExit()
    }
  }

  const kill = async (note = 'aborted-by-panel', overrideLedger) => {
    killed = true
    killNote = note
    if (overrideLedger) targetLedger = overrideLedger
    await dispose()
  }

  const resultPromise = (async () => {
    try {
      const outcome = await handle.done
      const endedAt = Date.now()
      const processElapsedMs = Math.max(0, endedAt - startedAt)

      const stdout = handle.collected?.stdout?.readFrom(0)
      const stdoutText = stdout?.text ?? ''
      const stderrText = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      const stdoutSpillPath = stdout?.spillPath

      const after = await takeArtifactSnapshot(rt, cwd, undefined, graceMs)
      const artifacts = diffArtifacts(before, after)
      if (!artifacts.root) artifacts.root = cwd

      const isAborted = signal?.aborted === true || killed

      const parsed = typeof worker.parse === 'function' ? worker.parse(stdoutText) : parseAgyJson(stdoutText)
      const mapped = typeof worker.classify === 'function'
        ? worker.classify({
            parsed,
            exitCode: outcome?.exitCode,
            artifacts,
            timedOut,
            cancelled: isAborted,
            signal: outcome?.signal,
            raw: stdoutText,
            stderr: stderrText,
          })
        : mapAgyResult(stdoutText, outcome, artifacts, {
            aborted: isAborted,
            timedOut,
            spillPath: stdoutSpillPath,
            cwd,
            stderr: stderrText,
          })

      const nextConversationId = (typeof worker.extractSessionId === 'function'
        ? worker.extractSessionId(stdoutText)
        : extractConversationId(stdoutText)) ?? continuation.conversationId
      const usage = parsed?.usage ?? extractUsage(stdoutText)
      const durationMs = parsed?.durationSeconds
        ? Math.round(parsed.durationSeconds * 1000)
        : extractDurationMs(stdoutText, processElapsedMs)
      const stallWarnings = stall.snapshot().warnings

      let note
      if (killed) {
        note = killNote ?? 'aborted-by-panel'
      } else if (timedOut) {
        note = 'timed-out'
      } else if (signal?.aborted === true) {
        note = 'aborted-by-signal'
      } else {
        note = continuation.continuing ? 'continued' : (continuation.freshReason ?? 'cold-start')
      }

      const rawBaseDir = targetLedger ? dirname(targetLedger.filePath) : config.rawDir
      const rawPath = await persistRaw(
        rawBaseDir,
        taskId,
        continuation.round,
        stdoutText
      )

      if (targetLedger && taskId !== undefined) {
        await targetLedger.record({
          taskId,
          worker: worker.name,
          round: continuation.round,
          conversationId: nextConversationId,
          cwd,
          stopReason: mapped.stopReason,
          changedFiles: artifacts.files,
          changedFilesDetermined: artifacts.determined,
          durationMs,
          ...(usage === undefined ? {} : {
            tokens: usage.total,
            cacheReadTokens: usage.cacheRead,
            turns: usage.turns,
          }),
          note,
          ...(stallWarnings === 0 ? {} : { stallWarnings }),
        })
      }

      // 工人健康记账
      const faultTexts = [
        typeof parsed?.error === 'string' ? parsed.error : undefined,
        typeof parsed?.response === 'string' ? parsed.response.slice(0, 500) : undefined,
        typeof stderrText === 'string' ? stderrText.slice(0, 2000) : undefined,
      ].filter(text => typeof text === 'string' && text !== '')
      const faultKind = classifyFaultKind({
        stopReason: mapped.stopReason,
        timedOut: timedOut === true,
        cancelled: isAborted,
        outputEmpty: stdoutText.trim() === '',
        status: typeof parsed?.apiStatus === 'number' ? parsed.apiStatus : undefined,
        texts: faultTexts,
        raw: stdoutText,
      })
      const outcomeKind = mapped.stopReason === 'completed' ? 'success' : (faultKind ?? 'neutral')
      let workerHealth = { worker: worker.name, benched: false }
      if (healthEnabled) {
        const recorded = await updateHealthState(healthPath, state => recordWorkerOutcome(state, {
          worker: worker.name,
          kind: outcomeKind,
          stopReason: mapped.stopReason,
          diagnostic: mapped.diagnostic,
          config,
        }))
        workerHealth = snapshotHealth(recorded, worker.name)
      }

      const isOutsideRoot = mapped.reconciliation?.status === 'undetermined' &&
        (mapped.reconciliation?.outsideFiles?.length > 0 || mapped.reconciliation?.findings?.[0]?.includes('不在被探测的工作区内'))

      const artifactsDetermined = (artifacts.determined === false || (isOutsideRoot && (artifacts.files ?? []).length === 0))
        ? false
        : artifacts.determined

      const artifactsUndeterminedReason = isOutsideRoot
        ? '声称的文件不在被探测的工作区内'
        : (artifacts.determined === false ? '工作目录不是 git 仓库' : undefined)

      const reportText = typeof mapped.report === 'string'
        ? mapped.report
        : (Array.isArray(mapped.output) ? mapped.output.map(b => b.text).join('\n') : '')

      return {
        taskId,
        worker: worker.name,
        workerReason: selection.reason,
        round: continuation.round,
        continuing: continuation.continuing,
        freshReason: continuation.freshReason,
        conversationId: nextConversationId,
        stopReason: mapped.stopReason,
        capacity: mapped.capacity === true,
        report: reportText,
        diagnostic: mapped.diagnostic,
        changedFiles: artifacts.files,
        artifactsDetermined,
        artifactsUndeterminedReason,
        durationMs,
        usage,
        spillPath: stdoutSpillPath,
        rawPath,
        expired: timedOut,
        structured: mapped.structured,
        claimedFiles: mapped.claimedFiles,
        reconciliation: mapped.reconciliation,
        stall: stall.snapshot(),
        workerHealth,
        benched: selection.benched,
        benched_skipped: selection.benched_skipped,
        benched_workers: selection.benched_skipped,
        all_benched: selection.all_benched,
        selection,
        mapped,
        artifacts,
        outcome,
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (claimed) active.release(taskId, runId)
      if (taskId !== undefined) liveRunHandles.delete(taskId)
      stall.stop()
    }
  })()

  if (taskId !== undefined) {
    const liveHandle = {
      taskId,
      runId,
      startedAt,
      worker: worker.name,
      workerReason: selection.reason,
      round: continuation.round,
      continuing: continuation.continuing,
      dispose,
      kill,
      resultPromise,
    }
    liveRunHandles.set(taskId, liveHandle)
  }

  return {
    taskId,
    runId,
    startedAt,
    worker: worker.name,
    workerReason: selection.reason,
    round: continuation.round,
    continuing: continuation.continuing,
    freshReason: continuation.freshReason,
    result: resultPromise,
    dispose,
    kill,
  }
}

/**
 * 裸命令名在 PATH 上的候选绝对路径。
 *
 * 只有「不含路径分隔符」的名字才按 PATH 展开（Windows 再按 PATHEXT 补扩展名）；
 * 显式路径原样返回，由调用方决定存在与否。
 *
 * @param {string} name - 可执行文件名或路径
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} 候选路径，按查找顺序
 */
export function executableCandidates(name, env = process.env) {
  if (typeof name !== 'string' || name.trim() === '') return []
  if (name.includes('/') || name.includes('\\')) return [name]
  const windows = process.platform === 'win32'
  const extensions = windows
    ? (name.includes('.') ? [''] : String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : ['']
  const directories = String(env.PATH ?? '').split(windows ? ';' : ':').filter(directory => directory.trim() !== '')
  const candidates = []
  for (const directory of directories) {
    for (const extension of extensions) candidates.push(join(directory, name + extension))
  }
  return candidates
}

/**
 * 预检查 agy 是否可用。
 *
 * 裸命令名（默认的 `agy.exe` / `agy`）按 PATH 查找——`existsSync('agy.exe')` 只会查
 * 当前工作目录，会把装在 PATH 上的工人误判成不存在。
 *
 * @param {string|object} agyPathOrOptions
 * @param {(path: string) => boolean} [exists]
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ok: true, path: string}|{ok: false, path: string, reason: string}}
 */
export function preflightAgy(agyPathOrOptions, exists = existsSync, env = process.env) {
  let agyPath = agyPathOrOptions
  if (agyPathOrOptions && typeof agyPathOrOptions === 'object') {
    agyPath = agyPathOrOptions.config?.agyPath || agyPathOrOptions.agyPath
  }
  if (typeof agyPath !== 'string' || agyPath.trim() === '') {
    return { ok: false, path: '', reason: 'agy 路径为空：既没有 WOLFPACK_AGY，也没有可用的默认路径' }
  }
  const probe = candidate => {
    try {
      return exists(candidate) === true
    } catch {
      return false
    }
  }
  const resolved = executableCandidates(agyPath, env).find(probe)
  return resolved !== undefined
    ? { ok: true, path: resolved }
    : { ok: false, path: agyPath, reason: `agy 可执行文件不存在：${agyPath}（显式路径按原样判定，裸命令名已查 PATH）` }
}

function omitUndefined(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/**
 * 一条验收/基线结果 → lossless JSON（可选字段靠缺席表达）。
 *
 * @param {Record<string, any>} check
 * @returns {Record<string, unknown>}
 */
export function mapCheck(check) {
  return omitUndefined({
    command: check.command,
    ran: check.ran,
    ok: check.ok,
    exit_code: check.exitCode === null ? undefined : check.exitCode,
    tail: check.tail === '' ? undefined : check.tail,
    timed_out: check.timedOut ? true : undefined,
    signals: check.signals === undefined ? undefined : omitUndefined({
      items: check.signals.items?.map(item => ({ kind: item.kind, text: item.text })) ?? [],
      degraded: check.signals.degraded,
    }),
    error: check.error,
  })
}

/**
 * 执行一次完整委派任务（含基线闸门、启动工人、验收与 verdict）。
 *
 * @param {object} params
 * @param {object} [params.runtime]
 * @param {object} [params.ctx]
 * @param {object} params.config
 * @param {object} params.args - task_id, task, verify, verify_baseline, fresh, model
 * @param {string} [params.cwd]
 * @param {AbortSignal} [params.signal]
 * @param {RunsLedger} [params.ledger]
 * @param {ActiveRunRegistry} [params.registry]
 * @param {object} [params.exec]
 * @param {number} [params.verifyDeadline]
 * @param {number} [params.toolDeadlineMs]
 * @returns {Promise<Record<string, any>>}
 */
export async function runDelegateTask({
  runtime,
  ctx,
  config,
  args,
  cwd,
  signal,
  ledger,
  registry = defaultActiveRuns,
  exec,
  verifyDeadline,
  toolDeadlineMs,
  toastNotifier,
}) {
  const taskId = args?.task_id
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('[wolfpack/delegate] task_id 必须是非空字符串')
  }
  const task = args?.task
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error('[wolfpack/delegate] task 任务书必须是非空字符串')
  }

  const rt = resolveRuntime(runtime ?? config?.runtime ?? ctx)
  if (!rt || typeof rt.spawn !== 'function') {
    throw new Error('wolfpack: subprocess 服务不可用，无法执行委派任务')
  }

  const targetCwd = cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd()
  const targetSignal = signal ?? exec?.signal
  const theLedger = ledger ?? config?.ledger ?? (config?.ledgerPath ? new RunsLedger(config.ledgerPath, config) : undefined)
  const baselineCommands = normalizeCommands(args.verify_baseline)
  const verifyCommands = normalizeCommands(args.verify)
  const effVerifyTimeout = verifyDeadline ?? config?.verifyTimeoutMs

  // 1. 基线闸门
  let baselineChecks = []
  if (baselineCommands.length > 0) {
    baselineChecks = await runVerify({
      runtime: rt,
      ctx,
      cwd: targetCwd,
      commands: baselineCommands,
      signal: targetSignal,
      shellArgv: config?.shellArgv ?? defaultShellArgv(config?.shell),
      timeoutMs: effVerifyTimeout,
      graceMs: config?.graceMs,
    })
    const evalResult = evaluateBaseline(baselineChecks)
    if (evalResult.decision !== 'proceed') {
      const prev = theLedger ? await theLedger.latest(taskId) : undefined
      const round = (prev?.round ?? 0)
      const verdict = evalResult.decision === 'stale' ? 'stale' : 'error'

      if (theLedger) {
        await theLedger.record({
          taskId,
          round,
          verdict,
          stopReason: 'skipped',
          note: `baseline-${evalResult.decision}`,
          changedFilesDetermined: false,
        })
      }

      return omitUndefined({
        task_id: taskId,
        round,
        continued: false,
        stop_reason: 'skipped',
        report: '',
        changed_files: [],
        changed_files_determined: false,
        verify: [],
        verify_registered_count: verifyCommands.length,
        baseline: baselineChecks.map(mapCheck),
        verdict,
        diagnostic: evalResult.reason,
        tool_deadline_ms: toolDeadlineMs ?? config?.taskTimeoutMs ?? undefined,
      })
    }
  }

  // 2. 启动工人
  const effectiveWorkersEnabled = config?.workersEnabled !== undefined
    ? config.workersEnabled
    : ((config?.agy_enabled !== undefined || config?.claude_enabled !== undefined)
        ? (() => {
            const agyRaw = config.agy_enabled
            const claudeRaw = config.claude_enabled
            const agyVal = agyRaw !== null && typeof agyRaw === 'object' && typeof agyRaw.get === 'function' ? agyRaw.get() : agyRaw
            const claudeVal = claudeRaw !== null && typeof claudeRaw === 'object' && typeof claudeRaw.get === 'function' ? claudeRaw.get() : claudeRaw
            const agyOn = agyVal !== undefined ? (agyVal !== false && String(agyVal).trim().toLowerCase() !== 'false') : true
            const claudeOn = claudeVal !== undefined ? (claudeVal === true || String(claudeVal).trim().toLowerCase() === 'true') : false
            if (agyOn && claudeOn) return undefined
            if (agyOn) return ['agy']
            if (claudeOn) return ['claude']
            return []
          })()
        : undefined)

  const workerConfig = {
    ...config,
    ledger: theLedger,
    ...(args.model ? { model: args.model } : {}),
    ...(effectiveWorkersEnabled !== undefined ? { workersEnabled: effectiveWorkersEnabled } : {}),
  }

  const agyRun = await startAgy({
    runtime: rt,
    ctx,
    config: workerConfig,
    taskId,
    cwd: targetCwd,
    task,
    signal: targetSignal,
    forceFresh: args.fresh === true,
    registry,
    deadline: toolDeadlineMs,
    toastNotifier: toastNotifier ?? config?.stallToastNotifier,
  })

  const runResult = await agyRun.result
  const {
    mapped,
    artifacts,
    round,
    continuing,
    freshReason,
    conversationId,
    durationMs,
    rawPath,
    spillPath,
    stall,
    artifactsDetermined,
    artifactsUndeterminedReason,
  } = runResult

  // 3. 验收命令
  const verifyChecks = verifyCommands.length > 0
    ? await runVerify({
        runtime: rt,
        ctx,
        cwd: targetCwd,
        commands: verifyCommands,
        signal: targetSignal,
        shellArgv: config?.shellArgv ?? defaultShellArgv(config?.shell),
        timeoutMs: effVerifyTimeout,
        graceMs: config?.graceMs,
      })
    : []

  const executed = verifyChecks.filter(c => c.ran)
  const verdict = verifyChecks.length === 0
    ? 'unverified'
    : executed.length === 0
      ? 'error'
      : executed.every(c => c.ok) ? 'pass' : 'fail'

  // 4. 机械验收救回（自报 ERROR 但验收全过）
  const verifiedClean = executed.length > 0 && executed.every(c => c.ok)
  const salvaged = runResult.stopReason === 'error' && verifiedClean
  const stopReason = salvaged ? 'completed' : runResult.stopReason
  const diagnostic = salvaged
    ? [runResult.diagnostic, `${runResult.worker || 'agy'} 自报失败，但机械验收全部通过，判为完成`].filter(Boolean).join('｜')
    : runResult.diagnostic

  // 机械验收救回时回写健康台账为 success
  const healthPath = config.workerHealth?.filePath
  const healthEnabled = config.workerHealth?.enabled !== false && typeof healthPath === 'string' && healthPath !== ''
  let workerHealth = runResult.workerHealth
  if (salvaged && healthEnabled && runResult.worker) {
    const recorded = await updateHealthState(healthPath, state => recordWorkerOutcome(state, {
      worker: runResult.worker,
      kind: 'success',
      stopReason: 'completed',
      config,
    }))
    workerHealth = snapshotHealth(recorded, runResult.worker)
  }

  // 5. 更新台账 verdict
  if (theLedger) {
    await theLedger.record({
      taskId,
      worker: runResult.worker,
      round,
      verdict,
      stopReason,
      note: 'verify',
    })
  }

  return toLosslessJson(omitUndefined({
    task_id: taskId,
    worker: runResult.worker,
    worker_reason: runResult.workerReason,
    round,
    continued: continuing,
    fresh_reason: freshReason,
    stop_reason: stopReason,
    capacity: runResult.capacity === true ? true : undefined,
    report: runResult.report,
    changed_files: runResult.changedFiles,
    changed_files_determined: artifactsDetermined,
    changed_files_undetermined_reason: artifactsUndeterminedReason,
    verify: verifyChecks.map(mapCheck),
    verify_registered_count: verifyCommands.length,
    baseline: baselineChecks.length > 0 ? baselineChecks.map(mapCheck) : undefined,
    verdict,
    diagnostic,
    conversation_id: conversationId,
    raw_path: rawPath,
    spill_path: spillPath,
    duration_ms: durationMs,
    stall_warnings: stall?.warnings > 0 ? stall.warnings : undefined,
    tool_deadline_ms: toolDeadlineMs ?? config?.taskTimeoutMs ?? undefined,
    worker_health: workerHealth,
    benched: runResult.benched,
    benched_workers: runResult.benched_workers,
    benched_skipped: runResult.benched_skipped,
    all_benched: runResult.all_benched,
    health_note: runResult.all_benched === true
      ? 'all-benched'
      : (runResult.selection?.benched_ignored === true ? 'explicit-ignores-bench' : undefined),
  }))
}
