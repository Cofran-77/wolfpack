import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 工人健康台账：谁刚刚坏过、坏在哪、冷却到什么时候。
 *
 * 铁律：
 * 1. **只影响挑选，不影响判定**。任务本身跑得好不好仍由产物快照与机械验收说话，
 *    这里只回答「下一轮该派给谁」。
 * 2. **永不空转**。两个工人都在冷却时，仍会挑最早恢复的那个硬试一次，不假装没活干。
 * 3. **容错**。台账文件缺失或损坏一律当空台账，绝不因为台账问题拦下派活。
 */

/** 健康台账版本号（将来换结构时用于兼容判断）。 */
export const HEALTH_VERSION = 1

/** 默认冷却参数（可被配置或环境变量覆盖）。 */
export const DEFAULT_HEALTH_CONFIG = {
  enabled: true,
  // 普通失败（工人回了话但自报失败）连续几次才冷却
  failThreshold: 2,
  // 普通失败累计到阈值后的冷却时长
  cooldownMs: 10 * 60_000,
  // 容量/额度/中转池子耗尽：短冷却，等池子回血
  capacityCooldownMs: 5 * 60_000,
  // 超时（多半是挂住不说话）：较长冷却
  timeoutCooldownMs: 10 * 60_000,
  // 未登录/鉴权失败：需要人处理，冷却最长
  authCooldownMs: 30 * 60_000,
}

/**
 * 空台账。
 *
 * @returns {{ version: number, updatedAt: number, workers: Record<string, object> }}
 */
export function emptyHealthState() {
  return { version: HEALTH_VERSION, updatedAt: 0, workers: {} }
}

/**
 * 读取健康台账。文件不存在、内容损坏、结构不对，一律退化为空台账。
 *
 * @param {string} filePath
 * @returns {Promise<{ version: number, updatedAt: number, workers: Record<string, object> }>}
 */
export async function readHealthState(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return emptyHealthState()
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyHealthState()
    const workers = parsed.workers
    if (!workers || typeof workers !== 'object' || Array.isArray(workers)) return emptyHealthState()
    return {
      version: typeof parsed.version === 'number' ? parsed.version : HEALTH_VERSION,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      workers: { ...workers },
    }
  } catch {
    return emptyHealthState()
  }
}

/** 同进程内的读改写串行队列：并发小队不会互相覆盖。 */
let writeChain = Promise.resolve()

/**
 * 串行化的「读 → 改 → 原子写」。mutator 直接改传入的 state 并返回它（或返回新对象）。
 *
 * @param {string} filePath
 * @param {(state: object) => object} mutator
 * @returns {Promise<object>} 写入后的台账
 */
export async function updateHealthState(filePath, mutator) {
  if (typeof filePath !== 'string' || filePath === '' || typeof mutator !== 'function') {
    return emptyHealthState()
  }
  const task = writeChain.then(async () => {
    const state = await readHealthState(filePath)
    const next = mutator(state) ?? state
    next.updatedAt = Date.now()
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}`
    try {
      await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
      await rename(tmp, filePath)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    return next
  })
  // 队列不能因为单次失败而卡死
  writeChain = task.then(() => undefined, () => undefined)
  return task
}

/**
 * 归一化配置里的健康参数。
 *
 * @param {object} [config]
 * @returns {typeof DEFAULT_HEALTH_CONFIG}
 */
export function healthConfigOf(config) {
  const h = config?.workerHealth ?? {}
  const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
  return {
    enabled: h.enabled !== false,
    failThreshold: positive(h.failThreshold, DEFAULT_HEALTH_CONFIG.failThreshold),
    cooldownMs: positive(h.cooldownMs, DEFAULT_HEALTH_CONFIG.cooldownMs),
    capacityCooldownMs: positive(h.capacityCooldownMs, DEFAULT_HEALTH_CONFIG.capacityCooldownMs),
    timeoutCooldownMs: positive(h.timeoutCooldownMs, DEFAULT_HEALTH_CONFIG.timeoutCooldownMs),
    authCooldownMs: positive(h.authCooldownMs, DEFAULT_HEALTH_CONFIG.authCooldownMs),
  }
}

/** 故障类别 → 冷却时长（毫秒）。 */
function cooldownFor(kind, cfg) {
  if (kind === 'capacity') return cfg.capacityCooldownMs
  if (kind === 'timeout') return cfg.timeoutCooldownMs
  if (kind === 'auth') return cfg.authCooldownMs
  return cfg.cooldownMs
}

/**
 * 记录一轮结果。kind 取值：
 * - `'success'`：清零连续失败、解除冷却；
 * - `'neutral'`：什么都不改（基线闸门跳过、用户自己取消）；
 * - `'capacity' | 'auth' | 'timeout' | 'no-output' | 'error'`：记一次失败。
 *
 * 工人自身故障（capacity/auth/timeout/no-output）**当轮立即冷却**；
 * 普通失败（error，工人回了话但自报失败）累计到 failThreshold 才冷却。
 *
 * @param {object} state
 * @param {object} params
 * @param {string} params.worker
 * @param {string} [params.kind]
 * @param {string} [params.stopReason]
 * @param {string} [params.diagnostic]
 * @param {object} [params.config]
 * @param {number} [params.now]
 * @returns {object} 同一个 state（原地更新）
 */
export function recordWorkerOutcome(state, { worker, kind, stopReason, diagnostic, config, now = Date.now() } = {}) {
  const cfg = healthConfigOf(config)
  if (!cfg.enabled || typeof worker !== 'string' || worker === '') return state
  if (!state.workers || typeof state.workers !== 'object') state.workers = {}

  const base = state.workers[worker] ?? { consecutiveFailures: 0, totalFailures: 0 }

  if (kind === 'neutral') return state

  if (kind === undefined || kind === 'success') {
    state.workers[worker] = {
      ...base,
      consecutiveFailures: 0,
      benchedUntil: 0,
      benchReason: undefined,
      lastReason: undefined,
      lastStopReason: undefined,
      lastDiagnostic: undefined,
      lastOutcome: 'success',
      lastSuccessAt: now,
    }
    return state
  }

  const consecutiveFailures = (base.consecutiveFailures ?? 0) + 1
  const immediate = kind !== 'error'
  const shouldBench = immediate || consecutiveFailures >= cfg.failThreshold
  const cooldownMs = cooldownFor(kind, cfg)

  state.workers[worker] = {
    ...base,
    consecutiveFailures,
    totalFailures: (base.totalFailures ?? 0) + 1,
    lastFailureAt: now,
    lastReason: kind,
    lastStopReason: stopReason,
    lastDiagnostic: typeof diagnostic === 'string' ? diagnostic.slice(0, 300) : undefined,
    lastOutcome: 'failure',
    ...(shouldBench
      ? {
          benchedUntil: now + cooldownMs,
          benchReason: kind,
          benchUntilIso: new Date(now + cooldownMs).toISOString(),
        }
      : {}),
  }
  return state
}

/**
 * 清除某个工人的冷却与失败计数（手动「我修好了，立刻重试」）。
 *
 * @param {object} state
 * @param {string} worker - 'all' 表示清空所有工人
 * @returns {object}
 */
export function resetWorkerHealth(state, worker) {
  if (!state.workers || typeof state.workers !== 'object') state.workers = {}
  if (worker === 'all' || worker === undefined || worker === '') {
    state.workers = {}
    return state
  }
  delete state.workers[worker]
  return state
}

/**
 * 生成给调用方（digest / status / 面板）看的只读快照。
 *
 * @param {object} state
 * @param {string} worker
 * @param {number} [now]
 * @returns {object}
 */
export function snapshotHealth(state, worker, now = Date.now()) {
  const entry = state?.workers?.[worker]
  if (!entry) {
    return {
      worker,
      benched: false,
      consecutive_failures: 0,
      total_failures: 0,
    }
  }
  const until = typeof entry.benchedUntil === 'number' && Number.isFinite(entry.benchedUntil)
    ? entry.benchedUntil
    : 0
  const benched = until > now
  const snap = {
    worker,
    benched,
    consecutive_failures: typeof entry.consecutiveFailures === 'number' && Number.isFinite(entry.consecutiveFailures)
      ? entry.consecutiveFailures
      : 0,
    total_failures: typeof entry.totalFailures === 'number' && Number.isFinite(entry.totalFailures)
      ? entry.totalFailures
      : 0,
  }
  if (benched) {
    snap.benched_until = until
    snap.remaining_ms = Math.max(0, until - now)
  }
  if (entry.lastReason !== undefined && entry.lastReason !== null) snap.last_reason = entry.lastReason
  if (entry.lastStopReason !== undefined && entry.lastStopReason !== null) snap.last_stop_reason = entry.lastStopReason
  if (entry.lastDiagnostic !== undefined && entry.lastDiagnostic !== null) snap.last_diagnostic = entry.lastDiagnostic
  if (entry.lastOutcome !== undefined && entry.lastOutcome !== null) snap.last_outcome = entry.lastOutcome
  if (entry.lastFailureAt !== undefined && entry.lastFailureAt !== null) snap.last_failure_at = entry.lastFailureAt
  if (entry.lastSuccessAt !== undefined && entry.lastSuccessAt !== null) snap.last_success_at = entry.lastSuccessAt
  return snap
}

/** 故障类别的中文说明（digest / status / 面板共用）。 */
export const FAULT_LABELS = {
  capacity: '额度/容量不足（含 API 中转池子耗尽）',
  auth: '未登录或鉴权失败',
  timeout: '超时（疑似挂住不说话）',
  'no-output': '没有输出',
  error: '工人自报失败',
}

/**
 * 故障类别 → 可读文案。
 *
 * @param {string|undefined} kind
 * @returns {string}
 */
export function faultLabel(kind) {
  if (typeof kind !== 'string' || kind === '') return '未知原因'
  return FAULT_LABELS[kind] ?? kind
}
