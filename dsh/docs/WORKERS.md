# 工人目录与 CLI 调用契约（Worker Registry Directory）

[English](WORKERS.en.md) | 简体中文

> ⚠️ **诚实性声明**：
> 这些调用契约取自官方文档或源码，本仓库未安装、未运行任何被测 CLI；首次使用前请自行核对。
> 任何标记为 `contract: unknown` 的 CLI 均未接通，预检（preflight）直接失败（fail-closed），绝不主观猜测 flag，绝不把 unknown 说成支持。

---

## 1. 28 个工人全景表

| # | 名称 (`name`) | 厂商 (`vendor`) | 主命令 (`bin`) | 别名 (`binAliases`) | 启用类别 | 契约状态 (`contract`) | 可信度 (`confidence`) | 官方来源 / 取证 URL | 说明与调用特征 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `agy` | Google | `agy.exe` (Win) / `agy` | — | 核心 (`core`)，默认启用 | `documented` | `high` | [antigravity.google](https://antigravity.google) | Antigravity CLI 原生适配器；`--conversation <id>` 续跑 |
| 2 | `claude` | Anthropic | `claude.exe` (Win) / `claude` | — | 核心 (`core`)，需勾选启用 | `documented` | `high` | [claude.ai/code](https://claude.ai/code) | Claude Code CLI 原生适配器；`--resume <id>` 续跑 |
| 3 | `codex` | OpenAI | `codex` | — | Opt-in | `documented` | `high` | [developers.openai.com](https://developers.openai.com/codex/noninteractive)<br>[exec.md](https://raw.githubusercontent.com/openai/codex/main/docs/exec.md) | 非 git 仓库必须 `--skip-git-repo-check`；JSONL 输出 |
| 4 | `gemini` | Google | `gemini` | — | Opt-in | `documented` | `high` | [headless.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/headless.md)<br>[geminicli.com](https://geminicli.com/docs/cli/headless/) | 非 TTY 自动进 headless；`--output-format json` |
| 5 | `qwen` | Alibaba | `qwen` | — | Opt-in | `documented` | `high` | [headless.md](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/headless.md) | JSON 输出为数组；headless 下 `--resume` 必须显式传 id |
| 6 | `opencode` | sst | `opencode` | — | Opt-in | `documented` | `high` | [opencode.ai/docs/cli/](https://opencode.ai/docs/cli/) | 输出为 JSONL 事件流；`run <prompt> --format json` |
| 7 | `iflow` | iFlow | `iflow` | — | **不可用** | `unknown` | `unknown` | [iflow README.md](https://raw.githubusercontent.com/iflow-ai/iflow-cli/main/README.md) | 官方 README 声明 iFlow CLI 于 2026-04-17 (UTC+8) 关停；未查到非交互 argv 契约 |
| 8 | `crush` | Charm | `crush` | — | Opt-in | `documented` | `high` | [charm.land/crush/cli/run](https://charm.land/crush/cli/run) | resume 只见于源码与示例注释，文档 Flags 表未列；且文档明说 run 的 session 默认不存历史 → 该字段有失效风险 |
| 9 | `goose` | Block | `goose` | — | Opt-in | `documented` | `high` | [goose-cli-commands](https://block.github.io/goose/docs/guides/goose-cli-commands) | json 顶层字段名 unknown；autoApprove 只能靠环境变量 `GOOSE_MODE=auto`，规格里 `autoApproveFlags: null`；输出格式未文档化 |
| 10 | `aider` | Paul Gauthier | `aider` | — | Opt-in | `documented` | `medium` | [aider.chat/docs/scripting.html](https://aider.chat/docs/scripting.html) | 文档与源码在 `--yes` 上冲突（已按源码取 `--yes-always`）；通常还需 `<files>` 参数，无文件时行为未验证；无 session id |
| 11 | `copilot` | GitHub | `copilot` | — | Opt-in | `documented` | `high` | [copilot-cli-reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) | `-p` 模式的 JSONL 字段名完全未文档化；`--output-format` 在 `-p` 可用是 changelog/PR 佐证而非命令参考表；输出格式未文档化 |
| 12 | `cursor` | Anysphere | `agent` | `cursor-agent` | Opt-in | `documented` | `high` | [cursor.com/docs/cli/headless](https://cursor.com/docs/cli/headless) | 官方主 bin 是 `agent`，`cursor-agent` 是 legacy 别名；`agent` 名字很通用，装机者注意 PATH 撞名；最终文本取顶层 `.result` |
| 13 | `amp` | Sourcegraph | `amp` | — | Opt-in | `documented` | `high` | [ampcode.com/docs](https://ampcode.com/docs) | approve flag unknown；`AMP_API_KEY` 必须 `sgamp_` 前缀；JSONL 事件流 |
| 14 | `droid` | Factory | `droid` | — | Opt-in | `documented` | `high` | [docs.factory.com](https://docs.factory.com)<br>[npmjs.org/droid](https://registry.npmjs.org/droid) | 多轮交互走 `stream-jsonrpc`（旧 `stream-json` 输入属遗留，原句截断，medium）；顶层带 `result` 与 `session_id` |
| 15 | `auggie` | Augment | `auggie` | — | Opt-in | `documented` | `high` | [docs.augmentcode.com](https://docs.augmentcode.com)<br>[npmjs.org/@augmentcode/auggie](https://registry.npmjs.org/@augmentcode/auggie) | 无 yolo；json 顶层字段名未取证 |
| 16 | `cline` | Cline | `cline` | — | Opt-in | `documented` | `high` | [docs.cline.bot](https://docs.cline.bot) | NDJSON 顶层 `type`；文本在 `agent_event.event.text` 一类事件内 |
| 17 | `continue` | Continue | `cn` | — | Opt-in | `documented` | `high` | [npmjs.org/@continuedev/cli](https://registry.npmjs.org/@continuedev/cli) | 证据来自 npm 元数据；approve 与 key 环境变量 unknown；字段名未文档化 |
| 18 | `openhands` | All-Hands AI | `openhands` | — | Opt-in | `documented` | `high` | [docs.openhands.dev](https://docs.openhands.dev) | `--json` 事件只有 `{"type":"action"\|"observation"}`，最终文本需自行拼接；npm 上的 `openhands` 是占位包，真正安装方式见官方文档 |
| 19 | `oz` | Warp | `oz` | — | Opt-in | `documented` | `medium` | [docs.warp.dev](https://docs.warp.dev) | Warp 双 bin `warp`/`oz`，只有 `oz` 有无头模式；`warp` 本体无一次性 prompt；输出格式未文档化 |
| 20 | `plandex` | Plandex | `plandex` | — | Opt-in | `documented` | `medium` | [github.com/plandex-ai/plandex](https://github.com/plandex-ai/plandex) | plandex.ai 全程 TLS 失败，证据回退到 GitHub 源码；输出格式未文档化 |
| 21 | `kimi` | Moonshot AI | `kimi` | — | Opt-in | `documented` | `high` | [moonshotai.github.io/kimi-code](https://moonshotai.github.io/kimi-code) | `-p` 与 `--yolo`/`--auto` 的关系原文表述含糊；auth 走 config.toml 的 `api_key_env`（export 无效）；stream-json 内的 session id 文档未列 |
| 22 | `mcode` | MiniMax | `mcode` | — | Opt-in | `documented` | `medium` | [npmjs.org/@minimax-ai/code](https://registry.npmjs.org/@minimax-ai/code) | json 顶层结构、自身 key 环境变量、`--permission` 取值全 unknown；输出格式未文档化 |
| 23 | `codebuddy` | Tencent | `codebuddy` | `cbc` | Opt-in | `documented` | `high` | [codebuddy.cn/docs/cli](https://codebuddy.cn/docs/cli) | 腾讯；是唯一「`-p` 模式也必须显式放权」的 CLI，`--dangerously-skip-permissions` 不可省；最终文本取 `.response` |
| 24 | `qoder` | Alibaba | `qoder` | — | Opt-in | `documented` | `high` | [docs.qoder.com/cli](https://docs.qoder.com/cli) | 通义灵码（Lingma）于 2026-05-20 更名为 Qoder CN，**不存在独立的「灵码 CLI」**，同一产品；字段名未取证；输出格式未文档化 |
| 25 | `trae` | ByteDance | `trae-cli` | — | Opt-in | `documented` | `high` | [github.com/bytedance/trae-agent](https://github.com/bytedance/trae-agent) | 与 Trae IDE 不是同一产品；用 pip/uv 安装（不是 npm），装机者需自行准备；无 JSON 输出 |
| 26 | `comate` | Baidu | `comatecli` | — | Opt-in | `documented` | `medium` | [npmjs.org/@comate/comatecli](https://registry.npmjs.org/@comate/comatecli) | 百度；完整 flag/事件名/auth 均 unknown（`comate.baidu.com/zh/docs` 404）；输出格式未文档化 |
| 27 | `spark` | iFLYTEK | `aispark` | — | Opt-in | `documented` | `medium` | [github.com/iflytek/spark-ai-cli](https://github.com/iflytek/spark-ai-cli) | 讯飞星火；输出/resume unknown；输出格式未文档化 |
| 28 | `codebuff` | Freebuff | `codebuff` | `cb` | **不可用** | `unknown` | `unknown` | [npmjs.org/codebuff](https://registry.npmjs.org/codebuff)<br>[freebuff.com](https://freebuff.com) | **headless 契约全 unknown**；npm `codebuff@1.0.688` 未标 deprecated，但 README 已改名 Freebuff、官方包转 `freebuff@0.2.26` |

---

## 2. 启用与配置指南

### 2.1 默认工人池与 Opt-in 隔离
- **核心工人 (`core`)**：`agy` 与 `claude`。没有显式配置启用工人时，狼群仅在这两个核心工人之间自动挑选或轮换。
- **扩展工人 (`opt-in`)**：其余 26 个工人规格均为 opt-in。只有在显式启用时，才会加入挑选池。
- **Fail-Closed 保护**：任何契约未文档化（`contract: unknown`）的条目，`preflight()` 均强制返回失败，绝不发起进程执行。

### 2.2 名字与命令差异及路径解析
当工人名称 (`name`) 与默认可执行文件 (`bin`) 不同时：
- `cursor` → 主可执行文件 `agent`，别名 `cursor-agent`
- `continue` → 主可执行文件 `cn`
- `trae` → 主可执行文件 `trae-cli`
- `comate` → 主可执行文件 `comatecli`
- `spark` → 主可执行文件 `aispark`
- `codebuddy` → 主可执行文件 `codebuddy`，别名 `cbc`
- `codebuff` → 主可执行文件 `codebuff`，别名 `cb`

**重要原则**：配置键与环境变量统一按 **工人名称 (`name`)** 派生，绝不按 `bin` 派生：
- `cursor` → 配置键 `cursorPath`，环境变量 `WOLFPACK_CURSOR`
- `continue` → 配置键 `continuePath`，环境变量 `WOLFPACK_CONTINUE`
- `trae` → 配置键 `traePath`，环境变量 `WOLFPACK_TRAE`
- `comate` → 配置键 `comatePath`，环境变量 `WOLFPACK_COMATE`
- `spark` → 配置键 `sparkPath`，环境变量 `WOLFPACK_SPARK`

路径解析回退机制：若配置了别名（`binAliases`），且在主 `bin` 未能在 PATH 中找到时，会自动依次尝试各别名。

### 2.3 如何启用工人

以下环境变量和 JSON 启用方式用于 CLI/MCP。DSH 插件用 Cordis workers_enabled CSV（由界面写入）决定候选池，不使用这些 CLI 启用字段。

#### 方式 A：环境变量
通过 `WOLFPACK_WORKERS_ENABLED` 设置逗号分隔的工人名字（不区分大小写）：
```bash
# 启用 codex 与 cursor
export WOLFPACK_WORKERS_ENABLED="agy,codex,cursor"
```

#### 方式 B：配置文件 (`wolfpack.config.json`)
```json
{
  "workers_enabled": "agy,codex,cursor"
}
```

#### 方式 C：DSH 插件设置 (Cordis Config)
在插件的 `workers_enabled` 设置项填入工人名列表（CSV 格式，如 `agy,cursor`）。

### 2.4 在 GUI 里选择工人（方案 A 下拉菜单）

在 DSH 对话界面的输入框右侧（`conversation.input.right` 槽位），「🐺 狼群」模式胶囊右侧包含一个工人下拉菜单按钮（`▾`）：
1. **数据源**：下拉菜单中的工人条目来自配置快照中的 `workers_roster` 字段（JSON 格式 `{ version: 1, workers: [...] }`），覆盖全部 28 个工人；客户端完全动态读取快照，不硬编码工人列表。
2. **勾选与启停**：
   - 用户在下拉菜单中直接勾选或取消勾选工人，前端将计算启用工人的稳定序列化集合并写入 `workers_enabled` 配置字段（CSV 格式）。
   - 保底约束：至少保留一个启用的工人，取消最后一个勾选会被前端明确拦截并提示拒绝。
3. **可用状态探测**：
   - 每个工人的「已安装 / 未安装」状态是由插件宿主在模块加载时根据 PATH 与文件系统存在性预探测生成的，**探测过程禁止 spawn 外部进程**，避免拖慢插件或宿主启动。
   - 客户端手写模块无法探测文件系统或进程，完全基于宿主随快照下发的 `workers_roster` 元数据进行渲染与状态标记。

---

## 3. 查看与探测工人状态

使用 `wolf CLI` 的 `workers` 子命令查看当前系统中的工人可用性与解析路径：

```bash
# 查看表格视图（离线模式，绝不执行外部进程）
node bin/wolf.mjs workers

# 输出机器可读 JSON 格式
node bin/wolf.mjs workers --json

# 显式版本探活（仅对已解析到本地路径的工人执行 <bin> --version）
node bin/wolf.mjs workers --probe
```

---

## 4. 明确不登记清单（避免重复劳动）

下列产品经过调研与取证核对，**明确不在本仓库登记**：

| 产品 | 判定结论 | 证据与原因 |
|---|---|---|
| **Z.ai / 智谱 GLM** | **无 agent CLI** | ZCode 是桌面 ADE，无 CLI/headless 文档；`@z_ai/coding-helper` 仅是辅助库而非 autonomous agent CLI。来源：[docs.z.ai/devpack/tool/zcode](https://docs.z.ai/devpack/tool/zcode) ｜ [npmjs.org/@z_ai/coding-helper](https://registry.npmjs.org/@z_ai/coding-helper) |
| **Roo Code** | **无官方 CLI** | 官方仅提供 IDE 插件与 Cloud 服务；docs sitemap 510 条 URL 里 cli/headless 计数为 0；npm 上无官方包。来源：[docs.roocode.com/sitemap.xml](https://docs.roocode.com/sitemap.xml) |
| **Sourcegraph Cody CLI** | **未核实 / 暂不登记** | Cody 当前主推 IDE 插件与企业托管，CLI 契约不稳定，取证未闭环。 |
| **JetBrains Junie** | **未核实 / 暂不登记** | JetBrains 官方目前未公开独立 headless CLI 调用规范。 |
| **AWS Kiro** | **未核实 / 暂不登记** | 契约未核实，官方无公开无头 CLI 规范。 |
| **Google Antigravity CLI** | **已有原生核心适配器** | 已由 `agy` 核心工人承载，无需再作为扩展 specs 登记。 |
| **Windsurf CLI** | **未核实 / 暂不登记** | 官方仅为独立 IDE，未开放非交互无头 CLI 契约。 |
| **iFlow CLI** | **已在表内登记但关停** | 已在第一批规格中登记，但标记为 `contract: unknown`；官方 README 声明 2026-04-17 (UTC+8) 关停服务。 |

---

## 5. 取证方法学

- **纯 HTTP GET 取证**：全部证据通过只读抓取官方文档站点、GitHub 官方仓库公开源码及 npmjs 官方包元数据获取。
- **绝不安装或执行被测 CLI**：全过程未在本机下载、安装或执行任何被测 CLI 程序，无安全副作用。
- **诚实留白与 Fail-Closed**：所有查不到参数或结构化格式的字段一律如实标注 `unknown` 或保留为 `output: 'text'`，未编造任何 flag 或参数名。
