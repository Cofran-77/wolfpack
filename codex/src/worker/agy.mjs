import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { matchCapacity } from './faults.mjs'

/** 默认输出 JSON Schema 约束 */
export const DEFAULT_AGY_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '任务执行自述与简要说明',
    },
    claimed_files: {
      type: 'array',
      items: { type: 'string' },
      description: '本轮声称修改、新增或删除的文件相对路径列表',
    },
    modified_files: {
      type: 'array',
      items: { type: 'string' },
      description: '本轮修改或新增的文件相对路径列表（同 claimed_files）',
    },
  },
  required: ['summary'],
}

/**
 * 规范化相对文件路径（统一正斜杠、剥离前导 ./）。
 *
 * @param {unknown} p
 * @param {string} [cwd]
 * @returns {string}
 */
export function normalizeRelPath(p, cwd) {
  let s = String(p ?? '').trim().replace(/\\/g, '/')
  if (typeof cwd === 'string' && cwd !== '') {
    const normCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '')
    if (s.toLowerCase().startsWith(normCwd.toLowerCase() + '/')) {
      s = s.slice(normCwd.length + 1)
    }
  }
  return s.replace(/^\.\//, '')
}

/**
 * 判定是否为 agy 服务端容量不足（503 No capacity available）。
 *
 * @param {object|undefined} parsed
 * @param {string} [raw]
 * @param {string} [stderr]
 * @returns {boolean}
 */
export function isCapacityError(parsed, raw, stderr) {
  const texts = []
  if (typeof parsed?.error === 'string') texts.push(parsed.error)
  if (typeof parsed?.response === 'string') texts.push(parsed.response)
  if (typeof stderr === 'string') texts.push(stderr)
  return matchCapacity({ texts, raw })
}

/**
 * 从 JSON 解析出结构化输出对象。
 *
 * @param {Record<string, any>} [parsed]
 * @returns {{ summary?: string, claimedFiles?: string[], raw?: unknown } | undefined}
 */
export function parseStructuredReport(parsed) {
  if (!parsed || typeof parsed !== 'object') return undefined

  let candidate = undefined
  if (parsed.structured_output && typeof parsed.structured_output === 'object' && !Array.isArray(parsed.structured_output)) {
    candidate = parsed.structured_output
  } else if (parsed.structured && typeof parsed.structured === 'object' && !Array.isArray(parsed.structured)) {
    candidate = parsed.structured
  }

  if (!candidate) return undefined

  const summary = typeof candidate.summary === 'string'
    ? candidate.summary.trim()
    : (typeof candidate.report === 'string'
      ? candidate.report.trim()
      : (typeof candidate.answer === 'string' ? candidate.answer.trim() : undefined))

  const rawList = Array.isArray(candidate.claimed_files)
    ? candidate.claimed_files
    : (Array.isArray(candidate.claimedFiles)
      ? candidate.claimedFiles
      : (Array.isArray(candidate.modified_files)
        ? candidate.modified_files
        : (Array.isArray(candidate.modifiedFiles)
          ? candidate.modifiedFiles
          : (Array.isArray(candidate.filesChanged)
            ? candidate.filesChanged
            : (Array.isArray(candidate.files) ? candidate.files : undefined)))))

  const claimedFiles = Array.isArray(rawList)
    ? rawList.filter(f => typeof f === 'string' && f.trim() !== '').map(f => normalizeRelPath(f))
    : undefined

  if (summary === undefined && claimedFiles === undefined) return undefined

  return {
    summary,
    claimedFiles,
    raw: candidate,
  }
}

/**
 * agy 工人适配器契约对象。
 */
export const agyWorker = {
  name: 'agy',

  /**
   * 预检 agy 命令可用性。
   *
   * @param {object} cfg
   * @returns {{ ok: boolean, path: string, reason?: string }}
   */
  preflight(cfg) {
    const agyPath = cfg?.agyPath
    if (!agyPath || typeof agyPath !== 'string' || agyPath.trim() === '') {
      return { ok: false, path: '', reason: 'agy 路径为空' }
    }
    // 绝对路径直接探测存在性，命令名（如 agy）默认放行交由 spawn 探测
    if (isAbsolute(agyPath)) {
      const exists = existsSync(agyPath)
      return exists
        ? { ok: true, path: agyPath }
        : { ok: false, path: agyPath, reason: `agy 可执行文件不存在：${agyPath}` }
    }
    return { ok: true, path: agyPath }
  },

  /**
   * 拼装 agy 命令行参数数组。
   * 铁律：续跑只用 --conversation <id>，绝不用 -c。
   *
   * @param {object} cfg
   * @param {object} params
   * @param {string} params.task
   * @param {string} [params.sessionId]
   * @param {number} [params.timeoutMs]
   * @returns {string[]}
   */
  buildArgv(cfg, { task, sessionId, timeoutMs = 0 }) {
    const bin = Array.isArray(cfg.agyPath)
      ? cfg.agyPath
      : (typeof cfg.agyPath === 'string' && (cfg.agyPath.endsWith('.mjs') || cfg.agyPath.endsWith('.js'))
          ? [process.execPath, cfg.agyPath]
          : [cfg.agyPath])

    const argv = [
      ...bin,
      '-p', task,
      '--output-format', 'json',
      '--mode', cfg.mode || 'accept-edits',
    ]

    if (cfg.model) argv.push('--model', cfg.model)
    if (cfg.effort) argv.push('--effort', cfg.effort)
    if (sessionId) argv.push('--conversation', sessionId)

    const deadlineMs = timeoutMs > 0 ? timeoutMs : (24 * 60 * 60 * 1000)
    argv.push('--print-timeout', `${Math.ceil(deadlineMs / 1000) + 60}s`)
    argv.push('--dangerously-skip-permissions')

    const schema = cfg.jsonSchema ?? DEFAULT_AGY_SCHEMA
    if (schema !== false) {
      argv.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema))
    }

    return argv
  },

  /**
   * 从 stdout 中提取会话 ID。
   *
   * @param {string} stdout
   * @returns {string|undefined}
   */
  extractSessionId(stdout) {
    try {
      const parsed = JSON.parse(stdout)
      const id = parsed?.conversation_id
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
    } catch {
      return undefined
    }
  },

  /**
   * 解析 agy 输出的 JSON。
   *
   * @param {string} stdout
   * @returns {Record<string, any>|undefined}
   */
  parse(stdout) {
    try {
      const parsed = JSON.parse(stdout)
      if (!parsed || typeof parsed !== 'object') return undefined

      const structured = parseStructuredReport(parsed)
      const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : {}

      return {
        conversationId: parsed.conversation_id,
        status: parsed.status,
        error: parsed.error,
        response: parsed.response,
        durationSeconds: parsed.duration_seconds,
        numTurns: parsed.num_turns,
        usage: {
          total: num(usage.total_tokens),
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          thinking: num(usage.thinking_tokens),
          cacheRead: num(usage.cache_read_tokens),
          turns: num(parsed.num_turns),
        },
        structuredOutput: parsed.structured_output,
        structuredReport: structured,
      }
    } catch {
      return undefined
    }
  },

  /**
   * 判定政策分类：
   * 1. 取消/超时 -> aborted
   * 2. 503 容量饱和 -> capacity (capacity: true)
   * 3. 产物存在即完成 -> completed (即便 status: ERROR / exitCode != 0)
   * 4. status: SUCCESS 且 exitCode: 0 -> completed
   * 5. 其余 -> error
   *
   * @param {object} params
   * @param {Record<string, any>} [params.parsed]
   * @param {number | null} params.exitCode
   * @param {{ changed: boolean, summary: string, files?: string[], determined?: boolean }} params.artifacts
   * @param {boolean} [params.timedOut]
   * @param {boolean} [params.cancelled]
   * @param {string | null} [params.signal]
   * @param {string} [params.raw]
   * @param {string} [params.stderr]
   * @returns {{ stopReason: string, capacity?: boolean, diagnostic?: string }}
   */
  classify({ parsed, exitCode, artifacts, timedOut, cancelled, raw, stderr }) {
    if (cancelled || timedOut) {
      return {
        stopReason: 'aborted',
        diagnostic: timedOut ? 'agy 超时，已终止进程树' : '委派被取消',
      }
    }

    if (isCapacityError(parsed, raw, stderr)) {
      return {
        stopReason: 'capacity',
        capacity: true,
        diagnostic: `agy 报服务端容量不足（No capacity available）：${parsed?.error || '服务端暂无可用容量'}`,
      }
    }

    // 核心铁律：产物存在即完成（即使自报 ERROR 或退出码非零）
    if (artifacts?.changed && (parsed?.status !== 'SUCCESS' || exitCode !== 0)) {
      return {
        stopReason: 'completed',
        diagnostic: `agy 自报 ${parsed?.status ?? `exit ${exitCode}`}，但检测到磁盘产物：${artifacts.summary}`,
      }
    }

    if (parsed?.status === 'SUCCESS' && exitCode === 0) {
      return {
        stopReason: 'completed',
        diagnostic: undefined,
      }
    }

    return {
      stopReason: 'error',
      diagnostic: `agy ${parsed?.status ?? `exit ${exitCode}`}: ${parsed?.error || '无错误详情'}`,
    }
  },

  /**
   * 停滞监控心跳探针。
   * 若无可靠心跳则返回 undefined，跳过停滞监控，绝不编造。
   *
   * @param {object} cfg
   * @param {object} params
   * @param {string} [params.sessionId]
   * @param {string} [params.cwd]
   * @returns {undefined}
   */
  progressProbe(_cfg, _params) {
    return undefined
  },
}
