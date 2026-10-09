import { STALL_WORKERS, formatStallSummary } from './stall.mjs'
import { faultLabel } from './worker/health.mjs'

/**
 * 冷却剩余时长的可读写法。
 *
 * @param {unknown} ms
 * @returns {string}
 */
export function formatCooldown(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '不到 1 分钟'
  const minutes = ms / 60_000
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${Math.ceil(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = Math.ceil(minutes - hours * 60)
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/**
 * 格式化本轮工具调用预算。
 *
 * @param {unknown} toolDeadlineMs
 * @returns {string}
 */
export function formatToolBudget(toolDeadlineMs) {
  if (typeof toolDeadlineMs !== 'number' || !Number.isFinite(toolDeadlineMs) || toolDeadlineMs <= 0) {
    return '本轮工具调用预算：不设上限（宿主不设超时，仅受工人侧配额约束）'
  }
  const mins = toolDeadlineMs / 60_000
  const rounded = Math.round(mins * 10) / 10
  return `本轮工具调用预算：${rounded} 分钟（到点会被掐断）`
}

function baselineMark(check) {
  if (check.ran === false) return '⚠'
  return check.ok ? '✗' : '✓'
}

/**
 * 停滞监控的**逐工人**渲染：两个工人各占一行，明确谁在场、谁没参与。
 * 只报警的数据才来自真实采样；没启动的工人如实写「未参与本轮」，绝不编造。
 *
 * @param {Record<string, any>} value
 * @returns {string[]}
 */
function renderStallBlock(value) {
  const snapshot = value?.stall
  if (!snapshot || typeof snapshot !== 'object') return []
  const runningWorker = typeof snapshot.worker === 'string' && snapshot.worker !== ''
    ? snapshot.worker
    : value.worker
  const others = STALL_WORKERS.filter(w => w !== runningWorker)
  const lines = ['停滞监控（两个工人各自一套）：', `  · ${formatStallSummary(snapshot)}`]
  for (const worker of others) {
    lines.push(`  · ${worker}：本轮未参与（没启动该工人的会话，因此没有采样数据）`)
  }
  if (typeof snapshot.warnings === 'number' && snapshot.warnings > 0) {
    lines.push('  ⏳ 停滞只报警、永不自动终止：要停请自己中断（Esc / 停会话）。')
  }
  return lines
}

function baselineSuffix(check) {
  if (check.ran === false) return '  (无法执行——基线无法判定，属工具故障，本轮没有启动 agy)'
  const rawCode = check.exitCode ?? check.exit_code
  const code = rawCode === undefined ? '?' : String(rawCode)
  const isTimeout = check.timedOut === true || check.timed_out === true
  const timeout = isTimeout ? ', 超时' : ''
  return `  (exit ${code}${timeout})${check.ok ? ' —— 已通过：问题不存在或已被修' : ''}`
}

/**
 * 渲染有界 digest 文本。
 * 铁律：必须严格区分「队员声称」与「我已核实」两段，只有第二段算证据。
 *
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderDigest(value) {
  const lines = []
  const workerName = typeof value.worker === 'string' && value.worker !== '' ? value.worker : 'agy'
  // 全自动挑选的可读标注：轮换时明说是自动挑的；显式偏好落空时如实报警
  const workerMark = value.worker_reason === 'rotation' ? '（自动轮换）' : ''
  const fallbackMatch = typeof value.worker_reason === 'string'
    ? /^fallback\((.+)-unavailable\)$/.exec(value.worker_reason)
    : null
  const stale = value.verdict === 'stale'
  const continuation = stale
    ? `未启动 ${workerName}（基线未过）`
    : value.continued ? '续跑' : `冷启动${value.fresh_reason ? `（${value.fresh_reason}）` : ''}`

  lines.push(`🐺 ${value.task_id} · ${workerName}${workerMark} · 第 ${value.round} 轮 · ${continuation} · ${value.stop_reason}`)

  if (fallbackMatch) {
    lines.push(`⚠️ 配置指定的工人 ${fallbackMatch[1]} 当前不可用，本轮已自动改用 ${workerName}（全自动选择，无需用户确认）。`)
  }

  if (value.capacity === true || value.stop_reason === 'capacity') {
    lines.push('⚠️ 这是服务端容量不足（与账户额度无关）、不是任务失败、立刻报告用户、不要反复重试。')
  }

  if (typeof value.diagnostic === 'string' && value.diagnostic !== '') {
    lines.push(`⚠️ ${value.diagnostic}`)
  }

  if (typeof value.stall_warnings === 'number' && value.stall_warnings > 0) {
    lines.push(`⏳ 本轮疑似停滞报警 ${value.stall_warnings} 次（没进展超过停滞窗口）。**没有被自动终止**——要停请直接中断。`)
  }

  if (typeof value.subagents_spawned === 'number' && value.subagents_spawned > 0) {
    lines.push(`🧩 子智能体：本轮派出 ${value.subagents_spawned} 个（工人自报用量）`)
  }

  // 工人健康：谁被冷却跳过、本轮工人自己是不是刚被冷却，都如实写出来
  const benchedWorkers = Array.isArray(value.benched_workers) ? value.benched_workers : []
  for (const bench of benchedWorkers) {
    if (bench?.benched !== true) continue
    lines.push(
      `⛔ ${bench.worker} 处于冷却（${faultLabel(bench.last_reason)}，约剩 ${formatCooldown(bench.remaining_ms)}），`
      + `本轮跳过、改由 ${workerName} 接手。`,
    )
  }
  if (value.health_note === 'all-benched') {
    lines.push(`⚠️ 两个工人都在冷却中，本轮仍由 ${workerName} 硬试一次（绝不空转）。`)
  }
  if (value.health_note === 'explicit-ignores-bench') {
    lines.push(`⚠️ 配置固定用 ${workerName}，忽略它的冷却状态（显式点名优先）。`)
  }
  const workerHealth = value.worker_health
  if (workerHealth?.benched === true) {
    lines.push(
      `⛔ ${workerName} 本轮故障已进入冷却（${faultLabel(workerHealth.last_reason)}），`
      + `约 ${formatCooldown(workerHealth.remaining_ms)} 后自动恢复；下一轮会自动改派另一个工人，不用反复重试。`
      + `想立刻重试：node bin/wolf.mjs health --reset ${workerName}`,
    )
  } else if (typeof workerHealth?.consecutive_failures === 'number' && workerHealth.consecutive_failures > 0) {
    lines.push(`⚠️ ${workerName} 连续失败 ${workerHealth.consecutive_failures} 次（还没到冷却阈值）。`)
  }

  lines.push(...renderStallBlock(value))

  lines.push(formatToolBudget(value.tool_deadline_ms ?? value.toolDeadlineMs))

  lines.push('— 队员声称 —')
  lines.push(stale
    ? `（本轮没有启动 ${workerName}，所以没有队员自述）`
    : (value.report === '' ? '（无正文返回）' : value.report))

  lines.push('— 我已核实 —')
  const changed = Array.isArray(value.changed_files) ? value.changed_files : []
  const isUndetermined = value.changed_files_determined === false

  if (stale) {
    lines.push(`磁盘改动：未探测（本轮没有启动 ${workerName}）`)
  } else if (isUndetermined) {
    const reason = value.changed_files_undetermined_reason || '工作目录不是 git 仓库'
    lines.push(`磁盘改动：**无法判定**（${reason}）——以验收命令为准`)
  } else {
    lines.push(`磁盘改动 ${changed.length} 个文件${changed.length === 0 ? '（无）' : `：${changed.slice(0, 20).join(', ')}`}`)
  }

  const baseline = value.baseline ?? []
  if (baseline.length > 0) {
    lines.push('派活前基线（这些命令必须**失败**才算问题还在）：')
    for (const check of baseline) {
      lines.push(`  ${baselineMark(check)} ${check.command}${baselineSuffix(check)}`)
    }
  }

  const checks = value.verify ?? []
  const registeredCount = typeof value.verify_registered_count === 'number'
    ? value.verify_registered_count
    : (Array.isArray(value.verify) ? value.verify.length : 0)

  if (checks.length === 0) {
    if (registeredCount > 0) {
      lines.push(`验收：本轮未启动工人，验收未执行（已登记 ${registeredCount} 条命令，未运行）`)
    } else if (!stale) {
      lines.push('验收：未提供验收命令 —— 本轮**没有**可核实的成功证据')
    }
  } else {
    lines.push(`验收 verdict: ${value.verdict}`)
    if (value.verdict === 'error') {
      lines.push('  ⚠️ 验收命令**根本没跑起来**——这是狼群自己的工具故障，不是队友的任务失败。不要据此重派。')
    }
    for (const check of checks) {
      if (check.ran === false) {
        lines.push(`  ⚠ ${check.command}  (无法执行)`)
        if (typeof check.error === 'string' && check.error !== '') {
          lines.push(`      ${check.error}`)
        }
        continue
      }
      const mark = check.ok ? '✓' : '✗'
      const rawCode = check.exitCode ?? check.exit_code
      const code = rawCode === undefined ? '?' : String(rawCode)
      const isTimeout = check.timedOut === true || check.timed_out === true
      lines.push(`  ${mark} ${check.command}  (exit ${code}${isTimeout ? ', 超时' : ''})`)
      if (!check.ok) {
        const signals = check.signals
        if (signals && Array.isArray(signals.items) && signals.items.length > 0) {
          lines.push('      可定位信号：')
          for (const item of signals.items) {
            lines.push(`        · [${item.kind}] ${item.text}`)
          }
        } else {
          lines.push('      （未提取到可定位信号，降级为 tail）')
        }
        if (typeof check.tail === 'string' && check.tail !== '') {
          for (const tailLine of check.tail.split('\n').slice(-8)) {
            lines.push(`      ${tailLine}`)
          }
        }
      }
    }
  }

  if (typeof value.raw_path === 'string' && value.raw_path !== '') {
    lines.push(`${workerName} 原始 JSON（未进上下文，需要时自行读）：${value.raw_path}`)
  }
  if (typeof value.spill_path === 'string' && value.spill_path !== '') {
    lines.push(`${workerName} 完整 stdout（截断时的 spill）：${value.spill_path}`)
  }

  return lines.join('\n')
}

/**
 * 渲染 wolf_status 纯文本视图。
 *
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderStatus(value) {
  const lines = ['🐺 wolf_status（只读，不触发工人）']
  if (typeof value.ledger_path === 'string' && value.ledger_path !== '') {
    lines.push(`台账：${value.ledger_path}`)
  }
  const tasks = value.tasks ?? []
  lines.push(
    `任务 ${value.total} 个，显示 ${tasks.length} 个`
    + (value.truncated ? `（已截断：默认只列最近 ${tasks.length} 个，要更多传 limit，或传 task_id 只看一个）` : ''),
  )
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
    const filesPart = task.changed_files_determined === false
      ? '改动未探测'
      : `改动 ${files} 个文件`
    // tokens= 上面已经报过一次，这里只在真的超预算时点名，不让同一串数字重复占上下文
    const budgetPart = task.budget_over === true ? ' · 已超预算（下一轮会冷启动）' : ''
    const workerPart = typeof task.worker === 'string' && task.worker !== '' ? ` · 工人 ${task.worker}` : ''
    const stallPart = typeof task.stall_warnings === 'number' && task.stall_warnings > 0
      ? ` · 停滞报警 ${task.stall_warnings} 次`
      : ''
    lines.push(
      `- ${task.task_id}${workerPart} · 第 ${task.round} 轮 · ${verdict}${stop}`
      + ` · tokens=${task.total_tokens} · conversation_id ${task.has_conversation_id ? '有' : '无'}`
      + ` · ${task.running ? '正在跑' : '未在跑'} · ${filesPart}${budgetPart}${stallPart}`,
    )
  }
  return lines.join('\n')
}

/**
 * 渲染工人健康台账（CLI `wolf health` 与 MCP `wolf_status` 共用）。
 *
 * @param {object} [value]
 * @param {object[]} [value.workers] - snapshotHealth 的结果数组
 * @param {string} [value.file_path]
 * @param {boolean} [value.enabled]
 * @param {number} [value.fail_threshold]
 * @returns {string}
 */
export function renderHealthReport({ workers = [], file_path: filePath, enabled = true, fail_threshold: failThreshold } = {}) {
  const lines = []
  lines.push(`🐺 工人健康与冷却${enabled === false ? '（已关闭）' : ''}`)
  if (typeof filePath === 'string' && filePath !== '') lines.push(`台账：${filePath}`)
  if (typeof failThreshold === 'number') lines.push(`普通失败阈值：连续 ${failThreshold} 次进入冷却（工人自身故障当轮即冷却）`)
  for (const snap of workers) {
    if (snap?.benched === true) {
      lines.push(
        `⛔ ${snap.worker}：冷却中 · ${faultLabel(snap.last_reason)}`
        + ` · 约剩 ${formatCooldown(snap.remaining_ms)} · 累计失败 ${snap.total_failures ?? 0} 次`,
      )
      if (typeof snap.last_diagnostic === 'string' && snap.last_diagnostic !== '') {
        lines.push(`   上次诊断：${snap.last_diagnostic.slice(0, 120)}`)
      }
    } else if (typeof snap?.consecutive_failures === 'number' && snap.consecutive_failures > 0) {
      lines.push(`⚠️ ${snap.worker}：可用，但已连续失败 ${snap.consecutive_failures} 次（${faultLabel(snap.last_reason)}）`)
    } else {
      lines.push(`✅ ${snap?.worker}：可用，无失败记录`)
    }
  }
  lines.push('清除冷却：node bin/wolf.mjs health --reset claude | agy | all')
  return lines.join('\n')
}
