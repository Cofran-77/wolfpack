# Wolfpack 统一架构宿主支持矩阵 (HOST-MATRIX)

本文档定义了 `wolfpack-unified` 项目同一份宿主无关内核（`lib/core/**`）在三种不同宿主环境中的对接矩阵、能力边界、模块加载清单与行为差异。

---

## 1. 核心架构与文件加载清单

Wolfpack Unified 遵循「**同一份通用核 + 可插拔运行时/工人适配器**」设计模式：
- **宿主无关通用核 (`lib/core/**`)**：依赖边界为「**只依赖注入的 runtime 与注入的通知器，不 import 任何宿主模块**」。严禁直接导入 `node:child_process`，无任何向上越界 import（`from '../`），无任何 `if (isDSH)` 条件分支。所有外设调用（进程派生、信号终止、工作区快照、文件系统溢出日志、停滞通知）全部依赖注入的 `Runtime` 与注入的通知器对象。
- **可插拔工人适配器 (`lib/core/worker/**`)**：工人命令构造、结果映射、用量提取、错误分类（包含 503 容量不足识别）与工人类型解耦。

### 宿主专属模块清单 (Host-Specific Modules)
以下模块明确为宿主专属模块，严禁被核心层引用：
- `lib/runtime/dsh.mjs`：DSH 宿主运行时适配器（包装 `ctx.subprocess`）
- `lib/runtime/node.mjs`：Node.js 宿主运行时适配器（包装 `node:child_process` 并提供孤儿进程树清理）
- `lib/live-route.js`：DSH 专有 HTTP 实时路由（`/wolfpack/live`）
- `lib/agy-provider.js`：DSH `ctx.subagents` 委派机制 Provider
- `lib/index.js`：DSH Cordis 插件入口
- `lib/client.js`：DSH 前端 WebUI 插件

### 宿主实际加载文件清单 (Loaded Files Inventory)

| 宿主环境 | 入口与宿主专属模块 (Host-Specific) | 适配层运行时 (Runtime) | 通用核心库 (Shared Core) | 兼容重导出薄壳 (≤ 2000 字节) |
| :--- | :--- | :--- | :--- | :--- |
| **DSH Cordis 插件** | `lib/index.js` (插件入口)<br>`lib/agy-provider.js` (subagent provider)<br>`lib/live-route.js` (HTTP 实时路由)<br>`lib/stall-monitor.js` (DSH Toast 通知注入)<br>`lib/client.js` (前端 UI 插件) | `lib/runtime/dsh.mjs`<br>(包装 `ctx.subprocess`) | `lib/core/config.mjs`<br>`lib/core/ledger.mjs`<br>`lib/core/delegate.mjs`<br>`lib/core/verify.mjs`<br>`lib/core/digest.mjs`<br>`lib/core/team.mjs`<br>`lib/core/live.mjs`<br>`lib/core/spawn.mjs`<br>`lib/core/stall-monitor.mjs`<br>`lib/core/worker/agy.mjs` | `lib/runs-ledger.js` (135B)<br>`lib/agy-runner.js` (1.5KB)<br>`lib/wolf-delegate.js` (414B)<br>`lib/wolf-team.js` (441B) |
| **独立 CLI (`wolf.mjs`)** | `bin/wolf.mjs` (CLI 命令行入口) | `lib/runtime/node.mjs`<br>(带孤儿清理的 Node 子进程) | `lib/core/**` 全部通用模块 | 不加载 |
| **MCP Server (`wolf-mcp.mjs`)** | `bin/wolf-mcp.mjs` (stdio JSON-RPC 入口) | `lib/runtime/node.mjs`<br>(带孤儿清理的 Node 子进程) | `lib/core/**` 全部通用模块 | 不加载 |

> [!NOTE]
> `lib/index.js`（DSH 宿主壳）已完全切断对旧实现的直接引用，直接通过 `import ... from './core/**'` 连接通用核心。原 `lib/agy-runner.js`、`lib/wolf-delegate.js`、`lib/wolf-team.js`、`lib/runs-ledger.js` 仅保留极薄的重导出声明（均 ≤ 2000 字节），供外部单测平滑过渡，内部零重复逻辑。

---

## 2. 三宿主横向对比矩阵

| 维度 | DSH Cordis 插件 | 独立 CLI (`wolf.mjs`) | MCP Server (`wolf-mcp.mjs`) |
| :--- | :--- | :--- | :--- |
| **进程派生契约** | `DshRuntime` (`ctx.subprocess.spawn`)，遵循 DSH 沙箱安全策略 | `NodeRuntime` (`node:child_process.spawn`)，带超时兜底与孤儿进程树清理 | `NodeRuntime` (`node:child_process.spawn`)，同 CLI |
| **进程树清理机制** | 宿主 `ctx.subprocess` 内核生命周期纳管与自动回收 | 递归树终止 (`taskkill /T /F` / POSIX `SIGTERM->SIGKILL`) | 递归树终止 (`taskkill /T /F` / POSIX `SIGTERM->SIGKILL`) |
| **配置 / 设置来源** | Cordis schema 配置 (`wolfpack` 命名空间) + 环境变量 | `wolfpack.config.json` (可选) + 环境变量 | `wolfpack.config.json` (可选) + 环境变量 |
| **工具暴露表面** | `@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-subagent` 委派机制 | CLI 子命令 (`delegate`, `status`, `kill`, `team`) | 标准 MCP `tools/list` 与 `tools/call` RPC 协议 |
| **UI / 交互形态** | 丰富前端 (`lib/client.js`)：输入框开关、卡片、右侧实时监控面板 (`/wolfpack/live`) | 终端标准输出（纯文本 / `--json` 原始数据） | 宿主应用客户端（如 Claude Desktop / IDE）渲染的文本与工具卡 |
| **实时日志路由** | 内置 HTTP 服务端挂载 `/wolfpack/live`，支持 transcript 增量流式轮询 | 无 HTTP 路由（通过磁盘或台账直接读取） | 无 HTTP 路由（通过 JSON-RPC `tools/call` 调用 `wolf_status` 读取） |
| **台账存储位置** | **$DSH_HOME 统一阶梯解析**：<br>1. `WOLFPACK_LEDGER`<br>2. `$DSH_HOME/wolfpack/runs.ndjson`<br>3. `~/.dsh/wolfpack/runs.ndjson`<br>4. `tempdir/dsh-wolfpack/runs.ndjson` | **与 DSH 完全相同**（`lib/core/ledger.mjs` 的 `defaultLedgerPath` 是 `$DSH_HOME` 阶梯，所以 CLI 也是同一阶梯，不是 `~/.wolfpack/`） | **与 DSH 完全相同**（`lib/core/ledger.mjs` 的 `defaultLedgerPath` 是 `$DSH_HOME` 阶梯，所以 MCP 也是同一阶梯，不是 `~/.wolfpack/`） |
| **停滞监控与通知** | 宿主注入 PowerShell Toast + 写 `stall.ndjson`（Windows 交互气泡提示） | 宿主注入写 stderr + 写 `stall.ndjson` | 宿主注入写 stderr + 写 `stall.ndjson` |
| **并发互斥级别** | 单进程级：`ActiveRunRegistry` 阻断同 `task_id` 竞态 | 单进程级：CLI 单次执行独占运行 | 单进程级：MCP 进程维护当前会话 `ActiveRunRegistry` |
| **依赖环境要求** | Node.js >= 20 + DSH Cordis 宿主环境 + peer 依赖 | 纯 Node.js >= 20，**零第三方运行时依赖** | 纯 Node.js >= 20，**零第三方运行时依赖** |

---

## 3. 各宿主能力与边界细化说明

### 3.1 DSH Cordis 插件 (全功能态)
- **具备的能力**：
  - 双通道派活：既作为 `@deepseek-ai/dsh-subagent` 的外部 `provider` 接收自然语言自动委派，又直接作为 `@deepseek-ai/dsh-tools` 的工具显式受队长调用。
  - 完整 UI 融合：通过 `lib/client.js` 注册输入框激活开关、设置页配置项、`WolfStatusCard` 与 `WolfKillCard` 定制展示，以及侧边栏右侧 live 面板。
  - 会话与流式日志：通过 `lib/live-route.js` 挂载 HTTP `/wolfpack/live`，支持带鉴权、有界裁剪、容错解析的 transcript 流式事件推送。
  - 停滞监测：通过 `lib/core/stall-monitor.mjs` 监听文件活跃度，并在 5/10/15 分钟触发宿主注入的系统 Toast 与控制台告警。
- **宿主专属模块**：
  - `lib/index.js`：Cordis 生命周期 `apply(ctx)`、settings schema 注册、systemPrompt 注入与工具挂载。
  - `lib/runtime/dsh.mjs`：`DshRuntime` 包装 `ctx.subprocess`。
  - `lib/client.js`：前端 WebUI 插件。
  - `lib/live-route.js`：HTTP 路由监听器。
  - `lib/agy-provider.js`：DSH Subagent Provider。
  - `lib/stall-monitor.js`：DSH 宿主专有的 Toast 通知注入器与重导出薄壳。

### 3.2 独立 CLI (`wolf.mjs`)
- **具备的能力**：
  - 零依赖开箱即用：任意安装了 Node.js >= 20 的机器均可直接运行 `node bin/wolf.mjs`。
  - CI/CD 自动化集成：支持 `wolf status --json`、`wolf delegate` 等非交互式脚本调用，适合本地排障与构建脚本。
  - 完整核逻辑保真：复用同一套 `verify` 门闩、`verify_baseline`、5态裁决 (`pass`/`fail`/`error`/`unverified`/`stale`)、`digest` 两段式渲染。
  - 停滞监控注入：注入写 stderr 与写 `stall.ndjson`，不弹出桌面弹窗。
- **宿主专属模块**：
  - `bin/wolf.mjs`：CLI 命令参数解析与终端排版输出。
  - `lib/runtime/node.mjs`：Node.js 原生 `child_process` 运行时与孤儿清理。

### 3.3 MCP Server (`wolf-mcp.mjs`)
- **具备的能力**：
  - 标准兼容：完整实现 Model Context Protocol (2024-11-05 版本) 的 stdio JSON-RPC 规范。
  - 工具能力对等：暴露 4 个标准工具：
    - `wolf_delegate`：带基线检查与验收门闩的自主工人委派。
    - `wolf_status`：纯只读台账状态查询（保证零消耗、零副作用）。
    - `wolf_kill`：正在运行的工人进程树强制终止。
    - `wolf_team`：受控并发（1-4 并发）的小队并行委派。
  - 跨客户端赋能：允许 Claude Desktop、Cursor、Cline、VS Code Copilot 等外部 AI 客户端无缝使用狼群流水线与 agy 额度。
  - 停滞监控注入：注入写 stderr 与写 `stall.ndjson`。
- **宿主专属模块**：
  - `bin/wolf-mcp.mjs`：MCP JSON-RPC 协议解析与工具注册。
  - `lib/runtime/node.mjs`：Node.js 原生运行时。

---

## 4. 共享统一核行为契约清单

由同一份 `lib/core/**` 保证：
1. **统一裁决 5 态**：`pass`（验收全部通过）、`fail`（验收命令失败）、`error`（基线跑不起来/超时/工具崩溃）、`unverified`（未提供验收命令）、`stale`（基线检查已通过，问题早已不存在）。
2. **两段式摘要 (Digest)**：
   - 【队员声称】：提取工人的自述、轮次、改动文件。
   - 【我已核实】：真实的验收输出、退出码、失败定位信号，严禁空口承诺。
3. **机械验收救回**：工人自报 `ERROR` 但验收命令全部通过且 exitCode 为 0 时，自动救回判定为 `completed`。
4. **续跑与冷启动安全**：
   - 会话延续必须严格使用 `--conversation <id>`（绝不使用 `-c`）。
   - 同一 `task_id` 并发必须在第一时间拒绝抛出 `TaskBusyError`，严禁静默排队或串场。
5. **台账与落盘阶梯**：全宿主统一由 `lib/core/ledger.mjs` 的 `defaultLedgerPath` 是 `$DSH_HOME` 阶梯，所以 CLI/MCP 也是同一阶梯，寻找 `runs.ndjson`，默认使用 `raw/` 子目录持久化原始 JSON。
6. **Shell 解析防坑**：Windows 环境下杜绝裸 `pwsh` 调用，按 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 安全路径解析。
