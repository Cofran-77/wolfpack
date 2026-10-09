import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'

import { runDelegateTask, killRun, takeArtifactSnapshot, diffArtifacts, setDefaultRuntime } from '../src/delegate.mjs'
import { resetDefaultRuntime, getDefaultRuntime } from '../src/runtime/registry.mjs'
import { spawnProcess, killProcessTree } from '../src/spawn.mjs'
import { writeLiveRecord, isProcessAlive, getLiveRecordPath } from '../src/live.mjs'
import { createTempDir, cleanTempDir, fakeWorkerPath, projectRoot } from './test-helper.mjs'
import { readLiveRecord } from '../src/live.mjs'

const allTests = [
  { name: 'mixed-verification-cannot-pass', async run() {
    const dir = createTempDir()
    try {
      const runtime = { spawn(options) {
        if (options.argv.at(-1) === 'BROKEN_VERIFY') return {
          done: Promise.resolve({ exitCode: null, error: new Error('spawn unavailable') }),
          collected: { stdout: { text: '' }, stderr: { text: '' } }, terminate: async () => {},
        }
        return spawnProcess(options)
      } }
      const result = await runDelegateTask({ runtime, cwd: dir,
        config: { agyPath: fakeWorkerPath, rawDir: join(dir, 'raw'), ledgerPath: join(dir, 'runs.ndjson'), shell: [process.execPath, '-e'] },
        args: { task_id: 'mixed-verify', task: 'offline fixture', verify: ['process.exit(0)', 'BROKEN_VERIFY'] },
      })
      assert.equal(result.verdict, 'error')
    } finally { cleanTempDir(dir) }
  } },
  { name: 'cross-process-kill-preserves-host', async run() {
    const dir = createTempDir()
    const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
    const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
    try {
      await writeLiveRecord(dir, 'cancel-task', { taskId: 'cancel-task', pid: owner.pid, workerPid: worker.pid })
      const result = await killRun('cancel-task', undefined, { rawDir: dir })
      assert.equal(result.ok, true)
      assert.equal(isProcessAlive(owner.pid), true, 'cancel must preserve shared MCP host')
    } finally { killProcessTree(owner.pid); killProcessTree(worker.pid); cleanTempDir(dir) }
  } },
  { name: 'filesystem-snapshot-detects-create-edit-delete', async run() {
    const dir = createTempDir()
    try {
      await writeFile(join(dir, 'existing.txt'), 'before')
      await writeFile(join(dir, 'deleted.txt'), 'delete me')
      const before = await takeArtifactSnapshot(dir)
      await writeFile(join(dir, 'existing.txt'), 'after with different size')
      await writeFile(join(dir, 'new.txt'), 'new')
      await unlink(join(dir, 'deleted.txt'))
      const after = await takeArtifactSnapshot(dir)
      const diff = diffArtifacts(before, after)
      assert.equal(diff.determined, true)
      assert.deepEqual(diff.files, ['deleted.txt', 'existing.txt', 'new.txt'])
    } finally { cleanTempDir(dir) }
  } },
  { name: 'filesystem-partial-scan-is-undetermined', async run() {
    const dir = createTempDir()
    try {
      await writeFile(join(dir, 'a.txt'), 'a')
      await writeFile(join(dir, 'b.txt'), 'b')
      const snapshot = await filesystemSnapshot(dir, { maxFiles: 1 })
      assert.equal(diffArtifacts(snapshot, snapshot).determined, false)
      const excluded = await filesystemSnapshot(dir, { excludePaths: [join(dir, 'b.txt')] })
      assert.deepEqual([...excluded.filesystem.keys()], ['a.txt'])
    } finally { cleanTempDir(dir) }
  } },
  { name: 'live-task-identities-never-collide', async run() {
    assert.notEqual(getLiveRecordPath('.', 'a/b'), getLiveRecordPath('.', 'a_b'))
    assert.notEqual(getLiveRecordPath('.', 'TASK').toLowerCase(), getLiveRecordPath('.', 'task').toLowerCase())
    assert.notEqual(getLiveRecordPath('.', 'a/b'), getLiveRecordPath('.', 'task-c14cddc033f64b9dea80ea675cf280a015e672516090a5626781153dc68fea11'))
  } },
  { name: 'injected-host-never-falls-back-to-local-filesystem', async run() {
    const previous = getDefaultRuntime()
    const dir = createTempDir()
    try {
      await writeFile(join(dir, 'local.txt'), 'must not inspect')
      setDefaultRuntime({ spawn() { return { done: Promise.resolve({ exitCode: 1 }) } } })
      const snapshot = await takeArtifactSnapshot(dir)
      assert.equal(snapshot.filesystem, undefined)
    } finally {
      previous ? setDefaultRuntime(previous) : resetDefaultRuntime()
      cleanTempDir(dir)
    }
  } },
  { name: 'external-cancel-remains-aborted-and-skips-verification', async run({ external = true } = {}) {
    const dir = createTempDir()
    const previous = process.env.FAKE_WORKER_HANG
    process.env.FAKE_WORKER_HANG = '1'
    let resultPromise
    try {
      resultPromise = runDelegateTask({ cwd: dir,
        config: { agyPath: fakeWorkerPath, rawDir: join(dir, 'raw'), ledgerPath: join(dir, 'runs.ndjson'), shell: [process.execPath, '-e'] },
        args: { task_id: 'external-cancel', task: 'offline hanging fixture', verify: ['process.exit(0)'] },
      })
      let record
      for (let i = 0; i < 200; i++) {
        record = await readLiveRecord(join(dir, 'raw'), 'external-cancel')
        if (record?.workerPid) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(record?.workerPid)
      const kill = external ? spawnSync(process.execPath, [join(projectRoot, 'bin/wolf.mjs'), 'kill', '--task-id', 'external-cancel'], {
        env: { ...process.env, WOLFPACK_RAW_DIR: join(dir, 'raw'), WOLFPACK_LEDGER: join(dir, 'runs.ndjson') },
        encoding: 'utf8', windowsHide: true, timeout: 10000,
      }) : await killRun('external-cancel', undefined, { rawDir: join(dir, 'raw') })
      if (external) assert.equal(kill.status, 0, kill.stderr)
      else assert.equal(kill.ok, true)
      const result = await resultPromise
      assert.equal(result.stop_reason, 'aborted')
      assert.equal(result.verify.length, 0)
    } finally {
      await killRun('external-cancel', undefined, { rawDir: join(dir, 'raw') })
      await resultPromise?.catch(() => {})
      if (previous === undefined) delete process.env.FAKE_WORKER_HANG
      else process.env.FAKE_WORKER_HANG = previous
      cleanTempDir(dir)
    }
  } },
]

allTests.push({ name: 'local-cancel-remains-aborted-and-skips-verification', run: () =>
  allTests.find(test => test.name === 'external-cancel-remains-aborted-and-skips-verification').run({ external: false }) })

export const tests = allTests.filter(test => ['mixed-verification-cannot-pass', 'cross-process-kill-preserves-host', 'live-task-identities-never-collide', 'external-cancel-remains-aborted-and-skips-verification', 'local-cancel-remains-aborted-and-skips-verification'].includes(test.name))

if (process.argv.includes('--standalone')) {
  let failed = 0
  for (const test of tests) {
    try { await test.run(); console.log('PASS', test.name) }
    catch (error) { failed++; console.error('FAIL', test.name, error.message) }
  }
  process.exitCode = failed ? 1 : 0
}
