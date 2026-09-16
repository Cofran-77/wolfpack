# Wolfpack Codex 架构设计文档

本文档说明 `wolfpack-codex` 的模块职责、适配器契约，以及与 `dsh-wolfpack` 参考实现的文件对应关系。

---

## 一、模块映射关系

| wolfpack-codex 文件 | 对应 dsh-wolfpack 源文件 | 核心职责与改动说明 |
| --- | --- | --- |
| `src/config.mjs` | `lib/index.js` (部分) | 配置解析（环境变量 → `wolfpack.config.json` → 平台默认），杜绝绝对路径 |
| `src/spawn.mjs` | `ctx.subprocess` (Cordis) | **唯一**子进程出口，封装 `node:child_process`，实现 Windows 与 Unix 强力进程树杀灭 |
| `src/verify.mjs` | `lib/agy-runner.js:1590-1719` | 验收与基线命令执行（支持 `WOLFPACK_SHELL` 覆盖），基线闸门判定，失败信号提取 |
| `src/ledger.mjs` | `lib/runs-ledger.js` | NDJSON 追加写与增量读折叠，同 `task_id` 独占锁（拒绝并发），文件原子压缩 |
| `src/delegate.mjs` | `lib/wolf-delegate.js` + `lib/agy-runner.js` | 核心委派流程：基线闸门 → 独占锁 → 快照 → 工人 → 产物差集 → 验收 → 判定政策与机械救回 → 台账 |
| `src/digest.mjs` | `lib/wolf-delegate.js:119-220` | 有界 digest 渲染：严格区分「队员声称」与「我已核实」，诚实展示诊断与 tail 降级 |
| `src/team.mjs` | `lib/wolf-team.js` | 多工人并发扇出、入参严格校验、重复 `task_id` 整批拒绝、单任务失败隔离、摘要收敛 |
| `src/worker/agy.mjs` | `lib/agy-runner.js` (适配部分) | agy 工人适配器契约实现（参数拼装、会话延续、结果分类、心跳探针） |
| `src/worker/index.mjs` | 新增 | 工人适配器注册表，支持未来扩展其它 CLI 工人 |
| `bin/wolf.mjs` | 新增独立 CLI | 包含 `delegate` / `status` / `kill` / `team` 子命令，零运行时依赖 |
| `bin/wolf-mcp.mjs` | 新增 MCP stdio 服务 | 手写 JSON-RPC 2.0，暴露 `wolf_delegate` / `wolf_status` / `wolf_kill` / `wolf_team` |

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
