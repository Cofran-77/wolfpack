import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { resolveStallConfigs, stallToastEnabled } from './stall.mjs'

/**
 * 将路径中的 ~ 展开为当前用户家目录。
 *
 * @param {string} [pathStr]
 * @returns {string}
 */
export function resolveHome(pathStr) {
  if (typeof pathStr !== 'string' || pathStr.trim() === '') return ''
  const trimmed = pathStr.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return trimmed
}

/**
 * 从指定目录向上搜索 wolfpack.config.json 配置文件。
 *
 * @param {string} [startDir]
 * @returns {string|undefined}
 */
export function findConfigFile(startDir = process.cwd()) {
  try {
    let current = resolve(startDir)
    while (true) {
      const candidate = join(current, 'wolfpack.config.json')
      if (existsSync(candidate)) return candidate
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  } catch {
    // 忽略文件访问异常
  }
  return undefined
}

/**
 * 剥离 UTF-8 前导 BOM 字符（\uFEFF）。
 *
 * @param {unknown} val
 * @returns {unknown}
 */
export function stripBom(val) {
  if (typeof val === 'string' && val.charCodeAt(0) === 0xFEFF) {
    return val.slice(1)
  }
  return val
}

/**
 * 安全读取 JSON 配置文件。
 *
 * @param {string} filePath
 * @returns {Record<string, any>}
 */
export function readConfigFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {}
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(stripBom(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err) {
    console.warn(`[wolfpack] 配置文件读取失败 (${filePath}):`, err?.message || err)
    return {}
  }
}

/**
 * 解析超时/数字限额：0 / 'off' / 'none' / 非正数转换为 0（代表无限制）。
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function parseTimeoutMs(value, fallback = 0) {
  if (value === undefined || value === null) return fallback
  const str = String(value).trim().toLowerCase()
  if (str === 'off' || str === 'none' || str === '0') return 0
  const n = Number(str)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * 加载并合并配置：
 * 优先级：overrides > 环境变量 > wolfpack.config.json > 平台默认
 *
 * @param {Record<string, any>} [overrides]
 * @param {string} [cwd]
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, any>}
 */
export function loadConfig(overrides = {}, cwd = process.cwd(), env = process.env) {
  const configPath = env.WOLFPACK_CONFIG_FILE || findConfigFile(cwd)
  const fileConfig = configPath ? readConfigFile(configPath) : {}

  const merged = { ...fileConfig, ...overrides }

  // 1. agyPath / workerPath
  const defaultWorkerBin = process.platform === 'win32' ? 'agy.exe' : 'agy'
  const agyPathRaw = env.WOLFPACK_AGY || merged.agyPath || merged.workerPath || defaultWorkerBin
  const agyPath = resolveHome(agyPathRaw)

  // 2. worker 名称与自动选择策略
  // 默认 'auto'（全自动）：装了谁就用谁；agy 与 claude 都在时自动轮流派活。
  // 显式填 'agy' / 'claude' 则固定用该工人（该工人不可用时自动回退到可用的那一个）。
  const worker = env.WOLFPACK_WORKER || merged.worker || 'auto'

  // 2.1 claude 工人路径与专属配置（与 agy 对称）
  const defaultClaudeBin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const claudePath = resolveHome(env.WOLFPACK_CLAUDE || merged.claudePath || defaultClaudeBin)
  const claudeModel = env.WOLFPACK_CLAUDE_MODEL ?? merged.claudeModel ?? undefined
  const claudePermissionMode = env.WOLFPACK_CLAUDE_PERMISSION_MODE || merged.claudePermissionMode || undefined
  const claudeAgents = env.WOLFPACK_CLAUDE_AGENTS ?? merged.claudeAgents ?? undefined

  // 3. 执行模式
  const mode = env.WOLFPACK_MODE || merged.mode || 'accept-edits'

  // 4. 模型与推理深度
  const model = env.WOLFPACK_MODEL ?? merged.model ?? undefined
  const effort = env.WOLFPACK_EFFORT ?? merged.effort ?? undefined

  // 5. 台账路径
  const defaultLedger = join(homedir(), '.wolfpack', 'runs.ndjson')
  const ledgerPathRaw = env.WOLFPACK_LEDGER || merged.ledgerPath || defaultLedger
  const ledgerPath = resolveHome(ledgerPathRaw)

  // 6. 原始 JSON 落盘目录
  const defaultRawDir = join(homedir(), '.wolfpack', 'raw')
  const rawDirRaw = env.WOLFPACK_RAW_DIR || merged.rawDir || defaultRawDir
  const rawDir = resolveHome(rawDirRaw)

  // 7. 超时设定（0 = 不设上限）
  const taskTimeoutRaw = env.WOLFPACK_TASK_TIMEOUT ?? merged.taskTimeoutMs ?? 0
  const taskTimeoutMs = parseTimeoutMs(taskTimeoutRaw, 0)

  // 8. 验收超时设定（默认 5 分钟）
  const verifyTimeoutRaw = env.WOLFPACK_VERIFY_TIMEOUT ?? merged.verifyTimeoutMs ?? 300_000
  const verifyTimeoutMs = parseTimeoutMs(verifyTimeoutRaw, 300_000)

  // 9. 续跑策略
  const continuation = env.WOLFPACK_CONTINUATION ?? merged.continuation ?? undefined

  // 10. 累计 token 预算（默认 1,000,000）
  const budgetRaw = env.WOLFPACK_TOKEN_BUDGET ?? merged.continuationTokenBudget ?? 1_000_000
  let continuationTokenBudget = undefined
  if (budgetRaw !== undefined && budgetRaw !== null) {
    const s = String(budgetRaw).trim().toLowerCase()
    if (s !== 'off' && s !== 'none' && s !== '0') {
      const n = Number(s)
      if (Number.isFinite(n) && n > 0) continuationTokenBudget = Math.floor(n)
    }
  }

  // 11. 硬轮数上限（仅显式配置才生效）
  const maxRoundsRaw = env.WOLFPACK_MAX_ROUNDS ?? merged.maxRoundsPerTask ?? undefined
  let maxRoundsPerTask = undefined
  if (maxRoundsRaw !== undefined && maxRoundsRaw !== null) {
    const s = String(maxRoundsRaw).trim().toLowerCase()
    if (s !== 'off' && s !== 'none' && s !== '0') {
      const n = Number(s)
      if (Number.isFinite(n) && n > 0) maxRoundsPerTask = Math.floor(n)
    }
  }

  // 12. 用量未知轮数兜底（默认 20 轮）
  const unknownCapRaw = env.WOLFPACK_UNKNOWN_USAGE_CAP ?? merged.unknownUsageRoundCap ?? 20
  let unknownUsageRoundCap = 20
  if (unknownCapRaw !== undefined && unknownCapRaw !== null) {
    const s = String(unknownCapRaw).trim().toLowerCase()
    if (s === 'off' || s === 'none' || s === '0') {
      unknownUsageRoundCap = 0
    } else {
      const n = Number(s)
      if (Number.isFinite(n) && n > 0) unknownUsageRoundCap = Math.floor(n)
    }
  }

  // 13. 自定义 shell
  const shell = env.WOLFPACK_SHELL ?? merged.shell ?? undefined

  // 14. 并发小队默认并发数
  const concurrencyRaw = env.WOLFPACK_CONCURRENCY ?? merged.concurrency ?? 2
  const concurrencyNum = Number(concurrencyRaw)
  const concurrency = Number.isInteger(concurrencyNum) && concurrencyNum >= 1 && concurrencyNum <= 4
    ? concurrencyNum
    : 2

  // 15. 台账管理参数
  const maxEntries = Number(env.WOLFPACK_LEDGER_MAX_ENTRIES ?? merged.maxEntries ?? 5000) || 5000
  const maxBytes = Number(env.WOLFPACK_LEDGER_MAX_BYTES ?? merged.maxBytes ?? 10 * 1024 * 1024) || 10 * 1024 * 1024
  const keepRounds = Number(env.WOLFPACK_LEDGER_KEEP_ROUNDS ?? merged.keepRounds ?? 10) || 10

  // 16. 停滞监控：**每个工人各一套**（agy 看自己的 brain/conversations，claude 看 ~/.claude/projects）
  const stall = resolveStallConfigs({ env, config: merged })
  const defaultStallLog = join(dirname(ledgerPath), 'stall.ndjson')
  const stallLogPath = resolveHome(env.WOLFPACK_STALL_LOG || merged.stallLogPath || defaultStallLog)
  const stallToast = stallToastEnabled(env, merged)

  // 17. 实时面板（只读 HTTP，默认只监听回环地址）
  const panelPortRaw = Number(env.WOLFPACK_PANEL_PORT ?? merged.panelPort ?? 8787)
  const panelPort = Number.isInteger(panelPortRaw) && panelPortRaw > 0 && panelPortRaw < 65536 ? panelPortRaw : 8787
  const panelHost = env.WOLFPACK_PANEL_HOST || merged.panelHost || '127.0.0.1'
  const panelToken = env.WOLFPACK_PANEL_TOKEN || merged.panelToken || undefined
  const panelRefreshRaw = Number(env.WOLFPACK_PANEL_REFRESH ?? merged.panelRefreshMs ?? 3000)
  const panelRefreshMs = Number.isFinite(panelRefreshRaw) && panelRefreshRaw >= 500 ? Math.floor(panelRefreshRaw) : 3000

  return {
    agyPath,
    worker,
    claudePath,
    claudeModel,
    claudePermissionMode,
    claudeAgents,
    mode,
    model,
    effort,
    ledgerPath,
    rawDir,
    taskTimeoutMs,
    verifyTimeoutMs,
    continuation,
    continuationTokenBudget,
    maxRoundsPerTask,
    unknownUsageRoundCap,
    shell,
    concurrency,
    maxEntries,
    maxBytes,
    keepRounds,
    stall,
    stallLogPath,
    stallToast,
    panel: {
      port: panelPort,
      host: panelHost,
      token: panelToken,
      refreshMs: panelRefreshMs,
    },
    graceMs: 5_000,
    configPath,
  }
}
