import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { loadConfig } from './config.mjs'
import { defaultActiveRuns, RunsLedger, TaskBusyError } from './ledger.mjs'
import { isProcessAlive, readLiveRecord, removeLiveRecord, writeLiveRecord } from './live.mjs'
import { killProcessTree, spawnProcess } from './spawn.mjs'
import { defaultShellArgv, evaluateBaseline, runVerify } from './verify.mjs'
import { getWorker, resolveWorkerSelection } from './worker/index.mjs'
import { classifyFaultKind } from './worker/faults.mjs'
import { readHealthState, recordWorkerOutcome, snapshotHealth, updateHealthState } from './worker/health.mjs'
import { getDefaultRuntime, resolveRuntime, setDefaultRuntime } from './runtime/registry.mjs'
import { appendStallRecord, createStallMonitor, resolveStallConfig } from './stall.mjs'

// 运行时注入：宿主在自己的入口注入实现（Node 见 src/runtime/node.mjs），
// 核心层只认 resolveRuntime 的结果；未注入时回退到内置 Node 实现。
export { getDefaultRuntime, resolveRuntime, setDefaultRuntime }

/**
 * 进程级活跃委派表，供 status、kill 与实时面板查看。
 * 每条记录都带 `worker`（本轮真实工人）与 `stallMonitor`（该工人自己的停滞监控），
 * 因此面板可以**按工人分区**展示。
 * @type {Map<string, {
 *   taskId: string, runId: string, startedAt: number, worker: string, workerReason?: string,
 *   cwd?: string, round?: number, continuing?: boolean, conversationId?: string,
 *   stallMonitor?: { snapshot: () => object }, terminate: () => Promise<void>
 * }>}
 */
export const liveRuns = new Map()

/**
 * 终止指定 task_id 的活跃委派。
 * 流程：先查进程内登记；查不到则查磁盘 live 登记文件；用进程树杀。
 *
 * @param {string} taskId
 * @param {RunsLedger} [ledger]
 * @param {object} [config]
 * @returns {Promise<{ ok: boolean, reason?: string, taskId: string, runId?: string }>}
 */
export async function killRun(taskId, ledger, config) {
  const active = liveRuns.get(taskId)
  if (active) {
    try {
      await active.terminate()
      const rawDir = config?.rawDir || loadConfig().rawDir
      await removeLiveRecord(rawDir, taskId).catch(() => {})
      if (ledger) {
        await ledger.record({
          taskId,
          stopReason: 'aborted',
          note: 'killed-by-codex',
          changedFilesDetermined: false,
        })
      }
      return { ok: true, taskId, runId: active.runId }
    } catch (err) {
      return { ok: false, taskId, reason: err?.message || String(err) }
    }
  }

  // 查不到进程内登记，查磁盘 live 登记文件
  const rawDir = config?.rawDir || loadConfig().rawDir
  const fileRecord = await readLiveRecord(rawDir, taskId)
  if (!fileRecord) {
    return { ok: false, taskId, reason: `任务 "${taskId}" 当前没有正在运行的工人` }
  }

  const pidAlive = isProcessAlive(fileRecord.pid)
  const workerAlive = fileRecord.workerPid ? isProcessAlive(fileRecord.workerPid) : false

  if (!pidAlive && !workerAlive) {
    // 登记文件存在但进程已不存在：如实报「该运行已结束」，并清理残留登记文件，不许谎报成功
    await removeLiveRecord(rawDir, taskId).catch(() => {})
    return { ok: false, taskId, reason: '该运行已结束' }
  }

  try {
    if (fileRecord.workerPid && workerAlive) {
      killProcessTree(fileRecord.workerPid)
    }
    if (fileRecord.pid && pidAlive) {
      killProcessTree(fileRecord.pid)
    }
    await removeLiveRecord(rawDir, taskId).catch(() => {})
    if (ledger) {
      await ledger.record({
        taskId,
        stopReason: 'aborted',
        note: 'killed-by-codex',
        changedFilesDetermined: false,
      })
    }
    return { ok: true, taskId, runId: fileRecord.runId }
  } catch (err) {
    return { ok: false, taskId, reason: err?.message || String(err) }
  }
}

/**
 * 拍摄 git 状态快照。
 *
 * @param {string} cwd
 * @param {object} [runtime] - 注入的运行时；不传则用默认运行时/内置 Node 实现
 * @returns {Promise<{ isGit: boolean, files: Set<string> }>}
 */
export async function takeArtifactSnapshot(cwd, runtime) {
  try {
    const rt = resolveRuntime(runtime)
    const spawnFn = typeof rt?.spawn === 'function' ? rt.spawn.bind(rt) : spawnProcess
    const proc = spawnFn({
      argv: ['git', 'status', '--porcelain'],
      cwd,
      timeoutMs: 10_000,
    })
    const outcome = await proc.done
    if (outcome.exitCode !== 0 || outcome.error) {
      return { isGit: false, files: new Set() }
    }
    const files = new Set()
    const text = proc.collected.stdout.text
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const rest = line.slice(3).trim()
      const arrow = rest.lastIndexOf(' -> ')
      const p = arrow === -1 ? rest : rest.slice(arrow + 4)
      files.add(p.replace(/^"|"$/g, ''))
    }
    return { isGit: true, files }
  } catch {
    return { isGit: false, files: new Set() }
  }
}

/**
 * 计算前后快照差集。
 *
 * @param {{ isGit: boolean, files: Set<string> }} before
 * @param {{ isGit: boolean, files: Set<string> }} after
 * @returns {{ determined: boolean, changed: boolean, summary: string, files: string[] }}
 */
export function diffArtifacts(before, after) {
  if (!before?.isGit || !after?.isGit) {
    return { determined: false, changed: false, summary: '', files: [] }
  }
  const changed = []
  for (const f of after.files) {
    if (!before.files.has(f)) {
      changed.push(f)
    }
  }
  changed.sort()
  return {
    determined: true,
    changed: changed.length > 0,
    summary: changed.length === 0 ? '' : `${changed.length} 个文件：${changed.slice(0, 10).join(', ')}`,
    files: changed,
  }
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
 * 解析本轮是续跑还是冷启动。
 *
 * @param {object} params
 * @param {object} params.config
 * @param {object} [params.previous]
 * @param {boolean} [params.forceFresh]
 * @returns {{ conversationId?: string, round: number, continuing: boolean, freshReason?: string }}
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
 * 上报一次疑似停滞。**只报警，永不终止**：写入停滞台账、打到控制台，并把
 * 桌面通知交给宿主注入的通知器（核心层不 import 任何宿主模块）。
 *
 * @param {object} params
 * @param {object} params.config
 * @param {string} params.workerName
 * @param {string} params.taskId
 * @param {string} [params.conversationId]
 * @param {{level: number, maxWarnings: number, silentMs: number, windowMs?: number}} params.warning
 * @returns {Promise<void>}
 */
export async function reportStall({ config, workerName, taskId, conversationId, warning }) {
  const minutes = Math.max(1, Math.round(warning.silentMs / 60_000))
  const last = warning.level >= warning.maxWarnings
  const line = `[wolfpack] 疑似停滞（${workerName}）${warning.level}/${warning.maxWarnings}：`
    + `${taskId} 已 ${minutes} 分钟没有任何进展。`
    + (last
      ? '此后不再报警；**不会自动终止**——要停请自己中断（Esc / 停会话）。'
      : '继续观察中，不会被自动终止。')
  try {
    console.warn(line)
  } catch {}

  const record = {
    at: Date.now(),
    worker: workerName,
    taskId,
    conversationId,
    level: warning.level,
    maxWarnings: warning.maxWarnings,
    silentMs: warning.silentMs,
    windowMs: warning.windowMs,
    action: 'warn-only',
  }

  if (config?.stallLogPath) {
    await appendStallRecord(config.stallLogPath, record)
  }

  // 宿主通知器：DSH 用系统 Toast，Node 宿主用通知中心（见 src/runtime/node.mjs）
  const notifier = config?.stallToastNotifier
    ?? config?.toastNotifier
    ?? config?.stallToast
    ?? config?.stall?.notifier

  if (typeof notifier === 'function') {
    try {
      notifier({
        title: `狼群：${workerName} 疑似停滞`,
        message: `${taskId} 已 ${minutes} 分钟无进展（第 ${warning.level}/${warning.maxWarnings} 次）。不会自动终止。`,
        line,
        warning: { ...warning, worker: workerName },
        worker: workerName,
        taskId,
        conversationId,
        minutes,
        record,
      })
    } catch {}
  }
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
 * @param {string} rawDir
 * @param {string} taskId
 * @param {number} round
 * @param {string} raw
 * @returns {Promise<string|undefined>}
 */
async function persistRawOutput(rawDir, taskId, round, raw) {
  if (!rawDir || !raw) return undefined
  const safeId = String(taskId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
  const targetPath = join(rawDir, `${safeId}-r${round}-${Date.now()}.json`)
  try {
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, raw, 'utf8')
    return targetPath
  } catch (err) {
    console.warn('[wolfpack/delegate] 原始 JSON 落盘失败:', targetPath, err?.message || err)
    return undefined
  }
}

/**
 * 执行一次委派任务。
 * 完整流程：
 * 1. 基线闸门检查：所有基线命令必须跑了且失败；通过则判 stale，且完全不启动工人；跑不起判 error；
 * 2. 独占锁校验：同 task_id 并发直接拒绝；
 * 3. 产物快照 before；
 * 4. 启动工人（按适配器组装 argv，续跑传 --conversation <id>）；
 * 5. 产物快照 after，差集计算；
 * 6. 结果映射与分类（产物存在即完成）；
 * 7. 验收命令执行与五态 verdict 判定；
 * 8. 机械验收救回（若 agy 自报 ERROR 但验收全部通过 -> completed）；
 * 9. 记录台账并释放独占锁。
 *
 * @param {object} params
 * @param {object} params.config
 * @param {object} params.args - task_id, task, verify, verify_baseline, fresh, model
 *   （工人不接受调用方点名：由 resolveWorkerSelection 全自动挑选）
 * @param {string} [params.cwd]
 * @param {AbortSignal} [params.signal]
 * @param {RunsLedger} [params.ledger]
 * @param {ActiveRunRegistry} [params.registry]
 * @param {object} [params.runtime] - 注入的运行时；未注入则用默认运行时或内置 Node 实现
 * @returns {Promise<Record<string, any>>}
 */
export async function runDelegateTask({
  config,
  args,
  cwd = process.cwd(),
  signal,
  ledger,
  registry = defaultActiveRuns,
  runtime,
}) {
  const taskId = args.task_id
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('[wolfpack/delegate] task_id 必须是非空字符串')
  }
  const task = args.task
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error('[wolfpack/delegate] task 任务书必须是非空字符串')
  }

  const theLedger = ledger ?? (config.ledgerPath ? new RunsLedger(config.ledgerPath, config) : undefined)

  // 工人全自动挑选：不问用户、也不接受调用方点名。
  // 先读同 task_id 的上一轮记录：上一轮的工人若仍可用就沿用（会话 ID 只在各自 CLI 内有效）。
  const previous = theLedger ? await theLedger.latest(taskId) : undefined
  // 工人健康台账：谁刚坏过、冷却到什么时候。只影响「挑谁」，不影响任务判定。
  const healthPath = config.workerHealth?.filePath
  const healthEnabled = config.workerHealth?.enabled !== false && typeof healthPath === 'string' && healthPath !== ''
  const healthState = healthEnabled ? await readHealthState(healthPath) : undefined
  const selection = resolveWorkerSelection({ config, previousWorker: previous?.worker, health: healthState })
  const worker = getWorker(selection.name)

  const baselineCommands = normalizeCommands(args.verify_baseline)
  const verifyCommands = normalizeCommands(args.verify)

  // ── 1. 基线闸门 ──────────────────────────────────────────────────────
  let baselineChecks = []
  if (baselineCommands.length > 0) {
    baselineChecks = await runVerify({
      cwd,
      commands: baselineCommands,
      signal,
      shellArgv: defaultShellArgv(config.shell),
      timeoutMs: config.verifyTimeoutMs,
      graceMs: config.graceMs,
      runtime,
    })
    const evalResult = evaluateBaseline(baselineChecks)
    if (evalResult.decision !== 'proceed') {
      const round = previous?.round ?? 0
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

      return {
        task_id: taskId,
        worker: worker.name,
        worker_reason: selection.reason,
        round,
        continued: false,
        stop_reason: 'skipped',
        report: '',
        changed_files: [],
        changed_files_determined: false,
        verify: [],
        verify_registered_count: verifyCommands.length,
        baseline: baselineChecks,
        verdict,
        diagnostic: evalResult.reason,
        tool_deadline_ms: config.taskTimeoutMs || undefined,
      }
    }
  }

  // ── 2. 并发独占锁（同步抢占，拒绝排队；跨进程活运行检查）───────────────
  const runId = randomUUID()
  registry.claim(taskId, runId, undefined, worker.name)

  // 跨进程活运行检查：同 task_id 正在运行直接拒绝
  const crossRun = await readLiveRecord(config.rawDir, taskId)
  if (crossRun) {
    if (isProcessAlive(crossRun.pid)) {
      registry.release(taskId, runId)
      throw new TaskBusyError(taskId, crossRun.runId, crossRun.startedAt, Date.now(), crossRun.worker || worker.name)
    } else {
      // 残留孤儿登记清理
      await removeLiveRecord(config.rawDir, taskId).catch(() => {})
    }
  }

  // 登记磁盘 live 运行文件
  await writeLiveRecord(config.rawDir, taskId, {
    taskId,
    runId,
    worker: worker.name,
    cwd,
    pid: process.pid,
    startedAt: Date.now(),
  }).catch(() => {})

  let terminateProc = async () => {}
  const liveEntry = {
    taskId,
    runId,
    startedAt: Date.now(),
    worker: worker.name,
    workerReason: selection.reason,
    cwd,
    terminate: async () => {
      await terminateProc()
    },
  }
  liveRuns.set(taskId, liveEntry)

  let stallMonitor

  try {
    const continuation = resolveContinuation({
      config,
      previous,
      forceFresh: args.fresh === true,
      workerName: worker.name,
    })
    liveEntry.round = continuation.round
    liveEntry.continuing = continuation.continuing
    liveEntry.conversationId = continuation.conversationId

    // ── 3. 产物快照 before ─────────────────────────────────────────────
    const before = await takeArtifactSnapshot(cwd, runtime)

    // ── 4. 启动工人 ────────────────────────────────────────────────────
    // 模型优先级：args.model > 工人专属模型 > 全局 WOLFPACK_MODEL
    const modelForWorker = args.model
      ?? (worker.name === 'claude' ? (config.claudeModel ?? config.model) : config.model)
    const workerConfig = {
      ...config,
      ...(modelForWorker ? { model: modelForWorker } : {}),
    }

    const argv = worker.buildArgv(workerConfig, {
      task,
      sessionId: continuation.conversationId,
      timeoutMs: config.taskTimeoutMs,
    })

    const rt = resolveRuntime(runtime ?? config.runtime)
    const spawnFn = typeof rt?.spawn === 'function' ? rt.spawn.bind(rt) : spawnProcess

    const proc = spawnFn({
      argv,
      cwd,
      signal,
      timeoutMs: config.taskTimeoutMs,
      graceMs: config.graceMs,
    })

    terminateProc = proc.terminate

    /**
     * 活运行登记（跨进程可见，实时面板就是读它）。
     * 每次都写全量字段：面板要按工人分区，就必须知道 worker 与它自己的停滞采样。
     *
     * @param {object} [stallSnapshot]
     */
    const publishLiveRecord = async stallSnapshot => {
      await writeLiveRecord(config.rawDir, taskId, {
        taskId,
        runId,
        worker: worker.name,
        workerReason: selection.reason,
        // cwd 必须落盘：面板是另一个进程，claude 的会话流水路径要靠它算出来
        cwd,
        pid: process.pid,
        ...(proc.pid === undefined ? {} : { workerPid: proc.pid }),
        startedAt: liveEntry.startedAt,
        updatedAt: Date.now(),
        round: continuation.round,
        continuing: continuation.continuing,
        conversationId: continuation.conversationId ?? null,
        ...(stallSnapshot === undefined ? {} : { stall: stallSnapshot }),
      }).catch(() => {})
    }

    // 停滞监控：**按工人各自一套**（agy 看自己的 brain/conversations，claude 看自己的
    // ~/.claude/projects/<项目>/<session>.jsonl）。只报警，永不终止。
    const stallConfig = config.stall?.[worker.name] ?? resolveStallConfig(worker.name, { config })
    stallMonitor = createStallMonitor({
      worker: worker.name,
      storeRoot: stallConfig.storeRoot,
      sessionId: continuation.conversationId,
      cwd,
      windowMs: stallConfig.windowMs,
      maxWarnings: stallConfig.maxWarnings,
      pollMs: stallConfig.pollMs,
      onWarning: warning => {
        reportStall({ config, workerName: worker.name, taskId, conversationId: continuation.conversationId, warning })
          .catch(() => {})
      },
      onSample: snapshot => {
        // 每次采样都把该工人自己的停滞状态写进活运行登记，供实时面板跨进程分开展示
        publishLiveRecord(snapshot).catch(() => {})
      },
      onError: message => {
        try { console.warn(`[wolfpack] ${message}`) } catch {}
      },
    })
    stallMonitor.start()
    liveEntry.stallMonitor = stallMonitor

    await publishLiveRecord(stallMonitor.snapshot())

    const outcome = await proc.done
    const stdoutText = proc.collected.stdout.text
    const stderrText = proc.collected.stderr.text

    // ── 5. 产物快照 after 与差集 ───────────────────────────────────────
    const after = await takeArtifactSnapshot(cwd, runtime)
    const artifacts = diffArtifacts(before, after)

    // ── 6. 解析工人输出与判定分类 ──────────────────────────────────────
    const parsed = worker.parse(stdoutText)
    const nextSessionId = worker.extractSessionId(stdoutText) ?? continuation.conversationId

    const rawPath = await persistRawOutput(config.rawDir, taskId, continuation.round, stdoutText)

    const claimedCheck = checkClaimedFiles(parsed?.structuredReport?.claimedFiles, cwd)
    let determined = artifacts.determined
    let undeterminedReason = undefined

    if (!determined) {
      undeterminedReason = '工作目录不是 git 仓库'
    } else if (claimedCheck.isOutside) {
      determined = false
      undeterminedReason = '声称的文件不在被探测的工作区内'
    }

    const classified = worker.classify({
      parsed,
      exitCode: outcome.exitCode,
      artifacts,
      timedOut: outcome.timedOut,
      cancelled: outcome.aborted,
      signal: outcome.signal,
      raw: stdoutText,
      stderr: stderrText,
    })

    // ── 7. 执行验收命令 ────────────────────────────────────────────────
    const verifyChecks = verifyCommands.length > 0
      ? await runVerify({
          cwd,
          commands: verifyCommands,
          signal,
          shellArgv: defaultShellArgv(config.shell),
          timeoutMs: config.verifyTimeoutMs,
          graceMs: config.graceMs,
          runtime,
        })
      : []

    const executed = verifyChecks.filter(c => c.ran)
    const verdict = verifyChecks.length === 0
      ? 'unverified'
      : executed.length === 0
        ? 'error'
        : executed.every(c => c.ok) ? 'pass' : 'fail'

    // ── 8. 机械验收救回（自报 ERROR 但机械验收全过判为完成）──────────
    const verifiedClean = executed.length > 0 && executed.every(c => c.ok)
    const salvaged = classified.stopReason === 'error' && verifiedClean
    const stopReason = salvaged ? 'completed' : classified.stopReason
    const diagnostic = salvaged
      ? [classified.diagnostic, `${worker.name} 自报失败，但机械验收全部通过，判为完成`].filter(Boolean).join('｜')
      : classified.diagnostic

    const durationMs = parsed?.durationSeconds ? Math.round(parsed.durationSeconds * 1000) : 0
    const report = parsed?.structuredReport?.summary || parsed?.response || ''
    const stallSnapshot = stallMonitor ? stallMonitor.snapshot() : undefined

    // ── 8.5 工人健康记账 ───────────────────────────────────────────────
    // 只回答「下一轮还派不派它」：工人自己坏（没输出/超时/额度耗尽/未登录）当轮就冷却，
    // 普通失败累计到阈值才冷却；用户自己取消与基线跳过不改台账。
    const faultTexts = [
      typeof parsed?.error === 'string' ? parsed.error : undefined,
      typeof parsed?.response === 'string' ? parsed.response.slice(0, 500) : undefined,
      typeof stderrText === 'string' ? stderrText.slice(0, 2000) : undefined,
    ].filter(text => typeof text === 'string' && text !== '')
    const faultKind = classifyFaultKind({
      stopReason,
      timedOut: outcome.timedOut === true,
      cancelled: outcome.aborted === true,
      outputEmpty: stdoutText.trim() === '',
      status: typeof parsed?.apiStatus === 'number' ? parsed.apiStatus : undefined,
      texts: faultTexts,
      raw: stdoutText,
    })
    const outcomeKind = stopReason === 'completed' ? 'success' : (faultKind ?? 'neutral')
    let workerHealth = { worker: worker.name, benched: false }
    if (healthEnabled) {
      const recorded = await updateHealthState(healthPath, state => recordWorkerOutcome(state, {
        worker: worker.name,
        kind: outcomeKind,
        stopReason,
        diagnostic: diagnostic ?? classified.diagnostic,
        config,
      }))
      workerHealth = snapshotHealth(recorded, worker.name)
    }

    // ── 9. 台账记录 ────────────────────────────────────────────────────
    if (theLedger) {
      await theLedger.record({
        taskId,
        worker: worker.name,
        round: continuation.round,
        conversationId: nextSessionId,
        cwd,
        stopReason,
        verdict,
        changedFiles: artifacts.files,
        changedFilesDetermined: determined,
        durationMs,
        tokens: parsed?.usage?.total,
        cacheReadTokens: parsed?.usage?.cacheRead,
        turns: parsed?.numTurns,
        subagents: typeof parsed?.subagents?.spawned === 'number' ? parsed.subagents.spawned : undefined,
        stallWarnings: stallSnapshot?.warnings,
        stallSilentMs: stallSnapshot?.silent_ms,
        stallHeartbeats: stallSnapshot?.heartbeats,
        stallAvailable: stallSnapshot === undefined ? undefined : (stallSnapshot.enabled === true && stallSnapshot.unavailable !== true),
        note: continuation.continuing ? 'continued' : (continuation.freshReason || 'cold-start'),
      })
    }

    return {
      task_id: taskId,
      worker: worker.name,
      worker_reason: selection.reason,
      round: continuation.round,
      continued: continuation.continuing,
      fresh_reason: continuation.freshReason,
      stop_reason: stopReason,
      capacity: classified.capacity === true,
      report,
      changed_files: artifacts.files,
      changed_files_determined: determined,
      changed_files_undetermined_reason: undeterminedReason,
      verify: verifyChecks,
      verify_registered_count: verifyCommands.length,
      baseline: baselineChecks.length > 0 ? baselineChecks : undefined,
      verdict,
      diagnostic,
      conversation_id: nextSessionId,
      subagents_spawned: typeof parsed?.subagents?.spawned === 'number' ? parsed.subagents.spawned : undefined,
      stall: stallSnapshot,
      worker_health: workerHealth,
      ...(selection.benched_skipped === undefined ? {} : { benched_workers: selection.benched_skipped }),
      ...(selection.all_benched === true ? { health_note: 'all-benched' } : {}),
      ...(selection.benched_ignored === true ? { health_note: 'explicit-ignores-bench' } : {}),
      raw_path: rawPath,
      duration_ms: durationMs,
      tool_deadline_ms: config.taskTimeoutMs || undefined,
    }
  } finally {
    stallMonitor?.stop()
    registry.release(taskId, runId)
    liveRuns.delete(taskId)
    await removeLiveRecord(config.rawDir, taskId).catch(() => {})
  }
}
