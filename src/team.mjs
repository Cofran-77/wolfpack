import { runDelegateTask } from './delegate.mjs'

export const MAX_TEAM_TASKS = 8
export const MAX_TEAM_CONCURRENCY = 4
export const DEFAULT_TEAM_CONCURRENCY = 2
export const TEAM_REPORT_HEAD_CHARS = 400
export const TEAM_SUMMARY_MAX_CHARS = 4000
export const TEAM_ERROR_MAX_CHARS = 400

const ALLOWED_TASK_KEYS = new Set([
  'task_id',
  'task',
  'verify',
  'verify_baseline',
  'fresh',
  'model',
])

function buildTeamSummary(tasks, counts) {
  const lines = []
  const countParts = []
  for (const [k, v] of Object.entries(counts)) {
    if (typeof v === 'number' && v > 0) countParts.push(`${k}: ${v}`)
  }
  lines.push(`共委派 ${tasks.length} 个任务（${countParts.join(', ') || '无'}）`)

  for (const t of tasks) {
    const details = []
    if (t.round !== undefined) details.push(`第 ${t.round} 轮`)
    if (t.worker) details.push(t.worker)
    if (t.stop_reason) details.push(t.stop_reason)
    if (t.changed_files_determined === false) details.push('改动未探测')
    else if (typeof t.changed_file_count === 'number') details.push(`改动 ${t.changed_file_count} 文件`)
    if (typeof t.duration_ms === 'number') details.push(`${(t.duration_ms / 1000).toFixed(1)}s`)
    const detailStr = details.length > 0 ? ` (${details.join(' · ')})` : ''
    lines.push(`- ${t.task_id} [${t.verdict}]${detailStr}`)
    if (t.error) {
      lines.push(`    错误: ${t.error}`)
    }
  }

  const text = lines.join('\n')
  return text.length > TEAM_SUMMARY_MAX_CHARS ? text.slice(0, TEAM_SUMMARY_MAX_CHARS) : text
}

export function renderTeamDigest(value) {
  const lines = []
  const tasks = Array.isArray(value?.tasks) ? value.tasks : []
  const counts = value?.counts ?? {}
  const countParts = []
  for (const [k, v] of Object.entries(counts)) {
    if (typeof v === 'number' && v > 0) {
      countParts.push(`${k}=${v}`)
    }
  }

  lines.push(`🐺 狼群并发小队 · ${tasks.length} 个任务 · ${countParts.join(' · ') || '无'}`)

  if (counts.error > 0) {
    lines.push(`⚠️ 注意：有 ${counts.error} 个任务发生错误或工具故障，请参阅详情。`)
  }
  const hasCapacity = tasks.some(t => t.capacity === true || t.stop_reason === 'capacity')
  if (hasCapacity) {
    lines.push('⚠️ 存在服务端容量不足（503 No capacity available）的任务，非自身失败，切勿反复重试。')
  }

  if (typeof value?.summary === 'string' && value.summary.trim() !== '') {
    lines.push('')
    lines.push('— 执行汇总 —')
    lines.push(value.summary.trim())
  }

  lines.push('')
  lines.push('— 任务详情 —')
  for (const t of tasks) {
    const mark = t.verdict === 'pass'
      ? '✓'
      : (t.verdict === 'fail'
        ? '✗'
        : (t.verdict === 'stale' ? '○' : (t.verdict === 'unverified' ? '?' : '⚠')))
    const parts = []
    if (t.round !== undefined) parts.push(`第 ${t.round} 轮`)
    if (t.worker) parts.push(t.worker)
    if (t.continued === true) parts.push('续跑')
    if (t.stop_reason) parts.push(t.stop_reason)
    if (t.changed_files_determined === false) parts.push('改动未探测')
    else if (typeof t.changed_file_count === 'number') parts.push(`改动 ${t.changed_file_count} 文件`)
    if (typeof t.duration_ms === 'number') parts.push(`${(t.duration_ms / 1000).toFixed(1)}s`)
    lines.push(`  ${mark} ${t.task_id} [${t.verdict}] · ${parts.join(' · ')}`)

    if (t.error) {
      lines.push(`      错误：${t.error}`)
    } else if (t.report_head) {
      const trimmed = t.report_head.trim()
      if (trimmed) {
        lines.push(`      自述：${trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed}`)
      }
    }
  }

  const text = lines.join('\n')
  return text.length > TEAM_SUMMARY_MAX_CHARS ? text.slice(0, TEAM_SUMMARY_MAX_CHARS) : text
}

/**
 * 并发扇出执行任务小队。
 *
 * @param {object} params
 * @param {object} params.config
 * @param {Array<object>} params.tasks
 * @param {number} [params.concurrency]
 * @param {string} [params.cwd]
 * @param {AbortSignal} [params.signal]
 * @param {object} [params.ledger]
 * @param {object} [params.registry]
 * @returns {Promise<{ counts: Record<string, number>, summary: string, tasks: Array<object> }>}
 */
export async function runTeamTasks({
  config,
  tasks,
  concurrency = DEFAULT_TEAM_CONCURRENCY,
  cwd = process.cwd(),
  signal,
  ledger,
  registry,
}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('wolf_team: tasks 必须是非空数组（至少包含 1 个任务）')
  }

  if (tasks.length > MAX_TEAM_TASKS) {
    throw new Error(`wolf_team: tasks 数量 (${tasks.length}) 超过上限 ${MAX_TEAM_TASKS}`)
  }

  // 重复 task_id 校验：绝对不启动任何进程，直接拒绝
  const seenTaskIds = new Set()
  for (let i = 0; i < tasks.length; i++) {
    const item = tasks[i]
    if (!item || typeof item !== 'object') {
      throw new Error(`wolf_team: tasks[${i}] 必须是对象`)
    }

    for (const key of Object.keys(item)) {
      if (!ALLOWED_TASK_KEYS.has(key)) {
        throw new Error(`wolf_team: 任务项 "${item.task_id ?? i}" 包含未知参数 "${key}"，请检查拼写`)
      }
    }

    if (typeof item.task_id !== 'string' || !item.task_id.trim()) {
      throw new Error(`wolf_team: tasks[${i}].task_id 必须是非空字符串`)
    }
    if (typeof item.task !== 'string' || !item.task.trim()) {
      throw new Error(`wolf_team: 任务 "${item.task_id}" 缺少必填的 task 任务书`)
    }

    if (seenTaskIds.has(item.task_id)) {
      throw new Error(`wolf_team: 任务列表中存在重复的 task_id "${item.task_id}"，已拒绝执行`)
    }
    seenTaskIds.add(item.task_id)
  }

  let limit = DEFAULT_TEAM_CONCURRENCY
  if (concurrency !== undefined) {
    const c = Number(concurrency)
    if (!Number.isInteger(c)) {
      throw new Error('wolf_team: concurrency 必须是整数')
    }
    limit = Math.max(1, Math.min(MAX_TEAM_CONCURRENCY, c))
  }

  const results = new Array(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      const taskArgs = tasks[idx]
      try {
        const res = await runDelegateTask({
          config,
          args: taskArgs,
          cwd,
          signal,
          ledger,
          registry,
        })
        results[idx] = res
      } catch (err) {
        // 失败隔离
        results[idx] = {
          task_id: taskArgs.task_id,
          round: 0,
          verdict: 'error',
          error: err instanceof Error ? err.message : String(err),
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

  const workerCount = Math.min(limit, tasks.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  const taskSummaries = results.map(res => {
    const reportHead = typeof res.report === 'string'
      ? res.report.slice(0, TEAM_REPORT_HEAD_CHARS)
      : ''
    const changedFileCount = Array.isArray(res.changed_files) ? res.changed_files.length : 0

    return {
      task_id: res.task_id,
      worker: res.worker,
      round: res.round,
      verdict: res.verdict,
      stop_reason: res.stop_reason,
      capacity: res.capacity === true ? true : undefined,
      duration_ms: res.duration_ms,
      changed_file_count: changedFileCount,
      changed_files_determined: res.changed_files_determined,
      continued: res.continued,
      report_head: reportHead,
      error: typeof res.error === 'string' && res.error.length > TEAM_ERROR_MAX_CHARS
        ? res.error.slice(0, TEAM_ERROR_MAX_CHARS) + '…'
        : res.error,
    }
  })

  const counts = { pass: 0, fail: 0, error: 0, unverified: 0, stale: 0 }
  for (const t of taskSummaries) {
    if (Object.prototype.hasOwnProperty.call(counts, t.verdict)) {
      counts[t.verdict] += 1
    } else {
      counts[t.verdict] = 1
    }
  }

  const summary = buildTeamSummary(taskSummaries, counts)

  return {
    counts,
    summary,
    tasks: taskSummaries,
  }
}
