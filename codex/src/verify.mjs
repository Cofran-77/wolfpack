import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawnProcess } from './spawn.mjs'
import { resolveRuntime } from './runtime/registry.mjs'

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
 * 阶梯（严格复刻参考实现 agy-runner.js:1590-1630）：
 * 1. WOLFPACK_SHELL 显式覆盖（非空则解析为 argv 前缀并优先使用）
 * 2. Windows：PATH 里能找到 pwsh 就用 pwsh；找不到则用 join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
 *    （必须用变量拼接，不许出现字面盘符路径）
 * 3. POSIX：bash，找不到再 sh
 * 4. 没有任何 shell 可用时，诊断必须可行动：明确列出试过哪些候选，并提示「请设置 WOLFPACK_SHELL 指向可用的 shell」，不要只抛裸 spawn pwsh ENOENT
 *
 * @param {string|string[]} [customShell]
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function defaultShellArgv(customShell, env = process.env) {
  const override = customShell || env.WOLFPACK_SHELL
  if (Array.isArray(override) && override.length > 0) {
    return override
  }
  if (typeof override === 'string' && override.trim() !== '') {
    const parts = []
    const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
    let match
    while ((match = re.exec(override.trim())) !== null) {
      let token = match[0]
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1)
      }
      parts.push(token)
    }
    return parts.length > 0 ? parts : [override.trim()]
  }

  // Windows 阶梯
  if (process.platform === 'win32') {
    // 2.1 尝试 pwsh
    const pwshPath = findInPath('pwsh', env)
    if (pwshPath) {
      return [pwshPath, '-NoProfile', '-NonInteractive', '-Command']
    }

    // 2.2 尝试 Windows PowerShell 5.1（固定路径：%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe）
    const root = env.SystemRoot || env.SYSTEMROOT || process.env.SystemRoot || process.env.SYSTEMROOT || ''
    if (root) {
      const winPs = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      if (existsSync(winPs)) {
        return [winPs, '-NoProfile', '-NonInteractive', '-Command']
      }
    }

    // 兜底返回 pwsh（若后续执行失败则由 runVerify 报告诊断）
    return ['pwsh', '-NoProfile', '-NonInteractive', '-Command']
  }

  // POSIX 阶梯
  const bashPath = findInPath('bash', env) || (existsSync('/bin/bash') ? '/bin/bash' : undefined)
  if (bashPath) {
    return [bashPath, '-c']
  }
  const shPath = findInPath('sh', env) || (existsSync('/bin/sh') ? '/bin/sh' : undefined)
  if (shPath) {
    return [shPath, '-c']
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
export function extractFailureSignals(text, { maxItems = 5 } = {}) {
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
  cwd,
  commands,
  signal,
  shellArgv,
  timeoutMs = 300_000,
  tailLines = 20,
  graceMs = 5_000,
  env = process.env,
  runtime,
}) {
  const shell = shellArgv ?? defaultShellArgv(undefined, env)
  // 验收命令同样走注入的运行时：DSH 一类宿主换掉运行时即可（未注入则回退内置 Node 实现）
  const rt = resolveRuntime(runtime)
  const spawnFn = typeof rt?.spawn === 'function' ? rt.spawn.bind(rt) : spawnProcess
  const results = []

  for (const command of commands) {
    if (typeof command !== 'string' || command.trim() === '') continue

    const proc = spawnFn({
      argv: [...shell, command],
      cwd,
      env,
      signal,
      timeoutMs,
      graceMs,
    })

    const outcome = await proc.done
    let ran = false
    let exitCode = outcome.exitCode
    let text = ''
    let failure = undefined

    if (outcome.error) {
      ran = false
      const rawError = outcome.error.message || String(outcome.error)
      const candidates = getCandidateShells(env)
      failure = `未找到可用的 shell 执行命令（当前命令: "${shell[0]}"，原始错误: ${rawError}；曾探查候选列表: ${candidates.join(', ')}）。请设置 WOLFPACK_SHELL 环境变量指向可用的 shell。`
      text = `[wolfpack] 验收命令无法执行：${failure}`
    } else {
      ran = true
      const out = proc.collected.stdout.text
      const err = proc.collected.stderr.text
      text = `${out}${err ? `\n[stderr]\n${err}` : ''}`
    }

    const lines = text.trimEnd().split('\n')
    const ok = ran && exitCode === 0

    results.push({
      command,
      ran,
      exitCode,
      ok,
      tail: lines.slice(-tailLines).join('\n'),
      timedOut: outcome.timedOut,
      ...(ok || !ran ? {} : { signals: extractFailureSignals(text) }),
      ...(failure ? { error: failure } : {}),
    })
  }

  return results
}
