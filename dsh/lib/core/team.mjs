/**
 * 狼群模式 — 并发委派小队内核 (Wolfpack Unified Team Engine)。
 *
 * 铁律与设计边界：
 *   1. 唯一复用：所有委派必须只走 runDelegateTask，绝不重写 verdict / baseline / salvage 判定。
 *   2. 有界输出：工具返回直接进入队长上下文，严禁塞入完整 report；必须严格限制在预算内。
 *   3. 失败隔离：单个任务异常绝不拖垮其余任务，结果中如实标记 error。
 *   4. 防护严密：拒绝重复 task_id，拒绝未知参数，严格遵守并发限制。
 */

import { runDelegateTask } from './delegate.mjs'
import { buildTeamSummary, renderTeamDigest } from './digest.mjs'

export { buildTeamSummary, renderTeamDigest }

/** 工具名。 */
export const TEAM_TOOL_NAME = 'wolf_team'

/** 单次调用最多派发任务数。 */
export const MAX_TEAM_TASKS = 8

/** 最大并发任务数上限。 */
export const MAX_TEAM_CONCURRENCY = 4

/** 默认并发任务数。 */
export const DEFAULT_TEAM_CONCURRENCY = 2

/** 单个任务自述摘要截断长度。 */
export const TEAM_REPORT_HEAD_CHARS = 400

/** 顶层小队汇总文本最大长度。 */
export const TEAM_SUMMARY_MAX_CHARS = 4000

/** 单个任务的错误文案最大长度。 */
export const TEAM_ERROR_MAX_CHARS = 400

/** 允许的任务项参数名集合（防止拼写错误被静默忽略）。 */
export const ALLOWED_TASK_KEYS = new Set([
  'task_id',
  'task',
  'verify',
  'verify_baseline',
  'fresh',
  'model',
])

/** 允许的顶层工具调用参数名集合。 */
export const ALLOWED_ARGS_KEYS = new Set([
  'tasks',
  'concurrency',
])

/**
 * 去掉 undefined 的键。
 *
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function omitUndefined(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/**
 * 校验并发小队入参与任务参数。
 *
 * @param {Record<string, any>} args
 */
export function validateTeamArgs(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('wolf_team: 参数必须是非空对象')
  }

  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARGS_KEYS.has(key)) {
      throw new Error(`wolf_team: 包含未知参数 "${key}"，请检查拼写`)
    }
  }

  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    throw new Error('wolf_team: tasks 必须是非空数组（至少包含 1 个任务）')
  }

  if (args.tasks.length > MAX_TEAM_TASKS) {
    throw new Error(`wolf_team: tasks 数量 (${args.tasks.length}) 超过上限 ${MAX_TEAM_TASKS}`)
  }

  const seenTaskIds = new Set()
  for (let i = 0; i < args.tasks.length; i++) {
    const item = args.tasks[i]
    if (!item || typeof item !== 'object') {
      throw new Error(`wolf_team: tasks[${i}] 必须是对象`)
    }

    for (const key of Object.keys(item)) {
      if (!ALLOWED_TASK_KEYS.has(key)) {
        throw new Error(`wolf_team: 任务项 "${item.task_id ?? i}" 包含未知参数 "${key}"，请检查拼写`)
      }
    }

    if (typeof item.task_id !== 'string' || item.task_id.trim() === '') {
      throw new Error(`wolf_team: tasks[${i}].task_id 必须是非空字符串`)
    }

    if (typeof item.task !== 'string' || item.task.trim() === '') {
      throw new Error(`wolf_team: 任务 "${item.task_id}" 缺少必填的 task 任务书`)
    }

    if (seenTaskIds.has(item.task_id)) {
      throw new Error(`wolf_team: 任务列表中存在重复的 task_id "${item.task_id}"，已拒绝执行`)
    }
    seenTaskIds.add(item.task_id)
  }

  if (args.concurrency !== undefined) {
    if (typeof args.concurrency !== 'number' || !Number.isInteger(args.concurrency)) {
      throw new Error('wolf_team: concurrency 必须是整数')
    }
  }
}

/**
 * 执行多任务并发委派。
 *
 * @param {object} params
 * @param {object} [params.runtime] - 注入的宿主运行时
 * @param {object} [params.ctx] - Cordis 上下文
 * @param {object} params.config
 * @param {Array<Record<string, any>>} params.tasks
 * @param {number} [params.concurrency]
 * @param {object} [params.exec]
 * @param {number} [params.verifyDeadline]
 * @param {number} [params.toolDeadlineMs]
 * @param {string} [params.cwd]
 * @param {AbortSignal} [params.signal]
 * @param {RunsLedger} [params.ledger]
 * @param {ActiveRunRegistry} [params.registry]
 * @returns {Promise<{
 *   counts: { pass: number, fail: number, error: number, unverified: number, stale: number },
 *   summary: string,
 *   tasks: Array<Record<string, any>>
 * }>}
 */
export async function runTeamTasks({
  runtime,
  ctx,
  config = {},
  tasks,
  concurrency,
  args,
  exec = {},
  verifyDeadline,
  toolDeadlineMs,
  cwd,
  signal,
  ledger,
  registry,
  ...rest
}) {
  const teamArgs = args ?? { tasks, concurrency, ...rest }
  validateTeamArgs(teamArgs)

  const theTasks = teamArgs.tasks
  let effConcurrency = DEFAULT_TEAM_CONCURRENCY
  if (teamArgs.concurrency !== undefined) {
    effConcurrency = Math.max(1, Math.min(MAX_TEAM_CONCURRENCY, teamArgs.concurrency))
  }

  const results = new Array(theTasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < theTasks.length) {
      const index = nextIndex++
      const taskArgs = theTasks[index]
      try {
        const outcome = await runDelegateTask({
          runtime,
          ctx,
          config,
          args: taskArgs,
          exec,
          verifyDeadline,
          toolDeadlineMs,
          cwd,
          signal,
          ledger,
          registry,
        })
        results[index] = outcome
      } catch (error) {
        results[index] = {
          task_id: taskArgs.task_id,
          round: 0,
          verdict: 'error',
          error: error instanceof Error ? error.message : String(error),
          stop_reason: 'error',
          report: '',
          changed_files: [],
          changed_files_determined: false,
          verify: [],
          duration_ms: 0,
          continued: false,
        }
      }
    }
  }

  const workerCount = Math.min(effConcurrency, theTasks.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  const taskSummaries = results.map(res => {
    const reportHead = typeof res.report === 'string'
      ? res.report.slice(0, TEAM_REPORT_HEAD_CHARS)
      : (typeof res.report_head === 'string' ? res.report_head.slice(0, TEAM_REPORT_HEAD_CHARS) : '')

    const changedFileCount = Array.isArray(res.changed_files)
      ? res.changed_files.length
      : (typeof res.changed_file_count === 'number' ? res.changed_file_count : 0)

    return omitUndefined({
      task_id: res.task_id,
      round: res.round,
      verdict: res.verdict,
      stop_reason: res.stop_reason,
      capacity: res.capacity === true ? true : undefined,
      duration_ms: res.duration_ms,
      changed_file_count: changedFileCount,
      changed_files_determined: typeof res.changed_files_determined === 'boolean'
        ? res.changed_files_determined
        : undefined,
      continued: res.continued,
      report_head: reportHead,
      error: typeof res.error === 'string' && res.error.length > TEAM_ERROR_MAX_CHARS
        ? res.error.slice(0, TEAM_ERROR_MAX_CHARS) + '…'
        : res.error,
    })
  })

  const counts = { pass: 0, fail: 0, error: 0, unverified: 0, stale: 0 }
  for (const task of taskSummaries) {
    if (Object.prototype.hasOwnProperty.call(counts, task.verdict)) {
      counts[task.verdict] += 1
    } else {
      counts[task.verdict] = 1
    }
  }

  const summary = buildTeamSummary(taskSummaries, counts)

  return {
    counts,
    summary,
    tasks: taskSummaries,
  }
}
