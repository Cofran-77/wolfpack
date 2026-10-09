/**
 * 狼群模式 — agy 委派传输层（`ctx.subagents` provider）。
 *
 * 这是什么：`ctx.subagents` 的一个 provider。DSH 把「一个任务」交进来，
 * 这里起一个 agy 进程、等它跑完、把结果映射成 seam 要求的 SubagentResult。
 *
 * 这不是什么：不是 LLM provider。agy 的 agent loop、工具、权限、会话全都
 * 留在 agy 那一侧，这里一个字节都不介入。
 *
 * 分工：进程、输出限界、续跑、验收、台账全部在 `agy-runner.js`；本文件只是
 * 把 runner 适配成 seam 的形状。模型面入口是 `wolf-delegate.js`，两者共用
 * runner 以保证续跑与判定规则完全一致。
 *
 * 契约出处（逐字核对过）：
 *   packages/subagent/subagent/src/types.ts:344-390   SubagentProvider / SubagentRun / SubagentResult
 *   packages/subprocess/subprocess/src/types.ts:75-105 SubprocessSpawnSpec
 */

import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { DEFAULT_TASK_TIMEOUT_MS, extractConversationId } from './core/worker/agy.mjs'
import { startAgy } from './core/delegate.mjs'
import { createDshRuntime } from './runtime/dsh.mjs'

export { extractConversationId } from './core/worker/agy.mjs'

/** 注册到 ctx.subagents 上的名字。 */
export const PROVIDER_NAME = 'agy'

/**
 * 为什么 agy 不能做持久队员（prepareContinuable / ContinuableSubagentProvider）：
 *
 * 契约依据（packages/subagent/subagent/src/types.ts:231-236, 389）：
 * 1. ContinuableCreateSpec「是 DATA，绝不是能力」——它仅携带 seed 会话事件等静态数据，
 *    绝不携带 Agent、AgentHandle、prompt 投递、结果收集、销毁或恢复等生命周期操作。
 * 2. 续跑管理器（ContinuableManager）自身完全拥有子代理的整个生命周期并在 DSH 内部持有子会话。
 * 3. agy 是运行在父进程之外的外部 CLI 工具，根本不在 DSH 内部子会话执行链路上。
 *
 * 结论：
 * 若给 agy 实现 prepareContinuable，材料化出来的仅是 DSH 内部持有的子会话，外部 agy CLI
 * 完全被旁路，这属于虚报能力的作弊行为（让 AgentTeams 误以为连接了 agy，实际跑的根本不是 agy）。
 *
 * 【纪律约束 / 防作弊红线】：
 * 必须如实拒绝持久队员能力。严禁为了让 AgentTeams 校验通过而把 persona / toolFilter
 * 谎报为 true，亦不可实现虚假的 prepareContinuable。
 */
export const CONTINUABLE_UNSUPPORTED_REASON =
  'agy 为进程外独立 CLI 工具，DSH 续跑管理器自持子代理生命周期且 ContinuableCreateSpec 仅为纯数据，材料化无法接入外部 agy 进程，不可作为持久队员'

/**
 * 摊平 seam 给的 ContentBlock[]。
 * @param {Array<{type: string, text?: string}>} blocks
 * @returns {string}
 */
export function promptText(blocks) {
  return blocks
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n\n')
    .trim()
}

/**
 * 一个 agy 委派传输层。并发安全：每个 run 的进程与计时器都是局部的。
 */
export class AgyProvider {
  /** 注册名。 */
  name = PROVIDER_NAME

  /**
   * CLI provider **不能**兑现父进程侧的启动特性，所以全 false。
   * seam 会在 start 之前拒绝需要 persona/toolFilter 的请求，而不是接受后
   * 静默忽略（types.ts:51-63，"fail loud, no silent degradation"）。
   */
  capabilities = NO_START_CAPABILITIES

  /** agy 看不到我们的对话，这是事实不是缺陷，如实声明。 */
  inheritsParentContext = false

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  /**
   * 起一个一次性 agy 运行。
   * @param {object} request - ResolvedSubagentStartRequest
   * @returns {Promise<object>} SubagentRun
   */
  async start(request) {
    const cwd = request?.parent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(
        'wolfpack/agy: 队长会话没有 cwd，无法确定 agy 的工作目录——'
        + '请从有工作区的会话里委派',
      )
    }

    const task = promptText(request.prompt)
    if (task === '') throw new Error('wolfpack/agy: 任务正文为空')

    const run = await startAgy({
      runtime: createDshRuntime(this.ctx),
      ctx: this.ctx,
      config: this.config,
      taskId: this.taskKeyOf(request),
      cwd,
      task,
      signal: request.signal,
    })

    return {
      id: run.runId,
      // 进程外 provider 没有 in-process child（types.ts:314-320）。
      localAgent: undefined,
      result: run.result.then(outcome => toSubagentResult(outcome)),
      dispose: run.dispose,
    }
  }

  /**
   * 任务键。**同一任务的多轮必须解析出同一个键**，续跑才成立。
   *
   * ⚠️ 这是本文件的已知妥协：seam 的一次性请求里没有「任务身份」字段
   * （`SubagentStartRequest` 只有 label/prompt/parent/signal/agentOptions/…），
   * 所以只能退而用 `request.label`（工具层就是模型给的 `description`，
   * 3–5 个词的展示标签）。两个失效模式：
   *   1. 模型换个措辞 → 键变了 → 退化成冷启动（不是错，只是没赚到）；
   *   2. 两个不相关的任务用了同一个标签 → 错误续跑（这是错）。
   *
   * 所以**模型面不要走这个 provider**，走 `wolf_delegate` 工具：它有显式的
   * `task_id`，没有这两个失效模式。provider 只作为 seam 的互操作入口保留。
   *
   * @param {object} request
   * @returns {string|undefined} undefined = 每轮冷启动（安全降级）
   */
  taskKeyOf(request) {
    const label = request?.label
    return typeof label === 'string' && label.trim() !== '' ? label.trim() : undefined
  }
}

/**
 * runner 的结果 → seam 的 SubagentResult（types.ts:271-297）。
 * @param {object} outcome
 * @returns {object}
 */
export function toSubagentResult(outcome) {
  const result = {
    output: outcome.report === '' ? [] : [{ type: 'text', text: outcome.report }],
    stopReason: outcome.stopReason,
  }
  if (typeof outcome.diagnostic === 'string' && outcome.diagnostic !== '') {
    result.diagnostic = outcome.diagnostic
  }
  return result
}

/**
 * 注册 provider。
 * @param {object} ctx - 需要 ctx.subagents 与 ctx.subprocess
 * @param {object} config - agyPath / ledger / timeoutMs / continuation / maxRoundsPerTask
 * @returns {AgyProvider}
 */
export function registerAgyProvider(ctx, config) {
  const subagents = ctx.get?.('subagents')
  if (subagents === undefined) {
    throw new Error('wolfpack/agy: subagents 服务不可用——委派机制无法注册')
  }
  const provider = new AgyProvider(ctx, {
    timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    ...config,
  })
  subagents.registerProvider(provider)
  return provider
}
