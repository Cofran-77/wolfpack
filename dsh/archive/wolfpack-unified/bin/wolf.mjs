#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { createNodeRuntime } from '../lib/runtime/node.mjs'
import { loadConfig, stripBom } from '../lib/core/config.mjs'
import { killRun, runDelegateTask } from '../lib/core/delegate.mjs'
import { renderDigest, renderStatus } from '../lib/core/digest.mjs'
import { defaultActiveRuns, queryWolfStatus, RunsLedger } from '../lib/core/ledger.mjs'
import { renderTeamDigest, runTeamTasks } from '../lib/core/team.mjs'

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
  config.stallToastNotifier = ({ line }) => {
    try { process.stderr.write(`${line}\n`) } catch {}
  }
  const ledger = new RunsLedger(config.ledgerPath, config)
  const runtime = createNodeRuntime()

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`wolf CLI - 狼群委派引擎 (Wolfpack Unified)

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

    if (!taskId) {
      console.error('错误: 缺少必填参数 --task-id')
      process.exit(1)
    }
    if (!task) {
      console.error('错误: 缺少必填参数 --task')
      process.exit(1)
    }

    try {
      const result = await runDelegateTask({
        runtime,
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

      const exitCode = (result.verdict === 'pass' || result.verdict === 'stale') ? 0 : 1
      process.exit(exitCode)
    } catch (err) {
      console.error('委派执行失败:', err?.message || err)
      process.exit(1)
    }
  }

  if (command === 'status') {
    try {
      const statusOutput = await queryWolfStatus({
        ledger,
        taskId: flags['task-id'],
        limit: flags.limit,
        config,
        registry: defaultActiveRuns,
      })

      if (flags.json) {
        console.log(JSON.stringify(statusOutput, null, 2))
      } else {
        console.log(renderStatus(statusOutput))
      }
      process.exit(0)
    } catch (err) {
      console.error('读取台账失败:', err?.message || err)
      process.exit(1)
    }
  }

  if (command === 'kill') {
    const taskId = flags['task-id']
    if (!taskId) {
      console.error('错误: 缺少必填参数 --task-id')
      process.exit(1)
    }

    try {
      const res = await killRun(taskId, ledger, config)
      if (res.ok) {
        console.log(`任务 "${taskId}" 已终止 (runId: ${res.runId})`)
        process.exit(0)
      } else {
        console.error(`终止失败: ${res.reason}`)
        process.exit(1)
      }
    } catch (err) {
      console.error('终止操作异常:', err?.message || err)
      process.exit(1)
    }
  }

  if (command === 'team') {
    let tasks = []
    if (flags.tasks) {
      try {
        let rawJson = flags.tasks.trim()
        if (rawJson.startsWith('@')) {
          rawJson = readFileSync(rawJson.slice(1), 'utf8')
        }
        tasks = JSON.parse(stripBom(rawJson))
      } catch (err) {
        console.error('解析 --tasks JSON 失败:', err?.message || err)
        process.exit(1)
      }
    } else {
      try {
        const stdinText = (await readStdin()).trim()
        if (stdinText) {
          tasks = JSON.parse(stripBom(stdinText))
        }
      } catch (err) {
        console.error('从 stdin 读取任务 JSON 失败:', err?.message || err)
        process.exit(1)
      }
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      console.error('错误: 并发小队任务列表不能为空')
      process.exit(1)
    }

    try {
      const teamResult = await runTeamTasks({
        runtime,
        config,
        tasks,
        concurrency: flags.concurrency,
        cwd: process.cwd(),
        ledger,
      })

      if (flags.json) {
        console.log(JSON.stringify(teamResult, null, 2))
      } else {
        console.log(renderTeamDigest(teamResult))
      }

      const hasFail = (teamResult.counts?.fail || 0) > 0 || (teamResult.counts?.error || 0) > 0
      process.exit(hasFail ? 1 : 0)
    } catch (err) {
      console.error('小队执行失败:', err?.message || err)
      process.exit(1)
    }
  }

  console.error(`未知子命令: "${command}"。使用 "wolf help" 查看帮助。`)
  process.exit(1)
}

main().catch(err => {
  console.error('全局未捕获异常:', err)
  process.exit(1)
})
