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
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  registerWolfDelegate,
  registerWolfKill,
  registerWolfStatus,
  registerWolfTeam,
} from './index.js'
import { RunsLedger } from './runs-ledger.js'
import { toLosslessJson, losslessViolations } from './core/lossless.mjs'

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

/** 断言对象符合宿主 lossless JSON 判据。 */
function assertLosslessValid(toolName, value) {
  const issues = losslessViolations(value)
  assert.deepEqual(issues, [], `${toolName} 的返回对象不是 lossless JSON（会被宿主整份丢弃）：\n  ${issues.join('\n  ')}`)
  return value
}

/** 用 harness 自己的校验器验一个工具的返回对象。 */
function assertOutputValid(toolName, definition, value) {
  assert.ok(definition?.output?.schema, `${toolName} 没有声明 output.schema`)
  const violations = validateJsonSchemaValue(definition.output.schema, value)
  assert.ok(Array.isArray(violations), `${toolName} 校验器返回值不是数组`)
  assert.deepEqual(violations, [], `${toolName} 的返回对象过不了 output.schema：\n  ${violations.join('\n  ')}\n返回对象键：${Object.keys(value ?? {}).join(', ')}`)
  assertLosslessValid(toolName, value)
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

await ta('Y-h: wolf_delegate 在「健康文件有条目且未冷却」时的返回是 lossless JSON（真实盲区修复）', async () => {
  const healthFile = join(TMP, 'y-h-health.json')
  const now = Date.now()
  await writeFile(healthFile, JSON.stringify({
    version: 1,
    updatedAt: now,
    workers: {
      agy: {
        consecutiveFailures: 0,
        totalFailures: 0,
        benchedUntil: 0,
        lastOutcome: 'success',
        lastSuccessAt: now,
      },
    },
  }, null, 2), 'utf8')

  const ctx = fakeCtx({ baselineExit: 1, verifyExit: 0 })
  const cfg = {
    ...baseConfig(new RunsLedger(join(TMP, 'y-h.ndjson'))),
    workerHealth: {
      enabled: true,
      filePath: healthFile,
    },
  }
  registerWolfDelegate(ctx, cfg)
  const value = await ctx.registry.defs.get('wolf_delegate').execute(
    { task_id: 'y-h', task: 'x', verify_baseline: ['exit 1'], verify: ['echo ok'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'pass')
  assert.ok(value.worker_health, '必须包含 worker_health')
  assert.equal(value.worker_health.worker, 'agy')
  assert.equal(value.worker_health.benched, false)
  assert.equal('benched_until' in value.worker_health, false, '未冷却时 benched_until 必须缺席')
  assert.equal('remaining_ms' in value.worker_health, false, '未冷却时 remaining_ms 必须缺席')
  assertOutputValid('wolf_delegate', ctx.registry.defs.get('wolf_delegate'), value)
})

await ta('Y-i: 复现真实事故：工人运行失败带 lastDiagnostic/lastReason 时，返回值完整保留失败原因且为 lossless JSON', async () => {
  const healthFile = join(TMP, 'y-i-health.json')
  const ctx = fakeCtx({
    baselineExit: 1,
    agyExit: 1,
    verifyExit: 1,
    agyJson: JSON.stringify({
      status: 'FAILED',
      response: 'Error: API rate limit exceeded: 503 No capacity available',
      error: 'capacity',
      diagnostic: 'API rate limit exceeded on endpoint /v1/chat: 503 No capacity available',
      duration_seconds: 2,
    }),
  })
  const cfg = {
    ...baseConfig(new RunsLedger(join(TMP, 'y-i.ndjson'))),
    workerHealth: {
      enabled: true,
      filePath: healthFile,
    },
  }
  registerWolfDelegate(ctx, cfg)
  const value = await ctx.registry.defs.get('wolf_delegate').execute(
    { task_id: 'y-i', task: 'x', verify_baseline: ['exit 1'], verify: ['npm test'] },
    agentExec(),
  )
  assertOutputValid('wolf_delegate', ctx.registry.defs.get('wolf_delegate'), value)
  assert.equal(value.verdict, 'fail')
  assert.equal(value.stop_reason, 'capacity')
  assert.equal(value.capacity, true)
  assert.ok(
    value.diagnostic?.includes('No capacity available') || value.report?.includes('No capacity available'),
    '返回值中必须保留失败原因诊断',
  )
  assert.ok(value.worker_health, '必须包含 worker_health')
  assert.equal(value.worker_health.last_reason, 'capacity', 'worker_health 中必须包含 last_reason=capacity')
  assert.ok(
    value.worker_health.last_diagnostic?.includes('No capacity available'),
    'worker_health 中必须包含 last_diagnostic 诊断文案',
  )
  assert.equal('last_success_at' in value.worker_health, false, '失败条目中未成功的字段必须缺席')
})

t('Y-j: 宿主 lossless 判据与 toLosslessJson 防线机制（嵌套 undefined、NaN、Infinity、-0、非纯对象、成环全量校验）', () => {
  // 1. 宿主 lossless 判据能准确拦截各种非法情况
  assert.ok(losslessViolations({ a: undefined }).length > 0, '未拦截嵌套 undefined')
  assert.ok(losslessViolations({ a: { b: undefined } }).length > 0, '未拦截深度嵌套 undefined')
  assert.ok(losslessViolations({ a: NaN }).length > 0, '未拦截 NaN')
  assert.ok(losslessViolations({ a: Infinity }).length > 0, '未拦截 Infinity')
  assert.ok(losslessViolations({ a: -0 }).length > 0, '未拦截 -0')
  assert.ok(losslessViolations({ a: new Date() }).length > 0, '未拦截非纯对象')
  const cycle = {}
  cycle.self = cycle
  assert.ok(losslessViolations(cycle).length > 0, '未拦截成环')

  // 2. toLosslessJson 清洗对象属性中的 undefined
  const cleaned = toLosslessJson({ a: 1, b: undefined, c: { d: undefined, e: 'ok' } })
  assert.deepEqual(cleaned, { a: 1, c: { e: 'ok' } })
  assert.deepEqual(losslessViolations(cleaned), [])

  // 3. toLosslessJson 对数组中的 undefined 显式抛错（上游 bug 禁止静默抹平）
  assert.throws(() => toLosslessJson([1, undefined, 2]), /数组元素.*为 undefined/)

  // 4. toLosslessJson 对非法数字显式抛错（禁止静默改成 0）
  assert.throws(() => toLosslessJson({ val: -0 }), /-0/)
  assert.throws(() => toLosslessJson({ val: NaN }), /非有限数字/)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
