import assert from 'node:assert/strict'
import { join } from 'node:path'

import { runDelegateTask } from '../src/delegate.mjs'
import { RunsLedger } from '../src/ledger.mjs'
import { cleanTempDir, createTempDir, fakeWorkerPath } from './test-helper.mjs'

export const tests = [
  {
    name: 'continuation-resume',
    async run() {
      const tempDir = createTempDir('cont-resume-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      const origId = process.env.FAKE_WORKER_CONVERSATION_ID
      try {
        process.env.FAKE_WORKER_CONVERSATION_ID = 'test-session-resume-123'

        // 第 1 轮
        const res1 = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'task-resume',
            task: 'First round',
          },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res1.round, 1)
        assert.equal(res1.conversation_id, 'test-session-resume-123')
        assert.equal(res1.continued, false)

        // 第 2 轮（取消强制固定 ID 环境变量，让 fake-worker 依赖 argv 传入的 --conversation）
        delete process.env.FAKE_WORKER_CONVERSATION_ID

        const res2 = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'task-resume',
            task: 'Second round continuation',
          },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res2.round, 2)
        assert.equal(res2.continued, true)
        // fake-worker 提取自 argv 中的 --conversation
        assert.equal(res2.conversation_id, 'test-session-resume-123')
      } finally {
        if (origId !== undefined) process.env.FAKE_WORKER_CONVERSATION_ID = origId
        else delete process.env.FAKE_WORKER_CONVERSATION_ID
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'continuation-forced-fresh',
    async run() {
      const tempDir = createTempDir('cont-fresh-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      const origId = process.env.FAKE_WORKER_CONVERSATION_ID
      try {
        process.env.FAKE_WORKER_CONVERSATION_ID = 'session-to-be-abandoned'

        // 第 1 轮建立会话
        const res1 = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'task-fresh',
            task: 'First round',
          },
          cwd: tempDir,
          ledger,
        })
        assert.equal(res1.conversation_id, 'session-to-be-abandoned')

        // 第 2 轮使用 --fresh 强制冷启动
        delete process.env.FAKE_WORKER_CONVERSATION_ID
        const res2 = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'task-fresh',
            task: 'Second round forced fresh',
            fresh: true,
          },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res2.round, 2)
        assert.equal(res2.continued, false)
        assert.equal(res2.fresh_reason, 'forced-fresh')
        // fake-worker 未收到 --conversation，因此重新生成了全新的 session ID
        assert.notEqual(res2.conversation_id, 'session-to-be-abandoned')
      } finally {
        if (origId !== undefined) process.env.FAKE_WORKER_CONVERSATION_ID = origId
        else delete process.env.FAKE_WORKER_CONVERSATION_ID
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'continuation-token-budget',
    async run() {
      const tempDir = createTempDir('cont-budget-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        // 在台账中直接写入上一轮消耗超额 token 的记录
        await ledger.record({
          taskId: 'task-budget',
          round: 1,
          conversationId: 'session-budget-123',
          tokens: 1_200_000,
          stopReason: 'completed',
          verdict: 'pass',
        })

        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
            continuationTokenBudget: 1_000_000,
          },
          args: {
            task_id: 'task-budget',
            task: 'Should cold start due to budget',
          },
          cwd: tempDir,
          ledger,
        })

        // 铁律：累计超预算 → 冷启动，理由字符串里带真实数字！
        assert.equal(res.continued, false)
        assert.equal(res.fresh_reason, 'token-budget(已用 1200000 ≥ 1000000)')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
