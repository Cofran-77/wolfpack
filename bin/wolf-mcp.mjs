#!/usr/bin/env node

import { loadConfig } from '../src/config.mjs'
import { killRun, liveRuns, runDelegateTask } from '../src/delegate.mjs'
import { renderDigest, renderHealthReport, renderStatus } from '../src/digest.mjs'
import { defaultActiveRuns, RunsLedger } from '../src/ledger.mjs'
import { listLiveRecords } from '../src/live.mjs'
import {
  buildLivePayload,
  createLiveServer,
  enforcePayloadBounds,
  mergeLiveRecords,
  renderLiveSummary,
} from '../src/live-route.mjs'
// 运行时注入：导入 Node 运行时实现即注入（见 src/runtime/node.mjs 末尾），
// 核心层不 import 宿主模块。DSH 一类宿主换注入 src/runtime/dsh.mjs。
import { createNodeStallNotifier } from '../src/runtime/node.mjs'
import { renderTeamDigest, runTeamTasks } from '../src/team.mjs'
import { listWorkers } from '../src/worker/index.mjs'
import { healthConfigOf, readHealthState, snapshotHealth } from '../src/worker/health.mjs'

const config = loadConfig()
// 停滞报警的宿主外设：控制台 + 台账（src/delegate.mjs 的 reportStall），
// 桌面通知默认关（WOLFPACK_STALL_TOAST=1 才弹）。
config.stallToastNotifier = createNodeStallNotifier({ toast: config.stallToast === true })
const ledger = new RunsLedger(config.ledgerPath, config)

const TOOLS = [
  {
    name: 'wolf_delegate',
    description: '把一件自洽、可机械验收的活交给工人执行，并把实测证据带回。工人由狼群全自动挑选（agy 与 claude 装了谁用谁、两个都装则自动轮流），无需也无法指定，不要就工人选择征求用户同意；坏掉的工人（没输出/超时/额度或中转池子耗尽/未登录）会被自动冷却并改派另一个，收到 ⛔ 冷却提示时不要连续重派同一个 task_id。注意：工人看不到本会话，task 必须完整独立。同一个 task_id 的多轮会续用同一工人的会话（沿用会话才不浪费上下文）；换不相关的事必须换 task_id。同一个 task_id 不允许并发。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务稳定标识（如 fix-build、add-test）' },
        task: { type: 'string', description: '完整独立任务书：目标、交付物、以及怎样算完成。工人看不到本会话，task 必须完整独立。' },
        verify: { type: 'array', items: { type: 'string' }, description: '验收命令列表（在工作目录执行，如 npm test）' },
        verify_baseline: { type: 'array', items: { type: 'string' }, description: '派活前必须失败的基线检查命令。已有命令通过则直接判 stale 且不启动工人。' },
        fresh: { type: 'boolean', description: '是否强制冷启动、丢弃上一轮会话' },
        model: { type: 'string', description: '覆盖本次运行的模型（如 claude-opus-4-6-thinking）' },
      },
      required: ['task_id', 'task'],
    },
  },
  {
    name: 'wolf_status',
    description: '只读台账，回答「我派过哪些活、各自到哪了」，并顺带给出两个工人的健康与冷却状态。绝不启动工人、不跑验收。注意：回执会**整段进入你的上下文并常驻**（之后每轮都要重读一遍），它不是免费轮询——默认只列最近 5 条（还没结束的任务一定排最前），要更多传 limit，看单个任务传 task_id。给出轮数、最后 verdict、最后 stop_reason、累计 token 与 conversation_id 状态。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '可选：只查看此特定 task_id' },
        limit: { type: 'integer', description: '最多列出多少个任务（默认 20，上限 100）' },
      },
    },
  },
  {
    name: 'wolf_kill',
    description: '终止指定 task_id 正在运行的工人进程树。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要终止的任务 task_id' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'wolf_team',
    description: '一次调用受控并发派多个持久工人，并返回有界的汇总。工人由狼群全自动挑选（agy 与 claude 都在时自动轮流，天然把并发摊到两个工人上），无需也无法指定。注意：工人看不到本会话，task 必须完整独立。多个任务必须互相独立，同一个调用内严禁重复 task_id。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '并发委派任务列表（1 到 8 个）',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: '任务稳定标识' },
              task: { type: 'string', description: '完整独立任务书。工人看不到本会话，task 必须完整独立。' },
              verify: { type: 'array', items: { type: 'string' }, description: '验收命令列表' },
              verify_baseline: { type: 'array', items: { type: 'string' }, description: '基线命令列表' },
              fresh: { type: 'boolean', description: '是否强制冷启动' },
              model: { type: 'string', description: '覆盖模型' },
            },
            required: ['task_id', 'task'],
          },
        },
        concurrency: {
          type: 'integer',
          description: '最大并发任务数（1 到 4，默认 2）',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'wolf_live',
    description: '只读实时状态：正在跑什么、哪个工人在跑、跑到第几步、停滞监控现在什么状态。**按工人分区展示**（agy 与 claude 各一节，互不覆盖）。绝不启动工人、也不花工人的钱。注意：回执会**整段进入你的上下文并常驻**（之后每轮都要重读一遍），所以它不是免费的——长任务期间不要反复查，等它跑完看一次即可；要持续盯就给 wolf_panel 的地址（面板数据走浏览器，不进上下文）。默认不附带工人会话流水，确实要排查才传 transcript=true。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回几个运行（1 到 50，默认 8；两个工人会被轮转取样，保证都不缺席）' },
        transcript: { type: 'boolean', description: '是否附带工人会话流水片段。默认 false：流水会把工人原文灌进你的上下文并常驻，只在排查停滞时才打开。' },
      },
    },
  },
  {
    name: 'wolf_panel',
    description: '打开本地实时面板（只读 HTTP，默认只监听 127.0.0.1）。面板把 agy 与 claude 两个工人分开展示：各自的运行、步骤、会话流水、停滞监控与 token 累计，每 3 秒自刷新。返回面板 URL 与实时 JSON 路由，重复调用不会重复起服务。',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', description: '可选：覆盖面板端口（默认取配置 panelPort / WOLFPACK_PANEL_PORT，默认 8787；端口被占用时自动改用空闲端口）' },
      },
    },
  },
]

function sendJsonRpc(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/**
 * 组装实时面板所需的只读数据源。
 *
 * 面板与 MCP 是两个进程：进程内的 liveRuns 带活的 stallMonitor，
 * 磁盘登记文件（mergeLiveRecords）补上别的进程派发的任务，两者按 task_id 合并。
 *
 * @param {object} [extra]
 * @returns {Promise<object>}
 */
async function liveDataSources(extra = {}) {
  return {
    ledger,
    activeRuns: defaultActiveRuns,
    liveHandles: await mergeLiveRecords(config.rawDir, liveRuns),
    stallConfigs: config.stall,
    panelOptions: { refreshMs: config.panel?.refreshMs },
    ...extra,
  }
}

/** @type {{server: object, url: string, port: number, close: () => Promise<void>}|undefined} */
let panelServer

/**
 * 起（或复用）本地实时面板服务器。端口被占用时自动退回空闲端口——
 * 全程不问用户，也不因为端口冲突就失败。
 *
 * @param {number} [port]
 * @returns {Promise<{server: object, url: string, port: number, close: () => Promise<void>}>}
 */
async function ensurePanelServer(port) {
  if (panelServer !== undefined) return panelServer
  const host = config.panel?.host ?? '127.0.0.1'
  const wanted = Number.isInteger(port) && port > 0 && port < 65536 ? port : (config.panel?.port ?? 8787)
  const options = { config: await liveDataSources(), host, token: config.panel?.token }
  try {
    panelServer = await createLiveServer({ ...options, port: wanted })
  } catch {
    panelServer = await createLiveServer({ ...options, port: 0 })
  }
  return panelServer
}

function sendResponse(id, result) {
  sendJsonRpc({
    jsonrpc: '2.0',
    id,
    result,
  })
}

function sendError(id, code, message, data) {
  sendJsonRpc({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  })
}

async function handleRequest(req) {
  const { id, method, params } = req

  if (method === 'initialize') {
    return sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'wolfpack-codex',
        version: '1.0.0',
      },
    })
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    // 客户端通知，无需响应
    return
  }

  if (method === 'ping') {
    return sendResponse(id, {})
  }

  if (method === 'tools/list') {
    return sendResponse(id, {
      tools: TOOLS,
    })
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    const toolArgs = params?.arguments || {}

    try {
      if (toolName === 'wolf_delegate') {
        const res = await runDelegateTask({
          config,
          args: toolArgs,
          cwd: process.cwd(),
          ledger,
        })
        const digest = renderDigest(res)
        const isError = res.verdict === 'fail' || res.verdict === 'error'
        return sendResponse(id, {
          content: [{ type: 'text', text: digest }],
          isError,
          raw: res,
        })
      }

      if (toolName === 'wolf_status') {
        const allStates = [...(await ledger.read()).values()]
        const activeIds = new Set(defaultActiveRuns.list().map(r => r.taskId))
        const liveRecords = await listLiveRecords(config.rawDir)
        for (const r of liveRecords) {
          activeIds.add(r.taskId)
        }

        let filtered = toolArgs.task_id
          ? allStates.filter(s => s.taskId === toolArgs.task_id)
          : allStates

        // 还在跑的一定排在最前：纯按「最后登记时间」排序，会把跑了很久还没结束的任务
        // 挤到刚结束的历史任务后面——而调用方最关心的恰恰是它还在不在跑。
        // 判定同时看活登记与台账里的 verdict=running，MCP 进程重启过也认得出来；
        // 但必须同时要求 stop_reason 还是 running——被 kill 的任务最后一条只有
        // stop_reason=aborted，verdict 会停在 running 上，只认 verdict 会让它永远赖在第一条。
        const isRunningState = s => activeIds.has(s.taskId)
          || (s.lastVerdict === 'running' && s.lastStopReason === 'running')
        filtered.sort((a, b) => {
          const byRunning = (isRunningState(b) ? 1 : 0) - (isRunningState(a) ? 1 : 0)
          return byRunning !== 0 ? byRunning : (b.lastAt || 0) - (a.lastAt || 0)
        })

        // 默认只列最近 5 条：这段文本会整段进调用方上下文并常驻，历史台账是最没用的那部分
        const limit = toolArgs.limit && toolArgs.limit > 0 ? Math.min(toolArgs.limit, 100) : 5
        const truncated = filtered.length > limit

        const budgetLimit = typeof config.continuationTokenBudget === 'number' && config.continuationTokenBudget > 0
          ? config.continuationTokenBudget
          : undefined

        const displayTasks = filtered.slice(0, limit).map(s => {
          const used = s.totalTokens || 0
          return {
            task_id: s.taskId,
            worker: s.worker,
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

        // 工人健康（谁在冷却、冷却到什么时候）：与 status 一并返回，没调用新工具也能看到
        const healthConfig = healthConfigOf(config)
        const healthState = await readHealthState(config.workerHealth?.filePath)
        const workerHealth = {
          enabled: healthConfig.enabled,
          file_path: config.workerHealth?.filePath,
          fail_threshold: healthConfig.failThreshold,
          workers: listWorkers().map(w => snapshotHealth(healthState, w.name)),
        }
        statusOutput.worker_health = workerHealth

        return sendResponse(id, {
          content: [{
            type: 'text',
            text: `${renderStatus(statusOutput)}\n\n${renderHealthReport({
              workers: workerHealth.workers,
              file_path: workerHealth.file_path,
              enabled: workerHealth.enabled,
              fail_threshold: workerHealth.fail_threshold,
            })}`,
          }],
          raw: statusOutput,
        })
      }

      if (toolName === 'wolf_kill') {
        const taskId = toolArgs.task_id
        if (!taskId) {
          return sendResponse(id, {
            content: [{ type: 'text', text: '缺少必填参数 task_id' }],
            isError: true,
          })
        }
        const res = await killRun(taskId, ledger, config)
        return sendResponse(id, {
          content: [{
            type: 'text',
            text: res.ok ? `任务 "${taskId}" 已成功终止 (runId: ${res.runId})` : `终止失败: ${res.reason}`,
          }],
          isError: !res.ok,
        })
      }

      if (toolName === 'wolf_team') {
        const res = await runTeamTasks({
          config,
          tasks: toolArgs.tasks,
          concurrency: toolArgs.concurrency,
          cwd: process.cwd(),
          ledger,
        })
        const digest = renderTeamDigest(res)
        const hasFailure = (res.counts?.fail || 0) > 0 || (res.counts?.error || 0) > 0
        return sendResponse(id, {
          content: [{ type: 'text', text: digest }],
          isError: hasFailure,
          raw: res,
        })
      }

      if (toolName === 'wolf_live') {
        const limit = Number.isFinite(toolArgs.limit) ? toolArgs.limit : undefined
        const payload = await buildLivePayload(await liveDataSources(limit === undefined ? {} : { maxRuns: limit }))
        return sendResponse(id, {
          content: [{ type: 'text', text: renderLiveSummary(payload, { transcript: toolArgs.transcript === true }) }],
          raw: JSON.parse(enforcePayloadBounds(payload)),
        })
      }

      if (toolName === 'wolf_panel') {
        const panel = await ensurePanelServer(toolArgs.port)
        const liveUrl = `http://${config.panel?.host ?? '127.0.0.1'}:${panel.port}/wolfpack/live`
        const text = [
          '🐺 狼群实时面板已就绪（数据只走浏览器、不进你的上下文，两个工人分开展示）',
          `面板：${panel.url}`,
          `实时 JSON：${liveUrl}`,
          '面板把 agy 与 claude 各自的运行、步骤、会话流水、停滞监控与 token 累计分开显示，每 3 秒自刷新；关掉 MCP 进程面板即停止。',
        ].join('\n')
        return sendResponse(id, {
          content: [{ type: 'text', text }],
          raw: { url: panel.url, live_url: liveUrl, port: panel.port },
        })
      }

      return sendError(id, -32601, `未找到工具 "${toolName}"`)
    } catch (err) {
      console.error(`[wolf-mcp] 工具 "${toolName}" 执行异常:`, err)
      return sendResponse(id, {
        content: [{ type: 'text', text: `工具调用错误: ${err?.message || err}` }],
        isError: true,
      })
    }
  }

  if (id !== undefined) {
    return sendError(id, -32601, `未定义的方法 "${method}"`)
  }
}

// ── 标准输入流解析（支持 NDJSON 及 Content-Length 帧传输）────────────────
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk

  while (true) {
    // 1. Content-Length 帧头处理
    if (buffer.startsWith('Content-Length:')) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const header = buffer.slice(0, headerEnd)
      const lenMatch = header.match(/Content-Length:[ \t]*(\d+)/i)
      if (!lenMatch) {
        buffer = buffer.slice(headerEnd + 4)
        continue
      }
      const len = parseInt(lenMatch[1], 10)
      const totalLen = headerEnd + 4 + len
      if (buffer.length < totalLen) break
      const body = buffer.slice(headerEnd + 4, totalLen)
      buffer = buffer.slice(totalLen)
      try {
        const req = JSON.parse(body)
        handleRequest(req).catch(e => console.error('[wolf-mcp] 请求处理失败:', e))
      } catch (err) {
        console.error('[wolf-mcp] JSON 解析失败:', err)
      }
      continue
    }

    // 2. 按行（NDJSON）切分处理
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) break
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (!line) continue

    try {
      const req = JSON.parse(line)
      handleRequest(req).catch(e => console.error('[wolf-mcp] 请求处理失败:', e))
    } catch (err) {
      console.error('[wolf-mcp] JSON 行解析失败:', err)
    }
  }
})
