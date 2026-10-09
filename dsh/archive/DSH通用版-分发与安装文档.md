# DSH 通用版 · 分发与安装文档

**目的（按你的口径修正）**：这不是用来替代你自己那套 `dsh-wolf` 的，而是**给其他用户用的可分发版本**。
所以你正在用的插件**全程没有被改动，也没有执行过任何切换** —— `dsh-wolfpack` 9 个 lib 文件的
SHA256 我每一轮都核对，至今逐条未变。

---

## 1. 分发前修掉的一个真问题（这条最值得看）

我模拟「别人拿到这个包去装」时，用 `npm pack --dry-run` 查了实际会打进包里的文件：

```
打包会包含的文件数: 26
briefing.md 在包里吗: false      ← 问题在这
LICENSE 在包里吗: false
```

而 `lib/index.js:104` 是从**插件目录**读 `briefing.md` 的：

```js
const BRIEFING_PATH = process.env.WOLFPACK_BRIEFING ?? join(pluginRoot, 'briefing.md')
```

**后果**：任何人通过 npm / 打包方式安装，`briefing.md`（8,697 字节的队长指令正文）都不在包里，
插件会**静默退化**成那份几百字的兜底文案 —— 功能不报错，但队长完全不是狼群那套判断逻辑。
本地从源码目录跑一切正常，所以自测发现不了。

同一类坑在你旧插件的历史里出现过（白名单外的陈旧 `briefing.md`），这次是它的镜像版本。

**已修**：`package.json` 的 `files` 加上 `briefing.md` 与 `docs`，并补了 `README.md`、`LICENSE`。
复验：

```
包内文件数: 31
  ✓ briefing.md   ✓ LICENSE   ✓ README.md
  ✓ docs/HOST-MATRIX.md   ✓ docs/CUTOVER.md   ✓ cordis.patch.yml
```

---

## 2. 其他用户怎么装

完整安装说明写在项目根的 **`README.md`**（这次专门为「陌生人拿到就能装」写的）。三种装法：

| 装法 | 命令 / 配置 | 适用 |
|---|---|---|
| **A. 独立 CLI**（零依赖） | `node bin/wolf.mjs status --json` | 只想用命令行 / CI，不需要 DSH |
| **B. MCP 服务** | `[mcp_servers.wolfpack]` → `node .../bin/wolf-mcp.mjs` | ChatGPT 桌面端 / Codex / Claude Desktop / Cursor |
| **C. DSH 插件**（原生形态） | profile 依赖 + `cordis.patch.yml` 里 `id: wolfpack, name: wolfpack-unified` | DSH 用户 |

**别人需要准备什么**：Node ≥ 20、工人 CLI（当前适配器是 `agy`，需已安装并登录）；
只有走 DSH 插件形态才额外需要宿主与三个 peer 依赖（`@deepseek-ai/dsh-tools`、`dsh-subagent`、`schemastery`）。

**先自检再装**（不消耗工人额度、不需要工人）：

```bash
node tests/run.mjs      # 期望末行「全部通过」，退出码 0
```

---

## 3. 我实测过的（区分「它说」和「我验」）

| 检查项 | 结果 |
|---|---|
| 测试套件 | **212 通过 / 0 失败**（host 177 + client 35），exit 0 |
| 用例集合等价性 | 参考 109 + 6 → 新项目 **117 + 6，零丢失** |
| 打包完整性 | `npm pack` 复验：`briefing.md` / `LICENSE` / `README.md` / `docs/*` **已在包内** |
| 核心是否宿主无关 | `lib/core/**` 内无任何 `../` 越界 import、无 `node:child_process` |
| 浏览器面板 | `lib/client.js` 与旧插件 **SHA256 完全相同** |
| 你的线上插件 | `dsh-wolfpack` 9 个 lib **SHA256 全部未变** |
| 异地可移植性 | 拷到别处并**清空 `DSH_HOME`** 后：CLI exit 0；MCP 能启动并正确返回 `tools/list` |
| 机器专属路径 | 已清零：工人路径为 `WOLFPACK_AGY ?? (win32 ? 'agy.exe' : 'agy')`，走 PATH；`briefing.md` 按插件目录解析 |
| 交付包完整性 | 解压后 34 个文件与源**逐条 SHA256 相同** |

---

## 4. 还没做的：分发渠道（需要你决定）

我把 `private` 从 `true` 改成了 `false`（这只代表**允许**发布，本身不会发布任何东西）。
真正的对外分发还没做，因为那是**外部动作**，得你点头：

- **发 npm**：`npm publish` → 别人 `npm i wolfpack-unified`。需要 npm 账号与包名占用确认。
- **发 GitHub**：仓库 + `dsh-plugin` 话题 → 别人能 `dsh plugin add`。需要仓库地址，
  补进 `package.json` 的 `repository` 字段。
- **就这么传**：直接把 zip 给出去（零手续，但别人要自己接 profile）。

另外 `LICENSE` 里的版权行我写的是 `wolfpack-unified contributors`（我不知道你要署什么名）——
要改成你自己的名字或 GitHub 用户名，告诉我一声。

---

## 5. 诚实的边界

- **我没有在别人的（或干净的）DSH 里真正装过一次**。测试是**模拟宿主**跑的（用真的 `defineTool`
  与真 schema，但 ctx 是假的）。所以「换台机器能装上」是**推断**，第一次给别人装时要按 README 的
  自检步骤实证。
- **工人适配器目前只有 `agy`**。要适配「用别的 CLI 干活的用户」，得新写一个适配器文件——
  契约已经抽好（`lib/core/worker/`），这是下一个最值得做的扩展。
- **与本机另一套 `wolfpack-codex` 不共享台账**：这一套走 `$DSH_HOME` 阶梯，那一套走 `~/.wolfpack/`。
  分发给别人时不受影响，但你若同机都用会是两本账。

---

## 6. 两个交付物的关系

| | `wolfpack-codex-交付` | `wolfpack-unified-交付`（本包） |
|---|---|---|
| 形态 | 独立 CLI + MCP stdio | DSH 插件 + CLI + MCP 三入口 |
| 适合 | 只想在 Codex / ChatGPT 桌面端用的人 | 想要完整形态（含前端面板、实时看板）的人 |
| 依赖 | 零依赖 | DSH 宿主 + 三个 peer 依赖 |

分发给不同的人，按他们的环境挑一个给即可；两边用的是同一套判定语义。

---

*生成于 2026-09-16。源目录 `D:\DSH-Plugins\wolfpack-unified`。
你正在使用的 `D:\DSH-Plugins\dsh-wolfpack` 未被改动，也未执行任何切换。*
