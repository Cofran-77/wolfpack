# wolfpack-codex

> 独立、零依赖、可移植的 Node.js ESM 项目：让 **ChatGPT 桌面端（Codex）/ Codex CLI** 当队长，通过 MCP 工具或命令行把活派给 Antigravity CLI `agy`，由代码做机械化验收。

---

## 特性亮点

1. **零运行时依赖**：100% 使用 Node.js 原生内置模块（`node:*`），`package.json` 的 `dependencies` 为空，不依赖任何第三方包或外部 SDK。
2. **纯原生 JSON-RPC 2.0 over stdio**：完全自主实现 MCP 协议（`protocolVersion: 2024-11-05`），支持 `wolf_delegate`、`wolf_status`、`wolf_kill`、`wolf_team` 4 个工具。
3. **严格判定政策**：
   - 产物存在即完成（即使自报 ERROR 或退出码非零，只要检测到磁盘产物仍判完成）；
   - 自报失败但机械验收全部通过判完成；
   - 区分工具故障与测试失败：命令跑不起来判定为 `error`，跑了但失败判定为 `fail`；
   - 基线闸门防呆：任一基线命令通过判定为 `stale`，完全不启动工人；
   - 严格区分「队员声称」与「我已核实」。
4. **会话精准延续**：通过 `--conversation <id>` 延续上下文，绝不用 `-c`；累计 token 超预算（1,000,000）自动触发冷启动并展示真实数字。
5. **同 task_id 并发拒绝**：同任务运行中再次委派直接拒绝，避免状态串场。
6. **零绝对路径硬编码**：支持任意目录部署并拷贝到其他电脑直接运行。

---

## 快速开始：在另一台电脑上的部署步骤

### 1. 环境准备（三个前提，缺一不可）

| 前提 | 怎么确认 | 说明 |
| --- | --- | --- |
| **ChatGPT 桌面端**（应用本体，**不是网页版**） | 打开桌面端，能看到 Codex / New chat 入口 | 网页版不读本地配置、无本地执行环境，用不了 stdio MCP（详见第 3 节） |
| **Node.js ≥ 20** | `node -v` | 输出 `v20.x` 或更高 |
| **Antigravity CLI (`agy`)** | `agy --help` | 秒级返回帮助信息；未登录请先登录 |

### 2. 获取代码与配置

1. 把**整个 `wolfpack-codex` 目录**拷到目标机器（例：`D:\wolfpack-codex`、`/opt/wolfpack-codex`）。目录自包含，**不需要 `npm install`**（零运行时依赖）。
2. 记下 `agy` 可执行文件的**绝对路径**（例：`D:\AntigravityCLI\agy.exe`、`/usr/local/bin/agy`）。这个值下一步就要用。

> **agy 路径的解析优先级：环境变量 `WOLFPACK_AGY` > `wolfpack.config.json` > `PATH`。**
> 在 ChatGPT 桌面端 / 任何 MCP 宿主下，**只用第一种**：宿主拉起 MCP 进程时的工作目录不由你控制，而 `wolfpack.config.json` 是从 cwd 向上搜索的，靠相对位置找配置不可靠。
> 复制 `wolfpack.config.example.json` 为 `wolfpack.config.json` 这条路，只在「你自己 cd 进项目目录手动跑 `wolf`」时方便，别在 MCP 配置里依赖它。

### 3. 注册 MCP 服务（ChatGPT 桌面端 / Codex CLI / IDE 扩展通用）

OpenAI 官方文档（`learn.chatgpt.com/docs/extend/mcp`）原文：

> The ChatGPT desktop app, Codex CLI, and IDE extension support MCP servers and share MCP configuration for the same Codex host.
> Supported MCP features — **STDIO servers**: Servers that run as a local process (started by a command).

也就是说：**ChatGPT 桌面端支持 stdio MCP，且与 Codex CLI / IDE 扩展共用同一份配置**，所以下面这一段三种宿主通用。编辑 `~/.codex/config.toml`（或项目级 `.codex/config.toml`）：

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["<wolfpack-codex 绝对路径>/bin/wolf-mcp.mjs"]
env = { WOLFPACK_AGY = "<agy 绝对路径>" }
```

> 例如 Windows：
> ```toml
> [mcp_servers.wolfpack]
> command = "node"
> args = ["D:/DSH-Plugins/wolfpack-codex/bin/wolf-mcp.mjs"]
> env = { WOLFPACK_AGY = "D:/AntigravityCLI/agy.exe" }
> ```
> 例如 Linux/macOS：把上面两个路径换成 `/home/user/...` 形式。

**为什么用 `env` 显式给 `WOLFPACK_AGY`（重要）**：宿主拉起 MCP 进程时的工作目录**不保证**在 `wolfpack-codex` 里，而 `wolfpack.config.json` 是从 cwd 向上搜索的——用相对位置找配置不可靠。环境变量优先级最高、与 cwd 无关，是唯一稳的做法。若目标机器上 `agy` 已在 `PATH` 里，`env` 也可以省略。

等价做法：`codex mcp add wolfpack -- node <绝对路径>/bin/wolf-mcp.mjs`

> ⚠️ **不适用**：ChatGPT **网页版**。官方文档明确写着 ChatGPT web 不读取本地 Codex 配置、也不暴露本地执行环境——只有**桌面端应用**、Codex CLI、IDE 扩展这三种本地 Codex host 才支持 stdio MCP。
> ⚠️ 前提：目标机器必须已装 **Node ≥ 20** 和 **agy**。没有 agy 时工具仍会注册，但每次派活会立刻返回明确的「agy 不可用」原因（不会挂起等超时）。


### 4. 运行自检验证

在 `wolfpack-codex` 目录下运行：

```bash
node bin/wolf.mjs status --json
```

若输出类似以下内容且退出码为 0，即表示台账与环境工作正常：

```json
{
  "tasks": [],
  "total": 0,
  "truncated": false,
  "limit": 20,
  "ledger_path": "..."
}
```

> **本机没有 agy 时如何只跑自检？**
> 
> 本项目的全套测试套件**完全不依赖真实 agy**，也不消耗任何网络或订阅额度。直接执行：
> ```bash
> node tests/run.mjs
> ```
> 全部 **25** 个用例（基线闸门、五态判定、产物救援、续跑与 token 预算冷启动、跨进程 kill、同 task_id 并发拒绝、digest 文案、UTF-8 BOM、shell 解析阶梯、MCP 工具列表等）全部由内置的 `tests/fixtures/fake-worker.mjs` 承载，可随时离线验证功能完整性。期望输出末行：`25 passed, 0 failed`，退出码 0。

### 5. 配套指令接入

`AGENTS.md` 是**给队长模型读的执行手册**（选档策略、验收铁律、4 个 MCP 工具的用法与参数、成本认知）。

Codex 的指令发现规则（官方文档 `docs/agent-configuration/agents-md` 原文）：从**项目根（通常是 Git 根）**向下走到当前工作目录逐层查找；**找不到项目根时只检查当前目录**。另有 `~/.codex/AGENTS.md` 是**全局**文件，所有仓库都会继承。

两种放法，按目标选：

| 想要的效果 | 放哪里 |
| --- | --- |
| **这台机器上所有项目都能用狼群**（推荐） | `~/.codex/AGENTS.md` |
| 只在某个具体项目里用 | 那个项目的**根目录**（通常就是 Git 根）下的 `AGENTS.md` |

> 注意：目标目录**不是 Git 仓库**时 Codex 只看当前目录、不会向上层走——别把 `AGENTS.md` 放在非仓库目录的父级然后指望它被读到。

### 6. 部署自检清单（照顺序做，每步都有可判定的结果）

| # | 操作 | 期望结果 |
| --- | --- | --- |
| 1 | `node -v` | `v20.x` 或更高 |
| 2 | `node tests/run.mjs`（在项目目录内） | 末行 `25 passed, 0 failed`，退出码 0；**不需要 agy** |
| 3 | `node bin/wolf.mjs status --json` | 输出合法 JSON 且退出码 0（全新机器上是 `"tasks": []`、`"total": 0`） |
| 4 | 按第 3 节写入 `[mcp_servers.wolfpack]`（**别漏 `env.WOLFPACK_AGY`**） | 配置文件保存成功 |
| 5 | 重启桌面端应用（或新开一个会话），问 Codex「调用 wolf_status 看下台账」 | 返回台账内容；工具列表里应出现 `wolf_delegate` / `wolf_status` / `wolf_kill` / `wolf_team` |
| 6 | 真实派一件小事（例：让 agy 建一个文件，`--verify` 检查该文件） | digest 出现「我已核实」段且 verdict 为 `pass` |

第 5 步若看不到工具：桌面端有**集成终端**，可直接用 CLI 形态（见下节），不依赖 MCP 注册。CLI 形态已在真实 agy 上验证过端到端（含跨进程 `kill`）。

---

## 命令行用法 (CLI)

```bash
# 单任务委派（执行完打印 digest）
node bin/wolf.mjs delegate --task-id demo-1 --task "修复 parser 边界解析 bug" --verify "npm test"

# 查看台账状态（纯只读，绝不启动工人，台账不存在亦安全返回）
node bin/wolf.mjs status --json

# 终止正在跑的任务进程树
node bin/wolf.mjs kill --task-id demo-1

# 并发小队委派
node bin/wolf.mjs team --tasks tasks.json --concurrency 2
```

---

## 已知未做项 (Known Non-Goals / Roadmap)

1. **跨进程并发不是原子锁**：除进程内 `ActiveRunRegistry` 外，已实现基于 `<raw_dir>/live/<taskId>.json` 的跨进程拒绝（启动前读登记并按 PID 探活，仍存活则拒绝；`wolf kill` 也靠它跨进程终止进程树）。但「读登记 → 写登记」之间存在竞态窗口，**不是原子文件锁**：两个进程在同一瞬间启动同一 `task_id` 时，仍可能都通过检查。要绝对互斥需要 `O_EXCL` 锁文件或类似原语，本版本未做。
2. **agy 思考明文实时流提取**：由于 upstream agy CLI 协议未在 stdout 将 Thinking 思维链明文直接暴露，当前仅按规范提取 `usage.thinking_tokens` 计数；思考正文保留在本地日志文件中。
3. **MCP 协议资源订阅（Resources/Prompts）**：当前版本重点交付核心的 4 个工具调用能力，未声明 MCP Resources 与 Prompts 扩展能力。
