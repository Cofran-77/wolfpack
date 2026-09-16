#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { loadConfig, stripBom } from '../src/config.mjs'
import { killRun, runDelegateTask } from '../src/delegate.mjs'
import { renderDigest, renderStatus } from '../src/digest.mjs'
import { defaultActiveRuns, RunsLedger } from '../src/ledger.mjs'
import { listLiveRecords } from '../src/live.mjs'
import { renderTeamDigest, runTeamTasks } from '../src/team.mjs'

/**
 * 手写轻量命令行参数解析器（零第三方依赖）。
 *
 * @param {string[]} argv
 * @returns {{ command: string, flags: Record<string, any> }}
 */
function parseArgs(argv) {
  const flags = {
    verify: [],
    'verify-baseline': [],
  }
  let command = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!command && !arg.startsWith('-')) {
      command = arg
      continue
    }

    if (arg === '--json') {
      flags.json = true
    } else if (arg === '--fresh') {
      flags.fresh = true
    } else if (arg === '--task-id' && i + 1 < argv.length) {
      flags['task-id'] = argv[++i]
    } else if (arg.startsWith('--task-id=')) {
      flags['task-id'] = arg.slice('--task-id='.length)
    } else if (arg === '--task' && i + 1 < argv.length) {
      flags.task = argv[++i]
    } else if (arg.startsWith('--task=')) {
      flags.task = arg.slice('--task='.length)
    } else if (arg === '--verify' && i + 1 < argv.length) {
      flags.verify.push(argv[++i])
    } else if (arg.startsWith('--verify=')) {
      flags.verify.push(arg.slice('--verify='.length))
    } else if (arg === '--verify-baseline' && i + 1 < argv.length) {
      flags['verify-baseline'].push(argv[++i])
    } else if (arg.startsWith('--verify-baseline=')) {
      flags['verify-baseline'].push(arg.slice('--verify-baseline='.length))
    } else if (arg === '--model' && i + 1 < argv.length) {
      flags.model = argv[++i]
    } else if (arg.startsWith('--model=')) {
      flags.model = arg.slice('--model='.length)
    } else if (arg === '--limit' && i + 1 < argv.length) {
      flags.limit = Number(argv[++i])
    } else if (arg.startsWith('--limit=')) {
      flags.limit = Number(arg.slice('--limit='.length))
    } else if (arg === '--tasks' && i + 1 < argv.length) {
      flags.tasks = argv[++i]
    } else if (arg.startsWith('--tasks=')) {
      flags.tasks = arg.slice('--tasks='.length)
    } else if (arg === '--concurrency' && i + 1 < argv.length) {
      flags.concurrency = Number(argv[++i])
    } else if (arg.startsWith('--concurrency=')) {
      flags.concurrency = Number(arg.slice('--concurrency='.length))
    }
  }

  return { command, flags }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const ledger = new RunsLedger(config.ledgerPath, config)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`wolf CLI - 狼群委派引擎

子命令：
  delegate   委派任务给工人
  status     查看台账与任务状态（纯只读，绝不启动工人）
  kill       终止正在运行的任务
  team       并发小队委派
`)
    process.exit(0)
  }

  if (command === 'delegate') {
    const taskId = flags['task-id']
    const task = flags.task
    if (!taskId || !task) {
      console.error('[wolf] delegate 需要 --task-id 与 --task 参数')
      process.exit(1)
    }

    try {
      const result = await runDelegateTask({
        config,
        args: {
          task_id: taskId,
          task,
          verify: flags.verify,
          verify_baseline: flags['verify-baseline'],
          fresh: flags.fresh === true,
          model: flags.model,
        },
        cwd: process.cwd(),
        ledger,
      })

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(renderDigest(result))
      }
      process.exit(0)
    } catch (err) {
      console.error('[wolf] delegate 失败:', err?.message || err)
      process.exit(1)
    }
  }

  if (command === 'status') {
    try {
      const allStates = [...(await ledger.read()).values()]
      const activeIds = new Set(defaultActiveRuns.list().map(r => r.taskId))
      const liveRecords = await listLiveRecords(config.rawDir)
      for (const r of liveRecords) {
        activeIds.add(r.taskId)
      }

      const budgetLimit = typeof config.continuationTokenBudget === 'number' && config.continuationTokenBudget > 0
        ? config.continuationTokenBudget
        : undefined

      let filtered = flags['task-id']
        ? allStates.filter(s => s.taskId === flags['task-id'])
        : allStates

      filtered.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))

      const limit = flags.limit && flags.limit > 0 ? flags.limit : 20
      const truncated = filtered.length > limit
      const displayTasks = filtered.slice(0, limit).map(s => {
        const used = s.totalTokens || 0
        return {
          task_id: s.taskId,
          round: s.round,
          last_verdict: s.lastVerdict,
          last_stop_reason: s.lastStopReason,
          total_tokens: s.totalTokens,
          total_cache_read_tokens: s.totalCacheReadTokens,
          has_conversation_id: typeof s.conversationId === 'string' && s.conversationId !== '',
          running: activeIds.has(s.taskId),
          changed_files_count: s.changedFiles.length,
          changed_files: s.changedFiles.slice(0, 5),
          changed_files_determined: s.changedFilesDetermined === true,
          last_at: s.lastAt,
          last_duration_ms: s.lastDurationMs,
          budget_used: used,
          budget_limit: budgetLimit,
          budget_over: budgetLimit !== undefined && used >= budgetLimit,
        }
      })

      const statusOutput = {
        tasks: displayTasks,
        total: filtered.length,
        truncated,
        limit,
        ledger_path: ledger.filePath,
      }

      if (flags.json) {
        console.log(JSON.stringify(statusOutput, null, 2))
      } else {
        console.log(renderStatus(statusOutput))
      }
      process.exit(0)
    } catch (err) {
      console.error('[wolf] status 失败:', err?.message || err)
      process.exit(1)
    }
  }

  if (command === 'kill') {
    const taskId = flags['task-id']
    if (!taskId) {
      console.error('[wolf] kill 需要 --task-id 参数')
      process.exit(1)
    }
    const res = await killRun(taskId, ledger, config)
    if (res.ok) {
      console.log(`[wolf] 任务 "${taskId}" 已成功终止 (runId: ${res.runId})`)
      process.exit(0)
    } else {
      console.error(`[wolf] 终止失败: ${res.reason}`)
      process.exit(1)
    }
  }

  if (command === 'team') {
    const tasksArg = flags.tasks
    if (!tasksArg) {
      console.error('[wolf] team 需要 --tasks <文件路径|-> 参数')
      process.exit(1)
    }

    let rawTasksJson = ''
    if (tasksArg === '-') {
      rawTasksJson = await readStdin()
    } else {
      try {
        rawTasksJson = readFileSync(tasksArg, 'utf8')
      } catch (err) {
        console.error(`[wolf] 无法读取 tasks 文件 (${tasksArg}):`, err?.message || err)
        process.exit(1)
      }
    }

    let tasks = []
    try {
      tasks = JSON.parse(stripBom(rawTasksJson))
    } catch (err) {
      console.error('[wolf] tasks 内容必须是有效 JSON:', err?.message || err)
      process.exit(1)
    }

    try {
      const result = await runTeamTasks({
        config,
        tasks,
        concurrency: flags.concurrency,
        cwd: process.cwd(),
        ledger,
      })

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(renderTeamDigest(result))
      }
      process.exit(0)
    } catch (err) {
      console.error('[wolf] team 失败:', err?.message || err)
      process.exit(1)
    }
  }

  console.error(`[wolf] 未知子命令 "${command}"，运行 node bin/wolf.mjs --help 查看用法`)
  process.exit(1)
}

main().catch(err => {
  console.error('[wolf] 未捕获异常:', err)
  process.exit(1)
})
