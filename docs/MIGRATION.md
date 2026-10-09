# 迁移与版本说明

## 仓库目录变更

旧仓库根目录的 Codex 文件移动至 `codex/`，名称保留为 **Wolfpack for Codex**，包名仍是 `wolfpack-codex`。通用版位于 `universal/`，包名保留为 `wolfpack-unified`。2026-10-10 已加入最新 DSH 专供版，当前安装目录为 `dsh/`。

旧 MCP 配置中的 `<仓库>/bin/wolf-mcp.mjs` 应改为 `<仓库>/codex/bin/wolf-mcp.mjs`；切换通用版则改为 `<仓库>/universal/bin/wolf-mcp.mjs`。既有交付目录没有移动，正在使用旧绝对路径的客户端不会因此被改动。

## 通用版 2.1.0

基于 Codex 1.1.0 的最新本地修复同步执行核心，新增 Claude Code 工人、自动轮换与续跑沿用、健康冷却、`wolf_live`、`wolf_panel`、`health`、按工人区分的停滞监控与流水、派发即记账、UTF-8 MCP 帧读取、Windows 启动错误诊断，以及不依赖 DSH 的离线测试。

保留原通用版非 Git 工作区的文件快照：识别新增、大小或修改时间变化、删除；不跟随符号链接，忽略依赖与自身状态路径。最多扫描 10000 个条目；权限错误或超限时如实显示无法判定。该检测不是内容审计，修改时间与大小均未变化的写入可能无法识别。仅内置 Node 运行时默认允许本地文件系统回退；其他注入宿主不隐式回退，避免绕过宿主边界。状态排除路径按真实路径归一，兼容 macOS 临时目录别名与 Windows 目录联接。

所有登记验收都启动并通过才允许判 `pass`；其中有命令无法启动则判 `error`，不凭其他成功命令救回。取消任务先写入按 runId 匹配的独立取消标记，再终止目标工人树，保留共享宿主；宿主将本轮记录为 `aborted`、跳过验收，不因用户取消而惩罚工人健康。尚无工人 PID 时返回可重试的说明。特殊字符、大小写及长任务名使用散列登记名，散列前缀保留，避免与原文任务名碰撞。

通用版的默认状态目录为 `~/.wolfpack`，原 DSH 版的 `~/.dsh/wolfpack` 不自动迁移。继续历史任务时显式设置 `WOLFPACK_LEDGER` 和 `WOLFPACK_RAW_DIR`；两个版本并行使用时建议各自指定状态路径。

## DSH 与兼容范围

旧通用包中的 DSH Cordis 插件原样归档于 `dsh/archive/`，不再是当前安装入口。最新 DSH 专供版保存于 `dsh/lib/`，带 Cordis 入口、前端、provider、四工具、工人启用选择和原生面板。使用 `dsh plugin --profile <profile> add <仓库绝对路径>/dsh` 接入；切换前按 `dsh/docs/CUTOVER.md` 备份 profile 与配置。

DSH 的包名保留 `wolfpack-unified`，适配既有 patch 名称。通用版也使用这个历史包名，不能将两者混装或相互替换。要同时使用，指定不同目录与状态路径。

DSH 插件配置通过宿主 Config 读取，enabled、agy_enabled、claude_enabled 即时更新；CLI/MCP 则读取 wolfpack.config.json 和环境变量。不要将通用版 JSON 配置直接当作 DSH 插件设置。DSH 默认 agy 开、Claude 关，需勾选 Claude 才进入双工人候选集合。

新版通用包没有发布旧 Cordis `lib/index.js` 和兼容外壳；程序化入口见 universal/package.json 的 exports。DSH 版保留自身兼容外壳与旧导出，但三个版本独立维护；具体支持范围和后端边界见各版 README。

## 文档保留

仓库总 README 恢复为详细的产品介绍、三版对比与安装指南；DSH 保留完整源码交付手册，Codex 详细手册继续维护，通用版增加机制与排查说明。旧 Codex 仓库的完整介绍保存在 docs/history/README-CODEX-ORIGINAL.md；其中旧路径以当前文档为准。历史 archive 不删除。

## 当前边界

跨进程同任务检查仍有非原子登记的竞态窗口；并发任务共享工作区；CLI 的自动轮换游标每次启动重置。面板是只读有界取样，停滞只报警，不自动杀进程。真实服务登录、模型配额及网络可用性由工人 CLI 管理。
