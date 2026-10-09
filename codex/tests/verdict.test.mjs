import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { runDelegateTask } from '../src/delegate.mjs'
import { RunsLedger } from '../src/ledger.mjs'
import { cleanTempDir, createTempDir, fakeWorkerPath } from './test-helper.mjs'

function initGitRepo(dir) {
  spawnSync('git', ['init'], { cwd: dir, windowsHide: true })
  spawnSync('git', ['config', 'user.name', 'WolfpackTester'], { cwd: dir, windowsHide: true })
  spawnSync('git', ['config', 'user.email', 'test@wolfpack.local'], { cwd: dir, windowsHide: true })
  writeFileSync(join(dir, 'README.md'), '# Initial', 'utf8')
  spawnSync('git', ['add', '.'], { cwd: dir, windowsHide: true })
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, windowsHide: true })
}

export const tests = [
  {
    name: 'verdict-pass',
    async run() {
      const tempDir = createTempDir('verdict-pass-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
            shell: [process.execPath, '-e'],
          },
          args: {
            task_id: 'test-verdict-pass',
            task: 'Task should pass',
            verify: ['process.exit(0)'],
          },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res.verdict, 'pass')
        assert.equal(res.stop_reason, 'completed')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'verdict-fail',
    async run() {
      const tempDir = createTempDir('verdict-fail-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
            shell: [process.execPath, '-e'],
          },
          args: {
            task_id: 'test-verdict-fail',
            task: 'Task should fail',
            verify: ['process.exit(1)'],
          },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res.verdict, 'fail')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'verdict-unverified',
    async run() {
      const tempDir = createTempDir('verdict-unverified-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'test-verdict-unverified',
            task: 'Task with no verify commands',
          },
          cwd: tempDir,
          ledger,
        })

        // 铁律：不给 verify 就是 unverified，不许默认成 pass
        assert.equal(res.verdict, 'unverified')
        assert.notEqual(res.verdict, 'pass')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'verdict-artifact-rescue',
    async run() {
      const tempDir = createTempDir('verdict-rescue-')
      initGitRepo(tempDir)
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      const origStatus = process.env.FAKE_WORKER_STATUS
      const origTouch = process.env.FAKE_WORKER_TOUCH_FILES
      try {
        process.env.FAKE_WORKER_STATUS = 'ERROR'
        process.env.FAKE_WORKER_TOUCH_FILES = JSON.stringify(['generated_rescue_file.txt'])

        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'test-verdict-rescue',
            task: 'Task reports error but writes file',
          },
          cwd: tempDir,
          ledger,
        })

        // 铁律：工人自报 ERROR 但磁盘有产物 → 判定完成（stop_reason: completed）
        assert.equal(res.stop_reason, 'completed')
        assert.match(res.diagnostic, /自报 ERROR.*检测到磁盘产物/)
      } finally {
        if (origStatus !== undefined) process.env.FAKE_WORKER_STATUS = origStatus
        else delete process.env.FAKE_WORKER_STATUS
        if (origTouch !== undefined) process.env.FAKE_WORKER_TOUCH_FILES = origTouch
        else delete process.env.FAKE_WORKER_TOUCH_FILES
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'verify-error-vs-fail',
    async run() {
      const tempDir = createTempDir('verify-error-vs-fail-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
            shell: 'non_existent_shell_bin_xyz_777',
          },
          args: {
            task_id: 'test-error-vs-fail',
            task: 'Verify command fails to run',
            verify: ['do-something'],
          },
          cwd: tempDir,
          ledger,
        })

        // 铁律：验收命令跑不起来 = error，绝不是 fail！
        assert.equal(res.verdict, 'error')
        assert.notEqual(res.verdict, 'fail')
        assert.equal(res.verify[0]?.ran, false)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
