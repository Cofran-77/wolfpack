#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createNodeRuntime } from '../lib/runtime/node.mjs'
import { loadConfig, stripBom } from '../lib/core/config.mjs'
import { killRun, runDelegateTask } from '../lib/core/delegate.mjs'
import { renderDigest, renderStatus } from '../lib/core/digest.mjs'
import { defaultActiveRuns, queryWolfStatus, RunsLedger } from '../lib/core/ledger.mjs'
import { renderTeamDigest, runTeamTasks } from '../lib/core/team.mjs'
import { findInPath, isWorkerAvailable, listWorkers, workerPathOf } from '../lib/core/worker/index.mjs'

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
    } else if (arg === '--probe') {
      flags.probe = true
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
  workers    列出已注册的工人与可用状态
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

  if (command === 'workers') {
    try {
      const workers = listWorkers()
      const rawEnabled = config.workersEnabled
      const enabledSet = (Array.isArray(rawEnabled) && rawEnabled.length > 0)
        ? new Set(rawEnabled.map(w => String(w).trim().toLowerCase()))
        : (Array.isArray(rawEnabled) && rawEnabled.length === 0 ? new Set() : null)

      const workerList = []
      for (const w of workers) {
        const spec = w.spec
        const isCore = w.name === 'agy' || w.name === 'claude'
        const label = w.label || spec?.label || (w.name === 'agy' ? 'Antigravity CLI' : 'Claude Code CLI')
        const vendor = w.vendor || spec?.vendor || (w.name === 'agy' ? 'Google' : 'Anthropic')
        const bin = spec?.bin || (w.name === 'agy' ? (process.platform === 'win32' ? 'agy.exe' : 'agy') : (w.name === 'claude' ? (process.platform === 'win32' ? 'claude.exe' : 'claude') : w.name))
        const rawPath = workerPathOf(w.name, config) || bin
        const pathStr = Array.isArray(rawPath) ? rawPath.join(' ') : String(rawPath)

        let resolved = null
        if (Array.isArray(rawPath)) {
          resolved = (rawPath[0] && existsSync(rawPath[0])) ? rawPath[0] : null
        } else if (typeof rawPath === 'string' && rawPath.trim() !== '') {
          const target = rawPath.trim()
          if (isAbsolute(target) || target.includes('/') || target.includes('\\')) {
            resolved = existsSync(target) ? target : null
          } else {
            resolved = findInPath(target) || null
            if (!resolved && target === spec?.bin && Array.isArray(spec?.binAliases)) {
              for (const alias of spec.binAliases) {
                resolved = findInPath(alias) || null
                if (resolved) break
              }
            }
          }
        }

        const available = isWorkerAvailable(w.name, config)
        const probeRes = typeof w.preflight === 'function' ? w.preflight(config) : undefined
        const reason = available
          ? null
          : (probeRes && !probeRes.ok ? probeRes.reason : (resolved ? '不可用' : `未找到可执行文件或在 PATH 中未找到（配置值: ${pathStr}）`))
        const contract = spec?.contract || 'documented'
        const confidence = spec?.confidence || 'high'
        const tier = isCore ? 'core' : 'opt-in'
        const isEnabled = enabledSet !== null ? enabledSet.has(w.name) : isCore
        const source = spec?.source || (w.name === 'agy' ? ['https://antigravity.google'] : ['https://claude.ai/code'])

        const entry = {
          name: w.name,
          label,
          vendor,
          bin,
          path: pathStr,
          resolved,
          available,
          reason,
          contract,
          confidence,
          tier,
          enabled: isEnabled,
          source,
        }

        if (flags.probe) {
          if (resolved) {
            try {
              const probeProc = spawnSync(resolved, ['--version'], {
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'pipe'],
                encoding: 'utf8',
                windowsHide: true,
              })
              if (probeProc.error) {
                entry.probe = { status: 'failed', reason: probeProc.error.message }
              } else if (probeProc.status === 0) {
                const firstLine = (probeProc.stdout || probeProc.stderr || '').trim().split(/\r?\n/)[0]?.trim() || ''
                entry.probe = { status: 'ok', exitCode: 0, version: firstLine }
              } else {
                const firstLine = (probeProc.stderr || probeProc.stdout || '').trim().split(/\r?\n/)[0]?.trim() || ''
                entry.probe = { status: 'failed', exitCode: probeProc.status, reason: firstLine }
              }
            } catch (err) {
              entry.probe = { status: 'failed', reason: err?.message || String(err) }
            }
          } else {
            entry.probe = { status: 'failed', reason: '未找到可执行文件路径' }
          }
        }

        workerList.push(entry)
      }

      const enabledList = workerList.filter(w => w.enabled).map(w => w.name)
      const unknownWorkers = config.unknownWorkers || []

      if (flags.json) {
        const outputList = (flags.limit && Number.isFinite(flags.limit) && flags.limit > 0)
          ? workerList.slice(0, flags.limit)
          : workerList
        console.log(JSON.stringify({
          workers: outputList,
          enabled: enabledList,
          unknownWorkers,
        }, null, 2))
        process.exit(0)
      }

      // 人类可读表格
      const outputList = (flags.limit && Number.isFinite(flags.limit) && flags.limit > 0)
        ? workerList.slice(0, flags.limit)
        : workerList

      const rows = outputList.map(w => ({
        name: w.name,
        label: w.label,
        bin: w.bin,
        path: w.resolved || '未找到',
        contract: w.contract,
        confidence: w.confidence,
        tier: w.tier,
        enabled: w.enabled ? 'yes' : 'no',
        probe: w.probe ? (w.probe.status === 'ok' ? `ok (${w.probe.version})` : `failed (${w.probe.reason})`) : undefined,
      }))

      const colWidths = {
        name: Math.max(4, ...rows.map(r => r.name.length)),
        label: Math.max(5, ...rows.map(r => r.label.length)),
        bin: Math.max(3, ...rows.map(r => r.bin.length)),
        path: Math.max(10, ...rows.map(r => r.path.length)),
        contract: Math.max(8, ...rows.map(r => r.contract.length)),
        confidence: Math.max(10, ...rows.map(r => r.confidence.length)),
        tier: Math.max(6, ...rows.map(r => r.tier.length)),
        enabled: Math.max(8, ...rows.map(r => r.enabled.length)),
      }

      const pad = (s, w) => String(s).padEnd(w)
      const header = `${pad('NAME', colWidths.name)} ｜ ${pad('LABEL', colWidths.label)} ｜ ${pad('BIN', colWidths.bin)} ｜ ${pad('RESOLVED / STATUS', colWidths.path)} ｜ ${pad('CONTRACT', colWidths.contract)} ｜ ${pad('CONFIDENCE', colWidths.confidence)} ｜ ${pad('TIER', colWidths.tier)} ｜ ${pad('ENABLED?', colWidths.enabled)}`
      const divider = `${'—'.repeat(colWidths.name)} ｜ ${'—'.repeat(colWidths.label)} ｜ ${'—'.repeat(colWidths.bin)} ｜ ${'—'.repeat(colWidths.path)} ｜ ${'—'.repeat(colWidths.contract)} ｜ ${'—'.repeat(colWidths.confidence)} ｜ ${'—'.repeat(colWidths.tier)} ｜ ${'—'.repeat(colWidths.enabled)}`

      console.log(header)
      console.log(divider)
      for (const r of rows) {
        let line = `${pad(r.name, colWidths.name)} ｜ ${pad(r.label, colWidths.label)} ｜ ${pad(r.bin, colWidths.bin)} ｜ ${pad(r.path, colWidths.path)} ｜ ${pad(r.contract, colWidths.contract)} ｜ ${pad(r.confidence, colWidths.confidence)} ｜ ${pad(r.tier, colWidths.tier)} ｜ ${pad(r.enabled, colWidths.enabled)}`
        if (r.probe) {
          line += ` ｜ probe: ${r.probe}`
        }
        console.log(line)
      }

      process.exit(0)
    } catch (err) {
      console.error('获取工人列表失败:', err?.message || err)
      process.exit(2)
    }
  }

  console.error(`未知子命令: "${command}"。使用 "wolf help" 查看帮助。`)
  process.exit(1)
}

main().catch(err => {
  console.error('全局未捕获异常:', err)
  process.exit(1)
})
