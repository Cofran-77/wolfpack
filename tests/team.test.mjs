import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readConfigFile } from '../src/config.mjs'
import { cleanTempDir, createTempDir, fakeWorkerPath, projectRoot } from './test-helper.mjs'

export const tests = [
  {
    name: 'team-tasks-bom',
    async run() {
      const tempDir = createTempDir('team-bom-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const rawDir = join(tempDir, 'raw')
      const wolfCli = join(projectRoot, 'bin', 'wolf.mjs')

      try {
        const okScript = join(tempDir, 'ok.mjs')
        const badScript = join(tempDir, 'bad.mjs')
        writeFileSync(okScript, 'process.exit(0)\n', 'utf8')
        writeFileSync(badScript, 'process.exit(1)\n', 'utf8')

        const tasks = [
          {
            task_id: 'bom-case-1',
            task: 'BOM Test Task 1',
            verify: ['node ok.mjs'],
            verify_baseline: ['node bad.mjs'],
          },
          {
            task_id: 'bom-case-2',
            task: 'BOM Test Task 2',
            verify: ['node ok.mjs'],
            verify_baseline: ['node bad.mjs'],
          },
        ]

        // 写入带 UTF-8 BOM 前缀（\uFEFF）的 tasks JSON 文件
        const bomPath = join(tempDir, 'tasks-bom.json')
        writeFileSync(bomPath, '\uFEFF' + JSON.stringify(tasks, null, 2), 'utf8')

        const res = spawnSync(
          process.execPath,
          [wolfCli, 'team', '--tasks', bomPath, '--concurrency', '2'],
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

        assert.equal(res.status, 0, `带 BOM 的 tasks 文件解析并执行应退出 0，stderr: ${res.stderr}`)
        assert.doesNotMatch(res.stderr, /Unexpected token/)
        assert.match(res.stdout, /pass=2/, '两个任务均应 pass')

        // 同时验证带 BOM 的 wolfpack.config.json 能被正常读取
        const configBomPath = join(tempDir, 'wolfpack.config.json')
        writeFileSync(configBomPath, '\uFEFF' + JSON.stringify({ mode: 'accept-edits' }), 'utf8')
        const cfg = readConfigFile(configBomPath)
        assert.equal(cfg.mode, 'accept-edits')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
