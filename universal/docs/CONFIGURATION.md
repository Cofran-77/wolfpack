# Wolfpack 配置参考

## 配置

可参考 [wolfpack.config.example.json](wolfpack.config.example.json) 创建本地 `wolfpack.config.json`。默认从当前工作目录向上查找配置文件；`WOLFPACK_CONFIG_FILE` 可指定要读取的文件。

常用配置优先使用对应环境变量，再使用 JSON 配置值，最后采用默认值。

| JSON 配置项 | 环境变量 | 默认值 / 说明 |
| --- | --- | --- |
| `agyPath` | `WOLFPACK_AGY` | 从 PATH 查找 `agy`，Windows 为 `agy.exe` |
| `worker` | `WOLFPACK_WORKER` | 工人偏好：`auto`（默认，全自动：装了谁用谁、两个都装则轮流）/ `agy` / `claude` |
| `claudePath` | `WOLFPACK_CLAUDE` | 从 PATH 查找 `claude`，Windows 为 `claude.exe` |
| `claudeModel` | `WOLFPACK_CLAUDE_MODEL` | 仅对 claude 生效的模型覆盖，优先于 `WOLFPACK_MODEL` |
| `claudePermissionMode` | `WOLFPACK_CLAUDE_PERMISSION_MODE` | 不设时与 agy 对齐（绕过权限提示）；可设 `plan`、`acceptEdits` 等 |
| `claudeAgents` | `WOLFPACK_CLAUDE_AGENTS` | 透传 `--agents <json>`，定义 claude 的自定义子智能体 |
| `mode` | `WOLFPACK_MODE` | `accept-edits` |
| `model` | `WOLFPACK_MODEL` | 由 agy 决定 |
| `effort` | `WOLFPACK_EFFORT` | 由 agy 决定 |
| `ledgerPath` | `WOLFPACK_LEDGER` | `~/.wolfpack/runs.ndjson` |
| `rawDir` | `WOLFPACK_RAW_DIR` | `~/.wolfpack/raw` |
| `taskTimeoutMs` | `WOLFPACK_TASK_TIMEOUT` | `0`，不设置 Wolfpack 任务超时 |
| `verifyTimeoutMs` | `WOLFPACK_VERIFY_TIMEOUT` | `300000` 毫秒 |
| `continuationTokenBudget` | `WOLFPACK_TOKEN_BUDGET` | `1000000`，累计用量达到阈值时触发新会话 |
| `stall.windowSeconds` / `stall.windowSecondsByWorker` | `WOLFPACK_STALL_WINDOW`、`WOLFPACK_STALL_WINDOW_AGY` / `WOLFPACK_STALL_WINDOW_CLAUDE` | `300`（秒）：多久没有进展算疑似停滞；`0` / `off` 关闭该工人的监控 |
| `stall.warnings` / `stall.warningsByWorker` | `WOLFPACK_STALL_WARNINGS`（可加 `_AGY` / `_CLAUDE` 后缀） | `3`：最多报警几次；`0` 只采样不打扰 |
| `stall.pollSeconds` | `WOLFPACK_STALL_POLL` | `30`（秒）：采样间隔，下限 5 秒 |
| `stall.toast` | `WOLFPACK_STALL_TOAST` | 默认 `false`。设 `true` / `1` 时在 macOS 弹系统通知（CLI/MCP 下默认不打扰） |
| `stallLogPath` | `WOLFPACK_STALL_LOG` | `<台账目录>/stall.ndjson`：停滞报警台账（NDJSON） |
| `stall.storeRoots`（或旧版顶层 `stallStoreRoots`） | `WOLFPACK_AGY_STORE_ROOT` / `WOLFPACK_CLAUDE_STORE_ROOT` | 覆盖对应工人的会话存储根（默认 `~/.gemini/antigravity-cli` 与 `~/.claude/projects`） |
| `workerHealth.enabled` | `WOLFPACK_WORKER_HEALTH` | `true`：工人健康与自动冷却总开关；`off` 完全退回老规则 |
| `workerHealth.filePath` | `WOLFPACK_HEALTH_FILE` | `<台账目录>/worker-health.json`：健康台账文件 |
| `workerHealth.failThreshold` | `WOLFPACK_WORKER_FAIL_THRESHOLD` | `2`：普通失败连续几次进入冷却（工人自身故障当轮即冷却） |
| `workerHealth.cooldownMs` | `WOLFPACK_WORKER_COOLDOWN_MS` | `600000`：普通失败冷却时长（毫秒） |
| `workerHealth.capacityCooldownMs` | `WOLFPACK_WORKER_CAPACITY_COOLDOWN_MS` | `300000`：额度/容量不足（含中转池子耗尽）冷却时长 |
| `workerHealth.timeoutCooldownMs` | `WOLFPACK_WORKER_TIMEOUT_COOLDOWN_MS` | `600000`：超时（疑似挂住）冷却时长 |
| `workerHealth.authCooldownMs` | `WOLFPACK_WORKER_AUTH_COOLDOWN_MS` | `1800000`：未登录/鉴权失败冷却时长 |
| `panelPort` | `WOLFPACK_PANEL_PORT` | `8787`：面板端口（被占用时自动改用空闲端口） |
| `panelHost` | `WOLFPACK_PANEL_HOST` | `127.0.0.1`：面板监听地址 |
| `panelToken` | `WOLFPACK_PANEL_TOKEN` | 不设：面板口令；设了就要求 `?token=` 或 `x-wolfpack-token` 请求头 |
| `panelRefreshMs` | `WOLFPACK_PANEL_REFRESH` | `3000`：面板自刷新间隔（毫秒，下限 500） |

会话阈值用于控制上下文续用，并不是费用上限或单次任务的硬 token 限额。实际模型用量由 agy 的返回数据决定。

本地配置、凭据和运行日志不应提交到仓库；项目的 `.gitignore` 已排除常见相关文件。
