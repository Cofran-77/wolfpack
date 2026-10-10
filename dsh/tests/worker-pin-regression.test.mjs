import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from './core/config.mjs'
import { RunsLedger } from './core/ledger.mjs'
import { resolveWorkerSelection } from './core/worker/index.mjs'
import { registerWolfDelegate, runConfig } from './index.js'

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

console.log('\n2026-10-10 工人启用集合接线回归测试 (worker-pin)')

const testDir = join(tmpdir(), `wp-worker-pin-test-${Date.now()}`)
mkdirSync(testDir, { recursive: true })

const anyExe = process.execPath
const now = Date.now()
const benchedAgyHealth = {
  version: 1,
  updatedAt: now,
  workers: {
    agy: {
      consecutiveFailures: 2,
      totalFailures: 2,
      lastFailureAt: now,
      lastReason: 'no-output',
      lastStopReason: 'error',
      lastOutcome: 'failure',
      benchedUntil: now + 3600000,
      benchReason: 'no-output',
    },
  },
}

try {
  // 链路 1：CLI / loadConfig 链路：配置文件有 agy_enabled=true, claude_enabled=false
  // 必须直接由 loadConfig 将其折算为 workersEnabled = ['agy']，并在 resolveWorkerSelection 时杜绝 claude
  t('R-1: loadConfig 必须将配置文件中的 claude_enabled=false 翻译为 workersEnabled 启用集合', () => {
    const cfgFile = join(testDir, 'config-only-agy.json')
    writeFileSync(cfgFile, JSON.stringify({
      agy_enabled: true,
      claude_enabled: false,
      agyPath: anyExe,
      claudePath: anyExe,
    }), 'utf8')

    const loaded = loadConfig({}, testDir, {
      WOLFPACK_CONFIG_FILE: cfgFile,
      WOLFPACK_WORKERS_ENABLED: undefined,
    })

    assert.ok(loaded.workersEnabled !== undefined, 'loadConfig 返回的配置中必须存在 workersEnabled 字段')
    assert.deepEqual(loaded.workersEnabled, ['agy'], '配置 claude_enabled=false 时 workersEnabled 必须仅为 [agy]')

    // 不传显式 workersEnabled，直接把 loaded 传入真实挑选策略；
    // 即使 agy 已冷却，也必须硬试最早恢复的 agy（all-benched(agy)），绝不能越界派给被禁用的 claude！
    const selection = resolveWorkerSelection({
      config: loaded,
      health: benchedAgyHealth,
    })
    assert.equal(selection.name, 'agy', `在 claude_enabled=false 时绝不能挑选 claude（实际挑选: ${selection.name}）`)
    assert.match(selection.reason, /all-benched\(agy\)/)
  })

  // 链路 2：对照组：配置文件 claude_enabled=true 时必须能合法选中 claude
  t('R-2: loadConfig 对照：claude_enabled=true 且 agy 冷却时，必须正常委派给 claude', () => {
    const cfgFile = join(testDir, 'config-both.json')
    writeFileSync(cfgFile, JSON.stringify({
      agy_enabled: true,
      claude_enabled: true,
      agyPath: anyExe,
      claudePath: anyExe,
    }), 'utf8')

    const loaded = loadConfig({}, testDir, {
      WOLFPACK_CONFIG_FILE: cfgFile,
      WOLFPACK_WORKERS_ENABLED: undefined,
    })

    const selection = resolveWorkerSelection({
      config: loaded,
      health: benchedAgyHealth,
    })
    assert.equal(selection.name, 'claude', `在 claude_enabled=true 且 agy 冷却时应挑选 claude（实际挑选: ${selection.name}）`)
    assert.equal(selection.reason, 'only-available')
  })

  // 链路 3：宿主工具路径：registerWolfDelegate 接收原始 config 对象
  // runDelegateTask 必须获得计算好的 workersEnabled，不能只在回执能看见
  await ta('R-3: 宿主 wolf_delegate execute 必须向派活内核传递包含 workersEnabled 的配置', async () => {
    const ledgerPath = join(testDir, 'host-test-runs.ndjson')
    const ledger = new RunsLedger(ledgerPath)
    const healthPath = join(testDir, 'host-health.json')
    writeFileSync(healthPath, JSON.stringify(benchedAgyHealth), 'utf8')

    // 模拟 DSH 宿主环境传递的原始 config（带有 volatile/裸值，且无 workersEnabled 字段）
    const rawHostConfig = {
      agy_enabled: true,
      claude_enabled: false,
      agyPath: anyExe,
      claudePath: anyExe,
      ledger,
      ledgerPath,
      workerHealth: {
        enabled: true,
        filePath: healthPath,
      },
    }

    // 运行 runConfig，验证其是否将 workersEnabled 写回原始 config 或在工具中正确传递
    runConfig({}, rawHostConfig)
    assert.deepEqual(rawHostConfig.workersEnabled, ['agy'], 'runConfig 必须将计算好的 workersEnabled 写回 config 对象')

    let registeredTool = null
    let spawnedArgv = null
    const fakeCtx = {
      get(svc) {
        if (svc === 'tools') {
          return {
            register(toolDef) {
              registeredTool = toolDef
              return () => {}
            },
          }
        }
        if (svc === 'subprocess') {
          return {
            spawn({ argv }) {
              spawnedArgv = argv
              return {
                done: Promise.resolve({ exitCode: 0, signal: null }),
                collected: {
                  stdout: { readFrom: () => ({ text: JSON.stringify({ status: 'completed' }), nextOffset: 0, lossy: false }) },
                  stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
                },
                terminate: () => Promise.resolve(),
                waitForExit: () => Promise.resolve(),
              }
            },
          }
        }
        return undefined
      },
    }

    registerWolfDelegate(fakeCtx, rawHostConfig)
    assert.ok(registeredTool, 'wolf_delegate 必须成功注册')

    const exec = {
      agent: { session: { header: { cwd: testDir } } },
      signal: new AbortController().signal,
    }

    const res = await registeredTool.execute({
      task_id: 'host-worker-pin-task',
      task: 'verify worker pin in host path',
    }, exec)

    assert.equal(res.worker, 'agy', `宿主工具派活必须严格遵守工人启用集合，预期 agy，实际分派: ${res.worker}`)
  })
} finally {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {}
}

if (fail > 0) {
  process.exit(1)
}
