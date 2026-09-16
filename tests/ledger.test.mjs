import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { cleanTempDir, createTempDir, projectRoot } from './test-helper.mjs'

export const tests = [
  {
    name: 'ledger-status',
    async run() {
      const tempDir = createTempDir('ledger-status-')
      const nonExistentLedger = join(tempDir, 'non_existent_runs.ndjson')
      const wolfCli = join(projectRoot, 'bin', 'wolf.mjs')

      try {
        const proc = spawnSync(process.execPath, [wolfCli, 'status', '--json'], {
          cwd: tempDir,
          env: {
            ...process.env,
            WOLFPACK_LEDGER: nonExistentLedger,
          },
          encoding: 'utf8',
          windowsHide: true,
        })

        // 铁律：台账不存在时也要正常退出 0，纯只读
        assert.equal(proc.status, 0, `CLI status 命令必须退出 0，实际为 ${proc.status}, stderr: ${proc.stderr}`)
        const parsed = JSON.parse(proc.stdout)
        assert.deepEqual(parsed.tasks, [])
        assert.equal(parsed.total, 0)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'status-changed-files-undetermined',
    async run() {
      const tempDir = createTempDir('status-undetermined-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const rawDir = join(tempDir, 'raw')
      const wolfCli = join(projectRoot, 'bin', 'wolf.mjs')
      const fakeWorker = join(projectRoot, 'tests', 'fixtures', 'fake-worker.mjs')

      try {
        // 1. 在非 git 目录下委派任务（没有启动真实 git 探测或探测不到）
        const delegateRes = spawnSync(
          process.execPath,
          [
            wolfCli,
            'delegate',
            '--task-id',
            'task-undetermined-1',
            '--task',
            'Do nothing in non-git',
          ],
          {
            cwd: tempDir,
            env: {
              ...process.env,
              WOLFPACK_AGY: fakeWorker,
              WOLFPACK_LEDGER: ledgerPath,
              WOLFPACK_RAW_DIR: rawDir,
            },
            encoding: 'utf8',
            windowsHide: true,
          },
        )
        assert.equal(delegateRes.status, 0, `delegate 应成功退出 0: ${delegateRes.stderr}`)

        // 2. 验证 status --json 暴露布尔字段 changed_files_determined
        const jsonRes = spawnSync(
          process.execPath,
          [wolfCli, 'status', '--json'],
          {
            cwd: tempDir,
            env: {
              ...process.env,
              WOLFPACK_LEDGER: ledgerPath,
              WOLFPACK_RAW_DIR: rawDir,
            },
            encoding: 'utf8',
            windowsHide: true,
          },
        )
        assert.equal(jsonRes.status, 0)
        const parsed = JSON.parse(jsonRes.stdout)
        const task1 = parsed.tasks.find(t => t.task_id === 'task-undetermined-1')
        assert.ok(task1, '必须找到 task-undetermined-1')
        assert.strictEqual(task1.changed_files_determined, false, '非 git 目录下 changed_files_determined 必须为 false')

        // 3. 验证文本 status 渲染为「改动未探测」，严禁出现「改动 0 个文件」
        const textRes = spawnSync(
          process.execPath,
          [wolfCli, 'status'],
          {
            cwd: tempDir,
            env: {
              ...process.env,
              WOLFPACK_LEDGER: ledgerPath,
              WOLFPACK_RAW_DIR: rawDir,
            },
            encoding: 'utf8',
            windowsHide: true,
          },
        )
        assert.equal(textRes.status, 0)
        const line1 = textRes.stdout.split('\n').find(l => l.includes('task-undetermined-1')) || ''
        assert.match(line1, /改动未探测/, '文本输出必须包含「改动未探测」')
        assert.equal(line1.includes('改动 0 个文件'), false, '未探测时严禁出现「改动 0 个文件」')

        // 4. 验证基线未过（stale）未启动工人时，也是 false 且显示「改动未探测」
        const staleRes = spawnSync(
          process.execPath,
          [
            wolfCli,
            'delegate',
            '--task-id',
            'task-stale-1',
            '--task',
            'Stale task',
            '--verify-baseline',
            'node -e "process.exit(0)"',
          ],
          {
            cwd: tempDir,
            env: {
              ...process.env,
              WOLFPACK_AGY: fakeWorker,
              WOLFPACK_LEDGER: ledgerPath,
              WOLFPACK_RAW_DIR: rawDir,
            },
            encoding: 'utf8',
            windowsHide: true,
          },
        )
        assert.equal(staleRes.status, 0)

        const staleJsonRes = spawnSync(
          process.execPath,
          [wolfCli, 'status', '--json', '--task-id', 'task-stale-1'],
          {
            cwd: tempDir,
            env: {
              ...process.env,
              WOLFPACK_LEDGER: ledgerPath,
              WOLFPACK_RAW_DIR: rawDir,
            },
            encoding: 'utf8',
            windowsHide: true,
          },
        )
        const staleParsed = JSON.parse(staleJsonRes.stdout)
        const staleTask = staleParsed.tasks.find(t => t.task_id === 'task-stale-1')
        assert.ok(staleTask)
        assert.strictEqual(staleTask.changed_files_determined, false, '未启动工人时 changed_files_determined 必须为 false')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
