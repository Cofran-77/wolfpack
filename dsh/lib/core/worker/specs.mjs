/**
 * 工人规格表（Worker Specifications Registry）
 *
 * 铁律：本文件里每个 flag / argv 只能来自 _probe/WORKER-CONTRACTS.md 里带 source URL 的条目；
 * 查不到的字段写 unknown，不得主观臆测。本仓库未安装、未运行任何被测 CLI。
 */

/** 核心工人名称（由既有原生适配器提供，非声明式规格） */
export const CORE_WORKER_NAMES = ['agy', 'claude']

/** 声明式工人规格定义表 */
export const WORKER_SPECS = [
  // 1. OpenAI Codex CLI
  {
    name: 'codex',
    label: 'OpenAI Codex CLI',
    vendor: 'OpenAI',
    bin: 'codex',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://developers.openai.com/codex/noninteractive',
      'https://raw.githubusercontent.com/openai/codex/main/docs/exec.md',
    ],
    notes: '非 git 仓库必须 --skip-git-repo-check',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['exec', task, '--json', '--skip-git-repo-check']
      if (model) args.push('--model', model)
      if (autoApprove) args.push('--sandbox', 'workspace-write')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['exec', 'resume']
      if (sessionId) {
        args.push(sessionId)
      } else {
        args.push('--last')
      }
      args.push(task, '--json', '--skip-git-repo-check')
      return args
    },
    output: 'jsonl',
    extractFinalText(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type === 'item.completed' && e?.item?.type === 'agent_message' && typeof e?.item?.text === 'string') {
          return e.item.text
        }
      }
      return undefined
    },
    extractSessionId(events) {
      if (!Array.isArray(events)) return undefined
      for (const e of events) {
        if (e?.type === 'thread.started' && typeof e?.thread_id === 'string') {
          return e.thread_id
        }
      }
      return undefined
    },
    extractUsage(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type === 'turn.completed') {
          const input = typeof e.input_tokens === 'number' ? e.input_tokens : undefined
          const output = typeof e.output_tokens === 'number' ? e.output_tokens : undefined
          const cacheRead = typeof e.cached_input_tokens === 'number' ? e.cached_input_tokens : undefined
          const thinking = typeof e.reasoning_output_tokens === 'number' ? e.reasoning_output_tokens : undefined
          return {
            total: (input ?? 0) + (output ?? 0),
            input,
            output,
            cacheRead,
            thinking,
          }
        }
      }
      return undefined
    },
    extractError(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type === 'error' && e?.message) return e.message
        if (e?.type === 'turn.failed' && e?.error) return e.error
      }
      return undefined
    },
    modelFlag: ['--model'],
    autoApproveFlags: ['--sandbox', 'workspace-write'],
  },

  // 2. Google Gemini CLI
  {
    name: 'gemini',
    label: 'Google Gemini CLI',
    vendor: 'Google',
    bin: 'gemini',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/headless.md',
      'https://geminicli.com/docs/cli/headless/',
    ],
    notes: '非 TTY 自动进 headless',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['-p', task, '--output-format', 'json']
      if (model) args.push('--model', model)
      if (autoApprove) args.push('--approval-mode', 'auto_edit')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['-p', task, '--output-format', 'json', '--resume', sessionId || 'latest']
      return args
    },
    output: 'json',
    extractFinalText(obj) {
      return typeof obj?.response === 'string' ? obj.response : undefined
    },
    extractSessionId(obj) {
      return typeof obj?.session_id === 'string'
        ? obj.session_id
        : (typeof obj?.stats?.session_id === 'string' ? obj.stats.session_id : undefined)
    },
    extractUsage(obj) {
      const stats = obj?.stats
      if (!stats || typeof stats !== 'object') return undefined
      const input = typeof stats.input_tokens === 'number' ? stats.input_tokens : undefined
      const output = typeof stats.output_tokens === 'number' ? stats.output_tokens : undefined
      return {
        total: (input ?? 0) + (output ?? 0),
        input,
        output,
        cacheRead: typeof stats.cached_tokens === 'number' ? stats.cached_tokens : undefined,
      }
    },
    extractError(obj) {
      if (typeof obj?.error === 'string') return obj.error
      if (typeof obj?.error?.message === 'string') return obj.error.message
      return undefined
    },
    modelFlag: ['--model'],
    autoApproveFlags: ['--approval-mode', 'auto_edit'],
  },

  // 3. Alibaba Qwen Code
  {
    name: 'qwen',
    label: 'Alibaba Qwen Code',
    vendor: 'Alibaba',
    bin: 'qwen',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/headless.md',
    ],
    notes: 'json 输出是数组；headless 下 --resume 必须显式传 id',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['-p', task, '--output-format', 'json']
      if (model) args.push('--model', model)
      if (autoApprove) args.push('--approval-mode', 'auto-edit')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['-p', task, '--output-format', 'json']
      if (sessionId) {
        args.push('--resume', sessionId)
      } else {
        args.push('--continue')
      }
      return args
    },
    output: 'json',
    extractFinalText(val) {
      if (Array.isArray(val)) {
        for (let i = val.length - 1; i >= 0; i--) {
          if (val[i]?.type === 'result' && typeof val[i]?.result === 'string') {
            return val[i].result
          }
        }
      } else if (val && typeof val === 'object') {
        return typeof val.result === 'string' ? val.result : undefined
      }
      return undefined
    },
    extractSessionId(val) {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item?.session_id === 'string' && item.session_id) {
            return item.session_id
          }
        }
      } else if (val && typeof val === 'object') {
        return typeof val.session_id === 'string' ? val.session_id : undefined
      }
      return undefined
    },
    extractUsage(val) {
      if (Array.isArray(val)) {
        for (let i = val.length - 1; i >= 0; i--) {
          const u = val[i]?.usage
          if (u && typeof u === 'object') {
            const input = typeof u.input_tokens === 'number' ? u.input_tokens : undefined
            const output = typeof u.output_tokens === 'number' ? u.output_tokens : undefined
            return {
              total: (input ?? 0) + (output ?? 0),
              input,
              output,
            }
          }
        }
      }
      return undefined
    },
    extractError(val) {
      if (Array.isArray(val)) {
        for (let i = val.length - 1; i >= 0; i--) {
          const item = val[i]
          if (item?.is_error || item?.subtype === 'error') {
            return item.error || item.result || 'qwen execution error'
          }
        }
      }
      return undefined
    },
    modelFlag: ['--model'],
    autoApproveFlags: ['--approval-mode', 'auto-edit'],
  },

  // 4. opencode CLI
  {
    name: 'opencode',
    label: 'opencode CLI',
    vendor: 'sst',
    bin: 'opencode',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://opencode.ai/docs/cli/',
    ],
    notes: '输出为 JSONL 事件流；没有 --json，使用 --format json',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['run', task, '--format', 'json']
      if (model) args.push('--model', model)
      if (autoApprove) args.push('--auto')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['run', task, '--format', 'json']
      if (sessionId) {
        args.push('--session', sessionId)
      } else {
        args.push('--continue')
      }
      return args
    },
    output: 'jsonl',
    extractFinalText(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (typeof e?.part?.text === 'string') return e.part.text
        if (typeof e?.message?.content === 'string') return e.message.content
        if (typeof e?.text === 'string') return e.text
      }
      return undefined
    },
    extractSessionId(events) {
      if (!Array.isArray(events)) return undefined
      for (const e of events) {
        if (typeof e?.sessionID === 'string' && e.sessionID) return e.sessionID
        if (typeof e?.sessionId === 'string' && e.sessionId) return e.sessionId
      }
      return undefined
    },
    extractUsage(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const u = events[i]?.usage
        if (u && typeof u === 'object') {
          const input = typeof u.input_tokens === 'number' ? u.input_tokens : undefined
          const output = typeof u.output_tokens === 'number' ? u.output_tokens : undefined
          return {
            total: (input ?? 0) + (output ?? 0),
            input,
            output,
          }
        }
      }
      return undefined
    },
    extractError(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'error' && events[i]?.error) {
          return typeof events[i].error === 'string' ? events[i].error : events[i].error.message
        }
      }
      return undefined
    },
    modelFlag: ['--model'],
    autoApproveFlags: ['--auto'],
  },

  // 5. iFlow CLI（心流）
  {
    name: 'iflow',
    label: 'iFlow CLI',
    vendor: 'iFlow',
    bin: 'iflow',
    tier: 'opt-in',
    contract: 'unknown',
    confidence: 'unknown',
    source: [
      'https://raw.githubusercontent.com/iflow-ai/iflow-cli/main/README.md',
    ],
    notes: '官方 README 声明 iFlow CLI 于 2026-04-17 (UTC+8) 关停；未查到非交互 argv 契约',
  },

  // 6. Crush CLI
  {
    name: 'crush',
    label: 'Crush CLI',
    vendor: 'Charm',
    bin: 'crush',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://charm.land/crush/cli/run',
    ],
    notes: 'resume 只见于源码与示例注释，文档 Flags 表未列；且文档明说 run 的 session 默认不存历史 → 该字段有失效风险',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['run', task, '--quiet']
      if (autoApprove) args.push('--yolo')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['run']
      if (sessionId) {
        args.push('--session', sessionId)
      } else {
        args.push('--continue')
      }
      args.push(task, '--quiet')
      return args
    },
    output: 'text',
    autoApproveFlags: ['--yolo'],
  },

  // 7. Goose CLI
  {
    name: 'goose',
    label: 'Goose CLI',
    vendor: 'Block',
    bin: 'goose',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://block.github.io/goose/docs/guides/goose-cli-commands',
    ],
    notes: 'json 顶层字段名 unknown；autoApprove 只能靠环境变量，规格里 autoApproveFlags: null；输出格式未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['run', '-t', task, '--quiet']
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['run', '-r']
      if (sessionId) {
        args.push('--session-id', sessionId)
      }
      args.push('-t', task, '--quiet')
      return args
    },
    output: 'text',
    autoApproveFlags: null,
  },

  // 8. Aider
  {
    name: 'aider',
    label: 'Aider',
    vendor: 'Paul Gauthier',
    bin: 'aider',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'medium',
    source: [
      'https://aider.chat/docs/scripting.html',
    ],
    notes: '文档与源码在 --yes 上冲突（已按源码取 --yes-always）；通常还需 <files> 参数，无文件时行为未验证；无 session id',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['--message', task]
      if (model) args.push('--model', model)
      if (autoApprove) args.push('--yes-always')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      return ['--restore-chat-history', '--message', task]
    },
    output: 'text',
    modelFlag: ['--model'],
    autoApproveFlags: ['--yes-always'],
  },

  // 9. GitHub Copilot CLI
  {
    name: 'copilot',
    label: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    bin: 'copilot',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference',
    ],
    notes: '-p 模式的 JSONL 字段名完全未文档化；--output-format 在 -p 可用是 changelog/PR 佐证而非命令参考表；输出格式未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['-p', task, '-s']
      if (autoApprove) args.push('--allow-all-tools')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['-p', task, '-s']
      if (sessionId) {
        args.push(`--resume=${sessionId}`)
      } else {
        args.push('--continue')
      }
      return args
    },
    output: 'text',
    autoApproveFlags: ['--allow-all-tools'],
  },

  // 10. Cursor Agent CLI
  {
    name: 'cursor',
    label: 'Cursor Agent CLI',
    vendor: 'Anysphere',
    bin: 'agent',
    binAliases: ['cursor-agent'],
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://cursor.com/docs/cli/headless',
    ],
    notes: '官方主 bin 是 agent，cursor-agent 是 legacy 别名（install 脚本注释 "primary: agent, legacy: cursor-agent"）；agent 名字很通用，装机者注意 PATH 撞名',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['-p', task, '--output-format', 'json']
      if (model) args.push('--model', model)
      if (autoApprove) args.push('--force')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['-p', task, '--output-format', 'json']
      if (sessionId) {
        args.push('--resume', sessionId)
      } else {
        args.push('--continue')
      }
      return args
    },
    output: 'json',
    extractFinalText(val) {
      if (val && typeof val === 'object' && typeof val.result === 'string') {
        return val.result
      }
      return undefined
    },
    modelFlag: ['--model'],
    autoApproveFlags: ['--force'],
  },

  // 11. Amp
  {
    name: 'amp',
    label: 'Amp',
    vendor: 'Sourcegraph',
    bin: 'amp',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://ampcode.com/docs',
    ],
    notes: 'approve flag unknown；AMP_API_KEY 必须 sgamp_ 前缀',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['-x', task, '--stream-json']
    },
    resumeArgv(spec, { task, sessionId }) {
      return ['threads', 'continue', '--execute', task, '--stream-json']
    },
    output: 'jsonl',
    extractFinalText(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type === 'result' && typeof e?.result === 'string') return e.result
        if (e?.type === 'result' && typeof e?.text === 'string') return e.text
        if (e?.type === 'assistant' && typeof e?.text === 'string') return e.text
      }
      return undefined
    },
    extractSessionId(events) {
      if (!Array.isArray(events)) return undefined
      for (const e of events) {
        if (typeof e?.session_id === 'string' && e.session_id) return e.session_id
      }
      return undefined
    },
    autoApproveFlags: null,
  },

  // 12. Factory Droid
  {
    name: 'droid',
    label: 'Factory Droid',
    vendor: 'Factory',
    bin: 'droid',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://docs.factory.com',
      'https://registry.npmjs.org/droid',
    ],
    notes: '多轮交互走 stream-jsonrpc（旧 stream-json 输入属遗留，原句截断，medium）',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['exec', task, '-o', 'json']
      if (autoApprove) args.push('--auto', 'high')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['exec']
      if (sessionId) {
        args.push('-s', sessionId)
      }
      args.push(task, '-o', 'json')
      return args
    },
    output: 'json',
    extractFinalText(obj) {
      if (obj && typeof obj === 'object' && typeof obj.result === 'string') {
        return obj.result
      }
      return undefined
    },
    extractSessionId(obj) {
      return typeof obj?.session_id === 'string' ? obj.session_id : undefined
    },
    autoApproveFlags: ['--auto', 'high'],
  },

  // 13. Auggie
  {
    name: 'auggie',
    label: 'Auggie',
    vendor: 'Augment',
    bin: 'auggie',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://docs.augmentcode.com',
      'https://registry.npmjs.org/@augmentcode/auggie',
    ],
    notes: '无 yolo；json 顶层字段名未取证',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['--print', task, '--output-format', 'json']
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['--print']
      if (sessionId) {
        args.push('-r', sessionId)
      } else {
        args.push('-c')
      }
      args.push(task, '--output-format', 'json')
      return args
    },
    output: 'json',
    extractFinalText(obj) {
      if (obj && typeof obj === 'object') {
        if (typeof obj.response === 'string') return obj.response
        if (typeof obj.result === 'string') return obj.result
      }
      return undefined
    },
    extractSessionId(obj) {
      if (obj && typeof obj === 'object') {
        if (typeof obj.session_id === 'string') return obj.session_id
        if (typeof obj.sessionId === 'string') return obj.sessionId
        if (typeof obj.id === 'string') return obj.id
      }
      return undefined
    },
    autoApproveFlags: null,
  },

  // 14. Cline CLI
  {
    name: 'cline',
    label: 'Cline CLI',
    vendor: 'Cline',
    bin: 'cline',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://docs.cline.bot',
    ],
    notes: 'NDJSON 顶层 type；文本在 agent_event.event.text 一类事件内',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = [task, '--json']
      if (autoApprove) args.push('--yolo')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      return [task, '--json']
    },
    output: 'jsonl',
    extractFinalText(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (typeof e?.agent_event?.event?.text === 'string') return e.agent_event.event.text
        if (typeof e?.text === 'string') return e.text
      }
      return undefined
    },
    autoApproveFlags: ['--yolo'],
  },

  // 15. Continue CLI
  {
    name: 'continue',
    label: 'Continue CLI',
    vendor: 'Continue',
    bin: 'cn',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://registry.npmjs.org/@continuedev/cli',
    ],
    notes: '证据来自 npm 元数据；approve 与 key 环境变量 unknown；字段名未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['-p', task, '--format', 'json']
    },
    resumeArgv(spec, { task, sessionId }) {
      return ['-p', task, '--format', 'json', '--resume']
    },
    output: 'json',
    extractFinalText(val) {
      if (val && typeof val === 'object') {
        if (typeof val.response === 'string') return val.response
        if (typeof val.result === 'string') return val.result
      }
      if (typeof val === 'string') return val
      return undefined
    },
    autoApproveFlags: null,
  },

  // 16. OpenHands
  {
    name: 'openhands',
    label: 'OpenHands',
    vendor: 'All-Hands AI',
    bin: 'openhands',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://docs.openhands.dev',
    ],
    notes: '--json 事件只有 {"type":"action"|"observation"}，最终文本需自行拼接；npm 上的 openhands 是占位包，真正安装方式见官方文档',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['--headless', '-t', task, '--json']
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['--headless', '-t', task, '--json']
      if (sessionId) {
        args.push('--resume', sessionId)
      } else {
        args.push('--last')
      }
      return args
    },
    output: 'jsonl',
    extractFinalText(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (typeof e?.message === 'string') return e.message
        if (typeof e?.content === 'string') return e.content
        if (typeof e?.observation?.content === 'string') return e.observation.content
      }
      return undefined
    },
    autoApproveFlags: null,
  },

  // 17. Warp Oz
  {
    name: 'oz',
    label: 'Warp Oz',
    vendor: 'Warp',
    bin: 'oz',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'medium',
    source: [
      'https://docs.warp.dev',
    ],
    notes: 'Warp 双 bin warp/oz，只有 oz 有无头模式；warp 本体无一次性 prompt；output-format 未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['agent', 'run', '--prompt', task]
    },
    output: 'text',
    autoApproveFlags: null,
  },

  // 18. Plandex
  {
    name: 'plandex',
    label: 'Plandex',
    vendor: 'Plandex',
    bin: 'plandex',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'medium',
    source: [
      'https://github.com/plandex-ai/plandex',
    ],
    notes: 'plandex.ai 全程 TLS 失败，证据回退到 GitHub 源码；输出格式未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['tell', task]
    },
    resumeArgv(spec, { task, sessionId }) {
      return ['continue', task]
    },
    output: 'text',
    autoApproveFlags: null,
  },

  // 19. Kimi Code CLI
  {
    name: 'kimi',
    label: 'Kimi Code CLI',
    vendor: 'Moonshot AI',
    bin: 'kimi',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://moonshotai.github.io/kimi-code',
    ],
    notes: '-p 与 --yolo/--auto 的关系原文表述含糊；auth 走 config.toml 的 api_key_env（export 无效）；stream-json 内的 session id 文档未列',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['-p', task, '--output-format', 'stream-json']
      if (autoApprove) args.push('--yolo')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['-p', task, '--output-format', 'stream-json']
      if (sessionId) {
        args.push('--session', sessionId)
      } else {
        args.push('-c')
      }
      return args
    },
    output: 'jsonl',
    extractFinalText(events) {
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (typeof e?.text === 'string') return e.text
        if (typeof e?.content === 'string') return e.content
        if (typeof e?.delta === 'string') return e.delta
      }
      return undefined
    },
    autoApproveFlags: ['--yolo'],
  },

  // 20. MiniMax Code
  {
    name: 'mcode',
    label: 'MiniMax Code',
    vendor: 'MiniMax',
    bin: 'mcode',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'medium',
    source: [
      'https://registry.npmjs.org/@minimax-ai/code',
    ],
    notes: 'json 顶层结构、自身 key 环境变量、--permission 取值全 unknown；输出格式未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['exec', task]
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['exec']
      if (sessionId) {
        args.push('--session', sessionId)
      } else {
        args.push('--continue')
      }
      args.push(task)
      return args
    },
    output: 'text',
    autoApproveFlags: null,
  },

  // 21. CodeBuddy CLI
  {
    name: 'codebuddy',
    label: 'CodeBuddy CLI',
    vendor: 'Tencent',
    bin: 'codebuddy',
    binAliases: ['cbc'],
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://codebuddy.cn/docs/cli',
    ],
    notes: '腾讯；是唯一「-p 模式也必须显式放权」的 CLI，--dangerously-skip-permissions 不可省',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['-p', task, '--output-format', 'json', '--dangerously-skip-permissions']
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['-p', task, '--output-format', 'json', '--dangerously-skip-permissions']
      if (sessionId) {
        args.push('--resume', sessionId)
      } else {
        args.push('-r')
      }
      return args
    },
    output: 'json',
    extractFinalText(obj) {
      return typeof obj?.response === 'string' ? obj.response : undefined
    },
    extractSessionId(obj) {
      return typeof obj?.sessionId === 'string'
        ? obj.sessionId
        : (typeof obj?.session_id === 'string' ? obj.session_id : undefined)
    },
    autoApproveFlags: ['--dangerously-skip-permissions'],
  },

  // 22. Qoder CN
  {
    name: 'qoder',
    label: 'Qoder CN',
    vendor: 'Alibaba',
    bin: 'qoder',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://docs.qoder.com/cli',
    ],
    notes: '通义灵码（Lingma）于 2026-05-20 更名为 Qoder CN，不存在独立的「灵码 CLI」，同一产品；字段名未取证；输出格式未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      const args = ['-p', task]
      if (autoApprove) args.push('--yolo')
      return args
    },
    resumeArgv(spec, { task, sessionId }) {
      const args = ['-p', task]
      if (sessionId) {
        args.push('--session-id', sessionId)
      } else {
        args.push('-c')
      }
      return args
    },
    output: 'text',
    autoApproveFlags: ['--yolo'],
  },

  // 23. Trae Agent
  {
    name: 'trae',
    label: 'Trae Agent',
    vendor: 'ByteDance',
    bin: 'trae-cli',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'high',
    source: [
      'https://github.com/bytedance/trae-agent',
    ],
    notes: '与 Trae IDE 不是同一产品；用 pip/uv 安装（不是 npm），装机者需自行准备；无 JSON 输出',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['run', task]
    },
    output: 'text',
    autoApproveFlags: null,
  },

  // 24. Baidu Comate CLI
  {
    name: 'comate',
    label: 'Baidu Comate CLI',
    vendor: 'Baidu',
    bin: 'comatecli',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'medium',
    source: [
      'https://registry.npmjs.org/@comate/comatecli',
    ],
    notes: '百度；完整 flag/事件名/auth 均 unknown（comate.baidu.com/zh/docs 404）；输出格式未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['run', '-q', task]
    },
    output: 'text',
    autoApproveFlags: null,
  },

  // 25. iFLYTEK Spark CLI
  {
    name: 'spark',
    label: 'iFLYTEK Spark CLI',
    vendor: 'iFLYTEK',
    bin: 'aispark',
    tier: 'opt-in',
    contract: 'documented',
    confidence: 'medium',
    source: [
      'https://github.com/iflytek/spark-ai-cli',
    ],
    notes: '讯飞星火；输出/resume unknown；输出格式未文档化',
    prompt: 'argv',
    argv(spec, { task, sessionId, model, autoApprove }) {
      return ['q', task]
    },
    output: 'text',
    autoApproveFlags: null,
  },

  // 26. Freebuff / Codebuff
  {
    name: 'codebuff',
    label: 'Freebuff / Codebuff',
    vendor: 'Freebuff',
    bin: 'codebuff',
    binAliases: ['cb'],
    tier: 'opt-in',
    contract: 'unknown',
    confidence: 'unknown',
    source: [
      'https://registry.npmjs.org/codebuff',
      'https://freebuff.com',
    ],
    notes: 'headless 契约全 unknown；npm codebuff@1.0.688 未标 deprecated，但 README 已改名 Freebuff、官方包转 freebuff@0.2.26',
  },
]

