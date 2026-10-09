import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 默认任务超时时间（0 = 不设上限，仅受配额约束）。 */
export const DEFAULT_TASK_TIMEOUT_MS = 0

/** agy 进程 print-timeout 上限（24 小时）。 */
export const DEFAULT_AGY_PRINT_TIMEOUT_MS = 24 * 60 * 60 * 1000

export const MAX_STDOUT_BYTES = 8 * 1024 * 1024
export const MAX_SPILL_BYTES = 256 * 1024 * 1024
export const MAX_STDERR_BYTES = 64 * 1024

/** 队员自述摘要字符数上限。 */
export const DIGEST_MAX_CHARS = 4000

/** 诊断字段字节数上限。 */
export const DIAGNOSTIC_MAX_BYTES = 500

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
 * 判定文件是否逃逸出工作区根。
 *
 * @param {string} filePath
 * @param {string} root
 * @returns {boolean}
 */
export function isPathOutsideRoot(filePath, root) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return false
  const normalized = filePath.replace(/\\/g, '/')

  // 1. 显式相对路径逃逸
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    return true
  }

  // 2. 若未提供 root，但路径是绝对路径（如 D:/... 或 /...）
  if (typeof root !== 'string' || root.trim() === '') {
    if (isAbsolute(filePath) || /^[a-zA-Z]:[\\/]/.test(filePath)) {
      return true
    }
    return false
  }

  const normRoot = root.replace(/\\/g, '/')

  // 3. Windows 跨盘符判定（如 C: 探测 D:）
  const fileDriveMatch = normalized.match(/^([a-zA-Z]):/)
  const rootDriveMatch = normRoot.match(/^([a-zA-Z]):/)
  if (fileDriveMatch && rootDriveMatch) {
    if (fileDriveMatch[1].toLowerCase() !== rootDriveMatch[1].toLowerCase()) {
      return true
    }
  }

  try {
    const resolvedRoot = resolve(root)
    const resolvedTarget = resolve(root, filePath)
    const rel = relative(resolvedRoot, resolvedTarget)

    if (isAbsolute(rel)) return true
    if (rel.startsWith('..') || rel === '..') return true
    return false
  } catch {
    return true
  }
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
  const pattern = /no capacity available/i
  if (typeof parsed?.error === 'string' && pattern.test(parsed.error)) return true
  if (typeof parsed?.response === 'string' && pattern.test(parsed.response)) return true
  if (typeof raw === 'string' && pattern.test(raw)) return true
  if (typeof stderr === 'string' && pattern.test(stderr)) return true
  return false
}

/**
 * 机械对账：声称改动与磁盘改动对账。
 *
 * @param {string[]|undefined} claimedFiles
 * @param {{determined: boolean, changed: boolean, summary: string, files?: string[], root?: string, cwd?: string}|undefined} artifacts
 * @param {string|{cwd?: string, root?: string}} [rootOrOptions]
 * @returns {{status: 'matched'|'mismatch'|'undetermined', findings: string[], outsideFiles?: string[]}|undefined}
 */
export function reconcileClaimedArtifacts(claimedFiles, artifacts, rootOrOptions) {
  if (!Array.isArray(claimedFiles)) return undefined

  const root = typeof rootOrOptions === 'string'
    ? rootOrOptions
    : (rootOrOptions?.cwd ?? rootOrOptions?.root ?? artifacts?.root ?? artifacts?.cwd)

  // 1. 检查声称的文件是否落在被探测的根之外
  const outsideFiles = []
  for (const f of claimedFiles) {
    if (isPathOutsideRoot(f, root)) {
      outsideFiles.push(f)
    }
  }

  if (outsideFiles.length > 0) {
    return {
      status: 'undetermined',
      findings: [`声称的文件不在被探测的工作区内，无法对账：${outsideFiles.slice(0, 5).join(', ')}${outsideFiles.length > 5 ? '等' : ''}`],
      outsideFiles,
    }
  }

  if (artifacts?.determined === false) {
    return {
      status: 'undetermined',
      findings: ['磁盘改动无法判定，声称改动未完成机械对账'],
    }
  }

  const actualFiles = Array.isArray(artifacts?.files) ? artifacts.files : []
  const normKey = f => normalizeRelPath(f, root).toLowerCase()

  const actualMap = new Map()
  for (const f of actualFiles) {
    actualMap.set(normKey(f), normalizeRelPath(f, root))
  }

  const claimedMap = new Map()
  for (const f of claimedFiles) {
    claimedMap.set(normKey(f), normalizeRelPath(f, root))
  }

  const missing = []
  for (const [k, raw] of claimedMap) {
    if (!actualMap.has(k)) missing.push(raw)
  }
  const unexpected = []
  for (const [k, raw] of actualMap) {
    if (!claimedMap.has(k)) unexpected.push(raw)
  }

  if (missing.length === 0 && unexpected.length === 0) {
    return {
      status: 'matched',
      findings: [],
    }
  }

  const findings = []
  if (missing.length > 0) {
    findings.push(`声称改动但磁盘未动：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '等' : ''}`)
  }
  if (unexpected.length > 0) {
    findings.push(`磁盘实际改动但队员未声称：${unexpected.slice(0, 5).join(', ')}${unexpected.length > 5 ? '等' : ''}`)
  }

  return {
    status: 'mismatch',
    findings,
  }
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

  return {
    summary,
    claimedFiles,
    raw: candidate,
  }
}

/**
 * 解析 agy 输出的 JSON 对象。
 *
 * @param {string} raw
 * @returns {Record<string, any>|undefined}
 */
export function parseAgyJson(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 从输出提取会话 ID。
 *
 * @param {string} raw
 * @returns {string|undefined}
 */
export function extractConversationId(raw) {
  try {
    const parsed = JSON.parse(raw)
    const id = parsed?.conversation_id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 从输出提取 token 用量。
 *
 * @param {string} raw
 * @returns {{ total?: number, input?: number, output?: number, thinking?: number, cacheRead?: number, turns?: number }|undefined}
 */
export function extractUsage(raw) {
  const parsed = parseAgyJson(raw)
  if (parsed === undefined) return undefined

  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const usage = parsed.usage !== null && typeof parsed.usage === 'object' ? parsed.usage : {}

  const result = {
    total: num(usage.total_tokens),
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    thinking: num(usage.thinking_tokens),
    cacheRead: num(usage.cache_read_tokens),
    turns: num(parsed.num_turns),
  }
  return Object.values(result).some(value => value !== undefined) ? result : undefined
}

/**
 * 提取运行时长（毫秒）。
 *
 * @param {string} raw
 * @param {number} fallbackMs
 * @returns {number}
 */
export function extractDurationMs(raw, fallbackMs = 0) {
  const parsed = parseAgyJson(raw)
  const secs = Number(parsed?.duration_seconds)
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.round(secs * 1000)
  }
  return fallbackMs
}

/**
 * 组装 agy 命令行参数。
 *
 * @param {object} config
 * @param {string} task
 * @param {number} [timeoutMs]
 * @param {string} [conversationId]
 * @returns {string[]}
 */
export function buildAgyArgv(config, task, timeoutMs, conversationId) {
  const agyBin = config.agyPath || (process.platform === 'win32' ? 'agy.exe' : 'agy')
  const bin = Array.isArray(agyBin)
    ? agyBin
    : (typeof agyBin === 'string' && (agyBin.endsWith('.mjs') || agyBin.endsWith('.js'))
        ? [process.execPath, agyBin]
        : [agyBin])

  const argv = [
    ...bin,
    '-p', task,
    '--output-format', 'json',
    '--mode', config.mode || 'accept-edits',
  ]

  if (config.model !== undefined) argv.push('--model', config.model)
  if (config.effort !== undefined) argv.push('--effort', config.effort)
  // 续跑传 --conversation，绝不用 -c
  if (conversationId !== undefined) argv.push('--conversation', conversationId)

  const defaultPrintTimeoutMs = config.agyPrintTimeoutMs ?? DEFAULT_AGY_PRINT_TIMEOUT_MS
  const deadlineMs = timeoutMs && timeoutMs > 0 ? timeoutMs : defaultPrintTimeoutMs
  argv.push('--print-timeout', `${Math.ceil(deadlineMs / 1000) + 60}s`)
  argv.push('--dangerously-skip-permissions')

  const schema = config.jsonSchema !== undefined ? config.jsonSchema : DEFAULT_AGY_SCHEMA
  if (schema !== false) {
    argv.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema))
  }

  return argv
}

/**
 * 按字符数截断字符串。
 *
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function truncateChars(str, max) {
  if (typeof str !== 'string') return ''
  return str.length <= max ? str : str.slice(0, max) + '…[truncated]'
}

/**
 * 按 UTF-8 字节截断，不切碎多字节字符。
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateBytes(text, maxBytes) {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return text

  const suffix = '…[truncated]'
  const suffixBytes = new TextEncoder().encode(suffix).byteLength
  const fits = suffixBytes <= maxBytes
  let end = fits ? maxBytes - suffixBytes : maxBytes
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end -= 1

  return new TextDecoder().decode(encoded.subarray(0, end)) + (fits ? suffix : '')
}

/**
 * 映射 agy 执行结果。
 *
 * @param {string} raw
 * @param {{ exitCode: number | null, signal: string | null }} outcome
 * @param {{ changed: boolean, summary: string, files?: string[], determined?: boolean }} artifacts
 * @param {object} [context]
 * @returns {{
 *   output: Array<{ type: string, text: string }>,
 *   stopReason: string,
 *   capacity?: boolean,
 *   diagnostic?: string,
 *   structured?: unknown,
 *   claimedFiles?: string[],
 *   reconciliation?: object,
 *   report: string,
 *   rawParsed?: object
 * }}
 */
export function mapAgyResult(raw, outcome, artifacts, context = {}) {
  const parsed = parseAgyJson(raw)
  const structured = parseStructuredReport(parsed)
  const claimedFiles = structured?.claimedFiles
  const root = context?.cwd ?? artifacts?.root
  const reconciliation = reconcileClaimedArtifacts(claimedFiles, artifacts, root)

  const agyStatus = parsed?.status
  const agyError = typeof parsed?.error === 'string' ? parsed.error : ''

  let bodyText = ''
  if (structured?.summary !== undefined && structured.summary !== '') {
    bodyText = structured.summary
  } else if (typeof parsed?.response === 'string') {
    bodyText = parsed.response
  }
  const digest = bodyText === '' ? [] : [{ type: 'text', text: truncateChars(bodyText, DIGEST_MAX_CHARS) }]

  const mismatchDiag = reconciliation?.status === 'mismatch'
    ? `对账差异：${reconciliation.findings.join('；')}`
    : undefined

  if (context.aborted || context.timedOut) {
    return {
      output: digest,
      stopReason: 'aborted',
      diagnostic: truncateBytes(
        [context.timedOut ? 'agy 超时，已终止进程树' : '委派被取消', mismatchDiag].filter(Boolean).join('｜'),
        DIAGNOSTIC_MAX_BYTES,
      ),
      structured: structured?.raw ?? structured,
      claimedFiles,
      reconciliation,
      report: bodyText,
      rawParsed: parsed,
    }
  }

  // 服务端容量不足（503 No capacity available）
  if (isCapacityError(parsed, raw, context?.stderr)) {
    return {
      output: digest,
      stopReason: 'capacity',
      capacity: true,
      diagnostic: truncateBytes(
        [
          `agy 报服务端容量不足（No capacity available）：${agyError || '服务端暂无可用容量'}`,
          mismatchDiag,
        ].filter(Boolean).join('｜'),
        DIAGNOSTIC_MAX_BYTES,
      ),
      structured: structured?.raw ?? structured,
      claimedFiles,
      reconciliation,
      report: bodyText,
      rawParsed: parsed,
    }
  }

  // 产物存在即视为完成——即使 agy 自报 ERROR
  if (artifacts?.changed && (agyStatus !== 'SUCCESS' || outcome?.exitCode !== 0)) {
    const baseDiag = `agy 自报 ${agyStatus ?? `exit ${outcome?.exitCode}`}，但检测到磁盘产物：${artifacts.summary}`
    return {
      output: digest,
      stopReason: 'completed',
      diagnostic: truncateBytes(
        [baseDiag, mismatchDiag].filter(Boolean).join('｜'),
        DIAGNOSTIC_MAX_BYTES,
      ),
      structured: structured?.raw ?? structured,
      claimedFiles,
      reconciliation,
      report: bodyText,
      rawParsed: parsed,
    }
  }

  if (agyStatus === 'SUCCESS' && outcome?.exitCode === 0) {
    return {
      output: digest,
      stopReason: 'completed',
      diagnostic: mismatchDiag ? truncateBytes(mismatchDiag, DIAGNOSTIC_MAX_BYTES) : undefined,
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
    diagnostic: truncateBytes(
      [
        `agy ${agyStatus ?? `exit ${outcome?.exitCode}`}: ${agyError || '无错误详情'}`,
        mismatchDiag,
      ].filter(Boolean).join('｜'),
      DIAGNOSTIC_MAX_BYTES,
    ),
    structured: structured?.raw ?? structured,
    claimedFiles,
    reconciliation,
    report: bodyText,
    rawParsed: parsed,
  }
}

/** agy 工人适配器对象 */
export const agyWorker = {
  name: 'agy',

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

  buildArgv(config, { task, sessionId, timeoutMs }) {
    return buildAgyArgv(config, task, timeoutMs, sessionId)
  },

  extractSessionId(stdout) {
    return extractConversationId(stdout)
  },

  parse(stdout) {
    const parsed = parseAgyJson(stdout)
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
  },

  classify({ parsed, exitCode, artifacts, timedOut, cancelled, signal, raw, stderr }) {
    const outcome = { exitCode, signal: signal || (cancelled ? 'SIGTERM' : null) }
    const context = { aborted: cancelled, timedOut, stderr }
    return mapAgyResult(raw, outcome, artifacts, context)
  },
}
