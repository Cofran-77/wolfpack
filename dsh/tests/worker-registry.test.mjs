import assert from 'node:assert/strict'
import {
  computeWorkersEnabled,
} from './index.js'
import {
  getWorker,
  isWorkerAvailable,
  listWorkers,
  resolveWorkerSelection,
  workerPathOf,
  WORKER_PATH_KEYS,
  CORE_WORKER_NAMES,
  isOptInWorker,
} from './core/worker/index.mjs'
import {
  WORKER_SPECS,
} from './core/worker/specs.mjs'
import {
  createWorkerFromSpec,
} from './core/worker/generic.mjs'

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

console.log('\n可插拔工人注册表（Round 2）规格与选择测试')

// 1. 注册表顺序与唯一性（28 个工人）
t('1. listWorkers() 共 28 个：前两个是 agy、claude；其余 26 个名字与 WORKER_SPECS 一致且无重复', () => {
  const workers = listWorkers()
  const names = workers.map(w => w.name)
  assert.equal(names.length, 28, '注册表总工人数必须为 28')
  assert.equal(names[0], 'agy', '第一个必须是 agy')
  assert.equal(names[1], 'claude', '第二个必须是 claude')
  const rest = names.slice(2)
  const specNames = WORKER_SPECS.map(s => s.name)
  assert.equal(specNames.length, 26, '声明式规格数必须为 26')
  assert.deepEqual(rest, specNames, '其余工人按 specs 顺序注册')
  assert.equal(new Set(names).size, names.length, '工人名不得重复')
})

// 2. preflight 失败测试
t('2. 每个 spec: contract === "unknown" 预检失败且包含未核实；prompt === "stdin" 预检失败', () => {
  for (const spec of WORKER_SPECS) {
    const worker = createWorkerFromSpec(spec)
    if (spec.contract === 'unknown') {
      const probe = worker.preflight({})
      assert.equal(probe.ok, false, `${spec.name} contract=unknown preflight 必须返回 ok:false`)
      assert.ok(/未核实/.test(probe.reason), `${spec.name} reason 必须包含「未核实」`)
    }
  }

  const stdinSpec = {
    name: 'test-stdin-worker',
    contract: 'documented',
    prompt: 'stdin',
    source: ['https://example.com/stdin-worker'],
  }
  const stdinWorker = createWorkerFromSpec(stdinSpec)
  const stdinProbe = stdinWorker.preflight({})
  assert.equal(stdinProbe.ok, false, 'prompt=stdin preflight 必须返回 ok:false')
  assert.ok(/stdin/.test(stdinProbe.reason), 'reason 必须说明 stdin 不支持')
})

// 3. documented 规格 source 检查
t('3. 每条 documented spec 都至少有一个非空 source URL', () => {
  for (const spec of WORKER_SPECS) {
    if (spec.contract === 'documented') {
      assert.ok(Array.isArray(spec.source), `${spec.name} 的 source 必须是数组`)
      assert.ok(spec.source.length > 0, `${spec.name} 的 source 不能为空`)
      for (const url of spec.source) {
        assert.ok(typeof url === 'string' && url.startsWith('http'), `${spec.name} 的 source 必须是有效 URL: ${url}`)
      }
    }
  }
})

// 4. opt-in 过滤测试
t('4. opt-in 隔离：未显式启用时不会自动选中 opt-in 工人；显式启用且可用时才可能选中', () => {
  const exe = process.execPath
  const configWithoutEnabled = {
    agyPath: 'non-existent-agy-bin',
    claudePath: 'non-existent-claude-bin',
    codexPath: exe,
  }
  assert.throws(
    () => resolveWorkerSelection({ config: configWithoutEnabled }),
    /没有可用的工人 CLI/,
  )

  const configWithEnabled = {
    agyPath: 'non-existent-agy-bin',
    claudePath: 'non-existent-claude-bin',
    codexPath: exe,
    workersEnabled: ['codex'],
  }
  const picked = resolveWorkerSelection({ config: configWithEnabled })
  assert.equal(picked.name, 'codex')
})

// 5. computeWorkersEnabled 测试
t('5. computeWorkersEnabled 优先级、去重、未知过滤与旧行为测试', () => {
  assert.equal(computeWorkersEnabled({ workers_enabled: '', agy_enabled: true, claude_enabled: true }), undefined)
  assert.deepEqual(computeWorkersEnabled({ workers_enabled: 'codex, gemini ,codex' }), ['codex', 'gemini'])

  const res = computeWorkersEnabled({ workers_enabled: 'codex,nosuchworker' })
  assert.deepEqual(res, ['codex'])
  assert.ok(computeWorkersEnabled.unknownWorkers.includes('nosuchworker'))

  assert.deepEqual(computeWorkersEnabled({ agy_enabled: false, claude_enabled: true }), ['claude'])
  assert.deepEqual(computeWorkersEnabled({ agy_enabled: true, claude_enabled: false }), ['agy'])
  assert.equal(computeWorkersEnabled({ agy_enabled: true, claude_enabled: true }), undefined)
})

// 6. classify 铁律测试
t('6. createWorkerFromSpec 的 classify 铁律：有产物即完成，取消即 aborted', () => {
  const codexSpec = WORKER_SPECS.find(s => s.name === 'codex')
  assert.ok(codexSpec)
  const worker = createWorkerFromSpec(codexSpec)

  const completedRes = worker.classify({
    artifacts: ['x'],
    exitCode: 1,
    raw: '',
  })
  assert.equal(completedRes.stopReason, 'completed')

  const abortedRes = worker.classify({
    cancelled: true,
    exitCode: 0,
    raw: '',
  })
  assert.equal(abortedRes.stopReason, 'aborted')

  const authGenericRes = worker.classify({
    exitCode: 1,
    raw: 'Failed to authenticate. API Error: 403 该令牌无权访问模型 codex',
  })
  assert.equal(authGenericRes.stopReason, 'error')
  assert.match(authGenericRes.diagnostic, /403/)
  assert.match(authGenericRes.diagnostic, /authenticate/)
})

// 7. workerPathOf 测试
t('7. workerPathOf("codex", {codexPath: "X"}) === "X", workerPathOf("nosuch", {}) === undefined', () => {
  assert.equal(workerPathOf('codex', { codexPath: 'X' }), 'X')
  assert.equal(workerPathOf('nosuch', {}), undefined)
})

// 8. name 与 bin 差异映射测试
t('8. name 与 bin 差异映射以规格表为准，config 键与环境变量按 name 派生', () => {
  const cursorSpec = WORKER_SPECS.find(s => s.name === 'cursor')
  const continueSpec = WORKER_SPECS.find(s => s.name === 'continue')
  const traeSpec = WORKER_SPECS.find(s => s.name === 'trae')
  const comateSpec = WORKER_SPECS.find(s => s.name === 'comate')
  const sparkSpec = WORKER_SPECS.find(s => s.name === 'spark')

  assert.equal(cursorSpec?.bin, 'agent')
  assert.equal(continueSpec?.bin, 'cn')
  assert.equal(traeSpec?.bin, 'trae-cli')
  assert.equal(comateSpec?.bin, 'comatecli')
  assert.equal(sparkSpec?.bin, 'aispark')

  assert.equal(WORKER_PATH_KEYS.cursor, 'cursorPath')
  assert.equal(WORKER_PATH_KEYS.continue, 'continuePath')
  assert.equal(WORKER_PATH_KEYS.trae, 'traePath')
  assert.equal(WORKER_PATH_KEYS.comate, 'comatePath')
  assert.equal(WORKER_PATH_KEYS.spark, 'sparkPath')
})

// 9. binAliases 别名配置与 PATH 回退解析测试
t('9. binAliases 别名正确配置，且在 bin 不在 PATH 时自动回退到 alias', () => {
  const cursorSpec = WORKER_SPECS.find(s => s.name === 'cursor')
  const codebuddySpec = WORKER_SPECS.find(s => s.name === 'codebuddy')
  const codebuffSpec = WORKER_SPECS.find(s => s.name === 'codebuff')

  assert.deepEqual(cursorSpec?.binAliases, ['cursor-agent'])
  assert.deepEqual(codebuddySpec?.binAliases, ['cbc'])
  assert.deepEqual(codebuffSpec?.binAliases, ['cb'])

  // 模拟 PATH 中没有 agent 但有 cursor-agent
  const cursorWorker = createWorkerFromSpec(cursorSpec)
  const mockFind = (cmd) => (cmd === 'cursor-agent' ? '/usr/local/bin/cursor-agent' : undefined)
  const available = isWorkerAvailable('cursor', {}, { find: mockFind })
  assert.equal(available, true, '当 bin 不在 PATH 但 alias 在 PATH 时，isWorkerAvailable 应为 true')
})

// 10. unknown 契约与 fail-closed 检查
t('10. unknown 规格恰好为 iflow 与 codebuff，全部 preflight fail-closed', () => {
  const unknownSpecs = WORKER_SPECS.filter(s => s.contract === 'unknown')
  assert.equal(unknownSpecs.length, 2, 'contract=unknown 必须恰好 2 个')
  assert.deepEqual(unknownSpecs.map(s => s.name).sort(), ['codebuff', 'iflow'])

  for (const spec of unknownSpecs) {
    const worker = createWorkerFromSpec(spec)
    const probe = worker.preflight({})
    assert.equal(probe.ok, false)
    assert.ok(/未核实/.test(probe.reason))
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

