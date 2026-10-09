/**
 * 工具输出契约：每个工具的返回对象必须过得了 harness 自己的 JSON Schema 校验。
 *
 * 为什么单独一份：0.2.0 的 harness 会用 `output.schema`（`additionalProperties: false`）
 * 校验工具返回的对象，**校验不过就把整个结果丢掉**，队长只看到一句
 *   tool "wolf_delegate" returned invalid output: "value.xxx" is not a declared property
 * 也就是说：活干成了、台账也写了，但「我已核实」段永远回不来——验收证据链在最后一跳断掉。
 *
 * 这里不用手写期望值，而是把**真实工具实现**跑出真实返回对象，
 * 再用 harness 自己的 `validateJsonSchemaValue` 校验，所以代码加字段忘改 schema 会立刻红。
 *
 * 与其它套件一样放在 $DSH_HOME/profiles/ 下，解析到的是真的 defineTool 与真校验器。
 */

import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  registerWolfDelegate,
  registerWolfKill,
  registerWolfStatus,
  registerWolfTeam,
} from './index.js'
import { RunsLedger } from './runs-ledger.js'

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

const TMP = `${process.env.TEMP}/wolfpack-schema-test`
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })

/* ── 假宿主 ────────────────────────────────────────────────────────── */

const AGY_JSON = JSON.stringify({
  status: 'SUCCESS',
  response: 'did the thing',
  error: '',
  duration_seconds: 1,
  conversation_id: 'conv-schema',
})

function handle(text, exitCode = 0, stderr = '') {
  return {
    collected: {
      stdout: { readFrom: () => ({ text, nextOffset: 0, lossy: false, spillPath: 'C:/spill/run.log' }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate() {},
    waitForExit: async () => true,
  }
}

/**
 * @param {object} opts - baselineExit / verifyExit / agyJson / agyExit
 */
function fakeCtx(opts = {}) {
  const registry = { defs: new Map() }
  const tools = {
    register(definition) {
      registry.defs.set(definition.name, definition)
      return () => registry.defs.delete(definition.name)
    },
  }
  let shellCalls = 0
  const ctx = {
    registry,
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subprocess') {
        return {
          spawn(spec) {
            const program = spec.argv[0]
            if (/agy/i.test(program)) return handle(opts.agyJson ?? AGY_JSON, opts.agyExit ?? 0)
            if (/git/i.test(program)) return handle('', 0)
            shellCalls += 1
            // 第一条 shell 命令是基线闸门，之后才是验收命令
            const exitCode = shellCalls === 1 ? (opts.baselineExit ?? 1) : (opts.verifyExit ?? 0)
            return handle(exitCode === 0 ? 'ok' : 'boom: 1 failed, 3 passed', exitCode)
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

const agentExec = () => ({
  agent: { session: { header: { cwd: TMP } } },
  signal: new AbortController().signal,
})

const baseConfig = ledger => ({
  agyPath: 'agy.exe',
  ledger,
  graceMs: 10,
  timeoutMs: 0,
  verifyTimeoutMs: 5_000,
})

/** 用 harness 自己的校验器验一个工具的返回对象。 */
function assertOutputValid(toolName, definition, value) {
  assert.ok(definition?.output?.schema, `${toolName} 没有声明 output.schema`)
  const violations = validateJsonSchemaValue(definition.output.schema, value)
  assert.ok(Array.isArray(violations), `${toolName} 校验器返回值不是数组`)
  assert.deepEqual(violations, [], `${toolName} 的返回对象过不了 output.schema：\n  ${violations.join('\n  ')}\n返回对象键：${Object.keys(value ?? {}).join(', ')}`)
  return value
}

/* ── 用例 ──────────────────────────────────────────────────────────── */

console.log('\nY. 工具输出契约（harness 校验器）')

await ta('Y-a: wolf_delegate stale 路径（基线已通过，不启动 agy）的返回过校验', async () => {
  const ctx = fakeCtx({ baselineExit: 0 })
  registerWolfDelegate(ctx, baseConfig(new RunsLedger(join(TMP, 'y-a.ndjson'))))
  const value = await ctx.registry.defs.get('wolf_delegate').execute(
    { task_id: 'y-a', task: 'x', verify_baseline: ['exit 0'], verify: ['echo ok'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'stale')
  assert.equal(value.verify_registered_count, 1, 'stale 路径也必须回传本轮收到的验收命令条数')
  assertOutputValid('wolf_delegate', ctx.registry.defs.get('wolf_delegate'), value)
})

await ta('Y-b: wolf_delegate pass 路径（agy 真跑 + 验收通过）的返回过校验', async () => {
  const ctx = fakeCtx({ baselineExit: 1, verifyExit: 0 })
  registerWolfDelegate(ctx, baseConfig(new RunsLedger(join(TMP, 'y-b.ndjson'))))
  const value = await ctx.registry.defs.get('wolf_delegate').execute(
    { task_id: 'y-b', task: 'x', verify_baseline: ['exit 1'], verify: ['echo ok'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'pass')
  assert.equal(value.conversation_id, 'conv-schema')
  assertOutputValid('wolf_delegate', ctx.registry.defs.get('wolf_delegate'), value)
})

await ta('Y-c: wolf_delegate fail 路径（带失败信号）的返回过校验', async () => {
  const ctx = fakeCtx({ baselineExit: 1, verifyExit: 1 })
  registerWolfDelegate(ctx, baseConfig(new RunsLedger(join(TMP, 'y-c.ndjson'))))
  const value = await ctx.registry.defs.get('wolf_delegate').execute(
    { task_id: 'y-c', task: 'x', verify_baseline: ['exit 1'], verify: ['npm test'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'fail')
  assertOutputValid('wolf_delegate', ctx.registry.defs.get('wolf_delegate'), value)
})

await ta('Y-d: wolf_status 的返回过校验（含预算字段）', async () => {
  const ledger = new RunsLedger(join(TMP, 'y-d.ndjson'))
  await ledger.record({ taskId: 'y-d', round: 2, verdict: 'pass', stopReason: 'completed', conversationId: 'conv-schema' })
  await ledger.record({ taskId: 'y-d', round: 1, verdict: 'fail', stopReason: 'completed' })
  const ctx = fakeCtx({})
  registerWolfStatus(ctx, baseConfig(ledger))
  const value = await ctx.registry.defs.get('wolf_status').execute({}, agentExec())
  assert.ok(value.tasks.length >= 1)
  assertOutputValid('wolf_status', ctx.registry.defs.get('wolf_status'), value)
})

await ta('Y-e: wolf_kill 对不存在的 task_id 的返回过校验', async () => {
  const ctx = fakeCtx({})
  registerWolfKill(ctx, baseConfig(new RunsLedger(join(TMP, 'y-e.ndjson'))))
  const value = await ctx.registry.defs.get('wolf_kill').execute({ task_id: 'never-started' }, agentExec())
  assert.equal(value.ok, false, '不存在的任务必须明确报失败')
  assertOutputValid('wolf_kill', ctx.registry.defs.get('wolf_kill'), value)
})

await ta('Y-f: wolf_team 单任务批次的返回过校验', async () => {
  const ctx = fakeCtx({ baselineExit: 1, verifyExit: 0 })
  registerWolfTeam(ctx, baseConfig(new RunsLedger(join(TMP, 'y-f.ndjson'))))
  const value = await ctx.registry.defs.get('wolf_team').execute(
    { tasks: [{ task_id: 'y-f-1', task: 'x', verify: ['echo ok'] }], concurrency: 1 },
    agentExec(),
  )
  assert.ok(Array.isArray(value.tasks) && value.tasks.length === 1)
  assertOutputValid('wolf_team', ctx.registry.defs.get('wolf_team'), value)
})

t('Y-g: 四个工具的 output.schema 都禁掉了未声明字段（additionalProperties: false）', () => {
  const ctx = fakeCtx({})
  const ledger = new RunsLedger(join(TMP, 'y-g.ndjson'))
  registerWolfDelegate(ctx, baseConfig(ledger))
  registerWolfStatus(ctx, baseConfig(ledger))
  registerWolfKill(ctx, baseConfig(ledger))
  registerWolfTeam(ctx, baseConfig(ledger))
  for (const [name, definition] of ctx.registry.defs) {
    assert.equal(definition.output.schema.additionalProperties, false, `${name} 必须显式 additionalProperties: false`)
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
