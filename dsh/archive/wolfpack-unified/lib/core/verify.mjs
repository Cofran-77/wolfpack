import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawnProcess } from './spawn.mjs'

/** 默认验收命令超时时间（5 分钟）。 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 300_000

/** 默认进程优雅退出宽限时间（5 秒）。 */
export const DEFAULT_GRACE_MS = 5_000

/** 提取失败信号数量上限。 */
export const FAILURE_SIGNAL_LIMIT = 5

/**
 * 检查指定命令是否在 PATH 中。
 *
 * @param {string} cmd
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined} 命中的绝对路径或 undefined
 */
export function findInPath(cmd, env = process.env) {
  if (!cmd || typeof cmd !== 'string') return undefined
  const pathEnv = env.PATH || env.Path || process.env.PATH || process.env.Path || ''
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ? env.PATHEXT.split(';') : ['.exe', '.cmd', '.bat', ''])
    : ['']

  const dirs = pathEnv.split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, cmd.toLowerCase().endsWith(ext.toLowerCase()) && ext !== '' ? cmd : `${cmd}${ext}`)
      try {
        if (existsSync(candidate)) return candidate
      } catch {}
    }
  }
  return undefined
}

/**
 * 获取当前平台的候选 shell 列表描述（用于诊断提示）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function getCandidateShells(env = process.env) {
  if (process.platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || process.env.SystemRoot || process.env.SYSTEMROOT || ''
    const defaultWinPs = root
      ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'System32/WindowsPowerShell/v1.0/powershell.exe'
    return ['pwsh (PATH)', defaultWinPs]
  }
  return ['bash', 'sh']
}

/**
 * 获取默认的 shell 执行命令行参数。
 *
 * @param {string|string[]|Record<string, string|undefined>} [customShellOrEnv]
 * @param {Record<string, string|undefined>} [explicitEnv]
 * @returns {string[]}
 */
export function defaultShellArgv(customShellOrEnv = process.env, explicitEnv) {
  let override
  let env = process.env

  if (Array.isArray(customShellOrEnv)) {
    return customShellOrEnv
  }
  if (typeof customShellOrEnv === 'string') {
    override = customShellOrEnv
    if (explicitEnv) env = explicitEnv
  } else if (customShellOrEnv && typeof customShellOrEnv === 'object') {
    env = customShellOrEnv
    override = env.WOLFPACK_SHELL
  }

  if (typeof override === 'string' && override.trim() !== '') {
    return override.trim().split(/\s+/)
  }

  if (process.platform === 'win32') {
    const root = env?.SystemRoot ?? env?.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    return [
      join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      '-NoProfile', '-NonInteractive', '-Command',
    ]
  }
  return ['/bin/sh', '-c']
}

/** 计数行正则 */
const COUNT_RES = [
  /(\d+)\s+failed[,\s]+(\d+)\s+passed/i,
  /(\d+)\s+passed[,\s]+(\d+)\s+failed/i,
  /(\d+)\s+passing[\s\S]{0,40}?(\d+)\s+failing/i,
  /(\d+)\s+failing[\s\S]{0,40}?(\d+)\s+passing/i,
]

/** 文件行号正则 */
const FILE_LINE_RE = /(?:[\w.@~\\/-]*\.[A-Za-z]\w{0,7}):(\d+)(?::(\d+))?/g

/** 断言关键字正则 */
const ASSERT_RE = /AssertionError|\bassert\w*\s*\(|^\s*(?:expected|Expected|actual|Actual)\b|\bexpect\s*\(/m

/** 失败测试用例名正则 */
const TEST_NAME_RE = /^\s*(?:✗|✕|✖|×|FAIL(?:ED)?\b|not ok\s+\d+\s*-?)\s*(.+)$/

/**
 * 从输出文本中提取可定位的失败信号。
 *
 * @param {string} text
 * @param {{ maxItems?: number }} [options]
 * @returns {{ items: Array<{ kind: string, text: string }>, degraded: boolean }}
 */
export function extractFailureSignals(text, { maxItems = FAILURE_SIGNAL_LIMIT } = {}) {
  const source = typeof text === 'string' ? text : ''
  const items = []
  const seen = new Set()

  const push = (kind, raw) => {
    const norm = String(raw).trim()
    if (!norm || items.length >= maxItems) return
    const key = `${kind}|${norm}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ kind, text: norm })
  }

  // 1. 计数行
  for (const pattern of COUNT_RES) {
    const matched = source.match(pattern)
    if (matched) {
      push('counts', matched[0])
      break
    }
  }

  // 2. 文件与行号
  FILE_LINE_RE.lastIndex = 0
  let fileMatch
  while ((fileMatch = FILE_LINE_RE.exec(source)) !== null) {
    push('file:line', fileMatch[0])
    if (items.length >= maxItems) break
  }

  // 3. 断言行
  const lines = source.split('\n')
  if (ASSERT_RE.test(source)) {
    const line = lines.find(l => ASSERT_RE.test(l))
    if (line) push('assert', line)
  }

  // 4. 测试用例名
  for (const line of lines) {
    if (TEST_NAME_RE.test(line)) {
      push('test-name', line)
      if (items.length >= maxItems) break
    }
  }

  return { items, degraded: items.length === 0 }
}

/**
 * 判定基线命令执行结果。
 * 核心铁律：
 * 1. 只有所有命令都跑了且都失败才判 proceed（放行启动工人）；
 * 2. 任一命令通过（exit 0）判 stale（绝对不启动工人）；
 * 3. 命令跑不起来或全部超时判 error（工具故障，绝对不启动工人）。
 *
 * @param {Array<{ command: string, ran: boolean, ok: boolean, exitCode: number | null, timedOut?: boolean, error?: string }>} checks
 * @returns {{ decision: 'proceed' | 'stale' | 'error', reason?: string }}
 */
export function evaluateBaseline(checks) {
  const list = Array.isArray(checks) ? checks : []
  if (list.length === 0) return { decision: 'proceed', reason: undefined }

  const broken = list.filter(c => c.ran !== true)
  if (broken.length > 0) {
    const errorDetails = broken.map(c => (c.error ? `${c.command}: ${c.error}` : c.command)).join('；')
    return {
      decision: 'error',
      reason: `基线命令没有跑起来（工具故障，不是「问题还在」）：${errorDetails}`,
    }
  }

  const passing = list.filter(c => c.ok === true)
  if (passing.length > 0) {
    const timedOutNote = list.some(c => c.timedOut === true)
      ? '（另有基线命令超时，但那不影响这条结论）'
      : ''
    return {
      decision: 'stale',
      reason: `基线命令已经通过：${passing.map(c => `${c.command} (exit 0)`).join('；')}${timedOutNote}——问题不存在或已被修，本轮没有启动 agy。`,
    }
  }

  const timedOut = list.filter(c => c.timedOut === true)
  const normalFailures = list.filter(c => c.ok === false && c.timedOut !== true)
  if (timedOut.length > 0 && normalFailures.length === 0) {
    return {
      decision: 'error',
      reason: '基线命令超时，无法判定问题是否存在（工具故障，不是「问题还在」）',
    }
  }

  return { decision: 'proceed', reason: undefined }
}

/**
 * 运行验收或基线命令集合。
 *
 * @param {object} params
 * @param {object} [params.runtime] - 注入的宿主运行时
 * @param {object} [params.ctx] - 兼容 DSH Cordis 上下文
 * @param {string} params.cwd - 执行工作目录
 * @param {string[]} params.commands - 命令列表
 * @param {AbortSignal} [params.signal] - 中止信号
 * @param {string[]} [params.shellArgv] - 自定义 shell 前缀
 * @param {number} [params.timeoutMs] - 超时毫秒数（0 = 无限制）
 * @param {number} [params.tailLines] - 结果保留行数（默认 20 行）
 * @param {number} [params.graceMs] - 进程退出宽限时间
 * @param {Record<string, string|undefined>} [params.env] - 环境变量
 * @returns {Promise<Array<{
 *   command: string,
 *   ran: boolean,
 *   exitCode: number | null,
 *   ok: boolean,
 *   tail: string,
 *   timedOut: boolean,
 *   signals?: { items: Array<{ kind: string, text: string }>, degraded: boolean },
 *   error?: string
 * }>>}
 */
export async function runVerify({
  runtime,
  ctx,
  cwd,
  commands,
  signal,
  shellArgv,
  timeoutMs = 300_000,
  tailLines = 20,
  graceMs = 5_000,
  env = process.env,
}) {
  const rt = runtime
    ?? (typeof ctx?.get === 'function' ? ctx.get('subprocess') : (ctx?.subprocess ?? ctx))
  if (!rt || typeof rt.spawn !== 'function') {
    throw new Error('wolfpack: subprocess 服务不可用，无法执行验收命令——本轮没有可核实的成功证据')
  }

  const shell = shellArgv ?? defaultShellArgv(undefined, env)
  const results = []

  for (const command of commands) {
    if (typeof command !== 'string' || command.trim() === '') continue

    let timedOut = false
    let timer = undefined
    const controller = new AbortController()

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      timer.unref?.()
    }

    const mergedSignal = timeoutMs > 0
      ? (signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      : signal

    let ran = false
    let exitCode = null
    let text = ''
    let failure = undefined

    try {
      const handle = rt.spawn({
        argv: [...shell, command],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 1024 * 1024 },
        },
        graceMs,
        signal: mergedSignal,
      })

      const outcome = await handle.done
      if (outcome?.error) {
        throw outcome.error
      }

      ran = true
      exitCode = outcome?.exitCode ?? null
      const out = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      const err = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      text = `${out}${err === '' ? '' : `\n[stderr]\n${err}`}`
    } catch (error) {
      ran = false
      exitCode = null
      failure = error instanceof Error ? error.message : String(error)
      text = `[wolfpack] 验收命令无法执行：${failure}`
    } finally {
      if (timer) clearTimeout(timer)
    }

    const lines = text.trimEnd().split('\n')
    const ok = ran && exitCode === 0

    results.push({
      command,
      ran,
      exitCode,
      ok,
      tail: lines.slice(-tailLines).join('\n'),
      timedOut,
      ...(ok || !ran ? {} : { signals: extractFailureSignals(text) }),
      ...(failure ? { error: failure } : {}),
    })
  }

  return results
}
