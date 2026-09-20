import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { takeArtifactSnapshot } from '../src/delegate.mjs'
import { foldEntries } from '../src/ledger.mjs'
import { runVerify } from '../src/verify.mjs'
import {
  LIVE_ROUTE_PATH,
  MAX_PAYLOAD_BYTES,
  PANEL_ROUTE_PATH,
  buildLivePayload,
  createLiveServer,
  enforcePayloadBounds,
  mergeLiveRecords,
  registerLiveRoute,
  renderLiveSummary,
} from '../src/live-route.mjs'
import { writeLiveRecord } from '../src/live.mjs'
import {
  clearTranscriptCache,
  readTranscriptTail,
  summarizeTranscriptText,
} from '../src/live-transcript.mjs'
import { adaptHandle, createDshRuntime } from '../src/runtime/dsh.mjs'
import { NodeRuntime, createNodeStallNotifier } from '../src/runtime/node.mjs'
import {
  getDefaultRuntime,
  resetDefaultRuntime,
  resolveRuntime,
  setDefaultRuntime,
} from '../src/runtime/registry.mjs'
import {
  STALL_WORKERS,
  claudeProjectSlug,
  createStallMonitor,
  formatStallSummary,
  resolveStallConfig,
  resolveStallConfigs,
  sampleProgress,
  stallDecision,
} from '../src/stall.mjs'
import { cleanTempDir, createTempDir, projectRoot } from './test-helper.mjs'

/**
 * 记录被访问过哪些路径的假 fs：两个工人的采样路径必须各走各的，不许串。
 *
 * @param {Record<string, number>} writes - 路径 → mtime（未列出的路径一律 ENOENT）
 * @returns {{seen: string[], stat: Function, readdir: Function}}
 */
function recordingFs(writes = {}) {
  const seen = []
  const shape = (path, mtimeMs, isDirectory = false) => ({
    mtimeMs,
    isDirectory: () => isDirectory,
    isFile: () => !isDirectory,
  })
  return {
    seen,
    async stat(path) {
      seen.push(path)
      if (path in writes) return shape(path, writes[path])
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    async readdir(path) {
      seen.push(`${path}/`)
      const prefix = `${path}/`
      return Object.keys(writes)
        .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(key => key.slice(prefix.length))
    },
  }
}

/** 两个工人各自一条真实形态的流水样本。 */
const CLAUDE_LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-20T01:00:00.000Z',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '先把失败用例读一遍' }],
  },
})
const AGY_LINE = JSON.stringify({
  step_index: 3,
  type: 'PLANNER_RESPONSE',
  tool_calls: [{ name: 'run_command' }],
  thinking: '跑一遍测试看看',
})

/**
 * 真起一个 MCP 进程调一次工具（端到端验证入口接线，不 mock 任何东西）。
 *
 * @param {string} toolName
 * @param {object} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{data: object, proc: object}>}
 */
function callMcpTool(toolName, args, env = {}) {
  const proc = spawn(process.execPath, [join(projectRoot, 'bin', 'wolf-mcp.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    windowsHide: true,
  })

  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`MCP 工具 ${toolName} 响应超时`))
    }, 15_000)

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => {
      buffer += chunk
      while (true) {
        const idx = buffer.indexOf('\n')
        if (idx === -1) break
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id !== 3) continue
        clearTimeout(timer)
        resolve({ data: msg, proc })
      }
    })
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })

    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n')
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: args } }) + '\n')
  })
}

export const tests = [
  /* ── 停滞监控（两个工人各一套）────────────────────────────────── */
  {
    name: 'stall-decision-windows',
    async run() {
      const windowMs = 5 * 60 * 1000
      const base = { windowMs, maxWarnings: 3 }

      assert.equal(stallDecision({ ...base, silentMs: windowMs - 1, warningsSent: 0 }).warn, false)

      const first = stallDecision({ ...base, silentMs: windowMs, warningsSent: 0 })
      assert.deepEqual([first.warn, first.level, first.exhausted], [true, 1, false])

      // 同一窗口内不重复报
      assert.equal(stallDecision({ ...base, silentMs: 6 * 60 * 1000, warningsSent: 1 }).warn, false)

      const second = stallDecision({ ...base, silentMs: 10 * 60 * 1000, warningsSent: 1 })
      assert.deepEqual([second.warn, second.level], [true, 2])

      const third = stallDecision({ ...base, silentMs: 15 * 60 * 1000, warningsSent: 2 })
      assert.deepEqual([third.warn, third.level], [true, 3])

      // 三档之后彻底闭嘴，并且明确是「报警次数用尽」而不是「还没到点」
      const done = stallDecision({ ...base, silentMs: 60 * 60 * 1000, warningsSent: 3 })
      assert.deepEqual([done.warn, done.level, done.exhausted], [false, 3, true])

      // 关掉监控（窗口 0）时永远不报警
      assert.equal(stallDecision({ windowMs: 0, maxWarnings: 3, silentMs: 1e9, warningsSent: 0 }).warn, false)
    },
  },
  {
    name: 'stall-sample-is-per-worker',
    async run() {
      const agyRoot = '/tmp/wolf-fake-agy-root'
      const claudeRoot = '/tmp/wolf-fake-claude-root'
      const cwd = '/Users/someone/dev/app'

      const agyFs = recordingFs({
        [`${agyRoot}/conversations/conv-1.db`]: 1000,
        [`${agyRoot}/brain/conv-1/.system_generated/logs/transcript_full.jsonl`]: 2000,
      })
      const agy = await sampleProgress({ worker: 'agy', storeRoot: agyRoot, sessionId: 'conv-1', cwd, fs: agyFs })
      assert.equal(agy.available, true)
      assert.equal(agy.mtimeMs, 2000)
      assert(agyFs.seen.every(p => p.startsWith(agyRoot)), 'agy 采样只能碰 agy 自己的存储根')
      assert(agyFs.seen.some(p => p.includes('brain')))

      const slug = claudeProjectSlug(cwd)
      assert.equal(slug, '-Users-someone-dev-app', 'Claude Code CLI 的项目目录名规则')

      const claudeFs = recordingFs({ [`${claudeRoot}/${slug}/sess-9.jsonl`]: 3000 })
      const claude = await sampleProgress({ worker: 'claude', storeRoot: claudeRoot, sessionId: 'sess-9', cwd, fs: claudeFs })
      assert.equal(claude.available, true)
      assert.equal(claude.mtimeMs, 3000)
      assert(
        claudeFs.seen.every(p => p.startsWith(claudeRoot)),
        'claude 采样只能碰 ~/.claude/projects 这一侧（Claude Code CLI，不是 Claude Desktop）',
      )
      assert(claudeFs.seen.some(p => p.includes(slug)))

      // 两个工人绝不串用彼此的存储根
      assert(!agyFs.seen.some(p => p.startsWith(claudeRoot)))
      assert(!claudeFs.seen.some(p => p.startsWith(agyRoot)))

      // 存储根缺失时如实回报「不可用」，不假装有数据
      const missing = await sampleProgress({ worker: 'agy', storeRoot: undefined, sessionId: 'x', cwd })
      assert.equal(missing.available, false)
    },
  },
  {
    name: 'stall-monitor-warn-only',
    async run() {
      const windowMs = 1000
      const fakeFs = {
        async stat() {
          return { mtimeMs: 500, isDirectory: () => false, isFile: () => true }
        },
        async readdir() {
          return []
        },
      }

      let clock = 10_000
      const warnings = []
      const samples = []
      const errors = []
      const monitor = createStallMonitor({
        worker: 'claude',
        storeRoot: '/tmp/wolf-fake-claude-root',
        sessionId: 'sess-1',
        cwd: '/Users/me/app',
        windowMs,
        maxWarnings: 3,
        pollMs: 60_000,
        now: () => clock,
        fs: fakeFs,
        onWarning: w => warnings.push(w),
        onSample: s => samples.push(s),
        onError: m => errors.push(m),
      })

      // 停滞监控**只报警，永不终止**：对象上不存在任何终止/杀进程入口
      assert.equal(typeof monitor.kill, 'undefined')
      assert.equal(typeof monitor.terminate, 'undefined')
      assert.equal(typeof monitor.abort, 'undefined')
      assert.deepEqual(Object.keys(monitor).sort(), ['poll', 'snapshot', 'start', 'stop', 'worker'])

      await monitor.poll()
      assert.equal(warnings.length, 0, '刚有进展时不得报警')
      assert.equal(monitor.snapshot().heartbeats, 1)

      for (const at of [11_000, 12_000, 13_000, 20_000]) {
        clock = at
        await monitor.poll()
      }
      assert.equal(warnings.length, 3, '窗口 1×/2×/3× 各报一次，之后闭嘴')
      assert.deepEqual(warnings.map(w => w.level), [1, 2, 3])
      assert(warnings.every(w => w.worker === 'claude'), '报警必须带工人名')
      assert.equal(monitor.snapshot().exhausted, true)
      assert.equal(errors.length, 0)
      assert(samples.length >= 4, '每次采样都要回吐快照（面板靠它跨进程展示）')
      assert.equal(samples.at(-1).worker, 'claude')

      // 会话重新开始写：采样恢复可用、报警计数归零
      const revived = createStallMonitor({
        worker: 'agy',
        storeRoot: '/tmp/wolf-fake-agy-root',
        sessionId: 'conv-1',
        cwd: '/Users/me/app',
        windowMs,
        now: () => 30_000,
        fs: {
          async stat() {
            return { mtimeMs: 30_000, isDirectory: () => false, isFile: () => true }
          },
          async readdir() {
            return []
          },
        },
      })
      await revived.poll()
      assert.equal(revived.snapshot().warnings, 0)
      assert.equal(revived.snapshot().unavailable, false)
      assert.equal(revived.snapshot().worker, 'agy')
    },
  },
  {
    name: 'stall-summary-and-configs-per-worker',
    async run() {
      const summary = formatStallSummary({
        worker: 'agy',
        enabled: true,
        window_ms: 300_000,
        max_warnings: 3,
        heartbeats: 4,
        silent_ms: 0,
        warnings: 0,
      })
      assert.match(summary, /agy/)
      assert.match(summary, /窗口 5 分钟/)

      // 两个工人的窗口/存储根各自独立（env 分工人覆盖）
      const configs = resolveStallConfigs({
        env: {
          WOLFPACK_STALL_WINDOW_AGY: '120',
          WOLFPACK_STALL_WINDOW_CLAUDE: '540',
          WOLFPACK_CLAUDE_STORE_ROOT: '/tmp/claude-root',
          WOLFPACK_AGY_STORE_ROOT: '/tmp/agy-root',
        },
      })
      assert.deepEqual(STALL_WORKERS, ['agy', 'claude'])
      // 单位是秒：2 分钟 / 9 分钟
      assert.equal(configs.agy.windowMs, 2 * 60 * 1000)
      assert.equal(configs.claude.windowMs, 9 * 60 * 1000)
      assert.equal(configs.agy.storeRoot, '/tmp/agy-root')
      assert.equal(configs.claude.storeRoot, '/tmp/claude-root')
      assert.notEqual(configs.agy.storeRoot, configs.claude.storeRoot)

      const single = resolveStallConfig('claude', { env: { WOLFPACK_STALL_WINDOW_CLAUDE: '0' } })
      assert.equal(single.windowMs, 0, '窗口设 0 = 关掉该工人的监控')

      // 配置文件里的分工人设置：环境变量优先，其次配置文件，最后默认值
      const fromFile = resolveStallConfigs({
        env: {},
        config: {
          stall: {
            windowSeconds: 120,
            windowSecondsByWorker: { claude: 540 },
            warningsByWorker: { agy: 1 },
            pollSeconds: 15,
            storeRoots: { agy: '/tmp/agy-file', claude: '/tmp/claude-file' },
          },
        },
      })
      assert.equal(fromFile.agy.windowMs, 120_000)
      assert.equal(fromFile.claude.windowMs, 540_000)
      assert.equal(fromFile.agy.maxWarnings, 1)
      assert.equal(fromFile.claude.maxWarnings, 3)
      assert.equal(fromFile.claude.pollMs, 15_000)
      assert.equal(fromFile.agy.storeRoot, '/tmp/agy-file')
      assert.equal(fromFile.claude.storeRoot, '/tmp/claude-file')

      const envWins = resolveStallConfig('agy', {
        env: { WOLFPACK_STALL_WINDOW_AGY: '60' },
        config: { stall: { windowSeconds: 120 } },
      })
      assert.equal(envWins.windowMs, 60_000, '环境变量优先于配置文件')
    },
  },
  {
    name: 'stall-fields-fold-into-ledger',
    async run() {
      const states = foldEntries([
        { taskId: 't1', worker: 'claude', stallWarnings: 2, stallSilentMs: 600_000, stallHeartbeats: 7, stallAvailable: true },
      ])
      const state = states.get('t1')
      assert.equal(state.stallWarnings, 2)
      assert.equal(state.stallSilentMs, 600_000)
      assert.equal(state.stallHeartbeats, 7)
      assert.equal(state.stallAvailable, true)
    },
  },

  /* ── 实时路由 + 面板（两个工人分开展示）──────────────────────── */
  {
    name: 'live-payload-partitions-workers',
    async run() {
      const ledgerStub = {
        async read() {
          return new Map([
            ['agy-idle', { taskId: 'agy-idle', worker: 'agy', round: 1, lastAt: 100, lastVerdict: 'pass', totalTokens: 10, changedFiles: [] }],
            ['claude-idle', { taskId: 'claude-idle', worker: 'claude', round: 2, lastAt: 200, lastVerdict: 'fail', totalTokens: 20, changedFiles: [] }],
          ])
        },
      }
      const handles = new Map([
        ['agy-run', {
          taskId: 'agy-run',
          worker: 'agy',
          round: 1,
          workerReason: 'rotation',
          cwd: '/tmp/agy-cwd',
          stallMonitor: { snapshot: () => ({ worker: 'agy', enabled: true, warnings: 0, heartbeats: 2 }) },
        }],
        ['claude-run', {
          taskId: 'claude-run',
          worker: 'claude',
          round: 3,
          continuing: true,
          workerReason: 'continuation',
          cwd: '/tmp/claude-cwd',
          stallMonitor: { snapshot: () => ({ worker: 'claude', enabled: true, warnings: 1, heartbeats: 5 }) },
        }],
      ])

      const payload = await buildLivePayload({
        ledger: ledgerStub,
        activeRuns: [],
        liveHandles: handles,
        stallConfigs: {
          agy: { storeRoot: '/tmp/agy-root', windowMs: 60_000 },
          claude: { storeRoot: '/tmp/claude-root', windowMs: 120_000 },
        },
      })

      assert.deepEqual(Object.keys(payload.workers).sort(), ['agy', 'claude'])
      assert.deepEqual(payload.workers.agy.running.map(r => r.task_id), ['agy-run'])
      assert.deepEqual(payload.workers.claude.running.map(r => r.task_id), ['claude-run'])
      assert.deepEqual(payload.workers.agy.idle.map(r => r.task_id), ['agy-idle'])
      assert.deepEqual(payload.workers.claude.idle.map(r => r.task_id), ['claude-idle'])

      // 停滞状态按工人分区，绝不互相串
      assert.equal(payload.workers.agy.stall.worker, 'agy')
      assert.equal(payload.workers.claude.stall.worker, 'claude')
      assert.equal(payload.workers.claude.stall.warnings, 1)

      // 存储根与窗口也是逐工人暴露的
      assert.equal(payload.workers.agy.store_root, '/tmp/agy-root')
      assert.equal(payload.workers.claude.store_root, '/tmp/claude-root')
      assert.equal(payload.workers.agy.stall_window_ms, 60_000)
      assert.equal(payload.workers.claude.stall_window_ms, 120_000)

      // token 累计也分工人
      assert.equal(payload.workers.agy.tokens.total, 10)
      assert.equal(payload.workers.claude.tokens.total, 20)

      const text = renderLiveSummary(payload)
      assert.match(text, /Antigravity CLI/)
      assert.match(text, /Claude Code CLI/)
      assert.match(text, /claude-run/)
      assert.match(text, /agy-run/)
    },
  },
  {
    name: 'live-payload-round-robin-keeps-both-workers',
    async run() {
      const handles = new Map()
      for (let i = 0; i < 6; i++) {
        handles.set(`agy-${i}`, { taskId: `agy-${i}`, worker: 'agy', round: 1 })
      }
      handles.set('claude-only', { taskId: 'claude-only', worker: 'claude', round: 1 })

      const payload = await buildLivePayload({
        ledger: { async read() { return new Map() } },
        activeRuns: [],
        liveHandles: handles,
        stallConfigs: {},
        maxRuns: 4,
      })

      assert.equal(payload.runs.length, 4)
      assert(payload.runs.some(r => r.worker === 'claude'), '有界响应里 claude 不能被 agy 挤掉')
    },
  },
  {
    name: 'live-payload-bounded-32kb',
    async run() {
      const big = 'x'.repeat(4000)
      const handles = new Map()
      for (let i = 0; i < 8; i++) {
        const worker = i % 2 === 0 ? 'agy' : 'claude'
        handles.set(`t${i}`, {
          taskId: `t${i}`,
          worker,
          round: 1,
          stallMonitor: { snapshot: () => ({ worker, enabled: true, note: big }) },
        })
      }

      const payload = await buildLivePayload({
        ledger: { async read() { return new Map() } },
        activeRuns: [],
        liveHandles: handles,
        stallConfigs: {},
      })
      const json = enforcePayloadBounds(payload)
      assert(Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES, '有界路由绝不能超过 32KB')
      assert.doesNotThrow(() => JSON.parse(json))
    },
  },
  {
    name: 'live-server-end-to-end',
    async run() {
      const tempDir = createTempDir('live-server-')
      const rawDir = join(tempDir, 'raw')
      const ledgerStub = { async read() { return new Map() } }
      let server
      let secured
      try {
        server = await createLiveServer({
          config: { ledger: ledgerStub, activeRuns: [], liveHandles: new Map(), stallConfigs: {}, rawDir },
          port: 0,
        })
        const base = `http://127.0.0.1:${server.port}`

        const health = await fetch(`${base}/wolfpack/health`)
        assert.equal(health.status, 200)
        assert.equal((await health.json()).ok, true)

        const live = await fetch(`${base}${LIVE_ROUTE_PATH}`)
        assert.equal(live.status, 200)
        const payload = await live.json()
        assert.deepEqual(Object.keys(payload.workers).sort(), ['agy', 'claude'])
        assert.equal(payload.workers.claude.label, 'Claude Code CLI（claude）')
        assert.equal(payload.workers.agy.label, 'Antigravity CLI（agy）')

        const panel = await fetch(`${base}${PANEL_ROUTE_PATH}`)
        assert.equal(panel.status, 200)
        const html = await panel.text()
        assert.match(html, /<title>/)
        assert.match(html, /wolfpack\/live/, '面板必须去拉只读实时路由')
        assert.match(html, /renderWorker/, '面板必须按工人分区渲染')
        assert.match(html, /id="workers"/, '面板必须有工人分区容器')

        assert.equal((await fetch(`${base}/nope`)).status, 404)

        // 令牌：没带口令 401，带了 200；两种携带方式都认
        secured = await createLiveServer({
          config: { ledger: ledgerStub, activeRuns: [], liveHandles: new Map(), stallConfigs: {}, rawDir },
          port: 0,
          token: 's3cret',
        })
        const securedBase = `http://127.0.0.1:${secured.port}`
        assert.equal((await fetch(`${securedBase}${LIVE_ROUTE_PATH}`)).status, 401)
        assert.equal((await fetch(`${securedBase}${LIVE_ROUTE_PATH}?token=s3cret`)).status, 200)
        assert.equal(
          (await fetch(`${securedBase}${LIVE_ROUTE_PATH}`, { headers: { 'x-wolfpack-token': 's3cret' } })).status,
          200,
        )
        assert.match(secured.url, /token=s3cret/)
      } finally {
        await server?.close()
        await secured?.close()
        clearTranscriptCache()
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'live-merge-disk-records',
    async run() {
      const tempDir = createTempDir('live-merge-')
      const rawDir = join(tempDir, 'raw')
      try {
        const empty = await mergeLiveRecords(rawDir, new Map())
        assert.equal(empty.size, 0, '没有任何登记时必须返回空表而不是报错')

        const withLocal = await mergeLiveRecords(rawDir, new Map([
          ['local-task', { taskId: 'local-task', worker: 'agy', stallMonitor: { snapshot: () => ({ worker: 'agy' }) } }],
        ]))
        assert.equal(withLocal.size, 1)
        assert.equal(withLocal.get('local-task').worker, 'agy')

        // 别的进程派发的任务：登记文件必须能还原出 cwd 与该工人自己的停滞快照
        await writeLiveRecord(rawDir, 'remote-task', {
          taskId: 'remote-task',
          runId: 'r-1',
          worker: 'claude',
          workerReason: 'rotation',
          cwd: '/tmp/remote-cwd',
          pid: process.pid,
          round: 2,
          continuing: true,
          conversationId: 'sess-remote',
          stall: { worker: 'claude', enabled: true, warnings: 1, heartbeats: 3 },
        })

        const merged = await mergeLiveRecords(rawDir, new Map())
        const remote = merged.get('remote-task')
        assert.equal(remote.worker, 'claude')
        assert.equal(remote.cwd, '/tmp/remote-cwd', '面板是另一个进程，cwd 必须从登记文件还原')
        assert.equal(remote.conversationId, 'sess-remote')
        assert.equal(remote.continuing, true)
        assert.equal(remote.stallMonitor.snapshot().warnings, 1)

        // 进程已死的登记必须被清掉，不冒充「正在运行」
        await writeLiveRecord(rawDir, 'dead-task', {
          taskId: 'dead-task',
          worker: 'agy',
          pid: 999_999_999,
          round: 1,
        })
        const after = await mergeLiveRecords(rawDir, new Map())
        assert.equal(after.has('dead-task'), false)
      } finally {
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'live-payload-reads-transcript-with-camelcase-config',
    async run() {
      const tempDir = createTempDir('live-transcript-')
      const storeRoot = join(tempDir, 'projects')
      const cwd = join(tempDir, 'cwd')
      const sessionId = 'sess-camel'
      try {
        // 目录必须先存在：项目目录名是按 realpath 算出来的
        mkdirSync(cwd, { recursive: true })
        const projectDir = join(storeRoot, claudeProjectSlug(cwd))
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${CLAUDE_LINE}\n`, 'utf8')

        const payload = await buildLivePayload({
          ledger: { async read() { return new Map() } },
          activeRuns: [],
          liveHandles: new Map([
            ['camel', { taskId: 'camel', worker: 'claude', round: 1, cwd, conversationId: sessionId }],
          ]),
          // 配置一直是 camelCase（resolveStallConfigs 的输出），路由必须读懂
          stallConfigs: { agy: { storeRoot: '/tmp/agy', windowMs: 1000 }, claude: { storeRoot, windowMs: 1000 } },
        })

        const run = payload.runs.find(r => r.task_id === 'camel')
        assert.equal(run.transcript.available, true, 'claude 的流水必须能按 camelCase 存储根读到')
        assert.match(run.transcript.events.at(-1).text, /先把失败用例读一遍/)
        assert.equal(run.step_total, 1)
        assert.equal(payload.workers.claude.store_root, storeRoot)
      } finally {
        clearTranscriptCache()
        cleanTempDir(tempDir)
      }
    },
  },

  /* ── 会话流水（两份独立解析）────────────────────────────────── */
  {
    name: 'live-transcript-parses-both-workers',
    async run() {
      const claude = summarizeTranscriptText('claude', `${CLAUDE_LINE}\n`)
      assert.equal(claude.available, true)
      assert.equal(claude.step_total, 1)
      assert.match(claude.events.at(-1).text, /先把失败用例读一遍/)

      const agy = summarizeTranscriptText('agy', `${AGY_LINE}\n`)
      assert.equal(agy.available, true)
      assert.equal(agy.step_index, 3, 'agy 的 step_index 取自分片自己的字段')
      assert.match(agy.events.at(-1).text, /run_command/)

      // 同一行文本喂给两个工人，得到的摘要必须各按各的格式解析（不许串）
      assert.notEqual(
        summarizeTranscriptText('claude', `${AGY_LINE}\n`).events.at(-1)?.text,
        summarizeTranscriptText('agy', `${AGY_LINE}\n`).events.at(-1)?.text,
      )

      // 半截行（正在写）必须被跳过而不是炸掉
      const partial = summarizeTranscriptText('claude', `${CLAUDE_LINE}\n{"type":"assis`)
      assert.equal(partial.available, true)
      assert.equal(partial.step_total, 1)

      const empty = summarizeTranscriptText('claude', '')
      assert.equal(empty.available, false)
      assert.deepEqual(empty.events, [])
    },
  },
  {
    name: 'live-transcript-tail-read',
    async run() {
      const tempDir = createTempDir('transcript-tail-')
      const file = join(tempDir, 'sess.jsonl')
      try {
        writeFileSync(file, `${CLAUDE_LINE}\n${CLAUDE_LINE}\n`, 'utf8')
        const fresh = await readTranscriptTail('claude', file)
        assert.equal(fresh.available, true)
        assert.equal(fresh.events.length, 2)

        // 缓存读到的内容与新鲜读一致，且不共享可变对象（enforcePayloadBounds 会就地改写）
        const cached = await readTranscriptTail('claude', file, { cache: true })
        assert.deepEqual(cached.events, fresh.events)
        cached.events[0].text = '被就地改写'
        const again = await readTranscriptTail('claude', file, { cache: true })
        assert.notEqual(again.events[0].text, '被就地改写')

        const missing = await readTranscriptTail('claude', join(tempDir, 'nope.jsonl'))
        assert.equal(missing.available, false)
        assert.equal(missing.events.length, 0)
      } finally {
        clearTranscriptCache()
        cleanTempDir(tempDir)
      }
    },
  },

  /* ── 运行时注入 ─────────────────────────────────────────────── */
  {
    name: 'live-route-host-registration',
    async run() {
      const handlerConfig = {
        ledger: { async read() { return new Map() } },
        activeRuns: [],
        liveHandles: new Map(),
        stallConfigs: {},
      }

      /** 捕获注册的宿主路由，并按需伪造响应对象。 */
      const registrations = []
      const makeCtx = connection => ({
        get: name => {
          if (name === 'webServer') {
            return { register: route => { registrations.push(route); return () => {} } }
          }
          if (name === 'connection') return connection
          return undefined
        },
      })
      const makeRes = () => ({
        statusCode: 200,
        headers: {},
        body: undefined,
        setHeader(k, v) { this.headers[k] = v },
        end(body) { this.body = body },
      })

      const dispose = registerLiveRoute(makeCtx(undefined), handlerConfig)
      assert.equal(registrations.length, 2, '必须注册实时 JSON 与面板两条路由')
      assert.deepEqual(registrations.map(r => r.path).sort(), [LIVE_ROUTE_PATH, PANEL_ROUTE_PATH].sort())
      const liveRoute = registrations.find(r => r.path === LIVE_ROUTE_PATH)
      const panelRoute = registrations.find(r => r.path === PANEL_ROUTE_PATH)

      // 拿不到 connection 服务时 fail closed，绝不把状态裸奔出去
      const res503 = makeRes()
      await liveRoute.handler({ method: 'GET', url: LIVE_ROUTE_PATH }, res503)
      assert.equal(res503.statusCode, 503)

      // 宿主拒绝这次请求 → 用宿主的拒绝码
      registrations.length = 0
      const disposeDenied = registerLiveRoute(makeCtx({ requestRejection: () => 403 }), handlerConfig)
      const deniedRoute = registrations.find(r => r.path === LIVE_ROUTE_PATH)
      const res403 = makeRes()
      await deniedRoute.handler({ method: 'GET', url: LIVE_ROUTE_PATH }, res403)
      assert.equal(res403.statusCode, 403)
      disposeDenied()

      // 换一个带 connection 的宿主：允许时返回两个工人分区的 JSON
      registrations.length = 0
      const disposeAllowed = registerLiveRoute(makeCtx({ requestRejection: () => undefined }), handlerConfig)
      const allowedRoute = registrations.find(r => r.path === LIVE_ROUTE_PATH)
      const res200 = makeRes()
      await allowedRoute.handler({ method: 'GET', url: LIVE_ROUTE_PATH }, res200)
      assert.equal(res200.statusCode, 200)
      const payload = JSON.parse(res200.body)
      assert.deepEqual(Object.keys(payload.workers).sort(), ['agy', 'claude'])

      // 非 GET 一律 405
      const res405 = makeRes()
      await allowedRoute.handler({ method: 'POST', url: LIVE_ROUTE_PATH }, res405)
      assert.equal(res405.statusCode, 405)

      // 面板路由永远返回 HTML（不需要 connection）
      const resPanel = makeRes()
      await panelRoute.handler({ method: 'GET', url: PANEL_ROUTE_PATH }, resPanel)
      assert.equal(resPanel.statusCode, 200)
      assert.match(String(resPanel.body), /renderWorker/)

      dispose()
      disposeAllowed()
    },
  },
  {
    name: 'mcp-wolf-live-tool',
    async run() {
      const tempDir = createTempDir('mcp-live-')
      let proc
      try {
        const res = await callMcpTool('wolf_live', {}, {
          WOLFPACK_LEDGER: join(tempDir, 'runs.ndjson'),
          WOLFPACK_RAW_DIR: join(tempDir, 'raw'),
        })
        proc = res.proc
        const text = res.data.result?.content?.[0]?.text ?? ''
        assert.match(text, /Antigravity CLI/, 'wolf_live 必须给出 agy 分区')
        assert.match(text, /Claude Code CLI/, 'wolf_live 必须给出 claude 分区')
        assert.deepEqual(Object.keys(res.data.result?.raw?.workers ?? {}).sort(), ['agy', 'claude'])

        const live = res.data.result.raw
        assert.equal(live.workers.agy.worker, 'agy')
        assert.equal(live.workers.claude.worker, 'claude')
        assert.notEqual(live.workers.agy.store_root, live.workers.claude.store_root)
      } finally {
        proc?.kill()
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'mcp-wolf-panel-tool',
    async run() {
      const tempDir = createTempDir('mcp-panel-')
      let proc
      try {
        const res = await callMcpTool('wolf_panel', {}, {
          WOLFPACK_LEDGER: join(tempDir, 'runs.ndjson'),
          WOLFPACK_RAW_DIR: join(tempDir, 'raw'),
        })
        proc = res.proc
        const raw = res.data.result?.raw ?? {}
        assert.match(raw.url ?? '', /\/wolfpack\/panel/, 'wolf_panel 必须返回面板地址')
        assert.match(raw.live_url ?? '', /\/wolfpack\/live/)

        const panel = await fetch(raw.url)
        assert.equal(panel.status, 200)
        assert.match(await panel.text(), /renderWorker/)
      } finally {
        proc?.kill()
        cleanTempDir(tempDir)
      }
    },
  },
  {
    name: 'runtime-registry-and-node-runtime',
    async run() {
      // 导入 src/runtime/node.mjs 即注入 Node 运行时
      assert.equal(typeof getDefaultRuntime()?.spawn, 'function')
      assert.equal(resolveRuntime(), getDefaultRuntime())
      assert.equal(typeof new NodeRuntime().spawn, 'function')

      const custom = { spawn: () => {} }
      assert.equal(resolveRuntime(custom), custom, '显式传入的运行时优先')

      resetDefaultRuntime()
      assert.equal(getDefaultRuntime(), undefined)
      assert.equal(resolveRuntime(undefined), undefined, '未注入时如实返回 undefined，绝不偷用别的宿主')

      // 还原，避免污染同进程的其他用例
      setDefaultRuntime(new NodeRuntime())
      assert.equal(typeof getDefaultRuntime()?.spawn, 'function')
    },
  },
  {
    name: 'runtime-injected-into-artifact-snapshot',
    async run() {
      const calls = []
      const runtime = {
        spawn(options) {
          calls.push(options)
          return {
            pid: 4242,
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: { stdout: { text: ' M src/a.mjs\n' }, stderr: { text: '' } },
            terminate: async () => {},
          }
        },
      }
      const snapshot = await takeArtifactSnapshot('/tmp', runtime)
      assert.equal(calls.length, 1, '注入的运行时必须真的被用来派生进程')
      assert.deepEqual(calls[0].argv, ['git', 'status', '--porcelain'])
      assert.equal(snapshot.isGit, true)
      assert.deepEqual([...snapshot.files], ['src/a.mjs'])

      // 验收命令同样必须走注入的运行时（否则 DSH 一类宿主会在验收环节漏出 Node 进程）
      const verifyCalls = []
      const verifyRuntime = {
        spawn(options) {
          verifyCalls.push(options)
          return {
            pid: 5252,
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: { stdout: { text: 'all good\n' }, stderr: { text: '' } },
            terminate: async () => {},
          }
        },
      }
      const checks = await runVerify({
        cwd: '/tmp',
        commands: ['echo ok'],
        shellArgv: ['/bin/sh', '-c'],
        runtime: verifyRuntime,
      })
      assert.equal(verifyCalls.length, 1, '验收命令必须走注入的运行时')
      assert.equal(checks[0].ran, true)
      assert.equal(checks[0].exitCode, 0)
      assert.match(checks[0].tail ?? checks[0].text ?? '', /all good/)
    },
  },
  {
    name: 'runtime-dsh-adapter',
    async run() {
      const handle = {
        pid: 99,
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'hello', nextOffset: 5, lossy: false }) },
          stderr: { readFrom: () => ({ text: 'warn', nextOffset: 4, lossy: true }) },
        },
        terminate: async () => {},
      }
      const adapted = adaptHandle(handle)
      assert.equal(adapted.pid, 99)
      assert.equal(adapted.collected.stdout.text, 'hello')
      assert.equal(adapted.collected.stdout.bytes, 5)
      assert.equal(adapted.collected.stdout.truncated, false)
      assert.equal(adapted.collected.stderr.truncated, true)
      assert.equal((await adapted.done).exitCode, 0)

      const empty = adaptHandle(undefined)
      assert.equal(empty.collected.stdout.text, '')
      assert.equal((await empty.done).exitCode, null)

      const ctx = { subprocess: { spawn: options => ({ ...handle, options }) } }
      const runtime = createDshRuntime(ctx)
      const proc = runtime.spawn({ argv: ['echo', 'hi'], cwd: '/tmp' })
      assert.equal(proc.collected.stdout.text, 'hello')
      assert.equal(typeof runtime.killTree, 'function')
    },
  },
  {
    name: 'runtime-node-stall-notifier-quiet-by-default',
    async run() {
      const spawned = []
      const quiet = createNodeStallNotifier({ toast: false, spawnImpl: (...args) => spawned.push(args) })
      quiet({ warning: { worker: 'agy', level: 1, maxWarnings: 3, silentMs: 600_000 }, taskId: 't1' })
      assert.deepEqual(spawned, [], '默认关桌面通知，绝不打扰')

      const noisy = createNodeStallNotifier({
        toast: true,
        spawnImpl: (_bin, argv) => {
          spawned.push(argv)
          return { on: () => {}, unref: () => {} }
        },
      })
      noisy({ warning: { worker: 'claude', level: 1, maxWarnings: 3, silentMs: 600_000 }, taskId: 't2' })
      if (process.platform === 'darwin') {
        assert.equal(spawned.length, 1)
        assert.match(JSON.stringify(spawned[0]), /claude/)
        assert.match(JSON.stringify(spawned[0]), /不会自动终止/)
      } else {
        assert.deepEqual(spawned, [], '非 macOS 宿主不弹系统通知')
      }
    },
  },
]
