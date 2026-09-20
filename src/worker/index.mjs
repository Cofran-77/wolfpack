import { isAbsolute } from 'node:path'

import { findInPath } from '../verify.mjs'
import { agyWorker } from './agy.mjs'
import { claudeWorker } from './claude.mjs'

/** 「全自动」标记：不指定具体工人时，装了谁就用谁；两个都装则轮流派活 */
export const AUTO_WORKER = 'auto'

/** 与 auto 等价的写法 */
const AUTO_ALIASES = new Set(['auto', 'rotate', 'rotation', 'both', 'any'])

/** 各工人可执行文件所在的配置键 */
const WORKER_PATH_KEYS = { agy: 'agyPath', claude: 'claudePath' }

/**
 * 进程内轮换游标。
 * 两个工人同时可用时交替派活，避免「装了 claude 也永远只派给 agy」。
 */
let rotationCursor = 0

const registry = new Map([
  [agyWorker.name, agyWorker],
  [claudeWorker.name, claudeWorker],
])

/**
 * 注册工人适配器。
 *
 * @param {object} worker
 */
export function registerWorker(worker) {
  if (!worker || typeof worker.name !== 'string') {
    throw new Error('[wolfpack/worker] 工人适配器必须包含有效的 name')
  }
  registry.set(worker.name, worker)
}

/**
 * 获取指定名称的工人适配器。
 *
 * @param {string} [name='agy']
 * @returns {typeof agyWorker}
 */
export function getWorker(name = 'agy') {
  const worker = registry.get(name)
  if (!worker) {
    const known = [...registry.keys()].join(', ')
    throw new Error(`[wolfpack/worker] 未找到名为 "${name}" 的工人适配器（已注册：${known}）`)
  }
  return worker
}

/**
 * 列出全部已注册的工人适配器。
 *
 * @returns {Array<object>}
 */
export function listWorkers() {
  return [...registry.values()]
}

/**
 * 读取某工人配置的可执行文件路径。
 *
 * @param {string} name
 * @param {object} [config]
 * @returns {string|string[]|undefined}
 */
export function workerPathOf(name, config) {
  const key = WORKER_PATH_KEYS[name]
  return key ? config?.[key] : undefined
}

/**
 * 规范化配置里的工人偏好。
 * 空值、null 与 auto 系列写法都视为「全自动」，返回 undefined。
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function normalizeWorkerPreference(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '' || AUTO_ALIASES.has(trimmed)) return undefined
  return trimmed
}

/**
 * 判定某工人当前是否真的可用（装了、且路径能解析到）。
 * 绝对路径与带分隔符的相对路径：直接探测存在性，绝不拿它去搜 PATH；
 * 裸命令名（如 agy / claude）：按 PATH 搜索，找不到即视为没装。
 *
 * @param {string} name
 * @param {object} [config]
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {Function} [options.find] - 注入 PATH 查找实现（便于测试）
 * @returns {boolean}
 */
export function isWorkerAvailable(name, config, { env = process.env, find = findInPath } = {}) {
  const worker = registry.get(name)
  if (!worker || typeof worker.preflight !== 'function') return false

  const probe = worker.preflight(config)
  if (probe?.ok !== true) return false

  const raw = workerPathOf(name, config)
  if (Array.isArray(raw)) return true
  if (typeof raw !== 'string' || raw.trim() === '') return false

  const target = raw.trim()
  // 绝对路径与带分隔符的相对路径已由 preflight 探过存在性
  if (isAbsolute(target) || target.includes('/') || target.includes('\\')) return true

  const hit = find(target, env)
  return typeof hit === 'string' && hit !== ''
}

/**
 * 全自动挑选本轮执行工人（过程无需、也绝不询问用户）。
 *
 * 规则（自上而下，命中即返回）：
 * 1. 一个都没装 → 抛可读错误（绝不静默假装跑过）；
 * 2. 配置里显式点名工人 → 用它；若它不可用则回退到可用工人，并如实标注 fallback；
 * 3. 只装了一个 → 用它（only-available）；
 * 4. 同一 task_id 上一轮用过且仍可用 → 沿用（continuation，会话 ID 只在各自 CLI 内有效）；
 * 5. 两个都装 → 轮流派活（rotation），让 agy 与 claude 都真正承担执行。
 *
 * @param {object} params
 * @param {object} [params.config]
 * @param {string} [params.previousWorker] - 同一 task_id 上一轮的工人
 * @param {Record<string, string|undefined>} [params.env]
 * @param {Function} [params.find]
 * @returns {{ name: string, reason: string }}
 */
export function resolveWorkerSelection({ config, previousWorker, env = process.env, find = findInPath } = {}) {
  const known = [...registry.keys()]
  const eligible = listWorkers().filter(w => isWorkerAvailable(w.name, config, { env, find }))

  if (eligible.length === 0) {
    throw new Error(
      `[wolfpack/worker] 没有可用的工人 CLI（已注册：${known.join(', ')}）。`
      + '请至少安装并登录一个工人：Antigravity CLI（agy）或 Claude Code CLI（claude）；'
      + '也可用 WOLFPACK_AGY / WOLFPACK_CLAUDE 指定可执行文件路径。',
    )
  }

  const prefer = normalizeWorkerPreference(config?.worker)
  if (prefer !== undefined && !registry.has(prefer)) {
    throw new Error(
      `[wolfpack/worker] 未知工人 "${prefer}"（可选：${known.join(', ')}，或 ${AUTO_WORKER}）`,
    )
  }

  if (prefer !== undefined) {
    if (eligible.some(w => w.name === prefer)) return { name: prefer, reason: 'explicit' }
    const fallback = eligible[rotationCursor++ % eligible.length]
    return { name: fallback.name, reason: `fallback(${prefer}-unavailable)` }
  }

  if (eligible.length === 1) return { name: eligible[0].name, reason: 'only-available' }

  if (typeof previousWorker === 'string' && eligible.some(w => w.name === previousWorker)) {
    return { name: previousWorker, reason: 'continuation' }
  }

  const pick = eligible[rotationCursor++ % eligible.length]
  return { name: pick.name, reason: 'rotation' }
}

export { agyWorker, claudeWorker }
