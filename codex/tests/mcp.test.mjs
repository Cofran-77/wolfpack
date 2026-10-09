import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { projectRoot } from './test-helper.mjs'

/**
 * 真起一个 MCP 进程问一次 tools/list（不 mock 任何东西）。
 *
 * @returns {Promise<object[]>} MCP 工具定义数组
 */
async function listTools() {
  const mcpScript = join(projectRoot, 'bin', 'wolf-mcp.mjs')
  const proc = spawn(process.execPath, [mcpScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const lines = []
  let resolveOutput
  const outputPromise = new Promise(resolve => {
    resolveOutput = resolve
  })

  proc.stdout.setEncoding('utf8')
  let buffer = ''
  proc.stdout.on('data', chunk => {
    buffer += chunk
    while (true) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) {
        try {
          lines.push(JSON.parse(line))
          if (lines.length >= 2) {
            resolveOutput(lines)
          }
        } catch {}
      }
    }
  })

  // 铁律：把 initialize + tools/list 两行 JSON-RPC 喂给 bin/wolf-mcp.mjs
  const initReq = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }) + '\n'

  const listReq = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  }) + '\n'

  proc.stdin.write(initReq)
  proc.stdin.write(listReq)

  const received = await Promise.race([
    outputPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('MCP server 响应超时')), 5000)),
  ])

  proc.stdin.end()
  proc.kill()

  const listResp = received.find(r => r.id === 2)
  assert(listResp, '必须收到 id: 2 的 tools/list 响应')
  return listResp.result?.tools || []
}

export const tests = [
  {
    name: 'mcp-tools-list',
    async run() {
      const tools = await listTools()
      const toolNames = tools.map(t => t.name)

      // 断言返回里含 6 个工具名（4 个委派工具 + 实时面板只读工具）
      assert.equal(toolNames.length, 6)
      assert(toolNames.includes('wolf_delegate'))
      assert(toolNames.includes('wolf_status'))
      assert(toolNames.includes('wolf_kill'))
      assert(toolNames.includes('wolf_team'))
      assert(toolNames.includes('wolf_live'))
      assert(toolNames.includes('wolf_panel'))
    },
  },
  {
    name: 'mcp-readonly-copy-admits-context-cost',
    async run() {
      const tools = await listTools()
      const live = tools.find(t => t.name === 'wolf_live')
      const status = tools.find(t => t.name === 'wolf_status')

      // 根因护栏：这两个工具的回执会整段进入调用方上下文并常驻，
      // 说明里只要还写着「零 token / 不消耗配额」，模型就会当成免费轮询往死里调。
      for (const tool of [live, status]) {
        const desc = tool.description ?? ''
        assert.doesNotMatch(
          desc,
          /零 token|不消耗配额/,
          `${tool.name} 的回执会进上下文，不许自称零成本`,
        )
        assert.match(desc, /上下文/, `${tool.name} 必须如实说明回执会进调用方上下文`)
      }

      assert.ok(
        live.inputSchema?.properties?.transcript,
        'wolf_live 必须提供 transcript 开关，默认不把工人原文灌回主上下文',
      )
      assert.equal(live.inputSchema.properties.transcript.type, 'boolean')
      assert.match(
        String(live.inputSchema.properties.transcript.description ?? ''),
        /默认/,
        'transcript 开关必须写清默认值',
      )
    },
  },
]
