# Wolfpack for DSH · 狼群模式（Wolfpack Mode）

## 本仓库首推的原生插件版

DSH 是当前最适合 Wolfpack 原生交互的宿主：它将工具、配置、系统提示、子进程和前端都纳入“万物皆插件”的扩展机制。Wolfpack 不只是一个外部工具入口，而是在输入框和设置页提供开关，在开关旁选择工人，在对话中显示工具卡片，并在右侧面板持续观察任务。

这份目录现在是可安装的当前 DSH 专供版。安装目标应是仓库的 dsh/，不是根目录，也不是 archive/。包名仍保留 wolfpack-unified，兼容既有 Cordis patch；它与通用版的包名相同，但不是同一份代码或同一套宿主入口。

| 选择 | 最适合的用途 | 主要区别 |
| --- | --- | --- |
| **DSH 本版** | 原生插件交互，首推 | 四工具；按钮与工人复选框；systemPrompt；status/kill 卡片；宿主侧栏与路由 |
| [Codex 版](../codex/README.md) | Codex 当队长的开发工作流 | AGENTS.md；六工具；独立 HTTP 面板；双工人分轨监控与 CLI health |
| [通用版](../universal/README.md) | 其他本地 MCP 客户端、CLI、程序化接入 | 六工具；独立面板；有界非 Git 快照；无需 DSH peer 依赖 |

三版沿用同一套设计思想，分别维护实现。DSH 原生体验最完整，但并不意味着另一版的每个后端修复已经同步到这里。例如本版 Claude 分轨监控、跨进程登记和混合验收启动错误仍有边界，下文 §9 明确列出；四工具与六工具也不能直接互换。

**从按钮开始使用**：首次装入 profile 并重启后，启用狼群按钮；默认 agy 开、Claude 关。需要 Claude 时在弹层或设置页勾选它，两处状态同步。只启用一个就收窄候选集合；两个启用时允许自动挑选与轮换。选好后向队长给出独立任务、边界和验收，结束后看“我已核实”的证据与工具卡片，需要持续观察则打开侧栏。

以下保留完整功能介绍、命令、配置、架构、测试和故障排查，方便安装者与维护者逐项理解，不以简短目录导航替代版本手册。

> **Wolfpack 家族的 DSH 专供版**：一份宿主无关的核 + 可插拔的工人适配器。
> 把「自洽、可机械验收」的活派给外部 CLI 工人
> （适配器：Antigravity CLI `agy`、Claude Code `claude`），
> **验收由代码跑、结论由代码下**，队长只读一段有界的双段摘要。
>
> 同族的另外两份发行版是 `universal/`（CLI + MCP 通用版）与 `codex/`（Codex / AGENTS.md 版），
> 三者共用同一套设计；**只有本目录带 DSH 宿主的 Cordis 外壳**
> ——对话里的开关、工人多选、工具卡片与右侧实时面板都在这一份里。

**相对上一版（2.0.0）的主要变化**

- 新增 **Claude Code 工人适配器**（`lib/core/worker/claude.mjs`）与**自动挑选 / 轮换**
  （`worker` 默认从 `agy` 变为 `auto`）。
- 新增**按故障种类分档的健康冷却**：容量不足 5 分钟、超时与普通失败 10 分钟、
  未登录 30 分钟；状态落在 `<台账目录>/worker-health.json`。
- 狼群开关（输入框右侧）旁新增 **启用工人多选**：`agy_enabled` / `claude_enabled`
  两个 volatile 开关，改完立刻生效、不用重启宿主；缺省时 **agy 开、claude 关**
  （与 `Config` schema 的默认值一致，见 §4.17）。
- 工具仍是 **4 个**，签名与语义不变；测试从 230 例增至 **270 例**（新增 3 个套件）。

```
队长（你 / 任意 LLM 客户端）
   │  派活：task_id + 完整任务书 + verify（验收命令）+ verify_baseline（基线）
   ▼
┌─────────────────────────── wolfpack-unified ───────────────────────────┐
│  ① 基线闸门 verify_baseline  ── 已有命令通过 → stale，一个进程都不起     │
│  ② 工人适配器 agy / claude   ── 自动挑选 · 轮换 · 健康冷却 · 续跑        │
│  ③ 机械验收 verify           ── 真跑命令，抓 exit code 与可定位失败信号   │
│  ④ 五态裁决                  ── pass / fail / error / unverified / stale │
│  ⑤ 双段 digest               ── 「队员声称」+「我已核实」                 │
│  ⑥ NDJSON 台账               ── 轮次 / verdict / 耗时 / token / 会话 id   │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
队长只读有界摘要；原始 JSON 落盘，永不进上下文
```

三种宿主入口，共用同一份 `lib/core/**`：

| 入口 | 文件 | 给谁用 |
|---|---|---|
| **DSH Cordis 插件** | `lib/index.js` | DSH 用户（4 个工具 + 工人多选开关 + 工具卡片 + 右侧实时面板） |
| **命令行** | `bin/wolf.mjs` | 终端 / CI；零第三方依赖，无需 DSH |
| **MCP stdio 服务** | `bin/wolf-mcp.mjs` | 任意支持 MCP 的客户端（Claude Desktop、Codex、Cursor、Cline…） |

核心设计意图：**队长的钱花在判断上，验收交给代码**。工人自述不算证据，
只有工具返回的「**我已核实**」段算证据。

---

## 目录

1. [30 秒上手](#1-30-秒上手)
2. [三种安装方式](#2-三种安装方式)
3. [四个工具 / 子命令](#3-四个工具--子命令)
4. [特色功能详解](#4-特色功能详解)
5. [配置项全表](#5-配置项全表)
6. [目录结构与架构](#6-目录结构与架构)
7. [测试与验证](#7-测试与验证)
8. [故障排查](#8-故障排查)
9. [已知未做项（如实声明）](#9-已知未做项如实声明)
10. [许可](#10-许可)

---

## 1. 30 秒上手

要求：**Node.js ≥ 20**，以及**至少一个**已安装并登录的工人 CLI：
`agy`（Antigravity CLI）或 `claude`（Claude Code）。两个都装了会自动轮换，
只装一个就用那一个——**不需要任何配置**。CLI / MCP 两个入口**零第三方运行时依赖**，
不需要 `npm install`。

```bash
# 0) 先确认核心没坏（不调用真实工人，用内置假进程承载）
node tests/run.mjs
#   期望末行：全部通过      退出码 0

# 1) 看一眼台账（纯只读，不启动工人、不消耗配额）
node bin/wolf.mjs status

# 2) 派一件活：把「必须失败」的基线 + 「必须通过」的验收同时给它
node bin/wolf.mjs delegate \
  --task-id fix-build \
  --task "修复 npm run build 的报错，不要改公共 API" \
  --verify-baseline "npm run build" \
  --verify "npm run build"
```

读到 `verdict=pass` 就收尾；读到 `stale` 说明**问题根本不存在**（基线已通过，
本轮一个工人进程都没起）——这不是错误，是省钱设计。

---

## 2. 三种安装方式

### A. 独立 CLI（最简，零依赖）

```bash
node bin/wolf.mjs status --json
node bin/wolf.mjs delegate --task-id demo-1 --task "任务书全文" --verify "npm test"
node bin/wolf.mjs kill --task-id demo-1
node bin/wolf.mjs team --tasks "task1.json" --concurrency 2
```

工人路径解析优先级：**环境变量 > 配置文件 > PATH 查找**，两个工人对称——
`WOLFPACK_AGY` / `agyPath`（默认 `agy.exe`）、`WOLFPACK_CLAUDE` / `claudePath`（默认 `claude`）。
已在 PATH 里就什么都不用配。用哪个工人由 `WOLFPACK_WORKER` 决定：
`auto`（默认，自动挑选 + 轮换）、`agy`、`claude`。

台账速查（不启 DSH 也能看）：

```powershell
pwsh -File tools/ledger-status.ps1                      # TASK_ID / ROUNDS / VERDICT / TOKENS，按最近活动倒序
pwsh -File tools/ledger-status.ps1 -Path <runs.ndjson>  # 指定台账文件
```

### B. MCP 服务（给其他 AI 客户端）

配置（`~/.codex/config.toml` 或对应客户端的 MCP 配置）：

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["<本项目绝对路径>/bin/wolf-mcp.mjs"]
env = { WOLFPACK_AGY = "<agy 绝对路径>" }
```

> **为什么建议用 `env` 显式给路径**：宿主拉起 MCP 进程时的工作目录不由你控制，
> 而配置文件是从 cwd 向上搜索的。环境变量优先级最高、与 cwd 无关。

协议版本 `2024-11-05`，只实现 Tools（`initialize` / `notifications/initialized` /
`tools/list` / `tools/call`），未声明 Resources 与 Prompts。

### C. 装进 DSH（本项目的原生形态）

本项目用的是 DSH 的插件装载契约（`dsh.bundle.patch` + `dsh.client`），
peer 依赖为 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-subagent`、
`@deepseek-ai/schemastery`，面向 **DSH 0.2.0 及以后**
（0.1.5 时代的 `settingsScope` 客户端服务已被 `ctx.configForms` 取代）。

1. 用启动器自带包管理器把它装进目标 profile：
   `dsh plugin --profile <profile> add <本项目绝对路径>`。
   本地目录会被记成 `link:`（改源码后重启宿主即生效），插件自己带的
   `cordis.patch.yml` 会把 `{ id: wolfpack, name: wolfpack-unified }` 这一行插进组合，
   不需要手改 profile 的 patch 层。
2. 重启宿主（桌面端：退出并重新打开）。
3. **开关**：输入框右侧的狼群按钮与设置面板里的「狼群模式」写的是插件自己的
   `Config.enabled`（标了 `.volatile()`，命名空间就是条目 id `wolfpack`），
   写入由 loader 就地提交，开与关都不需要重启。关掉时四个工具整体摘除，不留残余。
4. **选择用哪几个工人**：点开输入框右侧狼群按钮的下拉弹层，底部是
   **启用工人（至少选一个）**——`Antigravity (agy)` / `Claude Code (claude)` 两个复选框，
   各带 `已启用` / `未启用` / `未安装` 状态文案；「设置 → 通用」的同一行里也有一份。
   两处写的是同一对 `agy_enabled` / `claude_enabled`，不会互相说谎；
   取消最后一个勾选会被就地拒绝并提示「至少要启用一个工人」。
   **改完立刻生效、不需要重启宿主**——下一次派活就按新的工人集合挑选。

详细的装载契约、每个宿主实际加载哪些文件、宿主专属模块清单，
见 [docs/HOST-MATRIX.md](docs/HOST-MATRIX.md)。若你要从一个已有的狼群插件迁移过来，
见 [docs/CUTOVER.md](docs/CUTOVER.md)（含备份、切换、回滚、回滚判据）。

---

## 3. 四个工具 / 子命令

DSH、CLI、MCP 三个宿主下**同名同语义**（CLI 用子命令形式）：

| 名字 | 作用 | 参数 | 关键语义 |
|---|---|---|---|
| `wolf_delegate` | 派一件活并验收 | `task_id`\*、`task`\*、`verify[]`、`verify_baseline[]`、`fresh`、`model` | `verify_baseline` 是**派活前必须失败**的命令：任一条通过 → `stale` 且**完全不启动工人**；一条都没跑起来 → `error`（工具故障，不是工人失败） |
| `wolf_status` | 只读台账 | `task_id`、`limit`（默认 20，上限 100） | **绝不启动工人、不跑验收、不消耗额度**；台账不存在也安全返回 |
| `wolf_kill` | 终止运行中的工人进程树 | `task_id`\* | **跨进程有效**（靠 `<raw_dir>/live/<taskId>.json` 登记 + PID 探活） |
| `wolf_team` | 受控并发小队（1–8 个任务，并发 1–4） | `tasks[]`\*、`concurrency` | 同一批里出现重复 `task_id` → **整批拒绝**，一个进程都不起；单个任务失败不影响其它 |

\* 为必填。四个工具都声明了 `isConcurrencySafe = () => true`。

**四个工具都没有 `worker` 参数**——用哪个工人由核自动挑选（见 4.19），
队长只能在狼群开关里把工人集合收窄（例如本机 claude 没额度时只勾 `agy`）。

CLI 等价形态：

```bash
wolf delegate   --task-id <id> --task <文本> --verify <cmd> --verify-baseline <cmd> [--fresh] [--model <m>] [--json]
wolf status     [--task-id <id>] [--limit <n>] [--json]
wolf kill       --task-id <id>
wolf team       [--tasks <file|@file>] [--concurrency <1-4>] [--json]     # 不给 --tasks 则读 stdin
```

MCP 下工具签名一致，`tools/call` 返回 `{ content: [{ type: 'text', text: digest }], isError, raw }`。
其中 `isError` 只在 `verdict` 为 `fail`/`error`（`wolf_team` 为存在 `fail`/`error` 计数）时为真——
**`stale` 与 `unverified` 不算错误**。

---

## 4. 特色功能详解

### 4.1 基线闸门 `verify_baseline`：把「重复派一件已经完成的活」变成不可能

这是本项目第一个、也是最省钱的设计。`evaluateBaseline()`（[lib/core/verify.mjs:177-211](lib/core/verify.mjs#L177-L211)）
按**固定优先级**给出三种互不相同的结论：

| 判定 | 触发条件 | 后果 |
|---|---|---|
| `stale` | 任一条基线命令 **exit 0**（已经有命令通过） | 立即返回，**一个工人进程都不起、不跑验收**，零配额消耗 |
| `error` | 有命令 **根本没跑起来**（`ran !== true`）；或**全部因超时失败**且无正常失败 | 立即返回，同样不起工人——这是**工具故障**，不是「问题还在」 |
| `proceed` | 所有命令都跑了、都失败 | 问题确实存在 → 正常派活，基线结果一并进 digest |

顺序即优先级：**「有命令没跑起来」优先于「有命令已通过」**（避免把环境故障误读成 `stale`）；
但「已有命令通过 + 另有命令超时」判 `stale`（超时不推翻已成立的结论）。
基线判定与验收相反——**失败才是好消息**，digest 里用 `✗` 表示已通过、`✓` 表示确实失败，
并带括号说明 `(exit N, 超时)` / `—— 已通过：问题不存在或已被修`。

### 4.2 五态裁决：把「失败」精确分成四种不同的东西

`delegate.mjs:1151-1155` 的判定逐字：

```js
const executed = verifyChecks.filter(c => c.ran)
const verdict = verifyChecks.length === 0
  ? 'unverified'
  : executed.length === 0
    ? 'error'
    : executed.every(c => c.ok) ? 'pass' : 'fail'
```

| verdict | 精确条件 | 队长该做什么 |
|---|---|---|
| `pass` | 提供了验收命令，且**所有真正执行到的**命令 `exit 0` | 收尾 |
| `fail` | 提供了验收命令，≥1 条执行到了，其中有失败的 | 看「可定位信号」决定续跑修还是 `fresh: true` 重开 |
| `error` | 提供了验收命令，但**没有任何一条跑起来** | **不要据此重派**——这是狼群自己的工具故障，不是队友的任务失败 |
| `unverified` | **没给验收命令** | 本轮没有成功证据，只能相信自述 |
| `stale` | **只**由基线闸门产生 | 问题不存在或已被修；换一件真的事，或收尾 |

两个容易写错的细节，这里明确写下来：

- **验收命令超时算 `fail` 而不是 `error`**（`ran` 仍为 `true`，只是 `ok === false`）；
  只有「进程根本没起来」才是 `error`。
- **`stale` 正常路径永远不会出现**，它只能从基线闸门返回；而且 `stale` 轮次的
  `changed_files_determined` 恒为 `false`，不会假装探测过磁盘。

### 4.3 「`status: ERROR` ≠ 失败」——这条规则被写进了代码，而且有两道

工人自报失败不等于任务失败。代码里有**两条独立的救回路径**，任一成立即判完成：

**救回一：磁盘有产物**（[lib/core/worker/agy.mjs:476](lib/core/worker/agy.mjs#L476)，注释原文
`// 产物存在即视为完成——即使 agy 自报 ERROR`）

```
artifacts.changed && (agyStatus !== 'SUCCESS' || exitCode !== 0)  →  stopReason = 'completed'
诊断追加：agy 自报 <status>，但检测到磁盘产物：<summary>
```

**救回二：机械验收全部通过**（`delegate.mjs:1158-1163`）

```js
const verifiedClean = executed.length > 0 && executed.every(c => c.ok)
const salvaged = runResult.stopReason === 'error' && verifiedClean
// 诊断追加：'<worker> 自报失败，但机械验收全部通过，判为完成'
```

救回成功后还会把该工人的健康台账**回写为 success**（`delegate.mjs:1165-1172`）——
「自报失败但活干成了」不该把工人关进冷却。

注意两道闸门都不放水：**工人自报 ERROR 且验收不过 → 仍是 error**；
**自报 ERROR 且没给 verify → 不救**（没有证据就是没有证据）；
**验收命令跑不起来 → 不触发救援**（工具故障不是完成证据）。

### 4.4 双段 digest：把「队员声称」和「我已核实」物理分开

`renderDigest()`（[lib/core/digest.mjs:113](lib/core/digest.mjs#L113)）输出**固定顺序**的版式，
文件头注释称之为「线上冻结契约」：

```
🐺 <task_id> · 第 N 轮 · 续跑|冷启动（原因）|未启动 agy（基线未过） · <stop_reason>
⚠️ <capacity 专属告警 / diagnostic>
⏳ 本轮疑似停滞报警 N 次（……**没有被自动终止**）
本轮工具调用预算：不设上限（宿主不设超时，仅受 agy 侧配额约束）
— 队员声称 —
<工人自述，截断到 4000 字符>
— 我已核实 —
磁盘改动 N 个文件：a, b, c            ← 或「**无法判定**（原因）——以验收命令为准」
派活前基线（这些命令必须**失败**才算问题还在）：
  ✓ npm run build  (exit 1)          ← ✓ = 确实失败（好消息）
验收 verdict: pass|fail|error|unverified
  ✗ npm test  (exit 1)
      可定位信号：
        · [counts] 3 failed, 12 passed
        · [file:line] src/a.ts:42
        · [test-name] ✗ rejects expired token
      <末尾 8 行>
agy 原始 JSON（未进上下文，需要时自行读）：<路径>
agy 完整 stdout（截断时的 spill）：<路径>
```

**只有第二段算证据。** 第一段是工人的一面之词，第二段是工具亲口报告的磁盘改动与 exit code。

### 4.5 有界输出：digest 按上下文计费，所以每一处都有硬上限

| 位置 | 上限 | 出处 |
|---|---|---|
| 工人自述正文 | **4000 字符**（超限加 `…[truncated]`） | `DIGEST_MAX_CHARS` |
| 诊断信息 | **500 字节**（UTF-8 安全截断，不切碎多字节字符） | `DIAGNOSTIC_MAX_BYTES` |
| 验收失败的可定位信号 | **最多 5 条** | `FAILURE_SIGNAL_LIMIT` |
| 验收命令保留尾部 | 20 行；digest 再渲染**最后 8 行** | `runVerify({ tailLines: 20 })` |
| 磁盘改动文件列表 | 前 **20** 个 | `renderDigest` |
| 小队任务自述 | 每项 **400 字符**；显示时再压到 200 | `TEAM_REPORT_HEAD_CHARS` |
| 小队汇总 | **4000 字符**（整体硬切） | `TEAM_SUMMARY_MAX_CHARS` |
| 小队错误文本 | **400 字符** | `TEAM_ERROR_MAX_CHARS` |
| 实时面板响应体 | **32 KB**；运行数 ≤ 8（硬上限 50）、每运行事件 ≤ 12、每条文本 ≤ 400 字符 | `live-route.js` |
| agy stdout 内存缓冲 | 8 MiB（超限 `lossy=true`），可落盘 spill | `MAX_STDOUT_BYTES` |

**原始 JSON 永不进上下文**：每轮 agy 的完整 stdout 落盘到 `<raw_dir>/raw/<task>-rN-<ts>.json`，
stdout 超 8 MiB 时另存 spill 文件（`%TEMP%/wolfpack-spill/spill-<ts>-<uuid>.log`），
digest 只给路径。要读自己去读——别让大文件进上下文。

### 4.6 可定位失败信号：失败不是「给你一坨日志」

`extractFailureSignals()`（[lib/core/verify.mjs:118-165](lib/core/verify.mjs#L118-L165)）按**固定顺序**抓四类信号，
最多 5 条、按 `kind|text` 去重：

| 顺序 | 种类 | 正则（逐字） |
|---|---|---|
| 1 | `counts` | `/(\d+)\s+failed[,\s]+(\d+)\s+passed/i`、`/(\d+)\s+passed[,\s]+(\d+)\s+failed/i`、`/(\d+)\s+passing[\s\S]{0,40}?(\d+)\s+failing/i`、`/(\d+)\s+failing[\s\S]{0,40}?(\d+)\s+passing/i`（命中第一条即停） |
| 2 | `file:line` | `/(?:[\w.@~\\/-]*\.[A-Za-z]\w{0,7}):(\d+)(?::(\d+))?/g` |
| 3 | `assert` | `/AssertionError|\bassert\w*\s*\(|^\s*(?:expected|Expected|actual|Actual)\b|\bexpect\s*\(/m`（取第一个命中行） |
| 4 | `test-name` | `/^\s*(?:✗|✕|✖|×|FAIL(?:ED)?\b|not ok\s+\d+\s*-?)\s*(.+)$/` |

一条都提不出来时 `degraded = true`，digest **明写** `（未提取到可定位信号，降级为 tail）`——
那是「提不出来」，不是「没有问题信号」，绝不静默。

### 4.7 机械对账：工人说改了 A，磁盘真的动了 A 吗

工人通过 `--json-schema` 强制返回结构化报告（默认 schema 要求 `summary` 字段，
另接受 `claimed_files` / `modified_files`）。`reconcileClaimedArtifacts()` 把**声称改动**与
**磁盘实测改动**（git 差集，或非 git 时的文件快照差集）机械对账，得出三态：

- `matched` —— 两边一致
- `mismatch` —— `声称改动但磁盘未动：…` / `磁盘实际改动但队员未声称：…`（各列前 5 个 + `等`）
- `undetermined` —— 探测**不可信**：声称的文件逃逸出被探测根，或本来就探测不到

配套三条硬规则：

- **「探测不到」必须与「没有改动」区分开。** 非 git 工作区里 digest 写
  「磁盘改动：**无法判定**（工作目录不是 git 仓库）——以验收命令为准」，
  绝不写「改动 0 个文件（无）」。小队汇总同理，说「改动未探测」而不是「0 文件」。
- **只看差集**：派活前就脏的文件不算本轮产物。
- **`response` 里混进来的 JSON 副本绝不当权威来源**，一律以 `structured_output` 为准；
  缺 `structured_output` 时安全降级不抛异常。

### 4.8 续跑：台账是「必需件」而不是可观测性的锦上添花

`agy -p` 每次都是新进程，会话上下文不跨进程保留；必须把 `conversation_id` 记下来，
下次用 **`--conversation <id>`** 传回（**绝不用 `-c`**）。不这么做，每轮都要重付
工人约 **27k tokens / 14 秒**的空载固定开销。

续跑决策链（顺序即优先级）：

1. `continuation === 'never'` → 冷启动，理由 `continuation-disabled`
2. `fresh: true` → 冷启动，理由 `forced-fresh`
3. 没有历史会话 id → 真·首次冷启动
4. **累计 token 超预算**（默认 **1,000,000**，`WOLFPACK_TOKEN_BUDGET`）→ 冷启动，
   理由带**真实数字**：`token-budget(已用 1042133 ≥ 1000000)`
5. 连续多轮**拿不到用量**（默认 **20** 轮，`WOLFPACK_UNKNOWN_USAGE_CAP`）→ 冷启动，
   理由 `unknown-usage-round-cap(20)`
6. 否则**续跑**，复用会话 id

配套的两个不显眼但关键的性质：

- **`conversationId` 只被「本任务最近一次真正拿到 id 的记录」覆盖**——后续一条没带 id 的
  失败记录不会把它抹掉。「否则一次失败就丢了续跑能力」（[lib/core/ledger.mjs:155](lib/core/ledger.mjs#L155)）。
- **默认不按轮数硬杀。** 能跑到第 8 轮说明这件事难，此时把攒下的上下文扔掉最亏；
  `WOLFPACK_MAX_ROUNDS` 默认**未设**，只有显式配置才生效。

### 4.9 并发闸门：同一个 `task_id` 不允许两轮同时在跑

`ActiveRunRegistry.claim(taskId, runId, at)` 是**同步**占位
（[lib/core/ledger.mjs:245](lib/core/ledger.mjs#L245)，注释原文：
「并发交错必须靠同步占位堵死，不能靠时间窗」）。第二次调用**在同一 tick 内**被拒：

```
wolfpack: task_id "fix-build" 上已经有正在运行的 agy 会话（runId r-3，已跑 1204ms）。
同一个 task_id 不允许并发：如果这是另一件事，请换一个新的 task_id；
如果确实要继续这件事，请等它跑完，再用同一个 task_id 追问。
```

（抛 `TaskBusyError`，`code = 'TASK_BUSY'`。）闸门在运行结束即释放，**拒绝不是永久锁**——
同一个 `task_id` 仍然可以续跑。闸门只锁同一个 `task_id`，不同 `task_id` 照常并行。

### 4.10 小队 `wolf_team`：受控并发 + 失败隔离 + 结果保序

- **并发**：1–4（默认 2），`concurrency` 被 `Math.max(1, Math.min(4, n))` 夹取；
  实际 worker 数 = `min(并发, 任务数)`。
- **结果保序**：`results` 按下标回填，**返回顺序恒等于入参顺序**，与完成先后无关。
- **失败隔离**：单个任务抛错只把它自己记成 `verdict: 'error'` 并附错误文本，
  其余任务照常跑完，整批不失败。
- **整批拒绝**（一个进程都不起）：重复 `task_id`（`任务列表中存在重复的 task_id "X"，已拒绝执行`）、
  未知参数、任务数 > 8、`tasks` 非数组、缺 `task` 任务书、`concurrency` 非整数。
- **判定复用**：小队走的是和 `wolf_delegate` **完全同一条**判定链路
  （基线闸门 → 工人 → 验收 → verdict → 救回规则），不是另写一套——
  所以五态裁决与**没有 `verify` 就 `unverified`** 的语义逐条适用。

### 4.11 停滞监控：只报警、永不自动终止

判据**不是钟表**，而是工人**还在不在写自己的 transcript**：
`sampleProgress()` 采样 4 个点取最大 mtime——
`conversations/<id>.db`、`<id>.db-wal`、`brain/<id>/.system_generated/logs/transcript.jsonl`，
以及该日志目录里最新一项（最多递归两层）。
这套采样根目前**只对应 agy**（`<HOME>/.gemini/antigravity-cli`）——
跑 claude 时它拿不到心跳证据，于是按「看不到就不报警」静默放过（见第 9 节第 10 条）。

默认阈值：**无进展 5 分钟报第 1 次、10 分钟第 2 次、15 分钟第 3 次，之后闭嘴**，
把决定权交还给人。恢复写入时进入新回合、报警额度重置（假警报不累计）。

- 报警走三路：控制台（`[wolfpack] 疑似停滞 1/3：<task> 已 1 分钟没有任何进展。继续观察中，不会被自动终止。`）、
  宿主注入的系统通知（DSH 下是 PowerShell 气泡，CLI/MCP 下是 stderr）、
  `<台账目录>/stall.ndjson`（`action: 'warn-only'`）。
- **本模块没有任何终止能力**（[lib/core/stall-monitor.mjs:2-10](lib/core/stall-monitor.mjs#L2-L10) 注释原文：
  「**只报警，永不终止。**…⚠️ 本模块没有任何终止能力。」），更不会误杀。
- **拿不到任何心跳证据时绝不报警**——把「看不到」说成「卡住了」是最坏的假信息；
  存储根缺席 = 整个监控不启用（`start()` 返回 `false`，没有静默降级）。

### 4.12 跨进程 kill：`wolf_kill` 真的能杀掉另一个进程里的工人

运行中的工人会在 `<raw_dir>/live/<taskId>.json` 登记 `{ pid, workerPid, runId }`。
`wolf_kill` 读到登记后用 `process.kill(pid, 0)` 探活（`EPERM` 也算存活），
两个 PID 都死了就清理登记并如实返回 `该运行已结束`；活着则杀进程树，
并把该轮在台账里记为 **`aborted`**（`note: 'killed-cross-process'`），而不是正常完成。
**杀不存在的任务明确返回失败，不假装成功。**

进程树如何真的被杀干净（宿主相关）：Windows 上 `taskkill /PID <pid> /T /F`；
POSIX 上直接 `SIGKILL` **进程组**（`process.kill(-pid, 'SIGKILL')`），失败才回落单进程
`SIGKILL`——没有 SIGTERM 阶段、没有两段等待；`terminate()` 只等
`min(graceMs, 2000)`（默认 2000 ms）。

### 4.13 通知 vs 工具故障：`error` 与 `fail` 的区别贯穿全文

这套区分在六处保持一致：

| 情形 | 判定 | 文案线索 |
|---|---|---|
| 验收命令**跑了但失败** | `fail` | `✗ cmd (exit 1)` + 可定位信号 |
| 验收命令**根本没跑起来** | `error` | `⚠ cmd (无法执行)` + `验收命令**根本没跑起来**——这是狼群自己的工具故障，不是队友的任务失败。不要据此重派。` |
| 基线命令没跑起来 | `error` | `基线命令没有跑起来（工具故障，不是「问题还在」）` |
| 基线命令超时 | `error` | `基线命令超时，无法判定问题是否存在（工具故障，不是「问题还在」）` |
| 基线命令已通过 | `stale` | `基线命令已经通过：cmd (exit 0)——问题不存在或已被修，本轮没有启动 agy。` |
| 服务端容量不足 | `capacity` | `⚠️ 这是服务端容量不足（与账户额度无关）、不是任务失败、立刻报告用户、不要反复重试。` |

**容量不足单独成态**（匹配 `/no capacity available/i`，依次测 `parsed.error`、
`parsed.response`、原始 stdout、stderr），**绝不伪造成 `completed`**，
即使磁盘上确实有改动；台账也真实记为 `capacity`。注意它只匹配那句短语，
不匹配 `503` 这个数字本身。

### 4.14 工具调用预算透明

digest 每轮都交代本轮的宿主侧预算，防止队长把「宿主掐断」误读成「工人失败」：

- 未设预算：`本轮工具调用预算：不设上限（宿主不设超时，仅受 agy 侧配额约束）`
- 设了预算：`本轮工具调用预算：43.5 分钟（到点会被宿主以 TOOL_TIMEOUT 掐断）`

### 4.15 `wolf_status`：只读台账，不启动工人

一个**纯只读**的台账折叠视图，绝不启动工人、不跑验收、不消耗额度；
台账不存在也安全返回（写台账失败同样不让派活失败）。每个任务给出：

`task_id`、`round`、`last_verdict`、`last_stop_reason`、`total_tokens`、
`total_cache_read_tokens`、**`has_conversation_id`（决定还能不能续跑）**、`running`、
`changed_files_count`（明细前 5 个）、`last_at`、`last_duration_ms`、
以及预算三元组 `budget_used` / `budget_limit` / `budget_over`。

```
🐺 wolf_status（只读，不触发 agy）
台账：C:\Users\<you>\.dsh\wolfpack\runs.ndjson
任务 12 个，显示 12 个
- fix-build · 第 3 轮 · verdict=pass · stop=completed · tokens=418220 · conversation_id 有 · 未在跑 · 改动 2 个文件 · 预算 418220/1000000
```

跨会话接手时**先调它**：哪些续跑、哪些收尾、哪些是重复派，一眼看完。

### 4.16 台账：append-only NDJSON + 读时折叠 + 增量读 + 原子压缩

- **形态**：每轮一条 JSON 追加写；崩溃安全；读时折叠成「这个任务现在到哪了」。
- **记录字段**：`at`、`taskId`、`round`、`conversationId`、`cwd`、`stopReason`、
  `changedFiles`、`changedFilesDetermined`、`verdict`、`durationMs`、
  `tokens`（工人**订阅配额**，不是 ¥）、`cacheReadTokens`、`turns`、`note`、
  `usageMissingRounds`、`kind: 'summary'`。
- **只消费完整行**：读到最后一个换行符为止，半行留在游标后
  （注释原文：「绝不能被 parse 成「坏行」静默丢掉——丢了就等于永久少一条记录」）。
- **增量读 + 身份锚**：文件没变时零解析；增长时只折新增记录；截断/轮转时丢弃游标全量重读。
  身份校验靠 `ino`/`birthtimeMs` 变化 + 文件头 32 字节锚 + 游标前 32 字节锚——
  **同路径 + 同大小 + 同 mtime 的原地改写也不会返回陈旧态**。
  作者自己标注了局限：三样都相同且头尾 32 B 也相同的原地改写仍会命中缓存（启发式，非绝对保证）。
- **留存策略**：超过 **5000** 条或 **10 MiB** 时压缩；每个任务只保留最近 **10** 轮明细，
  更早的折叠成一条 `kind: 'summary'`（保留累计 token / 轮次 / `conversationId` 语义）。
  压缩走「临时文件 → rename」的**原子写**，注入写失败后台账仍可被完整读取（不出现半截文件）。
- **诚实声明**：跨进程并发写同一本账**没有文件锁**，只有进程内 Promise 串行链。

### 4.17 DSH 宿主侧：开关、工人多选、队长指令、两个工具卡片、实时面板

- **一次开关，两处一致**：输入框右侧的 `WolfpackChip` 与「设置 → 通用」的 `WolfpackRow`
  写的是同一个 `Config.enabled`（`.volatile()`），两处状态不许互相说谎，
  设置只读时两处一起禁用。开/关**不需要重启**宿主：工具整体挂上/摘除。
- **工人多选就在开关旁边**：同一对 UI 里写 `agy_enabled` / `claude_enabled`，
  状态文案由 `workerStatusText(enabled, installed)` 统一给出
  （`未安装` / `已启用` / `未启用`；`*_installed` 由 Host 侧预检结果回填）。
  两个都勾 = 不限制（交给自动轮换），只勾一个 = 只用它；宿主侧
  `computeWorkersEnabled()` 把集合翻译成 `workersEnabled`，再由
  `resolveWorkerSelection()` 收窄候选池——**核不知道 UI 的存在**。
- **键缺省时按 schema 默认值兜底：`agy` 开、`claude` 关**。这一点值得单独写清楚，
  因为 profile 里**通常只写 `enabled`**：宿主交给 `apply()` 的是 `cordis.patch.yml` 的原文，
  **不套 schema 默认值**，所以 `agy_enabled` / `claude_enabled` 缺失是常态，不是异常。
  两处 UI 与 `computeWorkersEnabled()` 必须用同一套兜底（缺键 ≠ 关掉，
  也 ≠ 全部打开），否则会出现「界面显示已启用、实际没派给它」这类说谎。
  `claude` 默认关，是因为大多数机器上没装 Claude Code CLI 或没有额度，
  默认打开会让自动轮换把活派给一个必然失败的本机工人。
- **写入被拒会当面说清**：`scope.set()` 兑现 `false` 时先重读快照、自动重试一次
  （宿主侧最常见的拒绝原因是提交时 `revision` 已被别的写入改动，重读即可通过），
  仍失败就把原因显示在复选框旁（「设置还没同步过来」/「当前设置域是只读的」/
  「宿主拒绝了这次写入」），绝不只写 `console.warn`；取消最后一个勾选会被
  客户端与宿主两侧同时拦下（工人池不允许被清空）。
- **队长指令（systemPrompt）随开关注入**：注册为 order **1200** 的 systemPrompt section，
  `text` 是**惰性函数**——每次现读 `briefing.md`，改文案零重启；读失败降级为兜底文案并显式提示路径。
- **两个工具卡片**：`WolfStatusCard`（key `wolf_status`）渲染台账行：
  第 N 轮 / verdict 徽标 / stop_reason / tokens / 正在跑·未在跑 / 改动 N 个文件；
  `WolfKillCard`（key `wolf_kill`）渲染 `✅ 已终止 task_id=X（run_id=Y）` / `❌ 终止失败——<reason>`。
  两卡对 `undefined` / `null` / 畸形 `meta` 都不抛，回退渲染文本。
- **右侧实时面板 `WolfLivePanel`**：顶部「🐺 狼群 · 并行运行 R 个（共 N 个任务）」+
  「📂 显示全部」（最多 50）/「🔄 刷新」；每张卡片显示状态点、第 N 轮、**第 N 步**、
  `已跑 | 耗时`、`结束于 hh:mm:ss`、tokens、verdict 徽标，以及**工人的思考文本**
  （标注「思考在每步完成后写入，显示的是最近完成的一步」）。
- **面板轮询是自适应且有礼貌的**：有运行中时 1.5 s 一轮，全部空闲时 5 s；
  失败指数退避（上限 12 s）；页面不可见（`document.hidden`）时**暂停轮询**，回前台重置；
  活时钟仅在真有运行中任务时才每秒 tick。
- **实时路由 `/wolfpack/live`** 纯只读、零 token，
  **机械闸门保证它不含任何台账写入与工人启动调用**；鉴权四道：
  缺 `connection` 服务或 `requestRejection` 不可用 → **503（fail closed）**，
  被拒 → 用其状态码 + 空 body，非 `GET` → **405 + Allow: GET**，否则 200。
  所有分支带 `cache-control: no-store`。
- **耗时语义是刻意设计的**：运行中用活时钟 `now - startedAt`；已结束用台账真实总耗时且**固定**，
  并且**不返回可被当成起点的 `started_at`**（返回 `finished_at`）——
  注释原文：叫 `started_at` 会诱导客户端算出「距最后活动多久」的假耗时。
- **transcript 读取**：优先读 `transcript_full.jsonl`（完整思考），回退 `transcript.jsonl`；
  只读尾部 **64 KB**，逐行 `JSON.parse` 失败静默跳过（首尾半截行无害）；
  `step_total` 是**该 64 KB 窗口内的条数**，不是全文件总数。
  已结束任务的 transcript 走 LRU(32) 缓存，按 `(size, mtimeMs)` 命中，
  且**必须返回副本**——边界裁剪会就地改写事件文本，直交缓存会污染下一轮。
- 客户端有三处 id **有意不同**：`openTab` 用 `wolfpack`，tab 类型与
  `sidebar.right.pane.tab` 的 key 用 `wolfpack-unified`——改的时候别「顺手统一」。

### 4.18 宿主无关的核：一条可机械检查的架构约束

`lib/core/**` 的依赖边界是硬约束，且有**测试机械闸门**守着：

| 约束 | 守护用例 |
|---|---|
| 核心层**不 import 任何宿主模块**、无一向上越界 import | `core-has-no-host-imports` |
| 核心层**不直接 import `node:child_process`** | `core-has-no-child-process-import` |
| 软获取的服务**绝不做属性访问**（0.2.0 会抛 `without inject`） | `X-h`（扫 `lib/**`） |
| 客户端不含 `host.call` 与 `ctx.get("host")` | `U-f` / `V-a` / `W-b` |
| CLI / MCP **共用同一份核**，不复制第二套委派实现 | `cli-mcp-share-core` / `no-duplicate-delegation-impl` |
| 实时路由**不含台账写入与工人启动调用** | `L-e` |

所有外设调用（进程派生、信号终止、工作区快照、日志落盘、停滞通知）都走**注入的 Runtime**
与注入的通知器。唯一的强依赖是：

```js
spawn({ argv, cwd, stdio, graceMs, signal }) → {
  done: Promise<{ exitCode, signal, error? }>,
  collected: {
    stdout: { readFrom(offset?) → { text, nextOffset, lossy, spillPath? } },
    stderr: { readFrom(offset?) → { text, nextOffset, lossy } },
  },
  terminate(): Promise<void>,
  waitForExit(): Promise<void>,
  pid: number | undefined,
}
```

**换一个工人 = 新增一个适配器文件**（`lib/core/worker/<name>.mjs`，导出
`name` / `preflight` / `buildArgv` / `extractSessionId` / `parse` / `classify` 六项），
注册进 `lib/core/worker/index.mjs` 的 registry 即可，核一行不改。当前已注册两个适配器，
挑选与冷却规则见 4.19。

### 4.19 两个工人：自动挑选、轮换与健康冷却

工人适配器住在 `lib/core/worker/`，每个文件导出同一组六项契约，注册进
`worker/index.mjs` 的 registry 就能被挑选器看见。当前注册两个：

| 适配器 | 工人 | 续跑方式 |
|---|---|---|
| `worker/agy.mjs` | Antigravity CLI | `--conversation <id>`（**绝不用 `-c`**） |
| `worker/claude.mjs` | Claude Code | `--resume <id>`（**绝不用 `-c` / `--continue`**） |

挑选由 `resolveWorkerSelection({ config, previousWorker, env, find, health, now })` 完成，
**命中即返回**：

| # | 条件 | 返回的 `reason` |
|---|---|---|
| 1 | 配置显式点名，且该工人可用 | `explicit`（即使在冷却中也照用，附 `benched_ignored: true`） |
| 2 | 点名的工人被开关**禁用** | `fallback(<prefer>-disabled)` |
| 3 | 点名的工人**没装 / 预检不过** | `fallback(<prefer>-unavailable)` |
| 4 | 候选池里只剩一个可用 | `only-available` |
| 5 | 同一个 `task_id` 上一轮用的工人仍可用 | `continuation`（续跑尽量不换人） |
| 6 | 两个都可用 | `rotation` |
| — | 候选池里**全部在冷却中** | `all-benched(<name>)` + `all_benched: true`：挑**最早恢复**的那个，绝不空转 |
| — | 候选池**一个可用的都没有** | 抛出可读的中文错误，而不是静默失败 |

`auto`（含 `rotate` / `rotation` / `both` / `any`）表示「不点名，交给挑选器」；
`normalizeWorkerPreference()` 对未知值返回 `undefined` 而不抛错。
**四个工具签名里没有 `worker` 参数**——人手能做的只有「在狼群开关里把候选池收窄」。

**健康冷却**（`lib/core/worker/health.mjs`，状态落在 `<台账目录>/worker-health.json`，
临时文件 → rename 原子写）。失败不按同一种力度惩罚，而是按**故障种类**分档：

| 故障种类 | 判定来源 | 冷却 |
|---|---|---|
| `capacity`（额度/容量不足，含 API 中转池耗尽） | HTTP 402/429/503/529、`stopReason: 'capacity'`、`/no capacity available/i` | **5 分钟** |
| `auth`（未登录或鉴权失败） | 401/403 或文本特征 | **30 分钟** |
| `timeout`（超时，疑似挂住不说话） | `timedOut` | **10 分钟** |
| `error`（工人自报失败） | `stopReason: error` / `aborted` | **10 分钟** |
| `no-output`（没有输出） | 输出为空 | 按普通失败（10 分钟） |

- 连续失败到阈值（默认 **2** 次，`WOLFPACK_WORKER_FAIL_THRESHOLD`）才进冷却；
  **一次成功立刻清零**并解除冷却（`consecutiveFailures: 0`、`benchedUntil: 0`）。
- **被取消不算失败**：`classifyFaultKind()` 对「`cancelled` 且未超时」返回 `undefined`，
  而 `undefined` 与 `'success'` 走同一条路——不计失败、并清零。
  队长按停不该惩罚工人，这条是刻意的。
- `WOLFPACK_WORKER_HEALTH=off` 整个关掉这套机制，挑选器退回只看「装没装」。

digest 会把冷却如实写出来（`lib/core/digest.mjs:134-158`）：谁被跳过、由谁接手、
还剩多久自动恢复，以及「两个都在冷却 → 仍硬试一次，绝不空转」。
**为什么错开冷却时长**：容量不足多半是短时拥堵，超时可能是这件活真的难，
未登录则必须等人去登——三者用同一个时长，等于在最该换人的时候死等。

---

## 5. 配置项全表

### 5.1 环境变量

| 类别 | 变量 | 默认 | 说明 |
|---|---|---|---|
| **工人** | `WOLFPACK_AGY` | `agy.exe`(win) / `agy` | agy 可执行文件**绝对路径优先**（PATH 查找是兜底） |
| | `WOLFPACK_CLAUDE` | `claude` | claude 可执行文件（同上） |
| | `WOLFPACK_WORKER` | `auto` | 工人选择：`auto`（自动挑选 + 轮换）/ `agy` / `claude` |
| | `WOLFPACK_CLAUDE_MODEL` | — | 透传 claude `--model` |
| | `WOLFPACK_CLAUDE_PERMISSION_MODE` | — | 透传 claude 权限模式 |
| | `WOLFPACK_CLAUDE_AGENTS` | — | 透传 claude `--agents` |
| | `WOLFPACK_WORKER_HEALTH` | 开 | `off`/`none`/`0`/`false`/`no` **关闭整个健康冷却** |
| | `WOLFPACK_HEALTH_FILE` | `<台账目录>/worker-health.json` | 健康状态文件 |
| | `WOLFPACK_WORKER_FAIL_THRESHOLD` | **2** | 连续失败几次进冷却 |
| | `WOLFPACK_WORKER_COOLDOWN_MS` | **600000** | 普通失败冷却（10 分钟） |
| | `WOLFPACK_WORKER_CAPACITY_COOLDOWN_MS` | **300000** | 容量不足冷却（5 分钟） |
| | `WOLFPACK_WORKER_TIMEOUT_COOLDOWN_MS` | **600000** | 超时冷却（10 分钟） |
| | `WOLFPACK_WORKER_AUTH_COOLDOWN_MS` | **1800000** | 鉴权失败冷却（30 分钟） |
| | `WOLFPACK_MODEL` | — | 透传 `--model` |
| | `WOLFPACK_EFFORT` | — | 透传 `--effort` |
| | `WOLFPACK_MODE` | `accept-edits` | 透传 `--mode` |
| **路径** | `WOLFPACK_CONFIG_FILE` | 从 cwd 向上找 `wolfpack.config.json` | 显式配置文件 |
| | `WOLFPACK_LEDGER` | `$DSH_HOME/wolfpack/runs.ndjson` | 台账路径 |
| | `WOLFPACK_RAW_DIR` | `<台账目录>/raw` | 原始输出落盘目录 |
| | `WOLFPACK_BRIEFING` | `<项目>/briefing.md` | 队长指令正文 |
| **超时** | `WOLFPACK_TASK_TIMEOUT` | **0 = 不设** | 工人 wall-clock 上限（未设时仍给 agy 24h 的 `--print-timeout` 防它自己 5 分钟死掉） |
| | `WOLFPACK_VERIFY_TIMEOUT` | **300000**（5 分钟） | 单条验收/基线命令超时 |
| | `WOLFPACK_SHELL` | 平台默认 | 自定义 shell 前缀（空格分隔） |
| **续跑** | `WOLFPACK_CONTINUATION` | 按任务 | `never` 强制冷启动 |
| | `WOLFPACK_TOKEN_BUDGET` | **1000000** | 累计超预算才冷启动；`off`/`none`/`0` 关闭 |
| | `WOLFPACK_MAX_ROUNDS` | **未设** | 硬轮数上限（仅显式配置生效） |
| | `WOLFPACK_UNKNOWN_USAGE_CAP` | **20** | 连续拿不到用量时退回轮数判断；可关 |
| **台账** | `WOLFPACK_LEDGER_MAX_ENTRIES` | **5000** | 超限触发压缩；`off` 关闭该项 |
| | `WOLFPACK_LEDGER_MAX_BYTES` | **10485760**（10 MiB） | 同上 |
| | `WOLFPACK_LEDGER_KEEP_ROUNDS` | **10** | 每任务保留的明细轮数 |
| **停滞** | `WOLFPACK_STALL_WINDOW` | **300**（秒，即 5/10/15 分钟三次） | `off`/`none`/`0` **关闭整个监控** |
| | `WOLFPACK_STALL_WARNINGS` | **3** | 最多报几次 |
| | `WOLFPACK_STALL_POLL` | **30**（秒，下限 5 s） | 采样间隔 |
| | `WOLFPACK_STALL_TOAST` | **开** | `off` 关系统通知 |
| | `WOLFPACK_STALL_LOG` | `<台账目录>/stall.ndjson` | 停滞台账 |
| | `WOLFPACK_STORE_ROOT` | `<HOME>/.gemini/antigravity-cli` | 工人会话存储根（停滞判据来源） |
| **并发** | `WOLFPACK_CONCURRENCY` | **2** | 小队默认并发（夹在 1–4） |

`off` / `none` / `0` / 非正数一律表示「关闭该项限制」——**没配 ≠ 配成 0 毫秒**。

### 5.2 两个宿主读取哪些配置（别踩这个坑）

| | DSH Cordis 插件 | CLI / MCP |
|---|---|---|
| 配置来源 | 插件自己的 `Config` + 环境变量 | `wolfpack.config.json`（可选）+ 环境变量 |
| 读 `wolfpack.config.json`？ | **不读** | 读 |
| Config 里的可变键 | `enabled` / `agy_enabled` / `claude_enabled`（都标 `.volatile()`） | 无这一层 |
| 生效应变 | 三个开关**不重启**即生效（`loader/volatile-update` 就地刷新） | 环境变量 / 配置文件，进程启动时读 |

两条容易踩的坑：

- DSH 半边**不读** `wolfpack.config.json`，但**读** `WOLFPACK_WORKER` / `WOLFPACK_AGY` /
  `WOLFPACK_CLAUDE` / `WOLFPACK_WORKER_HEALTH` 等环境变量（插件启动时折进 `runConfig()`；
  `WOLFPACK_WORKER` 在 volatile 更新时也会重读）。
- `WOLFPACK_RAW_DIR` / `WOLFPACK_SHELL` / `WOLFPACK_CONCURRENCY` / `WOLFPACK_LEDGER_MAX_*`
  这些**对 DSH 插件无效**（它们属于 CLI/MCP 的核配置）。

**谁说了算**：狼群开关里的工人多选决定**候选池**（先过滤），`WOLFPACK_WORKER` 决定
**优先点名**；被点名的工人不在候选池里，就退化成池内轮换（`fallback(<prefer>-disabled)`）。

### 5.3 台账路径解析阶梯（三种宿主完全一致，绝不返回相对路径）

1. `WOLFPACK_LEDGER`
2. `$DSH_HOME/wolfpack/runs.ndjson`
3. `<USERPROFILE|HOME>/.dsh/wolfpack/runs.ndjson`
4. `<homedir>/.dsh/wolfpack/runs.ndjson`（兜底）

> 注释里记录了这个阶梯的来历：宿主进程的 `DSH_HOME` 不一定存在，早期版本会回落到相对路径
> `wolfpack/runs.ndjson`——于是台账落到源码检出目录里，并随 cwd 漂移。

---

## 6. 目录结构与架构

```
wolfpack-unified/
├── bin/
│   ├── wolf.mjs                  # CLI 入口（零依赖手写 parseArgs）
│   └── wolf-mcp.mjs              # MCP stdio 服务（JSON-RPC over NDJSON / Content-Length）
├── lib/
│   ├── core/                     # ★ 宿主无关核：只依赖注入的 Runtime，不 import 任何宿主模块
│   │   ├── config.mjs            #   配置加载与合并（overrides > env > 配置文件 > 平台默认）
│   │   ├── spawn.mjs             #   注入式 spawn 包装（超时 / abort / spill 默认值）
│   │   ├── verify.mjs            #   验收与基线：shell 解析、失败信号提取、evaluateBaseline
│   │   ├── delegate.mjs          #   runDelegateTask / startAgy / 续跑决策 / 产物快照 / killRun
│   │   ├── team.mjs              #   小队的校验、受控并发、保序、失败隔离、有界裁剪
│   │   ├── digest.mjs            #   双段 digest / status / team 三种有界文本渲染（纯展示层）
│   │   ├── ledger.mjs            #   NDJSON 台账、折叠、增量读、留存压缩、并发闸门
│   │   ├── live.mjs              #   跨进程活运行登记文件（<raw>/live/<taskId>.json）
│   │   ├── stall-monitor.mjs     #   停滞监控：采样 mtime、窗口判定、只报警
│   │   └── worker/
│   │       ├── index.mjs         #   注册表 + 挑选器 getWorker / resolveWorkerSelection
│   │       ├── agy.mjs           #   Antigravity CLI 适配器 + 全部纯函数（argv/解析/用量/对账）
│   │       ├── claude.mjs        #   Claude Code 适配器（续跑只用 --resume）
│   │       ├── faults.mjs        #   故障分类 capacity / auth / timeout / no-output / error
│   │       └── health.mjs        #   按工人分档的失败计数与冷却（worker-health.json）
│   ├── runtime/
│   │   ├── dsh.mjs               #   DshRuntime：包装 ctx.subprocess（沙箱语义由宿主负责）
│   │   └── node.mjs              #   NodeRuntime：child_process + killProcessTree
│   ├── index.js                  # DSH Cordis 插件入口（生命周期 / Config / 四工具 / provider / 路由）
│   ├── client.js                 # DSH 前端插件（开关 + 工人多选 / 设置行 / 两张卡片 / 实时面板）
│   ├── live-route.js             # DSH 专有 HTTP 实时路由 /wolfpack/live（纯只读）
│   ├── agy-provider.js           # DSH subagent provider（自然语言委派入口）
│   ├── stall-monitor.js          # DSH 专属：PowerShell Toast 通知注入
│   └── agy-runner.js / runs-ledger.js / wolf-delegate.js / wolf-team.js   # ≤2KB 兼容重导出薄壳
├── tests/
│   ├── run.mjs                   # 测试运行器（自动 staging + peer 依赖 junction）
│   ├── wolfpack.test.mjs         # 177 例：核与工人、台账、闸门、对账、小队、实时路由…
│   ├── config-volatile.test.mjs  #  11 例：0.2.0 volatile Config 挂载/摘除契约
│   ├── tool-schema.test.mjs      #   7 例：用 harness 真校验器验四个工具的返回对象
│   ├── client.test.mjs           #  42 例：前端注册、渲染、外观/交互契约、轮询生命周期
│   ├── worker-health.test.mjs    #   6 例：故障分类、冷却演化、挑选分支
│   ├── claude-worker.test.mjs    #  17 例：claude 适配器（假 claude 脚本，不跑真实 claude）
│   └── worker-selection.test.mjs #  10 例：工人启用集合 → 挑选结果
├── tools/ledger-status.ps1       # 台账速查脚本（永不抛异常，始终 exit 0）
├── docs/{HOST-MATRIX,CUTOVER}.md # 宿主支持矩阵 / 迁移与回滚记录
├── briefing.md                   # 注入给队长的「狼群模式」使用简报（可运行时改，零重启）
├── cordis.patch.yml              # 向 DSH 组合 insert { id: wolfpack, name: wolfpack-unified }
├── package.json                  # dsh.bundle.patch + dsh.client 装载契约；bin: wolf / wolf-mcp
└── LICENSE                       # MIT
```

**宿主角色的划分**：`lib/core/**` 是唯一一份业务逻辑；`runtime/` 是两个宿主适配层；
`lib/index.js` / `lib/client.js` / `lib/live-route.js` / `lib/agy-provider.js` /
`lib/stall-monitor.js` 是 DSH 专属外壳；四个 ≤ 2 KB 的 `.js` 只是给外部单测留的兼容重导出，
**内部零重复逻辑**。

### 三宿主横向对比

| 维度 | DSH Cordis 插件 | 独立 CLI | MCP 服务 |
|---|---|---|---|
| 进程派生 | `DshRuntime`（`ctx.subprocess.spawn`，遵循宿主沙箱策略） | `NodeRuntime`（`child_process`） | 同 CLI |
| 进程树终止 | 宿主内核生命周期纳管 | `taskkill /T /F`（win）/ `SIGKILL` 进程组（POSIX） | 同 CLI |
| 工具暴露 | `dsh-tools` 工具 + `dsh-subagent` 委派 provider | 四个子命令 | `tools/list` + `tools/call` |
| UI 形态 | 输入框开关、设置行、两张卡片、右侧实时面板 | 纯文本 / `--json` | 宿主客户端渲染的文本与工具卡 |
| 实时日志 | HTTP `/wolfpack/live` | 无（直接读台账 / 磁盘） | 无（走 `wolf_status`） |
| 停滞通知 | PowerShell Toast + `stall.ndjson` | stderr + `stall.ndjson` | stderr + `stall.ndjson` |
| 第三方依赖 | Node ≥ 20 + DSH 宿主 + 3 个 peer | **零** | **零** |

---

## 7. 测试与验证

```bash
node tests/run.mjs      # 末行「全部通过」，退出码 0；完全不调用真实工人
```

| 套件 | 用例数 | 覆盖 |
|---|---|---|
| `wolfpack.test.mjs` | **177** | 纯函数、假进程 seam、验收、四工具、digest 版式、provider、台账、闸门、停滞、kill、留存、对账、预算、小队、统一核与运行时 |
| `config-volatile.test.mjs` | **11** | `inject` 白名单、volatile 开关挂载/摘除、缺服务降级、软获取机械闸门 |
| `tool-schema.test.mjs` | **7** | 用 harness **自己的**校验器验四个工具的返回对象（`additionalProperties: false`） |
| `client.test.mjs` | **42** | 注册契约、渲染树、外观/交互契约、轮询生命周期、防回归机械闸门、工人多选三态与写入被拒的可见反馈 |
| `worker-health.test.mjs` | **6** | 故障分类（capacity/auth/timeout/no-output/error）、冷却演化、取消不清零之外的边界、挑选分支 |
| `claude-worker.test.mjs` | **17** | claude 适配器：argv、权限模式映射、会话 id 提取、结果解析、容量判定（全部用假 claude 脚本） |
| `worker-selection.test.mjs` | **10** | 工人启用集合 → 候选池收窄 → 挑选结果与 `reason` 文案；键缺省时必须按 schema 默认兜底 |
| **合计** | **270** | |

测试**完全不调用真实工人**（用内置假进程 / 假 claude 脚本承载），
因此不需要装 `agy` 或 `claude`、不消耗任何配额。
运行器会自动把源码暂存到 staging 目录，并从真 DSH 安装里建 `profiles/node_modules`
目录 junction 来解析 peer 依赖；干净环境可显式指定 `WP_TEST_HOME=<可写目录>`。

> **一条实打实的教训**（记在 [docs/CUTOVER.md](docs/CUTOVER.md) 里）：
> 插件测试套件的**假 ctx 不执行 Cordis 注入校验，也不跑 harness 校验器**，
> 所以 `ctx.某服务` 属性访问、`output.schema` 字段缺失这类断裂**只在真宿主显现**。
> 真机曾撞到三处：① 0.2.0 强制注入，未写进 `inject` 的属性访问直接抛
> `Error: cannot get property "subprocess" without inject`；
> ② harness 用 `output.schema`（`additionalProperties: false`）校验返回对象，
> 缺字段声明会整份丢弃（`tool "wolf_delegate" returned invalid output`）；
> ③ `existsSync('agy.exe')` 是相对 cwd 检查、不查 PATH，会把装在 PATH 上的工人误判成不存在。

---

## 8. 故障排查

| 症状 | 原因 / 处置 |
|---|---|
| 基线命令判成「**工具故障**」 | Windows 上没有 PowerShell 7（PATH 里没有 `pwsh`）时会回退到 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（绝对路径，**不查 PATH**）；环境更特殊就用 `WOLFPACK_SHELL` |
| `agy 不可用` | 工人路径解析失败。设 `WOLFPACK_AGY` 为绝对路径，或把 `agy` 放进 `PATH` |
| `claude 未找到可执行文件或 PATH 中未找到` | 本机没装 Claude Code，或路径不对。设 `WOLFPACK_CLAUDE` 为绝对路径（Windows 上 npm 装的是 `claude.cmd`）。**没额度就把狼群开关里的 claude 取消勾选**——claude 预检不过只影响 claude，agy 照常干活 |
| 派活怎么突然改用 claude 了 | 两个工人都勾选时是**轮换**（`reason: rotation`），不是 bug。只想要 agy 就在开关里取消勾选 claude |
| 某个工人被「跳过」了 | 它刚失败到阈值、进了冷却。digest 会写清冷却原因与剩余时间，到点自动恢复——这是设计，不用反复重试 |
| 工人复选框点了没反应 / 两个都显示「已启用」 | 2.0.0 的前端把**缺失的键**当成「已启用」，写入被拒时也只 `console.warn`。2.1.0 起：缺键按 schema 默认显示（agy 开、claude 关），写入被拒会重读快照重试一次并在复选框旁写明原因。**若仍无反应，是宿主进程还跑着升级前的模块**——宿主模块只在进程启动时 import 一次，改动插件源码后必须**完全退出并重开 DSH**（客户端模块每次刷新页面都会重读） |
| 派活后立刻返回 `stale` | **不是错误**：基线命令已经通过，说明问题已被修或不存在，本轮**没有启动工人**（省钱设计）。别重派，直接收尾 |
| 磁盘改动显示「无法判定」 | 工作目录不是 git 仓库，探测不到增量。**这不等于「没有改动」**，以 `verify` 的退出码为准 |
| 同一个 `task_id` 第二次调用被拒 | 上一次还在跑（闸门在运行结束即释放）。等它结束，或换 `task_id` |
| 右侧实时面板空白 | 看 `<台账目录>/live-route.log`：多半是 `webServer` / `connection` 服务未就位，路由没挂上（面板空 = 路由没挂，不是没数据） |
| `agy 报服务端容量不足` | 与账户额度无关，**不要反复重试**；digest 会明确写这句 |
| 队友自报 ERROR 但活干成了 | 磁盘有产物或验收全过即判完成（见 4.3），这是刻意的救回规则 |
| CLI 任务文本里含 `-and`、`-eq` 之类 | CLI 按空格拆参数，裸 `-` 开头的 token 会被当成选项。用 `cmd /c findstr /c:...` 这类写法绕过 |
| MCP 返回 `-32601` | 未知方法**和**未知工具都用 `-32601`（实现只支持 4 个方法、4 个工具） |

---

## 9. 已知未做项（如实声明）

**验收边界**：本版当前以“实际执行的验收命令”判断 pass。如果一个检查通过而另一检查根本没启动，当前实现可能仍判 pass；与 Codex/通用版“所有登记检查均启动并通过”的修复不同。审查时必须核对每条检查的 ran 与退出码，不能只读总 verdict。completed 也不等于已验收达标，无验收的 unverified 不提供成功证据。

**观察成本**：status 和宿主面板不会启动工人模型，但 status 回执进入队长上下文仍有宿主阅读成本。“只读/零工人 token”不代表 AI 会话中可以无限轮询。持续观察优先用右侧面板。

1. **跨进程并发不是原子锁**：靠 `<raw_dir>/live/<taskId>.json` 登记 + PID 探活，
   存在「读登记 → 写登记」的竞态窗口；并发闸门只防**同进程**并发
   （源码里明确标注）。跨进程并发写台账也**没有文件锁**，只有进程内 Promise 串行链。
2. **工人适配器目前有 `agy` 与 `claude` 两个**。契约已抽好（`lib/core/worker/`），
   换别的 CLI 只需新增一个适配器文件（6 个导出）并注册进 registry。
   `claude` 适配器有 17 个用例覆盖，但那些用例跑的是**假 claude 脚本**——
   真实 Claude Code 的行为差异仍属未验证区域。
3. **停滞告警在 CLI/MCP 下是写 stderr**，不是系统气泡（DSH 下才有 PowerShell Toast）。
4. **MCP 只实现 Tools**，未声明 Resources / Prompts；未知方法/工具一律 `-32601`。
5. 工人的**思考正文未提取为明文流**，只统计 `thinking_tokens`
   （DSH 实时面板能读 transcript，但那是面板专用读取，不进 digest、不进上下文）。
6. **无 stream-json 事件分发**：`--output-format json` 输出单个 JSON 对象，
   全仓没有「事件类型」这一层。
7. `lib/core/live.mjs` 的写入侧在当前检出**未接线**（`writeLiveRecord` 无调用点），
   跨进程 kill 因此只对已存在登记文件的运行生效；`listLiveRecords` 的注释说会清理孤儿，
   实现只读不清。
8. 小工具细节：`tools/ledger-status.ps1` 的帮助注释列了 6 个字段，实际输出只有 4 列；
   CLI `delegate` 在 `unverified` 时退出码 1，而 `team` 在 `unverified` 时退出码 0。
9. **DSH 半边不吃 `wolfpack.config.json`**（只有 CLI / MCP 读），见 5.2。
10. **按工人分轨的停滞监控尚未移植**：当前 `stall-monitor` 的采样根是 agy 的那一套
    （`<HOME>/.gemini/antigravity-cli`），claude 的 transcript 目录
    （`~/.claude/projects/<项目目录>/<sessionId>.jsonl`）还没接进来。
    也就是说**跑 claude 时停滞监控拿不到心跳证据**，按既定原则「看不到就不报警」处理——
    宁可漏报，也不把「看不到」说成「卡住了」。
11. **CLI / MCP 侧没有 `health` 子命令**：故障分类与冷却逻辑都在核里，
    但只有 DSH 插件与 digest 会显示它。想在终端里查看/重置某个工人的冷却，
    目前只能直接读 `<台账目录>/worker-health.json`。
12. **面板类能力是 DSH 版独有的实现方式**：同族的 `universal/` 与 `codex/` 把实时面板
    做成 `wolf_live` / `wolf_panel` 两个工具（因此那边是 **6 个工具**），
    DSH 版走宿主侧 HTTP 路由 `/wolfpack/live` + 右侧面板标签页，**因此这里是 4 个工具**。
13. **`lib/core/config.mjs` 的 Windows claude 默认值仍是 `claude.exe`**，
    而 npm 全局安装的 Claude Code 实际是 `claude.cmd` / `claude.ps1`；
    CLI / MCP 侧不显式给 `WOLFPACK_CLAUDE` 时可能找不到 claude。
    DSH 插件侧走的是裸命令名 `claude`（靠 `PATHEXT` 解析），不受影响。
14. **宿主侧模块不会热重载**：DSH 加载器只在进程启动时 import 一次插件模块
    （`lib/index.js` 等），改动源码后即使插件目录里的文件已经变了，
    正在运行的宿主仍跑旧代码——必须**完全退出并重开 DSH**。
    客户端模块（`lib/client.js`）相反，每次页面加载都从磁盘重读，
    所以会出现「前端是新的、宿主是旧的」这种半新半旧组合；
    2.1.0 的前端对这种情况会如实显示并说明原因（见 §8），不再谎报「已启用」。
15. **设置写入没有幂等确认**：`scope.set()` 返回 `true` 只代表宿主接受了这次
    提交，不代表最终值一定等于期望值（宿主侧还有 `revision` 栅栏与
    别处的并发写入）。UI 因此在写入后重读一次快照再渲染。

---

## 10. 许可

MIT，见 [LICENSE](LICENSE)。
