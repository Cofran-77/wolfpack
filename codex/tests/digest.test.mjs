import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { renderDigest, renderStatus } from '../src/digest.mjs'
import { cleanTempDir, createTempDir, projectRoot, fakeWorkerPath } from './test-helper.mjs'

export const tests = [
  {
    name: 'status-view-does-not-repeat-token-budget',
    async run() {
      const task = {
        task_id: 'busy',
        worker: 'claude',
        round: 2,
        last_verdict: 'pass',
        last_stop_reason: 'completed',
        total_tokens: 638617,
        has_conversation_id: true,
        running: false,
        changed_files_count: 0,
        changed_files: [],
        changed_files_determined: true,
        budget_used: 638617,
        budget_limit: 1000000,
        budget_over: false,
      }
      const view = { ledger_path: '/tmp/runs.ndjson', total: 1, limit: 5, truncated: false, tasks: [task] }

      const text = renderStatus(view)
      assert.match(text, /busy/, '任务本体仍然要渲染')
      assert.match(text, /tokens=638617/, 'token 数要报')
      assert.doesNotMatch(
        text,
        /预算 638617\/1000000/,
        'token 数已经报过一次，不许再把同一个数字当预算分母重复一遍',
      )

      const over = renderStatus({ ...view, tasks: [{ ...task, budget_over: true }] })
      assert.match(over, /已超/, '预算真的超了要明确报警，不能连报警一起删掉')
    },
  },
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
              WOLFPACK_AGY: fakeWorkerPath,
              WOLFPACK_CLAUDE: 'missing-claude-fixture',
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
