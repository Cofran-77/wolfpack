# Wolfpack

本地 AI 任务委派工具集。队长负责拆任务与审查，外部 CLI 工人负责执行，Wolfpack 负责机械验收、台账、健康冷却与实时状态。

## 版本选择

| 目录 | 展示名称 | 状态与用途 |
| --- | --- | --- |
| [universal](universal/README.md) | Wolfpack | 通用 CLI / MCP 版，可供支持 stdio MCP 的客户端使用 |
| [codex](codex/README.md) | Wolfpack for Codex | 保留 Codex 专供版及队长操作手册 |
| [dsh](dsh/README.md) | Wolfpack for DSH | 专供版待加入；旧插件源码单独归档，不作为新版发布 |

通用版与 Codex 版均支持 `agy` 和 Claude Code 工人、自动路由与续跑、故障冷却、基线检查、并发任务、实时状态和只读面板。Node.js ≥20，无第三方运行时依赖。

## 快速开始

选择一个版本后，在其目录内运行：

```sh
node bin/wolf.mjs status --json
node bin/wolf.mjs health --json
node tests/run.mjs
```

部署时指向选定版本的 `bin/wolf-mcp.mjs`，不要指向仓库根目录。目录迁移说明见 [MIGRATION.md](docs/MIGRATION.md)。

```json
{
  "mcpServers": {
    "wolfpack": {
      "command": "node",
      "args": ["<仓库绝对路径>/universal/bin/wolf-mcp.mjs"]
    }
  }
}
```

真实派活前需安装并登录至少一个工人 CLI。工人直接在指定工作区读写，不自动隔离并发任务；每个任务应提供可机械执行的验收命令。

## 开发与验证

仓库根目录运行 `npm test`，依次验证通用版和 Codex 版。历史 DSH 插件不参与此测试，其原测试需要 DSH peer 依赖。GitHub Actions 在 Windows、Linux、macOS 上运行当前两版测试。

原始交付包、备份和本地凭据不进入当前发布目录。许可为 MIT。
