#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * 模拟 Claude Code CLI（`claude -p ... --output-format json`）的输出信封。
 * 字段名与真实 claude 2.1.x 实测结果一致（顶层 type/subtype/is_error/session_id/usage/
 * subagent_stats 等），契约细节见 docs/DESIGN.md。
 */
async function main() {
  const env = process.env

  // 1. 模拟挂起/超时
  if (env.FAKE_CLAUDE_HANG === 'true' || env.FAKE_CLAUDE_HANG === '1') {
    setInterval(() => {}, 1 << 30)
    return
  }

  // 2. 会话 ID：环境变量优先，其次从 --resume 读取（模拟续跑）
  const args = process.argv.slice(2)
  let sessionId = env.FAKE_CLAUDE_SESSION_ID
  if (!sessionId) {
    const idx = args.indexOf('--resume')
    sessionId = idx !== -1 && idx + 1 < args.length
      ? args[idx + 1]
      : 'fake-claude-session-' + Math.random().toString(36).slice(2, 10)
  }

  // 3. 模拟磁盘产物写入
  if (env.FAKE_CLAUDE_TOUCH_FILES) {
    try {
      const filesToTouch = JSON.parse(env.FAKE_CLAUDE_TOUCH_FILES)
      if (Array.isArray(filesToTouch)) {
        for (const rel of filesToTouch) {
          const abs = resolve(process.cwd(), rel)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, 'fake-claude-content-' + Date.now(), 'utf8')
        }
      }
    } catch (err) {
      console.error('[fake-claude] 写产物失败:', err)
    }
  }

  const isError = env.FAKE_CLAUDE_IS_ERROR === '1' || env.FAKE_CLAUDE_IS_ERROR === 'true'
  const summary = env.FAKE_CLAUDE_SUMMARY || (isError ? 'Fake claude failed.' : 'Fake claude succeeded.')

  let claimedFiles = []
  if (env.FAKE_CLAUDE_TOUCH_FILES) {
    try { claimedFiles = JSON.parse(env.FAKE_CLAUDE_TOUCH_FILES) } catch {}
  }

  const spawned = Number(env.FAKE_CLAUDE_SUBAGENTS || 0)
  const apiStatus = env.FAKE_CLAUDE_API_STATUS !== undefined ? Number(env.FAKE_CLAUDE_API_STATUS) : null

  const envelope = {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    api_error_status: apiStatus,
    session_id: sessionId,
    result: JSON.stringify({ summary, claimed_files: claimedFiles }),
    structured_output: { summary, claimed_files: claimedFiles },
    duration_ms: 1200,
    duration_api_ms: 900,
    num_turns: 3,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 1200,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 0,
      output_tokens: 80,
      output_tokens_details: { thinking_tokens: 10 },
    },
    permission_denials: [],
    subagent_stats: { spawned, max_depth: spawned > 0 ? 1 : 0 },
  }

  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')

  const exitCode = env.FAKE_CLAUDE_EXIT_CODE !== undefined ? Number(env.FAKE_CLAUDE_EXIT_CODE) : 0
  process.exit(exitCode)
}

main().catch(err => {
  console.error('[fake-claude] 异常:', err)
  process.exit(1)
})
