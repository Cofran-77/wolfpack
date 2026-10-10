# DSH 工人目录升级 · 2026-10-10

[English](2026-10-10-dsh-worker-registry.en.md) | [项目首页](../../README.md)

本次同步用户提供的最新 wolfpack-dsh 源码。包内版本保留 **2.1.0**；日期标记用于区分源码快照，不代表新的语义版本。Codex 和通用版保留各自实现与详细手册。

## 行为变化

| 内容 | 升级后的行为 |
| --- | --- |
| 工人目录 | 28 项：agy/Claude 两个原生适配，另有 26 个需主动启用的声明；generic 适配解析声明的参数和文本/JSON/JSONL 输出 |
| 原生选择 | workers_roster 驱动动态 UI；workers_enabled 保存候选集合；兼容 agy_enabled/claude_enabled，默认 agy 开、Claude 关 |
| 禁用范围 | 候选集合传递到委派核心；不会因 agy 冷却而越界选择被禁用的 Claude |
| 离线检查 | workers / workers --json 只检查文件与 PATH；workers --probe 才执行 --version |
| Windows Claude | 默认 .exe 找不到时可回退 npm .cmd/.bat，并覆盖带空格路径 |
| 输出边界 | 工具与健康快照使用无损 JSON 转换；对象 undefined 被剔除，非有限数、-0、循环、数组 undefined、非普通对象被拒绝，避免静默改变数据 |

配置名以工人目录名称为准，例如 cursor 的二进制是 agent，但使用 WOLFPACK_CURSOR / cursorPath。CLI/MCP 用 WOLFPACK_WORKERS_ENABLED 或 JSON workers_enabled；DSH 候选集合使用 Cordis workers_enabled，不能混用。详见 [工人目录](../../dsh/docs/WORKERS.md) 与 [架构](../../dsh/docs/ARCHITECTURE.md)。

## 验证及仍存在的边界

本地 DSH **306 例、11 套件**通过，使用真实宿主 peer 依赖和模拟工人，不调用真实账户、不消耗模型额度。根目录测试及 GitHub 六组合矩阵验证 Codex/通用版，不代表 DSH 的云端测试覆盖。

28 项目录不是 28 个已验证的真实 CLI 集成；“已安装”只表示找到文件。iflow/codebuff 无头契约未确认，预检拒绝启动。真实登录、额度、CLI 版本和续跑行为需用户环境验证。

DSH 仍是四工具，面板走宿主路由。Claude 分轨停滞证据、跨进程 live 写入接线、CLI health 命令仍未齐备。混合验收场景中，某条检查未启动而其他已执行检查成功，仍可能总判 pass，必须核对每条 ran/退出码。未借此次同步悄悄扩大代码改动范围。

## 升级步骤

1. 更新仓库，安装入口保持 dsh/，不使用 archive/。
2. 保留原有 profile 配置；按需选择扩展工人，不默认打开全部目录。
3. **完全退出并重开 DSH**，确保宿主与前端加载同一源码快照。源码升级需要重启；之后的开关/选择可即时生效。
4. 先查看 workers 离线目录，再执行小型独立任务与明确验收，核对摘要和侧栏。

本次还新增根目录与三版完整英文手册、各版中英文运行架构，保留中文详细介绍和历史资料，并加入双语贡献与社区增长计划。
