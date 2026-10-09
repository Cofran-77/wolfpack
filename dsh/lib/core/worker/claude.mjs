import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

// 工人输出契约与 agy 完全一致（structured_output.summary / claimed_files，字段名经实测确认），
// 因此复用同一份解析器，避免两份实现漂移。
import { parseStructuredReport, reconcileClaimedArtifacts, truncateChars, DIGEST_MAX_CHARS } from './agy.mjs'
import { CAPACITY_STATUS, matchCapacity } from './faults.mjs'

/** 默认输出 JSON Schema 约束（与 agy 同形状：summary + claimed_files） */
export const DEFAULT_CLAUDE_SCHEMA = {
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
 * 视为「服务端容量不足」的 API 状态码（含中转池子额度耗尽的 402）。
 * 保留旧名以免外部引用失效，实际判定统一走 faults.mjs 的共享规则。
 */
export const CLAUDE_CAPACITY_STATUS = CAPACITY_STATUS

/**
 * 判定 claude 是否报服务端容量不足（429/503/529 或对应文案）。
 *
 * @param {Record<string, any>} [parsed]
 * @param {string} [stderr]
 * @returns {boolean}
 */
export function isClaudeCapacityError(parsed, stderr) {
  const status = parsed?.api_error_status
  const probes = []
  if (typeof parsed?.error === 'string') probes.push(parsed.error)
  if (typeof parsed?.result === 'string') probes.push(parsed.result.slice(0, 500))
  if (typeof stderr === 'string') probes.push(stderr.slice(0, 2000))

  return matchCapacity({ status: typeof status === 'number' ? status : undefined, texts: probes })
}

/**
 * 把 wolfpack 的 mode 词表映射到 claude 的 permission-mode 取值。
 * 未知取值原样透传，交给 claude 自己报错。
 *
 * @param {unknown} mode
 * @returns {string|undefined}
 */
export function mapPermissionMode(mode) {
  if (typeof mode !== 'string' || mode.trim() === '') return undefined
  const key = mode.trim().toLowerCase()
  const aliases = {
    'accept-edits': 'acceptEdits',
    acceptedits: 'acceptEdits',
    plan: 'plan',
    manual: 'manual',
    auto: 'auto',
    dontask: 'dontAsk',
    bypasspermissions: 'bypassPermissions',
  }
  return aliases[key] ?? mode.trim()
}

/**
 * Claude Code CLI 工人适配器契约对象。
 */
export const claudeWorker = {
  name: 'claude',

  /**
   * 预检 claude 命令可用性。
   *
   * @param {object} cfg
   * @returns {{ ok: boolean, path: string, reason?: string }}
   */
  preflight(cfg) {
    const claudePath = cfg?.claudePath
    if (!claudePath || typeof claudePath !== 'string' || claudePath.trim() === '') {
      return { ok: false, path: '', reason: 'claude 路径为空' }
    }
    if (isAbsolute(claudePath)) {
      const exists = existsSync(claudePath)
      return exists
        ? { ok: true, path: claudePath }
        : { ok: false, path: claudePath, reason: `claude 可执行文件不存在：${claudePath}` }
    }
    return { ok: true, path: claudePath }
  },

  /**
   * 拼装 claude 命令行参数数组。
   * 铁律：续跑只用 --resume <session_id>，绝不用 -c / --continue。
   * 子智能体：默认不传任何工具限制参数（--tools / --allowedTools / --disallowedTools），
   * 工人自带子智能体因此保持可用。
   *
   * @param {object} cfg
   * @param {object} params
   * @param {string} params.task
   * @param {string} [params.sessionId]
   * @param {number} [params.timeoutMs]
   * @returns {string[]}
   */
  buildArgv(cfg, { task, sessionId, timeoutMs } = {}) {
    const bin = Array.isArray(cfg.claudePath)
      ? cfg.claudePath
      : (typeof cfg.claudePath === 'string' && (cfg.claudePath.endsWith('.mjs') || cfg.claudePath.endsWith('.js'))
          ? [process.execPath, cfg.claudePath]
          : [cfg.claudePath])

    const argv = [
      ...bin,
      '-p', task,
      '--output-format', 'json',
    ]

    const model = cfg.claudeModel ?? cfg.model
    if (model) argv.push('--model', model)
    if (cfg.effort) argv.push('--effort', cfg.effort)
    if (sessionId) argv.push('--resume', sessionId)

    // 默认与 agy 对齐（绕过权限提示，否则工人无法改文件、跑测试）；
    // 显式配置 permission mode 时改用 --permission-mode。
    const permissionMode = mapPermissionMode(cfg.claudePermissionMode)
    if (permissionMode) {
      argv.push('--permission-mode', permissionMode)
    } else {
      argv.push('--dangerously-skip-permissions')
    }

    const schema = cfg.jsonSchema ?? DEFAULT_CLAUDE_SCHEMA
    if (schema !== false) {
      argv.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema))
    }

    // 可选：把自定义子智能体定义透传给 claude（--agents <json>）
    if (cfg.claudeAgents !== undefined && cfg.claudeAgents !== null && cfg.claudeAgents !== '') {
      argv.push('--agents', typeof cfg.claudeAgents === 'string' ? cfg.claudeAgents : JSON.stringify(cfg.claudeAgents))
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
      const id = parsed?.session_id
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
    } catch {
      return undefined
    }
  },

  /**
   * 解析 claude 输出的 JSON 信封。
   *
   * @param {string} stdout
   * @returns {Record<string, any>|undefined}
   */
  parse(stdout) {
    try {
      const parsed = JSON.parse(stdout)
      if (!parsed || typeof parsed !== 'object') return undefined

      const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : {}
      const input = num(usage.input_tokens)
      const output = num(usage.output_tokens)
      const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : undefined
      const isError = parsed.is_error === true
      const stats = parsed.subagent_stats && typeof parsed.subagent_stats === 'object'
        ? parsed.subagent_stats
        : undefined

      const apiStatus = num(parsed.api_error_status)
      const errorText = typeof parsed.result === 'string' && parsed.result !== ''
        ? parsed.result
        : (subtype ?? '未知错误')

      return {
        conversationId: typeof parsed.session_id === 'string' && parsed.session_id !== ''
          ? parsed.session_id
          : undefined,
        status: isError ? 'ERROR' : (subtype === 'success' ? 'SUCCESS' : subtype),
        error: isError
          ? (apiStatus !== undefined ? `API ${apiStatus}: ${errorText}` : errorText)
          : undefined,
        response: typeof parsed.result === 'string' ? parsed.result : undefined,
        durationSeconds: num(parsed.duration_ms) !== undefined ? parsed.duration_ms / 1000 : undefined,
        numTurns: num(parsed.num_turns),
        usage: {
          total: (input ?? 0) + (output ?? 0),
          input,
          output,
          thinking: num(usage.output_tokens_details?.thinking_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
          cacheCreation: num(usage.cache_creation_input_tokens),
          turns: num(parsed.num_turns),
        },
        structuredOutput: parsed.structured_output,
        structuredReport: parseStructuredReport(parsed),
        costUsd: num(parsed.total_cost_usd),
        apiStatus,
        permissionDenials: Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : undefined,
        subagents: stats
          ? { spawned: num(stats.spawned) ?? 0, maxDepth: num(stats.max_depth) }
          : undefined,
      }
    } catch {
      return undefined
    }
  },

  /**
   * 判定政策分类（与 agy 同一套铁律）：
   * 1. 取消/超时 -> aborted
   * 2. 429/503/529 容量不足 -> capacity
   * 3. 产物存在即完成 -> completed（即便 is_error / 退出码非零）
   * 4. is_error=false 且 exitCode=0 -> completed
   * 5. 其余 -> error
   *
   * @param {object} params
   * @returns {{ stopReason: string, capacity?: boolean, diagnostic?: string, report?: string, output?: Array<{type: string, text: string}>, structured?: unknown, claimedFiles?: string[], reconciliation?: object, rawParsed?: object }}
   */
  classify({ parsed, exitCode, artifacts, timedOut, cancelled, signal, raw, stderr }) {
    const structured = parsed?.structuredReport
    const claimedFiles = structured?.claimedFiles
    const root = artifacts?.root ?? artifacts?.cwd
    const reconciliation = reconcileClaimedArtifacts(claimedFiles, artifacts, root)

    const bodyText = structured?.summary || parsed?.response || ''
    const digest = bodyText === '' ? [] : [{ type: 'text', text: truncateChars(bodyText, DIGEST_MAX_CHARS) }]

    if (cancelled || timedOut) {
      return {
        output: digest,
        stopReason: 'aborted',
        diagnostic: timedOut ? 'claude 超时，已终止进程树' : '委派被取消',
        structured: structured?.raw ?? structured,
        claimedFiles,
        reconciliation,
        report: bodyText,
        rawParsed: parsed,
      }
    }

    if (isClaudeCapacityError(parsed, stderr)) {
      return {
        output: digest,
        stopReason: 'capacity',
        capacity: true,
        diagnostic: `claude 报服务端容量不足：${parsed?.error || '服务端暂无可用容量'}`,
        structured: structured?.raw ?? structured,
        claimedFiles,
        reconciliation,
        report: bodyText,
        rawParsed: parsed,
      }
    }

    // 核心铁律：产物存在即完成（即使自报失败或退出码非零）
    if (artifacts?.changed && (parsed?.status !== 'SUCCESS' || exitCode !== 0)) {
      return {
        output: digest,
        stopReason: 'completed',
        diagnostic: `claude 自报 ${parsed?.status ?? `exit ${exitCode}`}，但检测到磁盘产物：${artifacts.summary}`,
        structured: structured?.raw ?? structured,
        claimedFiles,
        reconciliation,
        report: bodyText,
        rawParsed: parsed,
      }
    }

    if (parsed?.status === 'SUCCESS' && exitCode === 0) {
      return {
        output: digest,
        stopReason: 'completed',
        diagnostic: undefined,
        structured: structured?.raw ?? structured,
        claimedFiles,
        reconciliation,
        report: bodyText,
        rawParsed: parsed,
      }
    }

    return {
      output: digest,
      stopReason: 'error',
      diagnostic: `claude ${parsed?.status ?? `exit ${exitCode}`}: ${parsed?.error || '无错误详情'}`,
      structured: structured?.raw ?? structured,
      claimedFiles,
      reconciliation,
      report: bodyText,
      rawParsed: parsed,
    }
  },

  /**
   * 停滞监控心跳探针：claude 无可靠外部心跳源，返回 undefined（跳过监控，绝不编造）。
   *
   * @returns {undefined}
   */
  progressProbe() {
    return undefined
  },
}
