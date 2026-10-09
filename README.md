# Wolfpack · 狼群模式

**把 AI 的判断、工人的执行和代码的验收接成一条流水线。**

Wolfpack 是一个本地 AI 任务委派工具集。队长理解目标、拆分任务、规定边界并审查结果；外部 CLI 工人在独立会话中读文件、改代码和运行命令；Wolfpack 负责启动工人、延续会话、执行验收、记录台账并返回有界摘要。

本仓库维护 **Wolfpack for DSH、Wolfpack for Codex、Wolfpack 通用版**。三版沿用同一套设计思想，分别保存独立实现，能力与配置并非完全相同。完整手册见 [DSH](dsh/README.md)、[Codex](codex/README.md)、[通用版](universal/README.md)。

**首推 DSH 版。** DSH“万物皆插件”的思路最适合 Wolfpack：任务委派能作为原生插件提供按钮开关、工人选择、工具结果卡片和右侧实时面板。已有 Codex 工作流的用户可选择 Codex 专供版；希望接入其他 MCP 客户端、终端或脚本的用户可选择通用版。

## Wolfpack 为什么值得使用

复杂任务混合了两类工作：理解需求、决定方案、设定验收与裁决结果；以及按明确目标修改文件、补测试、运行命令和整理交付。把所有执行细节留在队长长会话里，会产生大量原始日志、重复阅读和上下文膨胀。

Wolfpack 将自洽、可独立验收的执行工作派给外部 CLI，让队长读取实测摘要，避免直接吞入工人的整段会话。工人使用自己的登录、供应商和模型配置；如果工人模型成本更低，也能减少高成本队长模型承担的机械执行。实际节省取决于任务拆分、模型价格与返工情况。

适合修复已复现问题、实现边界明确的模块、补回归测试、批量修改和独立文档任务。架构取舍、依赖判断、权限决定和最终审查仍由队长负责。小改动可以直接做；有前后依赖的任务应顺序执行；同时改同一文件的任务需要协调边界。

## 三个版本怎么选

| 对比项 | DSH 专供版 | Codex 专供版 | 通用版 |
| --- | --- | --- | --- |
| 目录与手册 | [dsh/](dsh/README.md) | [codex/](codex/README.md) | [universal/](universal/README.md) |
| 展示名称 | Wolfpack for DSH | Wolfpack for Codex | Wolfpack |
| 推荐用途 | DSH 原生插件体验，首推 | Codex 队长拆任务与独立验收 | 兼容本地 stdio MCP 的客户端、CLI、脚本 |
| 主要入口 | Cordis 插件，另带 CLI/MCP | MCP 与 CLI，配套 AGENTS.md | MCP、CLI 与程序化核心导出 |
| 工人 | Antigravity agy / Claude Code claude | 同左 | 同左 |
| 工人选择 | 原生复选框收窄候选集合，支持自动挑选与轮换 | 环境变量/配置文件设置偏好与路径 | 环境变量/配置文件设置偏好与路径 |
| 图形开关 | 输入框按钮与设置页同步，开关即时生效 | 无 DSH 原生按钮 | 无 DSH 原生按钮 |
| 对话工具 | 4 个：delegate / status / kill / team | 6 个，另含 live / panel | 6 个，另含 live / panel |
| 实时展示 | DSH 右侧标签页与宿主 HTTP 路由 | 独立本地 HTTP 面板，按工人分区 | 独立本地 HTTP 面板，按工人分区 |
| 工具结果卡片 | 原生 status / kill 卡片 | 文本或 JSON 摘要 | 文本或 JSON 摘要 |
| 停滞监控 | 目前主要接 agy 证据，Claude 分轨未接齐 | 两个工人独立采样 | 两个工人独立采样 |
| 健康冷却 | 核心与摘要支持，无 CLI health 子命令 | health 查询与重置 | health 查询与重置 |
| 改动探测 | Git 差集与非 Git 文件快照 | Git 状态差集；非 Git 显示无法判定 | Git 差集与有界非 Git 文件快照 |
| 默认状态位置 | $DSH_HOME/wolfpack，回退 ~/.dsh/wolfpack | ~/.wolfpack | ~/.wolfpack |
| 运行依赖 | CLI/MCP 无第三方运行依赖；插件需 DSH peer 依赖 | Node.js 原生模块，无第三方运行依赖 | 同左 |
| 队长说明 | 随插件开关注入 briefing.md | AGENTS.md 详细委派手册 | briefing.md 按需交给宿主 AI |

DSH 的四工具不代表没有原生面板：它将观察能力接到宿主侧栏与 HTTP 路由，减少对话工具面的负担。另两版通过 wolf_live / wolf_panel 提供观察旁路，因此是六工具。

选择一个版本接入即可。三版均使用 wolf / wolf-mcp 命令名，DSH 与通用版还保留相同历史包名 wolfpack-unified，不要把它们当同一份包混装。多版并用时，以绝对路径调用各自入口，并分开指定台账及原始输出目录。

## 共同的执行机制

### 任务书自包含，验收提前写清楚

工人看不到队长会话。任务书应写明背景、目标、允许修改范围、不能破坏的接口、交付文件和验收命令。给工人可判定的目标，让它自己选择执行路径；最后由代码验收、队长审查。

```json
{
  "task_id": "fix-parser-empty-input",
  "task": "修复 parser 对空输入抛异常的问题。仅修改 parser 模块与对应测试，保持公开 API。补充回归测试；报告 summary、claimed_files、uncertainties 和实际检查结果。",
  "verify_baseline": ["npm run test:parser"],
  "verify": ["npm run test:parser", "npm run build"]
}
```

### 基线闸门避免重复派活

verify_baseline 是派活前必须失败的检查。基线已通过时返回 stale，本轮不启动工人；检查无法执行时报告工具故障；问题仍被复现时才进入执行。应选能复现特定问题的检查，不要混入无关成功命令。

### 自动选择、会话续跑与健康冷却

候选工人由安装状态、配置、DSH 启用集合（仅 DSH 版）及健康状态决定。同一任务复用 task_id 可以沿用原工人会话；换工人会冷启动，避免混用不同 CLI 的会话 ID。

容量、额度、鉴权或超时等故障进入健康台账，后续任务可改派另一工人。常见默认冷却为容量类 5 分钟、超时/普通失败 10 分钟、鉴权类 30 分钟。自动恢复、显式偏好和所有工人都冷却时的处理以各版手册为准。

### “队员声称”与“我已核实”分开返回

摘要第一段是工人报告，第二段是 Wolfpack 实测证据：磁盘改动、验收是否执行、退出码和失败信号。原始输出落盘，默认不整段送入队长上下文。

工人报 ERROR 不一定表示没有交付：留下产物或机械验收通过时，执行状态可能救回为 completed。**completed 与 verdict: pass 是不同维度；文件存在不等于内容正确。**

| verdict | 含义 |
| --- | --- |
| pass | 机械验收通过；各版对部分检查未启动的边界见版本手册 |
| fail | 检查实际执行但未通过 |
| error | 检查无法执行等工具/环境问题 |
| unverified | 未注册验收，不能声称已验收通过 |
| stale | 基线已通过，本轮未派活 |

### 并发小队与可回溯台账

wolf_team 接收 1–8 个独立任务，并发上限为 4。同批重复任务 ID 被拒绝，单任务异常隔离，结果按输入顺序汇总。任务共享目标工作区，不自动创建隔离目录。

台账记录 ID、轮数、会话、工人、状态、verdict、耗时与 token。wolf_status 只读台账，不重新派活。频繁将状态回执送入 AI 会话仍会占上下文；持续观察适合用面板。

## DSH：最完整的原生插件体验

DSH 版接入宿主的插件装载、配置、提示注入、子进程与前端扩展体系：

- **按钮开关**：输入框狼群按钮与“设置 → 通用”同步 enabled 状态，开关无需重启，关闭时摘除工具。
- **工人复选框**：启用 agy、Claude 或二者，显示已启用/未启用/未安装；UI 防止取消最后一个工人。当前默认 agy 开、Claude 关，要双工人轮换请勾选 Claude。
- **队长提示**：briefing.md 随插件启用接入 systemPrompt，减少手动粘贴操作约定。
- **原生工具卡片**：status 用任务行与徽标展示台账，kill 显示取消结果与原因。
- **右侧实时面板**：显示运行数量、轮次、步骤、耗时、token 与可读 transcript。运行时积极刷新、空闲时放缓、隐藏页面暂停轮询。
- **宿主子进程管理**：使用 ctx.subprocess，透传宿主输出落盘、取消信号和生命周期语义。

这些交互是 DSH 版的主要价值。Claude 分轨监控、跨进程登记等仍有实现边界，详见 [DSH 完整手册](dsh/README.md)。不要直接将另两版能力套在 DSH 上。

## 安装与第一次使用

需要 Node.js **≥20**。真实派活还需至少一个已安装并登录的工人 CLI；登录、代理、供应商与配额由工人自身管理。离线测试无需真实工人账户。

```sh
git clone https://github.com/Cofran-77/wolfpack.git
cd wolfpack
```

### DSH 插件

面向 DSH 0.2.0 及以后，将仓库 **dsh 子目录**装进目标 profile：

```sh
dsh plugin --profile <profile> add <仓库绝对路径>/dsh
```

首次安装后重启宿主。通过输入框按钮启用插件并选择工人；开关与工人选择自身无需重启。依赖、Cordis patch、权限与回滚见 [DSH 手册](dsh/README.md) 和 [切换指南](dsh/docs/CUTOVER.md)。

### Codex

服务脚本指向 **codex 子目录**：

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["<仓库绝对路径>/codex/bin/wolf-mcp.mjs"]
```

按需设置 WOLFPACK_AGY / WOLFPACK_CLAUDE，配合 [Codex 队长手册](codex/AGENTS.md)。接入既有项目时按需合并指令。完整示例见 [Codex README](codex/README.md)。

### 通用 CLI / MCP

在目标项目工作目录，以绝对路径调用通用版：

```sh
node <仓库绝对路径>/universal/bin/wolf.mjs status --json
node <仓库绝对路径>/universal/bin/wolf.mjs delegate --task-id fix-parser --task "完整独立任务书" --verify "npm test"
```

常见 JSON MCP 配置：

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

客户端配置位置与字段可能不同。MCP 服务 cwd 是目标工作区，脚本所在目录不会自动成为任务目录。命令、配置与面板详见 [通用版 README](universal/README.md)。

## 目录与维护

```text
wolfpack/
├── README.md                 项目介绍、版本对比与入口
├── dsh/                      当前 DSH 原生插件及完整手册
│   ├── lib/                  Cordis 外壳、前端、provider 与核心
│   ├── tests/                宿主契约与模拟工人测试
│   └── archive/              历史源码，非当前安装入口
├── codex/                    Codex 专供版、AGENTS.md 与离线测试
├── universal/                通用 CLI/MCP、briefing.md 与离线测试
├── docs/MIGRATION.md         目录、配置与历史迁移
└── scripts/test.mjs          通用版与 Codex 版统一测试入口
```

三版分别维护。DSH 包名保留 wolfpack-unified，兼容既有 Cordis 装载条目；目录和展示名明确标为 DSH 版。旧 archive 保留作迁移参考，不参与当前 DSH 发行包。原 Codex 详细介绍保留在 [历史介绍](docs/history/README-CODEX-ORIGINAL.md)。

## 验证与边界

根目录 npm test 验证通用版与 Codex 版。GitHub Actions 在 Windows、macOS、Linux 和 Node.js 20/24 上检查两版。DSH 测试需已安装的宿主 peer 依赖：在 dsh/ 中运行 node tests/run.mjs，以 DSH_HOME 或 WP_TEST_HOME 指定环境，详见版本手册。模拟工人测试不等同于真实账户、所有宿主版本的端到端验证。

各版均不自动隔离并发工作区；跨进程互斥并非原子文件锁。运行日志、会话用量和产物检测有各自边界，应提供合适的机械验收并审查重要交付。Wolfpack 也不会代替你授权发布或其他外部操作。

MIT 许可。完整配置、架构说明和故障排查分别保留在各版本目录。
