/**
 * 狼群模式通用内核 — 停滞监控（宿主无关）。**只报警，永不终止。**
 *
 * 判据：agy 还在不在工作（采样 transcript.jsonl / brain 目录 mtime）。
 * 窗口 1× / 2× / 3× 各报一次（默认 5 / 10 / 15 分钟无进展），之后闭嘴，
 * 把决定权交给人：终止与否由人决定（Esc / 中断会话）。
 *
 * ⚠️ 本模块没有任何终止能力，只提供文件活跃度采样、判定与停滞台账写入。
 * 系统通知（Toast）属于宿主专有外设，由宿主环境显式注入。
 */

import { appendFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 默认停滞窗口：多久没有任何进展才算「可能卡住」。 */
export const DEFAULT_STALL_WINDOW_MS = 5 * 60 * 1000
/** 默认最多报警几次（之后闭嘴，交给人）。 */
export const DEFAULT_STALL_WARNINGS = 3
/** 默认采样间隔。 */
export const DEFAULT_STALL_POLL_MS = 30 * 1000

/**
 * agy 会话存储根。默认 ~/.gemini/antigravity-cli，可用 WOLFPACK_STORE_ROOT 覆盖。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined} 无法确定家目录时返回 undefined（= 监控不启用）
 */
export function defaultStoreRoot(env = process.env) {
  const home = env.USERPROFILE ?? env.HOME ?? ''
  return home === '' ? undefined : join(home, '.gemini', 'antigravity-cli')
}

/**
 * 秒型开关：off/none/0 → 0（关闭）；空/无效值 → 默认；正数 → 毫秒。
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

/** 停滞窗口（毫秒）。0 = 关闭监控。 */
export function stallWindowMs(env = process.env) {
  return secondsEnv(env.WOLFPACK_STALL_WINDOW, DEFAULT_STALL_WINDOW_MS)
}

/** 最多报警次数。0 = 只记录不打扰。 */
export function stallMaxWarnings(env = process.env) {
  const raw = env.WOLFPACK_STALL_WARNINGS
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_STALL_WARNINGS
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return 0
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_STALL_WARNINGS
}

/** 采样间隔（毫秒），下限 5 秒。 */
export function stallPollMs(env = process.env) {
  const value = secondsEnv(env.WOLFPACK_STALL_POLL, DEFAULT_STALL_POLL_MS)
  return value === 0 ? DEFAULT_STALL_POLL_MS : Math.max(5_000, value)
}

/** 系统通知开关（WOLFPACK_STALL_TOAST=off 关闭）。 */
export function stallToastEnabled(env = process.env) {
  const raw = env.WOLFPACK_STALL_TOAST
  if (raw === undefined || String(raw).trim() === '') return true
  const text = String(raw).trim().toLowerCase()
  return !(text === 'off' || text === 'none' || text === '0' || text === 'false')
}

/**
 * 把环境变量解析成启动监控所需的一组参数。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{storeRoot: string|undefined, windowMs: number, maxWarnings: number, pollMs: number, toast: boolean}}
 */
export function resolveStallConfig(env = process.env) {
  const override = env.WOLFPACK_STORE_ROOT
  return {
    storeRoot: typeof override === 'string' && override.trim() !== '' ? override.trim() : defaultStoreRoot(env),
    windowMs: stallWindowMs(env),
    maxWarnings: stallMaxWarnings(env),
    pollMs: stallPollMs(env),
    toast: stallToastEnabled(env),
  }
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
 * 一次心跳采样。
 *
 * @param {object} params
 * @param {string|undefined} params.storeRoot - 存储根；空 = 不可观测
 * @param {string[]} [params.conversationIds] - 已知会话 id（精确观测）
 * @param {{stat: Function, readdir: Function}} [params.fs]
 * @returns {Promise<{available: boolean, mtimeMs: number}>} available = 有没有任何可观测的写入
 */
export async function sampleProgress({ storeRoot, conversationIds = [], fs = DEFAULT_FS }) {
  if (typeof storeRoot !== 'string' || storeRoot === '') return { available: false, mtimeMs: 0 }

  const marks = []
  const statOf = async path => {
    try {
      return (await fs.stat(path)).mtimeMs
    } catch {
      return 0
    }
  }

  if (conversationIds.length > 0) {
    for (const id of conversationIds) {
      marks.push(await statOf(join(storeRoot, 'conversations', `${id}.db`)))
      marks.push(await statOf(join(storeRoot, 'conversations', `${id}.db-wal`)))
      marks.push(await statOf(join(storeRoot, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')))
      marks.push(await latestInDir(fs, join(storeRoot, 'brain', id, '.system_generated', 'logs'), 1))
    }
  } else {
    marks.push(await latestInDir(fs, join(storeRoot, 'conversations'), 0))
    marks.push(await latestInDir(fs, join(storeRoot, 'brain'), 2))
  }

  const mtimeMs = marks.reduce((max, value) => (value > max ? value : max), 0)
  return { available: marks.some(value => value > 0), mtimeMs }
}

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
 * 创建停滞监控器（纯核心层）。**不具备终止能力**。
 *
 * @param {object} params
 * @param {string|undefined} params.storeRoot
 * @param {string[]} [params.conversationIds]
 * @param {number} params.windowMs - 0 = 关闭监控
 * @param {number} [params.maxWarnings]
 * @param {number} [params.pollMs]
 * @param {() => number} [params.now]
 * @param {{stat: Function, readdir: Function}} [params.fs]
 * @param {(warning: {level: number, maxWarnings: number, silentMs: number}) => void} [params.onWarning]
 * @param {(message: string) => void} [params.onError]
 * @param {(warning: {level: number, maxWarnings: number, silentMs: number}) => void} [params.onToast] - 注入的通知回调
 * @returns {object} { start, stop, poll, snapshot }
 */
export function createStallMonitor({
  storeRoot,
  conversationIds = [],
  windowMs,
  maxWarnings = DEFAULT_STALL_WARNINGS,
  pollMs = DEFAULT_STALL_POLL_MS,
  now = () => Date.now(),
  fs = DEFAULT_FS,
  onWarning,
  onError,
  onToast,
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

  async function poll() {
    if (!enabled) return
    const at = now()
    let sample
    try {
      sample = await sampleProgress({ storeRoot, conversationIds, fs })
    } catch (error) {
      state.unavailable = true
      onError?.(`停滞采样失败：${error instanceof Error ? error.message : String(error)}`)
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
      const warningInfo = { level: decision.level, maxWarnings, silentMs }
      onWarning?.(warningInfo)
      if (typeof onToast === 'function') {
        try {
          onToast(warningInfo)
        } catch {}
      }
      return
    }
    if (decision.exhausted) state.exhausted = true
  }

  async function run() {
    if (!state.started) return
    await poll()
    if (!state.started) return
    timer = setTimeout(run, pollMs)
    timer?.unref?.()
  }

  return {
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
    snapshot() {
      return {
        enabled,
        heartbeats: state.heartbeats,
        unavailable: state.unavailable,
        warnings: state.warnings,
        episodes: state.episodes,
        exhausted: state.exhausted,
        lastProgressAt: state.lastProgressAt === 0 ? undefined : state.lastProgressAt,
        lastWarningAt: state.lastWarningAt === 0 ? undefined : state.lastWarningAt,
        silentMs: state.silentMs,
      }
    },
  }
}
