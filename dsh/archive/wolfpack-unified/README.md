# wolfpack-unified · 狼群模式（通用版）

> 一份**宿主无关的核** + **可插拔工人适配器**。把「自洽、可机械验收」的活派给外部 CLI 工人
> （当前适配器：Antigravity CLI `agy`），**验收由代码跑**，队长只读有界摘要。

对外三种入口，共用同一份 `lib/core/**`：

| 入口 | 文件 | 给谁用 |
|---|---|---|
| **DSH Cordis 插件** | `lib/index.js` | DSH 用户（对话里出现 `wolf_delegate` 等 4 个工具 + 前端面板） |
| **命令行** | `bin/wolf.mjs` | 终端 / CI；无需 DSH |
| **MCP stdio 服务** | `bin/wolf-mcp.mjs` | 任意支持 MCP 的客户端（ChatGPT 桌面端、Codex、Claude Desktop、Cursor…） |

核心设计意图：**队长只花在判断上，钱花在验收**。工人自述不算证据，只有工具返回的
「**我已核实**」段算。

---

## 1. 环境要求

| 需要 | 检查 | 说明 |
|---|---|---|
| Node.js **≥ 20** | `node -v` | CLI / MCP 入口**零第三方依赖**，不需要 `npm install` |
| **工人 CLI**（当前为 `agy`） | `agy --help` | 必须已安装并登录 |
| DSH 宿主 + 三个 peer 依赖 | 见 §3 | **只有**走 DSH 插件入口时才需要 |

> 没有工人时工具仍会注册，但每次派活会**立刻**返回明确原因，不会挂起等超时。

---

## 2. 三种装法

### A. 独立 CLI（最简，零依赖）

```bash
node bin/wolf.mjs status --json
node bin/wolf.mjs delegate --task-id demo-1 --task "任务书全文" --verify "npm test"
```

工人路径解析优先级：**环境变量 `WOLFPACK_AGY` > `wolfpack.config.json` 的 `agyPath` > `PATH` 查找**。
`agy` 已在 PATH 里就什么都不用配。

### B. MCP 服务（给其他 AI 客户端）

配置（`~/.codex/config.toml` 或对应客户端的 MCP 配置）：

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["<本项目绝对路径>/bin/wolf-mcp.mjs"]
env = { WOLFPACK_AGY = "<agy 绝对路径>" }
```

> **为什么建议用 `env` 显式给路径**：宿主拉起 MCP 进程时的工作目录不由你控制，
> 而 `wolfpack.config.json` 是从 cwd 向上搜索的。环境变量优先级最高、与 cwd 无关。

### C. 装进 DSH（本项目的原生形态）

本项目用的是 DSH 的插件装载契约（`dsh.bundle.patch` + `dsh.client`），peer 依赖为
`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/schemastery`。

1. 把项目放到任意目录，并在 DSH profile 里把它作为依赖接入（`file:` / `link:` / junction，任选）。
2. 确认 profile 的 `cordis.patch.yml` 含：

   ```yaml
   - insert:
       - id: wolfpack
         name: wolfpack-unified
   ```

3. 重启 DSH 宿主，日志应出现 `wolfpack: 委派机制已挂载`。

详细的装载契约、每个宿主实际加载哪些文件、宿主专属模块清单，
见 **`docs/HOST-MATRIX.md`**。若你要从一个已有的狼群插件迁移过来，
见 **`docs/CUTOVER.md`**（含备份、切换、回滚、回滚判据）。

---

## 3. 先验证装对了（不消耗工人额度、也不需要工人）

```bash
node tests/run.mjs
```

期望末行 `全部通过`，退出码 0。测试**完全不调用真实工人**，用内置假进程承载。

快速自检台账与配置：

```bash
node bin/wolf.mjs status --json
```

---

## 4. 提供的能力

**4 个工具 / CLI 子命令**（DSH 与 MCP 下同名）：

| 名字 | 作用 | 关键语义 |
|---|---|---|
| `wolf_delegate` | 派一件活并验收 | `verify_baseline` 是**派活前必须失败**的命令：任一条通过 → `stale` 且**完全不启动工人**；一条都没跑起来 → `error`（工具故障，不是工人失败） |
| `wolf_status` | 只读台账 | **绝不启动工人、不跑验收、不消耗额度**；台账不存在也安全返回 |
| `wolf_kill` | 终止运行中的工人进程树 | **跨进程有效**（靠 `<raw_dir>/live/<taskId>.json` 登记） |
| `wolf_team` | 受控并发小队（1–8 个任务，并发 1–4） | 同一批里出现重复 `task_id` → **整批拒绝**；单个任务失败不影响其它 |

**五态裁决**：`pass` / `fail` / `error` / `unverified` / `stale`。
注意 **`error` 与 `fail` 不同**：命令**跑不起来**是 `error`（工具故障），**跑了但失败**才是 `fail`。

**结论政策**（代码定死，不靠队长自觉）：
产物存在即完成（即使工人自报 ERROR 或退出码非零）；工人自报失败但机械验收全过 → 判完成。

**续跑**：同一 `task_id` 的多轮复用工人会话（`--conversation <id>`，**绝不用 `-c`**），
会话 id 落在台账里所以跨进程有效。累计 token 超预算（默认 1,000,000）才强制冷启动，并给出真实数字。

---

## 5. 配置项（全部可用环境变量覆盖）

| 类别 | 变量 |
|---|---|
| 工人 | `WOLFPACK_AGY`、`WOLFPACK_WORKER`、`WOLFPACK_MODEL`、`WOLFPACK_EFFORT`、`WOLFPACK_MODE` |
| 路径 | `WOLFPACK_CONFIG_FILE`、`WOLFPACK_LEDGER`、`WOLFPACK_RAW_DIR`、`WOLFPACK_BRIEFING` |
| 超时 | `WOLFPACK_TASK_TIMEOUT`（默认 **0 = 不设**）、`WOLFPACK_VERIFY_TIMEOUT`（默认 5 分钟）、`WOLFPACK_SHELL` |
| 续跑 | `WOLFPACK_CONTINUATION`、`WOLFPACK_TOKEN_BUDGET`、`WOLFPACK_MAX_ROUNDS`、`WOLFPACK_UNKNOWN_USAGE_CAP` |
| 台账 | `WOLFPACK_LEDGER_MAX_ENTRIES`、`WOLFPACK_LEDGER_MAX_BYTES`、`WOLFPACK_LEDGER_KEEP_ROUNDS` |
| 停滞告警 | `WOLFPACK_STALL_WINDOW`、`WOLFPACK_STALL_WARNINGS`、`WOLFPACK_STALL_POLL`、`WOLFPACK_STALL_TOAST`、`WOLFPACK_STALL_LOG`、`WOLFPACK_STORE_ROOT` |
| 并发 | `WOLFPACK_CONCURRENCY` |

**默认台账位置**：`$DSH_HOME/wolfpack/runs.ndjson`，没有 `DSH_HOME` 时退化为
`~/.dsh/wolfpack/runs.ndjson`。原始工人输出落 `<raw_dir>/raw/`，**永不进上下文**。

---

## 6. 出问题先看这里

| 症状 | 原因 / 处置 |
|---|---|
| 基线命令判成「**工具故障**」 | Windows 上没有 PowerShell 7（PATH 里没有 `pwsh`）。本项目已按 `SystemRoot` 阶梯回退到 Windows PowerShell 5.1；若你的环境更特殊，用 `WOLFPACK_SHELL` 显式指定 |
| `agy 不可用` | 工人路径解析失败。设 `WOLFPACK_AGY` 为绝对路径，或把 `agy` 放进 `PATH` |
| 派活后立刻返回 `stale` | **不是错误**：基线命令已经通过，说明问题已被修或不存在，本轮**没有启动工人**（这是省钱设计）。别重派，直接收尾 |
| 磁盘改动显示「无法判定」 | 工作目录不是 git 仓库，探测不到增量。**这不等于「没有改动」**，以 `verify` 的退出码为准 |
| 同一个 `task_id` 第二次调用被拒 | 上一次还在跑（跨进程也生效）。等它结束，或换 `task_id` |

---

## 7. 已知未做项（如实声明）

1. **跨进程并发不是原子锁**：靠 `<raw_dir>/live/<taskId>.json` 登记 + PID 探活，存在
   「读登记 → 写登记」的竞态窗口，两个进程同一瞬间启动同一 `task_id` 时可能都通过。
2. **工人适配器目前只有 `agy`**。契约已抽好（`lib/core/worker/`），换别的 CLI 只需新增一个适配器文件。
3. **停滞告警在 CLI/MCP 下是写 stderr**，不是系统气泡（DSH 下才有 PowerShell Toast）。
4. **MCP 只实现 Tools**，未声明 Resources / Prompts。
5. 工人的思考正文未提取为明文流，只统计 `thinking_tokens`。

---

## 8. 许可

MIT，见 `LICENSE`。
