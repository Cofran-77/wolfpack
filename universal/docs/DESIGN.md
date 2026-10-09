# Wolfpack 宿主 AI 架构设计文档

本文档说明 `wolfpack-codex` 的模块职责、适配器契约，以及与 `dsh-wolfpack` 参考实现的文件对应关系。

---

## 一、模块映射关系

| wolfpack-codex 文件 | 对应 dsh-wolfpack 源文件 | 核心职责与改动说明 |
| --- | --- | --- |
| `src/config.mjs` | `lib/index.js` (部分) | 配置解析（环境变量 → `wolfpack.config.json` → 平台默认），杜绝绝对路径 |
| `src/spawn.mjs` | `ctx.subprocess` (Cordis) | **唯一**子进程出口，封装 `node:child_process`，实现 Windows 与 Unix 强力进程树杀灭 |
| `src/verify.mjs` | `lib/agy-runner.js:1590-1719` | 验收与基线命令执行（支持 `WOLFPACK_SHELL` 覆盖），基线闸门判定，失败信号提取 |
| `src/ledger.mjs` | `lib/runs-ledger.js` | NDJSON 追加写与增量读折叠，同 `task_id` 独占锁（拒绝并发），文件原子压缩 |
| `src/delegate.mjs` | `lib/wolf-delegate.js` + `lib/agy-runner.js` | 核心委派流程：基线闸门 → 独占锁 → 快照 → 工人 → 产物差集 → 验收 → 判定政策与机械救回 → 台账（**派发即写 `running`，收工补结果**，中途被掐断的派发也留痕） |
| `src/digest.mjs` | `lib/wolf-delegate.js:119-220` | 有界 digest 渲染：严格区分「队员声称」与「我已核实」，诚实展示诊断与 tail 降级 |
| `src/team.mjs` | `lib/wolf-team.js` | 多工人并发扇出、入参严格校验、重复 `task_id` 整批拒绝、单任务失败隔离、摘要收敛 |
| `src/worker/agy.mjs` | `lib/agy-runner.js` (适配部分) | agy 工人适配器契约实现（参数拼装、会话延续、结果分类、心跳探针） |
| `src/worker/claude.mjs` | 新增 | Claude Code CLI 工人适配器（`-p --output-format json`、`--resume` 续跑、`--json-schema` 结构化输出、读取子智能体用量） |
| `src/worker/index.mjs` | 新增 | 工人适配器注册表（agy / claude）+ **全自动工人选择**（可用性探测、续跑粘性、轮换、显式偏好回退） |
| `src/worker/health.mjs` | 新增 | 工人健康台账：故障分类记账、冷却期、原子写与串行读改写；`snapshotHealth()` 供 digest / status / 面板只读展示 |
| `src/worker/faults.mjs` | 新增 | 工人故障识别：容量/额度（含 API 中转池子 `402`、`无可用渠道`、`额度不足`）、鉴权失败、超时、无输出，与「任务本身失败」区分 |
| `src/stall.mjs` | `lib/core/stall-monitor.mjs` | 停滞监控内核（**逐工人参数化**：agy 看 brain/conversations，claude 看 `~/.claude/projects`）。窗口 1×/2×/3× 各报一次，**只报警、永不终止** |
| `src/live-transcript.mjs` | `lib/live-route.js`（解析部分） | 两份独立会话流水解析（claude 的 `message.content[]` / agy 的 `step_index + tool_calls`），64KB 尾读 + LRU 缓存 |
| `src/live-route.mjs` | `lib/live-route.js` + `lib/core/**` | 实时路由与有界 payload（32KB 上限，**按工人分区**，轮转取样保证两个工人都出现）；`/wolfpack/live`、`/wolfpack/panel`、`/wolfpack/health` |
| `src/panel-html.mjs` + `src/panel-client.js` | `lib/client.js` | 零构建、零依赖的面板：服务端内联脚本，浏览器端每 3 秒拉 `/wolfpack/live`，两个工人各一个 `<section>` |
| `src/runtime/registry.mjs` | —（宿主无关核） | 运行时注入表：核心层只认 `resolveRuntime()`，绝不 import 宿主模块 |
| `src/runtime/node.mjs` | `lib/runtime/node.mjs` | Node 宿主实现：转发 `spawnProcess` / `killProcessTree`，并把 macOS 通知中心接到停滞报警（导入即注入） |
| `src/runtime/dsh.mjs` | `lib/runtime/dsh.mjs` | DSH（Cordis）宿主实现：把 `collected.stdout.readFrom(offset)` 归一成内核契约 |
| `bin/wolf.mjs` | 新增独立 CLI | 包含 `delegate` / `status` / `kill` / `team` / `live` / `panel` / `health` 子命令，零运行时依赖 |
| `bin/wolf-mcp.mjs` | 新增 MCP stdio 服务 | 手写 JSON-RPC 2.0，暴露 `wolf_delegate` / `wolf_status` / `wolf_kill` / `wolf_team` / `wolf_live` / `wolf_panel` |

---

## 二、工人适配器契约 (Worker Adapter Contract)

每个工人适配器（如 `agyWorker`）必须导出如下契约对象：

```javascript
{
  // 适配器唯一名称
  name: 'agy',

  // 挂载/执行前预检工人可执行文件
  preflight(cfg): { ok: boolean, path: string, reason?: string },

  // 组装命令行启动参数数组（argv）
  // 铁律：续跑只用 --conversation <id>，绝不使用 -c
  buildArgv(cfg, { task, sessionId, timeoutMs }): string[],

  // 从 stdout 字符串中提取会话 ID
  extractSessionId(stdout): string | undefined,

  // 解析 stdout 结构化与自由文本字段
  parse(stdout): {
    conversationId?: string,
    status?: string,
    error?: string,
    response?: string,
    durationSeconds?: number,
    numTurns?: number,
    usage?: { total?: number, input?: number, output?: number, thinking?: number, cacheRead?: number, turns?: number },
    structuredOutput?: unknown,
    structuredReport?: { summary?: string, claimedFiles?: string[] }
  } | undefined,

  // 映射工人退出态为核心 stopReason
  // 核心铁律：产物存在即完成（即使工人自报 ERROR 或退出码非零）
  classify({ parsed, exitCode, artifacts, timedOut, cancelled, raw, stderr }): {
    stopReason: 'completed' | 'error' | 'aborted' | 'capacity',
    capacity?: boolean,
    diagnostic?: string
  },

  // 停滞监控心跳探针
  // 若无可靠心跳则返回 undefined，此时跳过停滞监控，绝不编造
  progressProbe(cfg, { sessionId, cwd }): undefined | { ... }
}
```

---

### 工人自动选择（Auto Worker Selection）

调用方**不能**指定工人（`worker` 参数已从 CLI 与 MCP 接口移除）；`resolveWorkerSelection()` 每次委派时按以下顺序决定：

1. **可用性探测**：`preflight()` 校验配置的路径；绝对路径/带分隔符路径只探测存在性，裸命令名（`agy` / `claude`）才按 `PATH` 查找。一个都没有 → 抛可读错误，绝不假装跑过。
2. **显式偏好**：配置写了 `worker: agy|claude` 就用它；若它当前不可用，自动回退到另一个可用工人，并在 digest 里如实标注 `fallback(<工人>-unavailable)`。
3. **唯一可用**：只装了一个工人就用它（`only-available`）。
4. **续跑粘性**：同一 `task_id` 上一轮的工人在台账里，且仍可用 → 沿用（`continuation`）。会话 ID 只在各自 CLI 内有效，禁止跨工人复用。
5. **轮换**：两个工人都在 → 进程内游标交替派活（`rotation`），让 `agy` 与 `claude` 都真正承担执行；并发小队因此天然把负载摊到两个工人上。

每次委派的返回值都带 `worker`（真实工人）与 `worker_reason`（上述取值之一），并写入台账，便于事后核对本轮是谁干的。

---

### 运行时注入（Runtime Injection）

核心层（`delegate.mjs` / `team.mjs` / `verify.mjs`）不直接 import 任何宿主模块：所有进程派生都走 `resolveRuntime(runtimeOrCtx)` 解析出来的运行时（显式传入 > 注入的默认实现 > 内置 Node 兜底）。宿主在自己的入口注入实现：

- Node 宿主（CLI / MCP）import `src/runtime/node.mjs` 即可，模块末尾会 `setDefaultRuntime(new NodeRuntime())`。
- DSH 一类自带 `ctx.subprocess` 的宿主改用 `src/runtime/dsh.mjs` 的 `createDshRuntime(ctx)`；适配层只做句柄归一（`.stdout.text` 等），不解释沙箱与 spill 语义。

停滞报警这类宿主专有外设同样走注入：核心层只调 `config.stallToastNotifier`（有就调、没有就算），桌面通知由宿主自己决定弹不弹。

---

### 实时面板与停滞监控

**两个工人各有一套，互不借用**：

| | `agy` | `claude` |
| --- | --- | --- |
| 会话存储根 | `~/.gemini/antigravity-cli` | `~/.claude/projects`（**Claude Code CLI**，不是 Claude Desktop） |
| 停滞判据 | `conversations/<id>.db*` + `brain/<id>/.system_generated/logs/transcript*.jsonl` 的 mtime | `<项目目录>/<sessionId>.jsonl` 的 mtime（项目目录名 = cwd realpath 的非字母数字替换为 `-`） |
| 流水解析 | `step_index` / `tool_calls` / `thinking` / `content` / `status` | `message.content[]` 的 `thinking` / `text` / `tool_use` / `tool_result` |
| 首轮未拿到会话 ID 时 | 只有在**恰好一个 agy 运行在跑**时按 `brain/` 最新会话兜底，多开时如实显示「会话 ID 尚未产生」 | 按工作目录下最新的 `<sessionId>.jsonl` 兜底 |

停滞监控默认每 30 秒采样一次、5/10/15 分钟各报一次、之后闭嘴，**没有任何终止能力**（`createStallMonitor()` 返回的对象只有 `start/stop/poll/snapshot`）。报警写入 `stall.ndjson`，并把该工人自己的快照写进活运行登记（`<rawDir>/live/<taskId>.json`），供**另一个进程**的面板分开展示。

面板与 MCP 是两个进程：进程内的 `liveRuns` 带活的 `stallMonitor`，磁盘登记文件补上别的进程派发的任务，两者按 `task_id` 合并（`mergeLiveRecords()`），进程内条目优先。响应体严格约束在 32KB（先压停滞快照为白名单标量，再逐级裁剪流水事件与运行条数），且**轮转取样**保证有界响应里两个工人都不会被挤掉。

---

### 工人健康与自动冷却（Worker Health / Auto-Bench）

要解决的问题：CLI 装着但没登录、API 中转池子额度耗尽、进程挂着不说话——这类状态里工人**看起来可用**，于是每一轮都被挑中、每一轮都失败一遍。

设计要点：

1. **故障分类与任务判定解耦**：`src/worker/faults.mjs` 只回答「这是不是工人自己的毛病」，判据是 `stopReason`、超时/取消标志、输出是否为空，以及结构化错误字段与 stderr 上的状态码/文案（**整段 stdout 只允许匹配窄模式**，避免把工人正文里的日常用语误判成故障）。`capacity` 与 `auth` 两类都必须在中转场景下成立：`402`、`429`、`insufficient_user_quota`、`no available channel`、`无可用渠道`、`额度不足`、`401`、`invalid API key` 等。
2. **健康台账**（`src/worker/health.mjs`）：`{ workers: { <name>: { consecutiveFailures, totalFailures, benchedUntil, benchReason, lastReason, lastDiagnostic, lastSuccessAt } } }`，默认落在 `<台账目录>/worker-health.json`。写入走「同进程串行队列 + 临时文件原子 rename」；读取容错——文件缺失、JSON 损坏、结构不对一律退化为空台账，**绝不因为台账问题拦下派活**。
3. **冷却策略**：工人自身故障（capacity / auth / timeout / no-output）**当轮即冷却**；普通失败（error）累计到 `failThreshold`（默认 2）才冷却。冷却时长按类型区分：容量 5 分钟、超时与普通失败 10 分钟、鉴权 30 分钟；到期自动恢复，无需人去清。
4. **选择器接线**（`resolveWorkerSelection`）：只影响挑选。可用的工人先减掉冷却中的，再走「唯一可用 / 续跑沿用 / 轮换」；两个都在冷却时挑 `benchedUntil` 最早的那个硬试一次（`all-benched(<x>)`），**永不空转**；配置显式点名（`WOLFPACK_WORKER`）优先于冷却，并在 digest 里标注「忽略冷却」。
5. **可观测**：`wolf_delegate` 的返回带 `worker_health`、`benched_workers`、`health_note`；`wolf_status` 追加健康段；`/wolfpack/live` 的每个工人分区带 `health` 字段，面板在每个分区里直接显示「冷却中 · 原因 · 剩余时间」。`doctor` 级别的自查用 `wolf health [--json]`，手动解除用 `wolf health --reset claude|agy|all`。

---

## 三、五态 Verdict 决策树

```
                         [提供 verify 命令?]
                             /         \
                           否           是
                           /             \
                  [unverified]      [所有命令跑起来?]
                                      /          \
                                    否            是
                                    /              \
                                [error]      [所有 exitCode === 0?]
                                                /           \
                                              是             否
                                              /               \
                                           [pass]           [fail]
```

- `stale` 态由**派活前基线闸门**产出：基线命令任一通过直接判 `stale`，且**完全不启动工人进程**。
