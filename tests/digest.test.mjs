import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { renderDigest } from '../src/digest.mjs'
import { cleanTempDir, createTempDir, projectRoot } from './test-helper.mjs'

export const tests = [
  {
    name: 'digest-two-sections',
    async run() {
      const sampleResult = {
        task_id: 'test-digest-sections',
        round: 1,
        continued: false,
        stop_reason: 'completed',
        report: 'I modified file.txt and ran tests.',
        changed_files: ['file.txt'],
        changed_files_determined: true,
        verify: [
          {
            command: 'npm test',
            ran: true,
            ok: true,
            exit_code: 0,
          },
        ],
        verdict: 'pass',
      }

      const text = renderDigest(sampleResult)

      // 铁律：digest 两段：队员声称＋我已核实
      assert.match(text, /—\s*队员声称\s*—/)
      assert.match(text, /—\s*我已核实\s*—/)
      assert(text.includes('I modified file.txt and ran tests.'))
      assert(text.includes('磁盘改动 1 个文件：file.txt'))
      assert(text.includes('验收 verdict: pass'))
    },
  },
  {
    name: 'digest-verify-not-run-wording',
    async run() {
      const tempDir = createTempDir('digest-wording-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const wolfCli = join(projectRoot, 'bin', 'wolf.mjs')

      try {
        const res = spawnSync(
          process.execPath,
          [
            wolfCli,
            'delegate',
            '--task-id',
            'test-digest-not-run',
            '--task',
            'dummy task for wording check',
            '--verify-baseline',
            'node -e "process.exit(0)"',
            '--verify',
            'node -e "process.exit(0)"',
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              WOLFPACK_LEDGER: ledgerPath,
            },
          },
        )

        assert.equal(res.status, 0, `CLI 进程退出码应为 0，stderr: ${res.stderr}`)
        // 铁律：给了 verify 但未运行，严禁出现「未提供验收命令」
        assert.doesNotMatch(
          res.stdout,
          /未提供验收命令/,
          '给了 verify 但工人未启动，不应输出「未提供验收命令」',
        )
        // 必须清晰指出工人未启动，验收未执行，并显示已登记条数
        assert.match(
          res.stdout,
          /验收：本轮未启动工人，验收未执行（已登记 1 条命令，未运行）/,
          '应输出「验收：本轮未启动工人，验收未执行（已登记 1 条命令，未运行）」',
        )
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
