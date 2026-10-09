#!/usr/bin/env node

import { createNodeRuntime } from '../lib/runtime/node.mjs'
import { loadConfig } from '../lib/core/config.mjs'
import { killRun, runDelegateTask } from '../lib/core/delegate.mjs'
import { renderDigest, renderStatus } from '../lib/core/digest.mjs'
import { defaultActiveRuns, queryWolfStatus, RunsLedger } from '../lib/core/ledger.mjs'
import { renderTeamDigest, runTeamTasks } from '../lib/core/team.mjs'

const config = loadConfig()
config.stallToastNotifier = ({ line }) => {
  try { process.stderr.write(`${line}\n`) } catch {}
}
const ledger = new RunsLedger(config.ledgerPath, config)
const runtime = createNodeRuntime()

const TOOLS = [
  {
    name: 'wolf_delegate',
    description: '把一件自洽、可机械验收的活交给 agy（Antigravity CLI）执行，并把实测证据带回。注意：agy 看不到本会话，task 必须完整独立。同一个 task_id 的多轮会续用 agy 会话；换不相关的事必须换 task_id。同一个 task_id 不允许并发。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务稳定标识（如 fix-build、add-test）' },
        task: { type: 'string', description: '完整独立任务书：目标、交付物、以及怎样算完成。agy 看不到本会话，task 必须完整独立。' },
        verify: { type: 'array', items: { type: 'string' }, description: '验收命令列表（在工作目录执行，如 npm test）' },
        verify_baseline: { type: 'array', items: { type: 'string' }, description: '派活前必须失败的基线检查命令。已有命令通过则直接判 stale 且不启动 agy。' },
        fresh: { type: 'boolean', description: '是否强制冷启动、丢弃上一轮会话' },
        model: { type: 'string', description: '覆盖本次运行的模型（如 claude-opus-4-6-thinking）' },
      },
      required: ['task_id', 'task'],
    },
  },
  {
    name: 'wolf_status',
    description: '只读台账，回答「我派过哪些活、各自到哪了」。注意：纯只读，绝不启动 agy、不跑验收、不消耗配额。给出轮数、最后 verdict、最后 stop_reason、累计 token 与 conversation_id 状态。',
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
    description: '一次调用受控并发派多个持久 agy 工人，并返回有界的汇总。注意：agy 看不到本会话，task 必须完整独立。多个任务必须互相独立，同一个调用内严禁重复 task_id。',
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
              task: { type: 'string', description: '完整独立任务书。agy 看不到本会话，task 必须完整独立。' },
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
]

function sendJsonRpc(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
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

/**
 * 处理单个 JSON-RPC 请求。
 *
 * @param {Record<string, any>} req
 */
export async function handleRpcRequest(req) {
  const { id, method, params } = req

  if (method === 'initialize') {
    return sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'wolfpack-unified-mcp',
        version: '2.0.0',
      },
    })
  }

  if (method === 'notifications/initialized') {
    return
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
          runtime,
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
        const statusOutput = await queryWolfStatus({
          ledger,
          taskId: toolArgs.task_id,
          limit: toolArgs.limit,
          config,
          registry: defaultActiveRuns,
        })

        return sendResponse(id, {
          content: [{ type: 'text', text: renderStatus(statusOutput) }],
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
          runtime,
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

  // 1. 处理 Content-Length 头部帧模式
  while (true) {
    if (buffer.startsWith('Content-Length:')) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break

      const lenMatch = buffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i)
      if (!lenMatch) {
        buffer = buffer.slice(headerEnd + 4)
        continue
      }

      const contentLength = parseInt(lenMatch[1], 10)
      const bodyStart = headerEnd + 4
      if (buffer.length < bodyStart + contentLength) break

      const body = buffer.slice(bodyStart, bodyStart + contentLength)
      buffer = buffer.slice(bodyStart + contentLength)

      try {
        const req = JSON.parse(body)
        handleRpcRequest(req).catch(e => console.error('[wolf-mcp] 请求处理异常:', e))
      } catch (err) {
        console.error('[wolf-mcp] JSON 解析失败 (Content-Length 模式):', err)
      }
      continue
    }

    // 2. 处理标准单行 NDJSON 模式
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) break

    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)

    if (!line) continue

    try {
      const req = JSON.parse(line)
      handleRpcRequest(req).catch(e => console.error('[wolf-mcp] 请求处理异常:', e))
    } catch (err) {
      console.error('[wolf-mcp] JSON 解析失败 (NDJSON 模式):', err)
    }
  }
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
