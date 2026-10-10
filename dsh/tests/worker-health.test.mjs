/**
 * 工人注册表与健康台账测试套件（DSH 版狼群）
 */

import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CAPACITY_STATUS,
  apiStatusFromText,
  classifyFaultKind,
  matchAuth,
  matchCapacity,
} from './core/worker/faults.mjs'

import {
  DEFAULT_HEALTH_CONFIG,
  FAULT_LABELS,
  HEALTH_VERSION,
  emptyHealthState,
  faultLabel,
  healthConfigOf,
  readHealthState,
  recordWorkerOutcome,
  resetWorkerHealth,
  snapshotHealth,
  updateHealthState,
} from './core/worker/health.mjs'

import {
  AUTO_WORKER,
  agyWorker,
  getWorker,
  isWorkerAvailable,
  listWorkers,
  normalizeWorkerPreference,
  registerWorker,
  resolveWorkerSelection,
  workerPathOf,
} from './core/worker/index.mjs'

import { loadConfig } from './core/config.mjs'

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

const TMP = `${process.env.TEMP}/wolfpack-health-test`
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })

console.log('\nZ. 工人注册表、挑选策略与健康冷却')

// 1. faults.mjs 判定
t('Z-a: classifyFaultKind 与状态/文本判定', () => {
  assert.equal(classifyFaultKind({ stopReason: 'aborted', cancelled: true }), undefined)
  assert.equal(classifyFaultKind({ stopReason: 'aborted', timedOut: true }), 'timeout')
  assert.equal(classifyFaultKind({ stopReason: 'capacity' }), 'capacity')
  assert.equal(classifyFaultKind({ stopReason: 'error', status: 429 }), 'capacity')
  assert.equal(classifyFaultKind({ stopReason: 'error', status: 503 }), 'capacity')
  assert.equal(classifyFaultKind({ stopReason: 'error', status: 401 }), 'auth')
  assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['insufficient_user_quota'] }), 'capacity')
  assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['Invalid API key'] }), 'auth')
  assert.equal(classifyFaultKind({ stopReason: 'error', outputEmpty: true }), 'no-output')
  assert.equal(classifyFaultKind({ stopReason: 'error' }), 'error')
  assert.equal(classifyFaultKind({ stopReason: 'completed' }), undefined)
  assert.equal(classifyFaultKind({ stopReason: 'skipped' }), undefined)

  assert.equal(matchCapacity({ texts: ['Overloaded'] }), true)
  assert.equal(matchCapacity({ raw: '我今天重写了容量不足的提示文案' }), false)
  assert.equal(matchAuth({ texts: ['未登录'] }), true)

  const REAL_AUTH_RAW = 'Failed to authenticate. API Error: 403 该令牌无权访问模型 claude-opus-5-5'
  assert.equal(matchAuth({ texts: [REAL_AUTH_RAW] }), true)
  assert.equal(matchAuth({ raw: REAL_AUTH_RAW }), true)
  assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['claude exit 1: 无错误详情'], raw: REAL_AUTH_RAW }), 'auth')
  assert.equal(classifyFaultKind({ stopReason: 'error', status: 403 }), 'auth')

  // 反例：普通失败或正文偶现 403/error 绝不误判为 auth
  assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['测试失败'], raw: '{"status":"ERROR","error":"测试失败"}' }), 'error')
  assert.equal(classifyFaultKind({ stopReason: 'error', raw: 'Error: expected 403 status code but got 200' }), 'error')
  assert.equal(matchAuth({ raw: '普通失败，包含 403 状态码与 error 堆栈，用例全部执行完毕' }), false)
  assert.equal(matchAuth({ texts: ['测试运行抛错：assertion failed'] }), false)

  // claude 适配器把状态码拼成 `API 402: …`，apiStatusFromText 只认这个形式
  assert.equal(apiStatusFromText('API 429: Too Many Requests'), 429)
  assert.equal(apiStatusFromText('没有任何状态码'), undefined)
})

// 2. health.mjs 状态演化与冷却计算
t('Z-b: health 状态演化、阈值触发与成功清零', () => {
  const now = 1_700_000_000_000
  const cfg = { workerHealth: { failThreshold: 2, cooldownMs: 60_000, capacityCooldownMs: 30_000, authCooldownMs: 120_000 } }

  let state = emptyHealthState()
  assert.equal(state.version, HEALTH_VERSION)

  // 第一次普通失败：不冷却
  recordWorkerOutcome(state, { worker: 'agy', kind: 'error', config: cfg, now })
  assert.equal(snapshotHealth(state, 'agy', now).benched, false)

  // 第二次普通失败：进冷却
  recordWorkerOutcome(state, { worker: 'agy', kind: 'error', config: cfg, now })
  const snap1 = snapshotHealth(state, 'agy', now)
  assert.equal(snap1.benched, true)
  assert.equal(snap1.remaining_ms, 60_000)
  assert.equal(snap1.consecutive_failures, 2)
  assert.equal(snap1.last_reason, 'error')
  assert.equal(state.workers.agy.benchReason, 'error')
  assert.equal(faultLabel(snap1.last_reason), FAULT_LABELS.error)

  // 成功一次：清零解除冷却
  recordWorkerOutcome(state, { worker: 'agy', kind: 'success', config: cfg, now: now + 1 })
  const snap2 = snapshotHealth(state, 'agy', now + 1)
  assert.equal(snap2.benched, false)
  assert.equal(snap2.consecutive_failures, 0)

  // 容量错误：单次立刻进容量专用冷却
  recordWorkerOutcome(state, { worker: 'agy', kind: 'capacity', config: cfg, now })
  const snap3 = snapshotHealth(state, 'agy', now)
  assert.equal(snap3.benched, true)
  assert.equal(snap3.remaining_ms, 30_000)
  assert.equal(snap3.last_reason, 'capacity')
  assert.equal(state.workers.agy.benchReason, 'capacity')
  assert.equal(faultLabel(snap3.last_reason), FAULT_LABELS.capacity)

  // 鉴权错误：单次立刻进鉴权专用冷却
  recordWorkerOutcome(state, { worker: 'claude', kind: 'auth', config: cfg, now })
  const snapAuth = snapshotHealth(state, 'claude', now)
  assert.equal(snapAuth.benched, true)
  assert.equal(snapAuth.remaining_ms, 120_000)
  assert.equal(snapAuth.last_reason, 'auth')
  assert.equal(state.workers.claude.benchReason, 'auth')
  assert.equal(faultLabel(snapAuth.last_reason), FAULT_LABELS.auth)

  // resetWorkerHealth
  resetWorkerHealth(state, 'agy')
  assert.equal(snapshotHealth(state, 'agy', now).benched, false)
  resetWorkerHealth(state, 'claude')
  assert.equal(snapshotHealth(state, 'claude', now).benched, false)
})

// 3. health.mjs 读写文件持久化
await ta('Z-c: readHealthState 与 updateHealthState 文件持久化', async () => {
  const healthFile = join(TMP, 'worker-health.json')
  const read1 = await readHealthState(healthFile)
  assert.equal(read1.version, HEALTH_VERSION)

  const updated = await updateHealthState(healthFile, s => {
    s.workers.agy = {
      consecutiveFailures: 3,
      totalFailures: 3,
      lastFailureAt: Date.now(),
      lastReason: 'capacity',
      benchedUntil: Date.now() + 100000,
      benchReason: 'capacity',
    }
  })
  assert.equal(updated.workers.agy.consecutiveFailures, 3)

  const read2 = await readHealthState(healthFile)
  assert.equal(read2.workers.agy.consecutiveFailures, 3)
})

// 4. worker/index.mjs 工人获取与挑选逻辑
t('Z-d: worker 注册表与 resolveWorkerSelection 挑选逻辑', () => {
  assert.equal(AUTO_WORKER, 'auto')
  assert.equal(getWorker(), agyWorker)
  assert.equal(getWorker('agy'), agyWorker)
  assert.throws(() => getWorker('unknown'), /未找到名为 "unknown" 的工人适配器/)

  // 空值 / auto 系列一律归一为 undefined（= 全自动挑选）
  assert.equal(normalizeWorkerPreference(undefined), undefined)
  assert.equal(normalizeWorkerPreference('auto'), undefined)
  assert.equal(normalizeWorkerPreference('rotate'), undefined)
  assert.equal(normalizeWorkerPreference('agy'), 'agy')

  // 「装好的工人」用当前 node 可执行文件充当：绝对路径且必然存在，preflight 必过
  const anyExe = process.execPath

  // 显式选择 agy
  const sel1 = resolveWorkerSelection({ config: { worker: 'agy', agyPath: anyExe } })
  assert.equal(sel1.name, 'agy')
  assert.equal(sel1.reason, 'explicit')

  // auto 模式，健康正常 -> 选择 agy（config 未给 claudePath，故 claude 视为没装）
  const sel2 = resolveWorkerSelection({ config: { worker: 'auto', agyPath: anyExe } })
  assert.equal(sel2.name, 'agy')

  // 单工人全部冷却时的 fallback
  const now = 1_700_000_000_000
  const benchedState = emptyHealthState()
  benchedState.workers.agy = {
    consecutiveFailures: 2,
    totalFailures: 2,
    lastFailureAt: now,
    lastReason: 'error',
    benchedUntil: now + 60000,
    benchReason: 'error',
  }
  const sel3 = resolveWorkerSelection({ config: { worker: 'auto', agyPath: anyExe }, health: benchedState, now })
  assert.equal(sel3.name, 'agy')
  assert.equal(sel3.all_benched, true)
  assert.equal(sel3.reason, 'all-benched(agy)')
  assert.equal(sel3.benched.benched, true)
})

// 5. agy.mjs 方法完备性
t('Z-e: agyWorker preflight / extractSessionId / parse / classify', () => {
  // preflight: 空路径 -> 失败
  const pf1 = agyWorker.preflight({ agyPath: '' })
  assert.equal(pf1.ok, false)

  // preflight: 不存在的绝对路径 -> 失败
  const pf2 = agyWorker.preflight({ agyPath: join(TMP, 'non-existent-agy.exe') })
  assert.equal(pf2.ok, false)

  // preflight: 裸命令名 -> 放行
  const pf3 = agyWorker.preflight({ agyPath: 'agy' })
  assert.equal(pf3.ok, true)

  // extractSessionId
  // extractSessionId 从 agy 的 JSON 输出里取 conversation_id
  assert.equal(agyWorker.extractSessionId(JSON.stringify({ conversation_id: 'abc-123' })), 'abc-123')
  assert.equal(agyWorker.extractSessionId('不是 JSON'), undefined)

  // parse
  const parsed = agyWorker.parse(JSON.stringify({ status: 'SUCCESS', response: 'done' }))
  assert.equal(parsed.status, 'SUCCESS')
  assert.equal(parsed.response, 'done')

  // classify
  const okJson = JSON.stringify({ status: 'SUCCESS', response: 'ok' })
  const cl = agyWorker.classify({
    parsed: agyWorker.parse(okJson),
    raw: okJson,
    exitCode: 0,
    artifacts: { added: [], modified: [], deleted: [] },
    timedOut: false,
    cancelled: false,
  })
  assert.equal(cl.stopReason, 'completed')
})

// 6. config.mjs 的 worker 与 workerHealth 默认值
t('Z-f: config.mjs worker 默认 auto 且包含 workerHealth 配置项', () => {
  const cfg = loadConfig({}, {})
  assert.equal(cfg.worker, 'auto')
  assert.equal(cfg.workerHealth.enabled, true)
  assert.equal(cfg.workerHealth.failThreshold, 2)
  assert.equal(cfg.workerHealth.cooldownMs, 600000)
  assert.equal(cfg.workerHealth.capacityCooldownMs, 300000)
  assert.equal(cfg.workerHealth.timeoutCooldownMs, 600000)
  assert.equal(cfg.workerHealth.authCooldownMs, 1800000)
})

console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  process.exit(1)
}
