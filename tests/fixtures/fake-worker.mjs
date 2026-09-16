#!/usr/bin/env node

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

async function main() {
  const env = process.env

  // 1. 模拟挂起/超时
  if (env.FAKE_WORKER_HANG === 'true' || env.FAKE_WORKER_HANG === '1') {
    setInterval(() => {}, 1 << 30) // 真正持有事件循环
    return
  }

  // 2. 解析命令行参数
  const args = process.argv.slice(2)
  let convId = env.FAKE_WORKER_CONVERSATION_ID

  if (!convId) {
    const convIdx = args.indexOf('--conversation')
    if (convIdx !== -1 && convIdx + 1 < args.length) {
      convId = args[convIdx + 1]
    } else {
      convId = 'fake-session-' + Math.random().toString(36).slice(2, 10)
    }
  }

  // 3. 模拟磁盘产物写入
  if (env.FAKE_WORKER_TOUCH_FILES) {
    try {
      const filesToTouch = JSON.parse(env.FAKE_WORKER_TOUCH_FILES)
      if (Array.isArray(filesToTouch)) {
        for (const rel of filesToTouch) {
          const abs = resolve(process.cwd(), rel)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, 'fake-content-' + Date.now(), 'utf8')
        }
      }
    } catch (err) {
      console.error('[fake-worker] 写产物失败:', err)
    }
  }

  // 4. 构建返回 JSON
  const status = env.FAKE_WORKER_STATUS || 'SUCCESS'
  const errorMsg = env.FAKE_WORKER_ERROR || (status === 'ERROR' ? 'Unknown fake worker error' : undefined)
  const responseText = env.FAKE_WORKER_RESPONSE || (status === 'SUCCESS' ? 'Fake worker succeeded.' : 'Fake worker failed.')
  const summary = env.FAKE_WORKER_SUMMARY || responseText

  let claimedFiles = []
  if (env.FAKE_WORKER_CLAIMED_FILES) {
    try {
      claimedFiles = JSON.parse(env.FAKE_WORKER_CLAIMED_FILES)
    } catch {}
  } else if (env.FAKE_WORKER_TOUCH_FILES) {
    try {
      claimedFiles = JSON.parse(env.FAKE_WORKER_TOUCH_FILES)
    } catch {}
  }

  const tokens = Number(env.FAKE_WORKER_TOKENS || 500)

  const outputObj = {
    conversation_id: convId,
    status,
    response: responseText,
    ...(errorMsg ? { error: errorMsg } : {}),
    duration_seconds: 0.1,
    num_turns: 1,
    usage: {
      input_tokens: Math.round(tokens * 0.6),
      output_tokens: Math.round(tokens * 0.4),
      total_tokens: tokens,
    },
    structured_output: {
      summary,
      claimed_files: claimedFiles,
      modified_files: claimedFiles,
    },
  }

  process.stdout.write(JSON.stringify(outputObj, null, 2) + '\n')

  const exitCode = env.FAKE_WORKER_EXIT_CODE !== undefined ? Number(env.FAKE_WORKER_EXIT_CODE) : 0
  process.exit(exitCode)
}

main().catch(err => {
  console.error('[fake-worker] 异常:', err)
  process.exit(1)
})
