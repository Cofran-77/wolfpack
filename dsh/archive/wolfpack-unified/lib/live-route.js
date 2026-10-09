/**
 * 狼群模式 — 宿主实时状态 HTTP 路由。
 *
 * 铁律：纯只读，零 token。
 * 供浏览器右侧实时面板拉取正在跑的 agy 任务与最新 transcript 事件。
 * 数据仅走 HTTP 路由，永不写入会话日志，永不进模型上下文。
 */

import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultActiveRuns } from './core/ledger.mjs'
import { resolveStallConfig } from './stall-monitor.js'
import { liveRunHandles } from './core/delegate.mjs'

/** 路由路径（避开 /plugins/... 前缀）。 */
export const LIVE_ROUTE_PATH = '/wolfpack/live'

/** 最大并发暴露运行数。 */
export const MAX_LIVE_RUNS = 8

/** 「显示全部」时允许的最大运行条数：硬上限，防止一次把响应体拉爆。 */
export const MAX_LIVE_RUNS_HARD = 50

/** 每个运行最多返回的 transcript 事件数。 */
export const MAX_TRANSCRIPT_EVENTS = 12

/** 每条事件文本截断上限。 */
export const MAX_EVENT_TEXT_CHARS = 400

/** 尾部读取字节窗口（64KB）。 */
export const TAIL_READ_BYTES = 64 * 1024

/** 响应体最大字节数（32KB）。 */
export const MAX_PAYLOAD_BYTES = 32 * 1024

/**
 * 提取 transcript 单条记录的人类可读摘要文本。
 *
 * @param {Record<string, unknown>} entry
 * @param {number} [maxChars]
 * @returns {string}
 */
export function summarizeTranscriptEntry(entry, maxChars = MAX_EVENT_TEXT_CHARS) {
  if (!entry || typeof entry !== 'object') return ''

  let text = ''
  if (entry.thinking) {
    const think = String(entry.thinking).trim()
    if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
      const toolNames = entry.tool_calls
        .map(tc => (typeof tc === 'string' ? tc : tc?.name || 'tool'))
        .filter(Boolean)
        .join(', ')
      text = toolNames ? `[${toolNames}] ${think}` : think
    } else {
      text = think
    }
  } else if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
    text = entry.tool_calls
      .map(tc => (typeof tc === 'string' ? tc : tc?.name || 'tool'))
      .filter(Boolean)
      .join(', ')
  } else if (entry.content !== undefined && entry.content !== null) {
    text = typeof entry.content === 'string' ? entry.content.trim() : JSON.stringify(entry.content)
  } else if (entry.status) {
    text = String(entry.status)
  }

  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
  }
  return text
}

/**
 * 已结束任务的 transcript 不会再被追加，按 (size, mtimeMs) 缓存其尾部读取结果，
 * 免掉面板每轮都重读同一批文件（默认 8 个卡片 × 64KB / 轮）。
 *
 * 只对**没有在跑**的任务使用——正在跑的文件随时在追加，必须每次读新的。
 * 内容变了 size 与 mtimeMs 必然至少变一个，届时自动重读。
 */
const TAIL_CACHE_MAX_ENTRIES = 32

/** @type {Map<string, {size: number, mtimeMs: number, value: object}>} */
const tailCache = new Map()

/**
 * 防御性副本：`enforcePayloadBounds` 会**就地改写**事件文本，
 * 若把缓存对象直接交出去，那次改写会把缓存本身污染掉，下一轮就返回被截断的内容。
 *
 * @param {object} transcript
 * @returns {object}
 */
function cloneTranscript(transcript) {
  return {
    ...transcript,
    events: Array.isArray(transcript.events) ? transcript.events.map(e => ({ ...e })) : [],
  }
}

/**
 * 带缓存的 tail 读取（仅供已结束任务使用）。
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function readTranscriptTailCached(filePath) {
  let size
  let mtimeMs
  try {
    const s = await stat(filePath)
    size = s.size
    mtimeMs = s.mtimeMs
  } catch {
    // 拿不到 stat 就交给原实现产出结构化错误，结果不进缓存
    return readTranscriptTail(filePath)
  }

  const hit = tailCache.get(filePath)
  if (hit !== undefined && hit.size === size && hit.mtimeMs === mtimeMs) {
    tailCache.delete(filePath) // 命中后移到队尾（LRU）
    tailCache.set(filePath, hit)
    return cloneTranscript(hit.value)
  }

  const value = await readTranscriptTail(filePath)
  tailCache.delete(filePath)
  tailCache.set(filePath, { size, mtimeMs, value })
  while (tailCache.size > TAIL_CACHE_MAX_ENTRIES) {
    const oldest = tailCache.keys().next().value
    tailCache.delete(oldest)
  }
  return cloneTranscript(value)
}

/**
 * 只读 tail 读取 transcript.jsonl。
 *
 * @param {string} filePath
 * @param {number} [maxEvents]
 * @param {number} [maxChars]
 * @returns {Promise<{available: boolean, reason?: string, events: Array<{at?: string, kind: string, text: string}>}>}
 */
export async function readTranscriptTail(filePath, maxEvents = MAX_TRANSCRIPT_EVENTS, maxChars = MAX_EVENT_TEXT_CHARS) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { available: false, reason: '路径无效', events: [], step_index: null, step_total: 0 }
  }

  let fileHandle
  try {
    fileHandle = await open(filePath, 'r')
    const fileStat = await fileHandle.stat()
    const size = fileStat.size
    if (size === 0) {
      return { available: true, events: [], step_index: null, step_total: 0 }
    }

    const readLen = Math.min(size, TAIL_READ_BYTES)
    const position = size - readLen
    const buffer = Buffer.alloc(readLen)
    const { bytesRead } = await fileHandle.read(buffer, 0, readLen, position)
    const text = buffer.subarray(0, bytesRead).toString('utf8')

    const lines = text.split('\n')
    const parsedEntries = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const item = JSON.parse(trimmed)
        if (item && typeof item === 'object') {
          parsedEntries.push(item)
        }
      } catch {
        // 跳过解析失败的行（首行或尾行常是半截）
      }
    }

    if (parsedEntries.length === 0 && size > 0) {
      return { available: false, reason: '未解析到有效记录', events: [], step_index: null, step_total: 0 }
    }

    const lastEntry = parsedEntries[parsedEntries.length - 1]
    const step_index = (lastEntry && typeof lastEntry.step_index === 'number') ? lastEntry.step_index : null
    const step_total = parsedEntries.length

    const recent = parsedEntries.slice(-maxEvents)
    const events = recent.map(entry => {
      const evt = {
        kind: String(entry.type ?? entry.source ?? 'unknown'),
        text: summarizeTranscriptEntry(entry, maxChars),
      }
      if (entry.created_at) {
        evt.at = String(entry.created_at)
      }
      return evt
    })

    return { available: true, step_index, step_total, events }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      events: [],
      step_index: null,
      step_total: 0,
    }
  } finally {
    if (fileHandle !== undefined) {
      await fileHandle.close().catch(() => {})
    }
  }
}

/**
 * 确定 storeRoot。
 *
 * @param {object} [config]
 * @returns {string|undefined}
 */
function resolveStoreRoot(config = {}) {
  if (typeof config?.storeRoot === 'string' && config.storeRoot.trim() !== '') {
    return config.storeRoot.trim()
  }
  if (typeof config?.stallStoreRoot === 'string' && config.stallStoreRoot.trim() !== '') {
    return config.stallStoreRoot.trim()
  }
  return resolveStallConfig().storeRoot
}

/**
 * 构造有界的实时状态数据。
 *
 * @param {object} [config]
 * @returns {Promise<object>}
 */
export async function buildLivePayload(config = {}) {
  const now = Date.now()
  const registry = config.activeRuns ?? defaultActiveRuns
  const activeList = Array.isArray(config.activeRuns)
    ? config.activeRuns
    : (typeof registry?.list === 'function' ? registry.list() : [])

  const activeMap = new Map()
  for (const item of activeList) {
    const taskId = item.taskId ?? item.task_id
    if (taskId) {
      activeMap.set(taskId, item)
    }
  }

  let ledgerTasks = []
  if (config.ledger && typeof config.ledger.read === 'function') {
    try {
      const map = await config.ledger.read()
      ledgerTasks = [...map.values()]
    } catch {
      ledgerTasks = []
    }
  }
  const ledgerMap = new Map(ledgerTasks.map(t => [t.taskId, t]))
  const ledger_total = ledgerTasks.length

  const storeRoot = resolveStoreRoot(config)

  // 1. 正在运行的任务
  const runningRuns = []
  for (const [taskId, activeItem] of activeMap) {
    const taskState = ledgerMap.get(taskId)
    const runId = activeItem.runId ?? activeItem.run_id
    const startedAt = activeItem.startedAt ?? activeItem.started_at
    const handle = liveRunHandles.get(taskId)
    const round = activeItem.round ?? handle?.round ?? taskState?.round ?? 1
    const convId = activeItem.conversationId ?? activeItem.conversation_id ?? taskState?.conversationId

    const runObj = {
      task_id: taskId,
      status: 'running',
      round,
    }
    if (runId !== undefined) runObj.run_id = runId
    if (startedAt !== undefined) {
      runObj.started_at = startedAt
      runObj.elapsed_ms = Math.max(0, now - startedAt)
    }
    if (taskState?.totalTokens !== undefined) runObj.total_tokens = taskState.totalTokens
    if (taskState?.lastVerdict !== undefined) runObj.verdict = taskState.lastVerdict
    if (taskState?.lastStopReason !== undefined) runObj.stop_reason = taskState.lastStopReason
    runObj._convId = convId

    runningRuns.push(runObj)
  }

  // 2. 空闲任务（按最近活动时间倒序）
  const idleRuns = []
  const idleTasks = ledgerTasks
    .filter(t => !activeMap.has(t.taskId))
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

  for (const t of idleTasks) {
    const runObj = {
      task_id: t.taskId,
      status: 'idle',
      round: t.round ?? 1,
    }
    // 已结束的任务：`lastAt` 是「最后一次活动时刻」，**不是**开始时刻——叫 started_at
    // 会诱导客户端把它当起点去算 `now - started_at`，那得到的是「距最后活动过了多久」，
    // 每秒都在涨，还会被误读成耗时。所以这里如实命名为 finished_at。
    if (t.lastAt !== undefined) runObj.finished_at = t.lastAt
    // 耗时必须是**那一次运行的真实总耗时**（台账 durationMs），固定不变。
    if (typeof t.lastDurationMs === 'number') runObj.elapsed_ms = t.lastDurationMs
    if (t.totalTokens !== undefined) runObj.total_tokens = t.totalTokens
    if (t.lastVerdict !== undefined) runObj.verdict = t.lastVerdict
    if (t.lastStopReason !== undefined) runObj.stop_reason = t.lastStopReason
    runObj._convId = t.conversationId

    idleRuns.push(runObj)
  }

  // 默认最多 MAX_LIVE_RUNS 个运行；面板「显示全部」可请求更多，但不超过硬上限。
  const requested = Number.isFinite(config.maxRuns) ? Math.trunc(config.maxRuns) : MAX_LIVE_RUNS
  const maxRuns = Math.max(1, Math.min(requested, MAX_LIVE_RUNS_HARD))
  const selected = [...runningRuns, ...idleRuns].slice(0, maxRuns)

  // 读 transcript
  const runs = await Promise.all(selected.map(async item => {
    const convId = item._convId
    const wasRunning = item.status === 'running'
    delete item._convId

    let transcript
    if (!convId || typeof convId !== 'string' || !storeRoot) {
      transcript = {
        available: false,
        reason: !convId ? '未获取到 conversationId' : 'storeRoot 不可用',
        events: [],
        step_index: null,
        step_total: 0,
      }
    } else {
      const logDir = join(storeRoot, 'brain', convId, '.system_generated', 'logs')
      const fullPath = join(logDir, 'transcript_full.jsonl')
      const compactPath = join(logDir, 'transcript.jsonl')
      let targetPath = compactPath
      try {
        const s = await stat(fullPath)
        if (s.isFile()) targetPath = fullPath
      } catch {
        targetPath = compactPath
      }
      // 正在跑的任务每次读新的；已结束的走缓存（内容不会再变）。
      transcript = wasRunning
        ? await readTranscriptTail(targetPath, MAX_TRANSCRIPT_EVENTS, MAX_EVENT_TEXT_CHARS)
        : await readTranscriptTailCached(targetPath)
    }

    return {
      ...item,
      step_index: transcript.step_index,
      step_total: transcript.step_total,
      transcript,
    }
  }))

  return {
    generated_at: now,
    runs,
    ledger_total,
  }
}

/**
 * 响应体大小严格约束在 32KB 内。
 *
 * @param {object} payload
 * @returns {string}
 */
export function enforcePayloadBounds(payload) {
  let json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) {
    return json
  }

  // 阶梯压缩文本
  for (const limit of [200, 100, 50]) {
    for (const run of payload.runs) {
      if (Array.isArray(run.transcript?.events)) {
        for (const evt of run.transcript.events) {
          if (evt.text && evt.text.length > limit) {
            evt.text = evt.text.slice(0, limit)
          }
        }
      }
    }
    json = JSON.stringify(payload)
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json
  }

  // 削减事件条数
  for (const maxEvts of [6, 3, 1, 0]) {
    for (const run of payload.runs) {
      if (Array.isArray(run.transcript?.events) && run.transcript.events.length > maxEvts) {
        run.transcript.events = run.transcript.events.slice(-maxEvts)
      }
    }
    json = JSON.stringify(payload)
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json
  }

  // 削减运行条数
  while (payload.runs.length > 1) {
    payload.runs.pop()
    json = JSON.stringify(payload)
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json
  }

  return json
}

/**
 * 注册实时状态只读 HTTP 路由。
 *
 * @param {object} ctx - 需要 webServer，可选 connection
 * @param {object} config - ledger / activeRuns / stallStoreRoot
 * @returns {() => void} disposer
 */
/**
 * 从 `?limit=` 解析面板「显示全部」请求的运行条数。
 *
 * 缺省/非法一律退回 MAX_LIVE_RUNS，且始终夹在 [1, MAX_LIVE_RUNS_HARD]——
 * 查询参数是**外部输入**，不能让一次请求把响应体和读盘量拉爆。
 *
 * 路由是 `kind: 'exact'`，宿主按 pathname 匹配（`webserver/src/index.ts` 的
 * `new URL(req.url).pathname`），所以带查询串不影响命中。
 *
 * @param {{url?: string}} req
 * @returns {number}
 */
function parseMaxRuns(req) {
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

export function registerLiveRoute(ctx, config) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (webServer === undefined || typeof webServer?.register !== 'function') {
    console.warn('wolfpack: webServer 服务不可用，跳过 /wolfpack/live 实时路由挂载')
    return () => {}
  }

  const unregister = webServer.register({
    kind: 'exact',
    path: LIVE_ROUTE_PATH,
    handler: async (req, res) => {
      // 1. 鉴权：拿不到 connection 服务时 fail closed（返回 503）
      const connection = ctx.get?.('connection') ?? ctx.connection
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
        res.setHeader('cache-control', 'no-store')
        res.end()
        return
      }

      // 2. HTTP 方法限制：只支持 GET
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end()
        return
      }

      // 3. 构造只读实时状态响应
      try {
        const payload = await buildLivePayload({ ...config, maxRuns: parseMaxRuns(req) })
        const json = enforcePayloadBounds(payload)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(json)
      } catch (error) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    },
  })

  return () => {
    try {
      if (typeof unregister === 'function') {
        unregister()
      } else if (typeof unregister?.dispose === 'function') {
        unregister.dispose()
      }
    } catch {
      // 忽略卸载异常
    }
  }
}
