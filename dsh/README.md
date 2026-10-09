# Wolfpack for DSH

此目录预留给后续加入的 DSH 专供版，目前没有发布新版 DSH 插件。

`archive/wolfpack-unified/` 完整保留 2026-09-16 原通用交付包的源码、DSH Cordis 入口、前端、provider、运行时和原测试，作为迁移参考。配套安装说明位于 `archive/DSH通用版-分发与安装文档.md`。归档不是已验证的当前版本，不应按新版通用版的能力安装它。

后续接入时需保留 Cordis `apply(ctx)`、settings 生命周期、provider 契约和 `ctx.subprocess` 的沙箱与输出落盘语义；同步适配双工人、冷却、六个工具及新版句柄契约。应在真实 DSH 宿主中验证插件加载、面板、取消任务与卸载。

历史源码已知待处理：部分验收未启动仍判通过；跨进程取消误杀宿主；任务登记文件名碰撞；占用释放异常；Content-Length 中文字节处理；以展示标签复用 provider 会话。当前通用 CLI/MCP 使用 `universal/`，不会加载归档。
