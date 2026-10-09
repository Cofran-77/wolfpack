import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { killRun, runDelegateTask } from '../src/delegate.mjs'
import { RunsLedger } from '../src/ledger.mjs'
import { readLiveRecord } from '../src/live.mjs'
import { cleanTempDir, createTempDir, fakeWorkerPath, projectRoot } from './test-helper.mjs'

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
    name: 'status-filesystem-determined-and-stale-undetermined',
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
        assert.strictEqual(task1.changed_files_determined, true, '非 git 目录通过文件快照确定改动')

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
        assert.match(line1, /改动 0 个文件/, '完整快照应显示零改动')
        assert.equal(line1.includes('改动未探测'), false, '完整快照不应显示未探测')

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
  {
    name: 'dispatch-start-recorded-before-worker-finishes',
    async run() {
      const tempDir = createTempDir('dispatch-start-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const rawDir = join(tempDir, 'raw')

      let delegatePromise
      const origHang = process.env.FAKE_WORKER_HANG
      try {
        process.env.FAKE_WORKER_HANG = '1'

        delegatePromise = runDelegateTask({
          config: { agyPath: fakeWorkerPath, ledgerPath, rawDir },
          args: { task_id: 'task-dispatch-start', task: 'Dispatch start record test' },
          cwd: tempDir,
          ledger: new RunsLedger(ledgerPath),
        }).catch(() => {})

        // 工人仍在挂起时，台账里必须已经能看到这次派发；
        // 这样即便 CLI 进程在任务中途被中断，也不会留下「完全无痕」的派发。
        let latest
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 50))
          latest = await new RunsLedger(ledgerPath).latest('task-dispatch-start')
          if (latest) break
        }

        assert.ok(latest, '工人仍在运行时，台账里必须已经能看到这次派发')
        assert.equal(latest.lastStopReason, 'running', '派发中的记录必须标记为 running')
        assert.equal(latest.lastVerdict, 'running', '派发中的记录不得冒充已完成的 verdict')
        assert.equal(latest.taskId, 'task-dispatch-start')

        // 必须等 worker 真正启动（live 登记里出现 workerPid）再杀：
        // 否则 killRun 会落在 spawn 之前成为空操作，留下挂起的孤儿进程。
        let liveRec
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 50))
          liveRec = await readLiveRecord(rawDir, 'task-dispatch-start')
          if (liveRec?.workerPid) break
        }
        assert.ok(liveRec?.workerPid, '工人启动后 live 登记必须带上 workerPid')
      } finally {
        // 无论断言是否失败，都必须终止挂起的工人进程，否则遗留子进程会拖住整轮测试
        await killRun('task-dispatch-start', new RunsLedger(ledgerPath), { rawDir }).catch(() => {})
        if (delegatePromise) {
          await Promise.race([
            delegatePromise.catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 5000)),
          ])
        }
        if (origHang !== undefined) process.env.FAKE_WORKER_HANG = origHang
        else delete process.env.FAKE_WORKER_HANG
        cleanTempDir(tempDir)
      }
    },
  },
]
