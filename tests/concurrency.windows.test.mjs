import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Windows 版：进程结束后 exitCode 非空，退出判定只需检查 exitCode。
// macOS / Linux 版见 concurrency.macos-linux.test.mjs，两份文件除该判定外内容一致，修改时需同步。
import { killRun, runDelegateTask } from '../src/delegate.mjs'
import { ActiveRunRegistry, RunsLedger, TaskBusyError } from '../src/ledger.mjs'
import { killProcessTree } from '../src/spawn.mjs'
import { cleanTempDir, createTempDir, fakeWorkerPath, projectRoot } from './test-helper.mjs'

export const tests = [
  {
    name: 'concurrency-reject',
    async run() {
      const tempDir = createTempDir('concurrency-reject-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)
      const registry = new ActiveRunRegistry()

      const origHang = process.env.FAKE_WORKER_HANG
      try {
        process.env.FAKE_WORKER_HANG = '1'

        // 启动第 1 个挂起的任务
        const task1Promise = runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'task-concurrency-test',
            task: 'Hanging task',
          },
          cwd: tempDir,
          ledger,
          registry,
        })

        // 给一点点时间让任务 1 启动并成功占位
        await new Promise(r => setTimeout(r, 100))

        // 尝试启动同 task_id 的第 2 个任务，必须立即被拒绝（抛出 TaskBusyError）
        let rejected = false
        try {
          await runDelegateTask({
            config: {
              agyPath: fakeWorkerPath,
              ledgerPath,
            },
            args: {
              task_id: 'task-concurrency-test',
              task: 'Concurrent task should be rejected',
            },
            cwd: tempDir,
            ledger,
            registry,
          })
        } catch (err) {
          rejected = true
          assert(err instanceof TaskBusyError || err.code === 'TASK_BUSY')
          assert.match(err.message, /已经有正在运行的 agy 会话/)
        }

        assert.equal(rejected, true, '同 task_id 并发委派必须被直接拒绝')

        // 终止任务 1
        await killRun('task-concurrency-test', ledger)
        await task1Promise.catch(() => {})
      } finally {
        if (origHang !== undefined) process.env.FAKE_WORKER_HANG = origHang
        else delete process.env.FAKE_WORKER_HANG
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'kill-cross-process',
    async run() {
      const tempDir = createTempDir('kill-cross-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const rawDir = join(tempDir, 'raw')
      const wolfCli = join(projectRoot, 'bin', 'wolf.mjs')

      const sleep = ms => new Promise(r => setTimeout(r, ms))

      let child = null
      try {
        // 1. 在独立进程中启动一个挂起的 delegate
        child = spawn(
          process.execPath,
          [wolfCli, 'delegate', '--task-id', 'cross-kill-1', '--task', 'Hanging task for cross kill'],
          {
            cwd: tempDir,
            env: {
              ...process.env,
              FAKE_WORKER_HANG: '1',
              WOLFPACK_AGY: fakeWorkerPath,
              WOLFPACK_LEDGER: ledgerPath,
              WOLFPACK_RAW_DIR: rawDir,
            },
            stdio: 'ignore',
            windowsHide: true,
          },
        )

        // 等待进程启动并在 raw/live 目录下建立登记
        await sleep(2000)
        assert.equal(child.exitCode, null, 'delegate 进程应处于运行中')

        // 验证 <raw_dir>/live/<taskId>.json 登记已写入，包含 taskId, pid, startedAt
        const liveFile = join(rawDir, 'live', 'cross-kill-1.json')
        assert.ok(existsSync(liveFile), 'live 登记文件必须存在')
        const liveRecord = JSON.parse(readFileSync(liveFile, 'utf8'))
        assert.equal(liveRecord.taskId, 'cross-kill-1')
        assert.ok(typeof liveRecord.pid === 'number')
        assert.ok(typeof liveRecord.startedAt === 'number')

        // 验证并发保护：同 task_id 跨进程再次 delegate 仍必须被拒绝
        const concurrentRes = spawnSync(
          process.execPath,
          [wolfCli, 'delegate', '--task-id', 'cross-kill-1', '--task', 'Another concurrent task'],
          {
            cwd: tempDir,
            env: {
              ...process.env,
              WOLFPACK_AGY: fakeWorkerPath,
              WOLFPACK_LEDGER: ledgerPath,
              WOLFPACK_RAW_DIR: rawDir,
            },
            encoding: 'utf8',
            windowsHide: true,
          },
        )
        assert.notEqual(concurrentRes.status, 0, '并发同 task_id 必须被拒绝')
        assert.match(concurrentRes.stderr, /已经有正在运行的 agy 会话|TASK_BUSY/i)

        // 2. 从当前进程执行 kill 命令进行跨进程终止
        const killRes = spawnSync(
          process.execPath,
          [wolfCli, 'kill', '--task-id', 'cross-kill-1'],
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
        assert.equal(killRes.status, 0, `kill 命令应退出 0: ${killRes.stderr}`)
        assert.match(killRes.stdout, /已成功终止/)

        // 等待被杀进程退出
        await sleep(2000)
        assert.notEqual(child.exitCode, null, '被 kill 后 delegate 进程必须已退出')
        assert.equal(existsSync(liveFile), false, 'kill 成功后 live 登记文件必须被删除')

        // 3. 登记文件存在但进程已不存在测试
        // 手动写入一个假死 pid 登记文件
        const deadFile = join(rawDir, 'live', 'dead-task-1.json')
        writeFileSync(deadFile, JSON.stringify({ taskId: 'dead-task-1', pid: 999999, startedAt: Date.now() }), 'utf8')
        const deadKillRes = spawnSync(
          process.execPath,
          [wolfCli, 'kill', '--task-id', 'dead-task-1'],
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
        assert.notEqual(deadKillRes.status, 0, '进程已不存在时 kill 应返回非 0')
        assert.match(deadKillRes.stderr, /该运行已结束/)
        assert.equal(existsSync(deadFile), false, '残留登记文件必须被清理')
      } finally {
        if (child && child.exitCode === null) {
          killProcessTree(child.pid)
        }
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'worker-hang-does-not-return',
    async run() {
      const tempDir = createTempDir('hang-not-return-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const rawDir = join(tempDir, 'raw')
      const ledger = new RunsLedger(ledgerPath)

      const origHang = process.env.FAKE_WORKER_HANG
      try {
        process.env.FAKE_WORKER_HANG = '1'

        let delegateFinished = false
        const delegatePromise = runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
            rawDir,
          },
          args: {
            task_id: 'task-hang-check',
            task: 'Worker hangs test',
          },
          cwd: tempDir,
          ledger,
        }).then(
          res => {
            delegateFinished = true
            return res
          },
          err => {
            delegateFinished = true
            throw err
          },
        )

        // 挂起期间等待 1000ms，期间 delegate 绝对不应提前收工
        await new Promise(r => setTimeout(r, 1000))
        assert.equal(delegateFinished, false, '工人挂起期间 delegate 绝不能提前返回/收工')

        // 检查台账：派发即记录后，挂起期间允许存在运行中记录，但绝不能出现已结束的记录
        const latest = await ledger.latest('task-hang-check')
        assert.ok(
          latest === undefined || latest.lastStopReason === 'running',
          '工人挂起期间不得出现已结束的台账记录',
        )

        // 清理终止任务
        await killRun('task-hang-check', ledger, { rawDir })
        await delegatePromise.catch(() => {})
      } finally {
        if (origHang !== undefined) process.env.FAKE_WORKER_HANG = origHang
        else delete process.env.FAKE_WORKER_HANG
        cleanTempDir(tempDir)
      }
    },
  },
]
