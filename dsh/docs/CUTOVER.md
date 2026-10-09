# Wolfpack 迁移记录与回滚（CUTOVER）

> 状态：**已于 2026-10-01 完成**。目标 = 桌面版 DSH **0.2.0-rc.2** 的 `desktop` profile。
> 旧 0.1.5 安装（`D:\deepseek-harness` 源码 checkout + `profiles\web` / `profiles\headless`）
> 已按同一次清理删除；本文件从「未来割接预案」改为「已完成记录 + 回滚步骤」。

---

## 1. 迁移做了什么

宿主契约从 0.1.5 升到 0.2.0，两半各改了一处**真实断裂**的 API，其余保持不变：

| 半边 | 0.1.5 写法 | 0.2.0 写法 |
| :--- | :--- | :--- |
| Host | `inject = ['settings', 'systemPrompt']`；`ctx.settings.register(NS, Config, { base })` + `scope.watch()` | `inject = ['systemPrompt']`；开关就是插件自己的 `Config.enabled`（标 `.volatile()`），值从 `apply(ctx, config)` 读（`.get()`），变更靠 `ctx.on('loader/volatile-update', sync)` 就地挂载/摘除 |
| Client | `inject = ['slots', 'settingsScope']`；`settingsScope.bind({ namespace: NS })` | `inject = ['slots', 'configForms']`；`ctx.configForms.get(NS)`（快照形状 `{ status, value, base, user, revision, writable, mode }` 与旧版一致；`set()` 现在兑现 `Promise<boolean>`） |
| Client 模块 id | `window.__ModuleLoader__.load({ id: 'dsh-wolfpack' })` | id 必须等于包名：`id: 'wolfpack-unified'` |

### 1.1 真机实测又抓到的三处断裂（首轮只改对了一半）

装好后在真宿主里跑才算数——下面三处是**纸面比对看不出来、只有真机 boot 才会现形**的：

| # | 症状 | 根因 | 修法 |
| :--- | :--- | :--- | :--- |
| 1 | 整条 entry 不激活：`dsh: warning: 1 entry did not activate` + `Error: cannot get property "subprocess" without inject`（接着是 `webServer`、`connection`） | 0.2.0 的 cordis **强制注入**：`ctx.某服务` 这种属性访问，只要没写进 `inject` 就直接抛错。插件刻意软获取（缺服务时降级机制半、保住队长指令），却在 `DshRuntime`/`verify`/`live-route` 里用属性访问兜底 | 三处全改 `ctx.get('…')`；新增机械闸门 `X-h`（白名单式扫 `lib/**`，任何非核心属性访问即红） |
| 2 | 活干成了、台账也写了，但队长只看到 `tool "wolf_delegate" returned invalid output: "value.verify_registered_count" is not a declared property` | 0.2.0 会用 `output.schema`（`additionalProperties: false`）校验工具**返回对象**，校验不过就整份丢弃 → 「我已核实」段永远回不来 | 补 `verify_registered_count` 声明；新增套件 `tool-schema.test.mjs`：用 harness 自己的 `validateJsonSchemaValue` 校验四个工具真实返回的对象 |
| 3 | `agy 可执行文件不存在：agy.exe`，于是每次派活立刻返回「不可用」——但 `agy` 明明在 PATH 上 | 预检只做 `existsSync('agy.exe')`，那是相对**当前工作目录**的检查，从不查 PATH | `executableCandidates()` 按 PATH/PATHEXT 解析，并把解析出的**绝对路径**回写进配置再 spawn |

教训（值得记住）：**插件测试套件的假 ctx 不执行 cordis 的注入校验**，所以 `inject` 类断裂只能在真宿主里显现；
同理，假 ctx 也不会用 harness 的校验器验返回值。这也是为什么上一轮 219 条用例全绿、真机却挂不上。


保持不变（0.2.0 里仍然存在，已逐条核实）：

- 服务名 `tools` / `subagents` / `subprocess` / `systemPrompt`；`@deepseek-ai/dsh-tools` 的 `defineTool`、`@deepseek-ai/dsh-subagent` 的 `NO_START_CAPABILITIES` 导出名未变。
- 槽位 `conversation.input.right`、`settings.general.item`、`tool.call.toolview`（组件仍从 `props.block` 取工具块）、`sidebar.right.pane.tab`。
- 右侧栏服务 `ctx.sidebarRight` / `ctx.sidebarRightTabs`（0.2.0 用 `ctx.reflect.provide` 注册，名字没变），tab 类型 id 与槽位 key 已从 `dsh-wolfpack` 统一改为 `wolfpack-unified`。
- `ctx.inject(['<service>'], cb)` 仍是合法的 Cordis 客户端模式。

顺带修掉的旧环境依赖：测试套件原先靠 `$DSH_HOME/profiles/node_modules` 指向 0.1.5 源码的
junction farm 解析 peer 依赖（那份 schemastery 3.18.2 没有 `.volatile()`）。现在该目录是
**从桌面版安装里提取出来的真实 0.2.0 peer 闭包**（`@deepseek-ai/dsh-subagent` / `dsh-tools` /
`schemastery` 及其依赖，约 9 MB），不依赖任何源码 checkout。

---

## 2. 当前落位（desktop profile）

```jsonc
// <DSH_HOME>\profiles\desktop\package.json
{
  "dependencies": { "wolfpack-unified": "link:D:/DSH-Plugins/wolfpack-unified" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "@deepseek-ai/dsh-experimental-auto-review", "wolfpack-unified"
  ] } }
}
```

`node_modules\wolfpack-unified` 是指向 `D:\DSH-Plugins\wolfpack-unified` 的 junction（`link:` 语义），
所以改源码后重启宿主即可生效。插件行由本项目自带的 `cordis.patch.yml` 提供
（`{ id: wolfpack, name: wolfpack-unified }`），profile 的 patch 层不需要写这一行。

### 同批迁移的第三方插件

旧 `web` profile 里的第三方插件逐个尝试装进 `desktop`，装不上的由 0.2.0 的 peer 兼容闸门
挡在 pnpm 之前（什么都没下载）：

| 插件 | 结果 |
| :--- | :--- |
| `dsh-auto-collapse` 0.2.1 | ✅ 装（`settingsScope` 只是可选增强，按槽位探测，0.2.0 里自动降级不报错） |
| `dsh-diff-card` 0.1.4 | ✅ 装（已是最新，peer 是 `>=0.1.2-rc.1`，兼容） |
| `dshmarket` 1.66.7 | ✅ 装**新版**（旧 1.45.1 被拒；新版 peer 明确包含 `^0.2.0-rc.1`；设置卡走 `plugins.bundle.config` / `settings.plugins.tab` 槽位探测） |
| `@nanmicoder/dsh-agent-teams` 0.1.22 | ✅ 装**新版**（旧 0.1.17 被拒；新版 peer 列表含 `0.2.0-rc.2`） |
| `dsh-find-plugin` 0.3.7 / 0.4.0 | ❌ 拒装：连最新版都把 `@deepseek-ai/dsh-tools` 锁在 `^0.1.x`，没有适配 0.2.0 的版本。要强装必须先 `dsh plugin allow-version`（显式接受风险） |

---

## 3. 验收步骤

1. 退出并重新打开桌面版 DeepSeek Harness（首次装载必须重启，profile 不是 live-reload 型）。
2. 侧边栏 **插件** 页应能看到 `wolfpack-unified`；**设置 → 通用** 里应出现「🐺 狼群模式 / Wolfpack」行。
3. 新开一个会话，输入框右侧应出现狼群开关；打开后向模型询问可用工具，应看到
   `wolf_delegate` / `wolf_status` / `wolf_kill` / `wolf_team` 四个工具。
4. 让模型调用 `wolf_status`：只读台账，不启动工人、不消耗配额。
5. 小试一次委派：`task: "echo hello"`、`verify: ["echo hello"]`，应得到 `stale`（基线已通过 ⇒ 不启动工人，这是省钱设计，不是错误）。
6. 关掉开关：四个工具应立刻消失（不需要重启）。

不需要工人也能验的部分：`node tests/run.mjs`（**227 用例**，末行 `全部通过`，退出码 0）。

### 3.1 已跑通的真机冒烟（headless 冒烟 profile）

桌面端 profile 由 Electron 壳独占，CLI 不允许 boot 它，所以另有一个只为冒烟存在的 headless profile：

```
$DSH_HOME\profiles\wp-probe\        # bundles: base + headless + wolfpack-unified；patch 里 enabled: true
dsh --profile wp-probe headless "<让模型调用某个狼群工具的指令>"
```

已实测通过的三步（2026-10-01）：

1. 挂载日志：`wolfpack: 委派机制已挂载（provider "agy" + 工具 wolf_delegate/wolf_status/wolf_kill/wolf_team…）`
   （headless 组合没有 `webServer`，因此还有一句「跳过 /wolfpack/live」——桌面端有 `id: webserver` 与 `id: connection` 两行，所以那边会真挂上。）
2. `wolf_status`：读出台账 20 个任务，明确「只读，不触发 agy」。
3. `wolf_delegate` 真实委派（`smoke-hello-2`）：基线闸门 → agy 冷启动 55 秒 → 写出文件 → `findstr` 验收 → `verdict=pass`，两段式 digest 完整回来（修 #2 之前这一步只会回一句 schema 校验错误）。

> 注意：CLI 的任务文本是**按空格当参数解析**的，任务里出现 `-and`、`-eq` 这种独立 `-` 开头的 token 会被当成选项而报错。
> 冒烟时用 `cmd /c findstr /c:...` 这类没有裸 `-` 的写法绕过（`-` 只作为 stdin 标记时才特殊，且实测 stdin 传任务不可靠）。


---

## 4. 回滚

```powershell
# 1) 从 profile 里摘掉插件（会同时取消组合包选择）
dsh plugin --profile desktop remove wolfpack-unified

# 2) 需要保留历史配置时，从迁移前快照恢复
$BACKUP = "D:\DSH-Plugins\_migration-backup\profiles-desktop-before"
$PROFILE_DIR = "$env:DSH_HOME\profiles\desktop"   # 通常是 %USERPROFILE%\.dsh\profiles\desktop
Copy-Item "$BACKUP\package.json"     "$PROFILE_DIR\package.json" -Force
Copy-Item "$BACKUP\cordis.patch.yml" "$PROFILE_DIR\cordis.patch.yml" -Force

# 3) 重启宿主
```

源码级回滚：`D:\DSH-Plugins\_migration-backup\wolfpack-unified-before\` 保留了改动前的
`index.js` / `client.js` / `package.json`（0.1.5 契约版本，只能配 0.1.5 宿主使用）。

## 5. 回滚判定准则

1. 宿主启动时报 `Cannot find module 'wolfpack-unified'` 或该行加载失败。
2. `wolf_status` 调用导致会话异常。
3. 历史台账 `runs.ndjson` 被写坏或任务状态丢失。
4. 开关翻不动，或输入框右侧开关导致输入框不可用。
