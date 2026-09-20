import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { loadConfig } from '../src/config.mjs'
import { runDelegateTask } from '../src/delegate.mjs'
import { renderDigest } from '../src/digest.mjs'
import { RunsLedger } from '../src/ledger.mjs'
import { runTeamTasks } from '../src/team.mjs'
import { claudeWorker } from '../src/worker/claude.mjs'
import {
  agyWorker,
  getWorker,
  isWorkerAvailable,
  listWorkers,
  normalizeWorkerPreference,
  resolveWorkerSelection,
} from '../src/worker/index.mjs'
import { cleanTempDir, createTempDir, fakeClaudePath, fakeWorkerPath, projectRoot } from './test-helper.mjs'

/** 真实 claude 2.1.x `-p --output-format json --json-schema` 的信封（实测样本）。 */
const SAMPLE_ENVELOPE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  session_id: 'b0d2a65c-826b-4cc1-8b2e-18af0f89e206',
  duration_ms: 6385,
  duration_api_ms: 6339,
  num_turns: 3,
  total_cost_usd: 0.16422699999999998,
  result: '{"summary":"Replied ok.","claimed_files":[]}',
  structured_output: { summary: 'Replied ok.', claimed_files: [] },
  permission_denials: [],
  subagent_stats: { spawned: 0, max_depth: 0 },
  usage: {
    input_tokens: 29537,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 29184,
    output_tokens: 78,
    output_tokens_details: { thinking_tokens: 0 },
  },
}

function buildArgv(cfg, params = {}) {
  return claudeWorker.buildArgv({ claudePath: fakeClaudePath, ...cfg }, { task: '任务书', ...params })
}

function indexOfArg(argv, flag) {
  return argv.indexOf(flag)
}

/** 两个工人路径都指向 fixture 的配置：全自动挑选时两者都算可用 */
const bothWorkers = { agyPath: fakeWorkerPath, claudePath: fakeClaudePath }

export const tests = [
  {
    name: 'claude-registered',
    async run() {
      assert.equal(agyWorker.name, 'agy')
      assert.equal(claudeWorker.name, 'claude')
      assert.equal(getWorker('claude').name, 'claude', '注册表必须能取到 claude 适配器')
      assert.equal(getWorker().name, 'agy', '默认工人必须仍然是 agy')
      const names = listWorkers().map(w => w.name)
      assert.deepEqual(names.sort(), ['agy', 'claude'])
      assert.throws(() => getWorker('nope'), /未找到名为 "nope" 的工人适配器/)
    },
  },
  {
    name: 'claude-argv-basic',
    async run() {
      const argv = buildArgv({})

      assert.equal(argv[0], process.execPath, '.mjs 工人必须用 node 执行')
      assert.equal(argv[1], fakeClaudePath)
      assert.equal(argv[indexOfArg(argv, '-p') + 1], '任务书')
      assert.equal(argv[indexOfArg(argv, '--output-format') + 1], 'json')

      // 默认与 agy 对称：绕过权限提示，否则工人无法改文件、跑测试
      assert(argv.includes('--dangerously-skip-permissions'), '默认必须绕过权限提示')

      // 结构化输出：与 agy 同名的 structured_output 契约
      const schemaIdx = indexOfArg(argv, '--json-schema')
      assert(schemaIdx !== -1, '必须传 --json-schema')
      const schema = JSON.parse(argv[schemaIdx + 1])
      assert(schema.properties.summary, 'schema 必须含 summary')
      assert(schema.properties.claimed_files, 'schema 必须含 claimed_files')

      // 铁律：续跑绝不用 -c/--continue
      assert(!argv.includes('-c'), '严禁使用 -c')
      assert(!argv.includes('--continue'), '严禁使用 --continue')

      // 子智能体：默认不得传任何限制工具的参数
      assert(!argv.includes('--tools'), '不得限制可用工具')
      assert(!argv.includes('--allowedTools') && !argv.includes('--allowed-tools'), '不得限制 allowedTools')
      assert(!argv.includes('--disallowedTools') && !argv.includes('--disallowed-tools'), '不得限制 disallowedTools')
    },
  },
  {
    name: 'claude-argv-resume-and-overrides',
    async run() {
      const resumed = buildArgv({}, { sessionId: 'sess-abc' })
      assert.equal(resumed[indexOfArg(resumed, '--resume') + 1], 'sess-abc')
      assert(!resumed.includes('-c'), '续跑必须走 --resume，不得用 -c')

      const overridden = buildArgv({
        model: 'claude-opus-5',
        effort: 'high',
        claudePermissionMode: 'plan',
        claudeAgents: { reviewer: { description: '审查代码', prompt: '你是审查者' } },
      })
      assert.equal(overridden[indexOfArg(overridden, '--model') + 1], 'claude-opus-5')
      assert.equal(overridden[indexOfArg(overridden, '--effort') + 1], 'high')
      assert.equal(overridden[indexOfArg(overridden, '--permission-mode') + 1], 'plan')
      assert(!overridden.includes('--dangerously-skip-permissions'), '显式权限模式下不得再传绕过参数')

      const agentsIdx = indexOfArg(overridden, '--agents')
      assert(agentsIdx !== -1, '必须透传 --agents')
      const agents = JSON.parse(overridden[agentsIdx + 1])
      assert(agents.reviewer, '--agents 内容必须原样透传')
    },
  },
  {
    name: 'claude-parse-envelope',
    async run() {
      const stdout = JSON.stringify(SAMPLE_ENVELOPE)

      assert.equal(claudeWorker.extractSessionId(stdout), 'b0d2a65c-826b-4cc1-8b2e-18af0f89e206')
      assert.equal(claudeWorker.extractSessionId('not json'), undefined)

      const parsed = claudeWorker.parse(stdout)
      assert.equal(parsed.conversationId, 'b0d2a65c-826b-4cc1-8b2e-18af0f89e206')
      assert.equal(parsed.status, 'SUCCESS')
      assert.equal(parsed.error, undefined)
      assert.equal(parsed.numTurns, 3)
      assert.equal(Math.round(parsed.durationSeconds * 1000), 6385)
      assert.equal(parsed.usage.input, 29537)
      assert.equal(parsed.usage.output, 78)
      assert.equal(parsed.usage.cacheRead, 29184)
      assert.equal(parsed.usage.total, 29537 + 78)
      assert.equal(parsed.structuredReport.summary, 'Replied ok.')
      assert.deepEqual(parsed.structuredReport.claimedFiles, [])
      assert.equal(parsed.costUsd, SAMPLE_ENVELOPE.total_cost_usd)
      assert.equal(parsed.subagents.spawned, 0)
    },
  },
  {
    name: 'claude-parse-error-envelope',
    async run() {
      const parsed = claudeWorker.parse(JSON.stringify({
        ...SAMPLE_ENVELOPE,
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 500,
        result: 'API Error: 500 Internal Server Error',
        structured_output: undefined,
      }))

      assert.equal(parsed.status, 'ERROR')
      assert.match(parsed.error, /500/)
    },
  },
  {
    name: 'claude-classify-policies',
    async run() {
      const artifactsNone = { determined: true, changed: false, summary: '', files: [] }
      const artifactsChanged = { determined: true, changed: true, summary: '1 个文件：a.txt', files: ['a.txt'] }

      assert.equal(
        claudeWorker.classify({ parsed: { status: 'SUCCESS' }, exitCode: 0, artifacts: artifactsNone }).stopReason,
        'completed',
      )

      const rescued = claudeWorker.classify({
        parsed: { status: 'ERROR', error: 'boom' },
        exitCode: 1,
        artifacts: artifactsChanged,
      })
      assert.equal(rescued.stopReason, 'completed', '产物存在即完成（救回铁律）')
      assert.match(rescued.diagnostic, /检测到磁盘产物/)

      const failed = claudeWorker.classify({
        parsed: { status: 'ERROR', error: 'boom' },
        exitCode: 1,
        artifacts: artifactsNone,
      })
      assert.equal(failed.stopReason, 'error')
      assert.match(failed.diagnostic, /boom/)

      assert.equal(
        claudeWorker.classify({ parsed: undefined, exitCode: null, artifacts: artifactsNone, cancelled: true }).stopReason,
        'aborted',
      )
      assert.equal(
        claudeWorker.classify({ parsed: undefined, exitCode: null, artifacts: artifactsNone, timedOut: true }).stopReason,
        'aborted',
      )

      const capacity = claudeWorker.classify({
        parsed: { status: 'ERROR', api_error_status: 529, error: 'Overloaded' },
        exitCode: 1,
        artifacts: artifactsNone,
        stderr: 'API Error: 529 Overloaded',
      })
      assert.equal(capacity.stopReason, 'capacity')
      assert.equal(capacity.capacity, true)
    },
  },
  {
    name: 'claude-preflight',
    async run() {
      const missing = claudeWorker.preflight({ claudePath: '/nonexistent/dir/claude-xyz' })
      assert.equal(missing.ok, false)
      assert.match(missing.reason, /不存在/)

      const bare = claudeWorker.preflight({ claudePath: 'claude' })
      assert.equal(bare.ok, true, '命令名交给 PATH 探测')
    },
  },
  {
    name: 'config-claude-fields',
    async run() {
      const cfg = loadConfig({}, process.cwd(), {
        WOLFPACK_CLAUDE: 'claude-custom',
        WOLFPACK_CLAUDE_MODEL: 'claude-opus-5',
        WOLFPACK_CLAUDE_PERMISSION_MODE: 'plan',
        WOLFPACK_CLAUDE_AGENTS: '{"reviewer":{"description":"审查","prompt":"你是审查者"}}',
      })

      assert.equal(cfg.claudePath, 'claude-custom')
      assert.equal(cfg.claudeModel, 'claude-opus-5')
      assert.equal(cfg.claudePermissionMode, 'plan')
      assert.equal(typeof cfg.claudeAgents, 'string')

      const defaults = loadConfig({}, process.cwd(), { WOLFPACK_CONFIG_FILE: join(process.cwd(), 'no-such-config.json') })
      assert.equal(defaults.worker, 'auto', '默认必须是全自动挑选工人')
      assert.equal(defaults.claudePath, 'claude')
    },
  },
  {
    name: 'delegate-explicit-preference-claude',
    async run() {
      const tempDir = createTempDir('worker-claude-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      const origSub = process.env.FAKE_CLAUDE_SUBAGENTS
      try {
        process.env.FAKE_CLAUDE_SUBAGENTS = '2'

        const res = await runDelegateTask({
          config: { ...bothWorkers, worker: 'claude', ledgerPath },
          args: { task_id: 'task-claude', task: '由 claude 执行' },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res.worker, 'claude')
        assert.equal(res.worker_reason, 'explicit', '配置显式点名时必须用它')
        assert.equal(res.stop_reason, 'completed')
        assert.equal(res.verdict, 'unverified')
        assert.match(res.conversation_id, /^fake-claude-session-/)
        assert.equal(res.subagents_spawned, 2, '子智能体用量必须如实带回')

        const digest = renderDigest(res)
        assert.match(digest, /claude/, 'digest 必须显示真实工人名')
        assert.match(digest, /子智能体/, 'digest 必须显示子智能体用量')

        const state = await ledger.latest('task-claude')
        assert.equal(state.worker, 'claude', '台账必须记录工人名')
      } finally {
        if (origSub !== undefined) process.env.FAKE_CLAUDE_SUBAGENTS = origSub
        else delete process.env.FAKE_CLAUDE_SUBAGENTS
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'delegate-auto-picks-only-available-worker',
    async run() {
      const tempDir = createTempDir('worker-default-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        // 只给出 agy 路径（claudePath 缺省为空）：即便本机装了 claude，也必须只派 agy
        const res = await runDelegateTask({
          config: { agyPath: fakeWorkerPath, ledgerPath },
          args: { task_id: 'task-default', task: '只装了 agy' },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res.worker, 'agy', '只有一个可用工人时必须用它')
        assert.equal(res.worker_reason, 'only-available')
        const digest = renderDigest(res)
        assert.match(digest, /agy/)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'auto-select-only-available-worker',
    async run() {
      const onlyAgy = { agyPath: fakeWorkerPath, claudePath: '' }
      assert.equal(isWorkerAvailable('agy', onlyAgy), true)
      assert.equal(isWorkerAvailable('claude', onlyAgy), false, '路径为空一律视为不可用')
      assert.deepEqual(resolveWorkerSelection({ config: onlyAgy }), { name: 'agy', reason: 'only-available' })

      const onlyClaude = { agyPath: '/nonexistent/dir/agy-xyz', claudePath: fakeClaudePath }
      assert.equal(isWorkerAvailable('agy', onlyClaude), false, '路径不存在一律视为不可用')
      assert.deepEqual(resolveWorkerSelection({ config: onlyClaude }), { name: 'claude', reason: 'only-available' })

      // 裸命令名走 PATH 探测：注入 find 后结果完全确定，不依赖跑测试的机器装了什么
      const viaPath = { agyPath: 'agy', claudePath: 'claude' }
      const findOnlyClaude = cmd => (cmd === 'claude' ? '/fake/bin/claude' : undefined)
      assert.deepEqual(
        resolveWorkerSelection({ config: viaPath, find: findOnlyClaude }),
        { name: 'claude', reason: 'only-available' },
      )
    },
  },
  {
    name: 'auto-rotates-between-both-workers',
    async run() {
      const first = resolveWorkerSelection({ config: bothWorkers })
      const second = resolveWorkerSelection({ config: bothWorkers })

      assert.equal(first.reason, 'rotation', '两个都装时必须自动轮换，而不是永远只用 agy')
      assert.equal(second.reason, 'rotation')
      assert.notEqual(first.name, second.name, '相邻两次自动挑选必须交替')
    },
  },
  {
    name: 'auto-continuation-sticky-and-explicit-fallback',
    async run() {
      assert.deepEqual(
        resolveWorkerSelection({ config: bothWorkers, previousWorker: 'claude' }),
        { name: 'claude', reason: 'continuation' },
        '同一 task_id 的上一轮工人仍可用时必须沿用（会话 ID 只在各自 CLI 内有效）',
      )
      assert.deepEqual(
        resolveWorkerSelection({ config: bothWorkers, previousWorker: 'agy' }),
        { name: 'agy', reason: 'continuation' },
      )

      assert.equal(
        resolveWorkerSelection({ config: { ...bothWorkers, worker: 'claude' } }).name,
        'claude',
        '显式偏好可用时必须用它',
      )

      const fallback = resolveWorkerSelection({
        config: { agyPath: fakeWorkerPath, claudePath: '/nonexistent/dir/claude-xyz', worker: 'claude' },
      })
      assert.equal(fallback.name, 'agy', '显式指定的工人不可用时必须自动回退，绝不空转')
      assert.equal(fallback.reason, 'fallback(claude-unavailable)')

      assert.equal(normalizeWorkerPreference('AUTO'), undefined, 'auto 视为全自动')
      assert.equal(normalizeWorkerPreference(''), undefined)
      assert.equal(normalizeWorkerPreference(undefined), undefined)
      assert.equal(normalizeWorkerPreference(' Claude '), 'claude')
    },
  },
  {
    name: 'auto-none-available-throws',
    async run() {
      assert.throws(
        () => resolveWorkerSelection({
          config: { agyPath: '/nonexistent/dir/agy-xyz', claudePath: '/nonexistent/dir/claude-xyz' },
        }),
        /没有可用的工人 CLI/,
        '一个工人都没装时必须如实报错，绝不假装跑过',
      )
      assert.throws(
        () => resolveWorkerSelection({ config: { ...bothWorkers, worker: 'gpt' } }),
        /未知工人 "gpt"/,
        '配置写错工人名必须直接报错',
      )
    },
  },
  {
    name: 'delegate-auto-uses-both-workers',
    async run() {
      const tempDir = createTempDir('auto-both-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)
      const config = { ...bothWorkers, ledgerPath }

      try {
        const seen = new Map()
        for (let i = 0; i < 4; i++) {
          const res = await runDelegateTask({
            config,
            args: { task_id: `auto-${i}`, task: '全自动分派' },
            cwd: tempDir,
            ledger,
          })
          assert.equal(res.stop_reason, 'completed')
          assert.equal(res.worker_reason, 'rotation')
          seen.set(res.worker, (seen.get(res.worker) || 0) + 1)
        }
        assert(seen.has('agy') && seen.has('claude'), '两个工人都必须被真正派过活')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'team-rejects-worker-key',
    async run() {
      await assert.rejects(
        () => runTeamTasks({
          config: { ...bothWorkers },
          tasks: [{ task_id: 't1', task: '带 worker 参数的任务项', worker: 'claude' }],
        }),
        /包含未知参数 "worker"/,
        '工人选择已全自动，任务项再传 worker 必须被直接拒绝',
      )
    },
  },
  {
    name: 'delegate-worker-switch-forces-cold-start',
    async run() {
      const tempDir = createTempDir('worker-switch-')
      const ledgerPath = join(tempDir, 'runs.ndjson')
      const ledger = new RunsLedger(ledgerPath)

      try {
        await ledger.record({
          taskId: 'task-switch',
          round: 1,
          conversationId: 'agy-session-old',
          worker: 'agy',
          stopReason: 'completed',
          verdict: 'pass',
        })

        const res = await runDelegateTask({
          config: { ...bothWorkers, worker: 'claude', ledgerPath },
          args: { task_id: 'task-switch', task: '换工人必须冷启动' },
          cwd: tempDir,
          ledger,
        })

        assert.equal(res.worker, 'claude')
        assert.equal(res.continued, false, '换工人后严禁复用上一个工人的会话')
        assert.match(res.fresh_reason, /worker-changed\(agy→claude\)/)
        assert.notEqual(res.conversation_id, 'agy-session-old')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'mcp-has-no-worker-param',
    async run() {
      const mcpScript = join(projectRoot, 'bin', 'wolf-mcp.mjs')
      const proc = spawn(process.execPath, [mcpScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

      const lines = []
      let resolveOutput
      const outputPromise = new Promise(resolve => { resolveOutput = resolve })

      proc.stdout.setEncoding('utf8')
      let buffer = ''
      proc.stdout.on('data', chunk => {
        buffer += chunk
        while (true) {
          const idx = buffer.indexOf('\n')
          if (idx === -1) break
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line) {
            try {
              lines.push(JSON.parse(line))
              if (lines.length >= 2) resolveOutput(lines)
            } catch {}
          }
        }
      })

      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n')
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')

      const received = await Promise.race([
        outputPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('MCP server 响应超时')), 5000)),
      ])

      proc.stdin.end()
      proc.kill()

      const tools = received.find(r => r.id === 2)?.result?.tools || []
      assert.equal(tools.length, 6, '工具数量必须是 6 个（委派 4 + 实时 2）')

      const delegate = tools.find(t => t.name === 'wolf_delegate')
      assert.equal(
        delegate?.inputSchema?.properties?.worker,
        undefined,
        '工人选择已全自动：wolf_delegate 不得再暴露 worker 参数',
      )
      assert.match(delegate.description, /全自动/, '工具说明必须写明工人是全自动挑选的')

      const team = tools.find(t => t.name === 'wolf_team')
      const itemProps = team?.inputSchema?.properties?.tasks?.items?.properties
      assert.equal(itemProps?.worker, undefined, 'wolf_team 任务项同样不得暴露 worker 参数')
      assert.match(team.description, /全自动/)
    },
  },
]
