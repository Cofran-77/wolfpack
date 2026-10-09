# Wolfpack

宿主无关的本地任务委派引擎，提供 CLI 和 stdio MCP 入口。适用于支持本地 MCP 服务的 AI 客户端，也可供终端和自动化脚本使用。

Node.js ≥20；无第三方运行时依赖，无需 `npm install`。真实派活需已安装并登录 Antigravity CLI (`agy`) 或 Claude Code CLI (`claude`)。没有工人时仍可读台账、查健康、运行离线测试。

## 能力

- 两种工人适配器；自动选择、轮换、续跑沿用与不可用回退。
- 工人故障识别、健康台账及冷却；容量、额度、鉴权、超时分别处理。
- 基线闸门、会话续跑、token 累计、受控并发、进程树取消和派发即记账。
- 六个 MCP 工具：`wolf_delegate`、`wolf_status`、`wolf_kill`、`wolf_team`、`wolf_live`、`wolf_panel`。
- 按工人展示实时状态与会话尾部、只读本地面板、停滞只报警不自动终止。
- Git 差集与非 Git 文件快照；队员自述和实测证据分开汇报。

## CLI 使用

在本目录运行：

```sh
node bin/wolf.mjs status --json
node bin/wolf.mjs health --json
node bin/wolf.mjs delegate --task-id fix-parser --task "修复 parser 空输入并补回归测试" --verify "npm test"
node bin/wolf.mjs status --task-id fix-parser --json
node bin/wolf.mjs live --json
node bin/wolf.mjs panel
node bin/wolf.mjs kill --task-id fix-parser
node bin/wolf.mjs health --reset claude
```

`--verify` 是目标工作区的验收命令；重复此参数可注册多个验收。任务书必须包含目标、边界、交付文件与验收要求，因为工人看不到队长会话。工人从命令运行时的工作目录执行任务；从其他项目使用时，以绝对路径调用 `bin/wolf.mjs`。

小队使用 `node bin/wolf.mjs team --tasks tasks.json --concurrency 2`：

```json
[
  { "task_id": "parser", "task": "完整独立任务书", "verify": ["npm test"] },
  { "task_id": "docs", "task": "另一件不冲突的任务书", "verify": ["npm run check-docs"] }
]
```

小队最多八个任务、并发最多四个；同批重复 task_id 整批拒绝。只有互不依赖、文件边界清楚的任务才适合并行。

## MCP 接入

常见 JSON 客户端配置：

```json
{
  "mcpServers": {
    "wolfpack": {
      "command": "node",
      "args": ["<仓库绝对路径>/universal/bin/wolf-mcp.mjs"],
      "env": {
        "WOLFPACK_AGY": "<agy 可执行文件绝对路径>",
        "WOLFPACK_CLAUDE": "<claude 可执行文件绝对路径>"
      }
    }
  }
}
```

只保留实际安装工人的环境变量；CLI 在客户端 PATH 中时也可省略。各客户端字段与配置位置可能不同，应按客户端的 stdio MCP 设置接入。Codex 专供版及其 TOML 示例见 [../codex](../codex/README.md)。

MCP 工人的工作目录是服务进程 cwd。需在客户端设置工作目录或在目标项目内启动服务；不要将 MCP 脚本所在目录误认为目标工作区。环境变量路径比 cwd 搜索配置更稳定。

## 配置与结果

配置文件为从 cwd 向上搜索的 `wolfpack.config.json`，示例见 [wolfpack.config.example.json](wolfpack.config.example.json)，完整字段见 [配置参考](docs/CONFIGURATION.md)。可用 `WOLFPACK_CONFIG_FILE` 指定配置文件，`WOLFPACK_AGY` / `WOLFPACK_CLAUDE` 指定可执行文件，`WOLFPACK_WORKER=agy|claude` 设置偏好。

状态默认存于 `~/.wolfpack`；覆盖路径用 `WOLFPACK_LEDGER` 与 `WOLFPACK_RAW_DIR`。原 DSH 的历史台账不自动搬迁；多个版本同时使用时应分开指定状态路径。

结果有五态：`pass`（所有验收执行成功）、`fail`（已执行的验收失败）、`error`（验收无法执行等工具故障）、`unverified`（没有验收）、`stale`（基线已通过，未启动工人）。无验收不能声称测试通过；磁盘产物可救回工人自报失败的完成状态，但不会改变未验证的 verdict。队长操作建议见 [briefing.md](briefing.md)，仅在明确采用 Wolfpack 时应用。

## 测试与兼容

```sh
node tests/run.mjs
```

测试仅使用模拟工人，不消耗真实模型额度。覆盖双工人、路由、冷却、基线、验收、续跑、并发、MCP、面板、Windows 启动故障与本次回归修复。

本版面向通用 CLI/MCP，旧 Cordis 插件、前端和 provider 完整保留在 [DSH 历史归档](../dsh/README.md)，等待 DSH 专供版迁移。旧 DSH 插件入口与历史 `lib/*` 内部接口不在当前通用包发布范围。迁移、文件快照边界及已知限制见 [迁移说明](../docs/MIGRATION.md)。MIT 许可。
