# Wolfpack Codex

连接 Codex 与 Antigravity CLI（`agy`）的本地任务委派工具。

Wolfpack 将任务派发、会话续跑、并发执行和命令验收整合到同一工作流中：Codex 负责明确目标和审查结果，agy 负责执行，Wolfpack 记录过程并汇总可核实的证据。你可以通过 MCP 工具调用，也可以直接使用命令行。

项目使用 Node.js 原生模块构建，无第三方运行时依赖。

## 为什么要用它：把贵的那一半用在判断上

Codex 和 agy 都在「聊天」里干活，但成本结构完全不同。驱动 Codex 的模型额度消耗快、单价高；驱动 agy 的模型用量便宜得多，而在目标明确、边界清楚的编码任务上通常足够可靠。真正稀缺的是**判断力**——拆任务、定验收标准、审查结果——而不是敲键盘的动作。

打个比方：装修一套房子，既要有设计师定方案、盯效果，也要有施工队刷墙铺砖。让设计师亲手刷墙，付的是设计师的时薪，速度却未必比工人快；反过来让施工队自己拍板方案，返工的概率又太高。Wolfpack 就是把这两件事分开的那道工序：Codex 出方案、下判断、做验收，动手的活交给 agy，贵的额度只花在真正需要判断力的地方。

省下来的额度主要来自三处：

- **上下文不搬家**：不必把代码库和长对话灌进贵模型，agy 在自己的会话里读文件、跑命令。
- **轮数被压缩**：一次 `wolf_delegate` 把「派活 + 执行 + 验收」合成一到两轮，而不是来回十几轮。
- **会话可复用**：同一 `task_id` 续跑复用 agy 会话，省掉冷启动开销；累计用量超过阈值才强制冷启动。

省钱的前提是任务本身**能被机械验收**。目标含糊、需要反复澄清的活派出去，只会把成本换成返工。

## 核心能力

- **任务委派**：提交独立任务，收集执行结果、文件改动和验收输出。
- **会话续跑**：使用稳定的 `task_id` 关联 agy 会话；支持强制新会话与累计 token 阈值控制。
- **并发执行**：一次提交最多 8 个任务，并发数可设为 1–4，默认 2。
- **独立验收**：执行调用方提供的检查命令，将执行者自述与实际检查结果分开呈现。
- **基线检查**：派发前确认问题仍然存在，避免重复处理已满足条件的任务。
- **任务管理**：查询历史、查看运行状态，并终止指定任务的进程树。

适合目标明确、可以独立执行且有验收方式的开发任务。有依赖关系的任务应按顺序执行；多个任务同时修改同一文件时，需要调用方协调。

## 快速开始

### 环境要求

- Node.js 20 或更高版本。
- 已安装并完成登录的 Antigravity CLI，`agy --help` 可正常执行。
- 使用 MCP 接入时，需要支持本地 stdio MCP 服务的客户端；也可以仅使用 CLI。

```sh
node --version
agy --help
```

### 获取项目

```sh
git clone https://github.com/Cofran-77/wolfpack-codex.git
cd wolfpack-codex
```

本仓库为私有仓库，克隆前需要具有访问权限并完成 GitHub 身份验证。项目无需执行 `npm install`。

运行离线测试和只读状态查询：

```sh
node tests/run.mjs
node bin/wolf.mjs status --json
```

测试使用内置模拟执行器，不依赖真实 agy，也不消耗其模型调用额度。`status` 只读取任务记录；它成功返回不代表已经验证 agy 的登录或任务执行能力。

### 接入 Codex

将以下内容加入 Codex 的 MCP 配置（通常为 `~/.codex/config.toml`），把占位路径替换为实际绝对路径：

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["/absolute/path/to/wolfpack-codex/bin/wolf-mcp.mjs"]
env = { WOLFPACK_AGY = "/absolute/path/to/agy" }
```

Windows 路径可使用正斜杠，agy 可执行文件通常为 `agy.exe`。如果客户端无法找到 `node`，也应将 `command` 改为 Node.js 的绝对路径。

也可以通过 Codex CLI 注册：

```sh
codex mcp add wolfpack --env "WOLFPACK_AGY=/absolute/path/to/agy" -- node "/absolute/path/to/wolfpack-codex/bin/wolf-mcp.mjs"
```

重新加载客户端或开启新会话后，调用 `wolf_status` 检查服务是否可用。可用工具如下：

| 工具 | 用途 |
| --- | --- |
| `wolf_delegate` | 委派一个任务，返回执行摘要与验收结果 |
| `wolf_team` | 并发执行一组独立任务 |
| `wolf_status` | 只读查询历史和运行状态 |
| `wolf_kill` | 终止指定任务的进程树 |

MCP 服务需要由具有本地进程执行能力的客户端启动。仅有网页聊天界面并不等于能够启动本地 stdio 服务。

### 与 CC Switch 等配置管理工具共存

Wolfpack 的 MCP 注册写在 `~/.codex/config.toml`。有些配置管理工具（例如 CC Switch）在切换供应商或模型时会**整体重写**该文件，只保留它自己管理的 MCP 服务，`[mcp_servers.wolfpack]` 会被一并抹掉，表现为切换之后客户端里再也看不到 `wolf_status` 等工具。

为了不反复手工补配置，切换之前先做两件事：

1. 把 Wolfpack 加进该工具的 MCP 管理清单（例如 CC Switch 的「MCP 管理」）并勾选 Codex，让它每次写配置时带上这一条。
2. 切换完成后完全退出并重开客户端。工具列表在会话创建时确定，已有会话不会自动出现新工具，新开一个任务最稳妥。

万一仍然丢失，用上面的 `codex mcp add` 命令补回来即可。排查顺序：先确认 `~/.codex/config.toml` 里 `[mcp_servers.wolfpack]` 是否存在，再重启客户端。

### 工作目录与权限

**任务执行和验收命令都以进程的工作目录为准。** CLI 应从待处理项目目录启动，并通过绝对路径引用 Wolfpack 的入口脚本。MCP 模式使用服务进程的工作目录；当前工具参数不支持逐任务指定 `cwd`，接入时应确认客户端为服务设置的工作目录。

建议在 MCP 配置中显式设置 `WOLFPACK_AGY`，避免依赖客户端的 PATH 或工作目录。需要指定配置文件时，可设置 `WOLFPACK_CONFIG_FILE` 为其绝对路径。

**当前 agy 适配器固定传入 `--dangerously-skip-permissions`，会自动批准 agy 的工具操作。** Wolfpack 本身不提供沙箱或任务目录隔离。请在你授权修改的工作区中使用，并明确任务范围与验收要求。

## 使用方式

### 单任务委派

通过 `wolf_delegate` 提交完整、独立的任务描述：

```json
{
  "task_id": "fix-parser-empty-input",
  "task": "修复当前项目中 parser 对空输入的处理，补充回归测试，并运行相关测试。保持既有公共接口不变。",
  "verify": ["npm test"]
}
```

`npm test` 是目标项目的验收命令示例，请替换为实际检查命令。agy 不会自动获得 Codex 当前对话的上下文，任务描述应包含必要的背景、目标、约束和交付要求。

CLI 提供对应操作。以下示例从目标项目目录执行，入口路径需替换为实际安装路径：

```sh
node "/absolute/path/to/wolfpack-codex/bin/wolf.mjs" delegate --task-id fix-parser-empty-input --task "修复 parser 空输入处理并补充回归测试" --verify "npm test"
```

常用参数：

| MCP 参数 | CLI 参数 | 说明 |
| --- | --- | --- |
| `task_id` | `--task-id` | 任务标识；同一任务续跑时复用，不相关任务使用新标识 |
| `task` | `--task` | 自包含的任务描述 |
| `verify` | `--verify` | 验收命令；MCP 使用数组，CLI 可重复传入 |
| `verify_baseline` | `--verify-baseline` | 派发前的基线检查；任一命令通过则跳过派发 |
| `fresh` | `--fresh` | 放弃该任务原有会话，重新开始 |
| `model` | `--model` | 指定本次使用的 agy 模型 |

基线检查适合确认某个已知失败是否仍然存在。应使用针对该问题的检查命令，避免将无关的成功检查误判为任务已完成。

### 并发任务

调用 `wolf_team`，或将以下内容保存为 `tasks.json`：

```json
[
  {
    "task_id": "parser-tests",
    "task": "为 parser 模块补充边界测试，仅修改该模块的测试文件。",
    "verify": ["npm run test:parser"]
  },
  {
    "task_id": "api-docs",
    "task": "根据现有接口实现更新 API 文档，仅修改 docs/api 目录。",
    "verify": ["npm run docs:check"]
  }
]
```

将任务与检查命令调整为目标项目的实际内容后执行：

```sh
node "/absolute/path/to/wolfpack-codex/bin/wolf.mjs" team --tasks tasks.json --concurrency 2
```

MCP 调用的参数形式为 `{ "tasks": [...], "concurrency": 2 }`。同一批任务不能使用重复的 `task_id`；同一个任务运行期间也不能再次委派。

### 查询与终止

```sh
node "/absolute/path/to/wolfpack-codex/bin/wolf.mjs" status --json
node "/absolute/path/to/wolfpack-codex/bin/wolf.mjs" status --task-id fix-parser-empty-input --json
node "/absolute/path/to/wolfpack-codex/bin/wolf.mjs" kill --task-id fix-parser-empty-input
```

`status` 不启动 agy，也不执行验收命令。任务记录默认位于当前用户的 `~/.wolfpack` 目录，可通过配置修改。

## 结果判定

摘要分别展示“队员声称”和“我已核实”。前者是执行者报告，后者包含文件改动探测与验收命令结果。

| `verdict` | 含义 |
| --- | --- |
| `pass` | 已配置的验收命令全部成功执行并通过 |
| `fail` | 验收命令已执行，但存在未通过的检查 |
| `error` | 检查无法正常执行等工具或环境错误 |
| `unverified` | 未提供验收命令，无法据此确认任务达标 |
| `stale` | 基线检查中已有命令通过，因此跳过本次派发 |

执行状态与验收结论是两个不同维度：agy 报错后，如果检测到文件改动，执行状态仍可能被标记为 `completed`；验收全部通过时也可能恢复该状态。**`completed` 不等于 `verdict: pass`，文件存在或发生改动也不代表内容正确。**

非 Git 工作区无法通过 Git 状态计算改动差集，此时会报告“无法判定”。应结合明确的验收命令和必要的人工审查判断结果。

CLI 正常返回的结构化结果也可能包含失败结论；自动化调用应使用 `--json` 并检查 `verdict`，不要只依赖进程退出码。

## 配置

可参考 [wolfpack.config.example.json](wolfpack.config.example.json) 创建本地 `wolfpack.config.json`。默认从当前工作目录向上查找配置文件；`WOLFPACK_CONFIG_FILE` 可指定要读取的文件。

常用配置优先使用对应环境变量，再使用 JSON 配置值，最后采用默认值。

| JSON 配置项 | 环境变量 | 默认值 / 说明 |
| --- | --- | --- |
| `agyPath` | `WOLFPACK_AGY` | 从 PATH 查找 `agy`，Windows 为 `agy.exe` |
| `mode` | `WOLFPACK_MODE` | `accept-edits` |
| `model` | `WOLFPACK_MODEL` | 由 agy 决定 |
| `effort` | `WOLFPACK_EFFORT` | 由 agy 决定 |
| `ledgerPath` | `WOLFPACK_LEDGER` | `~/.wolfpack/runs.ndjson` |
| `rawDir` | `WOLFPACK_RAW_DIR` | `~/.wolfpack/raw` |
| `taskTimeoutMs` | `WOLFPACK_TASK_TIMEOUT` | `0`，不设置 Wolfpack 任务超时 |
| `verifyTimeoutMs` | `WOLFPACK_VERIFY_TIMEOUT` | `300000` 毫秒 |
| `continuationTokenBudget` | `WOLFPACK_TOKEN_BUDGET` | `1000000`，累计用量达到阈值时触发新会话 |

会话阈值用于控制上下文续用，并不是费用上限或单次任务的硬 token 限额。实际模型用量由 agy 的返回数据决定。

本地配置、凭据和运行日志不应提交到仓库；项目的 `.gitignore` 已排除常见相关文件。

## 开发与文档

```sh
node tests/run.mjs
```

测试覆盖基线检查、结果判定、会话续跑、并发冲突、任务终止、配置解析和 MCP 工具发现等行为。

并发与任务终止用例按平台分成两份实现：`tests/concurrency.windows.test.mjs` 按 Windows 语义判断进程结束（`exitCode` 非空即可），`tests/concurrency.macos-linux.test.mjs` 同时接受退出码与信号（POSIX 下被 `SIGKILL` 终止的进程 `exitCode` 为 `null`，终止原因记录在 `signalCode`）。`tests/run.mjs` 按运行平台自动选择，两份文件除该判定外内容一致，修改时需同步。在 macOS/Linux 上运行测试要求 `node` 位于 `PATH` 中，否则部分用例会以 `exit 127` 之类的形式假失败。

```text
bin/          CLI 与 MCP 入口
src/          任务调度、验收、记录和进程管理
src/worker/   agy 适配器
tests/       离线测试及模拟执行器
docs/        设计文档
```

- [设计说明](docs/DESIGN.md)：内部结构与实现背景。
- [委派操作手册](AGENTS.md)：供调用方参考的任务拆分与验收约定。接入现有项目时按需合并相关内容，避免覆盖已有项目指令。

修改后请运行相关检查，通过分支与 Pull Request 协作。单纯修改文档时，重点核对命令、参数、链接和描述是否与实现一致。

## 当前限制

- 跨进程同任务检查依赖运行记录与进程存活探测，尚未使用原子文件锁，极端并发下存在竞态窗口。
- 并发任务共享调用方提供的工作区，不自动创建隔离目录或 Git worktree。
- 当前适配器读取 agy 的最终 JSON 结果，未提供实时执行日志面板或思考正文展示。
- MCP 接口仅提供上述四个工具，未实现 Resources、Prompts 或订阅能力。
- agy 服务可用性、模型配额与权限行为由其自身环境决定，Wolfpack 不提供可用性保证。
