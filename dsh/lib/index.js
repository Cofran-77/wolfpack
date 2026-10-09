/**
 * 狼群模式（Wolfpack Mode）— Host 半。
 *
 * 本插件现在有两半，各自独立：
 *
 *   1. **策略半**（原样保留）：设置里一个 `wolfpack` 开关，打开时把队长指令
 *      作为动态 system-prompt section 注入每次请求。正文从外部文件读，改文案
 *      零重启。这一半决定「队长怎么判断」。
 *
 *   2. **机制半**（新增）：开关打开时挂载 agy 委派机制——
 *        · `AgyProvider` 注册到 `ctx.subagents`（seam 互操作入口）
 *        · `wolf_delegate` 模型面工具（正常入口，带 task_id 与 verify）
 *        · `wolf_status` 只读状态工具
 *        · `wolf_kill` 终止活运行工具
 *        · `wolf_team` 并发委派小队工具
 *      这一半决定「队长怎么派、怎么验收」。开关关掉时整体摘除，不留残余工具。
 *
 * 设计要点：
 *   · 统一接入通用核（lib/core/**），消除重复实现；
 *   · 续跑用 `--conversation <id>`，绝不用 `-c`；
 *   · 台账路径统一使用 $DSH_HOME 阶梯解析；
 *   · 子进程通过 DshRuntime 统一纳管。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { defaultActiveRuns, defaultLedgerPath, RunsLedger, statusMetaFromValue } from './core/ledger.mjs'
import {
  abortActiveRun,
  killRun,
  listLiveRuns,
  preflightAgy,
  runDelegateTask,
} from './core/delegate.mjs'
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  defaultShellArgv,
  evaluateBaseline,
  runVerify,
} from './core/verify.mjs'
import {
  formatToolBudget,
  renderDigest,
  renderStatus,
  renderTeamDigest,
} from './core/digest.mjs'
import {
  ALLOWED_ARGS_KEYS,
  ALLOWED_TASK_KEYS,
  DEFAULT_TEAM_CONCURRENCY,
  MAX_TEAM_CONCURRENCY,
  MAX_TEAM_TASKS,
  runTeamTasks,
  TEAM_ERROR_MAX_CHARS,
  TEAM_REPORT_HEAD_CHARS,
  TEAM_SUMMARY_MAX_CHARS,
  TEAM_TOOL_NAME,
} from './core/team.mjs'
import {
  loadConfig,
  parseTimeoutMs,
  resolveDeadline,
} from './core/config.mjs'
import {
  DEFAULT_TASK_TIMEOUT_MS,
} from './core/worker/agy.mjs'
import {
  findInPath,
  isWorkerAvailable,
} from './core/worker/index.mjs'
import { createDshRuntime, DshRuntime } from './runtime/dsh.mjs'
import { createDshToastNotifier, resolveStallConfig } from './stall-monitor.js'
import { registerAgyProvider } from './agy-provider.js'
import { registerLiveRoute } from './live-route.js'

export {
  defaultLedgerPath,
  RunsLedger,
  statusMetaFromValue,
  formatToolBudget,
  renderDigest,
  renderStatus,
  renderTeamDigest,
  runDelegateTask,
}

/** Cordis 插件名，同时用作设置命名空间。 */
export const name = 'wolfpack'

/** 硬依赖：系统提示组装。机制半所需的服务用软获取（见下）。 */
export const inject = ['systemPrompt']

/**
 * 插件配置：`enabled` 就是设置里的狼群开关。
 *
 * 0.2.0 的设置即插件自己的 Config——字段标 `.volatile()` 才会进入设置表单，
 * 写入由 loader 就地提交进运行中的配置引用（不重挂插件），并发出
 * `loader/volatile-update`。所以开关值从 `apply(ctx, config)` 的第二个参数读，
 * 而不是从某个设置服务读。
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  agy_enabled: z.boolean().default(true).volatile(),
  // claude 默认关：本机 claude 无额度，默认开会让轮换把任务派给 claude 再失败。
  // 有额度时在狼群开关的「启用工人」里勾上即可。
  claude_enabled: z.boolean().default(false).volatile(),
})

/** 设置命名空间。 */
const NS = 'wolfpack'

/** 队长指令正文所在路径；可用环境变量覆盖。 */
const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const BRIEFING_PATH = process.env.WOLFPACK_BRIEFING ?? join(pluginRoot, 'briefing.md')

/** agy 可执行文件路径（无硬编码默认路径，遵循标准平台查找）。 */
export const AGY_PATH = process.env.WOLFPACK_AGY ?? (process.platform === 'win32' ? 'agy.exe' : 'agy')

/** claude 可执行文件路径。 */
export const CLAUDE_PATH = process.env.WOLFPACK_CLAUDE ?? 'claude'

/** 台账路径（统一走 $DSH_HOME 阶梯）。 */
const LEDGER_PATH = process.env.WOLFPACK_LEDGER ?? defaultLedgerPath()

/**
 * 停滞台账路径。刻意与 runs.ndjson 分开：台账按「轮」折叠，混进报警记录会污染统计。
 */
const STALL_LOG_PATH = process.env.WOLFPACK_STALL_LOG ?? join(dirname(LEDGER_PATH), 'stall.ndjson')

/**
 * 正文文件读不到时的兜底文案。
 */
const FALLBACK_BRIEFING = [
  '## 狼群模式已开启（Wolfpack Mode）',
  '',
  '⚠️ briefing.md 读取失败，当前是兜底文案。请检查 ' + BRIEFING_PATH,
  '',
  '你是**队长**：拆解 → 派给队员 → **独立验收**。',
  '',
  '队员 = Antigravity CLI（agy），通过 `wolf_delegate` 工具委派。',
  '',
  '主要判据：**这活我自己做要超过 2 轮 → 派；1 轮内能收尾 → 自己做。**',
  '验收铁律：队员的自我报告不是证据；工具返回的「我已核实」段才是。',
].join('\n')

function readBriefing() {
  try {
    const text = readFileSync(BRIEFING_PATH, 'utf8')
    return text.trim().length > 0 ? text : FALLBACK_BRIEFING
  } catch (error) {
    console.warn('wolfpack: cannot read briefing file, using fallback:', BRIEFING_PATH, error)
    return FALLBACK_BRIEFING
  }
}

/**
 * 读 volatile 字段值。
 *
 * `.volatile()` 字段在插件侧是只读引用（`.get()`），被设置写入后就地更新；
 * 未标 volatile 的字段是裸值。两种形态都兼容，避免将来加字段时必须改这里。
 */
export function readVolatile(config, key, fallback) {
  if (config === undefined || config === null) return fallback
  const item = config[key]
  const raw = item !== null && typeof item === 'object' && typeof item.get === 'function'
    ? item.get()
    : item
  return raw !== undefined ? raw : fallback
}

function readEnabled(config) {
  return readVolatile(config, 'enabled', false) === true
}

/**
 * 把两个工人开关折成 `workersEnabled`（工人池收窄的唯一入口）。
 *
 * ⚠️ 兜底值必须**等于 Config 的 schema 默认值**（`agy_enabled` default true、
 * `claude_enabled` default false）。DSH 0.2.0 把 profile 里的**原始** config 交给
 * `apply(ctx, config)`——只写了 `enabled: true` 时两个工人键根本不存在；此时若按
 * “缺省即开”兜底，claude 就会被静默算进工人池，轮换热身时把任务派给它再失败
 * （本机 claude 无额度）。缺省关掉 claude 才是 schema 说的那个意思。
 */
export function computeWorkersEnabled(config) {
  const agyOn = readVolatile(config, 'agy_enabled', true) !== false
  const claudeOn = readVolatile(config, 'claude_enabled', false) !== false
  if (agyOn && claudeOn) return undefined // 两个都开等价于不限制
  if (agyOn) return ['agy']
  if (claudeOn) return ['claude']
  return [] // 两个都关（异常防御）
}

export const DEFAULT_TOKEN_BUDGET = 1_000_000

export function maxRoundsPerTask(env = process.env) {
  const raw = env.WOLFPACK_MAX_ROUNDS
  if (raw === undefined || String(raw).trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function durationEnv(raw, fallbackMs) {
  if (raw === undefined || String(raw).trim() === '') return fallbackMs
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return 0
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : fallbackMs
}

export function taskTimeoutMs(env = process.env) {
  return durationEnv(env.WOLFPACK_TASK_TIMEOUT, 0)
}

export function verifyTimeoutMs(env = process.env) {
  return durationEnv(env.WOLFPACK_VERIFY_TIMEOUT, DEFAULT_VERIFY_TIMEOUT_MS)
}

export function continuationTokenBudget(env = process.env) {
  const raw = env.WOLFPACK_TOKEN_BUDGET
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_TOKEN_BUDGET
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return undefined
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TOKEN_BUDGET
}

export const DEFAULT_UNKNOWN_USAGE_CAP = 20

export function unknownUsageRoundCap(env = process.env) {
  const raw = env.WOLFPACK_UNKNOWN_USAGE_CAP
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_UNKNOWN_USAGE_CAP
  const text = String(raw).trim().toLowerCase()
  if (text === 'off' || text === 'none' || text === '0') return 0
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_UNKNOWN_USAGE_CAP
}

export function runConfig(ctx, config) {
  const maxRounds = maxRoundsPerTask()
  const stall = resolveStallConfig()
  const defaultHealth = loadConfig({ ledgerPath: LEDGER_PATH }).workerHealth
  const healthOff = ['off', 'none', '0', 'false', 'no'].includes(
    String(process.env.WOLFPACK_WORKER_HEALTH ?? '').trim().toLowerCase(),
  )
  const workerHealth = healthOff ? { enabled: false } : defaultHealth

  return {
    agyPath: AGY_PATH,
    claudePath: CLAUDE_PATH,
    ...(process.env.WOLFPACK_CLAUDE_MODEL === undefined ? {} : { claudeModel: process.env.WOLFPACK_CLAUDE_MODEL }),
    ...(process.env.WOLFPACK_CLAUDE_PERMISSION_MODE === undefined ? {} : { claudePermissionMode: process.env.WOLFPACK_CLAUDE_PERMISSION_MODE }),
    ...(process.env.WOLFPACK_CLAUDE_AGENTS === undefined ? {} : { claudeAgents: process.env.WOLFPACK_CLAUDE_AGENTS }),
    ...(process.env.WOLFPACK_WORKER === undefined ? {} : { worker: process.env.WOLFPACK_WORKER }),
    workersEnabled: computeWorkersEnabled(config),
    workerHealth,
    ledger: new RunsLedger(LEDGER_PATH),
    mode: process.env.WOLFPACK_MODE ?? 'accept-edits',
    timeoutMs: taskTimeoutMs(),
    verifyTimeoutMs: verifyTimeoutMs(),
    stall: {
      windowMs: stall.windowMs,
      maxWarnings: stall.maxWarnings,
      pollMs: stall.pollMs,
      toast: stall.toast,
    },
    stallStoreRoot: stall.storeRoot,
    stallLogPath: STALL_LOG_PATH,
    stallToastNotifier: createDshToastNotifier(ctx),
    ...(process.env.WOLFPACK_MODEL === undefined ? {} : { model: process.env.WOLFPACK_MODEL }),
    ...(process.env.WOLFPACK_EFFORT === undefined ? {} : { effort: process.env.WOLFPACK_EFFORT }),
    continuation: process.env.WOLFPACK_CONTINUATION ?? 'per-task',
    continuationTokenBudget: continuationTokenBudget(),
    unknownUsageRoundCap: unknownUsageRoundCap(),
    ...(maxRounds === undefined ? {} : { maxRoundsPerTask: maxRounds }),
  }
}

function omitUndefined(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/* ── 1. wolf_delegate ──────────────────────────────────────────────── */

export const TOOL_NAME = 'wolf_delegate'

const DELEGATE_DESCRIPTION = [
  '把一件自洽、可机械验收的活交给 agy（Antigravity CLI，走你的订阅额度）执行，',
  '并把「实测证据」带回本次会话。agy 看不到本会话的任何内容，所以 `task` 必须是完整独立的任务书。',
  '',
  '适用：有明确交付物、能用测试/命令判定成败、且不依赖本会话上下文的活。',
  '不适用：一轮内能收尾的小事；本质是「读+判断」的活（把活派出去却没有产出可卸载）；',
  '必须了解本会话前因后果才能做对的活。',
  '',
  '同一个 `task_id` 的多轮会续用 agy 自己的会话，所以追问不必重述任务书；',
  '换一件不相关的事就必须换 `task_id`，否则会把上一件的现场接过去。',
  '同一个 `task_id` 在已有运行中时，第二次调用会被**拒绝**（不是排队、也不是静默串场）：换 id 或等它跑完。',
  '改错了方向时用 `fresh: true` 重开——续跑会把错误路径一起保留。',
  '任务**没有 wall-clock 超时**：agy 会一直跑到自己结束，唯一的上限是配额——',
  '不会出现「20 分钟到点被杀、活干完了却什么都没拿回来」。',
  '队长取消（Esc）或会话中断仍然会终止进程树，映射成 `stop_reason: aborted`；',
  '想让工具层按时间兜底，设 `WOLFPACK_TASK_TIMEOUT=<秒>`（默认 0 = 不设）。',
  '**停滞只报警、永不自动终止**：判据是 agy 还在不在写自己的 transcript，默认无进展',
  '5/10/15 分钟各报一次（控制台 + 系统通知 + `stall.ndjson`），之后闭嘴；要停由你自己中断。',
  '`WOLFPACK_STALL_WINDOW=<秒>` 调窗口，`=off` 关掉监控，`WOLFPACK_STALL_TOAST=off` 关通知。',
  '续跑由累计 token 预算兜底（默认 1,000,000），超预算才强制冷启动，理由写在 digest 里。',
  '连续多轮拿不到用量（agy 不报 tokens）时会退回轮数判断：`unknown-usage-round-cap`（默认 20 轮），',
  '可用 `WOLFPACK_UNKNOWN_USAGE_CAP` 调整，设 `off`/`none`/`0` 可关闭该兜底。',
  '',
  '`verify_baseline` 是**派活前必须失败**的命令，用来证明问题此刻真的存在：',
  '基线里已经有命令通过 → 直接返回 `stale` 且**不启动 agy**（省钱，并消灭「重复派一件已完成的活」）。',
  '`verify_baseline` 命令没跑起来 → 结论是 `error`（工具故障），绝不当作「问题还在」推进。',
  '不给 `verify` 就等于本轮没有可核实的成功证据，结论只会是 `unverified`。',
  '想知道自己派过哪些活、各自到第几轮、最后结论与累计用量，用只读的 `wolf_status`（它不会启动 agy）。',
].join('\n')

export function registerWolfDelegate(ctx, config) {
  const tools = ctx.get?.('tools')
  if (tools === undefined) {
    throw new Error('wolfpack: tools 服务不可用——wolf_delegate 无法注册')
  }

  const taskDeadline = resolveDeadline(config.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)
  const verifyDeadline = resolveDeadline(config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS)
  const toolDeadlineMs = taskDeadline === undefined
    ? undefined
    : taskDeadline + (verifyDeadline ?? 0) + 120_000

  const runtime = createDshRuntime(ctx)

  return tools.register(defineTool({
    name: TOOL_NAME,
    description: DELEGATE_DESCRIPTION,
    ...(toolDeadlineMs === undefined ? {} : { timeoutMs: toolDeadlineMs }),
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: '这件事的稳定标识（如 `fix-build`、`add-csv-export`）。同一个 task_id 的多轮会续用 agy 自己的会话；换一件不相关的事必须换 id，否则会把上一件的现场接过去。',
      },
      task: {
        type: 'string',
        required: true,
        description: '完整独立的任务书：目标、交付物、以及「怎样算完成」。agy 看不到本会话，省略的上下文它不会知道。',
      },
      verify_baseline: {
        type: 'array',
        items: { type: 'string' },
        description: '派活前**必须失败**的命令（用来证明问题此刻真的存在）。基线里已经有命令通过 → 本轮直接返回 `stale`，且**完全不启动 agy**（省钱，并消灭「重复派一件已完成的活」）。基线命令没跑起来 → 返回 `error`（工具故障），不会当成「问题还在」推进。省略即不做陈旧检测。语法同 `verify`。',
      },
      verify: {
        type: 'array',
        items: { type: 'string' },
        description: '验收命令（在队长会话的工作目录里执行，如 `npm test`）。强烈建议每次都给：不给就等于本轮没有可核实的成功证据，只能相信队员的自述。每条命令单独一条；默认 shell 是 Windows PowerShell，多条命令请用 `;` 分隔（它不支持 `&&`）。',
      },
      fresh: {
        type: 'boolean',
        description: '强制冷启动、丢弃已有的 agy 会话。用于「上一轮方向错了」——续跑会把错误路径一起保留。',
      },
      model: {
        type: 'string',
        description: '覆盖本次运行的 agy 模型（如 `claude-opus-4-6-thinking`）。省略则用部署默认值。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          round: { type: 'integer', required: true },
          continued: { type: 'boolean', required: true },
          stop_reason: { type: 'string', required: true },
          capacity: {
            type: 'boolean',
            description: '是否为服务端容量不足（503 No capacity available）；此时非任务自身失败，切勿反复重试。',
          },
          report: { type: 'string', required: true },
          changed_files: { type: 'array', required: true, items: { type: 'string' } },
          changed_files_determined: {
            type: 'boolean',
            description: '磁盘改动探测是否可信：false = 本轮没探测过（例如基线未过、根本没启动 agy）或探测不可用（非 git 工作区）。不要把它读成「确认没有改动」。',
          },
          changed_files_undetermined_reason: {
            type: 'string',
            description: '磁盘改动无法判定时的原因说明。',
          },
          verify: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                command: { type: 'string', required: true },
                ran: { type: 'boolean', required: true },
                ok: { type: 'boolean', required: true },
                exit_code: { type: 'integer' },
                tail: { type: 'string' },
                timed_out: { type: 'boolean' },
                signals: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          kind: { type: 'string', required: true },
                          text: { type: 'string', required: true },
                        },
                      },
                    },
                    degraded: { type: 'boolean', required: true },
                  },
                },
                error: { type: 'string' },
              },
            },
          },
          baseline: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                command: { type: 'string', required: true },
                ran: { type: 'boolean', required: true },
                ok: { type: 'boolean', required: true },
                exit_code: { type: 'integer' },
                tail: { type: 'string' },
                timed_out: { type: 'boolean' },
                signals: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          kind: { type: 'string', required: true },
                          text: { type: 'string', required: true },
                        },
                      },
                    },
                    degraded: { type: 'boolean', required: true },
                  },
                },
                error: { type: 'string' },
              },
            },
          },
          verdict: { type: 'string' },
          diagnostic: { type: 'string' },
          verify_registered_count: {
            type: 'integer',
            description: '本轮收到几条验收命令（即使基线未过、一条都没跑，也能看出队长给了几条）。',
          },
          conversation_id: { type: 'string' },
          raw_path: { type: 'string' },
          spill_path: { type: 'string' },
          fresh_reason: { type: 'string' },
          duration_ms: { type: 'integer' },
          stall_warnings: {
            type: 'integer',
            description: '本轮 agy 疑似停滞的报警次数（0/缺席 = 没报过）。报警**只提醒、从不终止**：没有任何自动终止逻辑，要停只能由人中断。',
          },
          tool_deadline_ms: {
            type: 'integer',
            description: '本轮向宿主声明的工具调用超时（毫秒），缺席 = 不设上限。',
          },
          worker: { type: 'string' },
          worker_reason: { type: 'string' },
          worker_health: { type: 'object', additionalProperties: true },
          benched: { type: 'object', additionalProperties: true },
          benched_workers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          benched_skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
          all_benched: { type: 'boolean' },
          health_note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDigest(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!exec?.agent) {
        throw new Error('wolf_delegate 需要一个调用方 agent（exec.agent 为空）')
      }
      const cwd = exec.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') {
        throw new Error('wolf_delegate 需要一个有工作目录的会话——当前会话没有 cwd')
      }
      return runDelegateTask({
        runtime,
        ctx,
        config,
        args,
        exec,
        cwd,
        signal: exec.signal,
        verifyDeadline,
        toolDeadlineMs,
      })
    },
  }))
}

/* ── 2. wolf_status ────────────────────────────────────────────────── */

export const STATUS_TOOL_NAME = 'wolf_status'
export const DEFAULT_STATUS_LIMIT = 20
export const MAX_STATUS_LIMIT = 100
export const STATUS_CHANGED_FILES_PER_TASK = 5

const STATUS_DESCRIPTION = [
  '只读台账，回答「我派过哪些活、各自到哪了」。',
  '跨会话恢复后重新接手时用它：每个任务给出轮数、最后 verdict、最后 stop_reason、',
  '累计 token（配额，不是 ¥）、conversation_id 是否存在、是否正在跑。',
  '',
  '它**绝不**启动 agy、不跑验收、不消耗配额——只把台账的折叠结果渲染成有界文本。',
  '想知道某件事一共烧了多少配额，看 total_tokens；想知道能不能续跑，看 conversation_id。',
].join('\n')

function normalizeLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_STATUS_LIMIT
  return Math.min(Math.max(Math.floor(value), 1), MAX_STATUS_LIMIT)
}

export function registerWolfStatus(ctx, config) {
  const tools = ctx.get?.('tools')
  if (tools === undefined) {
    throw new Error('wolfpack: tools 服务不可用——wolf_status 无法注册')
  }

  return tools.register(defineTool({
    name: STATUS_TOOL_NAME,
    description: STATUS_DESCRIPTION,
    parameters: {
      task_id: {
        type: 'string',
        description: '只看这一个 task_id；省略则列出全部（按最近活动倒序）。',
      },
      limit: {
        type: 'integer',
        description: `最多列出多少个任务（默认 ${DEFAULT_STATUS_LIMIT}，上限 ${MAX_STATUS_LIMIT}）。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                round: { type: 'integer', required: true },
                last_verdict: { type: 'string' },
                last_stop_reason: { type: 'string' },
                total_tokens: { type: 'integer', required: true },
                total_cache_read_tokens: { type: 'integer', required: true },
                has_conversation_id: { type: 'boolean', required: true },
                running: { type: 'boolean', required: true },
                changed_files_count: { type: 'integer', required: true },
                changed_files: { type: 'array', required: true, items: { type: 'string' } },
                last_at: { type: 'integer', required: true },
                last_duration_ms: { type: 'integer' },
                budget_used: {
                  type: 'integer',
                  required: true,
                  description: '该任务累计已用 token 数（取自台账 totalTokens）。',
                },
                budget_limit: {
                  type: 'integer',
                  description: '该任务的累计 token 预算上限；预算被关闭时省略。',
                },
                budget_over: {
                  type: 'boolean',
                  required: true,
                  description: '是否已超预算（used >= limit）；预算被关闭时为 false。',
                },
              },
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          limit: { type: 'integer', required: true },
          ledger_path: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
      presentationMeta: (_args, value) => statusMetaFromValue(value),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ledger = config.ledger
      if (ledger === undefined) {
        return omitUndefined({
          tasks: [],
          total: 0,
          truncated: false,
          limit: DEFAULT_STATUS_LIMIT,
          ledger_path: undefined,
        })
      }
      const budgetLimit = typeof config?.continuationTokenBudget === 'number'
        && Number.isFinite(config.continuationTokenBudget)
        && config.continuationTokenBudget > 0
        ? config.continuationTokenBudget
        : undefined
      const registry = config.activeRuns ?? defaultActiveRuns
      const active = new Set(registry.list().map(entry => entry.taskId))
      const all = [...(await ledger.read()).values()]
      const rows = (typeof args.task_id === 'string' && args.task_id !== ''
        ? all.filter(state => state.taskId === args.task_id)
        : all)
        .map(state => {
          const used = typeof state.totalTokens === 'number' && Number.isFinite(state.totalTokens)
            ? state.totalTokens
            : 0
          const budgetOver = budgetLimit !== undefined && used >= budgetLimit
          return omitUndefined({
            task_id: state.taskId,
            round: state.round,
            last_verdict: state.lastVerdict,
            last_stop_reason: state.lastStopReason,
            total_tokens: state.totalTokens,
            total_cache_read_tokens: state.totalCacheReadTokens,
            has_conversation_id: typeof state.conversationId === 'string' && state.conversationId !== '',
            running: active.has(state.taskId),
            changed_files_count: state.changedFiles.length,
            changed_files: state.changedFiles.slice(0, STATUS_CHANGED_FILES_PER_TASK),
            last_at: state.lastAt,
            last_duration_ms: state.lastDurationMs,
            budget_used: used,
            budget_limit: budgetLimit,
            budget_over: budgetOver,
          })
        })
        .sort((left, right) => right.last_at - left.last_at)

      const limit = normalizeLimit(args.limit)
      return omitUndefined({
        tasks: rows.slice(0, limit),
        total: rows.length,
        truncated: rows.length > limit,
        limit,
        ledger_path: typeof ledger.filePath === 'string' ? ledger.filePath : undefined,
      })
    },
  }))
}

/* ── 3. wolf_kill ──────────────────────────────────────────────────── */

export const WOLF_KILL_TOOL_NAME = 'wolf_kill'

export function killMetaFromValue(value) {
  const out = { ok: Boolean(value?.ok) }
  if (value?.task_id != null) out.task_id = value.task_id
  if (value?.run_id != null) out.run_id = value.run_id
  if (value?.reason != null) out.reason = value.reason
  return out
}

export function registerWolfKill(ctx, config) {
  const tools = ctx.get?.('tools')
  if (tools === undefined) {
    return () => {}
  }
  return tools.register(defineTool({
    name: WOLF_KILL_TOOL_NAME,
    description: [
      '终止某个**正在运行**的 agy 运行（连进程树一起杀）。',
      '',
      '适用场景：发现队员跑歪了、或者已经不需要这轮结果时，立刻停掉它，',
      '避免继续消耗配额。',
      '',
      '注意（不夸大）：',
      '· 只能终止正在运行的 agy；已结束的运行无法操作，如实返回失败。',
      '· 被终止的轮次在台账里记为 `aborted`，不会显示成正常完成。',
      '· 终止后下一次 wolf_delegate 仍可对同一 task_id 续跑（视续跑策略而定）。',
      '· 要知道哪些 task_id 正在运行，先用 wolf_status 查历史；',
      '  正在运行的 task_id 本轮的 wolf_delegate 调用尚未返回。',
    ].join('\n'),
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: '要终止的运行的 task_id（必须是当前正在运行的）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task_id: { type: 'string' },
          run_id: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render(value) {
        if (value.ok) {
          return `wolf_kill: 已终止 task_id="${value.task_id}" (run_id=${value.run_id})。台账已记为 aborted。`
        }
        return `wolf_kill: 终止失败——${value.reason}`
      },
      presentationMeta: (_args, value) => killMetaFromValue(value),
    },
    async execute({ task_id }) {
      const ledger = config.ledger
      const result = await killRun(task_id, ledger, config)
      if (result.ok) {
        return { ok: true, task_id: result.taskId, run_id: result.runId }
      }
      return { ok: false, reason: result.reason }
    },
  }))
}

/* ── 4. wolf_team ──────────────────────────────────────────────────── */

export function registerWolfTeam(ctx, config) {
  const tools = ctx.get?.('tools')
  if (tools === undefined) {
    throw new Error('wolfpack: tools 服务不可用——wolf_team 无法注册')
  }

  const taskDeadline = resolveDeadline(config.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)
  const verifyDeadline = resolveDeadline(config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS)
  const toolDeadlineMs = taskDeadline === undefined
    ? undefined
    : taskDeadline + (verifyDeadline ?? 0) + 120_000

  const runtime = createDshRuntime(ctx)

  return tools.register(defineTool({
    name: TEAM_TOOL_NAME,
    description: [
      '并发委派一组自洽任务给多个 agy 工人，并在队长侧保序收集结果与聚合摘要。',
      '每个任务项均走统一的 runDelegateTask 内核，享有相同的基线陈旧检测、机械验收和判决逻辑。',
    ].join('\n'),
    ...(toolDeadlineMs === undefined ? {} : { timeoutMs: toolDeadlineMs }),
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: '并发委派的任务列表（1 到 8 个）。每项包含 task_id、task，以及可选的 verify、verify_baseline、fresh、model。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task_id: { type: 'string', required: true, description: '这件事的稳定标识。' },
            task: { type: 'string', required: true, description: '完整独立的任务书。' },
            verify_baseline: { type: 'array', items: { type: 'string' }, description: '派活前必须失败的基线检查命令。' },
            verify: { type: 'array', items: { type: 'string' }, description: '验收命令列表。' },
            fresh: { type: 'boolean', description: '是否强制冷启动。' },
            model: { type: 'string', description: '覆盖本次运行的模型。' },
          },
        },
      },
      concurrency: {
        type: 'integer',
        description: '最大并发任务数（1 到 4，默认 2）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pass: { type: 'integer', required: true },
              fail: { type: 'integer', required: true },
              error: { type: 'integer', required: true },
              unverified: { type: 'integer', required: true },
              stale: { type: 'integer', required: true },
            },
          },
          summary: { type: 'string', required: true },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                round: { type: 'integer' },
                verdict: { type: 'string', required: true },
                stop_reason: { type: 'string' },
                capacity: { type: 'boolean' },
                duration_ms: { type: 'integer' },
                changed_file_count: { type: 'integer' },
                changed_files_determined: { type: 'boolean' },
                continued: { type: 'boolean' },
                report_head: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTeamDigest(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec = {}) {
      return runTeamTasks({
        runtime,
        ctx,
        config,
        args,
        exec,
        verifyDeadline,
        toolDeadlineMs,
      })
    },
  }))
}

/* ── 挂载工厂 ──────────────────────────────────────────────────────── */

/**
 * 实时路由的挂载回执写进 `$DSH_HOME/wolfpack/live-route.log`（一行一次，追加，尽力而为）。
 *
 * 为什么需要它：桌面端的宿主 stderr 看不见（Electron 不落盘），而「右侧实时面板空着」
 * 最常见的原因就是路由没挂上。写完不抛，诊断失败绝不影响挂载。
 *
 * @param {string} message
 */
function liveRouteLog(message) {
  try {
    const base = dirname(LEDGER_PATH)
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, 'live-route.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // 诊断日志失败绝不影响挂载
  }
}

/**
 * 配置回执：把宿主进程此刻真正解析到的工人开关写进 live-route.log。
 *
 * 为什么需要它：设置面板读的是宿主进程里**已加载的那个模块**的 Config schema。
 * 插件文件更新后若宿主没换模块，前端看到的就是没有这些字段的旧 schema——
 * 表现正是「开关显示不对、点了没反应」，而桌面端 stderr 看不见、无从判断。
 * 这一行让「宿主到底加载了哪一版、解析出什么」有据可查（键名列表就是版本指纹）。
 *
 * @param {unknown} config - 当前插件配置。
 * @param {Record<string, unknown>} runtimeConfig - 折算后的运行时配置。
 */
function logConfigReceipt(config, runtimeConfig) {
  const obj = (config !== null && typeof config === 'object') ? config : undefined
  const keys = obj === undefined ? '(非对象)' : Object.keys(obj).join(',')
  const has = key => (obj !== undefined && key in obj) ? 'yes' : 'no'
  const workers = Array.isArray(runtimeConfig.workersEnabled) ? runtimeConfig.workersEnabled.join(',') : String(runtimeConfig.workersEnabled)
  liveRouteLog(
    '配置回执：'
    + `enabled=${String(readVolatile(config, 'enabled', false))}`
    + ` agy_enabled=${String(readVolatile(config, 'agy_enabled', true))}`
    + ` claude_enabled=${String(readVolatile(config, 'claude_enabled', false))}`
    + ` 有claude_enabled=${has('claude_enabled')}`
    + ` 有agy_enabled=${has('agy_enabled')}`
    + ` workers=[${workers}]`
    + ` 配置键=[${keys}]`,
  )
}

function delegationFactory(ctx, config) {
  const runtimeConfig = runConfig(ctx, config)

  function updatePreflight() {
    const agyPreflight = preflightAgy(runtimeConfig.agyPath)
    if (agyPreflight.ok) {
      runtimeConfig.agyPath = agyPreflight.path
    }
    const claudeHit = findInPath(runtimeConfig.claudePath)
    if (claudeHit) {
      runtimeConfig.claudePath = claudeHit
    }

    const enabled = runtimeConfig.workersEnabled
    const targetWorkers = (Array.isArray(enabled) && enabled.length > 0) ? enabled : ['agy', 'claude']
    const availableWorkers = targetWorkers.filter(w => isWorkerAvailable(w, runtimeConfig))

    if (availableWorkers.length === 0) {
      const reasons = targetWorkers.map(w => {
        if (w === 'agy') return `agy: ${agyPreflight.ok ? '可用' : agyPreflight.reason}`
        return `claude: 未找到可执行文件或 PATH 中未找到（路径: ${runtimeConfig.claudePath}）`
      }).join('；')
      runtimeConfig.agyUnavailable = `所有启用的工人均不可用（${reasons}）`
      console.warn(
        `wolfpack: 工人预检未通过——${runtimeConfig.agyUnavailable}。`
        + 'wolf_delegate / wolf_status 仍会注册，但派活会在调用时立刻返回明确的不可用原因，不会挂起等超时。',
      )
    } else {
      delete runtimeConfig.agyUnavailable
    }
  }

  function updateConfig() {
    runtimeConfig.workersEnabled = computeWorkersEnabled(config)
    if (process.env.WOLFPACK_WORKER !== undefined) {
      runtimeConfig.worker = process.env.WOLFPACK_WORKER
    }
    updatePreflight()
    logConfigReceipt(config, runtimeConfig)
  }

  updatePreflight()

  return {
    updateConfig,
    mount() {
      const tools = ctx.get('tools')
      const subprocess = ctx.get('subprocess')
      const subagents = ctx.get('subagents')

      if (tools === undefined || subprocess === undefined || subagents === undefined) {
        const missing = [
          tools === undefined ? 'tools' : undefined,
          subprocess === undefined ? 'subprocess' : undefined,
          subagents === undefined ? 'subagents' : undefined,
        ].filter(Boolean).join(', ')
        console.warn(
          `wolfpack: 委派机制未挂载——缺少服务：${missing}。`
          + '队长指令仍然生效，但 wolf_delegate 工具不可用。',
        )
        return () => {}
      }

      const provider = registerAgyProvider(ctx, runtimeConfig)
      const disposeTool = registerWolfDelegate(ctx, runtimeConfig)
      const disposeStatus = registerWolfStatus(ctx, runtimeConfig)
      const disposeKill = registerWolfKill(ctx, runtimeConfig)
      const disposeTeam = registerWolfTeam(ctx, runtimeConfig)

      const harness = ctx.get?.('harness')
      let disposeHarness
      if (harness !== undefined && typeof harness.handle === 'function') {
        const ledger = runtimeConfig.ledger
        const hLiveRuns = harness.handle('wolf/live-runs', async () => ({
          ok: true,
          runs: listLiveRuns(),
        }))
        const hKillRun = harness.handle('wolf/kill-run', async ({ task_id }) => {
          if (typeof task_id !== 'string' || task_id.trim() === '') {
            return { ok: false, reason: 'task_id 必须是非空字符串' }
          }
          return killRun(task_id, ledger, runtimeConfig)
        })
        disposeHarness = () => {
          try { hLiveRuns?.() } catch {}
          try { hKillRun?.() } catch {}
        }
      }

      const disposeLiveRoute = registerLiveRoute(ctx, runtimeConfig, { log: liveRouteLog })

      console.info(
        `wolfpack: 委派机制已挂载（provider "${provider.name}" + 工具 wolf_delegate/wolf_status/wolf_kill/wolf_team，台账 ${LEDGER_PATH}）`,
      )

      return () => {
        disposeTool()
        disposeStatus()
        disposeKill()
        disposeTeam()
        disposeHarness?.()
        disposeLiveRoute?.()
        if (typeof provider?.dispose === 'function') provider.dispose()
      }
    },
  }
}

/**
 * Host 半。
 *
 * @param ctx - 插件上下文。
 * @param config - 已校验的插件配置；`enabled` 是 volatile 引用，随设置写入就地变化。
 */
export function apply(ctx, config) {
  const enabled = () => readEnabled(config)

  ctx.effect(() => {
    let dispose
    try {
      dispose = ctx.systemPrompt.section({
        name: NS,
        order: 1200,
        text: () => (enabled() ? readBriefing() : ''),
      })
    } catch (error) {
      console.warn('wolfpack: briefing section already registered, keeping the existing one', error)
      return
    }
    return () => { dispose() }
  }, 'wolfpack: captain briefing')

  ctx.effect(() => {
    const delegation = delegationFactory(ctx, config)
    let disposeMount

    const sync = () => {
      delegation.updateConfig?.()
      const on = enabled()
      if (on && disposeMount === undefined) {
        disposeMount = delegation.mount()
      } else if (!on && disposeMount !== undefined) {
        disposeMount()
        disposeMount = undefined
      }
    }

    sync()
    // volatile 配置写入由 loader 就地提交后发出这个事件，开关因此不需要重启宿主。
    const off = ctx.on('loader/volatile-update', sync)
    return () => {
      off?.()
      disposeMount?.()
      disposeMount = undefined
    }
  }, 'wolfpack: agy delegation')
}
