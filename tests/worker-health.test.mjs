import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfig } from '../src/config.mjs'
import { runDelegateTask } from '../src/delegate.mjs'
import { renderHealthReport } from '../src/digest.mjs'
import { RunsLedger } from '../src/ledger.mjs'
import { classifyFaultKind, matchAuth, matchCapacity } from '../src/worker/faults.mjs'
import {
  emptyHealthState,
  faultLabel,
  readHealthState,
  recordWorkerOutcome,
  resetWorkerHealth,
  snapshotHealth,
  updateHealthState,
} from '../src/worker/health.mjs'
import { resolveWorkerSelection } from '../src/worker/index.mjs'
import { cleanTempDir, createTempDir, fakeClaudePath, fakeWorkerPath, projectRoot } from './test-helper.mjs'

/** 两个工人都指向 fixture 的配置（全自动挑选时两者都算可用）。 */
function bothWorkers(extra = {}) {
  return { agyPath: fakeWorkerPath, claudePath: fakeClaudePath, ...extra }
}

/** 构造一个「claude 已在冷却中」的健康台账。 */
function benchedClaudeState(now, remainingMs = 60_000, reason = 'capacity') {
  const state = emptyHealthState()
  state.workers.claude = {
    consecutiveFailures: 1,
    totalFailures: 1,
    lastFailureAt: now,
    lastReason: reason,
    benchedUntil: now + remainingMs,
    benchReason: reason,
  }
  return state
}

export const tests = [
  {
    name: 'worker-fault-classification',
    async run() {
      // 用户自己取消：不算工人毛病
      assert.equal(classifyFaultKind({ stopReason: 'aborted', cancelled: true }), undefined)
      // 超时：算（多半是挂住不说话）
      assert.equal(classifyFaultKind({ stopReason: 'aborted', timedOut: true }), 'timeout')
      // 官方限流与中转池子额度耗尽
      assert.equal(classifyFaultKind({ stopReason: 'capacity' }), 'capacity')
      assert.equal(classifyFaultKind({ stopReason: 'error', status: 402 }), 'capacity')
      assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['无可用渠道，请稍后再试'] }), 'capacity')
      assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['insufficient_user_quota'] }), 'capacity')
      assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['额度不足'] }), 'capacity')
      // 未登录 / 鉴权失败
      assert.equal(classifyFaultKind({ stopReason: 'error', texts: ['Invalid API key · please run /login'] }), 'auth')
      assert.equal(classifyFaultKind({ stopReason: 'error', status: 401 }), 'auth')
      // 一个字都没吐
      assert.equal(classifyFaultKind({ stopReason: 'error', outputEmpty: true }), 'no-output')
      // 工人回了话但自报失败
      assert.equal(classifyFaultKind({ stopReason: 'error' }), 'error')
      // 成功与基线跳过不改台账
      assert.equal(classifyFaultKind({ stopReason: 'completed' }), undefined)
      assert.equal(classifyFaultKind({ stopReason: 'skipped' }), undefined)

      // 命中判定本身：窄模式才允许匹配整段 stdout，避免误判工人正文
      assert.equal(matchCapacity({ texts: ['Overloaded'] }), true)
      assert.equal(matchCapacity({ raw: '我今天重写了容量不足的提示文案' }), false)
      assert.equal(matchAuth({ texts: ['未登录'] }), true)
    },
  },
  {
    name: 'worker-health-threshold-and-reset',
    async run() {
      const now = 1_700_000_000_000
      const config = { workerHealth: { failThreshold: 2, cooldownMs: 60_000 } }

      // 普通失败第一次不冷却，第二次才冷却
      let state = emptyHealthState()
      recordWorkerOutcome(state, { worker: 'claude', kind: 'error', config, now })
      assert.equal(snapshotHealth(state, 'claude', now).benched, false)
      recordWorkerOutcome(state, { worker: 'claude', kind: 'error', config, now })
      const benched = snapshotHealth(state, 'claude', now)
      assert.equal(benched.benched, true)
      assert.equal(benched.remaining_ms, 60_000)
      assert.equal(benched.consecutive_failures, 2)

      // 成功一次清零并解除冷却
      recordWorkerOutcome(state, { worker: 'claude', kind: 'success', config, now: now + 1 })
      const cleared = snapshotHealth(state, 'claude', now + 1)
      assert.equal(cleared.benched, false)
      assert.equal(cleared.consecutive_failures, 0)

      // 工人自身故障（额度耗尽）当轮即冷却，不必等阈值
      let capacityState = emptyHealthState()
      recordWorkerOutcome(capacityState, { worker: 'claude', kind: 'capacity', config, now })
      assert.equal(snapshotHealth(capacityState, 'claude', now).benched, true)

      // neutral（用户取消/基线跳过）什么都不改
      const before = JSON.stringify(capacityState)
      recordWorkerOutcome(capacityState, { worker: 'claude', kind: 'neutral', config, now: now + 5 })
      assert.equal(JSON.stringify(capacityState), before)

      // 冷却到期自动恢复（不需要手动清）
      assert.equal(snapshotHealth(capacityState, 'claude', now + 10 * 60_000).benched, false)

      // 手动清冷却
      resetWorkerHealth(capacityState, 'claude')
      assert.equal(snapshotHealth(capacityState, 'claude', now).benched, false)
      assert.deepEqual(capacityState.workers, {})
    },
  },
  {
    name: 'worker-health-selection-skips-benched',
    async run() {
      const now = 1_700_000_000_000
      const config = bothWorkers()
      const health = benchedClaudeState(now)

      // claude 冷却中：即使轮换游标指向它，也必须派给 agy，并如实标注
      for (let i = 0; i < 4; i++) {
        const pick = resolveWorkerSelection({ config, health, now })
        assert.equal(pick.name, 'agy')
        assert.equal(pick.reason, 'only-available')
        assert.equal(pick.benched_skipped.length, 1)
        assert.equal(pick.benched_skipped[0].worker, 'claude')
        assert.equal(pick.benched_skipped[0].benched, true)
      }

      // 冷却到期后回到正常轮换（两个工人都能轮到）
      const later = now + 10 * 60_000
      const names = new Set()
      for (let i = 0; i < 6; i++) names.add(resolveWorkerSelection({ config, health, now: later }).name)
      assert.deepEqual([...names].sort(), ['agy', 'claude'])

      // 两个都在冷却：仍会挑最早恢复的那个硬试，绝不空转
      const bothBenched = benchedClaudeState(now, 60_000, 'capacity')
      bothBenched.workers.agy = {
        consecutiveFailures: 1,
        totalFailures: 1,
        lastReason: 'no-output',
        benchedUntil: now + 5 * 60_000,
        benchReason: 'no-output',
      }
      const pick = resolveWorkerSelection({ config, health: bothBenched, now })
      assert.equal(pick.name, 'claude', '最早恢复的是 claude（1 分钟后）')
      assert.equal(pick.all_benched, true)
      assert.match(pick.reason, /^all-benched\(claude\)$/)

      // 显式点名优先于冷却：配置说用 claude 就用 claude，但标注忽略冷却
      const explicit = resolveWorkerSelection({
        config: { ...config, worker: 'claude' },
        health,
        now,
      })
      assert.equal(explicit.name, 'claude')
      assert.equal(explicit.reason, 'explicit')
      assert.equal(explicit.benched_ignored, true)

      // 健康机制关掉：完全按老规则挑（不看冷却）
      const disabled = resolveWorkerSelection({
        config: { ...config, workerHealth: { enabled: false } },
        health,
        now,
      })
      assert.deepEqual(Object.keys(disabled).sort(), ['name', 'reason'], '关掉健康机制后不引入额外字段')
      assert.ok(['agy', 'claude'].includes(disabled.name))

      // 不传健康台账：与老行为完全一致（不引入多余字段）
      const plain = resolveWorkerSelection({ config })
      assert.deepEqual(Object.keys(plain).sort(), ['name', 'reason'])
      assert.equal(plain.reason, 'rotation')
      assert.ok(['agy', 'claude'].includes(plain.name))
    },
  },
  {
    name: 'worker-health-store-tolerant-and-atomic',
    async run() {
      const tempDir = createTempDir('wolf-health-store-')
      const filePath = join(tempDir, 'worker-health.json')

      try {
        // 文件不存在：空台账，不抛错
        const missing = await readHealthState(filePath)
        assert.deepEqual(missing.workers, {})

        // 文件损坏：同样当空台账，绝不因为台账问题拦下派活
        writeFileSync(filePath, '{ 这不是 JSON', 'utf8')
        assert.deepEqual((await readHealthState(filePath)).workers, {})

        // 结构不对（workers 是数组）也当空台账
        writeFileSync(filePath, JSON.stringify({ workers: [] }), 'utf8')
        assert.deepEqual((await readHealthState(filePath)).workers, {})

        // 写回：原子替换 + 串行队列（并发调用不互相覆盖）
        await Promise.all([
          updateHealthState(filePath, state => recordWorkerOutcome(state, {
            worker: 'claude',
            kind: 'capacity',
            config: { workerHealth: { capacityCooldownMs: 60_000 } },
          })),
          updateHealthState(filePath, state => recordWorkerOutcome(state, {
            worker: 'agy',
            kind: 'timeout',
            config: { workerHealth: { timeoutCooldownMs: 120_000 } },
          })),
        ])
        const saved = JSON.parse(readFileSync(filePath, 'utf8'))
        assert.equal(typeof saved.workers.claude.benchedUntil, 'number')
        assert.equal(typeof saved.workers.agy.benchedUntil, 'number')
        assert.equal(saved.workers.agy.lastReason, 'timeout')
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'worker-health-delegate-benches-and-switches-worker',
    async run() {
      const tempDir = createTempDir('wolf-health-delegate-')
      const taskId = 'health-switch-task'
      const saved = { ...process.env }

      try {
        const healthPath = join(tempDir, 'worker-health.json')
        const baseConfig = loadConfig({
          agyPath: fakeWorkerPath,
          claudePath: fakeClaudePath,
          ledgerPath: join(tempDir, 'runs.ndjson'),
          rawDir: join(tempDir, 'raw'),
          workerHealth: { filePath: healthPath, capacityCooldownMs: 10 * 60_000 },
        })
        const ledger = new RunsLedger(baseConfig.ledgerPath, baseConfig)

        // 第一轮：显式点名 claude，而 claude 报中转池子额度耗尽（402）
        process.env.FAKE_CLAUDE_IS_ERROR = '1'
        process.env.FAKE_CLAUDE_API_STATUS = '402'
        process.env.FAKE_CLAUDE_SUMMARY = 'insufficient_user_quota: 中转池子余额不足'

        const first = await runDelegateTask({
          config: { ...baseConfig, worker: 'claude' },
          args: { task_id: taskId, task: '第一轮：claude 额度耗尽' },
          cwd: tempDir,
          ledger,
        })

        assert.equal(first.worker, 'claude')
        assert.equal(first.stop_reason, 'capacity')
        assert.equal(first.worker_health.benched, true, '额度耗尽当轮即冷却')
        assert.equal(first.worker_health.last_reason, 'capacity')

        // 第二轮：回到全自动，claude 还在冷却 → 自动改派 agy，不再撞同一堵墙
        delete process.env.FAKE_CLAUDE_IS_ERROR
        delete process.env.FAKE_CLAUDE_API_STATUS
        delete process.env.FAKE_CLAUDE_SUMMARY

        const second = await runDelegateTask({
          config: { ...baseConfig, worker: 'auto' },
          args: { task_id: taskId, task: '第二轮：应该自动改派给 agy' },
          cwd: tempDir,
          ledger,
        })

        assert.equal(second.worker, 'agy', 'claude 冷却中，本轮改派 agy')
        assert.equal(second.stop_reason, 'completed')
        assert.equal(second.benched_workers.length, 1)
        assert.equal(second.benched_workers[0].worker, 'claude')
        assert.equal(second.benched_workers[0].last_reason, 'capacity')

        // 第三轮：agy 成功 → agy 无失败记录，claude 仍在冷却
        const state = await readHealthState(healthPath)
        assert.equal(snapshotHealth(state, 'agy').consecutive_failures, 0)
        assert.equal(snapshotHealth(state, 'claude').benched, true)

        // digest 必须把「为什么换人」讲清楚
        const digest = renderHealthReport({
          workers: ['agy', 'claude'].map(w => snapshotHealth(state, w)),
          file_path: healthPath,
          enabled: true,
          fail_threshold: 2,
        })
        assert.match(digest, /claude：冷却中/)
        assert.match(digest, new RegExp(faultLabel('capacity')))
        assert.match(digest, /health --reset/)
      } finally {
        for (const key of Object.keys(process.env)) {
          if (!(key in saved)) delete process.env[key]
        }
        Object.assign(process.env, saved)
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'worker-health-cli-report-and-reset',
    async run() {
      const tempDir = createTempDir('wolf-health-cli-')
      const healthPath = join(tempDir, 'worker-health.json')
      const wolfCli = join(projectRoot, 'bin', 'wolf.mjs')
      const env = { ...process.env, WOLFPACK_HEALTH_FILE: healthPath }

      try {
        const state = benchedClaudeState(Date.now(), 10 * 60_000, 'auth')
        writeFileSync(healthPath, JSON.stringify(state), 'utf8')

        const report = spawnSync(process.execPath, [wolfCli, 'health', '--json'], { env, encoding: 'utf8' })
        assert.equal(report.status, 0, report.stderr)
        const parsed = JSON.parse(report.stdout)
        assert.equal(parsed.enabled, true)
        const claude = parsed.workers.find(w => w.worker === 'claude')
        assert.equal(claude.benched, true)
        assert.equal(claude.last_reason, 'auth')

        const reset = spawnSync(process.execPath, [wolfCli, 'health', '--reset', 'all'], { env, encoding: 'utf8' })
        assert.equal(reset.status, 0, reset.stderr)
        assert.match(reset.stdout, /已清除 全部工人 的冷却/)
        assert.deepEqual(JSON.parse(readFileSync(healthPath, 'utf8')).workers, {})

        // 非法目标：明确报错，不静默吞掉
        const bad = spawnSync(process.execPath, [wolfCli, 'health', '--reset', 'gpt'], { env, encoding: 'utf8' })
        assert.equal(bad.status, 1)
        assert.match(bad.stderr, /只接受/)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
]
