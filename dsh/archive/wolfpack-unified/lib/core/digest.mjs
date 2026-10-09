/**
 * 结构化结果与 digest 文本渲染器（纯展示层，零外部依赖）。
 * 遵循严格的线上冻结契约：
 * 1. wolf_delegate digest 双段格式：— 队员声称 — 与 — 我已核实 —
 * 2. wolf_status digest：🐺 wolf_status（只读，不触发 agy）
 * 3. wolf_team digest：🐺 狼群并发小队 · 执行汇总 · 任务详情
 */

/** 队员自述摘要字符数上限。 */
export const DIGEST_MAX_CHARS = 4000

/** 诊断字段字节数上限。 */
export const DIAGNOSTIC_MAX_BYTES = 500

/** 团队汇总文本最大长度。 */
export const TEAM_SUMMARY_MAX_CHARS = 4000

/**
 * 按字符数截断字符串。
 *
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function truncateChars(str, max) {
  if (typeof str !== 'string') return ''
  return str.length <= max ? str : str.slice(0, max) + '…[truncated]'
}

/**
 * 按 UTF-8 字节截断，不切碎多字节字符。
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateBytes(text, maxBytes) {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return text

  const suffix = '…[truncated]'
  const suffixBytes = new TextEncoder().encode(suffix).byteLength
  const fits = suffixBytes <= maxBytes
  let end = fits ? maxBytes - suffixBytes : maxBytes
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end -= 1

  return new TextDecoder().decode(encoded.subarray(0, end)) + (fits ? suffix : '')
}

/**
 * 格式化本轮的工具调用预算。
 *
 * @param {unknown} toolDeadlineMs
 * @returns {string}
 */
export function formatToolBudget(toolDeadlineMs) {
  if (typeof toolDeadlineMs !== 'number' || !Number.isFinite(toolDeadlineMs) || toolDeadlineMs <= 0) {
    return '本轮工具调用预算：不设上限（宿主不设超时，仅受 agy 侧配额约束）'
  }
  const mins = toolDeadlineMs / 60_000
  const rounded = Math.round(mins * 10) / 10
  return `本轮工具调用预算：${rounded} 分钟（到点会被宿主以 TOOL_TIMEOUT 掐断）`
}

/**
 * 基线检查的符号：与验收相反，失败才是好消息。
 *
 * @param {{ ran?: boolean, ok?: boolean }} check
 * @returns {string}
 */
export function baselineMark(check) {
  if (check.ran === false) return '⚠'
  return check.ok ? '✗' : '✓'
}

/**
 * 基线检查的括号说明。
 *
 * @param {{ ran?: boolean, ok?: boolean, exit_code?: number, timed_out?: boolean }} check
 * @returns {string}
 */
export function baselineSuffix(check) {
  if (check.ran === false) return '  (无法执行——基线无法判定，属工具故障，本轮没有启动 agy)'
  const code = check.exit_code === undefined ? '?' : String(check.exit_code)
  const timeout = check.timed_out === true ? ', 超时' : ''
  return `  (exit ${code}${timeout})${check.ok ? ' —— 已通过：问题不存在或已被修' : ''}`
}

/**
 * 将委派结果渲染为有界的双段 Digest（线上冻结契约）。
 *
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderDigest(value) {
  const lines = []
  const stale = value.verdict === 'stale'
  const continuation = stale
    ? '未启动 agy（基线未过）'
    : value.continued ? '续跑' : `冷启动${value.fresh_reason === undefined ? '' : `（${value.fresh_reason}）`}`
  lines.push(`🐺 ${value.task_id} · 第 ${value.round} 轮 · ${continuation} · ${value.stop_reason}`)

  if (value.capacity === true || value.stop_reason === 'capacity') {
    lines.push('⚠️ 这是服务端容量不足（与账户额度无关）、不是任务失败、立刻报告用户、不要反复重试。')
  }

  if (typeof value.diagnostic === 'string' && value.diagnostic !== '') {
    lines.push(`⚠️ ${value.diagnostic}`)
  }

  if (typeof value.stall_warnings === 'number' && value.stall_warnings > 0) {
    lines.push(`⏳ 本轮疑似停滞报警 ${value.stall_warnings} 次（没进展超过停滞窗口）。**没有被自动终止**——` +
      '如果你觉得它其实卡住了，下次直接中断；要调整窗口看 WOLFPACK_STALL_WINDOW。')
  }

  lines.push(formatToolBudget(value.tool_deadline_ms ?? value.toolDeadlineMs))

  lines.push('— 队员声称 —')
  lines.push(stale
    ? '（本轮没有启动 agy，所以没有队员自述）'
    : (value.report === '' ? '（无正文返回）' : value.report))

  lines.push('— 我已核实 —')
  const changed = value.changed_files ?? []
  const isUndetermined = value.changed_files_determined === false ||
    (value.reconciliation?.status === 'undetermined' && changed.length === 0)

  if (stale) {
    lines.push('磁盘改动：未探测（本轮没有启动 agy）')
  } else if (isUndetermined) {
    const reason = value.changed_files_undetermined_reason
      ?? (value.reconciliation?.outsideFiles?.length > 0 || value.reconciliation?.findings?.[0]?.includes('不在被探测的工作区内')
        ? '声称的文件不在被探测的工作区内'
        : '工作目录不是 git 仓库')
    lines.push(`磁盘改动：**无法判定**（${reason}）——以验收命令为准`)
  } else {
    lines.push(`磁盘改动 ${changed.length} 个文件${changed.length === 0 ? '（无）' : `：${changed.slice(0, 20).join(', ')}`}`)
  }

  const baseline = value.baseline ?? []
  if (baseline.length > 0) {
    lines.push('派活前基线（这些命令必须**失败**才算问题还在）：')
    for (const check of baseline) lines.push(`  ${baselineMark(check)} ${check.command}${baselineSuffix(check)}`)
  }

  const checks = value.verify ?? []
  if (checks.length === 0) {
    if (!stale) lines.push('验收：未提供验收命令 —— 本轮**没有**可核实的成功证据')
  } else {
    lines.push(`验收 verdict: ${value.verdict}`)
    if (value.verdict === 'error') {
      lines.push('  ⚠️ 验收命令**根本没跑起来**——这是狼群自己的工具故障，不是队友的任务失败。不要据此重派。')
    }
    for (const check of checks) {
      if (check.ran === false) {
        lines.push(`  ⚠ ${check.command}  (无法执行)`)
        if (typeof check.error === 'string' && check.error !== '') lines.push(`      ${check.error}`)
        continue
      }
      const mark = check.ok ? '✓' : '✗'
      const code = check.exit_code === undefined ? (check.exitCode === undefined ? '?' : String(check.exitCode)) : String(check.exit_code)
      const isTimeout = check.timed_out || check.timedOut
      lines.push(`  ${mark} ${check.command}  (exit ${code}${isTimeout ? ', 超时' : ''})`)
      if (!check.ok) {
        const signals = check.signals
        if (signals !== undefined && Array.isArray(signals.items) && signals.items.length > 0) {
          lines.push('      可定位信号：')
          for (const item of signals.items) lines.push(`        · [${item.kind}] ${item.text}`)
        } else {
          lines.push('      （未提取到可定位信号，降级为 tail）')
        }
        if (typeof check.tail === 'string' && check.tail !== '') {
          for (const tailLine of check.tail.split('\n').slice(-8)) lines.push(`      ${tailLine}`)
        }
      }
    }
  }

  if (typeof value.raw_path === 'string' && value.raw_path !== '') {
    lines.push(`agy 原始 JSON（未进上下文，需要时自行读）：${value.raw_path}`)
  }
  if (typeof value.spill_path === 'string' && value.spill_path !== '') {
    lines.push(`agy 完整 stdout（截断时的 spill）：${value.spill_path}`)
  }

  return lines.join('\n')
}

/**
 * 状态渲染：有界、每行一个任务（线上冻结契约）。
 *
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderStatus(value) {
  const lines = ['🐺 wolf_status（只读，不触发 agy）']
  if (typeof value.ledger_path === 'string' && value.ledger_path !== '') lines.push(`台账：${value.ledger_path}`)
  const tasks = value.tasks ?? []
  lines.push(`任务 ${value.total} 个，显示 ${tasks.length} 个${value.truncated ? '（已截断：用 task_id 或 limit 收窄）' : ''}`)
  if (tasks.length === 0) {
    lines.push('（台账里还没有任何委派记录）')
    return lines.join('\n')
  }
  for (const task of tasks) {
    const verdict = task.last_verdict === undefined ? '尚未验收' : `verdict=${task.last_verdict}`
    const stop = task.last_stop_reason === undefined ? '' : ` · stop=${task.last_stop_reason}`
    const files = task.changed_files_count === 0
      ? '0'
      : `${task.changed_files_count}（${(task.changed_files ?? []).join(', ')}`
        + `${task.changed_files_count > (task.changed_files ?? []).length ? ', …' : ''}）`
    const budgetPart = typeof task.budget_limit === 'number'
      ? ` · 预算 ${task.budget_used ?? task.total_tokens ?? 0}/${task.budget_limit}${task.budget_over ? '（已超——下一轮会冷启动）' : ''}`
      : ''
    lines.push(
      `- ${task.task_id} · 第 ${task.round} 轮 · ${verdict}${stop}`
      + ` · tokens=${task.total_tokens} · conversation_id ${task.has_conversation_id ? '有' : '无'}`
      + ` · ${task.running ? '正在跑' : '未在跑'} · 改动 ${files} 个文件${budgetPart}`,
    )
  }
  return lines.join('\n')
}

/**
 * 构建小队整体概况文本。
 *
 * @param {Array<Record<string, any>>} tasks
 * @param {Record<string, number>} counts
 * @returns {string}
 */
export function buildTeamSummary(tasks, counts) {
  const lines = []
  const countParts = []
  for (const [k, v] of Object.entries(counts)) {
    if (typeof v === 'number' && v > 0) countParts.push(`${k}: ${v}`)
  }
  lines.push(`共委派 ${tasks.length} 个任务（${countParts.join(', ') || '无'}）`)

  for (const t of tasks) {
    const details = []
    if (t.round !== undefined) details.push(`第 ${t.round} 轮`)
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

/**
 * 把 wolf_team 的结果渲染成有界的给人看的文本。
 *
 * @param {Record<string, any>} value
 * @returns {string}
 */
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
