import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 默认台账目录名 */
export const LEDGER_DIRNAME = '.wolfpack'
/** 默认台账文件名 */
export const LEDGER_FILENAME = 'runs.ndjson'

/** 默认条目数裁剪阈值 */
export const DEFAULT_LEDGER_MAX_ENTRIES = 5000
/** 默认文件大小裁剪阈值（10MB） */
export const DEFAULT_LEDGER_MAX_BYTES = 10 * 1024 * 1024
/** 默认每个任务保留轮数 */
export const DEFAULT_LEDGER_KEEP_ROUNDS = 10

/**
 * 获取默认台账绝对路径。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function defaultLedgerPath(env = process.env) {
  const explicit = env.WOLFPACK_LEDGER
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return join(homedir(), LEDGER_DIRNAME, LEDGER_FILENAME)
}

/**
 * 任务并发冲突异常。
 * 铁律：同一个 task_id 正在运行时，第二次委派必须直接被拒绝，绝不排队或串场。
 */
export class TaskBusyError extends Error {
  /**
   * @param {string} taskId
   * @param {string} activeRunId
   * @param {number} [startedAt]
   * @param {number} [now]
   */
  constructor(taskId, activeRunId, startedAt, now = Date.now()) {
    const elapsed = typeof startedAt === 'number' ? `，已跑 ${Math.max(0, now - startedAt)}ms` : ''
    super(
      `wolfpack: task_id "${taskId}" 上已经有正在运行的 agy 会话`
      + `（runId ${activeRunId}${elapsed}）。同一个 task_id 不允许并发：`
      + '如果这是另一件事，请换一个新的 task_id；'
      + '如果确实要继续这件事，请等它跑完，再用同一个 task_id 追问。',
    )
    this.name = 'TaskBusyError'
    this.code = 'TASK_BUSY'
    this.taskId = taskId
    this.activeRunId = activeRunId
  }
}

/**
 * 进程内活运行登记表。
 */
export class ActiveRunRegistry {
  constructor() {
    /** @type {Map<string, { runId: string, startedAt: number }>} */
    this.active = new Map()
  }

  /**
   * 独占锁定 task_id，同步检查并占位。
   *
   * @param {string} taskId
   * @param {string} runId
   * @param {number} [at]
   * @returns {string}
   */
  claim(taskId, runId, at = Date.now()) {
    const existing = this.active.get(taskId)
    if (existing !== undefined) {
      throw new TaskBusyError(taskId, existing.runId, existing.startedAt, at)
    }
    this.active.set(taskId, { runId, startedAt: at })
    return runId
  }

  /**
   * 释放 task_id 锁。
   *
   * @param {string} taskId
   * @param {string} [runId]
   */
  release(taskId, runId) {
    const existing = this.active.get(taskId)
    if (existing === undefined) return
    if (runId === undefined || existing.runId === runId) {
      this.active.delete(taskId)
    }
  }

  /**
   * 查询是否正在运行。
   * @param {string} taskId
   * @returns {boolean}
   */
  isActive(taskId) {
    return this.active.has(taskId)
  }

  /**
   * 列出所有正在运行的任务。
   * @returns {Array<{ taskId: string, runId: string, startedAt: number }>}
   */
  list() {
    return [...this.active].map(([taskId, val]) => ({
      taskId,
      runId: val.runId,
      startedAt: val.startedAt,
    }))
  }

  get size() {
    return this.active.size
  }
}

/** 全局进程级运行登记表 */
export const defaultActiveRuns = new ActiveRunRegistry()

/**
 * 将多条台账记录折叠为每个任务的最新状态。
 *
 * @param {Array<Record<string, any>>} entries
 * @param {Map<string, any>} [seed]
 * @returns {Map<string, any>}
 */
export function foldEntries(entries, seed) {
  const tasks = new Map()
  if (seed !== undefined) {
    for (const [taskId, state] of seed) {
      tasks.set(taskId, { ...state, changedFiles: [...state.changedFiles] })
    }
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const taskId = entry.taskId
    if (typeof taskId !== 'string' || taskId === '') continue

    const previous = tasks.get(taskId)
    const changed = Array.isArray(entry.changedFiles) ? entry.changedFiles : []
    const merged = new Set(previous?.changedFiles ?? [])
    for (const f of changed) {
      if (typeof f === 'string' && f !== '') merged.add(f)
    }

    const convId = typeof entry.conversationId === 'string' && entry.conversationId !== ''
      ? entry.conversationId
      : previous?.conversationId

    const entryDetermined = typeof entry.changedFilesDetermined === 'boolean'
      ? entry.changedFilesDetermined
      : (typeof entry.artifactsDetermined === 'boolean' ? entry.artifactsDetermined : undefined)

    const entryTokens = typeof entry.tokens === 'number' && Number.isFinite(entry.tokens) ? entry.tokens : undefined
    const entryCacheRead = typeof entry.cacheReadTokens === 'number' && Number.isFinite(entry.cacheReadTokens) ? entry.cacheReadTokens : 0

    let usageMissingRounds = 0
    if (typeof entry.usageMissingRounds === 'number' && Number.isFinite(entry.usageMissingRounds)) {
      usageMissingRounds = entry.usageMissingRounds
    } else if (entryTokens !== undefined) {
      usageMissingRounds = 0
    } else {
      usageMissingRounds = (previous?.usageMissingRounds ?? 0) + 1
    }

    tasks.set(taskId, {
      taskId,
      conversationId: convId,
      round: typeof entry.round === 'number' && Number.isFinite(entry.round) ? entry.round : previous?.round ?? 0,
      cwd: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : previous?.cwd,
      changedFiles: [...merged],
      changedFilesDetermined: entryDetermined !== undefined ? entryDetermined : (previous?.changedFilesDetermined ?? false),
      lastStopReason: typeof entry.stopReason === 'string' ? entry.stopReason : previous?.lastStopReason,
      lastNote: typeof entry.note === 'string' ? entry.note : previous?.lastNote,
      lastVerdict: typeof entry.verdict === 'string' ? entry.verdict : previous?.lastVerdict,
      totalTokens: (previous?.totalTokens ?? 0) + (entryTokens ?? 0),
      totalCacheReadTokens: (previous?.totalCacheReadTokens ?? 0) + entryCacheRead,
      lastTurns: typeof entry.turns === 'number' ? entry.turns : previous?.lastTurns,
      lastDurationMs: typeof entry.durationMs === 'number' ? entry.durationMs : previous?.lastDurationMs,
      lastAt: typeof entry.at === 'number' ? entry.at : previous?.lastAt ?? 0,
      usageMissingRounds,
    })
  }

  return tasks
}

function splitCompleteLines(text) {
  const cut = text.lastIndexOf('\n')
  if (cut === -1) return { complete: '', consumed: 0 }
  return {
    complete: text.slice(0, cut),
    consumed: Buffer.byteLength(text.slice(0, cut + 1), 'utf8'),
  }
}

function parseLines(text) {
  const entries = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const clean = trimmed.charCodeAt(0) === 0xFEFF ? trimmed.slice(1) : trimmed
    try {
      entries.push(JSON.parse(clean))
    } catch {}
  }
  return entries
}

function cloneTasks(tasks) {
  const out = new Map()
  for (const [taskId, state] of tasks) {
    out.set(taskId, { ...state, changedFiles: [...state.changedFiles] })
  }
  return out
}

const ANCHOR_BYTES = 32

/**
 * 台账管理类（支持追加、增量读、折叠与原子压缩）。
 */
export class RunsLedger {
  /**
   * @param {string} filePath
   * @param {object} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.maxEntries = options.maxEntries ?? DEFAULT_LEDGER_MAX_ENTRIES
    this.maxBytes = options.maxBytes ?? DEFAULT_LEDGER_MAX_BYTES
    this.keepRounds = options.keepRounds ?? DEFAULT_LEDGER_KEEP_ROUNDS

    this.writeChain = Promise.resolve()
    this.cache = undefined
    this.cachedSize = 0
    this.cachedMtimeMs = 0
    this.cachedIno = undefined
    this.cachedBirthtimeMs = undefined
    this.cachedAnchor = undefined
    this.cachedHeadAnchor = undefined
    this.stats = { reads: 0, cacheHits: 0, fullParses: 0, incrementalParses: 0, bytesParsed: 0 }
  }

  #reset(tasks, size, mtimeMs, identity = {}) {
    this.cache = tasks
    this.cachedSize = size
    this.cachedMtimeMs = mtimeMs
    this.cachedIno = identity.ino
    this.cachedBirthtimeMs = identity.birthtimeMs
    this.cachedAnchor = identity.anchor
    this.cachedHeadAnchor = identity.headAnchor
  }

  async #captureAnchors(size) {
    const head = await this.#readRange(0, Math.min(ANCHOR_BYTES, Math.max(0, size)))
    const tail = await this.#readRange(Math.max(0, size - ANCHOR_BYTES), size)
    return { head: head ?? '', tail: tail ?? '' }
  }

  async #anchorsMatch(size) {
    if (this.cachedAnchor === undefined && this.cachedHeadAnchor === undefined) return true
    const { head, tail } = await this.#captureAnchors(size)
    return head === (this.cachedHeadAnchor ?? '') && tail === (this.cachedAnchor ?? '')
  }

  async #readRange(from, to) {
    const length = to - from
    if (length <= 0) return ''
    let handle
    try {
      handle = await open(this.filePath, 'r')
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, from)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } catch {
      return undefined
    } finally {
      if (handle !== undefined) await handle.close().catch(() => {})
    }
  }

  /**
   * 追加一条记录。
   *
   * @param {Record<string, any>} entry
   * @returns {Promise<void>}
   */
  async record(entry) {
    const line = JSON.stringify({ at: Date.now(), ...entry })
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${line}\n`, 'utf8')
      await this.#maybeCompact()
    }).catch(error => {
      console.warn('[wolfpack/ledger] 写入失败', this.filePath, error)
    })
    await this.writeChain
  }

  async #maybeCompact() {
    try {
      let fileStat
      try {
        fileStat = await stat(this.filePath)
      } catch {
        return
      }

      const exceedsBytes = typeof this.maxBytes === 'number' && this.maxBytes > 0 && fileStat.size > this.maxBytes
      let entries = undefined

      if (exceedsBytes) {
        const text = await readFile(this.filePath, 'utf8')
        entries = parseLines(splitCompleteLines(text).complete)
      } else if (typeof this.maxEntries === 'number' && this.maxEntries > 0) {
        const text = await readFile(this.filePath, 'utf8')
        entries = parseLines(splitCompleteLines(text).complete)
        if (entries.length <= this.maxEntries) return
      } else {
        return
      }

      await this.#executeCompact({ entries })
    } catch (err) {
      console.warn('[wolfpack/ledger] 自动压缩失败:', err?.message || err)
    }
  }

  async #executeCompact({ entries }) {
    if (!entries || entries.length === 0) return { compacted: false, prunedEntries: 0 }

    const keepRounds = this.keepRounds || DEFAULT_LEDGER_KEEP_ROUNDS
    const byTask = new Map()

    for (const entry of entries) {
      if (!entry || typeof entry.taskId !== 'string') continue
      let list = byTask.get(entry.taskId)
      if (!list) {
        list = []
        byTask.set(entry.taskId, list)
      }
      list.push(entry)
    }

    let totalPruned = 0
    const finalEntries = []

    for (const [taskId, taskEntries] of byTask) {
      if (taskEntries.length <= keepRounds) {
        finalEntries.push(...taskEntries)
        continue
      }

      const toPrune = taskEntries.slice(0, taskEntries.length - keepRounds)
      const toKeep = taskEntries.slice(taskEntries.length - keepRounds)
      const state = foldEntries(toPrune).get(taskId)

      if (!state) {
        finalEntries.push(...taskEntries)
        continue
      }

      totalPruned += toPrune.length - 1
      const summaryEntry = {
        kind: 'summary',
        at: state.lastAt,
        taskId: state.taskId,
        round: state.round,
        changedFiles: state.changedFiles,
        changedFilesDetermined: state.changedFilesDetermined,
        conversationId: state.conversationId,
        cwd: state.cwd,
        stopReason: state.lastStopReason,
        note: state.lastNote,
        verdict: state.lastVerdict,
        tokens: state.totalTokens,
        cacheReadTokens: state.totalCacheReadTokens,
        turns: state.lastTurns,
        durationMs: state.lastDurationMs,
        usageMissingRounds: state.usageMissingRounds,
      }
      finalEntries.push(summaryEntry, ...toKeep)
    }

    if (totalPruned <= 0) return { compacted: false, prunedEntries: 0 }

    finalEntries.sort((a, b) => (a.at || 0) - (b.at || 0))
    const newContent = finalEntries.map(e => JSON.stringify(e)).join('\n') + '\n'

    const tempPath = join(dirname(this.filePath), `.compact-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    try {
      await writeFile(tempPath, newContent, 'utf8')
      await rename(tempPath, this.filePath)
      this.#reset(new Map(), 0, 0)
      this.cache = undefined
      return { compacted: true, prunedEntries: totalPruned }
    } catch (err) {
      try { await rm(tempPath, { force: true }) } catch {}
      throw err
    }
  }

  /**
   * 读取全部任务最新状态（增量解析与缓存）。
   *
   * @returns {Promise<Map<string, any>>}
   */
  async read() {
    await this.writeChain
    this.stats.reads += 1

    let info
    try {
      info = await stat(this.filePath)
    } catch {
      this.#reset(new Map(), 0, 0)
      return new Map()
    }

    const identityChanged = (this.cachedIno !== undefined && this.cachedIno !== 0 && info.ino !== undefined && info.ino !== 0 && info.ino !== this.cachedIno)
      || (this.cachedBirthtimeMs !== undefined && this.cachedBirthtimeMs !== 0 && info.birthtimeMs !== undefined && info.birthtimeMs !== 0 && info.birthtimeMs !== this.cachedBirthtimeMs)

    const hasCache = this.cache !== undefined
    const anchorsOk = hasCache && !identityChanged ? await this.#anchorsMatch(this.cachedSize) : false

    if (hasCache && !identityChanged && anchorsOk && info.size === this.cachedSize && info.mtimeMs === this.cachedMtimeMs) {
      this.stats.cacheHits += 1
      return cloneTasks(this.cache)
    }

    if (hasCache && !identityChanged && anchorsOk && info.size > this.cachedSize) {
      const appended = await this.#readRange(this.cachedSize, info.size)
      if (appended !== undefined) {
        const { complete, consumed } = splitCompleteLines(appended)
        if (consumed > 0) {
          this.cache = foldEntries(parseLines(complete), this.cache)
          this.cachedSize += consumed
          this.cachedMtimeMs = info.mtimeMs
          const adv = await this.#captureAnchors(this.cachedSize)
          this.cachedAnchor = adv.tail
          this.cachedHeadAnchor = adv.head
          this.stats.incrementalParses += 1
          this.stats.bytesParsed += consumed
          return cloneTasks(this.cache)
        }
        return cloneTasks(this.cache)
      }
    }

    let text
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch {
      this.#reset(new Map(), 0, 0)
      return new Map()
    }

    const { complete, consumed } = splitCompleteLines(text)
    const tasks = foldEntries(parseLines(complete))
    const fresh = await this.#captureAnchors(consumed)
    this.#reset(tasks, consumed, info.mtimeMs, {
      ino: info.ino,
      birthtimeMs: info.birthtimeMs,
      anchor: fresh.tail,
      headAnchor: fresh.head,
    })
    this.stats.fullParses += 1
    this.stats.bytesParsed += consumed
    return cloneTasks(tasks)
  }

  /**
   * 获取指定任务最新状态。
   *
   * @param {string} taskId
   * @returns {Promise<any|undefined>}
   */
  async latest(taskId) {
    return (await this.read()).get(taskId)
  }

  /**
   * 获取指定任务下一轮要传回的 conversationId。
   *
   * @param {string} taskId
   * @returns {Promise<string|undefined>}
   */
  async conversationFor(taskId) {
    return (await this.latest(taskId))?.conversationId
  }
}
