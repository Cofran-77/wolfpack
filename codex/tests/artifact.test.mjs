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

        // 铁律：非 git 工作区 → determined:false，绝不许显示成「没有改动」
        assert.equal(res.changed_files_determined, false)

        const digest = renderDigest(res)
        assert.match(digest, /磁盘改动：\*\*无法判定\*\*（工作目录不是 git 仓库）/)
        assert(!digest.includes('磁盘改动 0 个文件（无）'))
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
