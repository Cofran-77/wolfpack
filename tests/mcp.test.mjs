import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { projectRoot } from './test-helper.mjs'

export const tests = [
  {
    name: 'mcp-tools-list',
    async run() {
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
      const tools = listResp.result?.tools || []
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
]
