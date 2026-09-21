import { readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { defaultActiveRuns } from './ledger.mjs'
import { listLiveRecords } from './live.mjs'
import { renderPanelHtml } from './panel-html.mjs'
import { clearTranscriptCache, readTranscriptTail, resolveTranscriptPath } from './live-transcript.mjs'
import { STALL_WORKERS, claudeProjectSlug, formatStallSummary, resolveStallConfigs } from './stall.mjs'
import { healthConfigOf, readHealthState, snapshotHealth } from './worker/health.mjs'

/**
 * 狼群实时路由（宿主无关的构建逻辑 + 一个本地 HTTP 实现）。
 *
 * 铁律：HTTP 路由纯只读，数据只走 HTTP，永不写入会话日志、永不进模型上下文；
 * 但 `renderLiveSummary` 的输出是**给调用方（主线程）看的**，会整段进入它的
 * 上下文并常驻——两者别混：进上下文的只有摘要文本，面板那条路确实不沾模型。
 *
 * **两个工人分开展示**：payload 里 `workers.agy` 与 `workers.claude` 各自持有
 * 自己的运行列表、token 累计、最近一次结果与停滞状态，前端按工人分区渲染。
 */

/** 实时状态 JSON 路由。 */
export const LIVE_ROUTE_PATH = '/wolfpack/live'
/** 面板 HTML 路由。 */
export const PANEL_ROUTE_PATH = '/wolfpack/panel'
/** 健康检查路由。 */
export const HEALTH_ROUTE_PATH = '/wolfpack/health'
/** 默认最多暴露的运行数。 */
export const MAX_LIVE_RUNS = 8
/** 「显示全部」时的硬上限，防止一次把响应体拉爆。 */
export const MAX_LIVE_RUNS_HARD = 50
/** 响应体最大字节数（32KB）。 */
export const MAX_PAYLOAD_BYTES = 32 * 1024

/** 工人的展示名（前端标题用，避免前端自己拼）。 */
export const WORKER_LABELS = {
  agy: 'Antigravity CLI（agy）',
  claude: 'Claude Code CLI（claude）',
}

/**
 * 从 `?limit=` 解析面板「显示全部」请求的运行条数。
 * 查询参数是外部输入，始终夹在 [1, MAX_LIVE_RUNS_HARD]。
 *
 * @param {{url?: string}} req
 * @returns {number}
 */
export function parseMaxRuns(req) {
  try {
    const raw = new URL(req?.url ?? '/', 'http://localhost').searchParams.get('limit')
    if (raw === null || raw.trim() === '') return MAX_LIVE_RUNS
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return MAX_LIVE_RUNS
    return Math.max(1, Math.min(n, MAX_LIVE_RUNS_HARD))
  } catch {
    return MAX_LIVE_RUNS
  }
}

/**
 * 运行中的 claude 任务：会话 ID 要等 stdout 出来才有，
 * 但 Claude Code CLI 的流水文件在跑的时候就在写——按 cwd 的项目目录取最新的那个。
 *
 * @param {string|undefined} storeRoot
 * @param {string} [cwd]
 * @returns {Promise<string|undefined>}
 */
async function newestClaudeSessionFile(storeRoot, cwd) {
  if (typeof storeRoot !== 'string' || storeRoot === '' || typeof cwd !== 'string' || cwd === '') return undefined
  const projectDir = join(storeRoot, claudeProjectSlug(cwd))
  let names
  try {
    names = await readdir(projectDir)
  } catch {
    return undefined
  }
  let best
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const full = join(projectDir, name)
    try {
      const s = await stat(full)
      if (!best || s.mtimeMs > best.mtimeMs) best = { mtimeMs: s.mtimeMs, file: full }
    } catch {
      // 跳过读不到的条目
    }
  }
  return best?.file
}

/**
 * agy 尚未产生 conversationId 时的兜底：brain/ 下 mtime 最新的那个会话的流水。
 * **只在恰好一个 agy 运行在跑时使用**，否则宁可不猜（避免把别人的会话显示成本任务的）。
 *
 * @param {string} storeRoot
 * @returns {Promise<string|undefined>}
 */
async function newestAgyTranscript(storeRoot) {
  if (typeof storeRoot !== 'string' || storeRoot === '') return undefined
  const brainDir = join(storeRoot, 'brain')
  let names
  try {
    names = await readdir(brainDir)
  } catch {
    return undefined
  }
  let best
  for (const name of names) {
    const dir = join(brainDir, name)
    try {
      const info = await stat(dir)
      if (info.isDirectory() !== true) continue
      if (!best || info.mtimeMs > best.mtimeMs) best = { mtimeMs: info.mtimeMs, dir }
    } catch {
      // 跳过读不到的条目
    }
  }
  if (best === undefined) return undefined
  for (const fileName of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const candidate = join(best.dir, '.system_generated', 'logs', fileName)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // 试下一个候选
    }
  }
  return undefined
}

/**
 * 读某个运行对应的会话流水尾部（两个工人各走各的路径）。
 *
 * @param {object} params
 * @param {string} params.worker
 * @param {boolean} params.running
 * @param {object} params.stallConfig
 * @param {string|undefined} params.conversationId
 * @param {string} [params.cwd]
 * @param {boolean} [params.allowNewestFallback] - 会话 ID 未产生时能否按「最新会话」兜底。
 *   两个工人都靠它防串台：同一目录下多开时，「最新会话」分不清是谁的，猜错就是报错人。
 * @returns {Promise<object>}
 */
async function readRunTranscript({ worker, running, stallConfig, conversationId, cwd, allowNewestFallback }) {
  // 配置里两个工人的存储根是 camelCase（resolveStallConfigs），也兼容 snake_case
  const storeRoot = stallConfig?.storeRoot ?? stallConfig?.store_root
  const empty = reason => ({ available: false, reason, events: [], step_index: null, step_total: 0 })

  if (typeof storeRoot !== 'string' || storeRoot === '') {
    return empty(`${worker} 的会话存储根不可用`)
  }

  let filePath = await resolveTranscriptPath(worker, { storeRoot, conversationId, cwd })
  // claude 的 conversationId 要等本轮结束才拿得到；同一个 cwd 下多开时
  // 「最新会话」根本认不出是谁的，认领错了就会把 A 的流水报成 B、C 的。
  // 只有该工人只有一个在跑时才兜底（多开时不猜，避免串台）。
  if (filePath === undefined && worker === 'claude' && running === true && allowNewestFallback === true) {
    filePath = await newestClaudeSessionFile(storeRoot, cwd)
  }
  // agy 的 conversationId 要等本轮结束才拿得到；只有一个 agy 运行在跑时，
  // 就按 brain/ 下最新的那个会话兜底（多开时不猜，避免串台）
  if (filePath === undefined && worker === 'agy' && running === true && allowNewestFallback === true) {
    filePath = await newestAgyTranscript(storeRoot)
  }
  if (filePath === undefined) {
    return empty(conversationId === undefined || conversationId === ''
      ? '会话 ID 尚未产生（本轮结束后可读）'
      : '未找到会话流水文件')
  }

  // 正在跑的文件随时在追加，必须每次读新的；已结束的走 (size, mtime) 缓存。
  return readTranscriptTail(worker, filePath, { cache: running !== true })
}

/**
 * 把磁盘上的活运行登记（**别的进程**派发的任务）并进进程内的 liveHandles。
 *
 * 面板与 CLI 是两个进程：谁派活的谁持有 stallMonitor，别的进程只有登记文件。
 * 本函数把登记文件还原成 handle 形状（含该工人自己的 stall 快照），
 * 进程内已有的条目优先（它带的是活的 stallMonitor）。
 *
 * @param {string} rawDir
 * @param {Map<string, object>} [handles]
 * @returns {Promise<Map<string, object>>}
 */
export async function mergeLiveRecords(rawDir, handles = new Map()) {
  const merged = new Map(handles)
  if (typeof rawDir !== 'string' || rawDir === '') return merged

  const records = await listLiveRecords(rawDir)
  for (const record of records) {
    const taskId = record?.taskId
    if (!taskId || merged.has(taskId)) continue
    const stall = record.stall
    merged.set(taskId, {
      taskId,
      runId: record.runId,
      worker: record.worker,
      workerReason: record.workerReason,
      cwd: record.cwd,
      round: record.round,
      continuing: record.continuing,
      conversationId: record.conversationId ?? undefined,
      startedAt: record.startedAt,
      // 磁盘登记只有快照，没有活的监控对象——按 handle 契约包一层只读快照
      ...(stall === undefined ? {} : { stallMonitor: { snapshot: () => stall } }),
    })
  }
  return merged
}

/**
 * 构造有界的实时状态数据（**按工人分区**）。
 *
 * @param {object} [config]
 * @returns {Promise<object>}
 */
export async function buildLivePayload(config = {}) {
  const now = Date.now()
  const registry = config.activeRuns ?? defaultActiveRuns
  const handles = config.liveHandles instanceof Map ? config.liveHandles : new Map()

  const activeList = Array.isArray(config.activeRuns)
    ? config.activeRuns
    : (typeof registry?.list === 'function' ? registry.list() : [])
  const activeMap = new Map()
  for (const item of activeList) {
    const taskId = item.taskId ?? item.task_id
    if (taskId) activeMap.set(taskId, item)
  }
  for (const handle of handles.values()) {
    if (handle?.taskId) activeMap.set(handle.taskId, { ...(activeMap.get(handle.taskId) ?? {}), ...handle })
  }

  let ledgerTasks = []
  if (config.ledger && typeof config.ledger.read === 'function') {
    try {
      ledgerTasks = [...(await config.ledger.read()).values()]
    } catch {
      ledgerTasks = []
    }
  }
  const ledgerMap = new Map(ledgerTasks.map(t => [t.taskId, t]))
  const stallConfigs = config.stallConfigs ?? resolveStallConfigs({ config })
  // 工人健康：只读台账，面板与 CLI 都能看到「谁在冷却、还剩多久」
  const healthConfig = healthConfigOf(config)
  const healthState = await readHealthState(config.workerHealth?.filePath)

  // ── 1. 运行中的任务 ───────────────────────────────────────────────
  const runningByWorker = new Map(STALL_WORKERS.map(w => [w, []]))
  for (const [taskId, activeItem] of activeMap) {
    const taskState = ledgerMap.get(taskId)
    const handle = handles.get(taskId)
    const worker = activeItem.worker ?? handle?.worker ?? taskState?.worker ?? 'agy'
    const run = {
      task_id: taskId,
      worker,
      status: 'running',
      round: activeItem.round ?? handle?.round ?? taskState?.round ?? 1,
    }
    const runId = activeItem.runId ?? handle?.runId
    if (runId !== undefined) run.run_id = runId
    const startedAt = activeItem.startedAt ?? handle?.startedAt
    if (startedAt !== undefined) {
      run.started_at = startedAt
      run.elapsed_ms = Math.max(0, now - startedAt)
    }
    if (handle?.continuing === true) run.continued = true
    if (typeof handle?.workerReason === 'string') run.worker_reason = handle.workerReason
    if (taskState?.totalTokens !== undefined) run.total_tokens = taskState.totalTokens
    if (taskState?.lastVerdict !== undefined) run.verdict = taskState.lastVerdict
    if (taskState?.lastStopReason !== undefined) run.stop_reason = taskState.lastStopReason
    if (handle?.cwd !== undefined) run.cwd = handle.cwd
    run._conversationId = taskState?.conversationId ?? handle?.conversationId
    run._stall = typeof handle?.stallMonitor?.snapshot === 'function' ? handle.stallMonitor.snapshot() : undefined
    if (!runningByWorker.has(worker)) runningByWorker.set(worker, [])
    runningByWorker.get(worker).push(run)
  }

  // ── 2. 空闲任务（按最近活动倒序）──────────────────────────────────
  const idleByWorker = new Map(STALL_WORKERS.map(w => [w, []]))
  const idleTasks = ledgerTasks
    .filter(t => !activeMap.has(t.taskId))
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

  for (const t of idleTasks) {
    const worker = typeof t.worker === 'string' && t.worker !== '' ? t.worker : 'agy'
    const run = {
      task_id: t.taskId,
      worker,
      status: 'idle',
      round: t.round ?? 1,
    }
    // lastAt 是「最后一次活动时刻」，不是开始时刻——如实命名为 finished_at
    if (t.lastAt !== undefined) run.finished_at = t.lastAt
    if (typeof t.lastDurationMs === 'number') run.elapsed_ms = t.lastDurationMs
    if (t.totalTokens !== undefined) run.total_tokens = t.totalTokens
    if (t.totalCacheReadTokens !== undefined) run.cache_read_tokens = t.totalCacheReadTokens
    if (t.lastVerdict !== undefined) run.verdict = t.lastVerdict
    if (t.lastStopReason !== undefined) run.stop_reason = t.lastStopReason
    if (typeof t.stallWarnings === 'number') run.stall_warnings = t.stallWarnings
    if (Array.isArray(t.changedFiles)) run.changed_file_count = t.changedFiles.length
    run._conversationId = t.conversationId
    run._cwd = t.cwd
    if (!idleByWorker.has(worker)) idleByWorker.set(worker, [])
    idleByWorker.get(worker).push(run)
  }

  const requested = Number.isFinite(config.maxRuns) ? Math.trunc(config.maxRuns) : MAX_LIVE_RUNS
  const maxRuns = Math.max(1, Math.min(requested, MAX_LIVE_RUNS_HARD))

  /**
   * 轮转取样：两个工人都要出现在有界响应里，不能被一个工人挤掉。
   *
   * @param {Map<string, object[]>} groups
   * @returns {object[]}
   */
  function roundRobinPick(groups) {
    const picked = []
    let index = 0
    let added = true
    while (added && picked.length < maxRuns) {
      added = false
      for (const list of groups.values()) {
        if (index < list.length && picked.length < maxRuns) {
          picked.push(list[index])
          added = true
        }
      }
      index += 1
    }
    return picked
  }

  const workerKeys = [...new Set([...runningByWorker.keys(), ...idleByWorker.keys()])]
  const runningGroups = new Map(workerKeys.map(w => [w, runningByWorker.get(w) ?? []]))
  const idleGroups = new Map(workerKeys.map(w => [w, idleByWorker.get(w) ?? []]))
  const selected = [...roundRobinPick(runningGroups), ...roundRobinPick(idleGroups)]

  // ── 3. 读取每个运行自己的工人流水 ────────────────────────────────
  const runs = await Promise.all(selected.map(async item => {
    const worker = item.worker
    const conversationId = item._conversationId
    const cwd = item._cwd ?? item.cwd
    const running = item.status === 'running'
    const stall = item._stall
    delete item._conversationId
    delete item._cwd
    delete item._stall

    const transcript = await readRunTranscript({
      worker,
      running,
      stallConfig: stallConfigs?.[worker],
      conversationId,
      cwd,
      allowNewestFallback: (runningByWorker.get(worker) ?? []).length === 1,
    })

    return {
      ...item,
      ...(stall === undefined ? {} : { stall }),
      step_index: transcript.step_index,
      step_total: transcript.step_total,
      transcript,
    }
  }))

  // ── 4. 逐工人汇总（前端分区渲染的数据源）────────────────────────
  const workers = {}
  for (const worker of STALL_WORKERS) {
    const workerRuns = runs.filter(r => r.worker === worker)
    const running = workerRuns.filter(r => r.status === 'running')
    const idle = workerRuns.filter(r => r.status === 'idle')
    const ledgerOfWorker = ledgerTasks.filter(t => (t.worker ?? 'agy') === worker)
    const lastIdle = ledgerOfWorker.slice().sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))[0]

    workers[worker] = {
      worker,
      label: WORKER_LABELS[worker] ?? worker,
      // 两个工人的存储根与窗口各自独立（兼容 camelCase 与 snake_case 两种写法）
      store_root: stallConfigs?.[worker]?.storeRoot ?? stallConfigs?.[worker]?.store_root,
      stall_window_ms: stallConfigs?.[worker]?.windowMs ?? stallConfigs?.[worker]?.window_ms,
      stall: running.find(r => r.stall !== undefined)?.stall ?? null,
      health: healthConfig.enabled === false
        ? { worker, benched: false, disabled: true }
        : snapshotHealth(healthState, worker, now),
      counts: {
        running: running.length,
        idle: idle.length,
        ledger_total: ledgerOfWorker.length,
      },
      tokens: {
        total: ledgerOfWorker.reduce((sum, t) => sum + (t.totalTokens ?? 0), 0),
        cache_read: ledgerOfWorker.reduce((sum, t) => sum + (t.totalCacheReadTokens ?? 0), 0),
      },
      last_run: lastIdle === undefined
        ? null
        : {
            task_id: lastIdle.taskId,
            round: lastIdle.round ?? 1,
            verdict: lastIdle.lastVerdict,
            stop_reason: lastIdle.lastStopReason,
            at: lastIdle.lastAt,
            duration_ms: lastIdle.lastDurationMs,
            stall_warnings: lastIdle.stallWarnings,
          },
      running,
      idle,
    }
  }

  return {
    generated_at: now,
    runs,
    workers,
    ledger_total: ledgerTasks.length,
  }
}

/**
 * 人话版实时摘要（CLI `wolf live` 与 MCP `wolf_live` 共用）。
 * **两个工人各起一节**，谁都不会被另一个顶掉。
 *
 * 铁律：MCP 这条路上的回执会**整段进入调用方（主线程）的上下文并常驻**，
 * 之后每一轮都要重读一遍。所以默认只给「谁在跑、跑到第几步、停滞如何」这类
 * 短事实；工人会话流水等于把工人原文灌回主上下文，必须由调用方显式传
 * `transcript: true` 才附带。终端里的 `wolf live` 不进模型上下文，自己显式打开。
 *
 * @param {object} payload - buildLivePayload 的结果
 * @param {object} [options]
 * @param {boolean} [options.transcript] - 是否附带工人会话流水片段（默认 false）
 * @returns {string}
 */
export function renderLiveSummary(payload, { transcript = false } = {}) {
  const lines = []
  const stamp = new Date(payload?.generated_at ?? Date.now()).toLocaleString('zh-CN', { hour12: false })
  const runningTotal = (payload?.runs ?? []).filter(r => r.status === 'running').length
  lines.push(`🐺 狼群实时状态 · ${stamp}`)
  lines.push(`台账任务 ${payload?.ledger_total ?? 0} 条 · 当前运行 ${runningTotal} 条`)

  for (const worker of STALL_WORKERS) {
    const info = payload?.workers?.[worker]
    if (!info) continue
    lines.push('')
    lines.push(`── ${info.label ?? worker} ──`)
    lines.push(`运行中 ${info.counts?.running ?? 0} · 空闲 ${info.counts?.idle ?? 0}`
      + ` · 台账 ${info.counts?.ledger_total ?? 0} 条`
      + ` · 累计 token ${info.tokens?.total ?? 0}（cache read ${info.tokens?.cache_read ?? 0}）`)

    const stall = info.stall ?? (info.running ?? []).find(r => r.stall !== undefined)?.stall
    lines.push(stall
      ? `停滞监控：${formatStallSummary(stall)}`
      : '停滞监控：本轮未参与（没启动该工人的会话，因此没有采样数据）')

    for (const run of info.running ?? []) {
      const bits = [`第 ${run.round ?? 1} 轮`]
      if (run.continued === true) bits.push('续跑沿用会话')
      if (typeof run.worker_reason === 'string') bits.push(`路由 ${run.worker_reason}`)
      if (typeof run.elapsed_ms === 'number') bits.push(`已跑 ${Math.round(run.elapsed_ms / 1000)}s`)
      const step = run.step_index === undefined || run.step_index === null
        ? '步骤未知'
        : (run.step_total > 0 ? `步骤 ${run.step_index}/${run.step_total}` : `步骤 ${run.step_index}`)
      lines.push(`  ▶ ${run.task_id} · ${bits.join(' · ')} · ${step}`)
      // 工人流水会把工人原文灌回调用方上下文，默认不给，只有显式 opt-in 才附带。
      if (transcript === true) {
        for (const evt of (run.transcript?.events ?? []).slice(-3)) {
          lines.push(`      ${evt.kind ?? '事件'}：${String(evt.text ?? '').slice(0, 120)}`)
        }
      }
      if (run.transcript?.available === false && run.transcript?.reason) {
        lines.push(`      （流水不可读：${run.transcript.reason}）`)
      }
    }

    for (const run of (info.idle ?? []).slice(0, 3)) {
      const verdict = run.verdict ?? '未知'
      const when = typeof run.finished_at === 'number'
        ? new Date(run.finished_at).toLocaleTimeString('zh-CN', { hour12: false })
        : '时间未知'
      const tokens = run.total_tokens === undefined ? '' : ` · ${run.total_tokens} token`
      const warn = run.stall_warnings > 0 ? ` · 停滞报警 ${run.stall_warnings} 次` : ''
      lines.push(`  ○ ${run.task_id} · ${verdict} · ${when}${tokens}${warn}`)
    }
  }

  lines.push('')
  lines.push(`面板 ${PANEL_ROUTE_PATH}（走浏览器、不进你的上下文）· 机器可读 ${LIVE_ROUTE_PATH}`)
  return lines.join('\n')
}

/** 停滞快照里允许出现在有界响应中的字段（其余一律丢弃，防止响应体被撑爆）。 */
const STALL_SCALAR_KEYS = [
  'worker',
  'enabled',
  'window_ms',
  'max_warnings',
  'heartbeats',
  'unavailable',
  'warnings',
  'episodes',
  'exhausted',
  'last_progress_at',
  'last_warning_at',
  'silent_ms',
]

/**
 * 把停滞快照压成白名单标量；路径类字符串截到 200 字符。
 *
 * @param {object} stall
 * @returns {object}
 */
function compactStall(stall) {
  const out = {}
  for (const key of STALL_SCALAR_KEYS) {
    const value = stall[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  const root = stall.store_root
  if (typeof root === 'string' && root !== '') out.store_root = root.length > 200 ? `${root.slice(0, 200)}…` : root
  return out
}

/**
 * 响应体大小严格约束在 32KB 内（就地裁剪事件文本与条数）。
 *
 * @param {object} payload
 * @returns {string}
 */
export function enforcePayloadBounds(payload) {
  let json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json

  const eachRun = fn => {
    for (const run of payload.runs) fn(run)
  }

  // 0. 停滞快照先压成白名单标量：它来自磁盘登记，不能成为把响应体撑爆的缺口
  eachRun(run => {
    if (run.stall && typeof run.stall === 'object') run.stall = compactStall(run.stall)
  })
  json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json

  for (const limit of [200, 100, 50]) {
    eachRun(run => {
      if (Array.isArray(run.transcript?.events)) {
        for (const evt of run.transcript.events) {
          if (evt.text && evt.text.length > limit) evt.text = evt.text.slice(0, limit)
        }
      }
    })
    json = JSON.stringify(payload)
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json
  }

  for (const maxEvts of [6, 3, 1, 0]) {
    eachRun(run => {
      if (Array.isArray(run.transcript?.events) && run.transcript.events.length > maxEvts) {
        run.transcript.events = run.transcript.events.slice(-maxEvts)
      }
    })
    json = JSON.stringify(payload)
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json
  }

  // 削减运行条数：先从「每个工人保留 1 条」开始，再退到只剩 1 条
  const seenWorkers = new Set()
  payload.runs = payload.runs.filter(run => {
    if (seenWorkers.has(run.worker)) return false
    seenWorkers.add(run.worker)
    return true
  })
  json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json

  while (payload.runs.length > 1) {
    payload.runs.pop()
    json = JSON.stringify(payload)
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json
  }

  return json
}

/**
 * 统一处理一次实时面板 HTTP 请求（面板 HTML / 实时 JSON / 健康检查）。
 *
 * @param {object} req
 * @param {object} res
 * @param {object} config
 * @returns {Promise<boolean>} 是否已处理（false = 交给上层 404）
 */
export async function handleLiveRequest(req, res, config = {}) {
  const path = new URL(req?.url ?? '/', 'http://localhost').pathname

  if (path === PANEL_ROUTE_PATH || path === '/' || path === '/index.html') {
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(renderPanelHtml(config.panelOptions ?? {}))
    return true
  }

  if (path === HEALTH_ROUTE_PATH) {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ ok: true, at: Date.now() }))
    return true
  }

  if (path !== LIVE_ROUTE_PATH) return false

  try {
    const payload = await buildLivePayload({ ...config, maxRuns: parseMaxRuns(req) })
    const json = enforcePayloadBounds(payload)
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(json)
  } catch {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ error: 'internal error' }))
  }
  return true
}

/**
 * 注册实时状态只读路由（宿主契约：ctx.get('webServer')，可选 ctx.get('connection')）。
 * DSH 一类自带 webServer 的宿主可以只调这一个函数拿到实时路由 + 面板。
 *
 * @param {object} ctx
 * @param {object} [config]
 * @returns {() => void} disposer
 */
export function registerLiveRoute(ctx, config = {}) {
  const webServer = ctx?.get?.('webServer') ?? ctx?.webServer
  if (webServer === undefined || typeof webServer?.register !== 'function') {
    console.warn('wolfpack: webServer 服务不可用，跳过实时路由挂载')
    return () => {}
  }

  const registrations = []

  registrations.push(webServer.register({
    kind: 'exact',
    path: LIVE_ROUTE_PATH,
    handler: async (req, res) => {
      // 1. 鉴权：拿不到 connection 服务时 fail closed
      const connection = ctx?.get?.('connection') ?? ctx?.connection
      if (connection === undefined || typeof connection?.requestRejection !== 'function') {
        res.statusCode = 503
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ error: 'service unavailable: connection service required' }))
        return
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end()
        return
      }
      // 2. 只支持 GET
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      try {
        const payload = await buildLivePayload({ ...config, maxRuns: parseMaxRuns(req) })
        const json = enforcePayloadBounds(payload)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(json)
      } catch {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    },
  }))

  registrations.push(webServer.register({
    kind: 'exact',
    path: PANEL_ROUTE_PATH,
    handler: async (_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(renderPanelHtml(config.panelOptions ?? {}))
    },
  }))

  return () => {
    for (const registration of registrations) {
      try {
        if (typeof registration === 'function') registration()
        else if (typeof registration?.dispose === 'function') registration.dispose()
      } catch {
        // 忽略卸载异常
      }
    }
  }
}

/**
 * 起一个本地实时面板服务器（零依赖，默认只监听回环地址）。
 *
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.token]
 * @returns {Promise<{server: object, url: string, port: number, close: () => Promise<void>}>}
 */
export async function createLiveServer({ config = {}, host = '127.0.0.1', port = 8787, token } = {}) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.end()
      return
    }

    if (typeof token === 'string' && token !== '') {
      const url = new URL(req?.url ?? '/', 'http://localhost')
      const provided = url.searchParams.get('token') ?? req.headers?.['x-wolfpack-token']
      if (provided !== token) {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    }

    handleLiveRequest(req, res, config)
      .then(handled => {
        if (handled) return
        res.statusCode = 404
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'not found', routes: [LIVE_ROUTE_PATH, PANEL_ROUTE_PATH] }))
      })
      .catch(() => {
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'internal error' }))
      })
  })

  await new Promise((resolve, reject) => {
    const onError = err => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  const actualPort = server.address()?.port ?? port
  const suffix = typeof token === 'string' && token !== '' ? `?token=${encodeURIComponent(token)}` : ''
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}${PANEL_ROUTE_PATH}${suffix}`,
    close: async () => {
      clearTranscriptCache()
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}
