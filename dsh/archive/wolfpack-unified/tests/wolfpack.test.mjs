/**
 * 狼群模式 v1.3.0 验证脚本。
 *
 * 位置有讲究：放在 $DSH_HOME/profiles/ 下面，Node 向上查找能命中
 * profiles/node_modules/@deepseek-ai/*，所以这里用的是**真的** defineTool
 * 和真的 schemastery，不是 stub。
 *
 * 不 spawn 任何真实进程：ctx.subprocess 全部由脚本假造，agy 一次都不跑，
 * 不消耗配额。
 */

import { mkdir, rm } from 'node:fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  buildAgyArgv, defaultShellArgv, diffArtifacts, extractConversationId, extractUsage, mapAgyResult,
  resolveContinuation, resolveDeadline, runVerify, startAgy, truncateBytes,
  listLiveRuns, killRun, extractDurationMs,
} from './agy-runner.js'
import { AgyProvider, promptText, toSubagentResult } from './agy-provider.js'
import { registerWolfDelegate, renderDigest, TOOL_NAME } from './wolf-delegate.js'
import { RunsLedger, foldEntries, defaultLedgerPath } from './runs-ledger.js'

// R1 新增能力一律走命名空间导入：这样「函数还不存在」表现为**逐条用例失败**，
// 而不是整个测试文件加载失败——红基线要能逐条证明「这条用例在旧实现上会挂」。
import * as runnerMod from './agy-runner.js'
import * as ledgerMod from './runs-ledger.js'
import * as delegateMod from './wolf-delegate.js'
import * as liveRouteMod from './live-route.js'
import * as teamMod from './wolf-team.js'

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

/* ── 假造进程 seam ─────────────────────────────────────────────────── */

const agyJson = (convId, status = 'SUCCESS') => JSON.stringify({
  status, response: 'did the thing', error: '', duration_seconds: 1, conversation_id: convId,
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
 * @param {object} opts - agyJsonOutput / gitBefore / gitAfter / verifyByCommand / agyExitCode
 */
function fakeCtx(opts = {}) {
  const calls = { git: [], agy: [], verify: [] }
  let gitRound = 0
  const ctx = {
    calls,
    // 服务一律走 ctx.get()：与源码约定一致（可选服务不做 ctx.<name> 属性访问）
    get(name) {
      return name === 'subprocess' ? this.subprocess : undefined
    },
    subprocess: {
      spawn(spec) {
        const prog = spec.argv[0]
        if (prog === 'git') {
          const files = gitRound++ === 0 ? (opts.gitBefore ?? []) : (opts.gitAfter ?? [])
          calls.git.push(files)
          return handle(files.map(f => `?? ${f}`).join('\n'), 0)
        }
        if (/(powershell|pwsh|bash|sh)(\.exe)?$/i.test(prog)) {
          const command = spec.argv[spec.argv.length - 1]
          calls.verify.push(command)
          const spec2 = (opts.verifyByCommand ?? {})[command] ?? { exitCode: 0, stdout: 'ok' }
          return handle(spec2.stdout ?? '', spec2.exitCode ?? 0, spec2.stderr ?? '')
        }
        calls.agy.push(spec.argv)
        return handle(opts.agyJsonOutput ?? agyJson('conv-A'), opts.agyExitCode ?? 0, opts.agyStderr ?? '')
      },
    },
  }
  return ctx
}

const baseConfig = (ledger) => ({
  agyPath: 'agy.exe',
  ledger,
  graceMs: 1000,
  timeoutMs: 60_000,
})

const TMP = `${process.env.TEMP}/wolfpack-v130-test`
await rm(TMP, { recursive: true, force: true })

/* ── A. 纯函数 ─────────────────────────────────────────────────────── */

console.log('\nA. 纯函数')

t('buildAgyArgv 冷启动不带 --conversation，永不带 -c', () => {
  const argv = buildAgyArgv({ agyPath: 'agy.exe' }, 'do it', 60_000, undefined)
  assert.equal(argv.includes('--conversation'), false)
  assert.equal(argv.includes('-c'), false)
  assert.equal(argv.includes('--dangerously-skip-permissions'), true)
})

t('buildAgyArgv 续跑用 --conversation <id>', () => {
  const argv = buildAgyArgv({ agyPath: 'agy.exe' }, 'do it', 60_000, 'conv-A')
  const i = argv.indexOf('--conversation')
  assert.notEqual(i, -1)
  assert.equal(argv[i + 1], 'conv-A')
  assert.equal(argv.includes('-c'), false)
})

t('buildAgyArgv 的 --print-timeout 比我们的 deadline 宽松', () => {
  const argv = buildAgyArgv({ agyPath: 'agy.exe' }, 'x', 600_000, undefined)
  const value = argv[argv.indexOf('--print-timeout') + 1]
  assert.equal(value, '660s')
})

t('resolveDeadline: undefined/0/负数/NaN 都不是 deadline（没配 ≠ 配成 0 毫秒）', () => {
  for (const value of [undefined, null, 0, -1, Number.NaN, Infinity, 'abc', '']) {
    assert.equal(resolveDeadline(value), undefined, `值 ${String(value)} 应被读成「不设 deadline」`)
  }
  assert.equal(resolveDeadline(1_500), 1_500)
  assert.equal(resolveDeadline('2000'), 2_000)
})

t('不设 deadline 时仍然给 agy 一个有限但极宽的 --print-timeout（否则 agy 自己 5 分钟就死）', () => {
  // 关键：agy 的 --print-timeout 默认只有 5 分钟。不设 deadline 时如果干脆不传这个参数，
  // 长任务会被 agy 自己掐死——那和不设 deadline 的意图正好相反。
  const argv = buildAgyArgv({ agyPath: 'agy.exe' }, 'x', undefined, undefined)
  const value = argv[argv.indexOf('--print-timeout') + 1]
  assert.equal(value, '86460s') // 24 小时 + 60 秒
  assert.equal(argv.includes('--print-timeout'), true)
})

t('不设 deadline 的 --print-timeout 可以被配置覆盖', () => {
  const argv = buildAgyArgv({ agyPath: 'agy.exe', agyPrintTimeoutMs: 3_600_000 }, 'x', 0, undefined)
  assert.equal(argv[argv.indexOf('--print-timeout') + 1], '3660s')
})

t('resolveContinuation: 无历史 → 冷启动', () => {
  const r = resolveContinuation({ config: {}, previous: undefined, forceFresh: false })
  assert.deepEqual([r.continuing, r.conversationId, r.round], [false, undefined, 1])
})

t('resolveContinuation: 有历史 → 续跑，轮数递增', () => {
  const r = resolveContinuation({ config: {}, previous: { conversationId: 'c1', round: 2 }, forceFresh: false })
  assert.deepEqual([r.continuing, r.conversationId, r.round], [true, 'c1', 3])
})

t('resolveContinuation: continuation=never 强制冷启动', () => {
  const r = resolveContinuation({ config: { continuation: 'never' }, previous: { conversationId: 'c1', round: 2 } })
  assert.equal(r.continuing, false)
  assert.equal(r.freshReason, 'continuation-disabled')
})

t('resolveContinuation: forceFresh 丢弃旧会话（思路错了要重开）', () => {
  const r = resolveContinuation({ config: {}, previous: { conversationId: 'c1', round: 2 }, forceFresh: true })
  assert.equal(r.continuing, false)
  assert.equal(r.freshReason, 'forced-fresh')
})

t('resolveContinuation: 轮数超限自动冷启动（会话越长越贵）', () => {
  const r = resolveContinuation({ config: { maxRoundsPerTask: 3 }, previous: { conversationId: 'c1', round: 3 } })
  assert.equal(r.continuing, false)
  assert.equal(r.freshReason, 'max-rounds(3)')
})

t('diffArtifacts 只报差集，不吃派活前就脏的文件', () => {
  const before = new Set(['old.ts'])
  const after = new Set(['old.ts', 'new.ts'])
  const r = diffArtifacts(before, after)
  assert.deepEqual(r.files, ['new.ts'])
  assert.equal(r.changed, true)
})

t('diffArtifacts: 探测不到必须与「没有改动」区分开', () => {
  const unknown = diffArtifacts(new Set(), undefined)
  assert.equal(unknown.determined, false)
  assert.equal(unknown.changed, false)
  const none = diffArtifacts(new Set(), new Set())
  assert.equal(none.determined, true)
  assert.equal(none.changed, false)
})

t('mapAgyResult: SUCCESS + exit 0 → completed', () => {
  const r = mapAgyResult(agyJson('c'), { exitCode: 0, signal: null }, { changed: false, summary: '' }, { aborted: false, timedOut: false })
  assert.equal(r.stopReason, 'completed')
})

t('mapAgyResult: ERROR 但有磁盘产物 → completed（503 场景的代码化）', () => {
  const r = mapAgyResult(agyJson('c', 'ERROR'), { exitCode: 0, signal: null }, { changed: true, summary: '1 个文件：a.ts' }, { aborted: false, timedOut: false })
  assert.equal(r.stopReason, 'completed')
  assert.match(r.diagnostic, /但检测到磁盘产物/)
})

t('mapAgyResult: ERROR 且无产物 → error', () => {
  const r = mapAgyResult(agyJson('c', 'ERROR'), { exitCode: 0, signal: null }, { changed: false, summary: '' }, { aborted: false, timedOut: false })
  assert.equal(r.stopReason, 'error')
})

t('mapAgyResult: 超时 → aborted', () => {
  const r = mapAgyResult(agyJson('c'), { exitCode: null, signal: null }, { changed: false, summary: '' }, { aborted: false, timedOut: true })
  assert.equal(r.stopReason, 'aborted')
})

t('mapAgyResult: 输出不是 JSON 也不炸，按 exit code 判定', () => {
  const r = mapAgyResult('not json', { exitCode: 1, signal: null }, { changed: false, summary: '' }, { aborted: false, timedOut: false })
  assert.equal(r.stopReason, 'error')
})

t('extractConversationId: 前有噪声/非 JSON/正常', () => {
  assert.equal(extractConversationId(`warn\n${agyJson('c1')}`), undefined)
  assert.equal(extractConversationId('garbage'), undefined)
  assert.equal(extractConversationId(agyJson('c1')), 'c1')
})

t('truncateBytes 不切碎多字节字符', () => {
  const out = truncateBytes('中文中文中文中文', 10)
  assert.equal(out.includes('\uFFFD'), false)
  assert.ok(new TextEncoder().encode(out).byteLength <= 10)
})

/* ── B. startAgy 集成 ─────────────────────────────────────────────── */

console.log('\nB. startAgy（假造进程 seam）')

await ta('冷启动：写台账、拿到 conversation_id', async () => {
  const ledger = new RunsLedger(`${TMP}/b1.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('conv-A') })
  const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'task-1', cwd: 'C:/repo', task: 'do it' })
  const out = await run.result
  assert.equal(out.round, 1)
  assert.equal(out.continuing, false)
  assert.equal(out.conversationId, 'conv-A')
  assert.equal(out.stopReason, 'completed')
  const state = await ledger.latest('task-1')
  assert.equal(state.conversationId, 'conv-A')
  assert.equal(state.round, 1)
})

await ta('第二轮：同一 taskId 自动续跑，argv 带 --conversation', async () => {
  const ledger = new RunsLedger(`${TMP}/b2.ndjson`)
  await ledger.record({ taskId: 'task-2', round: 1, conversationId: 'conv-B', stopReason: 'completed' })
  const ctx = fakeCtx({ agyJsonOutput: agyJson('conv-B') })
  const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'task-2', cwd: 'C:/repo', task: 'again' })
  const out = await run.result
  assert.equal(out.continuing, true)
  assert.equal(out.round, 2)
  const argv = ctx.calls.agy[0]
  assert.equal(argv[argv.indexOf('--conversation') + 1], 'conv-B')
  assert.equal(argv.includes('-c'), false)
})

await ta('agy 不回新 id 时沿用旧 id（不丢续跑能力）', async () => {
  const ledger = new RunsLedger(`${TMP}/b3.ndjson`)
  await ledger.record({ taskId: 'task-3', round: 1, conversationId: 'conv-C' })
  const ctx = fakeCtx({ agyJsonOutput: JSON.stringify({ status: 'SUCCESS', response: 'ok' }) })
  const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'task-3', cwd: 'C:/repo', task: 'x' })
  const out = await run.result
  assert.equal(out.conversationId, 'conv-C')
})

await ta('本轮产物只算差集：派活前就脏的文件不算', async () => {
  const ledger = new RunsLedger(`${TMP}/b4.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c'), gitBefore: ['dirty.ts'], gitAfter: ['dirty.ts', 'made.ts'] })
  const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'task-4', cwd: 'C:/repo', task: 'x' })
  const out = await run.result
  assert.deepEqual(out.changedFiles, ['made.ts'])
})

await ta('ERROR 但有产物：端到端判为 completed', async () => {
  const ledger = new RunsLedger(`${TMP}/b5.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c', 'ERROR'), gitAfter: ['out.ts'] })
  const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'task-5', cwd: 'C:/repo', task: 'x' })
  const out = await run.result
  assert.equal(out.stopReason, 'completed')
  assert.deepEqual(out.changedFiles, ['out.ts'])
})

await ta('并发两个任务各自独立，argv 不共用会话', async () => {
  const ledger = new RunsLedger(`${TMP}/b6.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c') })
  const [a, b] = await Promise.all([
    startAgy({ ctx, config: baseConfig(ledger), taskId: 'p1', cwd: 'C:/repo', task: 'one' }),
    startAgy({ ctx, config: baseConfig(ledger), taskId: 'p2', cwd: 'C:/repo', task: 'two' }),
  ])
  await Promise.all([a.result, b.result])
  assert.equal(ctx.calls.agy.length, 2)
  assert.equal(ctx.calls.agy.every(argv => !argv.includes('--conversation')), true)
  const tasks = [...(await ledger.read()).keys()].sort()
  assert.deepEqual(tasks, ['p1', 'p2'])
})

/**
 * 一个**不会自己结束**的 agy 进程 seam：`done` 只在收到的 signal abort 或
 * 测试主动 terminate 时结算。用来验证「无 deadline 时不会被自己的计时器杀掉」。
 *
 * @returns {{ctx: object, state: {spec: object|undefined, settled: boolean}}}
 */
function pendingCtx() {
  const state = { spec: undefined, settled: false }
  const ctx = {
    calls: { git: [], agy: [], verify: [] },
    get(name) {
      return name === 'subprocess' ? this.subprocess : undefined
    },
    subprocess: {
      spawn(spec) {
        if (spec.argv[0] === 'git') return handle('', 0)
        state.spec = spec
        let settle
        const done = new Promise(resolve => { settle = resolve })
        const finish = outcome => {
          if (state.settled) return
          state.settled = true
          settle(outcome)
        }
        const onAbort = () => finish({ exitCode: null, signal: 'SIGTERM' })
        if (spec.signal?.aborted === true) onAbort()
        else spec.signal?.addEventListener('abort', onAbort, { once: true })
        return {
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done,
          terminate: onAbort,
          waitForExit: async () => true,
        }
      },
    },
  }
  return { ctx, state }
}

await ta('无 deadline：跑很久也不会被自己的计时器杀掉（调用方取消仍能终止进程树）', async () => {
  const ledger = new RunsLedger(`${TMP}/b7.ndjson`)
  const { ctx, state } = pendingCtx()
  const caller = new AbortController()
  const run = await startAgy({
    ctx,
    config: { agyPath: 'agy.exe', ledger, graceMs: 1000, timeoutMs: 0 },
    taskId: 'no-deadline',
    cwd: 'C:/repo',
    task: 'x',
    signal: caller.signal,
  })

  // 超过任何「旧默认值」的观察窗口仍然必须活着——旧实现到这里已经被 abort 了。
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(state.spec.signal?.aborted === true, false)
  assert.equal(state.settled, false)

  // 取消能力不能被「不设 deadline」一起取消掉。
  caller.abort()
  const out = await run.result
  assert.equal(out.stopReason, 'aborted')
  assert.equal(out.expired, false)
  assert.match(out.diagnostic, /委派被取消/)
})

await ta('显式 deadline 仍然生效：到点终止进程树并标记 expired', async () => {
  const ledger = new RunsLedger(`${TMP}/b8.ndjson`)
  const { ctx, state } = pendingCtx()
  // deadline 计时器是 unref 的（宿主进程常驻，不该被它拉住）；这里必须自己保留
  // 一个 ref 的句柄，否则 Node 会在计时器到点前先判定「顶层 await 没有着落」退出。
  const keepAlive = setTimeout(() => {}, 5_000)
  try {
    const run = await startAgy({
      ctx,
      config: { agyPath: 'agy.exe', ledger, graceMs: 1000, timeoutMs: 150 },
      taskId: 'with-deadline',
      cwd: 'C:/repo',
      task: 'x',
    })
    const out = await run.result
    assert.equal(out.stopReason, 'aborted')
    assert.equal(out.expired, true)
    assert.equal(state.spec.signal.aborted, true)
    assert.match(out.diagnostic, /超时/)
  } finally {
    clearTimeout(keepAlive)
  }
})

/* ── C. 验收 ───────────────────────────────────────────────────────── */
console.log('\nC. runVerify')

await ta('验收跑命令并回传 exit code 与尾部', async () => {
  const ctx = fakeCtx({ verifyByCommand: { 'npm test': { exitCode: 0, stdout: 'all green' }, 'npm run lint': { exitCode: 1, stdout: 'line1\nline2\nBOOM' } } })
  const results = await runVerify({ ctx, cwd: 'C:/repo', commands: ['npm test', 'npm run lint'], graceMs: 1000, tailLines: 2 })
  assert.equal(results.length, 2)
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.match(results[1].tail, /BOOM/)
  assert.equal(results[1].tail.split('\n').length, 2)
})

/* ── D. wolf_delegate 工具（真 defineTool + 真 schema 校验）───────── */

console.log('\nD. wolf_delegate 工具')

function captureTool(ctx) {
  let definition
  const tools = { register(def) { definition = def; return () => { definition = undefined } } }
  ctx.get = name => (name === 'tools' ? tools : (name === 'subprocess' ? ctx.subprocess : undefined))
  return () => definition
}

const agentExec = () => ({
  agent: { session: { header: { cwd: 'C:/repo' } } },
  signal: new AbortController().signal,
})

await ta('默认不向 harness 声明 timeoutMs —— 外层 timeout-policy 因此不给 deadline', async () => {
  const ctx = fakeCtx({})
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, { agyPath: 'agy.exe', ledger: new RunsLedger(`${TMP}/d0.ndjson`), graceMs: 1000 })
  const def = getDef()
  // 声明了 timeoutMs，外层把它换成 abort（进而杀进程树）；不声明才真的没有上限。
  assert.equal(def.timeoutMs, undefined)
})

await ta('显式 deadline 时才声明外层工具预算（deadline + 验收 + 120s 宽限）', async () => {
  const ctx = fakeCtx({})
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(new RunsLedger(`${TMP}/d0b.ndjson`)))
  // baseConfig: timeoutMs 60_000，验收默认 5 分钟 → 60_000 + 300_000 + 120_000
  assert.equal(getDef().timeoutMs, 480_000)
})

await ta('registerWolfDelegate 能通过真 defineTool 的 schema 校验并注册', async () => {
  const ctx = fakeCtx({})
  const getDef = captureTool(ctx)
  const dispose = registerWolfDelegate(ctx, baseConfig(new RunsLedger(`${TMP}/d1.ndjson`)))
  const def = getDef()
  assert.equal(def.name, TOOL_NAME)
  assert.equal(typeof def.execute, 'function')
  assert.equal(typeof def.output.render, 'function')
  assert.equal(typeof dispose, 'function')
})

await ta('工具端到端：跑 agy + 跑验收 + 返回 pass 与有界 digest', async () => {
  const ledger = new RunsLedger(`${TMP}/d2.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('conv-D'),
    gitAfter: ['a.ts', 'b.ts'],
    verifyByCommand: { 'npm test': { exitCode: 0, stdout: 'green' } },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute(
    { task_id: 'fix-build', task: 'fix the build', verify: ['npm test'] },
    agentExec(),
  )
  assert.equal(value.task_id, 'fix-build')
  assert.equal(value.round, 1)
  assert.equal(value.continued, false)
  assert.equal(value.verdict, 'pass')
  assert.deepEqual(value.changed_files, ['a.ts', 'b.ts'])
  assert.equal(value.conversation_id, 'conv-D')
  assert.equal(value.verify[0].ok, true)
  // 返回值必须是 lossless JSON（工具层会做这个校验）
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  // 验收结论进台账
  const state = await ledger.latest('fix-build')
  assert.equal(state.lastVerdict, 'pass')
})

await ta('验收失败 → verdict=fail（队长拿到的是实测结论）', async () => {
  const ledger = new RunsLedger(`${TMP}/d3.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c'), verifyByCommand: { 'npm test': { exitCode: 1, stdout: 'red' } } })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x', verify: ['npm test'] }, agentExec())
  assert.equal(value.verdict, 'fail')
  assert.equal(value.verify[0].ok, false)
})

await ta('不给 verify → verdict=unverified（明确标注没有成功证据）', async () => {
  const ledger = new RunsLedger(`${TMP}/d4.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c') })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x' }, agentExec())
  assert.equal(value.verdict, 'unverified')
  assert.deepEqual(value.verify, [])
  assert.match(renderDigest(value), /没有\*\*可核实的成功证据|没有\*\*可核实/)
})

await ta('缺 task_id 被 schema 挡下（不会静默当成新任务）', async () => {
  const ctx = fakeCtx({})
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(new RunsLedger(`${TMP}/d5.ndjson`)))
  await assert.rejects(() => getDef().execute({ task: 'x' }, agentExec()))
})

await ta('fresh:true 强制冷启动', async () => {
  const ledger = new RunsLedger(`${TMP}/d6.ndjson`)
  await ledger.record({ taskId: 't', round: 3, conversationId: 'old-conv' })
  const ctx = fakeCtx({ agyJsonOutput: agyJson('new-conv') })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x', fresh: true }, agentExec())
  assert.equal(value.continued, false)
  assert.equal(value.fresh_reason, 'forced-fresh')
  assert.equal(ctx.calls.agy[0].includes('--conversation'), false)
})

await ta('无 exec.agent 时明确报错，不静默', async () => {
  const ctx = fakeCtx({})
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(new RunsLedger(`${TMP}/d7.ndjson`)))
  await assert.rejects(() => getDef().execute({ task_id: 't', task: 'x' }, { signal: new AbortController().signal }), /agent/)
})

/* ── E. digest 版式 ────────────────────────────────────────────────── */

console.log('\nE. digest 版式')

t('digest 把「队员声称」与「我已核实」分开', () => {
  const text = renderDigest({
    task_id: 'fix-build', round: 2, continued: true, stop_reason: 'completed',
    report: '我改好了', changed_files: ['a.ts'],
    verify: [{ command: 'npm test', ok: false, exit_code: 1, tail: 'BOOM' }],
    verdict: 'fail', spill_path: 'C:/spill/run.log',
  })
  assert.match(text, /队员声称/)
  assert.match(text, /我已核实/)
  assert.match(text, /✗ npm test/)
  assert.match(text, /BOOM/)
  assert.match(text, /verdict: fail/)
  assert.match(text, /C:\/spill\/run\.log/)
  assert.match(text, /续跑/)
})

/* ── F. provider 适配 ──────────────────────────────────────────────── */

console.log('\nF. AgyProvider（seam 适配）')

t('promptText 摊平 ContentBlock[]', () => {
  assert.equal(promptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb')
})

t('toSubagentResult 映射到 seam 形状', () => {
  const r = toSubagentResult({ report: 'hi', stopReason: 'completed', diagnostic: 'note' })
  assert.deepEqual(r.output, [{ type: 'text', text: 'hi' }])
  assert.equal(r.stopReason, 'completed')
  assert.equal(r.diagnostic, 'note')
})

t('toSubagentResult: 空正文 → 空 output，不造空块', () => {
  assert.deepEqual(toSubagentResult({ report: '', stopReason: 'error' }).output, [])
})

await ta('provider.start 返回 seam 形状的 run，id 唯一', async () => {
  const ledger = new RunsLedger(`${TMP}/f1.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('conv-F') })
  const provider = new AgyProvider(ctx, baseConfig(ledger))
  const request = {
    label: 'fix build',
    prompt: [{ type: 'text', text: 'fix it' }],
    parent: { session: { header: { cwd: 'C:/repo' } } },
    signal: undefined,
  }
  const run = await provider.start(request)
  assert.equal(typeof run.id, 'string')
  assert.equal(run.localAgent, undefined)
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.output, [{ type: 'text', text: 'did the thing' }])
  await run.dispose()
})

await ta('provider 无 cwd 时明确报错', async () => {
  const provider = new AgyProvider(fakeCtx({}), baseConfig(new RunsLedger(`${TMP}/f2.ndjson`)))
  await assert.rejects(
    () => provider.start({ prompt: [{ type: 'text', text: 'x' }], parent: { session: { header: {} } } }),
    /cwd/,
  )
})

/* ── G. 台账 ───────────────────────────────────────────────────────── */

console.log('\nG. 台账')

t('foldEntries: 失败记录不抹掉已有 conversationId', () => {
  const folded = foldEntries([
    { at: 1, taskId: 't', round: 1, conversationId: 'c1' },
    { at: 2, taskId: 't', round: 2, note: 'failed without id' },
  ])
  assert.equal(folded.get('t').conversationId, 'c1')
})

await ta('台账：路径不可写时不抛异常，派活不受影响', async () => {
  // 含 NUL 的路径必然写不进去；契约是「记警告但绝不抛」，否则一次台账故障
  // 就会把整个委派带崩。
  const ledger = new RunsLedger(`${TMP}/nonexistent\x00bad/runs.ndjson`)
  await ledger.record({ taskId: 't' })
  assert.deepEqual([...(await ledger.read()).keys()], [])
})

await ta('台账：目录不存在时会自动创建', async () => {
  const ledger = new RunsLedger(`${TMP}/deep/nested/runs.ndjson`)
  await ledger.record({ taskId: 't', round: 1, conversationId: 'c' })
  assert.equal((await ledger.latest('t')).conversationId, 'c')
})

/* ── 汇总 ──────────────────────────────────────────────────────────── */


/* ── H. 真机试验暴露的缺陷（回归测试）──────────────────────────────── */

console.log('\nH. 试验暴露的缺陷（回归）')

t('defaultShellArgv: 不依赖 PATH，解析到绝对路径', () => {
  const shell = defaultShellArgv({ SystemRoot: 'C:\\Windows' })
  if (process.platform === 'win32') {
    // 本机只装了 Windows PowerShell 5.1，PATH 里没有 pwsh——这正是当初
    // ENOENT 的根因，所以默认值绝不能是裸的 'pwsh'。
    assert.equal(shell[0].includes('pwsh'), false)
    assert.ok(shell[0].includes('powershell.exe'))
    assert.ok(shell[0].startsWith('C:\\Windows'))
  }
})

t('defaultShellArgv: WOLFPACK_SHELL 可覆盖', () => {
  assert.deepEqual(defaultShellArgv({ WOLFPACK_SHELL: 'cmd.exe /d /c' }), ['cmd.exe', '/d', '/c'])
})

t('defaultLedgerPath: 任何环境组合下都返回绝对路径', () => {
  const cases = [{}, { DSH_HOME: 'C:/a' }, { USERPROFILE: 'C:/u' }, { WOLFPACK_LEDGER: 'D:/x/runs.ndjson' }, { DSH_HOME: '   ' }]
  for (const env of cases) {
    const path = defaultLedgerPath(env)
    assert.ok(isAbsolute(path), `不是绝对路径: ${path} (${JSON.stringify(env)})`)
  }
})

t('defaultLedgerPath: WOLFPACK_LEDGER > DSH_HOME > USERPROFILE', () => {
  assert.equal(defaultLedgerPath({ WOLFPACK_LEDGER: 'D:/x.ndjson', DSH_HOME: 'C:/a' }), 'D:/x.ndjson')
  assert.ok(defaultLedgerPath({ DSH_HOME: 'C:/a' }).replace(/\\/g, '/').startsWith('C:/a'))
  assert.ok(defaultLedgerPath({ USERPROFILE: 'C:/u' }).includes('.dsh'))
})

t('digest: 探测不到产物时显示「无法判定」，绝不显示「无」', () => {
  const text = renderDigest({
    task_id: 't', round: 1, continued: false, stop_reason: 'completed', report: 'x',
    changed_files: [], changed_files_determined: false, verify: [], verdict: 'unverified',
  })
  assert.match(text, /无法判定/)
  assert.equal(text.includes('（无）'), false)
})

t('digest: verdict=error 时明确说是工具故障，不要重派', () => {
  const text = renderDigest({
    task_id: 't', round: 1, continued: false, stop_reason: 'completed', report: 'x',
    changed_files: [], changed_files_determined: true,
    verify: [{ command: 'npm test', ran: false, ok: false, error: 'spawn x ENOENT' }],
    verdict: 'error',
  })
  assert.match(text, /工具故障/)
  assert.match(text, /ENOENT/)
  assert.match(text, /无法执行/)
})

await ta('runVerify: 命令起不来 → ran:false（不是 ok:false）', async () => {
  const ctx = { get: () => ({ spawn() { throw new Error('spawn pwsh ENOENT') } }) }
  const results = await runVerify({ ctx, cwd: 'C:/repo', commands: ['npm test'], graceMs: 1000 })
  assert.equal(results[0].ran, false)
  assert.equal(results[0].ok, false)
  assert.match(results[0].error, /ENOENT/)
})

await ta('工具：验收完全跑不起来 → verdict=error，而不是 fail', async () => {
  const ledger = new RunsLedger(`${TMP}/h1.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c') })
  const realSpawn = ctx.subprocess.spawn
  ctx.subprocess.spawn = spec => {
    if (/(powershell|pwsh|bash|sh)(\.exe)?$/i.test(spec.argv[0])) throw new Error('spawn x ENOENT')
    return realSpawn(spec)
  }
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x', verify: ['npm test'] }, agentExec())
  assert.equal(value.verdict, 'error')
  assert.equal(value.verify[0].ran, false)
})

await ta('startAgy: 每次运行都把 agy 原始 JSON 落盘', async () => {
  const ledger = new RunsLedger(`${TMP}/h2.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('conv-RAW') })
  const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'raw-task', cwd: 'C:/repo', task: 'x' })
  const out = await run.result
  assert.ok(typeof out.rawPath === 'string' && out.rawPath !== '')
  assert.equal(readFileSync(out.rawPath, 'utf8'), agyJson('conv-RAW'))
})

await ta('工具：无 git 仓库时 changed_files_determined 为 false', async () => {
  const ledger = new RunsLedger(`${TMP}/h3.ndjson`)
  // git 探测失败（非仓库）：exit 1 → after 为 undefined
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c') })
  const realSpawn = ctx.subprocess.spawn
  ctx.subprocess.spawn = spec => {
    if (spec.argv[0] === 'git') return handle('', 128)
    return realSpawn(spec)
  }
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x' }, agentExec())
  assert.equal(value.changed_files_determined, false)
  assert.deepEqual(value.changed_files, [])
})


/* ── I. 补齐项：用量记录与完成判定 ─────────────────────────────────── */

console.log('\nI. 补齐项（用量 / 完成判定）')

t('extractUsage: 按实测确认的字段名读数', () => {
  const raw = JSON.stringify({
    status: 'SUCCESS',
    conversation_id: 'c',
    num_turns: 7,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 80, total_tokens: 205 },
  })
  const usage = extractUsage(raw)
  assert.equal(usage.total, 205)
  assert.equal(usage.cacheRead, 80)
  assert.equal(usage.turns, 7)
  assert.equal(usage.output, 20)
})

t('extractUsage: 缺字段或非 JSON 时返回 undefined，绝不编造数字', () => {
  assert.equal(extractUsage('not json'), undefined)
  assert.equal(extractUsage(JSON.stringify({ status: 'SUCCESS' })), undefined)
  assert.equal(extractUsage(JSON.stringify({ usage: {} })), undefined)
})

await ta('台账按任务累计 agy 用量（只进台账，不进队长上下文）', async () => {
  const ledger = new RunsLedger(`${TMP}/i1.ndjson`)
  const raw = JSON.stringify({ status: 'SUCCESS', response: 'ok', num_turns: 3, usage: { total_tokens: 1000, cache_read_tokens: 900 } })
  const ctx = fakeCtx({ agyJsonOutput: raw })
  const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'usage-task', cwd: 'C:/repo', task: 'x' })
  const out = await run.result
  assert.equal(out.usage.total, 1000)
  const state = await ledger.latest('usage-task')
  assert.equal(state.totalTokens, 1000)
  assert.equal(state.totalCacheReadTokens, 900)
  assert.equal(state.lastTurns, 3)
})

await ta('两轮用量会累加', async () => {
  const ledger = new RunsLedger(`${TMP}/i2.ndjson`)
  const raw = JSON.stringify({ status: 'SUCCESS', response: 'ok', usage: { total_tokens: 500 } })
  for (let round = 0; round < 2; round += 1) {
    const ctx = fakeCtx({ agyJsonOutput: raw })
    const run = await startAgy({ ctx, config: baseConfig(ledger), taskId: 'sum-task', cwd: 'C:/repo', task: 'x' })
    await run.result
  }
  assert.equal((await ledger.latest('sum-task')).totalTokens, 1000)
})

await ta('agy 自报 ERROR 但验收全过 → 判为 completed（非 git 工作区的救命规则）', async () => {
  const ledger = new RunsLedger(`${TMP}/i3.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('c', 'ERROR'),
    verifyByCommand: { 'npm test': { exitCode: 0, stdout: 'green' } },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x', verify: ['npm test'] }, agentExec())
  assert.equal(value.stop_reason, 'completed')
  assert.equal(value.verdict, 'pass')
  assert.match(value.diagnostic, /判为完成/)
})

await ta('agy 自报 ERROR 且验收不过 → 仍是 error', async () => {
  const ledger = new RunsLedger(`${TMP}/i4.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('c', 'ERROR'),
    verifyByCommand: { 'npm test': { exitCode: 1, stdout: 'red' } },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x', verify: ['npm test'] }, agentExec())
  assert.equal(value.stop_reason, 'error')
  assert.equal(value.verdict, 'fail')
})

await ta('agy 自报 ERROR 且没给 verify → 不救（没有证据就是没有证据）', async () => {
  const ledger = new RunsLedger(`${TMP}/i5.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c', 'ERROR') })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x' }, agentExec())
  assert.equal(value.stop_reason, 'error')
  assert.equal(value.verdict, 'unverified')
})

await ta('验收命令跑不起来时不触发救援（工具故障不是完成证据）', async () => {
  const ledger = new RunsLedger(`${TMP}/i6.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c', 'ERROR') })
  const realSpawn = ctx.subprocess.spawn
  ctx.subprocess.spawn = spec => {
    if (/(powershell|pwsh|bash|sh)(\.exe)?$/i.test(spec.argv[0])) throw new Error('spawn x ENOENT')
    return realSpawn(spec)
  }
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 't', task: 'x', verify: ['npm test'] }, agentExec())
  assert.equal(value.stop_reason, 'error')
  assert.equal(value.verdict, 'error')
})

/* ── J. R1 加固契约：并发 / 预算 / 增量读 / 预检 / 基线 / 诊断 / 状态 ── */

console.log('\nJ. R1 加固契约')

await ta('同 task_id 并发：第二次在同一 tick 内被拒（不是排队，也不是串场）', async () => {
  const registry = new ledgerMod.ActiveRunRegistry()
  const ledger = new RunsLedger(`${TMP}/j1.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('conv-j1') })
  const config = baseConfig(ledger)
  // 同一条消息里并发两次，同一个 task_id：这是队长最常踩的交错形状。
  const [first, second] = await Promise.allSettled([
    startAgy({ ctx, config, taskId: 'same-id', cwd: 'C:/repo', task: 'one', registry }),
    startAgy({ ctx, config, taskId: 'same-id', cwd: 'C:/repo', task: 'two', registry }),
  ])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(second.reason.code, 'TASK_BUSY')
  assert.equal(second.reason.taskId, 'same-id')
  // 文案必须让队长知道下一步：换 id 或等。
  assert.match(second.reason.message, /换一个新的 task_id/)
  assert.match(second.reason.message, /等它跑完/)
  // 直接证据：被拒的那次没有起进程。
  assert.equal(ctx.calls.agy.length, 1)
  const out = await first.value.result
  assert.equal(out.stopReason, 'completed')
  assert.equal(registry.size, 0)
})

await ta('闸门跑完即释放：拒绝不是永久锁，同一个 task_id 还能续跑', async () => {
  const registry = new ledgerMod.ActiveRunRegistry()
  const ledger = new RunsLedger(`${TMP}/j2.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('conv-j2') })
  const config = baseConfig(ledger)
  const first = await startAgy({ ctx, config, taskId: 'loop', cwd: 'C:/repo', task: 'one', registry })
  const denied = await Promise.allSettled([
    startAgy({ ctx, config, taskId: 'loop', cwd: 'C:/repo', task: 'two', registry }),
  ])
  assert.equal(denied[0].status, 'rejected')
  await first.result
  const second = await startAgy({ ctx, config, taskId: 'loop', cwd: 'C:/repo', task: 'three', registry })
  const out = await second.result
  assert.equal(out.round, 2)
  assert.equal(out.continuing, true)
  assert.equal(ctx.calls.agy.length, 2)
})

await ta('闸门只锁同一个 task_id：不同 task_id 仍然并行', async () => {
  const registry = new ledgerMod.ActiveRunRegistry()
  const ledger = new RunsLedger(`${TMP}/j3.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('c') })
  const config = baseConfig(ledger)
  const runs = await Promise.all([
    startAgy({ ctx, config, taskId: 'par-a', cwd: 'C:/repo', task: 'a', registry }),
    startAgy({ ctx, config, taskId: 'par-b', cwd: 'C:/repo', task: 'b', registry }),
  ])
  await Promise.all(runs.map(run => run.result))
  assert.equal(ctx.calls.agy.length, 2)
  assert.deepEqual([...(await ledger.read()).keys()].sort(), ['par-a', 'par-b'])
  assert.equal(registry.size, 0)
})

t('续跑闸门改按累计 token 预算：超了才冷启动，理由带真实数字', () => {
  const over = resolveContinuation({
    config: { continuationTokenBudget: 1000 },
    previous: { conversationId: 'c1', round: 3, totalTokens: 1500 },
  })
  assert.equal(over.continuing, false)
  assert.match(over.freshReason, /token-budget/)
  assert.match(over.freshReason, /1500/)
  assert.match(over.freshReason, /1000/)

  const within = resolveContinuation({
    config: { continuationTokenBudget: 1000 },
    previous: { conversationId: 'c1', round: 3, totalTokens: 900 },
  })
  assert.deepEqual([within.continuing, within.conversationId], [true, 'c1'])
})

await ta('难任务不再被轮数硬杀：默认环境下第 8 轮仍然续跑', async () => {
  const indexMod = await import('./index.js')
  // 用**默认环境**算出来的闸门值——这正是 index.js 装进 config 的那两个值。
  // 写死一个 config 的话，这条用例在旧实现上也会通过（旧实现照样续跑）。
  const budget = indexMod.continuationTokenBudget({})
  const maxRounds = indexMod.maxRoundsPerTask({})
  const config = {
    continuationTokenBudget: budget,
    ...(maxRounds === undefined ? {} : { maxRoundsPerTask: maxRounds }),
  }

  const kept = resolveContinuation({
    config,
    previous: { conversationId: 'c-eight', round: 8, totalTokens: 300_000 },
  })
  assert.deepEqual([kept.continuing, kept.conversationId, kept.round], [true, 'c-eight', 9])

  // 向后兼容：显式打开老开关时，老行为必须原样还在。
  const legacy = resolveContinuation({
    config: { ...config, maxRoundsPerTask: 8 },
    previous: { conversationId: 'c-eight', round: 8, totalTokens: 300_000 },
  })
  assert.equal(legacy.freshReason, 'max-rounds(8)')

  // 新闸门是预算：真的超了才冷启动。
  const over = resolveContinuation({
    config,
    previous: { conversationId: 'c-eight', round: 8, totalTokens: 2_000_000 },
  })
  assert.match(over.freshReason, /token-budget/)
})

await ta('时长闸门默认不设：任务是 0（无 deadline），验收仍默认 5 分钟', async () => {
  const indexMod = await import('./index.js')
  // 默认不设 wall-clock deadline——「没配」必须解析成 undefined，而不是 0 毫秒。
  assert.equal(indexMod.taskTimeoutMs({}), 0)
  assert.equal(indexMod.taskTimeoutMs({ WOLFPACK_TASK_TIMEOUT: '0' }), 0)
  assert.equal(indexMod.taskTimeoutMs({ WOLFPACK_TASK_TIMEOUT: 'off' }), 0)
  assert.equal(indexMod.taskTimeoutMs({ WOLFPACK_TASK_TIMEOUT: '垃圾' }), 0)
  // 显式配置恢复按时间杀（秒 → 毫秒）。
  assert.equal(indexMod.taskTimeoutMs({ WOLFPACK_TASK_TIMEOUT: '1800' }), 1_800_000)
  // 验收命令的预算默认保留，可单独关掉。
  assert.equal(indexMod.verifyTimeoutMs({}), 300_000)
  assert.equal(indexMod.verifyTimeoutMs({ WOLFPACK_VERIFY_TIMEOUT: 'off' }), 0)
  assert.equal(indexMod.verifyTimeoutMs({ WOLFPACK_VERIFY_TIMEOUT: '60' }), 60_000)
})

await ta('默认配置的闸门值：轮数默认关闭，token 预算默认 1,000,000', async () => {
  const indexMod = await import('./index.js')
  assert.equal(indexMod.maxRoundsPerTask({}), undefined)
  assert.equal(indexMod.maxRoundsPerTask({ WOLFPACK_MAX_ROUNDS: '3' }), 3)
  assert.equal(indexMod.continuationTokenBudget({}), indexMod.DEFAULT_TOKEN_BUDGET)
  assert.equal(indexMod.continuationTokenBudget({ WOLFPACK_TOKEN_BUDGET: 'off' }), undefined)
  assert.equal(indexMod.continuationTokenBudget({ WOLFPACK_TOKEN_BUDGET: '250000' }), 250_000)
})

await ta('台账增量读：文件没变时零解析，增长时只折新增记录', async () => {
  const ledger = new RunsLedger(`${TMP}/j6.ndjson`)
  await ledger.record({ taskId: 'a', round: 1, conversationId: 'c-a', tokens: 100 })
  const first = await ledger.read()
  assert.equal(first.get('a').totalTokens, 100)
  assert.equal(ledger.stats.fullParses, 1)

  await ledger.read()
  assert.equal(ledger.stats.cacheHits, 1)
  assert.equal(ledger.stats.fullParses, 1)

  await ledger.record({ taskId: 'a', round: 2, conversationId: 'c-a', tokens: 50 })
  const third = await ledger.read()
  // 累计值不能被重复累加——增量折叠最容易在这里错。
  assert.equal(third.get('a').totalTokens, 150)
  assert.equal(third.get('a').round, 2)
  assert.equal(ledger.stats.fullParses, 1)
  assert.equal(ledger.stats.incrementalParses, 1)
})

await ta('台账增量读：写到一半的行绝不可见，写完才可见', async () => {
  const path = `${TMP}/j7.ndjson`
  writeFileSync(path, `${JSON.stringify({ at: 1, taskId: 'done', round: 1, tokens: 10 })}\n`, 'utf8')
  const ledger = new RunsLedger(path)
  assert.equal((await ledger.read()).get('done').round, 1)

  // 另一半正在写：没有换行 → 必须看不见，而且不能因此全量重读。
  appendFileSync(path, JSON.stringify({ at: 2, taskId: 'half', round: 1 }), 'utf8')
  assert.equal((await ledger.read()).has('half'), false)
  assert.equal(ledger.stats.fullParses, 1)

  appendFileSync(path, '\n', 'utf8')
  assert.equal((await ledger.read()).get('half').round, 1)
  assert.equal(ledger.stats.incrementalParses, 1)
})

await ta('台账增量读：文件被截断/轮转后丢弃游标，绝不返回陈旧态', async () => {
  const path = `${TMP}/j8.ndjson`
  const ledger = new RunsLedger(path)
  await ledger.record({ taskId: 'old', round: 3, conversationId: 'c-old' })
  await ledger.read()
  assert.equal(ledger.stats.fullParses, 1)

  writeFileSync(path, `${JSON.stringify({ at: 9, taskId: 'new', round: 1, conversationId: 'c-new' })}\n`, 'utf8')
  const after = await ledger.read()
  assert.equal(after.has('old'), false)
  assert.equal(after.get('new').conversationId, 'c-new')
  assert.equal(ledger.stats.fullParses, 2)
})

await ta('增量读不改变 read()/latest()/conversationFor() 的对外语义', async () => {
  const ledger = new RunsLedger(`${TMP}/j9.ndjson`)
  await ledger.record({ taskId: 'x', round: 1, conversationId: 'c-x', changedFiles: ['a.js'], tokens: 10 })
  await ledger.record({ taskId: 'x', round: 2, changedFiles: ['b.js'], tokens: 5, verdict: 'fail' })
  await ledger.record({ taskId: 'y', round: 1, conversationId: 'c-y' })

  const read = await ledger.read()
  const expected = foldEntries([
    { at: 0, taskId: 'x', round: 1, conversationId: 'c-x', changedFiles: ['a.js'], tokens: 10 },
    { at: 1, taskId: 'x', round: 2, changedFiles: ['b.js'], tokens: 5, verdict: 'fail' },
    { at: 2, taskId: 'y', round: 1, conversationId: 'c-y' },
  ]).get('x')
  const x = read.get('x')
  assert.deepEqual([...read.keys()].sort(), ['x', 'y'])
  assert.equal(x.round, expected.round)
  // 失败记录不带 id，绝不能把已有的 conversationId 抹掉。
  assert.equal(x.conversationId, 'c-x')
  assert.deepEqual([...x.changedFiles].sort(), ['a.js', 'b.js'])
  assert.equal(x.totalTokens, 15)
  assert.equal(x.lastVerdict, 'fail')
  assert.equal((await ledger.latest('x')).round, 2)
  assert.equal(await ledger.conversationFor('x'), 'c-x')
  assert.equal(await ledger.conversationFor('没有这个任务'), undefined)

  // 返回的是克隆：调用方改它不许污染缓存（否则下一次读会把脏数据当真相）。
  read.get('x').changedFiles.push('MUTATED')
  assert.deepEqual((await ledger.read()).get('x').changedFiles, ['a.js', 'b.js'])

  // 多次读取只全量解析一次——「不再每次全量 parse」这条需求的可验证形式。
  assert.equal(ledger.stats.fullParses, 1)
  assert.ok(ledger.stats.cacheHits >= 2)
})

t('preflightAgy: 路径不存在 → ok:false 且 reason 指出路径；存在 → ok:true', () => {
  const missing = runnerMod.preflightAgy('C:/definitely/missing/agy.exe')
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /agy\.exe/)
  assert.equal(runnerMod.preflightAgy('').ok, false)

  const found = runnerMod.preflightAgy(process.execPath)
  assert.equal(found.ok, true)
  assert.equal(found.path, process.execPath)
})

await ta('挂载期 preflight 失败：mount 不整体失败、工具仍注册、调用时报明确不可用', async () => {
  const previousAgy = process.env.WOLFPACK_AGY
  process.env.WOLFPACK_AGY = 'C:/definitely/missing/agy.exe'
  try {
    // index.js 在**模块加载时**读 WOLFPACK_AGY，所以用查询串绕开模块缓存。
    const indexMod = await import('./index.js?agy-missing')
    const registered = []
    const ctx = {
      get(name) {
        if (name === 'tools') return { register(definition) { registered.push(definition); return () => {} } }
        if (name === 'subprocess') return fakeCtx({}).subprocess
        if (name === 'subagents') return { registerProvider() {} }
        return undefined
      },
      settings: { register: () => ({ watch: () => () => {} }), get: () => ({ enabled: true }) },
      systemPrompt: { section: () => () => {} },
      effect(fn) { const disposer = fn(); return () => disposer?.() },
    }

    indexMod.apply(ctx) // 关键：预检失败也**不能**抛，否则整个机制半挂载失败

    const names = registered.map(definition => definition.name)
    assert.ok(names.includes('wolf_delegate'), `已注册工具：${names.join(',')}`)
    assert.ok(names.includes('wolf_status'), `已注册工具：${names.join(',')}`)

    const delegate = registered.find(definition => definition.name === 'wolf_delegate')
    await assert.rejects(
      () => delegate.execute({ task_id: 't', task: 'x', verify: ['echo ok'] }, agentExec()),
      /agy 不可用/,
    )
  } finally {
    if (previousAgy === undefined) delete process.env.WOLFPACK_AGY
    else process.env.WOLFPACK_AGY = previousAgy
  }
})

t('evaluateBaseline: 全失败→推进 / 已通过→stale / 没跑起来→error（三者互不相同）', () => {
  const proceed = runnerMod.evaluateBaseline([
    { command: 'a', ran: true, ok: false, exitCode: 1 },
    { command: 'b', ran: true, ok: false, exitCode: 2 },
  ])
  assert.equal(proceed.decision, 'proceed')

  const stale = runnerMod.evaluateBaseline([{ command: 'a', ran: true, ok: true, exitCode: 0 }])
  assert.equal(stale.decision, 'stale')
  assert.match(stale.reason, /已经通过/)

  const broken = runnerMod.evaluateBaseline([{ command: 'a', ran: false, ok: false, exitCode: null }])
  assert.equal(broken.decision, 'error')
  assert.match(broken.reason, /没有跑起来/)
  assert.notEqual(broken.reason, stale.reason)

  assert.equal(runnerMod.evaluateBaseline([]).decision, 'proceed')
})

await ta('工具：verify_baseline 已通过 → verdict=stale，agy 一次都没启动', async () => {
  const ledger = new RunsLedger(`${TMP}/j13.ndjson`)
  await ledger.record({ taskId: 'stale-task', round: 2, conversationId: 'c-old' })
  const ctx = fakeCtx({ verifyByCommand: { 'exit 0': { exitCode: 0, stdout: 'already fixed' } } })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute(
    { task_id: 'stale-task', task: 'x', verify_baseline: ['exit 0'], verify: ['npm test'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'stale')
  assert.equal(value.stop_reason, 'skipped')
  // 直接证据：一次 agy 都没起（不是靠「没有产物」间接推断）。
  assert.equal(ctx.calls.agy.length, 0)
  // 只跑了基线命令；verify 根本没轮到。
  assert.deepEqual(ctx.calls.verify, ['exit 0'])
  assert.equal(value.verify.length, 0)
  assert.equal(value.round, 2)
  assert.equal(value.baseline[0].ok, true)
  assert.match(renderDigest(value), /stale/)
  assert.equal((await ledger.latest('stale-task')).lastVerdict, 'stale')
})

await ta('工具：verify_baseline 命令没跑起来 → verdict=error，与 stale 不同且不起 agy', async () => {
  const ledger = new RunsLedger(`${TMP}/j14.ndjson`)
  const ctx = fakeCtx({})
  const realSpawn = ctx.subprocess.spawn
  ctx.subprocess.spawn = spec => {
    if (/(powershell|pwsh|bash|sh)(\.exe)?$/i.test(spec.argv[0])) throw new Error('spawn x ENOENT')
    return realSpawn(spec)
  }
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute(
    { task_id: 'broken-baseline', task: 'x', verify_baseline: ['npm test'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'error')
  assert.notEqual(value.verdict, 'stale')
  assert.equal(ctx.calls.agy.length, 0)
  assert.equal(value.baseline[0].ran, false)
  assert.match(value.diagnostic, /没有跑起来/)
  assert.match(renderDigest(value), /工具故障/)
})

await ta('工具：基线真失败（问题还在）→ 照常派活，基线结果进 digest', async () => {
  const ledger = new RunsLedger(`${TMP}/j15.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('conv-j15'),
    verifyByCommand: {
      'repro': { exitCode: 1, stdout: 'bug still here' },
      'npm test': { exitCode: 0, stdout: 'green' },
    },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute(
    { task_id: 'live-bug', task: 'x', verify_baseline: ['repro'], verify: ['npm test'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'pass')
  assert.equal(ctx.calls.agy.length, 1)
  assert.equal(value.baseline[0].ok, false)
  assert.match(renderDigest(value), /派活前基线/)
})

t('extractFailureSignals: 抓出 file:line / 计数 / 用例名', () => {
  const text = [
    'FAIL src/calc.test.ts > adds numbers',
    'AssertionError: expected 3 to equal 4',
    '  at src/calc.ts:12:5',
    'Tests  1 failed, 2 passed (3)',
  ].join('\n')
  const signals = runnerMod.extractFailureSignals(text)
  assert.equal(signals.degraded, false)
  assert.ok(signals.items.some(item => item.kind === 'file:line' && item.text.includes('src/calc.ts:12')))
  assert.ok(signals.items.some(item => item.kind === 'counts' && item.text.includes('1 failed, 2 passed')))
  assert.ok(signals.items.some(item => item.kind === 'test-name'))
  assert.ok(signals.items.length <= runnerMod.FAILURE_SIGNAL_LIMIT)
})

t('extractFailureSignals: 一条信号都提不出来时 degraded=true（明确降级，不静默）', () => {
  const signals = runnerMod.extractFailureSignals('something blew up\nno useful detail here')
  assert.equal(signals.degraded, true)
  assert.deepEqual(signals.items, [])
})

await ta('工具：验收失败时 digest 给可定位信号，不再只有 tail', async () => {
  const ledger = new RunsLedger(`${TMP}/j18.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('c'),
    verifyByCommand: {
      'npm test': {
        exitCode: 1,
        stdout: 'FAIL src/a.test.ts > x\nAssertionError: boom\n  at src/a.ts:7:3\nTests  1 failed, 2 passed',
      },
    },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 'diag', task: 'x', verify: ['npm test'] }, agentExec())
  assert.equal(value.verdict, 'fail')
  assert.equal(value.verify[0].signals.degraded, false)
  assert.ok(value.verify[0].signals.items.some(item => item.kind === 'file:line'))
  const digest = renderDigest(value)
  assert.match(digest, /可定位信号/)
  assert.match(digest, /src\/a\.ts:7:3/)
})

await ta('工具：验收失败但提不出信号 → digest 明确写「降级为 tail」', async () => {
  const ledger = new RunsLedger(`${TMP}/j19.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('c'),
    verifyByCommand: { 'npm test': { exitCode: 2, stdout: 'total gibberish output' } },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute({ task_id: 'diag2', task: 'x', verify: ['npm test'] }, agentExec())
  assert.equal(value.verify[0].signals.degraded, true)
  assert.match(renderDigest(value), /降级为 tail/)
})

await ta('verdict 扩到五种：stale 可独立到达，原有四种语义不变', async () => {
  const ledger = new RunsLedger(`${TMP}/j22.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('c'),
    verifyByCommand: {
      'ok': { exitCode: 0, stdout: 'fine' },
      'bad': { exitCode: 1, stdout: 'see src/x.ts:1:1' },
      'fixed': { exitCode: 0, stdout: 'baseline already green' },
    },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const pass = await getDef().execute({ task_id: 'v-pass', task: 'x', verify: ['ok'] }, agentExec())
  const fail = await getDef().execute({ task_id: 'v-fail', task: 'x', verify: ['bad'] }, agentExec())
  const unverified = await getDef().execute({ task_id: 'v-un', task: 'x' }, agentExec())
  const stale = await getDef().execute(
    { task_id: 'v-stale', task: 'x', verify_baseline: ['fixed'], verify: ['ok'] },
    agentExec(),
  )
  assert.equal(pass.verdict, 'pass')
  assert.equal(fail.verdict, 'fail')
  assert.equal(unverified.verdict, 'unverified')
  assert.equal(stale.verdict, 'stale')
  // 四种老结论 + 新增 stale：取值集合扩大到 5，且 stale 不会与任何老结论撞车。
  const reached = new Set([pass.verdict, fail.verdict, unverified.verdict, stale.verdict])
  assert.equal(reached.size, 4)
  assert.equal(reached.has('stale'), true)
})

await ta('wolf_status：只读（不 spawn 任何进程），列出 round/verdict/token/conversation_id', async () => {
  const ledger = new RunsLedger(`${TMP}/j20.ndjson`)
  await ledger.record({
    taskId: 'alpha',
    round: 2,
    conversationId: 'c-alpha',
    verdict: 'fail',
    stopReason: 'completed',
    tokens: 1200,
    changedFiles: ['a.js'],
  })
  await ledger.record({ taskId: 'beta', round: 1, tokens: 300 })

  const ctx = fakeCtx({})
  const status = captureTool(ctx)
  delegateMod.registerWolfStatus(ctx, baseConfig(ledger))
  const value = await status().execute({}, {})

  // 只读的直接证据：一次进程都没起。
  assert.equal(ctx.calls.agy.length, 0)
  assert.equal(ctx.calls.verify.length, 0)
  assert.equal(value.total, 2)
  assert.equal(value.truncated, false)

  const alpha = value.tasks.find(task => task.task_id === 'alpha')
  assert.equal(alpha.round, 2)
  assert.equal(alpha.last_verdict, 'fail')
  assert.equal(alpha.total_tokens, 1200)
  assert.equal(alpha.has_conversation_id, true)
  assert.equal(alpha.changed_files_count, 1)
  const beta = value.tasks.find(task => task.task_id === 'beta')
  assert.equal(beta.has_conversation_id, false)
  assert.match(delegateMod.renderStatus(value), /wolf_status/)
})

await ta('wolf_status：limit 有上限并标记截断，task_id 可收窄', async () => {
  const ledger = new RunsLedger(`${TMP}/j21.ndjson`)
  for (let index = 0; index < 25; index += 1) {
    await ledger.record({ taskId: `t-${String(index).padStart(2, '0')}`, round: 1, tokens: 10 })
  }
  const ctx = fakeCtx({})
  const status = captureTool(ctx)
  delegateMod.registerWolfStatus(ctx, baseConfig(ledger))

  const limited = await status().execute({ limit: 5 }, {})
  assert.equal(limited.tasks.length, 5)
  assert.equal(limited.total, 25)
  assert.equal(limited.truncated, true)
  assert.equal(limited.limit, 5)

  const huge = await status().execute({ limit: 10_000 }, {})
  assert.equal(huge.limit, delegateMod.MAX_STATUS_LIMIT)
  assert.equal(huge.tasks.length, 25)
  assert.equal(huge.truncated, false)

  const single = await status().execute({ task_id: 't-07' }, {})
  assert.deepEqual(single.tasks.map(task => task.task_id), ['t-07'])
  assert.equal(single.total, 1)
  assert.equal(single.truncated, false)

  const nonsense = await status().execute({ limit: -3 }, {})
  assert.equal(nonsense.limit, 1)
  assert.equal(nonsense.tasks.length, 1)
})

/* ── K. tests/run.mjs 的 staging 根开关 ───────────────────────────── */

console.log('\nK. staging 根开关（测试运行器自举）')

/**
 * 动态加载 run.mjs——「staged 目录里有没有 run.mjs」本身就是被测行为之一
 * （旧运行器不会把它复制进 staging）。用静态 import 会让整份用例在**加载期**
 * 就挂掉，红基线于是无法逐条归因；动态 import 让缺失表现为单条用例失败。
 */
const loadRunMod = () => import('./run.mjs')

/**
 * 造一个**确定性**的依赖源：三个最小 peer 包。
 *
 * 为什么必须有它：旧用例靠继承操作者 shell 的 DSH_HOME 才通过——那是把环境依赖
 * 当成了被测行为（reviewer 判为「验收空转」）。用测试自己造的源，正反两个方向
 * 都由用例自己控制，且不碰真的 node_modules。
 *
 * @param {string} dshHome - 要伪装成 DSH 主目录的路径
 * @returns {string} 同一个路径（便于链式书写）
 */
function makeFakeDepsSource(dshHome) {
  for (const name of ['dsh-subagent', 'dsh-tools', 'schemastery']) {
    const pkgDir = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0', main: 'index.js' }),
      'utf8',
    )
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {}\n', 'utf8')
  }
  return dshHome
}

await ta('staging 根：WP_TEST_HOME 覆盖优先，未设置时逐字回退 DSH_HOME', async () => {
  const runMod = await loadRunMod()

  const override = runMod.resolveStagingRoot({ WP_TEST_HOME: 'C:/temp/wp-home', DSH_HOME: 'C:/real/.dsh' })
  assert.equal(override.ok, true)
  assert.equal(override.source, runMod.STAGING_ROOT_ENV)
  const overrideStaging = join(override.root, 'profiles', runMod.STAGING_DIRNAME).replace(/\\/g, '/')
  assert.ok(overrideStaging.endsWith('wp-home/profiles/wptest'), overrideStaging)
  // 开关生效：不再落到 DSH_HOME 上。
  assert.equal(overrideStaging.includes('real'), false)

  // 未设置开关 → 与改动前逐字一致：$DSH_HOME/profiles/wptest
  const fallback = runMod.resolveStagingRoot({ DSH_HOME: 'C:/real/.dsh' })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.source, 'DSH_HOME')
  assert.equal(
    join(fallback.root, 'profiles', runMod.STAGING_DIRNAME).replace(/\\/g, '/'),
    'C:/real/.dsh/profiles/wptest',
  )

  // 两个都没有 → 明确报错（不是静默落到相对路径）。
  const missing = runMod.resolveStagingRoot({})
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /DSH_HOME/)
  assert.match(missing.reason, new RegExp(runMod.STAGING_ROOT_ENV))

  // 关键边界（t8 的硬约束）：依赖源回退**不得**泄漏到 staging 根语义上——
  // 未设置开关时仍然只认 DSH_HOME，不看 USERPROFILE/HOME。
  const profileOnlyRoot = runMod.resolveStagingRoot({ USERPROFILE: 'C:/Users/u' })
  assert.equal(profileOnlyRoot.ok, false)
})

await ta('staging 根：有源 → junction 建成，且 host 依赖真的解析得到（不依赖继承环境）', async () => {
  const runMod = await loadRunMod()
  // 依赖源用测试自己造的目录，不继承操作者 shell 的 DSH_HOME。
  const base = `${process.env.TEMP}/wolfpack-deps-source-${process.pid}-${Date.now()}`
  const source = makeFakeDepsSource(join(base, 'fake-dsh'))
  const root = join(base, 'staging-root')
  const staging = join(root, 'profiles', runMod.STAGING_DIRNAME)
  await mkdir(staging, { recursive: true })
  try {
    assert.equal(existsSync(join(root, 'profiles', 'node_modules')), false)

    const peers = await runMod.ensurePeerModules(root, { DSH_HOME: source })
    assert.equal(peers.ok, true)
    assert.equal(peers.action, 'junction')
    assert.ok(String(peers.source).includes('fake-dsh'), String(peers.source))

    // 直接证据一：链接建好之后，目录里真能看到 peer 包。
    assert.equal(existsSync(join(peers.path, '@deepseek-ai', 'dsh-subagent')), true)
    // 直接证据二：host 用例真的能解析到它们（不是只看目录存在）。
    const resolution = runMod.verifyPeerResolution(staging)
    assert.equal(resolution.ok, true, resolution.ok === true ? '' : resolution.reason)
    for (const name of runMod.PEER_PACKAGES) {
      assert.ok(resolution.resolved[name].length > 0, `${name} 解析结果为空`)
    }

    // 第二次必须是 no-op：不能每次跑都重建链接。
    const again = await runMod.ensurePeerModules(root, { DSH_HOME: source })
    assert.equal(again.action, 'present')

    // 只摘链接（rmdir 对 junction 是 link-only），造的源目录必须完好。
    spawnSync('cmd', ['/c', 'rmdir', peers.path], { stdio: 'ignore' })
    assert.equal(existsSync(peers.path), false)
    assert.equal(existsSync(join(source, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-subagent')), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await ta('staging 根：DSH_HOME 未设 + 默认主目录存在 → 走 USERPROFILE 回退补上依赖（场景 A）', async () => {
  const runMod = await loadRunMod()
  const base = `${process.env.TEMP}/wolfpack-deps-profile-${process.pid}-${Date.now()}`
  // 造一个「主目录」：依赖装在 <home>\.dsh\profiles\node_modules ——
  // 正是 USERPROFILE 回退要找的位置。
  const home = makeFakeDepsSource(join(base, 'home', '.dsh'))
  const root = join(base, 'staging-root')
  const staging = join(root, 'profiles', runMod.STAGING_DIRNAME)
  await mkdir(staging, { recursive: true })
  try {
    // env 里**故意没有 DSH_HOME**：这就是「真·干净环境」的定义，也是 t8 的缺陷场景。
    // 旧实现只认 DSH_HOME，在这里直接报「找不到可链接的源」——开关在最需要它的场景失效。
    const peers = await runMod.ensurePeerModules(root, { USERPROFILE: join(base, 'home'), HOME: '' })
    assert.equal(peers.ok, true, peers.ok === true ? '' : peers.reason)
    assert.equal(peers.action, 'junction')
    assert.ok(String(peers.source).includes('home'), String(peers.source))

    // 补上之后依赖必须真的解析得到（不是只看目录存在）。
    const resolution = runMod.verifyPeerResolution(staging)
    assert.equal(resolution.ok, true, resolution.ok === true ? '' : resolution.reason)

    spawnSync('cmd', ['/c', 'rmdir', join(root, 'profiles', 'node_modules')], { stdio: 'ignore' })
    assert.equal(existsSync(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools')), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await ta('staging 根：候选链全不可达时明确报错，不让干净环境第一次跑假失败', async () => {
  const runMod = await loadRunMod()
  const base = `${process.env.TEMP}/wolfpack-staging-probe-missing-${process.pid}-${Date.now()}`
  const root = join(base, 'staging-root')
  await mkdir(root, { recursive: true })
  try {
    // 显式传入「没有 USERPROFILE/HOME 回退」的 env：这条用例断言的是候选链全不可达
    // 时的诊断，不能靠继承来的 USERPROFILE 偷偷提供一个源。
    const result = await runMod.ensurePeerModules(root, {
      DSH_HOME: join(base, 'no-such-dsh-home'),
      USERPROFILE: '',
      HOME: '',
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /node_modules/)
    assert.match(result.reason, /DSH_HOME/)
    // 硬要求：不许把 Node 的原始解析错误当成结论。
    assert.equal(result.reason.includes('ERR_MODULE_NOT_FOUND'), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await ta('依赖源回退链：DSH_HOME → USERPROFILE\\.dsh → HOME\\.dsh（纯函数、显式 env）', async () => {
  const runMod = await loadRunMod()
  const norm = value => value.replace(/\\/g, '/').toLowerCase()

  // 干净环境（DSH_HOME 未设）也必须有候选——这正是 t8 的缺陷场景：
  // 开关本该在最需要它的场景里起作用，旧实现却在这里返回空候选。
  const profileOnly = runMod.depsSourceCandidates({ USERPROFILE: 'C:/Users/u' })
  assert.equal(profileOnly.length, 1)
  assert.ok(norm(profileOnly[0]).endsWith('c:/users/u/.dsh/profiles/node_modules'), profileOnly[0])

  const homeOnly = runMod.depsSourceCandidates({ HOME: '/home/h' })
  assert.equal(homeOnly.length, 1)
  assert.ok(norm(homeOnly[0]).includes('/home/h/.dsh/'), homeOnly[0])

  // 优先级：显式 DSH_HOME 永远排第一，USERPROFILE 次之。
  const all = runMod.depsSourceCandidates({ DSH_HOME: 'C:/a', USERPROFILE: 'C:/Users/u', HOME: '/home/h' })
  assert.equal(all.length, 3)
  assert.ok(norm(all[0]).endsWith('c:/a/profiles/node_modules'), all[0])
  assert.ok(norm(all[1]).includes('/users/u/.dsh/'), all[1])

  // 空环境 → 没有候选（不是静默落到相对路径）。
  assert.deepEqual(runMod.depsSourceCandidates({}), [])
})

await ta('staging 根：目录在但依赖解析不到 → 给自己的诊断，绝不把 ERR_MODULE_NOT_FOUND 抛出来', async () => {
  const runMod = await loadRunMod()
  const root = `${process.env.TEMP}/wolfpack-staging-decoy-${process.pid}-${Date.now()}`
  const staging = join(root, 'profiles', runMod.STAGING_DIRNAME)
  // 诱饵：profiles/node_modules 存在但是空的——只看「目录存在」的实现会误判成依赖就绪。
  await mkdir(join(root, 'profiles', 'node_modules'), { recursive: true })
  await mkdir(staging, { recursive: true })
  try {
    const peers = await runMod.ensurePeerModules(root, { DSH_HOME: join(root, 'no-such-dsh-home') })
    assert.equal(peers.ok, true)
    assert.equal(peers.action, 'present')

    const resolution = runMod.verifyPeerResolution(staging)
    assert.equal(resolution.ok, false)
    assert.match(resolution.reason, /@deepseek-ai\/dsh-subagent/)
    assert.match(resolution.reason, /WP_TEST_HOME/)
    // 硬要求：不许把 Node 的原始解析错误当成结论。
    assert.equal(resolution.reason.includes('ERR_MODULE_NOT_FOUND'), false)
    assert.equal(resolution.reason.includes('Cannot find module'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ── L. repair-round-2（F1 文件身份 / F2 用量不可得兜底 / F3 基线超时）── */

console.log('\nL. repair-round-2（F1–F3）')

await ta('台账增量读：同路径被换成**更大**的不同内容 → 必须全量重读，不能返回陈旧态（F1）', async () => {
  const path = `${TMP}/l1-rotate.ndjson`
  const ledger = new RunsLedger(path)
  await ledger.record({ taskId: 'old-a', round: 1, conversationId: 'c-old-a' })
  await ledger.record({ taskId: 'old-b', round: 1, conversationId: 'c-old-b' })
  await ledger.read()
  assert.equal(ledger.stats.fullParses, 1)
  const cachedSize = ledger.cachedSize
  assert.ok(cachedSize > 0, `游标应已推进：${cachedSize}`)

  // 同一路径、**更大**的不同内容：size 与 mtime 都会「看起来像追加」，
  // 只有文件身份（ino/birthtime）或游标前 anchor 能识破它。
  const fresh = [
    JSON.stringify({ at: 10, taskId: 'new-1', round: 1, conversationId: 'c-new-1', tokens: 5 }),
    JSON.stringify({ at: 11, taskId: 'new-2', round: 1, conversationId: 'c-new-2' }),
    `"${'x'.repeat(cachedSize)}"`,
  ].join('\n') + '\n'
  assert.ok(fresh.length > cachedSize, `新内容必须比游标更大：${fresh.length} vs ${cachedSize}`)
  writeFileSync(path, fresh, 'utf8')

  const after = await ledger.read()
  assert.equal(after.has('old-a'), false)
  assert.equal(after.has('old-b'), false)
  assert.deepEqual([...after.keys()].sort(), ['new-1', 'new-2'])
  assert.equal(after.get('new-1').conversationId, 'c-new-1')
  assert.equal(ledger.stats.fullParses, 2, '必须降级为全量重读')
})

await ta('台账增量读：同路径 / 同大小 / 同 mtime 的原地改写 → 命中路径也必须过 anchor（T11）', async () => {
  const path = `${TMP}/l3-inplace.ndjson`
  const line = (at, taskId, conversationId) => JSON.stringify({ at, taskId, round: 1, conversationId })
  const original = `${line(1, 'stale-task', 'c-stale')}\n${line(2, 'stale-task-2', 'c-stale-2')}\n`
  const replaced = `${line(3, 'fresh-task', 'c-fresh')}\n${line(4, 'fresh-task-2', 'c-fresh-2')}\n`
  assert.equal(replaced.length, original.length, '本用例要求新旧内容等长，否则测的不是命中路径')

  writeFileSync(path, original, 'utf8')
  const before = statSync(path)
  const ledger = new RunsLedger(path)
  assert.deepEqual([...(await ledger.read()).keys()].sort(), ['stale-task', 'stale-task-2'])
  assert.equal(ledger.stats.fullParses, 1)

  // 原地改写成等长的不同内容（size 不变 = 走不到「size 变大」那条路），
  // 并把 mtime 尽量复原回原值。
  writeFileSync(path, replaced, 'utf8')
  utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000)

  // 注意：Windows 上 utimesSync 复原 mtime 有**亚毫秒**误差（实测 .4592 vs .4587），
  // 而那个误差本身就会把读推去全量重读，让用例测不到命中路径。
  // 所以把缓存里的身份对齐成文件**现在**的样子：size / mtime / ino 全部一致，
  // 唯一不同的是游标前 32 字节——这才是精确的「同路径 + 同大小 + 同 mtime 原地改写」。
  const now = statSync(path)
  assert.equal(now.size, ledger.cachedSize, '大小必须相同，否则测不到命中路径')
  ledger.cachedMtimeMs = now.mtimeMs
  ledger.cachedIno = now.ino
  ledger.cachedBirthtimeMs = now.birthtimeMs
  assert.equal(ledger.cachedMtimeMs, now.mtimeMs, 'mtime 必须与文件一致，否则测不到命中路径')

  const after = await ledger.read()
  assert.equal(after.has('stale-task'), false)
  assert.equal(after.has('stale-task-2'), false)
  assert.deepEqual([...after.keys()].sort(), ['fresh-task', 'fresh-task-2'])
  assert.equal(after.get('fresh-task').conversationId, 'c-fresh')
  assert.equal(ledger.stats.fullParses, 2, '必须降级为全量重读，而不是命中陈旧缓存')
  assert.equal(ledger.stats.cacheHits, 0, '命中路径必须被 anchor 拦下')
})

await ta('用量不可得兜底：连续 N 轮拿不到 tokens → 第 N+1 轮退回轮数判断（F2）', async () => {
  const ledger = new RunsLedger(`${TMP}/l2-unknown-usage.ndjson`)
  const cap = 3
  for (let index = 0; index < cap; index += 1) {
    // 故意**不带 tokens**：模拟 agy 不报用量
    await ledger.record({ taskId: 'nu', round: index + 1, conversationId: 'c-nu' })
  }
  const state = await ledger.latest('nu')
  assert.equal(state.usageMissingRounds, cap)
  assert.equal(state.totalTokens, 0)

  const decision = resolveContinuation({
    config: { continuationTokenBudget: 1_000_000, unknownUsageRoundCap: cap },
    previous: state,
  })
  assert.equal(decision.continuing, false)
  assert.equal(decision.freshReason, `unknown-usage-round-cap(${cap})`)

  // 默认上限 20，且理由文本里是**真实数字**（不是编造的用量）。
  const defaulted = resolveContinuation({
    config: { continuationTokenBudget: 1_000_000 },
    previous: { conversationId: 'c-nu', round: 20, usageMissingRounds: 20 },
  })
  assert.equal(defaulted.freshReason, 'unknown-usage-round-cap(20)')

  // 一旦拿到真用量，计数归零、恢复续跑——不能因为一次缺失就永久杀。
  await ledger.record({ taskId: 'nu', round: cap + 1, conversationId: 'c-nu', tokens: 123 })
  const resumedState = await ledger.latest('nu')
  assert.equal(resumedState.usageMissingRounds, 0)
  const resumed = resolveContinuation({
    config: { continuationTokenBudget: 1_000_000, unknownUsageRoundCap: cap },
    previous: resumedState,
  })
  assert.equal(resumed.continuing, true)
})

t('基线闸门：失败全因超时 → error（没建立「问题存在」的前提就不派活）（F3b）', () => {
  const allTimedOut = runnerMod.evaluateBaseline([
    { command: 'slow-a', ran: true, ok: false, exitCode: null, timedOut: true },
    { command: 'slow-b', ran: true, ok: false, exitCode: null, timedOut: true },
  ])
  assert.equal(allTimedOut.decision, 'error')
  assert.equal(allTimedOut.reason, '基线命令超时，无法判定问题是否存在（工具故障，不是「问题还在」）')

  // 只要有一条「正常失败」，就说明问题确实存在 → 仍然可以派活。
  const mixed = runnerMod.evaluateBaseline([
    { command: 'slow-a', ran: true, ok: false, exitCode: null, timedOut: true },
    { command: 'fast-b', ran: true, ok: false, exitCode: 1 },
  ])
  assert.equal(mixed.decision, 'proceed')

  // 超时 + 另一条已通过：R3-F4 裁定后判 **stale**——`ok:true` 本身已经证明问题不存在，
  // 超时那条什么都没证明，但不能反过来把「已经修好了」报成工具故障。
  const withPass = runnerMod.evaluateBaseline([
    { command: 'slow-a', ran: true, ok: false, exitCode: null, timedOut: true },
    { command: 'fixed', ran: true, ok: true, exitCode: 0 },
  ])
  assert.equal(withPass.decision, 'stale')
})

t('digest：基线命令超时 → 摘要里标出「, 超时」，不把超时读成「问题还在」（F3a）', () => {
  const text = renderDigest({
    task_id: 't', round: 1, continued: false, stop_reason: 'skipped', report: '',
    changed_files: [], changed_files_determined: true, verify: [], verdict: 'error',
    baseline: [{ command: 'slow-baseline', ran: true, ok: false, timed_out: true }],
  })
  assert.match(text, /slow-baseline/)
  assert.match(text, /, 超时/)
})

/* ── M. R3 复审修复（R3-F1 声明诚实性 / R3-F2 stale 字段 / R3-F3 env 接线 / R3-F4 判定顺序）── */

console.log('\nM. R3 复审修复（F1–F4）')

await ta('台账增量读（对抗变体）：差异只在头部、尾 32B 相同 → 也不得返回陈旧态（R3-F1）', async () => {
  const path = `${TMP}/m1-head-diff.ndjson`
  const line = (at, taskId, conversationId) => JSON.stringify({ at, taskId, round: 1, conversationId })
  // 只改**第一行**的 taskId（等长替换），因此文件尾 32B 与原内容完全一致：
  // 尾锚（游标前 32B）挡不住它，只有头部锚能识破——正是 R3-F1 指出的缺口。
  const original = `${line(1, 'stale-task', 'c-stale')}\n${line(2, 'tail-anchor-task', 'c-tail')}\n`
  const replaced = `${line(3, 'fresh-task', 'c-fresh')}\n${line(2, 'tail-anchor-task', 'c-tail')}\n`
  assert.equal(replaced.length, original.length, '等长替换：size 不变')
  assert.equal(replaced.slice(-32), original.slice(-32), '尾 32B 必须完全相同（这就是本变体的对抗点）')
  assert.notEqual(replaced.slice(0, 32), original.slice(0, 32), '头部必须不同，否则本用例测不到头部锚')

  writeFileSync(path, original, 'utf8')
  const ledger = new RunsLedger(path)
  assert.deepEqual([...(await ledger.read()).keys()].sort(), ['stale-task', 'tail-anchor-task'])

  writeFileSync(path, replaced, 'utf8')
  // 对齐缓存身份（size/mtime/ino），把命中条件压缩到只剩两个 anchor。
  const now = statSync(path)
  assert.equal(now.size, ledger.cachedSize, '大小必须相同，否则测不到命中路径')
  ledger.cachedMtimeMs = now.mtimeMs
  ledger.cachedIno = now.ino
  ledger.cachedBirthtimeMs = now.birthtimeMs

  const after = await ledger.read()
  assert.equal(after.has('stale-task'), false)
  assert.deepEqual([...after.keys()].sort(), ['fresh-task', 'tail-anchor-task'])
  assert.equal(ledger.stats.fullParses, 2, '必须降级为全量重读')
  assert.equal(ledger.stats.cacheHits, 0, '头部锚必须拦下这次命中')
})

await ta('工具：verify_baseline 已过 → verdict=stale 时 changed_files_determined 必须为 false（R3-F2）', async () => {
  const ledger = new RunsLedger(`${TMP}/m2-stale-field.ndjson`)
  const ctx = fakeCtx({ verifyByCommand: { 'exit 0': { exitCode: 0, stdout: 'already fixed' } } })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))
  const value = await getDef().execute(
    { task_id: 'stale-field-task', task: 'x', verify_baseline: ['exit 0'], verify: ['echo ok'] },
    agentExec(),
  )
  assert.equal(value.verdict, 'stale')
  assert.equal(value.baseline[0].ok, true)
  assert.equal(ctx.calls.agy.length, 0, 'stale 时不该起 agy')
  // 本轮根本没探测磁盘（agy 都没启动）：这个字段必须是 false，
  // 否则读结构化字段的消费者会把「没探测」读成「已确认没有改动」。
  // 注意：wolf_status 报的是台账里累计的改动文件，不受这个字段影响；它只影响工具返回值。
  assert.equal(value.changed_files_determined, false)
  assert.deepEqual(value.changed_files, [])
})

await ta('环境接线：WOLFPACK_UNKNOWN_USAGE_CAP 可调、可关（R3-F3）', async () => {
  const indexMod = await import('./index.js')
  assert.equal(indexMod.unknownUsageRoundCap({}), indexMod.DEFAULT_UNKNOWN_USAGE_CAP)
  assert.equal(indexMod.unknownUsageRoundCap({ WOLFPACK_UNKNOWN_USAGE_CAP: '5' }), 5)
  assert.equal(indexMod.unknownUsageRoundCap({ WOLFPACK_UNKNOWN_USAGE_CAP: 'off' }), 0)
  assert.equal(indexMod.unknownUsageRoundCap({ WOLFPACK_UNKNOWN_USAGE_CAP: 'none' }), 0)
  assert.equal(indexMod.unknownUsageRoundCap({ WOLFPACK_UNKNOWN_USAGE_CAP: '0' }), 0)
  assert.equal(indexMod.unknownUsageRoundCap({ WOLFPACK_UNKNOWN_USAGE_CAP: '垃圾' }), indexMod.DEFAULT_UNKNOWN_USAGE_CAP)

  // cap=0（off）→ 兜底彻底关闭：用量不可得再多也不因它冷启动。
  const disabled = resolveContinuation({
    config: { continuationTokenBudget: 1_000_000, unknownUsageRoundCap: 0 },
    previous: { conversationId: 'c-many', round: 99, usageMissingRounds: 999 },
  })
  assert.equal(disabled.continuing, true)
  assert.equal(disabled.freshReason, undefined)

  // 调小 → 按新值生效，理由里带真实数字。
  const tuned = resolveContinuation({
    config: { continuationTokenBudget: 1_000_000, unknownUsageRoundCap: 2 },
    previous: { conversationId: 'c-many', round: 2, usageMissingRounds: 2 },
  })
  assert.equal(tuned.freshReason, 'unknown-usage-round-cap(2)')
})

t('基线闸门：baseline 里已有一条通过 + 另一条超时 → stale（不是 error）（R3-F4）', () => {
  const mixed = runnerMod.evaluateBaseline([
    { command: 'slow-baseline', ran: true, ok: false, exitCode: null, timedOut: true },
    { command: 'already-fixed', ran: true, ok: true, exitCode: 0 },
  ])
  assert.equal(mixed.decision, 'stale')
  assert.match(mixed.reason, /已经通过/)
  assert.match(mixed.reason, /另有基线命令超时/)

  // 没有任何命令通过时，仍然按「全因超时 → error」处理。
  const allTimedOut = runnerMod.evaluateBaseline([
    { command: 'slow-baseline', ran: true, ok: false, exitCode: null, timedOut: true },
  ])
  assert.equal(allTimedOut.decision, 'error')
})

/* ── N. 停滞监控：只报警，永不终止 ─────────────────────────────────── */

console.log('\nN. 停滞监控（只报警，永不终止）')

const stallMod = await import('./stall-monitor.js')

t('停滞窗口默认 5 分钟、3 次报警、通知默认开（可用环境变量覆盖）', () => {
  const base = stallMod.resolveStallConfig({ USERPROFILE: 'C:/u' })
  assert.equal(base.windowMs, 5 * 60 * 1000)
  assert.equal(base.maxWarnings, 3)
  assert.equal(base.toast, true)
  assert.equal(base.storeRoot, join('C:/u', '.gemini', 'antigravity-cli'))

  const tuned = stallMod.resolveStallConfig({
    USERPROFILE: 'C:/u',
    WOLFPACK_STALL_WINDOW: '60',
    WOLFPACK_STALL_WARNINGS: '2',
    WOLFPACK_STALL_TOAST: 'off',
  })
  assert.equal(tuned.windowMs, 60_000)
  assert.equal(tuned.maxWarnings, 2)
  assert.equal(tuned.toast, false)

  // off/0 = 关闭监控；垃圾值回退默认（不能把「配错了」读成「立刻报警」）。
  assert.equal(stallMod.resolveStallConfig({ WOLFPACK_STALL_WINDOW: 'off' }).windowMs, 0)
  assert.equal(stallMod.resolveStallConfig({ WOLFPACK_STALL_WINDOW: '垃圾' }).windowMs, 5 * 60 * 1000)
})

t('停滞判定：第 n 次报警发生在第 n 个窗口末尾，报满 maxWarnings 后交给（exhausted）', () => {
  const window = 300_000
  const at = (silentMs, warningsSent, maxWarnings = 3) =>
    stallMod.stallDecision({ silentMs, windowMs: window, warningsSent, maxWarnings })

  // 一个窗口都没到 → 绝不报警。这条是「不误报正常干活」的下限。
  assert.deepEqual(at(299_999, 0), { warn: false, level: 0, exhausted: false })
  assert.equal(at(300_000, 0).level, 1)
  assert.equal(at(600_000, 1).level, 2)
  assert.equal(at(900_000, 2).level, 3)
  // 报满 3 次之后不再打扰，进入 exhausted（决定权交回人）。
  assert.deepEqual(at(1_800_000, 3), { warn: false, level: 3, exhausted: true })
  // 窗口为 0 = 关闭监控。
  assert.deepEqual(stallMod.stallDecision({ silentMs: 1e9, windowMs: 0, warningsSent: 0, maxWarnings: 3 }), { warn: false, level: 0, exhausted: false })
})

await ta('采样：已知会话 id 时读 transcript 的 mtime；存储不存在时如实报不可观测', async () => {
  const root = `${TMP}/stall-store`
  const logs = join(root, 'brain', 'conv-1', '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const transcript = join(logs, 'transcript.jsonl')
  writeFileSync(transcript, '{"step_index":1}\n')
  utimesSync(transcript, new Date(1_700_000_000_000), new Date(1_700_000_000_000))

  const seen = await stallMod.sampleProgress({ storeRoot: root, conversationIds: ['conv-1'] })
  assert.equal(seen.available, true)
  assert.equal(Math.round(seen.mtimeMs), 1_700_000_000_000)

  const missing = await stallMod.sampleProgress({ storeRoot: `${TMP}/no-such-store`, conversationIds: ['conv-1'] })
  assert.deepEqual(missing, { available: false, mtimeMs: 0 })
  assert.deepEqual(await stallMod.sampleProgress({ storeRoot: undefined }), { available: false, mtimeMs: 0 })
})

await ta('停滞监控：先有心跳、再 1/2/3 次报警、之后闭嘴；**从不终止**', async () => {
  const root = `${TMP}/stall-live`
  const logs = join(root, 'brain', 'conv-live', '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  writeFileSync(join(logs, 'transcript.jsonl'), '{"step_index":1}\n')

  const warnings = []
  const clock = { at: 1_000_000 }
  const monitor = stallMod.createStallMonitor({
    storeRoot: root,
    conversationIds: ['conv-live'],
    windowMs: 1_000,
    maxWarnings: 3,
    now: () => clock.at,
    onWarning: warning => warnings.push(warning.level),
  })

  await monitor.poll()                 // 首次采样：确认有心跳，从此刻起算
  clock.at += 1_500
  await monitor.poll()                 // 1.5 个窗口 → 第 1 次
  clock.at += 1_000
  await monitor.poll()                 // 2.5 个窗口 → 第 2 次
  clock.at += 1_000
  await monitor.poll()                 // 3.5 个窗口 → 第 3 次
  clock.at += 60_000
  await monitor.poll()                 // 远超窗口 → 不再打扰
  await monitor.poll()

  assert.deepEqual(warnings, [1, 2, 3])
  const snap = monitor.snapshot()
  assert.equal(snap.warnings, 3)
  assert.equal(snap.exhausted, true)
  assert.equal(snap.unavailable, false)
  // 结构性保证：这个对象根本没有终止能力。加回「到点就杀」必须先改这条。
  assert.equal('terminate' in monitor, false)
  assert.equal('kill' in monitor, false)
})

await ta('进展恢复 → 开新回合，报警额度重置（假警报不累计）', async () => {
  const root = `${TMP}/stall-recover`
  const logs = join(root, 'brain', 'conv-r', '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const transcript = join(logs, 'transcript.jsonl')
  writeFileSync(transcript, 'a\n')
  // 文件 mtime 必须落在**假时钟的同一坐标轴**上，否则「后来的写入」看起来比
  // 初始写入还早，进展检测会假阴性。
  utimesSync(transcript, new Date(1_000), new Date(1_000))

  const warnings = []
  const clock = { at: 5_000_000 }
  const monitor = stallMod.createStallMonitor({
    storeRoot: root,
    conversationIds: ['conv-r'],
    windowMs: 1_000,
    maxWarnings: 3,
    now: () => clock.at,
    onWarning: warning => warnings.push(warning.level),
  })

  await monitor.poll()
  clock.at += 2_000
  await monitor.poll()                       // 第 1 次
  // agy 又写了一步 → 这不是真的卡住。
  utimesSync(transcript, new Date(clock.at + 1_000), new Date(clock.at + 1_000))
  await monitor.poll()
  const recovered = monitor.snapshot()
  assert.equal(recovered.warnings, 0)
  assert.equal(recovered.episodes, 1)

  clock.at += 1_500
  await monitor.poll()                       // 新回合的第 1 次
  assert.deepEqual(warnings, [1, 1])
})

await ta('拿不到任何心跳证据时绝不报警：把「看不到」说成「卡住了」是最坏的假信息', async () => {
  const warnings = []
  const clock = { at: 0 }
  const monitor = stallMod.createStallMonitor({
    storeRoot: `${TMP}/definitely-missing-store`,
    conversationIds: ['ghost'],
    windowMs: 10,
    maxWarnings: 3,
    now: () => clock.at,
    onWarning: warning => warnings.push(warning.level),
  })
  for (let i = 0; i < 5; i += 1) {
    clock.at += 100_000
    await monitor.poll()
  }
  assert.deepEqual(warnings, [])
  assert.equal(monitor.snapshot().unavailable, true)
})

t('存储根缺席 = 监控整体不启用（start 返回 false，没有静默降级）', () => {
  const monitor = stallMod.createStallMonitor({ storeRoot: undefined, windowMs: 1_000 })
  assert.equal(monitor.start(), false)
  assert.equal(monitor.snapshot().enabled, false)
  assert.equal(monitor.stop(), undefined)
})

await ta('停滞台账：NDJSON 追加，写不进去也不抛（通知失败不该影响任何流程）', async () => {
  const path = `${TMP}/stall.ndjson`
  assert.equal(await stallMod.appendStallRecord(path, { at: 1, taskId: 't', level: 1, action: 'warn-only' }), true)
  assert.equal(await stallMod.appendStallRecord(path, { at: 2, taskId: 't', level: 2, action: 'warn-only' }), true)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]).action, 'warn-only')
  // 路径非法/不可写：返回 false，不抛。
  assert.equal(await stallMod.appendStallRecord('', {}), false)
  assert.equal(await stallMod.appendStallRecord(join(TMP, 'no-such-dir', 'x.ndjson'), {}), false)
})

t('系统通知脚本：单引号转义正确（消息里带引号不能把脚本拆了）', () => {
  const script = stallMod.stallToastScript("狼群's test", "it's stuck")
  assert.match(script, /'狼群''s test'/)
  assert.match(script, /'it''s stuck'/)
  assert.equal(script.includes('ShowBalloonTip'), true)
})

await ta('startAgy：带 stallStoreRoot 时监控启用，结果里如实带回快照', async () => {
  const ledger = new RunsLedger(`${TMP}/n1.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: agyJson('conv-N') })
  const storeRoot = `${TMP}/stall-run`
  await mkdir(join(storeRoot, 'brain', 'conv-N', '.system_generated', 'logs'), { recursive: true })
  writeFileSync(join(storeRoot, 'brain', 'conv-N', '.system_generated', 'logs', 'transcript.jsonl'), 'x\n')
  const run = await startAgy({
    ctx,
    config: {
      agyPath: 'agy.exe',
      ledger,
      graceMs: 1000,
      stallStoreRoot: storeRoot,
      stallLogPath: `${TMP}/stall-run.ndjson`,
      stall: { windowMs: 60_000, maxWarnings: 3, pollMs: 30_000, toast: false },
    },
    taskId: 'stall-task',
    cwd: 'C:/repo',
    task: 'x',
  })
  const out = await run.result
  assert.equal(out.stall.enabled, true)
  assert.equal(out.stall.warnings, 0)
  assert.equal(out.stall.unavailable, false)
})

t('digest：停滞报警次数被如实交代，并写明「没有被自动终止」', () => {
  const text = renderDigest({
    task_id: 't', round: 1, continued: false, stop_reason: 'completed', report: 'ok',
    changed_files: [], changed_files_determined: true, verify: [
      { command: 'npm test', ran: true, ok: true, exit_code: 0 },
    ], verdict: 'pass', stall_warnings: 2,
  })
  assert.match(text, /疑似停滞报警 2 次/)
  assert.match(text, /没有被自动终止/)
})

await rm(TMP, { recursive: true, force: true })

/* ── O. 活运行注册表与 killRun API ──────────────────────────────────── */

console.log('\nO. 活运行注册表与 killRun API')

/**
 * 一个不会自己结束的进程 seam，同时记录「terminate() 被调用过」。
 * 用来断言「确实发生了杀进程树」这个动作。
 */
function killableCtx() {
  const state = { spec: undefined, settled: false, terminateCalled: 0 }
  const ctx = {
    calls: { git: [], agy: [], verify: [] },
    get(name) { return name === 'subprocess' ? this.subprocess : undefined },
    subprocess: {
      spawn(spec) {
        if (spec.argv[0] === 'git') return handle('', 0)
        state.spec = spec
        let settle
        const done = new Promise(resolve => { settle = resolve })
        const finish = outcome => {
          if (state.settled) return
          state.settled = true
          settle(outcome)
        }
        const onAbort = () => finish({ exitCode: null, signal: 'SIGTERM' })
        if (spec.signal?.aborted === true) onAbort()
        else spec.signal?.addEventListener('abort', onAbort, { once: true })
        return {
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done,
          terminate() { state.terminateCalled += 1; onAbort() },
          waitForExit: async () => true,
        }
      },
    },
  }
  return { ctx, state }
}

await ta('O-a: 活运行注册表 — 起运行后 listLiveRuns() 能列出它；结束后不再出现', async () => {
  // 用 pendingCtx 构造一个「不会自己结束」的 agy 进程 seam
  const { ctx, state } = pendingCtx()
  const ledger = new RunsLedger(`${TMP}/o1.ndjson`)

  // 运行前列表为空（或不含该 task_id）
  const before = listLiveRuns()
  assert.equal(before.some(r => r.task_id === 'live-task-o1'), false)

  const run = await startAgy({
    ctx,
    config: { agyPath: 'agy.exe', ledger, graceMs: 1000, timeoutMs: 0 },
    taskId: 'live-task-o1',
    cwd: 'C:/repo',
    task: 'x',
  })

  // 运行中：listLiveRuns() 能列出该条目
  const during = listLiveRuns()
  const entry = during.find(r => r.task_id === 'live-task-o1')
  assert.ok(entry !== undefined, '运行中应能列出该 task_id')
  assert.equal(entry.status, 'running')
  assert.equal(typeof entry.startedAt, 'number')
  assert.equal(typeof entry.durationMs, 'number')
  assert.ok(entry.durationMs >= 0, 'durationMs 应非负')
  assert.equal(entry.verdict, null)
  assert.equal(entry.totalTokens, null)
  assert.equal(typeof entry.round, 'number')

  // 结束运行（发 abort 信号）
  const caller = new AbortController()
  state.spec.signal?.addEventListener('abort', () => {}, { once: true })
  run.dispose()
  await run.result

  // 结束后：不再出现在活列表里
  const after = listLiveRuns()
  assert.equal(after.some(r => r.task_id === 'live-task-o1'), false, '运行结束后不应再出现在活列表')
})

await ta('O-b: killRun() 对正在跑的运行返回成功，且确实调用了 terminate()（杀进程树）', async () => {
  const { ctx, state } = killableCtx()
  const ledger = new RunsLedger(`${TMP}/o2.ndjson`)

  const run = await startAgy({
    ctx,
    config: { agyPath: 'agy.exe', ledger, graceMs: 1000, timeoutMs: 0 },
    taskId: 'kill-task-o2',
    cwd: 'C:/repo',
    task: 'x',
  })

  // 确认运行中
  assert.equal(listLiveRuns().some(r => r.task_id === 'kill-task-o2'), true)

  // killRun 返回成功
  const killResult = await killRun('kill-task-o2', ledger)
  assert.equal(killResult.ok, true, `killRun 应返回成功，实际：${JSON.stringify(killResult)}`)
  assert.equal(killResult.taskId, 'kill-task-o2')
  assert.equal(typeof killResult.runId, 'string')

  // 确认 terminate() 被调用（杀进程树这个动作确实发生了）
  assert.ok(state.terminateCalled > 0, `terminate() 应被调用至少一次，实际：${state.terminateCalled}`)

  await run.result
})

await ta('O-c: 被 killRun() 终止的轮次在台账里记为 aborted，而不是正常完成', async () => {
  const { ctx } = killableCtx()
  const ledger = new RunsLedger(`${TMP}/o3.ndjson`)

  const run = await startAgy({
    ctx,
    config: { agyPath: 'agy.exe', ledger, graceMs: 1000, timeoutMs: 0 },
    taskId: 'abort-record-o3',
    cwd: 'C:/repo',
    task: 'x',
  })

  await killRun('abort-record-o3', ledger)
  await run.result

  // 台账里的记录应当标记为 aborted，不是 completed
  const state = await ledger.latest('abort-record-o3')
  // lastStopReason 应为 aborted（由 result 的 mapAgyResult 写入，aborted-by-panel note 由 killRun 写入）
  assert.equal(state.lastStopReason, 'aborted', `台账 lastStopReason 应为 aborted，实际：${state.lastStopReason}`)
  // lastNote 应标明是面板终止
  assert.equal(state.lastNote, 'aborted-by-panel', `台账 lastNote 应为 aborted-by-panel，实际：${state.lastNote}`)
})

await ta('O-d: killRun() 对不存在的 task_id 明确返回失败（不假装成功）', async () => {
  const ledger = new RunsLedger(`${TMP}/o4.ndjson`)

  // 不存在的 task_id
  const result1 = await killRun('no-such-task-xyz', ledger)
  assert.equal(result1.ok, false, 'killRun 对不存在的 task_id 应返回 ok:false')
  assert.equal(typeof result1.reason, 'string', 'reason 应为字符串')
  assert.ok(result1.reason.includes('no-such-task-xyz'), `reason 应包含 task_id，实际：${result1.reason}`)

  // 已完成的 task_id（先跑完，再尝试 kill）
  const finishedCtx = fakeCtx({ agyJsonOutput: agyJson('conv-done') })
  const finishedRun = await startAgy({
    ctx: finishedCtx,
    config: { agyPath: 'agy.exe', ledger, graceMs: 1000 },
    taskId: 'already-done-o4',
    cwd: 'C:/repo',
    task: 'x',
  })
  await finishedRun.result
  // 已经结束，再 kill 应当失败
  const result2 = await killRun('already-done-o4', ledger)
  assert.equal(result2.ok, false, '已结束的运行 killRun 应返回 ok:false')
  assert.ok(result2.reason.includes('already-done-o4'), `reason 应包含 task_id，实际：${result2.reason}`)
})

await ta('O-e: wolf_kill 工具注册并能正确返回成功/失败结果', async () => {
  // 验证 wolf_kill 工具的注册逻辑（通过 captureTool seam）
  const indexMod = await import('./index.js')
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register(def) { registered.push(def); return () => {} } }
      if (name === 'subprocess') return fakeCtx({}).subprocess
      if (name === 'subagents') return { registerProvider() {} }
      return undefined
    },
    settings: { register: () => ({ watch: () => () => {} }), get: () => ({ enabled: true }) },
    systemPrompt: { section: () => () => {} },
    effect(fn) { const disposer = fn(); return () => disposer?.() },
  }
  indexMod.apply(ctx)

  const killTool = registered.find(def => def.name === 'wolf_kill')
  assert.ok(killTool !== undefined, 'wolf_kill 工具应已注册')
  assert.equal(typeof killTool.execute, 'function')

  // 对不存在 task_id 的调用 → ok:false
  const result = await killTool.execute({ task_id: 'ghost-task' }, {})
  assert.equal(result.ok, false)
  assert.equal(typeof result.reason, 'string')
})

await ta('O-f: 台账耗时反映 agy 实际运行时长（记录落盘远晚于 agy 结束时不计入空转）', async () => {
  const ledger = new RunsLedger(`${TMP}/o6-duration.ndjson`)
  // 1. 纯函数测试 extractDurationMs
  const rawWithDuration = JSON.stringify({
    status: 'SUCCESS',
    response: 'done',
    duration_seconds: 372.55,
    conversation_id: 'conv-dur',
  })
  assert.equal(extractDurationMs(rawWithDuration, 5000), 372550, '应精确解析 duration_seconds 为毫秒')
  assert.equal(extractDurationMs('not json', 5000), 5000, '非 JSON 应回退到 fallbackMs')
  assert.equal(extractDurationMs('{}', 5000), 5000, '缺 duration_seconds 应回退到 fallbackMs')

  // 2. 集成测试（含 duration_seconds 且有明显后置延迟）：
  // 模拟 agy 原件返回 duration_seconds: 1.5 (1500ms)，但在后置快照阶段人为延迟 200ms
  let gitAfterCalled = false
  const ctx = fakeCtx({
    agyJsonOutput: JSON.stringify({
      status: 'SUCCESS',
      response: 'done',
      duration_seconds: 1.5,
      conversation_id: 'conv-dur-1',
    }),
  })
  const origSpawn = ctx.subprocess.spawn
  ctx.subprocess.spawn = spec => {
    if (spec.argv[0] === 'git' && gitAfterCalled) {
      return {
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: new Promise(resolve => setTimeout(() => resolve({ exitCode: 0, signal: null }), 200)),
        terminate() {},
        waitForExit: async () => true,
      }
    }
    if (spec.argv[0] === 'git') gitAfterCalled = true
    return origSpawn(spec)
  }

  const run = await startAgy({
    ctx,
    config: baseConfig(ledger),
    taskId: 'duration-task-1',
    cwd: 'C:/repo',
    task: 'do it',
  })

  const out = await run.result
  // result 返回的 durationMs 应精准取自 agy 自报的 1.5 秒 (1500ms)
  assert.equal(out.durationMs, 1500, `durationMs 应为 1500，实际：${out.durationMs}`)
  const state = await ledger.latest('duration-task-1')
  assert.equal(state.lastDurationMs, 1500, `台账记录的 lastDurationMs 应为 1500，实际：${state.lastDurationMs}`)

  // 3. 集成测试（无 duration_seconds 且有明显后置延迟）：
  // 验证当 agy 未输出 duration_seconds 时，耗时是以 handle.done 结束时刻为准，
  // 而不是落盘/对账完成时刻（排除空转）
  let gitAfterCalled2 = false
  const ctx2 = fakeCtx({
    agyJsonOutput: JSON.stringify({
      status: 'SUCCESS',
      response: 'done',
      conversation_id: 'conv-dur-2',
    }),
  })
  const origSpawn2 = ctx2.subprocess.spawn
  ctx2.subprocess.spawn = spec => {
    if (spec.argv[0] === 'git' && gitAfterCalled2) {
      return {
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: new Promise(resolve => setTimeout(() => resolve({ exitCode: 0, signal: null }), 200)),
        terminate() {},
        waitForExit: async () => true,
      }
    }
    if (spec.argv[0] === 'git') gitAfterCalled2 = true
    return origSpawn2(spec)
  }

  const run2 = await startAgy({
    ctx: ctx2,
    config: baseConfig(ledger),
    taskId: 'duration-task-2',
    cwd: 'C:/repo',
    task: 'do it',
  })

  const out2 = await run2.result
  // 子进程本身在 fakeCtx 中是立即 resolve 的，而后置 git 延迟 200ms。
  // durationMs 必须在 100ms 以内，绝不能把 200ms 延迟算进去。
  assert.ok(out2.durationMs < 100, `无 duration_seconds 时 durationMs (${out2.durationMs}) 不应包含后置延迟 200ms`)
  const state2 = await ledger.latest('duration-task-2')
  assert.ok(state2.lastDurationMs < 100, `台账记录的 lastDurationMs (${state2.lastDurationMs}) 不应包含后置延迟 200ms`)
})

console.log('\nP. 台账留存与轮转策略')

await ta('P-a: 超过条目数上限时确实发生裁剪，且被裁剪后每个 task 的折叠摘要仍能读出累计 token / 轮数 / conversationId', async () => {
  const path = `${TMP}/p-retention-exceed.ndjson`
  // 显式指定上限：条目数上限 4，保留最近 2 轮明细
  const ledger = new RunsLedger(path, { maxEntries: 4, keepRounds: 2 })

  // 写入 4 轮记录：1..4 轮未超上限（4 <= 4）
  await ledger.record({ taskId: 'task-a', round: 1, conversationId: 'c-a1', tokens: 100, changedFiles: ['f1.js'] })
  await ledger.record({ taskId: 'task-a', round: 2, tokens: 200, changedFiles: ['f2.js'] })
  await ledger.record({ taskId: 'task-a', round: 3, conversationId: 'c-a2', tokens: 300 })
  await ledger.record({ taskId: 'task-a', round: 4, tokens: 400, verdict: 'pass' })

  const rawBefore = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(rawBefore.length, 4, '4 轮时应有 4 行明细')

  // 第 5 轮：总条数达到 5 > 4，触发裁剪
  await ledger.record({ taskId: 'task-a', round: 5, tokens: 500, changedFiles: ['f3.js'], stopReason: 'completed' })

  // 验证裁剪后条目数：保留最近 2 轮明细（round 4, 5） + 1 条折叠摘要，共 3 行
  const rawAfter = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(rawAfter.length, 3, `裁剪后应压缩为 3 行，实际：${rawAfter.length}`)

  const summary = JSON.parse(rawAfter[0])
  assert.equal(summary.kind, 'summary')
  assert.equal(summary.taskId, 'task-a')
  assert.equal(summary.round, 3, '折叠摘要记录前 3 轮的最大轮数 3')
  assert.equal(summary.tokens, 600, '折叠摘要累计前 3 轮 token: 100 + 200 + 300 = 600')

  // 读取折叠态：累计 token / 轮数 / conversationId 必须完整保真
  const state = await ledger.latest('task-a')
  assert.equal(state.round, 5, 'round 仍为 5')
  assert.equal(state.conversationId, 'c-a2', 'conversationId 正确继承最近一次有效 id')
  assert.equal(state.totalTokens, 1500, 'totalTokens 仍为 1500 (100+200+300+400+500)')
  assert.equal(state.lastStopReason, 'completed')
  assert.equal(state.lastVerdict, 'pass')
  assert.deepEqual(state.changedFiles.sort(), ['f1.js', 'f2.js', 'f3.js'])
})

await ta('P-b: 未超过上限时不裁剪（不能误删明细）', async () => {
  const path = `${TMP}/p-retention-no-compact.ndjson`
  const ledger = new RunsLedger(path, { maxEntries: 10, keepRounds: 2 })

  await ledger.record({ taskId: 'task-b', round: 1, conversationId: 'c-b1', tokens: 50 })
  await ledger.record({ taskId: 'task-b', round: 2, conversationId: 'c-b2', tokens: 60 })
  await ledger.record({ taskId: 'task-b', round: 3, conversationId: 'c-b3', tokens: 70 })

  // 3 <= 10，不应裁剪
  const raw = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(raw.length, 3, '未超过上限时应保留全部 3 行明细')
  const entries = raw.map(l => JSON.parse(l))
  assert.ok(entries.every(e => e.kind !== 'summary'), '未裁剪时不应产生任何折叠摘要')
  assert.equal(entries[0].round, 1)
  assert.equal(entries[1].round, 2)
  assert.equal(entries[2].round, 3)

  const state = await ledger.latest('task-b')
  assert.equal(state.round, 3)
  assert.equal(state.totalTokens, 180)
})

await ta('P-c: 裁剪写入是安全的：注入一次写失败后，台账仍可被完整读取（不出现半截文件）', async () => {
  const path = `${TMP}/p-retention-atomic-fail.ndjson`
  const ledger = new RunsLedger(path, { maxEntries: 3, keepRounds: 1 })

  await ledger.record({ taskId: 'task-c', round: 1, conversationId: 'c-c1', tokens: 10 })
  await ledger.record({ taskId: 'task-c', round: 2, conversationId: 'c-c2', tokens: 20 })
  await ledger.record({ taskId: 'task-c', round: 3, conversationId: 'c-c3', tokens: 30 })

  // 注入写入失败（模拟临时文件写入半截后发生磁盘故障或重命名失败）
  ledger.writeAtomic = async (tempPath, targetPath, content) => {
    writeFileSync(tempPath, '{"broken":true\n', 'utf8')
    throw new Error('EIO: simulated disk write failure during compaction')
  }

  // 写入第 4 轮，触发裁剪，但在原子写阶段失败（record 会捕获 warning，不挂崩）
  await ledger.record({ taskId: 'task-c', round: 4, conversationId: 'c-c4', tokens: 40 })

  // 原台账必须未受破坏：内容不包含半截残损文本，所有已写记录完整可读
  const content = readFileSync(path, 'utf8')
  assert.ok(!content.includes('{"broken":true'), '原台账文件绝不能被残破内容覆盖')

  const state = await ledger.latest('task-c')
  assert.equal(state.round, 4, '台账仍完整可读，最新记录 round 为 4')
  assert.equal(state.totalTokens, 100, 'token 累加依然正确: 10+20+30+40 = 100')
  assert.equal(state.conversationId, 'c-c4')

  // 临时文件被安全清理，不留垃圾文件
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const files = fsMod.readdirSync(pathMod.dirname(path))
  const leftoverTmp = files.filter(f => f.startsWith('.compact-') && f.endsWith('.tmp'))
  assert.equal(leftoverTmp.length, 0, '写失败后的临时文件必须被清理')
})

await ta('P-d: 按文件大小上限触发压缩，且 usageMissingRounds 与多任务折叠语义保真', async () => {
  const path = `${TMP}/p-retention-size.ndjson`
  // 设极小的 maxBytes (150 字节)
  const ledger = new RunsLedger(path, { maxBytes: 150, maxEntries: 1000, keepRounds: 1 })

  // task-1: 第 1 轮有 token，第 2 轮无 token (usageMissingRounds=1)，第 3 轮无 token (usageMissingRounds=2)
  await ledger.record({ taskId: 'task-1', round: 1, tokens: 100, conversationId: 'c1' })
  await ledger.record({ taskId: 'task-1', round: 2, note: 'round 2 missing usage' })
  await ledger.record({ taskId: 'task-1', round: 3, note: 'round 3 still missing usage' })

  // 此时文件大小超过 150 字节，触发按文件大小压缩
  const raw = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(raw.length, 2, '按大小压缩后应为 2 行（1 摘要 + 1 明细）')

  const state = await ledger.latest('task-1')
  assert.equal(state.round, 3)
  assert.equal(state.totalTokens, 100)
  assert.equal(state.usageMissingRounds, 2, '压缩后连续用量缺失轮数仍精确为 2')
  assert.equal(state.conversationId, 'c1')
})

await ta('P-e: 环境变量 WOLFPACK_LEDGER_MAX_ENTRIES / MAX_BYTES / KEEP_ROUNDS 生效', async () => {
  const path = `${TMP}/p-retention-env.ndjson`
  const oldEntries = process.env.WOLFPACK_LEDGER_MAX_ENTRIES
  const oldKeep = process.env.WOLFPACK_LEDGER_KEEP_ROUNDS
  try {
    process.env.WOLFPACK_LEDGER_MAX_ENTRIES = '3'
    process.env.WOLFPACK_LEDGER_KEEP_ROUNDS = '1'

    const ledger = new RunsLedger(path)
    await ledger.record({ taskId: 'env-task', round: 1, tokens: 10 })
    await ledger.record({ taskId: 'env-task', round: 2, tokens: 20 })
    await ledger.record({ taskId: 'env-task', round: 3, tokens: 30 })
    await ledger.record({ taskId: 'env-task', round: 4, tokens: 40 })

    const raw = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(raw.length, 2, '通过环境变量触发压缩，压缩后应为 2 行（1 摘要 + 1 明细）')

    const state = await ledger.latest('env-task')
    assert.equal(state.round, 4)
    assert.equal(state.totalTokens, 100)
  } finally {
    if (oldEntries === undefined) delete process.env.WOLFPACK_LEDGER_MAX_ENTRIES
    else process.env.WOLFPACK_LEDGER_MAX_ENTRIES = oldEntries

    if (oldKeep === undefined) delete process.env.WOLFPACK_LEDGER_KEEP_ROUNDS
    else process.env.WOLFPACK_LEDGER_KEEP_ROUNDS = oldKeep
  }
})

console.log('\nQ. agy 不可续跑声明与防作弊回归（如实拒绝）')

const agyProviderMod = await import('./agy-provider.js')

t('Q-a: 导出 CONTINUABLE_UNSUPPORTED_REASON 说明不可续跑理由（非空且非占位符）', () => {
  assert.ok('CONTINUABLE_UNSUPPORTED_REASON' in agyProviderMod, 'agy-provider 必须导出 CONTINUABLE_UNSUPPORTED_REASON 常量')
  const reason = agyProviderMod.CONTINUABLE_UNSUPPORTED_REASON
  assert.equal(typeof reason, 'string', 'CONTINUABLE_UNSUPPORTED_REASON 必须为字符串')
  assert.ok(reason.trim().length >= 20, `理由说明过短或为占位符 (实际长度: ${reason.trim().length})`)
  assert.ok(!/todo|placeholder|fixme/i.test(reason), '理由不能是占位符')
  assert.ok(
    reason.includes('CLI') && (reason.includes('生命周期') || reason.includes('数据') || reason.includes('进程')),
    '理由文案必须如实说明为什么 agy 作为进程外 CLI 不能充当 DSH 持久队员',
  )
})

t('Q-b: 防作弊回归 — AgyProvider 的 capabilities.persona 与 toolFilter 必须为 false', () => {
  const provider = new AgyProvider({}, {})
  assert.equal(
    provider.capabilities.persona,
    false,
    '防作弊回归：严禁为迎合 AgentTeams 校验将 persona 谎报为 true',
  )
  assert.equal(
    provider.capabilities.toolFilter,
    false,
    '防作弊回归：严禁为迎合 AgentTeams 校验将 toolFilter 谎报为 true',
  )
  assert.equal(provider.capabilities.agentOptions, false)
  assert.equal(provider.capabilities.outputSchema, false)
  assert.equal(provider.capabilities.depthLimit, false)
})

t('Q-c: AgyProvider 刻意不提供 prepareContinuable（如实拒绝而非遗漏）', () => {
  const provider = new AgyProvider({}, {})
  // 刻意的如实拒绝：
  // ContinuableCreateSpec 是 DATA 而非能力，续跑管理器完全自持子会话生命周期。
  // agy 为进程外 CLI 根本不在链路上，不实现 prepareContinuable（保持 undefined）
  // 是为了杜绝虚报能力欺骗 AgentTeams。
  assert.equal(
    provider.prepareContinuable,
    undefined,
    'AgyProvider 必须保持 prepareContinuable 为 undefined，绝不可实现伪造的持久队员接口',
  )
  assert.equal(
    'prepareContinuable' in provider,
    false,
    'AgyProvider 实例与原型链上绝不可出现 prepareContinuable 属性或方法',
  )
})

console.log('\nR. 结构化报告实测信封对齐与机械对账')

const REAL_AGY_ENVELOPE = JSON.stringify({
  conversation_id: '869f0334-656f-42c6-b613-c4c6a4cb0ff5',
  status: 'SUCCESS',
  response: '1 + 1 等于 2。\n{"answer":"1 + 1 等于 2。","filesChanged":[],"toolAction":"Finishing the task","toolSummary":"Finish task"}\n',
  duration_seconds: 37.9871079,
  num_turns: 2,
  structured_output: {
    answer: '1 + 1 等于 2。',
    filesChanged: [],
  },
  json_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      filesChanged: { type: 'array', items: { type: 'string' } },
    },
  },
  usage: {
    input_tokens: 30785,
    output_tokens: 416,
    thinking_tokens: 363,
    cache_read_tokens: 24456,
    total_tokens: 31201,
  },
})

t('R-a: 真实信封 → structured 正确解析、claimedFiles 精准取自 structured_output', () => {
  // 1. 纯解析器：对齐实测真实信封（answer / filesChanged）
  const parsed = runnerMod.parseStructuredReport(JSON.parse(REAL_AGY_ENVELOPE))
  assert.ok(parsed !== undefined, '结构化报告必须被解析成功')
  assert.equal(parsed.summary, '1 + 1 等于 2。')
  assert.deepEqual(parsed.claimedFiles, [])
  assert.deepEqual(parsed.raw, { answer: '1 + 1 等于 2。', filesChanged: [] })

  // 2. 带声称改动文件的变体信封
  const envelopeWithFiles = JSON.stringify({
    ...JSON.parse(REAL_AGY_ENVELOPE),
    structured_output: {
      answer: '已修改模块',
      filesChanged: ['src/button.js', './lib/util.js'],
    },
  })
  const parsedWithFiles = runnerMod.parseStructuredReport(JSON.parse(envelopeWithFiles))
  assert.equal(parsedWithFiles.summary, '已修改模块')
  assert.deepEqual(parsedWithFiles.claimedFiles, ['src/button.js', 'lib/util.js'])

  // 3. mapAgyResult 全链路映射
  const mapped = mapAgyResult(
    envelopeWithFiles,
    { exitCode: 0, signal: null },
    { determined: true, changed: true, summary: '2 files', files: ['src/button.js', 'lib/util.js'] },
    { aborted: false, timedOut: false },
  )
  assert.equal(mapped.stopReason, 'completed')
  assert.deepEqual(mapped.claimedFiles, ['src/button.js', 'lib/util.js'])
  assert.deepEqual(mapped.structured, { answer: '已修改模块', filesChanged: ['src/button.js', './lib/util.js'] })
  assert.equal(mapped.reconciliation.status, 'matched')
  assert.equal(mapped.output[0].text, '已修改模块')
})

t('R-b: response 中混入的 JSON 副本绝不被当作权威来源（以 structured_output 为准）', () => {
  // 故意构造 response 与 structured_output 产生冲突的不一致信封
  const conflictingEnvelope = JSON.stringify({
    conversation_id: 'conv-conflicting',
    status: 'SUCCESS',
    response: '自由文本在此：\n{"answer":"RESPONSE中的假自述","filesChanged":["fake.txt"],"claimed_files":["fake.txt"]}\n',
    structured_output: {
      answer: 'STRUCTURED_OUTPUT中的真自述',
      filesChanged: ['real.txt'],
    },
  })

  const parsed = runnerMod.parseStructuredReport(JSON.parse(conflictingEnvelope))
  assert.equal(parsed.summary, 'STRUCTURED_OUTPUT中的真自述', '自述必须取自 structured_output 而非 response 中的 JSON')
  assert.deepEqual(parsed.claimedFiles, ['real.txt'], '改动文件必须取自 structured_output 而非 response 中的 JSON')

  const mapped = mapAgyResult(
    conflictingEnvelope,
    { exitCode: 0, signal: null },
    { determined: true, changed: true, summary: '1 files', files: ['real.txt'] },
    { aborted: false, timedOut: false },
  )
  assert.equal(mapped.output[0].text, 'STRUCTURED_OUTPUT中的真自述')
  assert.deepEqual(mapped.claimedFiles, ['real.txt'])
  assert.equal(mapped.reconciliation.status, 'matched')
})

t('R-c: 缺 structured_output（或为 null）时安全降级，不抛异常且 structured 为 undefined', () => {
  // 1. structured_output 为 null，且 response 中有自由文本与 JSON 假象
  const nullStructured = JSON.stringify({
    conversation_id: 'conv-null',
    status: 'SUCCESS',
    response: '非结构化普通自述文本\n{"answer":"不可作为结构化来源"}',
    structured_output: null,
  })
  const parsedNull = runnerMod.parseStructuredReport(JSON.parse(nullStructured))
  assert.equal(parsedNull, undefined, 'structured_output 为 null 时必须返回 undefined')

  const mappedNull = mapAgyResult(
    nullStructured,
    { exitCode: 0, signal: null },
    { determined: true, changed: false, summary: '', files: [] },
    { aborted: false, timedOut: false },
  )
  assert.equal(mappedNull.structured, undefined)
  assert.equal(mappedNull.claimedFiles, undefined)
  assert.equal(mappedNull.reconciliation, undefined)
  assert.equal(mappedNull.output[0].text, '非结构化普通自述文本\n{"answer":"不可作为结构化来源"}')

  // 2. 字段完全缺席
  const missingStructured = JSON.stringify({
    conversation_id: 'conv-missing',
    status: 'SUCCESS',
    response: 'plain response without schema output',
  })
  const parsedMissing = runnerMod.parseStructuredReport(JSON.parse(missingStructured))
  assert.equal(parsedMissing, undefined)

  const mappedMissing = mapAgyResult(
    missingStructured,
    { exitCode: 0, signal: null },
    { determined: true, changed: false, summary: '', files: [] },
    { aborted: false, timedOut: false },
  )
  assert.equal(mappedMissing.structured, undefined)
  assert.equal(mappedMissing.claimedFiles, undefined)
})

t('R-d: stdout 是坏 JSON / 空字符串 / undefined 时安全降级，绝不抛未捕获异常', () => {
  const malformedInputs = ['', '   ', 'not-valid-json', '{"status": "SUCCESS", broken', 'null', '12345']
  for (const raw of malformedInputs) {
    assert.doesNotThrow(() => {
      const mapped = mapAgyResult(
        raw,
        { exitCode: 1, signal: null },
        { determined: true, changed: false, summary: '', files: [] },
        { aborted: false, timedOut: false },
      )
      assert.equal(mapped.stopReason, 'error')
      assert.equal(mapped.structured, undefined)
      assert.equal(mapped.claimedFiles, undefined)
      assert.equal(mapped.reconciliation, undefined)
    }, `输入 ${JSON.stringify(raw)} 时绝不可抛未捕获异常`)
  }

  assert.equal(runnerMod.parseStructuredReport(undefined), undefined)
  assert.equal(runnerMod.parseStructuredReport(null), undefined)
  assert.equal(runnerMod.parseStructuredReport({}), undefined)
})

t('R-e: 机械对账：声称改动与磁盘改动不符时产出显式 findings，两向均能精准识别', () => {
  // 1. 声称动了 A，但磁盘未动 A
  const claimOnly = runnerMod.reconcileClaimedArtifacts(['src/a.js'], { determined: true, changed: false, summary: '', files: [] })
  assert.equal(claimOnly.status, 'mismatch')
  assert.equal(claimOnly.findings.length, 1)
  assert.ok(claimOnly.findings[0].includes('声称改动但磁盘未动：src/a.js'))

  // 2. 磁盘动了 B，但队员未声称
  const diskOnly = runnerMod.reconcileClaimedArtifacts([], { determined: true, changed: true, summary: '', files: ['src/b.js'] })
  assert.equal(diskOnly.status, 'mismatch')
  assert.equal(diskOnly.findings.length, 1)
  assert.ok(diskOnly.findings[0].includes('磁盘实际改动但队员未声称：src/b.js'))

  // 3. 双向不一致：声称 A 磁盘动 B
  const crossMismatch = runnerMod.reconcileClaimedArtifacts(['src/a.js'], { determined: true, changed: true, summary: '', files: ['src/b.js'] })
  assert.equal(crossMismatch.status, 'mismatch')
  assert.equal(crossMismatch.findings.length, 2)
  assert.ok(crossMismatch.findings.some(f => f.includes('声称改动但磁盘未动：src/a.js')))
  assert.ok(crossMismatch.findings.some(f => f.includes('磁盘实际改动但队员未声称：src/b.js')))

  // 4. mapAgyResult 中 diagnostic 必须包含显式对账差异
  const mismatchEnvelope = JSON.stringify({
    conversation_id: 'conv-mismatch',
    status: 'SUCCESS',
    response: 'done',
    structured_output: { summary: '修改了 A', claimed_files: ['src/a.js'] },
  })
  const mapped = mapAgyResult(
    mismatchEnvelope,
    { exitCode: 0, signal: null },
    { determined: true, changed: true, summary: '1 files', files: ['src/b.js'] },
    { aborted: false, timedOut: false },
  )
  assert.ok(mapped.diagnostic.includes('对账差异'))
  assert.ok(mapped.diagnostic.includes('声称改动但磁盘未动：src/a.js'))
  assert.ok(mapped.diagnostic.includes('磁盘实际改动但队员未声称：src/b.js'))

  // 5. 完全匹配
  const matched = runnerMod.reconcileClaimedArtifacts(['src/a.js'], { determined: true, changed: true, summary: '', files: ['src/a.js'] })
  assert.equal(matched.status, 'matched')
  assert.equal(matched.findings.length, 0)
})

await ta('R-f: 原始 JSON 永不进入 digest 文本，digest 仅保留自述与落盘路径', async () => {
  // 1. renderDigest 单元验证
  const digest = renderDigest({
    task_id: 'task-real-envelope',
    round: 1,
    continued: false,
    stop_reason: 'completed',
    report: '1 + 1 等于 2。',
    changed_files: [],
    changed_files_determined: true,
    raw_path: 'C:/Users/test/raw.json',
  })

  // 原始信封中的大段 JSON 绝不出现在 digest 文本中
  assert.ok(!digest.includes('input_tokens'), 'digest 绝不能包含 input_tokens 等原始 JSON 字段')
  assert.ok(!digest.includes('total_tokens'), 'digest 绝不能包含 total_tokens')
  assert.ok(!digest.includes('structured_output'), 'digest 绝不能包含 structured_output')
  assert.ok(!digest.includes('toolAction'), 'digest 绝不能包含 toolAction 等内部动作')
  assert.ok(digest.includes('1 + 1 等于 2。'), '队员自述必须清晰呈现')
  assert.ok(digest.includes('agy 原始 JSON（未进上下文，需要时自行读）：C:/Users/test/raw.json'), '必须只呈现 raw_path 落盘路径')

  // 2. startAgy 端到端集成验证
  const ledger = new RunsLedger(`${TMP}/r-f-ledger.ndjson`)
  const ctx = fakeCtx({ agyJsonOutput: REAL_AGY_ENVELOPE })
  const run = await startAgy({
    ctx,
    config: baseConfig(ledger),
    taskId: 'task-rf-integrate',
    cwd: 'C:/repo',
    task: 'compute 1 + 1',
  })
  const out = await run.result
  assert.equal(out.report, '1 + 1 等于 2。', 'report 必须是提炼后的 self summary，绝不能包含 response 尾部夹带的 JSON 副本')
  assert.ok(!out.report.includes('toolAction'), 'report 不得夹带自由文本尾部的原始 JSON')
  assert.ok(!out.report.includes('filesChanged'), 'report 不得夹带原始 JSON 键')
  assert.ok(typeof out.rawPath === 'string' && out.rawPath.endsWith('.json'), '原始 JSON 必须独立落盘')
})

/* ── S. 工具调用预算透明（有界 digest 墙提示）──────────────────────── */

console.log('\nS. 工具调用预算透明（有界 digest 墙提示）')

t('S-a: 未设预算时，digest 明确标注「不设上限」，且说明仅受 agy 侧配额约束', () => {
  const text = renderDigest({
    task_id: 'task-no-budget',
    round: 1,
    continued: false,
    stop_reason: 'completed',
    report: '已完成',
    changed_files: [],
    changed_files_determined: true,
    verdict: 'pass',
    verify: [{ command: 'npm test', ran: true, ok: true }],
  })
  assert.match(text, /本轮工具调用预算：不设上限（宿主不设超时，仅受 agy 侧配额约束）/)
  assert.ok(text.includes('不设上限'))
  assert.ok(text.includes('仅受 agy 侧配额约束'))
})

t('S-b: 设了预算时，digest 出现按 taskDeadline + verifyDeadline + 120_000 换算出的分钟数并说明 TOOL_TIMEOUT', () => {
  // 假定 taskDeadline 8 分钟 (480_000ms)，verifyDeadline 1 分钟 (60_000ms)，宽限 120s (120_000ms)
  // 换算总预算 = 480_000 + 60_000 + 120_000 = 660_000 ms = 11 分钟
  const taskDeadline = 480_000
  const verifyDeadline = 60_000
  const toolDeadlineMs = taskDeadline + verifyDeadline + 120_000
  assert.equal(toolDeadlineMs, 660_000)

  const text = renderDigest({
    task_id: 'task-with-budget',
    round: 2,
    continued: true,
    stop_reason: 'completed',
    report: '修复完毕',
    changed_files: ['src/fix.js'],
    changed_files_determined: true,
    verdict: 'pass',
    verify: [{ command: 'npm test', ran: true, ok: true }],
    tool_deadline_ms: toolDeadlineMs,
  })
  assert.match(text, /本轮工具调用预算：11 分钟（到点会被宿主以 TOOL_TIMEOUT 掐断）/)
  assert.ok(text.includes('11 分钟'))
  assert.ok(text.includes('TOOL_TIMEOUT'))
})

t('S-c: 带预算说明的 digest 仍然保持有界，绝不复述原始 JSON', () => {
  const text = renderDigest({
    task_id: 'task-bounded',
    round: 1,
    continued: false,
    stop_reason: 'completed',
    report: '精简自述',
    changed_files: [],
    changed_files_determined: true,
    raw_path: 'C:/Users/test/raw.json',
    tool_deadline_ms: 660_000,
  })
  assert.ok(text.includes('本轮工具调用预算：11 分钟（到点会被宿主以 TOOL_TIMEOUT 掐断）'))
  assert.ok(!text.includes('input_tokens'), 'digest 绝不能包含 input_tokens 等原始 JSON 字段')
  assert.ok(!text.includes('total_tokens'), 'digest 绝不能包含 total_tokens')
  assert.ok(!text.includes('structured_output'), 'digest 绝不能包含 structured_output')
  assert.ok(!text.includes('toolAction'), 'digest 绝不能包含 toolAction')
  assert.ok(text.includes('agy 原始 JSON（未进上下文，需要时自行读）：C:/Users/test/raw.json'))
})

await ta('S-d: 端到端工具执行：显式配置超时时准确计算并向 digest 传递换算分钟数', async () => {
  const ledger = new RunsLedger(`${TMP}/s-d-ledger.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('conv-s-d'),
    verifyByCommand: { 'npm test': { exitCode: 0, stdout: 'pass' } },
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, {
    agyPath: 'agy.exe',
    ledger,
    timeoutMs: 480_000, // 8 分钟
    verifyTimeoutMs: 60_000, // 1 分钟
  })
  // toolDeadlineMs = 480_000 + 60_000 + 120_000 = 660_000 ms = 11 分钟
  assert.equal(getDef().timeoutMs, 660_000)

  const value = await getDef().execute(
    { task_id: 'e2e-budget', task: 'do task', verify: ['npm test'] },
    agentExec(),
  )
  assert.equal(value.tool_deadline_ms, 660_000)
  const digest = renderDigest(value)
  assert.ok(digest.includes('本轮工具调用预算：11 分钟（到点会被宿主以 TOOL_TIMEOUT 掐断）'))
})

await ta('S-e: 端到端工具执行：未设预算与 stale 轮次中，digest 诚实交代预算状态', async () => {
  // 1. 未配置 timeoutMs 时，不设上限
  const ledger1 = new RunsLedger(`${TMP}/s-e1-ledger.ndjson`)
  const ctx1 = fakeCtx({
    agyJsonOutput: agyJson('conv-s-e1'),
    verifyByCommand: { 'npm test': { exitCode: 0, stdout: 'pass' } },
  })
  const getDef1 = captureTool(ctx1)
  registerWolfDelegate(ctx1, { agyPath: 'agy.exe', ledger: ledger1 })
  assert.equal(getDef1().timeoutMs, undefined)
  const value1 = await getDef1().execute(
    { task_id: 'e2e-no-budget', task: 'do task', verify: ['npm test'] },
    agentExec(),
  )
  assert.equal(value1.tool_deadline_ms, undefined)
  assert.ok(renderDigest(value1).includes('本轮工具调用预算：不设上限（宿主不设超时，仅受 agy 侧配额约束）'))

  // 2. 基线未过导致 stale 时，配置的预算依然如实进入 digest
  const ledger2 = new RunsLedger(`${TMP}/s-e2-ledger.ndjson`)
  const ctx2 = fakeCtx({ verifyByCommand: { 'exit 0': { exitCode: 0, stdout: 'already ok' } } })
  const getDef2 = captureTool(ctx2)
  registerWolfDelegate(ctx2, {
    agyPath: 'agy.exe',
    ledger: ledger2,
    timeoutMs: 480_000,
    verifyTimeoutMs: 60_000,
  })
  const value2 = await getDef2().execute(
    { task_id: 'e2e-stale-budget', task: 'do task', verify_baseline: ['exit 0'] },
    agentExec(),
  )
  assert.equal(value2.verdict, 'stale')
  assert.equal(value2.tool_deadline_ms, 660_000)
  assert.ok(renderDigest(value2).includes('本轮工具调用预算：11 分钟（到点会被宿主以 TOOL_TIMEOUT 掐断）'))
})

/* ── T. 产物探测与工作区外声称文件的对账隔离 ──────────────────────── */

t('对账差异-工作区外 a: 声称的文件在被探测根之外 → 对账 undetermined 且不得产出声称改动但磁盘未动', () => {
  // 1. reconcileClaimedArtifacts: 声称文件在被探测根（C:/repo）之外（例如 D:/other/file.js）
  const result = runnerMod.reconcileClaimedArtifacts(
    ['D:/other/file.js'],
    { determined: true, changed: false, summary: '', files: [], root: 'C:/repo' },
    'C:/repo',
  )
  assert.equal(result.status, 'undetermined')
  assert.ok(result.findings.length > 0)
  assert.ok(result.findings[0].includes('声称的文件不在被探测的工作区内，无法对账'))
  assert.ok(!result.findings.some(f => f.includes('声称改动但磁盘未动')))
  assert.ok(!result.findings.some(f => f.includes('磁盘实际改动但队员未声称')))

  // 2. mapAgyResult: 声称工作区外文件时不得产出 mismatch diagnostic（消灭假警报）
  const envelope = JSON.stringify({
    conversation_id: 'conv-outside-root',
    status: 'SUCCESS',
    response: 'done',
    structured_output: { summary: '修改了工作区外文件', claimed_files: ['D:/other/file.js'] },
  })
  const mapped = mapAgyResult(
    envelope,
    { exitCode: 0, signal: null },
    { determined: true, changed: false, summary: '', files: [], root: 'C:/repo' },
    { aborted: false, timedOut: false, cwd: 'C:/repo' },
  )
  assert.equal(mapped.reconciliation?.status, 'undetermined')
  assert.equal(mapped.diagnostic, undefined)

  // 3. digest: 必须如实显示「无法判定」并附带工作区外原因，绝不得显示「0 个文件（无）」
  const digest = renderDigest({
    task_id: 'task-outside',
    round: 1,
    continued: false,
    stop_reason: 'completed',
    report: 'done',
    changed_files: [],
    changed_files_determined: false,
    changed_files_undetermined_reason: '声称的文件不在被探测的工作区内',
    verify: [],
    verdict: 'unverified',
    reconciliation: mapped.reconciliation,
  })
  assert.ok(digest.includes('无法判定'))
  assert.ok(digest.includes('声称的文件不在被探测的工作区内'))
  assert.equal(digest.includes('0 个文件（无）'), false)
  assert.equal(digest.includes('（无）'), false)
})

t('对账差异-工作区外 b: 声称的文件在根内且快照确实未变 → 仍是 mismatch 产出声称改动但磁盘未动', () => {
  // 1. reconcileClaimedArtifacts: 声称文件在根内，快照确定未变 → 仍是 mismatch
  const result = runnerMod.reconcileClaimedArtifacts(
    ['src/inner.js'],
    { determined: true, changed: false, summary: '', files: [], root: 'C:/repo' },
    'C:/repo',
  )
  assert.equal(result.status, 'mismatch')
  assert.equal(result.findings.length, 1)
  assert.ok(result.findings[0].includes('声称改动但磁盘未动：src/inner.js'))

  // 2. mapAgyResult: 根内未改动仍保留对账差异诊断
  const envelope = JSON.stringify({
    conversation_id: 'conv-in-root-mismatch',
    status: 'SUCCESS',
    response: 'done',
    structured_output: { summary: '修改了根内文件', claimed_files: ['src/inner.js'] },
  })
  const mapped = mapAgyResult(
    envelope,
    { exitCode: 0, signal: null },
    { determined: true, changed: false, summary: '', files: [], root: 'C:/repo' },
    { aborted: false, timedOut: false, cwd: 'C:/repo' },
  )
  assert.equal(mapped.reconciliation?.status, 'mismatch')
  assert.ok(mapped.diagnostic.includes('对账差异'))
  assert.ok(mapped.diagnostic.includes('声称改动但磁盘未动：src/inner.js'))
})

t('对账差异-工作区外 c: 非 git 工作区里根本没探测到任何改动且未声称文件 → 仍是 undetermined，digest 必须说无法判定而非 0 个文件（无）', () => {
  // 1. diffArtifacts: 非 git（fs 快照）未探测到改动时，determined 必须为 false
  const fsArtifacts = diffArtifacts(new Map(), new Map())
  assert.equal(fsArtifacts.determined, false)
  assert.equal(fsArtifacts.changed, false)
  assert.deepEqual(fsArtifacts.files, [])

  // 2. reconcileClaimedArtifacts: 未声称文件也是 undetermined
  const reconc = runnerMod.reconcileClaimedArtifacts([], fsArtifacts)
  assert.equal(reconc.status, 'undetermined')
  assert.ok(reconc.findings[0].includes('无法判定'))

  // 3. digest: 必须说「无法判定」，不许说「0 个文件（无）」
  const digest = renderDigest({
    task_id: 'task-no-git-no-change',
    round: 1,
    continued: false,
    stop_reason: 'completed',
    report: 'nothing claimed',
    changed_files: fsArtifacts.files,
    changed_files_determined: fsArtifacts.determined,
    verify: [],
    verdict: 'unverified',
  })
  assert.ok(digest.includes('无法判定'))
  assert.equal(digest.includes('0 个文件（无）'), false)
  assert.equal(digest.includes('（无）'), false)
})

/* ── T. 工具 presentationMeta（有界纯 JSON 投影）───────────────── */

console.log('\nT. 工具 presentationMeta（有界纯 JSON 投影）')

await ta('T-a: wolf_status presentationMeta 从真实注册获取并返回有界纯 JSON 结构', async () => {
  const ledger = new RunsLedger(`${TMP}/t-status-meta-a.ndjson`)
  const toolMap = new Map()
  const tools = {
    register(def) {
      toolMap.set(def.name, def)
      return () => { toolMap.delete(def.name) }
    },
    get(name) {
      return toolMap.get(name)
    },
  }
  const ctx = {
    tools,
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subprocess') return fakeCtx({}).subprocess
      return undefined
    },
  }
  delegateMod.registerWolfStatus(ctx, baseConfig(ledger))
  const statusTool = ctx.tools.get('wolf_status')
  assert.ok(statusTool, '期望 ctx.tools.get("wolf_status") 返回已注册工具，实际为 undefined')
  const presentationMeta = statusTool.output.presentationMeta
  assert.equal(typeof presentationMeta, 'function', `期望 presentationMeta 为函数，实际为 ${typeof presentationMeta}`)

  const sampleValue = {
    tasks: [
      {
        task_id: 'task-complete',
        round: 2,
        last_verdict: 'pass',
        last_stop_reason: 'completed',
        total_tokens: 1500,
        total_cache_read_tokens: 300,
        has_conversation_id: true,
        running: false,
        changed_files_count: 2,
        changed_files: ['lib/a.js', 'lib/b.js'],
        last_at: 1710001000,
        last_duration_ms: 12000,
      },
      {
        task_id: 'task-incomplete',
        round: 1,
        // 刻意缺失 last_verdict 与 last_stop_reason
        total_tokens: 450,
        total_cache_read_tokens: 0,
        has_conversation_id: false,
        running: true,
        changed_files_count: 0,
        changed_files: [],
        last_at: 1710002000,
        last_duration_ms: 4000,
      },
    ],
    total: 2,
    truncated: false,
    limit: 20,
    ledger_path: 'C:/Users/test/runs.ndjson',
  }

  const meta = presentationMeta({}, sampleValue)
  assert.equal(meta.total, 2, `期望 meta.total 为 2，实际为 ${meta.total}`)
  assert.equal(meta.truncated, false, `期望 meta.truncated 为 false，实际为 ${meta.truncated}`)
  assert.equal(meta.limit, 20, `期望 meta.limit 为 20，实际为 ${meta.limit}`)
  assert.equal(meta.tasks.length, 2, `期望 meta.tasks 长度为 2，实际为 ${meta.tasks?.length}`)
  assert.equal(Object.prototype.hasOwnProperty.call(meta, 'ledger_path'), false, '期望 meta 顶层不含 ledger_path，实际存在该属性')

  // 第一行：完整任务
  const row0 = meta.tasks[0]
  assert.equal(row0.task_id, 'task-complete', `期望 row0.task_id 为 "task-complete"，实际为 ${row0.task_id}`)
  assert.equal(row0.round, 2, `期望 row0.round 为 2，实际为 ${row0.round}`)
  assert.equal(row0.last_verdict, 'pass', `期望 row0.last_verdict 为 "pass"，实际为 ${row0.last_verdict}`)
  assert.equal(row0.last_stop_reason, 'completed', `期望 row0.last_stop_reason 为 "completed"，实际为 ${row0.last_stop_reason}`)
  assert.equal(row0.total_tokens, 1500, `期望 row0.total_tokens 为 1500，实际为 ${row0.total_tokens}`)
  assert.equal(row0.has_conversation_id, true, `期望 row0.has_conversation_id 为 true，实际为 ${row0.has_conversation_id}`)
  assert.equal(row0.running, false, `期望 row0.running 为 false，实际为 ${row0.running}`)
  assert.equal(row0.changed_files_count, 2, `期望 row0.changed_files_count 为 2，实际为 ${row0.changed_files_count}`)
  assert.equal(row0.last_at, 1710001000, `期望 row0.last_at 为 1710001000，实际为 ${row0.last_at}`)
  // 有界性验证：禁止把 changed_files 数组塞进 meta
  assert.equal(Object.prototype.hasOwnProperty.call(row0, 'changed_files'), false, '期望 row0 不含 changed_files 数组，实际存在该属性')
  assert.equal(Object.prototype.hasOwnProperty.call(row0, 'total_cache_read_tokens'), false, '期望 row0 不含 total_cache_read_tokens，实际存在该属性')
  assert.equal(Object.prototype.hasOwnProperty.call(row0, 'last_duration_ms'), false, '期望 row0 不含 last_duration_ms，实际存在该属性')

  // 第二行：缺失字段任务
  const row1 = meta.tasks[1]
  assert.equal(row1.task_id, 'task-incomplete', `期望 row1.task_id 为 "task-incomplete"，实际为 ${row1.task_id}`)
  assert.equal(row1.round, 1, `期望 row1.round 为 1，实际为 ${row1.round}`)
  assert.equal(row1.total_tokens, 450, `期望 row1.total_tokens 为 450，实际为 ${row1.total_tokens}`)
  assert.equal(row1.has_conversation_id, false, `期望 row1.has_conversation_id 为 false，实际为 ${row1.has_conversation_id}`)
  assert.equal(row1.running, true, `期望 row1.running 为 true，实际为 ${row1.running}`)
  assert.equal(row1.changed_files_count, 0, `期望 row1.changed_files_count 为 0，实际为 ${row1.changed_files_count}`)
  assert.equal(row1.last_at, 1710002000, `期望 row1.last_at 为 1710002000，实际为 ${row1.last_at}`)
  assert.equal(Object.prototype.hasOwnProperty.call(row1, 'changed_files'), false, '期望 row1 不含 changed_files 数组，实际存在该属性')
})

await ta('T-b: wolf_status presentationMeta 缺省字段整键省略（非 undefined 占位）', async () => {
  const ledger = new RunsLedger(`${TMP}/t-status-meta-b.ndjson`)
  const toolMap = new Map()
  const tools = {
    register(def) { toolMap.set(def.name, def); return () => {} },
    get(name) { return toolMap.get(name) },
  }
  const ctx = {
    tools,
    get(name) { return name === 'tools' ? tools : undefined },
  }
  delegateMod.registerWolfStatus(ctx, baseConfig(ledger))
  const presentationMeta = ctx.tools.get('wolf_status').output.presentationMeta

  // 1. 从自然缺省字段对象测试
  const meta = presentationMeta({}, {
    tasks: [{
      task_id: 'task-no-verdict',
      round: 1,
      total_tokens: 100,
      has_conversation_id: false,
      running: false,
      changed_files_count: 0,
      last_at: 1710000000,
    }],
    total: 1,
    truncated: false,
    limit: 20,
  })
  const row = meta.tasks[0]
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, 'last_verdict'),
    false,
    `期望 row 完全省略 last_verdict 键，实际存在该属性且值为 ${row.last_verdict}`,
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, 'last_stop_reason'),
    false,
    `期望 row 完全省略 last_stop_reason 键，实际存在该属性且值为 ${row.last_stop_reason}`,
  )

  // 2. 显式带有 undefined / null 字段的对象测试：同样必须整键省略，不得留存为 undefined 或 null
  const metaWithExplicitNullOrUndefined = presentationMeta({}, {
    tasks: [{
      task_id: 'task-explicit',
      round: 1,
      last_verdict: undefined,
      last_stop_reason: null,
      total_tokens: 200,
      has_conversation_id: true,
      running: true,
      changed_files_count: 1,
      last_at: 1710000001,
    }],
    total: 1,
    truncated: false,
    limit: 20,
  })
  const explicitRow = metaWithExplicitNullOrUndefined.tasks[0]
  assert.equal(
    Object.prototype.hasOwnProperty.call(explicitRow, 'last_verdict'),
    false,
    `期望显式 undefined 的 last_verdict 被整键省略，实际存在该属性：${explicitRow.last_verdict}`,
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(explicitRow, 'last_stop_reason'),
    false,
    `期望显式 null 的 last_stop_reason 被整键省略，实际存在该属性：${explicitRow.last_stop_reason}`,
  )
})

await ta('T-c: wolf_status presentationMeta 满足纯 JSON 往返等价（无 undefined/丢失属性）', async () => {
  const ledger = new RunsLedger(`${TMP}/t-status-meta-c.ndjson`)
  const toolMap = new Map()
  const tools = {
    register(def) { toolMap.set(def.name, def); return () => {} },
    get(name) { return toolMap.get(name) },
  }
  const ctx = {
    tools,
    get(name) { return name === 'tools' ? tools : undefined },
  }
  delegateMod.registerWolfStatus(ctx, baseConfig(ledger))
  const presentationMeta = ctx.tools.get('wolf_status').output.presentationMeta

  const sample = {
    tasks: [
      {
        task_id: 't-1',
        round: 1,
        last_verdict: 'fail',
        last_stop_reason: 'aborted',
        total_tokens: 1000,
        has_conversation_id: true,
        running: false,
        changed_files_count: 5,
        last_at: 1710000000,
      },
      {
        task_id: 't-2',
        round: 2,
        total_tokens: 50,
        has_conversation_id: false,
        running: true,
        changed_files_count: 0,
        last_at: 1710000100,
      },
    ],
    total: 2,
    truncated: false,
    limit: 20,
  }

  const meta = presentationMeta({}, sample)
  const serialized = JSON.stringify(meta)
  const roundtripped = JSON.parse(serialized)
  assert.deepEqual(
    roundtripped,
    meta,
    `期望 JSON 往返序列化结果深等于 meta，实际反序列化为 ${serialized}`,
  )
})

await ta('T-d: wolf_status presentationMeta 满足纯函数契约（无副作用、同输入深相等）', async () => {
  const ledger = new RunsLedger(`${TMP}/t-status-meta-d.ndjson`)
  const toolMap = new Map()
  const tools = {
    register(def) { toolMap.set(def.name, def); return () => {} },
    get(name) { return toolMap.get(name) },
  }
  const ctx = {
    tools,
    get(name) { return name === 'tools' ? tools : undefined },
  }
  delegateMod.registerWolfStatus(ctx, baseConfig(ledger))
  const presentationMeta = ctx.tools.get('wolf_status').output.presentationMeta

  const sample = {
    tasks: [
      {
        task_id: 'task-pure',
        round: 1,
        last_verdict: 'pass',
        last_stop_reason: 'completed',
        total_tokens: 300,
        has_conversation_id: false,
        running: false,
        changed_files_count: 1,
        changed_files: ['file.txt'],
        last_at: 1710005000,
      },
    ],
    total: 1,
    truncated: false,
    limit: 10,
  }

  const first = presentationMeta({}, sample)
  const second = presentationMeta({}, sample)
  assert.deepEqual(
    first,
    second,
    '期望同输入两次调用 presentationMeta 返回深相等结果，实际不一致',
  )
  // 验证输入对象未被附带修改
  assert.deepEqual(sample.tasks[0].changed_files, ['file.txt'], '期望输入对象未被副作用修改')
})

await ta('T-e: wolf_kill presentationMeta 在 ok=true 与 ok=false 时均返回有界纯 JSON 并省略无关字段', async () => {
  const indexMod = await import('./index.js')
  const toolMap = new Map()
  const tools = {
    register(def) { toolMap.set(def.name, def); return () => {} },
    get(name) { return toolMap.get(name) },
  }
  const ctx = {
    tools,
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subprocess') return fakeCtx({}).subprocess
      if (name === 'subagents') return { registerProvider() {} }
      return undefined
    },
    settings: { register: () => ({ watch: () => () => {} }), get: () => ({ enabled: true }) },
    systemPrompt: { section: () => () => {} },
    effect(fn) { const disposer = fn(); return () => disposer?.() },
  }
  indexMod.apply(ctx)

  const killTool = ctx.tools.get('wolf_kill')
  assert.ok(killTool, '期望 ctx.tools.get("wolf_kill") 返回已注册工具，实际为 undefined')
  const killMeta = killTool.output.presentationMeta
  assert.equal(typeof killMeta, 'function', `期望 wolf_kill presentationMeta 为函数，实际为 ${typeof killMeta}`)

  // 1. ok=true 分支
  const okValue = { ok: true, task_id: 'task-alive', run_id: 'run-8888' }
  const okMeta = killMeta({}, okValue)
  assert.equal(okMeta.ok, true, `期望 ok 为 true，实际为 ${okMeta.ok}`)
  assert.equal(okMeta.task_id, 'task-alive', `期望 task_id 为 "task-alive"，实际为 ${okMeta.task_id}`)
  assert.equal(okMeta.run_id, 'run-8888', `期望 run_id 为 "run-8888"，实际为 ${okMeta.run_id}`)
  assert.equal(
    Object.prototype.hasOwnProperty.call(okMeta, 'reason'),
    false,
    `期望 ok=true 时完全省略 reason 属性，实际存在该属性：${okMeta.reason}`,
  )
  assert.deepEqual(JSON.parse(JSON.stringify(okMeta)), okMeta, '期望 okMeta 满足纯 JSON 往返等价')

  // 2. ok=false 分支（reason 只在失败时出现）
  const failValue = { ok: false, reason: 'task_id 未在运行' }
  const failMeta = killMeta({}, failValue)
  assert.equal(failMeta.ok, false, `期望 ok 为 false，实际为 ${failMeta.ok}`)
  assert.equal(failMeta.reason, 'task_id 未在运行', `期望 reason 为 "task_id 未在运行"，实际为 ${failMeta.reason}`)
  assert.equal(
    Object.prototype.hasOwnProperty.call(failMeta, 'task_id'),
    false,
    `期望 ok=false 时完全省略 task_id 属性，实际存在该属性：${failMeta.task_id}`,
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(failMeta, 'run_id'),
    false,
    `期望 ok=false 时完全省略 run_id 属性，实际存在该属性：${failMeta.run_id}`,
  )
  assert.deepEqual(JSON.parse(JSON.stringify(failMeta)), failMeta, '期望 failMeta 满足纯 JSON 往返等价')

  // 3. 显式 undefined 字段过滤与纯函数性
  const explicitUndefined = killMeta({}, { ok: true, task_id: 't-ex', run_id: 'r-ex', reason: undefined })
  assert.equal(
    Object.prototype.hasOwnProperty.call(explicitUndefined, 'reason'),
    false,
    '期望显式 undefined 的 reason 键被整键省略',
  )
  const okMetaSecond = killMeta({}, okValue)
  assert.deepEqual(okMeta, okMetaSecond, '期望 wolf_kill presentationMeta 相同输入两次调用深相等')
})

/* ── L. 宿主侧实时状态 HTTP 路由（只读 /wolfpack/live） ─────────── */

await ta('L-a: 鉴权 — requestRejection 返回 401 则不供数且返回 401；缺 connection 时 503；返回 undefined 则 200 且 JSON 可解析', async () => {
  let registeredDef
  const webServer = {
    register(def) {
      registeredDef = def
      return () => { registeredDef = undefined }
    },
  }

  // 1. connection 服务缺失 → fail closed 返回 503
  {
    const ctx = {
      get(name) {
        if (name === 'webServer') return webServer
        return undefined
      },
    }
    const dispose = liveRouteMod.registerLiveRoute(ctx, {})
    assert.ok(registeredDef, '应该已注册 /wolfpack/live 路由')
    assert.equal(registeredDef.path, '/wolfpack/live')

    const req = { method: 'GET', url: '/wolfpack/live', headers: {} }
    let status = 0
    let endedBody = ''
    const res = {
      set statusCode(c) { status = c },
      get statusCode() { return status },
      setHeader() {},
      end(chunk) { if (chunk) endedBody += chunk },
    }

    await registeredDef.handler(req, res)
    assert.equal(res.statusCode, 503, '缺 connection 服务时必须 fail closed 返回 503')
    dispose()
  }

  // 2. requestRejection 返回 401 → 401 且不供数
  {
    const connection = {
      requestRejection(_req) { return 401 },
    }
    const ctx = {
      get(name) {
        if (name === 'webServer') return webServer
        if (name === 'connection') return connection
        return undefined
      },
    }
    const dispose = liveRouteMod.registerLiveRoute(ctx, {})

    const req = { method: 'GET', url: '/wolfpack/live', headers: {} }
    let status = 0
    let endedBody = ''
    const res = {
      set statusCode(c) { status = c },
      get statusCode() { return status },
      setHeader() {},
      end(chunk) { if (chunk) endedBody += chunk },
    }

    await registeredDef.handler(req, res)
    assert.equal(res.statusCode, 401, 'requestRejection 返回 401 时应返回 401')
    assert.equal(endedBody, '', '401 时不得供数（响应体应为空）')
    dispose()
  }

  // 3. requestRejection 返回 undefined → 200 且提供有效 JSON
  {
    const connection = {
      requestRejection(_req) { return undefined },
    }
    const ctx = {
      get(name) {
        if (name === 'webServer') return webServer
        if (name === 'connection') return connection
        return undefined
      },
    }
    const dispose = liveRouteMod.registerLiveRoute(ctx, {
      ledger: { read: async () => new Map() },
      activeRuns: [],
    })

    const req = { method: 'GET', url: '/wolfpack/live', headers: {} }
    let status = 0
    const headers = {}
    let endedBody = ''
    const res = {
      set statusCode(c) { status = c },
      get statusCode() { return status },
      setHeader(k, v) { headers[k.toLowerCase()] = v },
      end(chunk) { if (chunk) endedBody += chunk },
    }

    await registeredDef.handler(req, res)
    assert.equal(res.statusCode, 200, '正常鉴权通过应返回 200')
    assert.equal(headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(headers['cache-control'], 'no-store')
    const parsed = JSON.parse(endedBody)
    assert.equal(typeof parsed.generated_at, 'number')
    assert.ok(Array.isArray(parsed.runs))
    assert.equal(typeof parsed.ledger_total, 'number')
    dispose()
  }
})

await ta('L-b: 有界 — 造 20 个运行 + 每个 100 条 transcript 事件 → 响应里运行数 ≤ 8、事件数 ≤ 12、每条文本 ≤ 400 字符、响应体 ≤ 32KB', async () => {
  const stagingRoot = join(process.env.WP_TEST_HOME ?? process.env.TEMP, 'wp-lb-bound-test')
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  const runs = []
  for (let i = 0; i < 20; i++) {
    const convId = `conv-bound-${i}`
    const logDir = join(stagingRoot, 'brain', convId, '.system_generated', 'logs')
    await mkdir(logDir, { recursive: true })
    const jsonlPath = join(logDir, 'transcript.jsonl')

    const lines = []
    for (let j = 0; j < 100; j++) {
      lines.push(JSON.stringify({
        step_index: j,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(1700000000000 + j * 1000).toISOString(),
        thinking: `第 ${i} 个运行步骤 ${j}：` + '超长文本'.repeat(120),
        tool_calls: [{ name: `tool_${j % 5}` }],
      }))
    }
    writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8')

    runs.push({
      taskId: `task-bound-${i}`,
      runId: `run-bound-${i}`,
      startedAt: Date.now() - 10000 + i * 100,
      round: 1,
      conversationId: convId,
    })
  }

  let registeredDef
  const webServer = {
    register(def) { registeredDef = def; return () => {} },
  }
  const connection = { requestRejection: () => undefined }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
  }

  const dispose = liveRouteMod.registerLiveRoute(ctx, {
    activeRuns: runs,
    storeRoot: stagingRoot,
  })

  const req = { method: 'GET', url: '/wolfpack/live', headers: {} }
  let status = 0
  let endedBody = ''
  const res = {
    set statusCode(c) { status = c },
    get statusCode() { return status },
    setHeader() {},
    end(chunk) { if (chunk) endedBody += chunk },
  }

  await registeredDef.handler(req, res)
  assert.equal(res.statusCode, 200)

  // 1. 响应体字节数 ≤ 32KB
  const bodyBytes = Buffer.byteLength(endedBody, 'utf8')
  assert.ok(bodyBytes <= 32 * 1024, `响应体应 ≤ 32KB，实际 ${bodyBytes} 字节`)

  // 2. 运行条数 ≤ 8
  const parsed = JSON.parse(endedBody)
  assert.ok(parsed.runs.length <= 8, `运行条数应 ≤ 8，实际 ${parsed.runs.length}`)

  // 3. 每个运行事件数 ≤ 12，且每条事件文本 ≤ 400 字符
  for (const r of parsed.runs) {
    assert.ok(r.transcript.events.length <= 12, `事件数应 ≤ 12，实际 ${r.transcript.events.length}`)
    for (const evt of r.transcript.events) {
      assert.ok(evt.text.length <= 400, `文本长度应 ≤ 400，实际 ${evt.text.length}`)
      assert.equal(typeof evt.kind, 'string')
    }
  }

  dispose()
  await rm(stagingRoot, { recursive: true, force: true })
})

await ta('L-c: 容错 — transcript 缺失/半截行/非法 JSON → available:false 或有界事件列表，且不抛异常', async () => {
  const stagingRoot = join(process.env.WP_TEST_HOME ?? process.env.TEMP, 'wp-lc-fault-test')
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  // 1. 文件缺失
  const missingConvId = 'conv-missing'

  // 2. 半截行
  const halfConvId = 'conv-half'
  const halfLogDir = join(stagingRoot, 'brain', halfConvId, '.system_generated', 'logs')
  await mkdir(halfLogDir, { recursive: true })
  const halfValidLine = JSON.stringify({
    step_index: 0,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-09-16T01:00:00Z',
    thinking: '正在思考有效第一步',
  })
  writeFileSync(join(halfLogDir, 'transcript.jsonl'), `${halfValidLine}\n{"step_index":1,"source":"MOD`, 'utf8')

  // 3. 非法非 JSON 数据
  const illegalConvId = 'conv-illegal'
  const illegalLogDir = join(stagingRoot, 'brain', illegalConvId, '.system_generated', 'logs')
  await mkdir(illegalLogDir, { recursive: true })
  writeFileSync(join(illegalLogDir, 'transcript.jsonl'), 'random garbage line 1\n{invalid json}\n!!!###\n', 'utf8')

  // 直接验证 readTranscriptTail 容错
  const missingResult = await liveRouteMod.readTranscriptTail(join(stagingRoot, 'brain', missingConvId, '.system_generated', 'logs', 'transcript.jsonl'))
  assert.equal(missingResult.available, false)
  assert.ok(typeof missingResult.reason === 'string')

  const halfResult = await liveRouteMod.readTranscriptTail(join(halfLogDir, 'transcript.jsonl'))
  assert.equal(halfResult.available, true)
  assert.equal(halfResult.events.length, 1)
  assert.equal(halfResult.events[0].kind, 'PLANNER_RESPONSE')
  assert.ok(halfResult.events[0].text.includes('正在思考有效第一步'))

  const illegalResult = await liveRouteMod.readTranscriptTail(join(illegalLogDir, 'transcript.jsonl'))
  assert.equal(illegalResult.available, false)

  // 端到端通过路由检验
  let registeredDef
  const webServer = { register(def) { registeredDef = def; return () => {} } }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
  }

  const runs = [
    { taskId: 't-missing', runId: 'r1', conversationId: missingConvId },
    { taskId: 't-half', runId: 'r2', conversationId: halfConvId },
    { taskId: 't-illegal', runId: 'r3', conversationId: illegalConvId },
  ]
  const dispose = liveRouteMod.registerLiveRoute(ctx, { activeRuns: runs, storeRoot: stagingRoot })

  const req = { method: 'GET', url: '/wolfpack/live', headers: {} }
  let endedBody = ''
  let status = 0
  const res = {
    set statusCode(c) { status = c },
    get statusCode() { return status },
    setHeader() {},
    end(chunk) { if (chunk) endedBody += chunk },
  }

  await registeredDef.handler(req, res)
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(endedBody)
  assert.equal(parsed.runs.length, 3)

  const rMissing = parsed.runs.find(r => r.task_id === 't-missing')
  assert.equal(rMissing.transcript.available, false)

  const rHalf = parsed.runs.find(r => r.task_id === 't-half')
  assert.equal(rHalf.transcript.available, true)
  assert.equal(rHalf.transcript.events.length, 1)

  const rIllegal = parsed.runs.find(r => r.task_id === 't-illegal')
  assert.equal(rIllegal.transcript.available, false)

  dispose()
  await rm(stagingRoot, { recursive: true, force: true })
})

await ta('L-d: 非 GET → 405', async () => {
  let registeredDef
  const webServer = { register(def) { registeredDef = def; return () => {} } }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
  }

  const dispose = liveRouteMod.registerLiveRoute(ctx, {})

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const req = { method, url: '/wolfpack/live', headers: {} }
    let status = 0
    const headers = {}
    let endedBody = ''
    const res = {
      set statusCode(c) { status = c },
      get statusCode() { return status },
      setHeader(k, v) { headers[k.toLowerCase()] = v },
      end(chunk) { if (chunk) endedBody += chunk },
    }

    await registeredDef.handler(req, res)
    assert.equal(res.statusCode, 405, `${method} 请求应返回 405`)
    assert.equal(headers['allow'], 'GET', '405 应包含 Allow: GET 头')
    assert.equal(endedBody, '', '405 不应返回响应体')
  }

  dispose()
})

await ta('L-e: 机械闸门 — 读 lib/live-route.js 源码，断言它不含任何台账写入调用及 wolf_delegate/agy 启动调用', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(here, 'live-route.js'),
    join(here, '..', 'lib', 'live-route.js'),
    'D:\\DSH-Plugins\\dsh-wolfpack\\lib\\live-route.js',
  ]
  const liveRoutePath = candidates.find(p => existsSync(p))
  assert.ok(liveRoutePath, '必须找到 live-route.js 源码文件')
  const code = readFileSync(liveRoutePath, 'utf8')

  // 1. 不含台账写入与文件写入
  assert.ok(!code.includes('writeLedger'), 'live-route.js 严禁包含 writeLedger')
  assert.ok(!code.includes('appendFile'), 'live-route.js 严禁包含 appendFile')
  assert.ok(!code.includes('writeFile'), 'live-route.js 严禁包含 writeFile')
  assert.ok(!code.includes('append'), 'live-route.js 严禁包含 append')
  assert.ok(!code.includes('.record('), 'live-route.js 严禁包含 ledger.record 调用')

  // 2. 不含 agy 或 delegate 启动
  assert.ok(!code.includes('wolf_delegate'), 'live-route.js 严禁包含 wolf_delegate 启动/派活逻辑')
  assert.ok(!code.includes('startAgy'), 'live-route.js 严禁包含 startAgy 调用')
  assert.ok(!code.includes('spawn'), 'live-route.js 严禁包含 spawn')
  assert.ok(!code.includes('child_process'), 'live-route.js 严禁包含 child_process')
})

await ta('L-f: transcript step_index 与 step_total 支持，且优先读取 transcript_full.jsonl 完整思考', async () => {
  const stagingRoot = join(process.env.WP_TEST_HOME ?? process.env.TEMP, 'wp-lf-test')
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  // 1. 测试 transcript.jsonl（只有 compact）时的 step_index / step_total
  const convCompact = 'conv-compact'
  const compactDir = join(stagingRoot, 'brain', convCompact, '.system_generated', 'logs')
  await mkdir(compactDir, { recursive: true })
  const step0 = JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hello' })
  const step1 = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', thinking: 'compact thinking' })
  writeFileSync(join(compactDir, 'transcript.jsonl'), `${step0}\n${step1}\n`, 'utf8')

  const resCompact = await liveRouteMod.readTranscriptTail(join(compactDir, 'transcript.jsonl'))
  assert.equal(resCompact.available, true)
  assert.equal(resCompact.step_index, 1)
  assert.equal(resCompact.step_total, 2)
  assert.equal(resCompact.events.length, 2)

  // 2. 测试同时存在 transcript_full.jsonl 时，buildLivePayload 优先使用 full 版
  const convFull = 'conv-full'
  const fullDir = join(stagingRoot, 'brain', convFull, '.system_generated', 'logs')
  await mkdir(fullDir, { recursive: true })
  const compactStep = JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', thinking: 'truncated' })
  const fullStep = JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', thinking: 'full unabridged thinking process' })
  writeFileSync(join(fullDir, 'transcript.jsonl'), `${compactStep}\n`, 'utf8')
  writeFileSync(join(fullDir, 'transcript_full.jsonl'), `${fullStep}\n`, 'utf8')

  const payload = await liveRouteMod.buildLivePayload({
    activeRuns: [{ taskId: 't-full', runId: 'r-f', conversationId: convFull }],
    storeRoot: stagingRoot,
  })
  assert.equal(payload.runs.length, 1)
  const runItem = payload.runs[0]
  assert.equal(runItem.step_index, 0)
  assert.equal(runItem.step_total, 1)
  assert.equal(runItem.transcript.step_index, 0)
  assert.equal(runItem.transcript.step_total, 1)
  assert.equal(runItem.transcript.events[0].text, 'full unabridged thinking process')

  await rm(stagingRoot, { recursive: true, force: true })
})

await ta('L-g: 耗时语义 — 正在跑才用活时钟（now - startedAt）；已结束必须是台账真实总耗时且固定，且不得给出可被当起点的 started_at', async () => {
  const startedAt = Date.now() - 30_000
  const finishedAt = Date.now() - 1_000
  const realDurationMs = 242_883

  const ledgerMap = new Map([
    ['task-running', { taskId: 'task-running', lastAt: finishedAt, round: 1 }],
    ['task-idle', {
      taskId: 'task-idle',
      lastAt: finishedAt,
      round: 2,
      lastDurationMs: realDurationMs,
      lastVerdict: 'pass',
      lastStopReason: 'completed',
    }],
    ['task-idle-unknown', { taskId: 'task-idle-unknown', lastAt: finishedAt, round: 1 }],
  ])

  const payload = await liveRouteMod.buildLivePayload({
    activeRuns: [{ taskId: 'task-running', runId: 'r-l-g', startedAt, round: 1 }],
    ledger: { read: async () => ledgerMap },
    storeRoot: undefined,
  })

  const running = payload.runs.find(r => r.task_id === 'task-running')
  const idle = payload.runs.find(r => r.task_id === 'task-idle')
  const unknown = payload.runs.find(r => r.task_id === 'task-idle-unknown')
  assert.ok(running && idle && unknown, '三个任务都应出现在 runs 里')

  // 1. 正在跑：活时钟，约 30 秒
  assert.equal(running.status, 'running')
  assert.ok(running.elapsed_ms >= 29_000 && running.elapsed_ms < 60_000,
    `正在跑的 elapsed_ms 应约为 30s，实际 ${running.elapsed_ms}`)

  // 2. 已结束：耗时取台账真实总耗时，固定不变
  assert.equal(idle.status, 'idle')
  assert.equal(idle.elapsed_ms, realDurationMs, '已结束任务的 elapsed_ms 必须取台账 lastDurationMs')
  assert.equal(idle.finished_at, finishedAt, '已结束任务应如实给出 finished_at')

  // 3. 已结束任务不得携带 started_at：客户端会拿它算 now - started_at，
  //    那得到的是「距最后活动过了多久」，会变成永远在涨的假耗时。
  assert.equal(idle.started_at, undefined, '已结束任务严禁携带 started_at')

  // 4. 台账没有 durationMs 时：宁可不给 elapsed_ms，也不编造数字
  assert.equal(unknown.elapsed_ms, undefined, '无 durationMs 时不得编造 elapsed_ms')
  assert.equal(unknown.started_at, undefined, '无 durationMs 时同样不得给出可当起点的 started_at')
})

await ta('L-h: ?limit= 可请求更多任务，但被夹在 [1, MAX_LIVE_RUNS_HARD]；非法值退回默认 8', async () => {
  let registeredDef
  const webServer = { register(def) { registeredDef = def; return () => {} } }
  const connection = { requestRejection: () => undefined }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
  }

  // 60 个已结束任务，全部没有 conversationId（不读盘，只验证条数闸门）
  const ledgerMap = new Map()
  for (let i = 0; i < 60; i++) {
    ledgerMap.set(`t-${i}`, { taskId: `t-${i}`, lastAt: Date.now() - i * 1000, round: 1, lastDurationMs: 1000 + i })
  }

  const dispose = liveRouteMod.registerLiveRoute(ctx, {
    activeRuns: [],
    ledger: { read: async () => ledgerMap },
    storeRoot: undefined,
  })

  async function call(url) {
    const req = { method: 'GET', url, headers: {} }
    let status = 0
    let body = ''
    const res = {
      set statusCode(c) { status = c },
      get statusCode() { return status },
      setHeader() {},
      end(chunk) { if (chunk) body += chunk },
    }
    await registeredDef.handler(req, res)
    return { status, parsed: JSON.parse(body) }
  }

  const dflt = await call('/wolfpack/live')
  assert.equal(dflt.status, 200)
  assert.equal(dflt.parsed.runs.length, 8, `默认应给 8 个，实际 ${dflt.parsed.runs.length}`)

  const many = await call('/wolfpack/live?limit=20')
  assert.equal(many.parsed.runs.length, 20, `limit=20 应给 20 个，实际 ${many.parsed.runs.length}`)

  const capped = await call('/wolfpack/live?limit=999')
  assert.equal(capped.parsed.runs.length, liveRouteMod.MAX_LIVE_RUNS_HARD,
    `limit=999 必须被夹到硬上限 ${liveRouteMod.MAX_LIVE_RUNS_HARD}，实际 ${capped.parsed.runs.length}`)

  const nan = await call('/wolfpack/live?limit=abc')
  assert.equal(nan.parsed.runs.length, 8, '非法 limit 应退回默认 8')

  for (const bad of ['0', '-5', '1e9', '   ']) {
    const r = await call(`/wolfpack/live?limit=${encodeURIComponent(bad)}`)
    assert.ok(r.parsed.runs.length >= 1 && r.parsed.runs.length <= liveRouteMod.MAX_LIVE_RUNS_HARD,
      `limit=${bad} 必须落在 [1, ${liveRouteMod.MAX_LIVE_RUNS_HARD}]，实际 ${r.parsed.runs.length}`)
  }

  dispose()
})

await ta('L-i: 已结束任务的 transcript 缓存必须返回副本——边界裁剪就地改写事件后，下一轮不得吐出被改写的内容', async () => {
  const stagingRoot = join(process.env.WP_TEST_HOME ?? process.env.TEMP, 'wp-li-cache-test')
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  const ledgerMap = new Map()
  for (let i = 0; i < 8; i++) {
    const convId = `conv-cache-${i}`
    const logDir = join(stagingRoot, 'brain', convId, '.system_generated', 'logs')
    await mkdir(logDir, { recursive: true })
    const lines = []
    for (let j = 0; j < 12; j++) {
      lines.push(JSON.stringify({
        step_index: j,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        thinking: `事件 ${i}-${j}：` + '很长很长的思考内容'.repeat(60),
      }))
    }
    writeFileSync(join(logDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf8')
    ledgerMap.set(`t-${i}`, {
      taskId: `t-${i}`,
      lastAt: Date.now() - i * 1000,
      round: 1,
      lastDurationMs: 1000,
      conversationId: convId,
    })
  }

  const config = { activeRuns: [], ledger: { read: async () => ledgerMap }, storeRoot: stagingRoot }

  // 第 1 轮：缓存未命中（写入缓存），返回的必须是副本
  const first = await liveRouteMod.buildLivePayload(config)
  const firstText = first.runs[0].transcript.events[0].text
  assert.equal(firstText.length, liveRouteMod.MAX_EVENT_TEXT_CHARS,
    `样例事件文本应被截到 ${liveRouteMod.MAX_EVENT_TEXT_CHARS}，实际 ${firstText.length}`)

  // 边界裁剪会**就地**改写事件文本——这正是缓存必须交出副本的原因
  liveRouteMod.enforcePayloadBounds(first)
  const mutatedText = first.runs[0].transcript.events[0].text
  assert.ok(mutatedText.length < firstText.length,
    '该样例应触发边界裁剪，否则本用例没有判别力')

  // 第 2 轮：缓存**命中**，返回的同样必须是副本
  const second = await liveRouteMod.buildLivePayload(config)
  assert.equal(second.runs[0].transcript.events[0].text, firstText,
    '缓存未命中那一轮返回了缓存对象本体——cloneTranscript 缺失或被绕过')

  // 真正危险的是这一轮：命中的对象若就是缓存本体，就地裁剪会**污染缓存**，
  // 于是此后每一轮都只返回被切碎的内容。只测一轮是测不出来的。
  liveRouteMod.enforcePayloadBounds(second)
  assert.ok(second.runs[0].transcript.events[0].text.length < firstText.length,
    '该样例第二次也应触发裁剪，否则无法验证缓存是否被污染')

  const third = await liveRouteMod.buildLivePayload(config)
  assert.equal(third.runs[0].transcript.events[0].text, firstText,
    '缓存已被就地裁剪污染——命中路径没有返回副本')

  await rm(stagingRoot, { recursive: true, force: true })
})

/* ── X. wolf_status 预算透出与 503 容量不足区分 ───────────────── */

console.log('\nX. wolf_status 预算透出与 503 容量不足区分')

await ta('X-a: wolf_status 预算透出：未超预算、已超预算（冷启动提示）、预算关闭（整键省略）', async () => {
  const ledger = new RunsLedger(`${TMP}/x-status-budget.ndjson`)
  await ledger.record({
    taskId: 'task-over',
    round: 2,
    tokens: 1_200_000,
    conversationId: 'c-over',
    changedFiles: ['over.js'],
  })
  await ledger.record({
    taskId: 'task-under',
    round: 1,
    tokens: 300_000,
    conversationId: 'c-under',
    changedFiles: [],
  })

  const ctx = fakeCtx({})
  const status = captureTool(ctx)
  delegateMod.registerWolfStatus(ctx, { ...baseConfig(ledger), continuationTokenBudget: 1_000_000 })
  const value = await status().execute({}, {})

  assert.equal(value.total, 2)
  const over = value.tasks.find(task => task.task_id === 'task-over')
  assert.equal(over.budget_used, 1_200_000)
  assert.equal(over.budget_limit, 1_000_000)
  assert.equal(over.budget_over, true)

  const under = value.tasks.find(task => task.task_id === 'task-under')
  assert.equal(under.budget_used, 300_000)
  assert.equal(under.budget_limit, 1_000_000)
  assert.equal(under.budget_over, false)

  // 渲染文案验证
  const rendered = delegateMod.renderStatus(value)
  assert.ok(rendered.includes('· 预算 1200000/1000000（已超——下一轮会冷启动）'))
  assert.ok(rendered.includes('· 预算 300000/1000000'))
  // 未超预算的那行不得带冷启动提示
  const lines = rendered.split('\n')
  const underLine = lines.find(l => l.includes('task-under'))
  assert.ok(underLine.includes('· 预算 300000/1000000'))
  assert.equal(underLine.includes('已超——下一轮会冷启动'), false)

  // presentationMeta 验证
  const meta = delegateMod.statusMetaFromValue(value)
  const metaOver = meta.tasks.find(t => t.task_id === 'task-over')
  assert.equal(metaOver.budget_used, 1_200_000)
  assert.equal(metaOver.budget_limit, 1_000_000)
  assert.equal(metaOver.budget_over, true)
  const metaUnder = meta.tasks.find(t => t.task_id === 'task-under')
  assert.equal(metaUnder.budget_used, 300_000)
  assert.equal(metaUnder.budget_limit, 1_000_000)
  assert.equal(metaUnder.budget_over, false)

  // 预算关闭分支：continuationTokenBudget: undefined
  const ctxOff = fakeCtx({})
  const statusOff = captureTool(ctxOff)
  delegateMod.registerWolfStatus(ctxOff, { ...baseConfig(ledger), continuationTokenBudget: undefined })
  const valueOff = await statusOff().execute({}, {})

  const overOff = valueOff.tasks.find(task => task.task_id === 'task-over')
  assert.equal(overOff.budget_used, 1_200_000)
  assert.equal(overOff.budget_over, false)
  assert.equal(Object.prototype.hasOwnProperty.call(overOff, 'budget_limit'), false)

  const metaOff = delegateMod.statusMetaFromValue(valueOff)
  const metaOverOff = metaOff.tasks.find(t => t.task_id === 'task-over')
  assert.equal(metaOverOff.budget_used, 1_200_000)
  assert.equal(metaOverOff.budget_over, false)
  assert.equal(Object.prototype.hasOwnProperty.call(metaOverOff, 'budget_limit'), false)

  const renderedOff = delegateMod.renderStatus(valueOff)
  assert.equal(renderedOff.includes('· 预算'), false)
})

await ta('X-b: wolf_status output.schema 权威定义包含 budget_used / budget_limit / budget_over', async () => {
  const ledger = new RunsLedger(`${TMP}/x-status-schema.ndjson`)
  const ctx = fakeCtx({})
  const status = captureTool(ctx)
  delegateMod.registerWolfStatus(ctx, baseConfig(ledger))
  const tool = status()
  const taskProps = tool.output.schema.properties.tasks.items.properties

  assert.ok(taskProps.budget_used, 'schema 必须包含 budget_used')
  assert.equal(taskProps.budget_used.type, 'integer')

  assert.ok(taskProps.budget_limit, 'schema 必须包含 budget_limit')
  assert.equal(taskProps.budget_limit.type, 'integer')

  assert.ok(taskProps.budget_over, 'schema 必须包含 budget_over')
  assert.equal(taskProps.budget_over.type, 'boolean')

  const required = tool.output.schema.properties.tasks.items.required
  assert.ok(required.includes('budget_used'), 'required 必须包含 budget_used')
  assert.ok(required.includes('budget_over'), 'required 必须包含 budget_over')
  assert.equal(required.includes('budget_limit'), false, 'required 严禁包含 budget_limit')
})

await ta('X-c: isCapacityError 准确识别 503 服务端容量错误（不误报其他错误）', async () => {
  assert.equal(runnerMod.isCapacityError({ error: 'No capacity available for model claude-opus-4-6-thinking' }), true)
  assert.equal(runnerMod.isCapacityError({ response: '503: No capacity available for this tier' }), true)
  assert.equal(runnerMod.isCapacityError(undefined, 'stderr: no capacity available for requested model'), true)
  assert.equal(runnerMod.isCapacityError(undefined, undefined, 'No capacity available for model'), true)

  // 正常/普通失败不误判
  assert.equal(runnerMod.isCapacityError({ error: 'command failed with exit code 1' }), false)
  assert.equal(runnerMod.isCapacityError({ response: 'all done' }), false)
  assert.equal(runnerMod.isCapacityError(undefined, 'syntax error: unexpected token'), false)
  assert.equal(runnerMod.isCapacityError(undefined, undefined, undefined), false)
})

await ta('X-d: mapAgyResult 服务端容量不足独立标记：stopReason 为 capacity，带 capacity: true，且绝不伪造成 completed（即使有磁盘改动）', async () => {
  const capJson = JSON.stringify({
    status: 'ERROR',
    error: 'No capacity available for claude-opus-4-6-thinking',
    response: '',
  })

  // 1. 无产物时：stopReason === 'capacity'，带 capacity: true，且不是 completed 也不是 error
  const rNoArtifacts = mapAgyResult(capJson, { exitCode: 1, signal: null }, { changed: false, summary: '' }, { aborted: false, timedOut: false })
  assert.equal(rNoArtifacts.stopReason, 'capacity')
  assert.equal(rNoArtifacts.capacity, true)
  assert.notEqual(rNoArtifacts.stopReason, 'completed')
  assert.notEqual(rNoArtifacts.stopReason, 'error')
  assert.match(rNoArtifacts.diagnostic, /No capacity available|容量/)

  // 2. 有产物时（既有规则会把 ERROR 救回 completed）：容量错误绝不能被救成 completed！必须依然是 capacity
  const rWithArtifacts = mapAgyResult(capJson, { exitCode: 1, signal: null }, { changed: true, summary: '1 个文件：a.ts' }, { aborted: false, timedOut: false })
  assert.equal(rWithArtifacts.stopReason, 'capacity')
  assert.equal(rWithArtifacts.capacity, true)
  assert.notEqual(rWithArtifacts.stopReason, 'completed')
})

await ta('X-e: wolf_delegate 端到端：容量错误独立标记、digest 包含专属警示文案、台账真实记录为 capacity（不被记成 completed）', async () => {
  const ledger = new RunsLedger(`${TMP}/x-delegate-cap.ndjson`)
  const capPayload = JSON.stringify({
    status: 'ERROR',
    error: 'No capacity available for claude-opus-4-6-thinking',
    response: '',
    duration_seconds: 1,
    conversation_id: 'conv-cap-1',
  })
  const ctx = fakeCtx({
    agyJsonOutput: capPayload,
    agyExitCode: 1,
  })
  const getDef = captureTool(ctx)
  registerWolfDelegate(ctx, baseConfig(ledger))

  const value = await getDef().execute({ task_id: 'task-cap', task: 'do heavy task' }, agentExec())

  // 1. 结果独立标记
  assert.equal(value.stop_reason, 'capacity')
  assert.equal(value.capacity, true)
  assert.notEqual(value.stop_reason, 'completed')

  // 2. digest 文案检查：写清服务端容量不足、不是任务失败、立刻报告用户、不要反复重试
  const digest = renderDigest(value)
  assert.ok(digest.includes('服务端容量不足（与账户额度无关）'), `期望 digest 包含容量不足说明，实际为：\n${digest}`)
  assert.ok(digest.includes('不是任务失败'), `期望 digest 说明不是任务失败，实际为：\n${digest}`)
  assert.ok(digest.includes('立刻报告用户、不要反复重试'), `期望 digest 包含提示不要重试，实际为：\n${digest}`)

  // 3. 台账记录真实原因，绝不记成 completed
  const recorded = await ledger.latest('task-cap')
  assert.equal(recorded.lastStopReason, 'capacity')
  assert.notEqual(recorded.lastStopReason, 'completed')
})

/* ── Y. wolf_team 并发小队工具 ─────────────────────────────────────── */

console.log('\nY. wolf_team 并发小队工具')

await ta('TM-a: 并发上限——5 个任务、concurrency: 2，假 subprocess 记录同时在跑的最大并发数 ≤ 2，且 5 个全部完成、结果顺序与输入一致', async () => {
  const ledger = new RunsLedger(`${TMP}/team-ta.ndjson`)
  let activeAgy = 0
  let maxAgy = 0
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('conv-ta'),
    verifyByCommand: {
      'npm test': { exitCode: 0, stdout: 'ok' },
    },
  })
  // 覆写 spawn：在跑 agy 时增加并发计数并做微延时，以测量真实并发度
  const origSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = (spec) => {
    const prog = spec.argv[0]
    const isGit = prog === 'git'
    const isVerify = /(powershell|pwsh|bash|sh)(\.exe)?$/i.test(prog)
    if (!isGit && !isVerify) {
      activeAgy++
      if (activeAgy > maxAgy) maxAgy = activeAgy
      const res = origSpawn(spec)
      return {
        ...res,
        done: new Promise(resolve => {
          setTimeout(() => {
            activeAgy--
            resolve({ exitCode: 0, signal: null })
          }, 20)
        }),
      }
    }
    return origSpawn(spec)
  }

  const getDef = captureTool(ctx)
  teamMod.registerWolfTeam(ctx, baseConfig(ledger))
  const tool = getDef()

  const tasks = [
    { task_id: 't-1', task: 'work 1', verify: ['npm test'] },
    { task_id: 't-2', task: 'work 2', verify: ['npm test'] },
    { task_id: 't-3', task: 'work 3', verify: ['npm test'] },
    { task_id: 't-4', task: 'work 4', verify: ['npm test'] },
    { task_id: 't-5', task: 'work 5', verify: ['npm test'] },
  ]

  const value = await tool.execute({ tasks, concurrency: 2 }, agentExec())

  // 1. 最大同时在跑并发数必须 ≤ 2，且确有并发重叠（>= 2）
  assert.ok(maxAgy <= 2, `最大并发数 (${maxAgy}) 不得超过指定的 concurrency (2)`)
  assert.ok(maxAgy >= 2, `并发未发生重叠 (maxAgy=${maxAgy})`)

  // 2. 5 个全部完成
  assert.equal(value.tasks.length, 5)
  assert.equal(value.counts.pass, 5)
  for (const item of value.tasks) {
    assert.equal(item.verdict, 'pass')
    assert.equal(item.stop_reason, 'completed')
  }

  // 3. 结果顺序必须与输入严格一致
  assert.deepEqual(value.tasks.map(item => item.task_id), ['t-1', 't-2', 't-3', 't-4', 't-5'])
})

await ta('TM-b: 重复 task_id → 整个调用被拒绝、错误信息含该 id、且一次都没有 spawn', async () => {
  const ledger = new RunsLedger(`${TMP}/team-tb.ndjson`)
  let spawnCount = 0
  const ctx = fakeCtx({})
  const origSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = (spec) => {
    spawnCount++
    return origSpawn(spec)
  }

  const getDef = captureTool(ctx)
  teamMod.registerWolfTeam(ctx, baseConfig(ledger))
  const tool = getDef()

  const tasks = [
    { task_id: 'unique-1', task: 'do 1' },
    { task_id: 'dup-id-xyz', task: 'do 2' },
    { task_id: 'unique-2', task: 'do 3' },
    { task_id: 'dup-id-xyz', task: 'do 4' },
  ]

  let rejectedError
  try {
    await tool.execute({ tasks }, agentExec())
  } catch (err) {
    rejectedError = err
  }

  assert.ok(rejectedError, '存在重复 task_id 时必须直接抛出异常拒绝调用')
  assert.match(rejectedError.message, /dup-id-xyz/, '错误信息中必须包含重复的 task_id')
  assert.equal(spawnCount, 0, '校验失败时一个进程都不许启动（spawn 次数必须为 0）')
  assert.equal(ctx.calls.agy.length, 0)
  assert.equal(ctx.calls.git.length, 0)
  assert.equal(ctx.calls.verify.length, 0)
})

await ta('TM-c: 单个工人抛错不影响其它工人：失败项 verdict=\'error\' 且有 error 文本，其它项正常完成', async () => {
  const ledger = new RunsLedger(`${TMP}/team-tc.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('conv-tc'),
    verifyByCommand: {
      'npm test': { exitCode: 0, stdout: 'ok' },
    },
  })
  const origSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = (spec) => {
    // 模拟针对特定任务的底层故障（如进程崩溃或 TaskBusyError）
    const isAgy = !spec.argv[0].includes('git') && !/(powershell|pwsh|bash|sh)(\.exe)?$/i.test(spec.argv[0])
    if (isAgy && spec.argv.some(arg => arg.includes('do crash'))) {
      throw new Error('E_SIMULATED_SPAWN: worker task-c-err crashed on spawn')
    }
    return origSpawn(spec)
  }

  const getDef = captureTool(ctx)
  teamMod.registerWolfTeam(ctx, baseConfig(ledger))
  const tool = getDef()

  const tasks = [
    { task_id: 'task-c-ok-1', task: 'do ok 1', verify: ['npm test'] },
    { task_id: 'task-c-err', task: 'do crash', verify: ['npm test'] },
    { task_id: 'task-c-ok-2', task: 'do ok 2', verify: ['npm test'] },
  ]

  // 调用整体不许 reject
  const value = await tool.execute({ tasks, concurrency: 2 }, agentExec())

  assert.equal(value.counts.pass, 2)
  assert.equal(value.counts.error, 1)
  assert.equal(value.tasks.length, 3)

  const [t1, t2, t3] = value.tasks
  assert.equal(t1.task_id, 'task-c-ok-1')
  assert.equal(t1.verdict, 'pass')
  assert.equal(t1.error, undefined)

  assert.equal(t2.task_id, 'task-c-err')
  assert.equal(t2.verdict, 'error')
  assert.ok(typeof t2.error === 'string' && t2.error.includes('E_SIMULATED_SPAWN: worker task-c-err crashed on spawn'))

  assert.equal(t3.task_id, 'task-c-ok-2')
  assert.equal(t3.verdict, 'pass')
  assert.equal(t3.error, undefined)
})

await ta('TM-d: 输出有界——8 个任务、每个 report 100KB，断言 JSON.stringify 长度 < 16KB、每个 report_head ≤ 400 字符、summary ≤ 4000 字符', async () => {
  const ledger = new RunsLedger(`${TMP}/team-td.ndjson`)
  const hugePayload = 'WOLFPACK_LARGE_REPORT_BODY_'.repeat(4000) // ~108 KB
  const ctx = fakeCtx({
    agyJsonOutput: JSON.stringify({
      status: 'SUCCESS',
      response: hugePayload,
      conversation_id: 'conv-td',
      duration_seconds: 2,
    }),
    verifyByCommand: {
      'npm test': { exitCode: 0, stdout: 'ok' },
    },
  })

  const getDef = captureTool(ctx)
  teamMod.registerWolfTeam(ctx, baseConfig(ledger))
  const tool = getDef()

  const tasks = Array.from({ length: 8 }, (_, i) => ({
    task_id: `task-huge-${i + 1}`,
    task: `huge task ${i + 1}`,
    verify: ['npm test'],
  }))

  const value = await tool.execute({ tasks, concurrency: 4 }, agentExec())

  // 1. 硬约束：JSON.stringify 必须严格小于 16KB
  const jsonStr = JSON.stringify(value)
  const byteLength = Buffer.byteLength(jsonStr, 'utf8')
  assert.ok(byteLength < 16 * 1024, `JSON 序列化字节数 (${byteLength}) 必须 < 16KB`)

  // 2. 任务数 8 个，且每个 report_head ≤ 400 字符，且等于 400（证明发生过截断）
  assert.equal(value.tasks.length, 8)
  for (const t of value.tasks) {
    assert.ok(typeof t.report_head === 'string')
    assert.ok(t.report_head.length <= 400, `report_head 长度 (${t.report_head.length}) 不得超过 400`)
    assert.equal(t.report_head.length, 400, '针对 100KB 的超长自述，report_head 必须截断到 400 字符')
    assert.equal(t.report, undefined, '完整 report 绝不许返回')
    assert.equal(t.raw_path, undefined, 'raw_path 绝不许塞入返回对象')
    assert.equal(t.spill_path, undefined, 'spill_path 绝不许塞入返回对象')
  }

  // 3. summary ≤ 4000 字符
  assert.ok(typeof value.summary === 'string')
  assert.ok(value.summary.length <= 4000, `summary 长度 (${value.summary.length}) 不得超过 4000 字符`)

  // 4. renderTeamDigest 渲染结果同样有界
  const digest = teamMod.renderTeamDigest(value)
  assert.ok(digest.length <= teamMod.TEAM_SUMMARY_MAX_CHARS)
})

await ta('TM-e: 没给 verify 的任务 → verdict=\'unverified\'（证明真的复用了 runDelegateTask 的判定，而不是新写了一套）', async () => {
  const ledger = new RunsLedger(`${TMP}/team-te.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('conv-te'),
    verifyByCommand: {
      'npm test': { exitCode: 0, stdout: 'ok' },
    },
  })

  const getDef = captureTool(ctx)
  teamMod.registerWolfTeam(ctx, baseConfig(ledger))
  const tool = getDef()

  const tasks = [
    { task_id: 'task-no-v', task: 'task without verify' },
    { task_id: 'task-with-v', task: 'task with verify', verify: ['npm test'] },
  ]

  const value = await tool.execute({ tasks, concurrency: 2 }, agentExec())

  assert.equal(value.counts.unverified, 1)
  assert.equal(value.counts.pass, 1)

  const [tNo, tWith] = value.tasks
  assert.equal(tNo.task_id, 'task-no-v')
  assert.equal(tNo.verdict, 'unverified', '未提供 verify 时，必须通过 runDelegateTask 判定为 unverified')

  assert.equal(tWith.task_id, 'task-with-v')
  assert.equal(tWith.verdict, 'pass')
})

await ta('TM-f: 任务项未知参数拼写错误与数量超限严格拒绝', async () => {
  const ledger = new RunsLedger(`${TMP}/team-tf.ndjson`)
  const ctx = fakeCtx({})
  const getDef = captureTool(ctx)
  teamMod.registerWolfTeam(ctx, baseConfig(ledger))
  const tool = getDef()

  // 1. 拼写错误（例如 verify_basline）
  await assert.rejects(
    async () => tool.execute({
      tasks: [{ task_id: 't-typo', task: 'task', verify_basline: ['x'] }],
    }, agentExec()),
    /verify_basline/,
  )

  // 2. 数量超过 MAX_TEAM_TASKS (8)
  const nineTasks = Array.from({ length: 9 }, (_, i) => ({ task_id: `t-${i}`, task: 'do' }))
  await assert.rejects(
    async () => tool.execute({ tasks: nineTasks }, agentExec()),
    /超过上限 8/,
  )

  // 3. 顶层未知参数
  await assert.rejects(
    async () => tool.execute({
      tasks: [{ task_id: 't-1', task: 'do' }],
      concurrency: 2,
      unknown_flag: true,
    }, agentExec()),
    /unknown_flag/,
  )
})

await ta('TM-g: 「没探测到」≠「没有改动」——探测不可信时汇总必须说「改动未探测」，绝不报「改动 0 文件」', async () => {
  // 1. 纯渲染层：这是第一次实战跑出来的坑（非 git 工作区里 agy 改了盘外文件，汇总却写着「改动 0 文件」）
  const undet = teamMod.renderTeamDigest({
    counts: { stale: 1 },
    summary: '共委派 1 个任务（stale: 1）\n- t-undet [stale] (第 1 轮 · 改动未探测)',
    tasks: [{
      task_id: 't-undet',
      round: 1,
      verdict: 'stale',
      changed_file_count: 0,
      changed_files_determined: false,
    }],
  })
  assert.ok(undet.includes('改动未探测'), `探测不可信时必须说「改动未探测」，实际：${undet}`)
  assert.ok(!undet.includes('改动 0 文件'), `探测不可信时严禁说「改动 0 文件」，实际：${undet}`)

  const det = teamMod.renderTeamDigest({
    counts: { pass: 1 },
    summary: '',
    tasks: [{
      task_id: 't-det',
      round: 1,
      verdict: 'pass',
      changed_file_count: 3,
      changed_files_determined: true,
    }],
  })
  assert.ok(det.includes('改动 3 文件'), `探测可信时应照常报数，实际：${det}`)

  // 2. 端到端：基线已通过 → stale → **根本没探测过磁盘** → 汇总必须如实说「改动未探测」
  const ledger = new RunsLedger(`${TMP}/team-tg.ndjson`)
  const ctx = fakeCtx({
    agyJsonOutput: agyJson('conv-tg'),
    verifyByCommand: { 'npm test': { exitCode: 0, stdout: 'ok' } },
  })
  const getDef = captureTool(ctx)
  teamMod.registerWolfTeam(ctx, baseConfig(ledger))
  const tool = getDef()

  const value = await tool.execute({
    tasks: [{
      task_id: 't-stale',
      task: '不该被派出去（基线已过）',
      verify_baseline: ['npm test'],
      verify: ['npm test'],
    }],
  }, agentExec())

  assert.equal(value.tasks[0].verdict, 'stale')
  assert.equal(value.tasks[0].changed_files_determined, false,
    'stale 时根本没探测磁盘，必须如实标 false')
  assert.ok(value.summary.includes('改动未探测'),
    `汇总必须说「改动未探测」，实际：${value.summary}`)
  assert.ok(!value.summary.includes('改动 0 文件'),
    `汇总严禁把「没探测」写成「改动 0 文件」，实际：${value.summary}`)
})

/* ── Z. 统一核与运行时测试 (Wolfpack Unified) ───────────────────────── */

console.log('\nZ. 统一核与运行时测试 (Wolfpack Unified)')

await ta('runtime-node-spawn', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const nodeRtPath = existsSync(join(here, 'runtime', 'node.mjs'))
    ? './runtime/node.mjs'
    : (existsSync(join(here, 'lib', 'runtime', 'node.mjs')) ? './lib/runtime/node.mjs' : '../lib/runtime/node.mjs')
  const { createNodeRuntime } = await import(nodeRtPath)
  const rt = createNodeRuntime()
  const proc = rt.spawn({
    argv: [process.execPath, '-e', 'console.log("hello node runtime"); process.exit(0)'],
  })
  const outcome = await proc.done
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.error, undefined)
  const text = proc.collected.stdout.readFrom(0).text.trim()
  assert.equal(text, 'hello node runtime')
})

await ta('runtime-dsh-delegates-to-ctx-subprocess', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const dshRtPath = existsSync(join(here, 'runtime', 'dsh.mjs'))
    ? './runtime/dsh.mjs'
    : (existsSync(join(here, 'lib', 'runtime', 'dsh.mjs')) ? './lib/runtime/dsh.mjs' : '../lib/runtime/dsh.mjs')
  const { createDshRuntime } = await import(dshRtPath)
  let capturedSpec
  const fakeSubprocess = {
    spawn(spec) {
      capturedSpec = spec
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'ok', nextOffset: 2, spillPath: 'C:/spill/run.log' }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0 }) },
        },
        terminate() {},
      }
    }
  }
  const rt = createDshRuntime({ subprocess: fakeSubprocess })
  const res = rt.spawn({
    argv: ['agy', '-p', 'task'],
    cwd: 'C:/repo',
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024, spill: { maxBytes: 50 * 1024 * 1024 } },
      stderr: { maxBytes: 512 },
    },
    graceMs: 3000,
  })
  assert.ok(capturedSpec, 'dsh runtime 必须调用 ctx.subprocess.spawn')
  assert.deepEqual(capturedSpec.argv, ['agy', '-p', 'task'])
  assert.equal(capturedSpec.cwd, 'C:/repo')
  assert.equal(capturedSpec.graceMs, 3000)
  assert.equal(capturedSpec.stdio.stdout.spill.maxBytes, 50 * 1024 * 1024)
  assert.equal(res.collected.stdout.readFrom(0).spillPath, 'C:/spill/run.log')
})

await ta('core-has-no-child-process-import', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(here, 'core'),
    join(here, 'lib', 'core'),
    join(here, '..', 'lib', 'core'),
    'D:\\DSH-Plugins\\wolfpack-unified\\lib\\core',
  ]
  const coreDir = candidates.find(d => existsSync(d))
  assert.ok(coreDir, `找不到 lib/core 目录，候选: ${candidates.join(', ')}`)

  const { readdirSync, readFileSync } = await import('node:fs')
  function scanDir(dir) {
    const files = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...scanDir(full))
      } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
        files.push(full)
      }
    }
    return files
  }

  const allCoreFiles = scanDir(coreDir)
  assert.ok(allCoreFiles.length >= 8, `lib/core 下的文件数应不少于 8 个，实际发现 ${allCoreFiles.length}`)

  for (const file of allCoreFiles) {
    const content = readFileSync(file, 'utf8')
    assert.ok(
      !content.includes('child_process'),
      `lib/core 文件 ${file} 严禁包含 child_process 引用，核心层必须宿主无关`
    )
  }
})

await ta('cli-mcp-share-core', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const ledgerModPath = existsSync(join(here, 'core', 'ledger.mjs'))
    ? './core/ledger.mjs'
    : (existsSync(join(here, 'lib', 'core', 'ledger.mjs')) ? './lib/core/ledger.mjs' : '../lib/core/ledger.mjs')
  const { queryWolfStatus, RunsLedger: LedgerClass } = await import(ledgerModPath)

  const testLedgerPath = join(TMP, 'share-core-ledger.ndjson')
  const ledger = new LedgerClass(testLedgerPath)
  await ledger.record({
    taskId: 'task-share',
    round: 1,
    conversationId: 'conv-share-123',
    cwd: 'C:/app',
    stopReason: 'completed',
    verdict: 'pass',
    changedFiles: ['fileA.txt'],
    durationMs: 1500,
    tokens: 4200,
  })

  const cfg = { ledgerPath: testLedgerPath, continuationTokenBudget: 1000000 }
  const cliStatus = await queryWolfStatus({ ledger, taskId: undefined, limit: 20, config: cfg })
  const mcpStatus = await queryWolfStatus({ ledger, taskId: undefined, limit: 20, config: cfg })

  assert.deepEqual(Object.keys(cliStatus), Object.keys(mcpStatus))
  assert.equal(cliStatus.tasks.length, 1)
  assert.equal(mcpStatus.tasks.length, 1)
  assert.deepEqual(Object.keys(cliStatus.tasks[0]), Object.keys(mcpStatus.tasks[0]))
  assert.equal(cliStatus.tasks[0].task_id, 'task-share')
  assert.equal(mcpStatus.tasks[0].task_id, 'task-share')
  assert.equal(cliStatus.tasks[0].last_verdict, 'pass')
  assert.equal(mcpStatus.tasks[0].last_verdict, 'pass')
})

await ta('dsh-shell-uses-core', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(here, 'index.js'),
    join(here, 'lib', 'index.js'),
    join(here, '..', 'lib', 'index.js'),
    'D:\\DSH-Plugins\\wolfpack-unified\\lib\\index.js',
  ]
  const indexPath = candidates.find(p => existsSync(p))
  assert.ok(indexPath, `找不到 index.js，候选: ${candidates.join(', ')}`)

  const content = readFileSync(indexPath, 'utf8')
  assert.ok(!content.includes("from './agy-runner.js'"), 'lib/index.js 严禁从 agy-runner.js 导入')
  assert.ok(!content.includes("from './wolf-delegate.js'"), 'lib/index.js 严禁从 wolf-delegate.js 导入')
  assert.ok(!content.includes("from './wolf-team.js'"), 'lib/index.js 严禁从 wolf-team.js 导入')
  assert.ok(!content.includes('D:\\\\AntigravityCLI\\\\agy.exe'), 'lib/index.js 严禁硬编码 agy 路径')

  assert.ok(content.includes('./core/delegate.mjs'), 'lib/index.js 必须从 ./core/delegate.mjs 导入委派机制')
  assert.ok(content.includes('./core/ledger.mjs'), 'lib/index.js 必须从 ./core/ledger.mjs 导入台账机制')
  assert.ok(content.includes('./core/verify.mjs'), 'lib/index.js 必须从 ./core/verify.mjs 导入验收机制')
  assert.ok(content.includes('./core/digest.mjs'), 'lib/index.js 必须从 ./core/digest.mjs 导入摘要渲染')
  assert.ok(content.includes('./core/team.mjs'), 'lib/index.js 必须从 ./core/team.mjs 导入并发小队')
  assert.ok(content.includes('DshRuntime') || content.includes('createDshRuntime'), 'lib/index.js 必须使用 DshRuntime 纳管子进程')

  let spawned = false
  const fakeCtx = {
    get: name => {
      if (name === 'subprocess') {
        return {
          spawn: () => {
            spawned = true
            return {
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: { stdout: { readFrom: () => ({ text: 'ok' }) } },
              terminate: () => {},
              waitForExit: () => {},
            }
          },
        }
      }
      return undefined
    },
  }
  const rtPath = existsSync(join(here, 'runtime', 'dsh.mjs'))
    ? './runtime/dsh.mjs'
    : (existsSync(join(here, 'lib', 'runtime', 'dsh.mjs')) ? './lib/runtime/dsh.mjs' : '../lib/runtime/dsh.mjs')
  const { createDshRuntime: makeRuntime } = await import(rtPath)
  const rt = makeRuntime(fakeCtx)
  rt.spawn({ argv: ['git', 'status'] })
  assert.equal(spawned, true, 'DshRuntime 必须将 spawn 透传给 ctx.subprocess')
})

await ta('no-duplicate-delegation-impl', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const checkFile = rel => {
    const candidates = [
      join(here, rel),
      join(here, 'lib', rel),
      join(here, '..', 'lib', rel),
      `D:\\DSH-Plugins\\wolfpack-unified\\lib\\${rel}`,
    ]
    const p = candidates.find(c => existsSync(c))
    assert.ok(p, `找不到 ${rel}，候选: ${candidates.join(', ')}`)
    const size = statSync(p).size
    assert.ok(
      size <= 2000,
      `${rel} 大小为 ${size} 字节，超过了 2000 字节上限，必须为纯 re-export 薄壳`
    )
    return size
  }

  const agyRunnerSize = checkFile('agy-runner.js')
  const wolfDelegateSize = checkFile('wolf-delegate.js')
  const wolfTeamSize = checkFile('wolf-team.js')
  const runsLedgerSize = checkFile('runs-ledger.js')

  assert.ok(agyRunnerSize <= 2000)
  assert.ok(wolfDelegateSize <= 2000)
  assert.ok(wolfTeamSize <= 2000)
  assert.ok(runsLedgerSize <= 2000)
})

await ta('core-has-no-host-imports', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(here, 'core'),
    join(here, 'lib', 'core'),
    join(here, '..', 'lib', 'core'),
    'D:\\DSH-Plugins\\wolfpack-unified\\lib\\core',
  ]
  const coreDir = candidates.find(d => existsSync(d))
  assert.ok(coreDir, `找不到 lib/core 目录，候选: ${candidates.join(', ')}`)

  const { readdirSync, readFileSync } = await import('node:fs')
  function scanDir(dir) {
    const files = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...scanDir(full))
      } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
        files.push(full)
      }
    }
    return files
  }

  const allCoreFiles = scanDir(coreDir)
  assert.ok(allCoreFiles.length >= 8, `lib/core 下的文件数应不少于 8 个，实际发现 ${allCoreFiles.length}`)

  for (const file of allCoreFiles) {
    const content = readFileSync(file, 'utf8')
    assert.ok(
      !content.includes("from '../") && !content.includes('from "../'),
      `lib/core 文件 ${file} 严禁包含向上越界 import ('../')`
    )
    assert.ok(
      !content.includes('stall-monitor.js'),
      `lib/core 文件 ${file} 严禁包含 stall-monitor.js 宿主模块字样`
    )
    assert.ok(
      !content.includes('runtime/dsh'),
      `lib/core 文件 ${file} 严禁包含 runtime/dsh 宿主运行时字样`
    )
  }
})

await ta('stall-monitor-injected-toast', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const stallCorePath = existsSync(join(here, 'core', 'stall-monitor.mjs'))
    ? './core/stall-monitor.mjs'
    : (existsSync(join(here, 'lib', 'core', 'stall-monitor.mjs')) ? './lib/core/stall-monitor.mjs' : '../lib/core/stall-monitor.mjs')
  const delegateCorePath = existsSync(join(here, 'core', 'delegate.mjs'))
    ? './core/delegate.mjs'
    : (existsSync(join(here, 'lib', 'core', 'delegate.mjs')) ? './lib/core/delegate.mjs' : '../lib/core/delegate.mjs')

  const { createStallMonitor } = await import(stallCorePath)
  const { reportStall } = await import(delegateCorePath)

  const testRoot = join(TMP, 'stall-injected-toast-root')
  const logsDir = join(testRoot, 'brain', 'conv-toast-1', '.system_generated', 'logs')
  await mkdir(logsDir, { recursive: true })
  writeFileSync(join(logsDir, 'transcript.jsonl'), '{"step":1}\n')

  // 1. 未注入 toast 实现：只写台账、控制台告警、不崩溃
  const stallLogPath1 = join(TMP, 'stall-no-toast.ndjson')
  let warnCalled1 = false
  const clock1 = { at: 1_000_000 }
  const monitorNoToast = createStallMonitor({
    storeRoot: testRoot,
    conversationIds: ['conv-toast-1'],
    windowMs: 1_000,
    maxWarnings: 3,
    now: () => clock1.at,
    onWarning: () => { warnCalled1 = true },
  })

  await monitorNoToast.poll()
  clock1.at += 1_500
  await monitorNoToast.poll()
  assert.equal(warnCalled1, true, '监控应正常产生 warning')

  await reportStall({
    config: { stallLogPath: stallLogPath1 },
    taskId: 'task-no-toast',
    conversationId: 'conv-toast-1',
    warning: { level: 1, maxWarnings: 3, silentMs: 1_500 },
  })
  assert.ok(existsSync(stallLogPath1), '未注入 toast 时台账必须正常记录')
  const logContent1 = readFileSync(stallLogPath1, 'utf8')
  assert.ok(logContent1.includes('task-no-toast'))

  // 2. 注入 toast 实现：确实调用了注入的实现
  const stallLogPath2 = join(TMP, 'stall-with-toast.ndjson')
  let monitorToastReceived = undefined
  const clock2 = { at: 2_000_000 }
  const monitorWithToast = createStallMonitor({
    storeRoot: testRoot,
    conversationIds: ['conv-toast-1'],
    windowMs: 1_000,
    maxWarnings: 3,
    now: () => clock2.at,
    onToast: payload => { monitorToastReceived = payload },
  })

  await monitorWithToast.poll()
  clock2.at += 1_500
  await monitorWithToast.poll()
  assert.ok(monitorToastReceived, 'createStallMonitor 注入的 onToast 必须被调用')
  assert.equal(monitorToastReceived.level, 1)

  let reportToastReceived = undefined
  await reportStall({
    config: {
      stallLogPath: stallLogPath2,
      stallToastNotifier: payload => { reportToastReceived = payload },
    },
    taskId: 'task-with-toast',
    conversationId: 'conv-toast-1',
    warning: { level: 1, maxWarnings: 3, silentMs: 1_500 },
  })
  assert.ok(existsSync(stallLogPath2), '注入 toast 时台账也必须正常记录')
  assert.ok(reportToastReceived, 'reportStall 注入的 stallToastNotifier 必须被调用')
  assert.equal(reportToastReceived.taskId, 'task-with-toast')
  assert.equal(reportToastReceived.title, '狼群：agy 疑似停滞')
  assert.ok(reportToastReceived.message.includes('task-with-toast'))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

