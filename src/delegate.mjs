import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { loadConfig } from './config.mjs'
import { defaultActiveRuns, RunsLedger, TaskBusyError } from './ledger.mjs'
import { isProcessAlive, readLiveRecord, removeLiveRecord, writeLiveRecord } from './live.mjs'
import { killProcessTree, spawnProcess } from './spawn.mjs'
import { defaultShellArgv, evaluateBaseline, runVerify } from './verify.mjs'
import { getWorker } from './worker/index.mjs'

/**
 * 进程级活跃委派表，供 status 和 kill 查看与终止。
 * @type {Map<string, { taskId: string, runId: string, startedAt: number, terminate: () => Promise<void> }>}
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
 * @returns {Promise<{ isGit: boolean, files: Set<string> }>}
 */
export async function takeArtifactSnapshot(cwd) {
  try {
    const proc = spawnProcess({
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
export function resolveContinuation({ config, previous, forceFresh }) {
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
 * @param {string} [params.cwd]
 * @param {AbortSignal} [params.signal]
 * @param {RunsLedger} [params.ledger]
 * @param {ActiveRunRegistry} [params.registry]
 * @returns {Promise<Record<string, any>>}
 */
export async function runDelegateTask({
  config,
  args,
  cwd = process.cwd(),
  signal,
  ledger,
  registry = defaultActiveRuns,
}) {
  const taskId = args.task_id
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('[wolfpack/delegate] task_id 必须是非空字符串')
  }
  const task = args.task
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error('[wolfpack/delegate] task 任务书必须是非空字符串')
  }

  const worker = getWorker(config.worker || 'agy')
  const theLedger = ledger ?? (config.ledgerPath ? new RunsLedger(config.ledgerPath, config) : undefined)

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
    })
    const evalResult = evaluateBaseline(baselineChecks)
    if (evalResult.decision !== 'proceed') {
      const prev = theLedger ? await theLedger.latest(taskId) : undefined
      const round = prev?.round ?? 0
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
  registry.claim(taskId, runId)

  // 跨进程活运行检查：同 task_id 正在运行直接拒绝
  const crossRun = await readLiveRecord(config.rawDir, taskId)
  if (crossRun) {
    if (isProcessAlive(crossRun.pid)) {
      registry.release(taskId, runId)
      throw new TaskBusyError(taskId, crossRun.runId, crossRun.startedAt)
    } else {
      // 残留孤儿登记清理
      await removeLiveRecord(config.rawDir, taskId).catch(() => {})
    }
  }

  // 登记磁盘 live 运行文件
  await writeLiveRecord(config.rawDir, taskId, {
    taskId,
    runId,
    pid: process.pid,
    startedAt: Date.now(),
  }).catch(() => {})

  let terminateProc = async () => {}
  liveRuns.set(taskId, {
    taskId,
    runId,
    startedAt: Date.now(),
    terminate: async () => {
      await terminateProc()
    },
  })

  try {
    const previous = theLedger ? await theLedger.latest(taskId) : undefined
    const continuation = resolveContinuation({
      config,
      previous,
      forceFresh: args.fresh === true,
    })

    // ── 3. 产物快照 before ─────────────────────────────────────────────
    const before = await takeArtifactSnapshot(cwd)

    // ── 4. 启动工人 ────────────────────────────────────────────────────
    const workerConfig = {
      ...config,
      ...(args.model ? { model: args.model } : {}),
    }

    const argv = worker.buildArgv(workerConfig, {
      task,
      sessionId: continuation.conversationId,
      timeoutMs: config.taskTimeoutMs,
    })

    const proc = spawnProcess({
      argv,
      cwd,
      signal,
      timeoutMs: config.taskTimeoutMs,
      graceMs: config.graceMs,
    })

    terminateProc = proc.terminate

    // 更新 live 记录加入 workerPid
    if (proc.pid) {
      await writeLiveRecord(config.rawDir, taskId, {
        taskId,
        runId,
        pid: process.pid,
        workerPid: proc.pid,
        startedAt: Date.now(),
      }).catch(() => {})
    }

    const outcome = await proc.done
    const stdoutText = proc.collected.stdout.text
    const stderrText = proc.collected.stderr.text

    // ── 5. 产物快照 after 与差集 ───────────────────────────────────────
    const after = await takeArtifactSnapshot(cwd)
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
      ? [classified.diagnostic, 'agy 自报失败，但机械验收全部通过，判为完成'].filter(Boolean).join('｜')
      : classified.diagnostic

    const durationMs = parsed?.durationSeconds ? Math.round(parsed.durationSeconds * 1000) : 0
    const report = parsed?.structuredReport?.summary || parsed?.response || ''

    // ── 9. 台账记录 ────────────────────────────────────────────────────
    if (theLedger) {
      await theLedger.record({
        taskId,
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
        note: continuation.continuing ? 'continued' : (continuation.freshReason || 'cold-start'),
      })
    }

    return {
      task_id: taskId,
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
      raw_path: rawPath,
      duration_ms: durationMs,
      tool_deadline_ms: config.taskTimeoutMs || undefined,
    }
  } finally {
    registry.release(taskId, runId)
    liveRuns.delete(taskId)
    await removeLiveRecord(config.rawDir, taskId).catch(() => {})
  }
}
