import assert from 'node:assert/strict'
import { join } from 'node:path'

import { runDelegateTask } from '../src/delegate.mjs'
import { renderDigest } from '../src/digest.mjs'
import { RunsLedger } from '../src/ledger.mjs'
import { cleanTempDir, createTempDir, fakeWorkerPath } from './test-helper.mjs'

export const tests = [
  {
    name: 'artifact-non-git',
    async run() {
      // 创建空临时目录，非 git 仓库
      const tempDir = createTempDir('non-git-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        const res = await runDelegateTask({
          config: {
            agyPath: fakeWorkerPath,
            ledgerPath,
          },
          args: {
            task_id: 'task-non-git',
            task: 'Task in non-git directory',
          },
          cwd: tempDir,
          ledger,
        })

        // 完整非 Git 文件快照确定零改动，不把台账当产物
        assert.equal(res.changed_files_determined, true)

        const digest = renderDigest(res)
        assert(!digest.includes('无法判定'))
        assert.equal(res.changed_files.length, 0)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
