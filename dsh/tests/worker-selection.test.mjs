import assert from 'node:assert/strict'
import {
  Config,
  computeWorkersEnabled,
  readVolatile,
  runConfig,
} from './index.js'
import {
  listWorkers,
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

console.log('\n工人启用集合筛选与配置测试')

const exe = process.execPath
const bothConfig = { agyPath: exe, claudePath: exe }

t('Config: 包含 agy_enabled 与 claude_enabled，agy 默认开、claude 默认关', () => {
  const parsed = Config({})
  assert.equal(readVolatile(parsed, 'enabled', true), false)
  assert.equal(readVolatile(parsed, 'agy_enabled', false), true)
  assert.equal(readVolatile(parsed, 'claude_enabled', true), false)
})

t('readVolatile: 兼容裸值与 .get() 引用，缺省时使用 fallback', () => {
  assert.equal(readVolatile({ agy_enabled: true }, 'agy_enabled', false), true)
  assert.equal(readVolatile({ agy_enabled: false }, 'agy_enabled', true), false)
  assert.equal(readVolatile({ agy_enabled: { get: () => false } }, 'agy_enabled', true), false)
  assert.equal(readVolatile({}, 'agy_enabled', true), true)
  assert.equal(readVolatile(undefined, 'agy_enabled', true), true)
})

t('computeWorkersEnabled: 两个都开返回 undefined，单选返回对应数组，全关返回空数组', () => {
  assert.equal(computeWorkersEnabled({ agy_enabled: true, claude_enabled: true }), undefined)
  assert.equal(computeWorkersEnabled({ agy_enabled: { get: () => true }, claude_enabled: { get: () => true } }), undefined)
  assert.deepEqual(computeWorkersEnabled({ agy_enabled: true, claude_enabled: false }), ['agy'])
  assert.deepEqual(computeWorkersEnabled({ agy_enabled: false, claude_enabled: true }), ['claude'])
  assert.deepEqual(computeWorkersEnabled({ agy_enabled: false, claude_enabled: false }), [])
})

// 回归闸门：profile 里没写工人键是常态（DSH 只交原始的 `{enabled:true}` 给 apply）。
// 兜底若按「缺省即开」，claude 会被静默算进工人池、轮换把活派给它再失败。
t('computeWorkersEnabled: 工人键缺失时按 schema 默认兜底（agy 开、claude 关）', () => {
  assert.deepEqual(computeWorkersEnabled({}), ['agy'])
  assert.deepEqual(computeWorkersEnabled(undefined), ['agy'])
  assert.deepEqual(computeWorkersEnabled({ enabled: true }), ['agy'])
})

t('runConfig: 包含 workersEnabled、claudePath 与 worker 字段', () => {
  const cfg = runConfig({}, { agy_enabled: true, claude_enabled: false })
  assert.deepEqual(cfg.workersEnabled, ['agy'])
  assert.ok(typeof cfg.claudePath === 'string')
  assert.ok(typeof cfg.agyPath === 'string')
})

t('workersEnabled: 未设置或空数组时完全不限制（回退全自动）', () => {
  const r1 = resolveWorkerSelection({ config: bothConfig })
  assert.ok(['agy', 'claude'].includes(r1.name))
  const r2 = resolveWorkerSelection({ config: { ...bothConfig, workersEnabled: [] } })
  assert.ok(['agy', 'claude'].includes(r2.name))
})

t('workersEnabled: 只启用 claude 时必须选 claude', () => {
  const res = resolveWorkerSelection({ config: { ...bothConfig, workersEnabled: ['claude'] } })
  assert.equal(res.name, 'claude')
  assert.equal(res.reason, 'only-available')
})

t('workersEnabled: 只启用 agy 时必须选 agy', () => {
  const res = resolveWorkerSelection({ config: { ...bothConfig, workersEnabled: ['agy'] } })
  assert.equal(res.name, 'agy')
  assert.equal(res.reason, 'only-available')
})

t('workersEnabled: 点名被禁用的工人时回退并标注 fallback(<prefer>-disabled)', () => {
  const res = resolveWorkerSelection({
    config: { ...bothConfig, worker: 'agy', workersEnabled: ['claude'] },
  })
  assert.equal(res.name, 'claude')
  assert.equal(res.reason, 'fallback(agy-disabled)')

  const res2 = resolveWorkerSelection({
    config: { ...bothConfig, worker: 'claude', workersEnabled: ['agy'] },
  })
  assert.equal(res2.name, 'agy')
  assert.equal(res2.reason, 'fallback(claude-disabled)')
})

t('workersEnabled: 启用的工人全部不可用时抛出可读错误并说明原因', () => {
  assert.throws(
    () => resolveWorkerSelection({ config: { agyPath: exe, workersEnabled: ['claude'] } }),
    /只启用了|没有可用的工人/,
  )
  try {
    resolveWorkerSelection({ config: { agyPath: exe, workersEnabled: ['claude'] } })
    assert.fail('should have thrown')
  } catch (err) {
    assert.ok(/只启用了.*claude/i.test(err.message))
    assert.ok(/已注册.*agy.*claude/i.test(err.message))
    assert.ok(/claude.*(路径为空|预检未通过|未配置|不可用|未找到)/i.test(err.message))
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
