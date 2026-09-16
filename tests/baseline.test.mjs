import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runDelegateTask } from '../src/delegate.mjs'
import { RunsLedger } from '../src/ledger.mjs'
import { cleanTempDir, createTempDir, fakeWorkerPath } from './test-helper.mjs'

export const tests = [
  {
    name: 'baseline-none',
    async run() {
      const tempDir = createTempDir('baseline-none-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'test-base-none',
            task: 'Do something without baseline',
            verify_baseline: [],
          },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res.verdict, 'unverified')
        assert.equal(res.stop_reason, 'completed')
        assert.equal(res.continued, false)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'baseline-stale',
    async run() {
      const tempDir = createTempDir('baseline-stale-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      // 使用 node -e 立即退出 0 模拟已经通过的基线命令
      const passingCmd = `"${process.execPath}" -e "process.exit(0)"`

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
            shell: [process.execPath, '-e'],
          },
          args: {
            task_id: 'test-base-stale',
            task: 'Task that should be stale',
            verify_baseline: ['process.exit(0)'],
          },
          cwd: tempDir,
          ledger,
        })

        // 铁律：基线有一条通过 -> verdict=stale，且完全没有启动工人（stop_reason: skipped）
        assert.equal(res.verdict, 'stale')
        assert.equal(res.stop_reason, 'skipped')
        assert.equal(res.changed_files_determined, false)
        assert.match(res.diagnostic, /基线命令已经通过/)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'baseline-error',
    async run() {
      const tempDir = createTempDir('baseline-error-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
            shell: 'non_existent_shell_xyz_123456789',
          },
          args: {
            task_id: 'test-base-error',
            task: 'Task with broken baseline shell',
            verify_baseline: ['any command'],
          },
          cwd: tempDir,
          ledger,
        })

        // 铁律：基线命令跑不起来 -> verdict=error，没有启动工人
        assert.equal(res.verdict, 'error')
        assert.equal(res.stop_reason, 'skipped')
        assert.match(res.diagnostic, /基线命令没有跑起来/)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
