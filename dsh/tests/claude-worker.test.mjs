/**
 * Claude 工人适配器与双工人集成测试套件（DSH 版狼群）
 */

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 注入 Node 运行时以驱动 runDelegateTask
import './runtime/node.mjs'

import { loadConfig } from './core/config.mjs'
import { runDelegateTask } from './core/delegate.mjs'
import { RunsLedger } from './core/ledger.mjs'
import { runTeamTasks } from './core/team.mjs'
import { claudeWorker } from './core/worker/claude.mjs'
import {
  agyWorker,
  getWorker,
  isWorkerAvailable,
  listWorkers,
  normalizeWorkerPreference,
  resolveWorkerSelection,
} from './core/worker/index.mjs'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}
const ta = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

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

const TMP = `${tmpdir()}/wolfpack-claude-test-${Date.now()}`
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })

const fakeClaudePath = join(TMP, 'fake-claude.mjs')
const fakeWorkerPath = join(TMP, 'fake-worker.mjs')

const fakeClaudeCode = `#!/usr/bin/env node
const args = process.argv.slice(2)
let sessionId = process.env.FAKE_CLAUDE_SESSION_ID
if (!sessionId) {
  const idx = args.indexOf('--resume')
  sessionId = idx !== -1 && idx + 1 < args.length
    ? args[idx + 1]
    : 'fake-claude-session-' + Math.random().toString(36).slice(2, 10)
}
const envelope = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: sessionId,
  result: JSON.stringify({ summary: 'Fake claude succeeded.', claimed_files: [] }),
  structured_output: { summary: 'Fake claude succeeded.', claimed_files: [] },
  duration_ms: 1200,
  num_turns: 1,
  usage: { input_tokens: 100, output_tokens: 50 },
}
process.stdout.write(JSON.stringify(envelope) + '\\n')
process.exit(0)
`

const fakeWorkerCode = `#!/usr/bin/env node
const args = process.argv.slice(2)
let convId = process.env.FAKE_WORKER_CONVERSATION_ID
if (!convId) {
  const idx = args.indexOf('--conversation')
  convId = idx !== -1 && idx + 1 < args.length
    ? args[idx + 1]
    : 'fake-session-' + Math.random().toString(36).slice(2, 10)
}
const output = {
  conversation_id: convId,
  status: 'SUCCESS',
  response: 'Fake worker succeeded.',
  duration_seconds: 0.1,
  num_turns: 1,
  usage: { total_tokens: 100 },
  structured_output: { summary: 'Fake worker succeeded.', claimed_files: [] },
}
process.stdout.write(JSON.stringify(output) + '\\n')
process.exit(0)
`

await writeFile(fakeClaudePath, fakeClaudeCode, 'utf8')
await writeFile(fakeWorkerPath, fakeWorkerCode, 'utf8')

const bothWorkers = { agyPath: fakeWorkerPath, claudePath: fakeClaudePath }

console.log('\nClaude 工人与双工人集成测试')

// 1. 注册表
t('claude-registered', () => {
  assert.equal(agyWorker.name, 'agy')
  assert.equal(claudeWorker.name, 'claude')
  assert.equal(getWorker('claude').name, 'claude', '注册表必须能取到 claude 适配器')
  assert.equal(getWorker().name, 'agy', '默认工人必须仍然是 agy')
  const names = listWorkers().map(w => w.name)
  assert.deepEqual(names.sort(), ['agy', 'claude'])
  assert.throws(() => getWorker('nope'), /未找到名为 "nope" 的工人适配器/)
})

// 2. 命令行基础参数拼装
t('claude-argv-basic', () => {
  const argv = claudeWorker.buildArgv({ claudePath: fakeClaudePath }, { task: '任务书' })
  assert.equal(argv[0], process.execPath, '.mjs 工人必须用 node 执行')
  assert.equal(argv[1], fakeClaudePath)
  assert.equal(argv[argv.indexOf('-p') + 1], '任务书')
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'json')

  assert(argv.includes('--dangerously-skip-permissions'), '默认必须绕过权限提示')

  const schemaIdx = argv.indexOf('--json-schema')
  assert(schemaIdx !== -1, '必须传 --json-schema')
  const schema = JSON.parse(argv[schemaIdx + 1])
  assert(schema.properties.summary, 'schema 必须含 summary')
  assert(schema.properties.claimed_files, 'schema 必须含 claimed_files')

  assert(!argv.includes('-c'), '严禁使用 -c')
  assert(!argv.includes('--continue'), '严禁使用 --continue')

  assert(!argv.includes('--tools'), '不得限制可用工具')
  assert(!argv.includes('--allowedTools') && !argv.includes('--allowed-tools'), '不得限制 allowedTools')
  assert(!argv.includes('--disallowedTools') && !argv.includes('--disallowed-tools'), '不得限制 disallowedTools')
})

// 3. resume 与覆盖参数
t('claude-argv-resume-and-overrides', () => {
  const resumed = claudeWorker.buildArgv({ claudePath: fakeClaudePath }, { task: '任务书', sessionId: 'sess-abc' })
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'sess-abc')
  assert(!resumed.includes('-c'), '续跑必须走 --resume，不得用 -c')

  const overridden = claudeWorker.buildArgv({
    claudePath: fakeClaudePath,
    model: 'claude-opus-5',
    effort: 'high',
    claudePermissionMode: 'plan',
    claudeAgents: { reviewer: { description: '审查代码', prompt: '你是审查者' } },
  }, { task: '任务书' })
  assert.equal(overridden[overridden.indexOf('--model') + 1], 'claude-opus-5')
  assert.equal(overridden[overridden.indexOf('--effort') + 1], 'high')
  assert.equal(overridden[overridden.indexOf('--permission-mode') + 1], 'plan')
  assert(!overridden.includes('--dangerously-skip-permissions'), '显式权限模式下不得再传绕过参数')

  const agentsIdx = overridden.indexOf('--agents')
  assert(agentsIdx !== -1, '必须透传 --agents')
  const agents = JSON.parse(overridden[agentsIdx + 1])
  assert(agents.reviewer, '--agents 内容必须原样透传')
})

// 4. 解析输出信封
t('claude-parse-envelope', () => {
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
})

// 5. 错误信封解析
t('claude-parse-error-envelope', () => {
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
})

// 6. 分类策略
t('claude-classify-policies', () => {
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
})

// 7. preflight
t('claude-preflight', () => {
  const missing = claudeWorker.preflight({ claudePath: '/nonexistent/dir/claude-xyz' })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不存在/)

  const bare = claudeWorker.preflight({ claudePath: 'claude' })
  assert.equal(bare.ok, true, '命令名交给 PATH 探测')
})

// 8. 配置键与环境变量
t('config-claude-fields', () => {
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
  assert.equal(defaults.claudePath, process.platform === 'win32' ? 'claude.exe' : 'claude')
})

// 9. 唯一可用工人自动选择
t('auto-select-only-available-worker', () => {
  const anyExe = process.execPath
  const onlyAgy = { agyPath: anyExe, claudePath: '' }
  assert.equal(isWorkerAvailable('agy', onlyAgy), true)
  assert.equal(isWorkerAvailable('claude', onlyAgy), false, '路径为空一律视为不可用')
  assert.deepEqual(resolveWorkerSelection({ config: onlyAgy }), { name: 'agy', reason: 'only-available' })

  const onlyClaude = { agyPath: '/nonexistent/dir/agy-xyz', claudePath: anyExe }
  assert.equal(isWorkerAvailable('agy', onlyClaude), false, '路径不存在一律视为不可用')
  assert.deepEqual(resolveWorkerSelection({ config: onlyClaude }), { name: 'claude', reason: 'only-available' })

  const viaPath = { agyPath: 'agy', claudePath: 'claude' }
  const findOnlyClaude = cmd => (cmd === 'claude' ? '/fake/bin/claude' : undefined)
  assert.deepEqual(
    resolveWorkerSelection({ config: viaPath, find: findOnlyClaude }),
    { name: 'claude', reason: 'only-available' },
  )
})

// 10. 双工人轮换
t('auto-rotates-between-both-workers', () => {
  const anyExe = process.execPath
  const testWorkers = { agyPath: anyExe, claudePath: anyExe }
  const first = resolveWorkerSelection({ config: testWorkers })
  const second = resolveWorkerSelection({ config: testWorkers })

  assert.equal(first.reason, 'rotation', '两个都装时必须自动轮换，而不是永远只用 agy')
  assert.equal(second.reason, 'rotation')
  assert.notEqual(first.name, second.name, '相邻两次自动挑选必须交替')
})

// 11. 会话沿用与显式点名回退
t('auto-continuation-sticky-and-explicit-fallback', () => {
  const anyExe = process.execPath
  const testWorkers = { agyPath: anyExe, claudePath: anyExe }
  assert.deepEqual(
    resolveWorkerSelection({ config: testWorkers, previousWorker: 'claude' }),
    { name: 'claude', reason: 'continuation' },
    '同一 task_id 的上一轮工人仍可用时必须沿用（会话 ID 只在各自 CLI 内有效）',
  )
  assert.deepEqual(
    resolveWorkerSelection({ config: testWorkers, previousWorker: 'agy' }),
    { name: 'agy', reason: 'continuation' },
  )

  assert.equal(
    resolveWorkerSelection({ config: { ...testWorkers, worker: 'claude' } }).name,
    'claude',
    '显式偏好可用时必须用它',
  )

  const fallback = resolveWorkerSelection({
    config: { agyPath: anyExe, claudePath: '/nonexistent/dir/claude-xyz', worker: 'claude' },
  })
  assert.equal(fallback.name, 'agy', '显式指定的工人不可用时必须自动回退，绝不空转')
  assert.equal(fallback.reason, 'fallback(claude-unavailable)')

  assert.equal(normalizeWorkerPreference('AUTO'), undefined, 'auto 视为全自动')
  assert.equal(normalizeWorkerPreference(''), undefined)
  assert.equal(normalizeWorkerPreference(undefined), undefined)
  assert.equal(normalizeWorkerPreference(' Claude '), 'claude')
})

// 12. 无可用工人与未知工人报错
t('auto-none-available-throws', () => {
  const anyExe = process.execPath
  assert.throws(
    () => resolveWorkerSelection({
      config: { agyPath: '/nonexistent/dir/agy-xyz', claudePath: '/nonexistent/dir/claude-xyz' },
    }),
    /没有可用的工人 CLI/,
    '一个工人都没装时必须如实报错，绝不假装跑过',
  )
  assert.throws(
    () => resolveWorkerSelection({ config: { agyPath: anyExe, claudePath: anyExe, worker: 'gpt' } }),
    /未知工人 "gpt"/,
    '配置写错工人名必须直接报错',
  )
})

// 13. team 任务项拒绝 worker 参数
await ta('team-rejects-worker-key', async () => {
  const anyExe = process.execPath
  await assert.rejects(
    () => runTeamTasks({
      config: { agyPath: anyExe, claudePath: anyExe },
      tasks: [{ task_id: 't1', task: '带 worker 参数的任务项', worker: 'claude' }],
    }),
    /包含未知参数 "worker"/,
    '工人选择已全自动，任务项再传 worker 必须被直接拒绝',
  )
})

// 14. 委派显式点名 claude
await ta('delegate-explicit-preference-claude', async () => {
  const tempDir = join(TMP, 'worker-claude')
  await mkdir(tempDir, { recursive: true })
  const ledgerPath = join(tempDir, 'runs.ndjson')
  const ledger = new RunsLedger(ledgerPath)

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

  const state = await ledger.latest('task-claude')
  assert.equal(state.worker, 'claude', '台账必须记录工人名')
})

// 15. 委派自动选择唯一可用工人
await ta('delegate-auto-picks-only-available-worker', async () => {
  const tempDir = join(TMP, 'worker-default')
  await mkdir(tempDir, { recursive: true })
  const ledgerPath = join(tempDir, 'runs.ndjson')
  const ledger = new RunsLedger(ledgerPath)

  const res = await runDelegateTask({
    config: { agyPath: fakeWorkerPath, claudePath: '', ledgerPath },
    args: { task_id: 'task-default', task: '只装了 agy' },
    cwd: tempDir,
    ledger,
  })

  assert.equal(res.worker, 'agy', '只有一个可用工人时必须用它')
  assert.equal(res.worker_reason, 'only-available')
})

// 16. 委派轮换使用两个工人
await ta('delegate-auto-uses-both-workers', async () => {
  const tempDir = join(TMP, 'auto-both')
  await mkdir(tempDir, { recursive: true })
  const ledgerPath = join(tempDir, 'runs.ndjson')
  const ledger = new RunsLedger(ledgerPath)
  const config = { ...bothWorkers, ledgerPath }

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
})

// 17. 换工人强制冷启动
await ta('delegate-worker-switch-forces-cold-start', async () => {
  const tempDir = join(TMP, 'worker-switch')
  await mkdir(tempDir, { recursive: true })
  const ledgerPath = join(tempDir, 'runs.ndjson')
  const ledger = new RunsLedger(ledgerPath)

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
})

// 清理测试临时目录
try {
  await rm(TMP, { recursive: true, force: true })
} catch {}

console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  process.exit(1)
}
