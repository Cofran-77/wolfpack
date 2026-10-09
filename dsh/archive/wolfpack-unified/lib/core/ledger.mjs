/**
 * 狼群模式 — 派活台账。
 *
 * 存在的理由只有一个：**agy 的会话上下文不能跨进程自动保留**。
 * `agy -p` 每次都是新进程；要让第二轮记得第一轮，唯一办法是记住
 * `conversation_id` 并在下一次显式传回（`--conversation <id>`）。
 * 这个 id 一旦丢掉，agy 那一侧的「本次任务上下文」就等于没存在过，
 * 而且固定开销（空载 27k tokens / 14s）白付一遍。
 *
 * 所以台账不是可观测性的锦上添花，它是这个模式的**必需件**。
 *
 * 形态：append-only NDJSON，读时折叠。
 *   - 追加天然崩溃安全，进程被 kill 也不会写坏已有行；
 *   - 顺带就是审计流水（谁派的、第几轮、改了哪些文件、验收结论）；
 *   - 折叠的最新态就是「这个任务现在到哪了」。
 */

import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 台账目录名（挂在 DSH_HOME 下）。 */
export const LEDGER_DIRNAME = 'wolfpack'

/** 台账文件名。 */
export const LEDGER_FILENAME = 'runs.ndjson'

/** 默认台账条目数上限（超出触发裁剪）。 */
export const DEFAULT_LEDGER_MAX_ENTRIES = 5000

/** 默认台账文件大小上限（10MB，超出触发压缩）。 */
export const DEFAULT_LEDGER_MAX_BYTES = 10 * 1024 * 1024

/** 默认每个任务保留的明细轮数（超出部分压缩为 1 条折叠摘要）。 */
export const DEFAULT_LEDGER_KEEP_ROUNDS = 10

/**
 * 解析台账条目数上限环境变量。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|undefined} 正整数上限；undefined = 不按条目数裁剪
 */
export function ledgerMaxEntries(env = process.env) {
  const raw = env.WOLFPACK_LEDGER_MAX_ENTRIES
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_LEDGER_MAX_ENTRIES
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return undefined
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LEDGER_MAX_ENTRIES
}

/**
 * 解析台账文件字节数上限环境变量。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|undefined} 正整数上限；undefined = 不按文件大小压缩
 */
export function ledgerMaxBytes(env = process.env) {
  const raw = env.WOLFPACK_LEDGER_MAX_BYTES
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_LEDGER_MAX_BYTES
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return undefined
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LEDGER_MAX_BYTES
}

/**
 * 解析每个任务保留轮数环境变量。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|undefined} 正整数保留轮数；undefined = 不折叠明细
 */
export function ledgerKeepRounds(env = process.env) {
  const raw = env.WOLFPACK_LEDGER_KEEP_ROUNDS
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_LEDGER_KEEP_ROUNDS
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return undefined
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LEDGER_KEEP_ROUNDS
}

/**
 * 一条台账记录。除 `at`/`taskId` 外全部可选——派活失败也要留痕，
 * 不能因为拿不到 conversation_id 就整条不写。
 *
 * @typedef {object} RunEntry
 * @property {number} at - 记录时刻（epoch ms）
 * @property {string} taskId - 任务键；同一任务的多轮共用
 * @property {number} [round] - 第几轮（从 1 记）
 * @property {string} [conversationId] - agy 返回的会话 id，下一轮要用
 * @property {string} [cwd] - agy 的工作目录
 * @property {string} [stopReason] - completed / error / aborted / …
 * @property {string[]} [changedFiles] - 本轮改动的文件（路径，不含内容）
 * @property {string} [verdict] - 验收结论（如果本轮跑过 verify）
 * @property {number} [durationMs]
 * @property {number} [tokens] - 本轮消耗的 agy token（配额，不是 ¥）
 * @property {number} [cacheReadTokens] - 其中命中前缀缓存的量
 * @property {number} [turns] - agy 自报的轮数
 * @property {string} [note] - 自由文本，失败原因等
 */

/**
 * 折叠出的任务最新态。
 *
 * @typedef {object} TaskState
 * @property {string} taskId
 * @property {string|undefined} conversationId - 下一轮要传回去的 id
 * @property {number} round - 已完成到第几轮
 * @property {string|undefined} cwd
 * @property {string[]} changedFiles - 累计改动文件（去重）
 * @property {string|undefined} lastStopReason
 * @property {string|undefined} lastVerdict
 * @property {number} totalTokens - 该任务累计 agy token（配额，不是 ¥）
 * @property {number} totalCacheReadTokens - 累计命中前缀缓存的量
 * @property {number} usageMissingRounds - 连续「用量不可得」的轮数（tokens 缺失 +1，拿到真用量归零）
 * @property {number|undefined} lastTurns
 * @property {number|undefined} lastDurationMs
 * @property {number} lastAt
 */

/**
 * 把一串记录折叠成每个任务的最新态。
 * 纯函数，便于单测，也是 `read()` 的实现内核。
 *
 * `seed` 让增量读成立：只把**新增**的记录折进已有的折叠结果，不必重放整本账。
 * 传入的 seed 不会被修改（先克隆）。
 *
 * @param {RunEntry[]} entries - 按时间升序的记录
 * @param {Map<string, TaskState>} [seed] - 已有折叠结果（增量读用）
 * @returns {Map<string, TaskState>}
 */
export function foldEntries(entries, seed) {
  /** @type {Map<string, TaskState>} */
  const tasks = new Map()
  if (seed !== undefined) {
    for (const [taskId, state] of seed) {
      tasks.set(taskId, { ...state, changedFiles: [...state.changedFiles] })
    }
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const taskId = entry.taskId
    if (typeof taskId !== 'string' || taskId === '') continue

    const previous = tasks.get(taskId)
    const changed = Array.isArray(entry.changedFiles) ? entry.changedFiles : []
    const merged = new Set(previous?.changedFiles ?? [])
    for (const file of changed) {
      if (typeof file === 'string' && file !== '') merged.add(file)
    }

    tasks.set(taskId, {
      taskId,
      // 关键语义：conversationId 只被「本任务最近一次真正拿到 id 的记录」覆盖，
      // 后续一条没带 id 的失败记录不会把它抹掉——否则一次失败就丢了续跑能力。
      conversationId: typeof entry.conversationId === 'string' && entry.conversationId !== ''
        ? entry.conversationId
        : previous?.conversationId,
      round: typeof entry.round === 'number' && Number.isFinite(entry.round)
        ? entry.round
        : previous?.round ?? 0,
      cwd: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : previous?.cwd,
      changedFiles: [...merged],
      lastStopReason: typeof entry.stopReason === 'string' ? entry.stopReason : previous?.lastStopReason,
      lastNote: typeof entry.note === 'string' ? entry.note : previous?.lastNote,
      lastVerdict: typeof entry.verdict === 'string' ? entry.verdict : previous?.lastVerdict,
      // 用量：累计值最容易回答「这件事一共烧了多少配额」。
      // 单位是 token（agy 侧配额），不是 ¥——¥ 花在队长步数上。
      totalTokens: (previous?.totalTokens ?? 0) + (typeof entry.tokens === 'number' && Number.isFinite(entry.tokens) ? entry.tokens : 0),
      totalCacheReadTokens: (previous?.totalCacheReadTokens ?? 0)
        + (typeof entry.cacheReadTokens === 'number' && Number.isFinite(entry.cacheReadTokens) ? entry.cacheReadTokens : 0),
      lastTurns: typeof entry.turns === 'number' ? entry.turns : previous?.lastTurns,
      lastDurationMs: typeof entry.durationMs === 'number' ? entry.durationMs : previous?.lastDurationMs,
      lastAt: typeof entry.at === 'number' ? entry.at : previous?.lastAt ?? 0,
      // 「用量不可得」的连续轮数：
      // 若 entry 显式携带了 usageMissingRounds（折叠摘要），直接延续它；
      // 否则 tokens 是有限数就归零，缺失就 +1。
      usageMissingRounds: typeof entry.usageMissingRounds === 'number' && Number.isFinite(entry.usageMissingRounds)
        ? entry.usageMissingRounds
        : ((typeof entry.tokens === 'number' && Number.isFinite(entry.tokens))
            ? 0
            : (previous?.usageMissingRounds ?? 0) + 1),
    })
  }
  return tasks
}

/* ── 同 task_id 并发闸门 ───────────────────────────────────────────── */

/**
 * 同一个 task_id 上已经有正在跑的 agy 时，第二次调用收到的错误。
 *
 * 为什么必须是「拒绝」而不是「排队」或「串场」：台账的读-改-写是
 * 「读 round=N → 跑 → 写 round=N+1」。两次并发会双双读到 N、各写一条 N+1，
 * 折叠的「最新覆盖」语义于是让 conversationId 与 changedFiles 互相覆盖——
 * 续跑从此接到别人的现场，而且没有任何报错。
 *
 * 文案要求：队长读完这条错误必须知道下一步是「换 id」还是「等」。
 */
export class TaskBusyError extends Error {
  /**
   * @param {string} taskId
   * @param {string} activeRunId - 正在跑的那次的 runId
   * @param {number|undefined} startedAt - 那次开始时刻（epoch ms）
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
 * 进程内「哪个 task_id 正在跑」的登记表。
 *
 * `claim()` 是**同步**的：并发交错必须靠同步占位堵死，不能靠时间窗
 * （「两次调用间隔太短」那种判断在异步代码里等于没判）。
 *
 * 进程内登记表只能防同进程并发（宿主一个进程里，队长的并发委派正是这种）。
 * 跨进程并发（两个宿主进程写同一本账）不在本轮范围内，如实标注。
 */
export class ActiveRunRegistry {
  constructor() {
    /** @type {Map<string, {runId: string, startedAt: number}>} */
    this.active = new Map()
  }

  /**
   * 占住一个 task_id。同步；已有运行中则抛 {@link TaskBusyError}。
   * @param {string} taskId
   * @param {string} runId
   * @param {number} [at]
   * @returns {string} runId（成功时原样返回，便于链式书写）
   */
  claim(taskId, runId, at = Date.now()) {
    const existing = this.active.get(taskId)
    if (existing !== undefined) throw new TaskBusyError(taskId, existing.runId, existing.startedAt, at)
    this.active.set(taskId, { runId, startedAt: at })
    return runId
  }

  /**
   * 释放。带上 runId 时只释放自己那一次，避免误删后来者的占位。
   * @param {string} taskId
   * @param {string} [runId]
   */
  release(taskId, runId) {
    const existing = this.active.get(taskId)
    if (existing === undefined) return
    if (runId === undefined || existing.runId === runId) this.active.delete(taskId)
  }

  /** @param {string} taskId @returns {boolean} */
  isActive(taskId) {
    return this.active.has(taskId)
  }

  /** @returns {Array<{taskId: string, runId: string, startedAt: number}>} */
  list() {
    return [...this.active].map(([taskId, value]) => ({ taskId, runId: value.runId, startedAt: value.startedAt }))
  }

  /** @returns {number} */
  get size() {
    return this.active.size
  }
}

/**
 * 进程级默认登记表：`startAgy` 不显式传 registry 时用它，
 * 于是工具入口与 provider 入口共享同一道闸门。
 */
export const defaultActiveRuns = new ActiveRunRegistry()

/* ── 台账读写 ──────────────────────────────────────────────────────── */

/**
 * 按 `\n` 切出**完整行**：只有以换行结尾的内容才会被消费。
 *
 * 这条规则是并发可见性的地基：另一个进程正在 append 时，文件尾部会有一段
 * 半个 JSON 行。它必须留在游标之后、下次再读，绝不能被 parse 成「坏行」
 * 静默丢掉——丢了就等于永久少一条记录。
 *
 * 顺带解决多字节问题：切点一定是 `\n`（ASCII，不可能出现在多字节字符
 * 内部），所以按字节区间续读永远落在字符边界上。
 *
 * @param {string} text
 * @returns {{complete: string, consumed: number}} 完整行文本（不含末换行）、消费掉的字节数
 */
function splitCompleteLines(text) {
  const cut = text.lastIndexOf('\n')
  if (cut === -1) return { complete: '', consumed: 0 }
  return { complete: text.slice(0, cut), consumed: Buffer.byteLength(text.slice(0, cut + 1), 'utf8') }
}

/**
 * 解析 NDJSON 文本；坏行跳过，不让一条坏记录毁掉整本账。
 * @param {string} text
 * @returns {RunEntry[]}
 */
function parseLines(text) {
  /** @type {RunEntry[]} */
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 半行/损坏行跳过。
    }
  }
  return entries
}

/**
 * 克隆折叠结果。调用方拿到的是自己的副本，改它不会污染缓存，
 * 也不会让下一次折叠把同一条记录算两遍（累计 token 会被重复累加）。
 * @param {Map<string, TaskState>} tasks
 * @returns {Map<string, TaskState>}
 */
function cloneTasks(tasks) {
  const out = new Map()
  for (const [taskId, state] of tasks) {
    out.set(taskId, { ...state, changedFiles: [...state.changedFiles] })
  }
  return out
}

/** 游标前保留多少字节做「文件身份锚」（F1）。32 字节足够便宜，也足够区分内容。 */
const ANCHOR_BYTES = 32

/**
 * 台账读写。
 *
 * 写：同进程内串行化，避免并发派活交错写坏行。
 * 读：**增量**。游标（字节）+ 折叠缓存，只解析新增的完整行。
 *
 * 缓存失效规则（三条 + 文件身份校验）：
 *   R1. 游标之后文件变短（`size < cachedSize`）→ 视为截断/轮转，丢弃缓存全量重读。
 *   R2. `size` 与 `mtimeMs` 都没变 **且身份校验通过** → 命中缓存：不解析任何字节，
 *       但会回读 {@link ANCHOR_BYTES} 字节的身份锚（T11：这一步不能在命中路径上省）。
 *   R3. `size` 变大 **且身份校验通过** → 续读 `[cachedSize, size)`；其中不以换行结尾的
 *       尾段留在游标之后（见 {@link splitCompleteLines}），下次再读。
 *   文件身份校验（T13）：`ino` / `birthtimeMs` / 文件头 {@link ANCHOR_BYTES} 字节 anchor /
 *   游标前 {@link ANCHOR_BYTES} 字节 anchor，任一变化即视为「同一路径被换成另一份内容」
 *   （另存、重写、轮转），一律降级为全量重读。命中路径（R2）与追加路径（R3）**都要过**。
 *
 *   ⚠️ 覆盖范围如实说明：R1–R3 只覆盖「追加」「截断/缩小（轮转）」「无变化」三种
 *   **可判定**情形；「文件被换成另一份内容（更大、等大、甚至更小）」不在这三条里，
 *   它靠身份校验兜住。其中两个 anchor 是平台无关的那一道——`ino`/`birthtimeMs` 在部分
 *   文件系统上不可用、或会被复用，单靠它们挡不住「同大小 + 同 mtime 的原地改写」。
 *   **但 anchor 是启发式，不是绝对保证**：它只看「头 32B」与「游标前 32B」，
 *   「同路径 + 同大小 + 同 mtime + 头尾 32B 都相同、只有中段不同」的原地改写
 *   仍会被判成「没变」。要做到绝对，只能每次全量重读、或对整本做内容哈希。
 *   所以这里既不声称「穷举」，也不声称「命中路径不可能返回另一份内容」。
 *
 * 并发可见性：
 *   · 本进程写：`read()` 先等 `writeChain` 排空，**读得到自己刚写的**；
 *   · 跨进程写：一条记录只有在写完那个换行之后才可能被看见（半行不可见）；
 *   · 跨进程**并发**写同一本账不做互斥（两个宿主进程场景，本轮不覆盖），
 *     但哪怕交错，每条已完成的记录都不会被解析丢。
 */
export class RunsLedger {
  /**
   * @param {string} filePath - NDJSON 文件路径（绝对路径）
   * @param {object} [options]
   * @param {number|string} [options.maxEntries] - 条目数上限（超出触发裁剪）
   * @param {number|string} [options.maxBytes] - 文件大小上限（超出触发裁剪）
   * @param {number|string} [options.keepRounds] - 每个任务保留明细轮数
   * @param {((tempPath: string, targetPath: string, content: string) => Promise<void>)} [options.writeAtomic] - 原子写实现（单测注入用）
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.maxEntries = options.maxEntries
    this.maxBytes = options.maxBytes
    this.keepRounds = options.keepRounds
    /** @type {(tempPath: string, targetPath: string, content: string) => Promise<void>} 原子写实现（可注入测试写故障） */
    this.writeAtomic = typeof options.writeAtomic === 'function'
      ? options.writeAtomic
      : async (tempPath, targetPath, content) => {
          await writeFile(tempPath, content, 'utf8')
          await rename(tempPath, targetPath)
        }
    /** @type {Promise<unknown>} 写串行链 */
    this.writeChain = Promise.resolve()
    /** @type {Map<string, TaskState>|undefined} 折叠缓存 */
    this.cache = undefined
    /** 游标：已经折进 cache 的字节数（总是落在行边界上） */
    this.cachedSize = 0
    /** 游标对应的文件 mtime（用于 R2 命中判断） */
    this.cachedMtimeMs = 0
    /** 游标对应的文件身份：inode（F1） */
    this.cachedIno = undefined
    /** 游标对应的文件身份：创建时间（F1，与 ino 互为补充） */
    this.cachedBirthtimeMs = undefined
    /** 游标前 ANCHOR_BYTES 字节的内容（文件身份锚·尾，启发式） */
    this.cachedAnchor = undefined
    /** 文件开头 ANCHOR_BYTES 字节的内容（文件身份锚·头，启发式；补 R3-F1 指出的缺口） */
    this.cachedHeadAnchor = undefined
    /**
     * 读自省计数。不是对外语义的一部分，但它让「不再每次全量 parse」
     * 这件事可以被机械验证——否则这条需求只能靠读代码相信。
     */
    this.stats = { reads: 0, cacheHits: 0, fullParses: 0, incrementalParses: 0, bytesParsed: 0 }
  }

  #getMaxEntries() {
    if (this.maxEntries !== undefined) {
      if (this.maxEntries === 0 || this.maxEntries === 'off' || this.maxEntries === 'none') return undefined
      const num = Number(this.maxEntries)
      return Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined
    }
    return ledgerMaxEntries()
  }

  #getMaxBytes() {
    if (this.maxBytes !== undefined) {
      if (this.maxBytes === 0 || this.maxBytes === 'off' || this.maxBytes === 'none') return undefined
      const num = Number(this.maxBytes)
      return Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined
    }
    return ledgerMaxBytes()
  }

  #getKeepRounds() {
    if (this.keepRounds !== undefined) {
      if (this.keepRounds === 0 || this.keepRounds === 'off' || this.keepRounds === 'none') return undefined
      const num = Number(this.keepRounds)
      return Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined
    }
    return ledgerKeepRounds()
  }

  /**
   * 丢弃缓存与游标（同时记下文件身份，供下一次读判断「还是不是同一个文件」）。
   * @param {Map<string, TaskState>} tasks
   * @param {number} size
   * @param {number} mtimeMs
   * @param {{ino?: number, birthtimeMs?: number, anchor?: string, headAnchor?: string}} [identity]
   */
  #reset(tasks, size, mtimeMs, identity = {}) {
    this.cache = tasks
    this.cachedSize = size
    this.cachedMtimeMs = mtimeMs
    this.cachedIno = identity.ino
    this.cachedBirthtimeMs = identity.birthtimeMs
    this.cachedAnchor = identity.anchor
    this.cachedHeadAnchor = identity.headAnchor
  }

  /**
   * 读「文件头 {@link ANCHOR_BYTES} 字节」与「游标前 {@link ANCHOR_BYTES} 字节」两个锚。
   * 读不到返回空串（仍可比对，只是更易失配）。
   * @param {number} size - 游标位置
   * @returns {Promise<{head: string, tail: string}>}
   */
  async #captureAnchors(size) {
    const head = await this.#readRange(0, Math.min(ANCHOR_BYTES, Math.max(0, size)))
    const tail = await this.#readRange(Math.max(0, size - ANCHOR_BYTES), size)
    return { head: head === undefined ? '' : head, tail: tail === undefined ? '' : tail }
  }

  /**
   * 校验两个锚是否原样还在。平台无关：不依赖 ino/birthtime 的可用性。
   *
   * ⚠️ 这是**启发式**，不是绝对保证：只比对「头 32B」与「游标前 32B」。
   *    「同路径 + 同大小 + 同 mtime + 头尾 32B 都相同」的原地改写（只有中段不同）
   *    仍会被判成「没变」而命中缓存——那是已知边界，如实写在这里。
   * @param {number} size - 游标位置
   * @returns {Promise<boolean>}
   */
  async #anchorsMatch(size) {
    if (this.cachedAnchor === undefined && this.cachedHeadAnchor === undefined) return true
    const { head, tail } = await this.#captureAnchors(size)
    return head === (this.cachedHeadAnchor ?? '') && tail === (this.cachedAnchor ?? '')
  }

  /**
   * 追加一条记录。
   * @param {RunEntry} entry - 不含 `at` 时自动补当前时间
   * @returns {Promise<void>}
   */
  async record(entry) {
    const line = JSON.stringify({ at: Date.now(), ...entry })
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${line}\n`, 'utf8')
      await this.#maybeCompact()
    }).catch(error => {
      // 台账写不进去不该让派活失败：记一条警告，任务继续。
      console.warn('wolfpack/ledger: 写入失败', this.filePath, error)
    })
    await this.writeChain
  }

  /**
   * 检查是否超出条目数或大小上限，必要时触发裁剪。
   */
  async #maybeCompact() {
    try {
      const maxBytes = this.#getMaxBytes()
      const maxEntries = this.#getMaxEntries()
      if (maxBytes === undefined && maxEntries === undefined) return

      let fileStat
      try {
        fileStat = await stat(this.filePath)
      } catch {
        return
      }

      const exceedsBytes = typeof maxBytes === 'number' && fileStat.size > maxBytes

      let text
      let entries
      if (exceedsBytes) {
        text = await readFile(this.filePath, 'utf8')
        entries = parseLines(splitCompleteLines(text).complete)
      } else if (typeof maxEntries === 'number') {
        text = await readFile(this.filePath, 'utf8')
        entries = parseLines(splitCompleteLines(text).complete)
        if (entries.length <= maxEntries) return
      } else {
        return
      }

      await this.#executeCompact({ entries })
    } catch (err) {
      console.warn('wolfpack/ledger: 自动裁剪失败', this.filePath, err)
    }
  }

  /**
   * 手动或按需执行台账裁剪/压缩。
   *
   * @param {object} [options]
   * @param {number} [options.keepRounds]
   * @param {boolean} [options.force]
   * @returns {Promise<{compacted: boolean, prunedEntries: number, entriesCount?: number}>}
   */
  async compact(options = {}) {
    return new Promise((resolve, reject) => {
      this.writeChain = this.writeChain.then(async () => {
        try {
          const result = await this.#executeCompact({ force: true, ...options })
          resolve(result)
        } catch (err) {
          reject(err)
        }
      }).catch(err => {
        reject(err)
      })
    })
  }

  /**
   * 执行台账压缩核心逻辑。
   *
   * @param {object} [options]
   * @param {RunEntry[]} [options.entries]
   * @param {number} [options.keepRounds]
   * @param {boolean} [options.force]
   * @returns {Promise<{compacted: boolean, prunedEntries: number, entriesCount?: number}>}
   */
  async #executeCompact(options = {}) {
    let entries = options.entries
    if (entries === undefined) {
      let text
      try {
        text = await readFile(this.filePath, 'utf8')
      } catch {
        return { compacted: false, prunedEntries: 0 }
      }
      entries = parseLines(splitCompleteLines(text).complete)
    }

    if (entries.length === 0) {
      return { compacted: false, prunedEntries: 0 }
    }

    const keepRounds = options.keepRounds ?? this.#getKeepRounds() ?? DEFAULT_LEDGER_KEEP_ROUNDS

    /** @type {Map<string, RunEntry[]>} */
    const byTask = new Map()
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const taskId = entry.taskId
      if (typeof taskId !== 'string' || taskId === '') continue
      let list = byTask.get(taskId)
      if (list === undefined) {
        list = []
        byTask.set(taskId, list)
      }
      list.push(entry)
    }

    let totalPruned = 0
    /** @type {RunEntry[]} */
    const finalEntries = []

    for (const [taskId, taskEntries] of byTask) {
      if (taskEntries.length <= keepRounds) {
        finalEntries.push(...taskEntries)
        continue
      }

      const toPrune = taskEntries.slice(0, taskEntries.length - keepRounds)
      const toKeep = taskEntries.slice(taskEntries.length - keepRounds)

      const foldedMap = foldEntries(toPrune)
      const state = foldedMap.get(taskId)

      if (state === undefined) {
        finalEntries.push(...taskEntries)
        continue
      }

      totalPruned += toPrune.length - 1

      /** @type {RunEntry} */
      const summaryEntry = {
        kind: 'summary',
        at: state.lastAt,
        taskId: state.taskId,
        round: state.round,
        changedFiles: state.changedFiles,
      }
      if (state.conversationId !== undefined) summaryEntry.conversationId = state.conversationId
      if (state.cwd !== undefined) summaryEntry.cwd = state.cwd
      if (state.lastStopReason !== undefined) summaryEntry.stopReason = state.lastStopReason
      if (state.lastNote !== undefined) summaryEntry.note = state.lastNote
      if (state.lastVerdict !== undefined) summaryEntry.verdict = state.lastVerdict
      if (state.totalTokens !== undefined) summaryEntry.tokens = state.totalTokens
      if (state.totalCacheReadTokens !== undefined) summaryEntry.cacheReadTokens = state.totalCacheReadTokens
      if (state.lastTurns !== undefined) summaryEntry.turns = state.lastTurns
      if (state.lastDurationMs !== undefined) summaryEntry.durationMs = state.lastDurationMs
      if (state.usageMissingRounds !== undefined) summaryEntry.usageMissingRounds = state.usageMissingRounds

      finalEntries.push(summaryEntry, ...toKeep)
    }

    if (totalPruned <= 0 && !options.force) {
      return { compacted: false, prunedEntries: 0 }
    }

    finalEntries.sort((a, b) => {
      const atA = typeof a.at === 'number' ? a.at : 0
      const atB = typeof b.at === 'number' ? b.at : 0
      if (atA !== atB) return atA - atB
      if (a.taskId === b.taskId) {
        if (a.kind === 'summary') return -1
        if (b.kind === 'summary') return 1
      }
      return 0
    })

    const newContent = finalEntries.length > 0
      ? finalEntries.map(e => JSON.stringify(e)).join('\n') + '\n'
      : ''

    const tempPath = join(
      dirname(this.filePath),
      `.compact-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    )

    try {
      await this.writeAtomic(tempPath, this.filePath, newContent)
      this.#reset(new Map(), 0, 0)
      this.cache = undefined
      return { compacted: true, prunedEntries: totalPruned, entriesCount: finalEntries.length }
    } catch (err) {
      try {
        await rm(tempPath, { force: true })
      } catch {}
      throw err
    }
  }

  /**
   * 读全部任务的最新态。
   * @returns {Promise<Map<string, TaskState>>}
   */
  async read() {
    // 读己所写：不等写链的话，会读到「刚 record 完但还没落盘」的旧态。
    await this.writeChain
    this.stats.reads += 1

    let info
    try {
      info = await stat(this.filePath)
    } catch {
      // 文件不存在 = 还没派过活，这是正常起点；顺手丢掉缓存，
      // 否则账被删掉之后还会一直返回陈旧态。
      this.#reset(new Map(), 0, 0)
      return new Map()
    }

    // 文件身份校验：同一条路径随时可能被换成另一份内容（另存、重写、轮转）。
    // 两道判据，命中路径与增量路径**都要过**：
    //   1) ino / birthtimeMs「两边都有值且不同」→ 换了文件。单独不够：有的文件系统
    //      不提供 ino，或者会把 inode 号复用（T11 之前的版本正是只靠这一道）；
    //   2) 游标前 ANCHOR_BYTES 字节的 anchor 必须原样还在（平台无关）。
    //      少了这一道，「同路径 + 同大小 + 同 mtime 的原地改写」会被命中路径
    //      当成「什么都没变」，直接把陈旧态返回给调用方。
    const identityChanged = (this.cachedIno !== undefined && this.cachedIno !== 0
      && info.ino !== undefined && info.ino !== 0 && info.ino !== this.cachedIno)
      || (this.cachedBirthtimeMs !== undefined && this.cachedBirthtimeMs !== 0
        && info.birthtimeMs !== undefined && info.birthtimeMs !== 0
        && info.birthtimeMs !== this.cachedBirthtimeMs)

    const hasCache = this.cache !== undefined
    // 每次带缓存的读多花两次 32B 读取（文件头 + 游标前）——相对「解析整本 NDJSON」可以忽略。
    // ⚠️ 这是**启发式**身份校验，不是绝对保证：只覆盖头 32B 与游标前 32B，
    //    「同路径 + 同大小 + 同 mtime + 头尾 32B 都相同（只有中段不同）」的原地改写
    //    仍会命中缓存并返回旧内容。要彻底消除只能每次全量重读、或对整本做内容哈希，
    //    那是数量级更高的代价，不在本设计的取舍内。
    const anchorsOk = hasCache && !identityChanged ? await this.#anchorsMatch(this.cachedSize) : false

    if (hasCache && !identityChanged && anchorsOk
      && info.size === this.cachedSize && info.mtimeMs === this.cachedMtimeMs) {
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
          const advanced = await this.#captureAnchors(this.cachedSize)
          this.cachedAnchor = advanced.tail
          this.cachedHeadAnchor = advanced.head
          this.stats.incrementalParses += 1
          this.stats.bytesParsed += consumed
          return cloneTasks(this.cache)
        }
        // 只多出半行：不动游标也不动缓存，等它写完再读。
        return cloneTasks(this.cache)
      }
    }

    // 首读 / 截断或缩小 / 文件身份或 anchor 变了（同路径被换成另一份内容）：全量重读。
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
   * 按字节区间读一段文本。读失败返回 undefined（让调用方回落到全量重读）。
   * @param {number} from
   * @param {number} to
   * @returns {Promise<string|undefined>}
   */
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
   * 取单个任务的最新态。
   * @param {string} taskId
   * @returns {Promise<TaskState|undefined>}
   */
  async latest(taskId) {
    return (await this.read()).get(taskId)
  }

  /**
   * 取该任务下一轮要传回 agy 的会话 id。
   * @param {string} taskId
   * @returns {Promise<string|undefined>}
   */
  async conversationFor(taskId) {
    return (await this.latest(taskId))?.conversationId
  }
}

/**
 * 默认台账路径。
 *
 * 必须是**绝对路径**。这里踩过一次真实的坑：宿主进程的 `process.env.DSH_HOME`
 * 不一定存在（DSH_* 是 host 注入给子 shell 的，不是 host 自己的环境），于是
 * 回落到相对路径 `wolfpack/runs.ndjson`，跟着宿主进程的 cwd 落到了
 * `D:\deepseek-harness\wolfpack\`——写进了源码检出目录，而且换 cwd 就换个地方。
 *
 * 所以这里逐级回落到一定绝对的位置，绝不返回相对路径。
 *
 * @param {Record<string, string|undefined>} [env] - 环境（便于单测）
 * @returns {string} 绝对路径
 */
export function defaultLedgerPath(env = process.env) {
  const explicit = env.WOLFPACK_LEDGER
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit

  const dshHome = env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    return join(dshHome, LEDGER_DIRNAME, LEDGER_FILENAME)
  }

  const userHome = env.USERPROFILE ?? env.HOME
  if (typeof userHome === 'string' && userHome.trim() !== '') {
    return join(userHome, '.dsh', LEDGER_DIRNAME, LEDGER_FILENAME)
  }

  return join(homedir(), '.dsh', LEDGER_DIRNAME, LEDGER_FILENAME)
}


/* ── 统一状态查询函数（CLI / MCP / DSH 共享同一份实现与结构） ── */

function omitUndefined(value) {
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) out[key] = val
  }
  return out
}

export const DEFAULT_STATUS_LIMIT = 20
export const MAX_STATUS_LIMIT = 100
export const STATUS_CHANGED_FILES_PER_TASK = 5

export function normalizeLimit(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), 1), MAX_STATUS_LIMIT)
    : DEFAULT_STATUS_LIMIT
}

export async function queryWolfStatus({
  ledger,
  taskId,
  limit,
  config = {},
  registry = defaultActiveRuns,
}) {
  if (!ledger) {
    return omitUndefined({
      tasks: [],
      total: 0,
      truncated: false,
      limit: DEFAULT_STATUS_LIMIT,
      ledger_path: undefined,
    })
  }

  const budgetLimit = typeof config?.continuationTokenBudget === 'number'
    && Number.isFinite(config.continuationTokenBudget)
    && config.continuationTokenBudget > 0
    ? config.continuationTokenBudget
    : undefined

  const active = new Set(registry.list().map(entry => entry.taskId))
  const all = [...(await ledger.read()).values()]
  const rows = (typeof taskId === 'string' && taskId !== ''
    ? all.filter(state => state.taskId === taskId)
    : all)
    .map(state => {
      const used = typeof state.totalTokens === 'number' && Number.isFinite(state.totalTokens)
        ? state.totalTokens
        : 0
      const budgetOver = budgetLimit !== undefined && used >= budgetLimit
      return omitUndefined({
        task_id: state.taskId,
        round: state.round,
        last_verdict: state.lastVerdict,
        last_stop_reason: state.lastStopReason,
        total_tokens: state.totalTokens,
        total_cache_read_tokens: state.totalCacheReadTokens,
        has_conversation_id: typeof state.conversationId === 'string' && state.conversationId !== '',
        running: active.has(state.taskId),
        changed_files_count: state.changedFiles.length,
        changed_files: state.changedFiles.slice(0, STATUS_CHANGED_FILES_PER_TASK),
        last_at: state.lastAt,
        last_duration_ms: state.lastDurationMs,
        budget_used: used,
        budget_limit: budgetLimit,
        budget_over: budgetOver,
      })
    })

  rows.sort((a, b) => b.last_at - a.last_at)
  const effLimit = normalizeLimit(limit)
  const visible = rows.slice(0, effLimit)
  return omitUndefined({
    tasks: visible,
    total: rows.length,
    truncated: rows.length > effLimit,
    limit: effLimit,
    ledger_path: ledger.filePath,
  })
}

/**
 * 把 wolf_status 的执行结果投影为纯 JSON 元数据（无 undefined、无 null）。
 *
 * @param {Record<string, any>} value - wolf_status 的 execute 返回值
 * @returns {Record<string, unknown>}
 */
export function statusMetaFromValue(value) {
  const tasks = Array.isArray(value?.tasks)
    ? value.tasks.map(task => {
        if (!task || typeof task !== 'object') return {}
        return omitUndefined({
          task_id: task.task_id,
          round: task.round,
          last_verdict: task.last_verdict ?? undefined,
          last_stop_reason: task.last_stop_reason ?? undefined,
          total_tokens: task.total_tokens,
          has_conversation_id: task.has_conversation_id,
          running: task.running,
          changed_files_count: task.changed_files_count,
          last_at: task.last_at,
          budget_used: typeof task.budget_used === 'number' ? task.budget_used : undefined,
          budget_limit: typeof task.budget_limit === 'number' ? task.budget_limit : undefined,
          budget_over: typeof task.budget_over === 'boolean' ? task.budget_over : undefined,
        })
      })
    : []

  return omitUndefined({
    tasks,
    total: value?.total,
    truncated: value?.truncated,
    limit: value?.limit,
  })
}
