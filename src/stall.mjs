import { realpathSync } from 'node:fs'
import { appendFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 狼群停滞监控（宿主无关核）。**只报警，永不终止。**
 *
 * 每个工人各有一套监控：判据是「这个工人自己还在不在写东西」——
 *   · agy：brain/<conversationId>/.system_generated/logs/transcript*.jsonl 与 conversations/<id>.db
 *   · claude：~/.claude/projects/<项目目录>/.<sessionId>.jsonl（Claude Code CLI 的会话流水，
 *     注意**不是** Claude Desktop，两者存储完全不同）
 *
 * 窗口 1× / 2× / 3× 各报一次（默认 5 / 10 / 15 分钟无进展），之后闭嘴。
 * 本模块没有任何终止能力，只提供采样、判定与停滞台账写入；
 * 系统通知属于宿主专有外设，由宿主显式注入（见 src/runtime/node.mjs）。
 */

/** 默认停滞窗口：多久没有任何进展才算「可能卡住」。 */
export const DEFAULT_STALL_WINDOW_MS = 5 * 60 * 1000
/** 默认最多报警几次（之后闭嘴，交给人）。 */
export const DEFAULT_STALL_WARNINGS = 3
/** 默认采样间隔。 */
export const DEFAULT_STALL_POLL_MS = 30 * 1000
/** 采样间隔下限，防止把磁盘打爆。 */
export const MIN_STALL_POLL_MS = 5_000

/**
 * 各工人的会话存储位置（相对于家目录）与环境变量覆盖键。
 * 两个工人**各有各的根**，绝不互相借用。
 */
export const WORKER_STALL_STORES = {
  agy: {
    worker: 'agy',
    envKeys: ['WOLFPACK_AGY_STORE_ROOT', 'WOLFPACK_STORE_ROOT'],
    segments: ['.gemini', 'antigravity-cli'],
  },
  claude: {
    worker: 'claude',
    envKeys: ['WOLFPACK_CLAUDE_STORE_ROOT'],
    segments: ['.claude', 'projects'],
  },
}

/** 已登记的工人名（用于面板与配置逐工人遍历）。 */
export const STALL_WORKERS = Object.keys(WORKER_STALL_STORES)

/**
 * 某工人的默认会话存储根。
 *
 * @param {string} workerName
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined} 无法确定家目录时返回 undefined（= 该工人监控不启用）
 */
export function defaultStoreRoot(workerName, env = process.env) {
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  const spec = WORKER_STALL_STORES[workerName]
  if (!spec) return undefined
  if (typeof home !== 'string' || home.trim() === '') return undefined
  return join(home, ...spec.segments)
}

/**
 * 解析某工人的会话存储根：环境变量 > 配置 > 平台默认。
 *
 * @param {string} workerName
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined}
 */
export function workerStoreRoot(workerName, config, env = process.env) {
  const spec = WORKER_STALL_STORES[workerName]
  if (!spec) return undefined

  for (const key of spec.envKeys) {
    const raw = env?.[key]
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  }

  const nested = config?.stall?.storeRoots?.[workerName]
  if (typeof nested === 'string' && nested.trim() !== '') return nested.trim()
  const configured = config?.stallStoreRoots?.[workerName]
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (workerName === 'agy' && typeof config?.stallStoreRoot === 'string' && config.stallStoreRoot.trim() !== '') {
    return config.stallStoreRoot.trim()
  }

  return defaultStoreRoot(workerName, env)
}

/**
 * 秒型开关：off / none / 0 → 0（关闭）；空/无效值 → 默认；正数 → 毫秒。
 *
 * @param {string|undefined} raw
 * @param {number} fallbackMs
 * @returns {number}
 */
function secondsEnv(raw, fallbackMs) {
  if (raw === undefined || String(raw).trim() === '') return fallbackMs
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return 0
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : fallbackMs
}

/**
 * 从配置文件里取某个工人专属/全局的秒型设置（`stall.windowSeconds`、
 * `stall.windowSecondsByWorker.<工人>`、`stall.pollSeconds` 等）。
 * 返回 undefined 表示「配置文件没管这项」，交给下一优先级。
 *
 * @param {object|undefined} config
 * @param {string} key - 'windowSeconds' | 'pollSeconds'
 * @param {string} [workerName]
 * @returns {number|undefined}
 */
function configSeconds(config, key, workerName) {
  const perWorker = workerName ? config?.stall?.[`${key}ByWorker`]?.[workerName] : undefined
  const raw = perWorker ?? config?.stall?.[key]
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return 0
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : undefined
}

/**
 * 从配置文件里取非负计数设置（`stall.warnings` / `stall.warningsByWorker.<工人>`）。
 *
 * @param {object|undefined} config
 * @param {string} workerName
 * @returns {number|undefined}
 */
function configCount(config, workerName) {
  const perWorker = config?.stall?.warningsByWorker?.[workerName]
  const raw = perWorker ?? config?.stall?.warnings
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return 0
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/**
 * 停滞窗口（毫秒），按工人可覆盖：WOLFPACK_STALL_WINDOW_<WORKER> > WOLFPACK_STALL_WINDOW。
 * 0 = 关闭该工人的监控。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [workerName]
 * @param {object} [config] - 文件配置（`stall.windowSeconds` / `stall.windowSecondsByWorker`）
 * @returns {number}
 */
export function stallWindowMs(env = process.env, workerName, config) {
  const specific = workerName ? env?.[`WOLFPACK_STALL_WINDOW_${workerName.toUpperCase()}`] : undefined
  const fromEnv = specific ?? env.WOLFPACK_STALL_WINDOW
  if (String(fromEnv ?? '').trim() !== '') return secondsEnv(fromEnv, DEFAULT_STALL_WINDOW_MS)
  const fromConfig = configSeconds(config, 'windowSeconds', workerName)
  return fromConfig === undefined ? DEFAULT_STALL_WINDOW_MS : fromConfig
}

/**
 * 最多报警次数。0 = 只记录不打扰。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [workerName]
 * @param {object} [config]
 * @returns {number}
 */
export function stallMaxWarnings(env = process.env, workerName, config) {
  const specific = workerName ? env?.[`WOLFPACK_STALL_WARNINGS_${workerName.toUpperCase()}`] : undefined
  const raw = specific ?? env.WOLFPACK_STALL_WARNINGS
  if (raw === undefined || String(raw).trim() === '') {
    const fromConfig = configCount(config, workerName)
    return fromConfig === undefined ? DEFAULT_STALL_WARNINGS : fromConfig
  }
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return 0
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_STALL_WARNINGS
}

/**
 * 采样间隔（毫秒），下限 5 秒。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [config]
 * @returns {number}
 */
export function stallPollMs(env = process.env, config) {
  const fromEnv = String(env?.WOLFPACK_STALL_POLL ?? '').trim()
  const value = fromEnv !== ''
    ? secondsEnv(env.WOLFPACK_STALL_POLL, DEFAULT_STALL_POLL_MS)
    : (configSeconds(config, 'pollSeconds') ?? DEFAULT_STALL_POLL_MS)
  return value === 0 ? DEFAULT_STALL_POLL_MS : Math.max(MIN_STALL_POLL_MS, value)
}

/**
 * 系统通知开关（WOLFPACK_STALL_TOAST=off 关闭；CLI/MCP 下默认关，避免打扰）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [config]
 * @returns {boolean}
 */
export function stallToastEnabled(env = process.env, config) {
  const raw = env.WOLFPACK_STALL_TOAST
  if (raw === undefined || String(raw).trim() === '') {
    return config?.stall?.toast === true
  }
  const text = String(raw).trim().toLowerCase()
  return !(text === 'off' || text === 'none' || text === '0' || text === 'false')
}

/**
 * 解析**某个工人**的停滞监控参数。
 *
 * @param {string} workerName
 * @param {object} [params]
 * @param {Record<string, string|undefined>} [params.env]
 * @param {object} [params.config]
 * @returns {{worker: string, storeRoot: string|undefined, windowMs: number, maxWarnings: number, pollMs: number, toast: boolean}}
 */
export function resolveStallConfig(workerName, { env = process.env, config } = {}) {
  return {
    worker: workerName,
    storeRoot: workerStoreRoot(workerName, config, env),
    windowMs: stallWindowMs(env, workerName, config),
    maxWarnings: stallMaxWarnings(env, workerName, config),
    pollMs: stallPollMs(env, config),
    toast: stallToastEnabled(env, config),
  }
}

/**
 * 解析**全部工人**的停滞监控参数（两个工人各一套，供面板分开展示）。
 *
 * @param {object} [params]
 * @param {Record<string, string|undefined>} [params.env]
 * @param {object} [params.config]
 * @returns {Record<string, ReturnType<typeof resolveStallConfig>>}
 */
export function resolveStallConfigs({ env = process.env, config } = {}) {
  const out = {}
  for (const workerName of STALL_WORKERS) {
    out[workerName] = resolveStallConfig(workerName, { env, config })
  }
  return out
}

/* ── 会话定位 ─────────────────────────────────────────────────────── */

/**
 * Claude Code CLI 的项目目录名：把工作目录里的非字母数字字符逐个换成 `-`。
 * 例：~/dev/app → -Users-you-dev-app（实测规则，用于定位 <sessionId>.jsonl）。
 *
 * 先做 realpath 归一：macOS 上 /tmp 是指向 /private/tmp 的软链，而 Claude Code CLI
 * 拿到的 cwd 是内核给出的物理路径，不归一就会算错项目目录名。
 *
 * @param {string} cwd
 * @returns {string}
 */
export function claudeProjectSlug(cwd) {
  const text = typeof cwd === 'string' ? cwd : ''
  if (text === '') return ''
  let resolved = text
  try {
    resolved = realpathSync(text)
  } catch {
    // 目录不存在（或不可读）时按原样算，不因为探测失败而放弃
  }
  return resolved.replace(/[^a-zA-Z0-9]/g, '-')
}

/* ── 采样 ─────────────────────────────────────────────────────────── */

const DEFAULT_FS = { stat, readdir }

/**
 * 目录里（最多两层）最新的一次写入时间。
 *
 * @param {{stat: Function, readdir: Function}} fs
 * @param {string} dir
 * @param {number} depth
 * @returns {Promise<number>} 毫秒；0 = 读不到
 */
async function latestInDir(fs, dir, depth) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return 0
  }
  let max = 0
  for (const name of names) {
    const full = join(dir, name)
    let info
    try {
      info = await fs.stat(full)
    } catch {
      continue
    }
    if (info.mtimeMs > max) max = info.mtimeMs
    if (depth > 0 && info.isDirectory() === true) {
      const inner = await latestInDir(fs, full, depth - 1)
      if (inner > max) max = inner
    }
  }
  return max
}

/**
 * 在 store 根里按文件名找某个会话文件（claude 的 <sessionId>.jsonl 可能落在别的项目目录）。
 *
 * @param {{stat: Function, readdir: Function}} fs
 * @param {string} root
 * @param {string} fileName
 * @returns {Promise<number>} mtime 毫秒；0 = 找不到
 */
async function findSessionFileMtime(fs, root, fileName) {
  let dirs
  try {
    dirs = await fs.readdir(root)
  } catch {
    return 0
  }
  let max = 0
  for (const name of dirs) {
    const dir = join(root, name)
    let info
    try {
      info = await fs.stat(dir)
    } catch {
      continue
    }
    if (info.isDirectory() !== true) {
      if (name === fileName && info.mtimeMs > max) max = info.mtimeMs
      continue
    }
    const hit = await statOf(fs, join(dir, fileName))
    if (hit > max) max = hit
  }
  return max
}

async function statOf(fs, path) {
  try {
    return (await fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 一次心跳采样。**两个工人各走各的路径**，绝不互相借用。
 *
 * @param {object} params
 * @param {string} params.worker - 'agy' | 'claude'
 * @param {string|undefined} params.storeRoot
 * @param {string} [params.sessionId] - 该工人自己的会话 ID（agy 为 conversationId，claude 为 session_id）
 * @param {string} [params.cwd] - 仅 claude 需要（用来算项目目录名）
 * @param {{stat: Function, readdir: Function}} [params.fs]
 * @returns {Promise<{available: boolean, mtimeMs: number, worker: string, sessionFile?: string}>}
 */
export async function sampleProgress({ worker, storeRoot, sessionId, cwd, fs = DEFAULT_FS }) {
  const result = { available: false, mtimeMs: 0, worker }
  if (typeof storeRoot !== 'string' || storeRoot === '') return result

  const marks = []

  if (worker === 'agy') {
    if (typeof sessionId === 'string' && sessionId !== '') {
      marks.push(await statOf(fs, join(storeRoot, 'conversations', `${sessionId}.db`)))
      marks.push(await statOf(fs, join(storeRoot, 'conversations', `${sessionId}.db-wal`)))
      marks.push(await statOf(fs, join(storeRoot, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl')))
      marks.push(await statOf(fs, join(storeRoot, 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl')))
      marks.push(await latestInDir(fs, join(storeRoot, 'brain', sessionId, '.system_generated', 'logs'), 1))
    } else {
      marks.push(await latestInDir(fs, join(storeRoot, 'conversations'), 0))
      marks.push(await latestInDir(fs, join(storeRoot, 'brain'), 2))
    }
  } else if (worker === 'claude') {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const fileName = `${sessionId}.jsonl`
      const slugged = typeof cwd === 'string' && cwd !== ''
        ? await statOf(fs, join(storeRoot, claudeProjectSlug(cwd), fileName))
        : 0
      marks.push(slugged)
      if (slugged === 0) {
        const found = await findSessionFileMtime(fs, storeRoot, fileName)
        marks.push(found)
        if (found > 0) result.sessionFile = fileName
      }
    } else {
      marks.push(await latestInDir(fs, storeRoot, 1))
    }
  } else {
    return result
  }

  const mtimeMs = marks.reduce((max, value) => (value > max ? value : max), 0)
  result.mtimeMs = mtimeMs
  result.available = marks.some(value => value > 0)
  return result
}

/* ── 判定与台账 ───────────────────────────────────────────────────── */

/**
 * 停滞判定（纯函数）。
 *
 * @param {object} params
 * @param {number} params.silentMs - 距上次有进展过了多久
 * @param {number} params.windowMs - 一个窗口的长度
 * @param {number} params.warningsSent - 已经报过几次
 * @param {number} params.maxWarnings - 最多报几次
 * @returns {{warn: boolean, level: number, exhausted: boolean}}
 */
export function stallDecision({ silentMs, windowMs, warningsSent, maxWarnings }) {
  const level = Number.isFinite(warningsSent) ? warningsSent : 0
  if (!Number.isFinite(windowMs) || windowMs <= 0) return { warn: false, level, exhausted: false }
  if (!Number.isFinite(silentMs) || silentMs < windowMs) return { warn: false, level, exhausted: false }
  const due = Math.floor(silentMs / windowMs)
  if (due <= level) return { warn: false, level, exhausted: false }
  if (level >= maxWarnings) return { warn: false, level, exhausted: true }
  return { warn: true, level: level + 1, exhausted: false }
}

/**
 * 把一次报警追加进停滞台账（NDJSON）。
 *
 * @param {string} filePath
 * @param {object} record
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function appendStallRecord(filePath, record) {
  if (typeof filePath !== 'string' || filePath === '') return false
  try {
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/* ── 监控器 ───────────────────────────────────────────────────────── */

/**
 * 创建**某工人**的停滞监控器（纯核，不具备终止能力）。
 *
 * @param {object} params
 * @param {string} params.worker
 * @param {string|undefined} params.storeRoot
 * @param {string} [params.sessionId]
 * @param {string} [params.cwd]
 * @param {number} params.windowMs - 0 = 关闭监控
 * @param {number} [params.maxWarnings]
 * @param {number} [params.pollMs]
 * @param {() => number} [params.now]
 * @param {{stat: Function, readdir: Function}} [params.fs]
 * @param {(warning: object) => void} [params.onWarning]
 * @param {(message: string) => void} [params.onError]
 * @param {(warning: object) => void} [params.onToast]
 * @param {(snapshot: object) => void} [params.onSample] - 每次采样后回调（供面板/落盘）
 * @returns {object} { start, stop, poll, snapshot }
 */
export function createStallMonitor({
  worker,
  storeRoot,
  sessionId,
  cwd,
  windowMs,
  maxWarnings = DEFAULT_STALL_WARNINGS,
  pollMs = DEFAULT_STALL_POLL_MS,
  now = () => Date.now(),
  fs = DEFAULT_FS,
  onWarning,
  onError,
  onToast,
  onSample,
}) {
  const state = {
    started: false,
    heartbeats: 0,
    unavailable: false,
    warnings: 0,
    episodes: 0,
    exhausted: false,
    lastProgressAt: 0,
    lastWarningAt: 0,
    observedMtimeMs: 0,
    silentMs: 0,
  }
  let timer

  const enabled = typeof storeRoot === 'string' && storeRoot !== '' && Number.isFinite(windowMs) && windowMs > 0

  const snapshot = () => ({
    worker,
    enabled,
    store_root: enabled ? storeRoot : undefined,
    window_ms: Number.isFinite(windowMs) ? windowMs : 0,
    max_warnings: maxWarnings,
    heartbeats: state.heartbeats,
    unavailable: state.unavailable,
    warnings: state.warnings,
    episodes: state.episodes,
    exhausted: state.exhausted,
    last_progress_at: state.lastProgressAt === 0 ? undefined : state.lastProgressAt,
    last_warning_at: state.lastWarningAt === 0 ? undefined : state.lastWarningAt,
    silent_ms: state.silentMs,
  })

  async function poll() {
    if (!enabled) return
    const at = now()
    let sample
    try {
      sample = await sampleProgress({ worker, storeRoot, sessionId, cwd, fs })
    } catch (error) {
      state.unavailable = true
      onError?.(`${worker} 停滞采样失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (!sample.available) {
      state.unavailable = true
      return
    }
    state.unavailable = false
    state.heartbeats += 1

    if (sample.mtimeMs > state.observedMtimeMs) {
      state.observedMtimeMs = sample.mtimeMs
      state.lastProgressAt = at
      if (state.warnings > 0 || state.exhausted) {
        state.episodes += 1
        state.warnings = 0
        state.exhausted = false
      }
    } else if (state.lastProgressAt === 0) {
      state.lastProgressAt = at
    }

    const silentMs = Math.max(0, at - state.lastProgressAt)
    state.silentMs = silentMs
    const decision = stallDecision({ silentMs, windowMs, warningsSent: state.warnings, maxWarnings })
    if (decision.warn) {
      state.warnings = decision.level
      state.lastWarningAt = at
      const warningInfo = { worker, level: decision.level, maxWarnings, silentMs, windowMs }
      onWarning?.(warningInfo)
      if (typeof onToast === 'function') {
        try {
          onToast(warningInfo)
        } catch {}
      }
      onSample?.(snapshot())
      return
    }
    if (decision.exhausted) state.exhausted = true
    onSample?.(snapshot())
  }

  async function run() {
    if (!state.started) return
    await poll()
    if (!state.started) return
    timer = setTimeout(run, pollMs)
    timer?.unref?.()
  }

  return {
    worker,
    start() {
      if (!enabled || state.started) return false
      state.started = true
      timer = setTimeout(run, pollMs)
      timer?.unref?.()
      return true
    },
    stop() {
      state.started = false
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
    poll,
    snapshot,
  }
}

/**
 * 人话版单工人停滞摘要（digest 与面板共用，**明确带工人名**）。
 *
 * @param {object|undefined} snapshot
 * @returns {string}
 */
export function formatStallSummary(snapshot) {
  const worker = snapshot?.worker ?? '工人'
  if (!snapshot || snapshot.enabled !== true) {
    return `${worker}：停滞监控未启用（未提供会话存储根，或窗口被设为 0）`
  }
  const windowMinutes = (snapshot.window_ms ?? 0) / 60_000
  const windowText = windowMinutes >= 1 ? `${Math.round(windowMinutes * 10) / 10} 分钟` : `${Math.round(snapshot.window_ms / 1000)} 秒`
  if (snapshot.unavailable === true) {
    return `${worker}：暂时观测不到会话写入（采样 ${snapshot.heartbeats ?? 0} 次）——不代表卡住`
  }
  const silentMinutes = Math.round(((snapshot.silent_ms ?? 0) / 60_000) * 10) / 10
  const warnText = snapshot.warnings > 0
    ? `报警 ${snapshot.warnings}/${snapshot.max_warnings} 次`
    : (snapshot.exhausted ? '已报警完毕，不再打扰' : '未报警')
  const episodeText = snapshot.episodes > 0 ? ` · 已恢复 ${snapshot.episodes} 次` : ''
  return `${worker}：采样 ${snapshot.heartbeats ?? 0} 次 · 最长静默 ${silentMinutes} 分钟 · ${warnText} · 窗口 ${windowText}${episodeText}`
}
