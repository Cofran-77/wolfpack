# Wolfpack 切换与割接操作指南 (CUTOVER)

> [!WARNING]
> **重要声明**：本指南仅作为架构演进与未来部署的技术预案文档。**当前阶段严格禁止执行任何部署、切换或重启操作！** 严禁修改 `C:\Users\13398\.dsh\` 下的任何文件。

---

## 1. 切换前置准备与备份要求

> [!IMPORTANT]
> **切换前请先备份 profile 的 `package.json` 与 `cordis.patch.yml`！**

在未来获准执行割接前，必须在备份目录下保留完整原状：
```powershell
# 假设 profile 目录为 C:\Users\13398\.dsh\profiles\default（根据实际环境为准）
$PROFILE_DIR = "C:\Users\13398\.dsh\profiles\web" # 或实际激活的 profile 目录
$BACKUP_DIR = "C:\Users\13398\.dsh\profiles\backup-before-wolfpack-cutover"

New-Item -ItemType Directory -Path $BACKUP_DIR -Force
Copy-Item "$PROFILE_DIR\package.json" -Destination "$BACKUP_DIR\package.json"
Copy-Item "$PROFILE_DIR\cordis.patch.yml" -Destination "$BACKUP_DIR\cordis.patch.yml"
```

---

## 2. 详细割接步骤 (Future Cutover Steps)

### 步骤 1：确认测试全绿与代码基线无损
在 `D:\DSH-Plugins\wolfpack-unified` 目录下运行完整测试套件，确认 208+ 测试全绿：
```powershell
cd D:\DSH-Plugins\wolfpack-unified
node tests/run.mjs
```
必须输出 `全部通过` 且退出码为 0。

### 步骤 2：更新 Profile 的 `package.json`
在目标 profile 的 `package.json` 中，将插件依赖从原 `dsh-wolfpack` 切换为 `wolfpack-unified`：
```json
{
  "dependencies": {
    "wolfpack-unified": "file:D:\\DSH-Plugins\\wolfpack-unified"
  }
}
```
（或者如果使用本地 npm link / junction 方案，将 `node_modules/wolfpack-unified` 链接至 `D:\DSH-Plugins\wolfpack-unified`）。

### 步骤 3：更新 Profile 的 `cordis.patch.yml`
检查 `cordis.patch.yml` 中的插件加载项：
- 原配置：
  ```yaml
  - insert:
      - id: wolfpack
        name: dsh-wolfpack
  ```
- 切换为：
  ```yaml
  - insert:
      - id: wolfpack
        name: wolfpack-unified
  ```
> **注意**：`wolfpack-unified` 保持对外 service 与 tool 命名空间依然为 `wolfpack`，配置项与历史台账完全无缝兼容。

### 步骤 4：更新本地目录 Junction（如适用）
如果宿主 profile 的 `node_modules` 采用目录软链接/Junction 方式挂载：
```cmd
:: 移除原 dsh-wolfpack junction
rmdir "C:\Users\13398\.dsh\profiles\web\node_modules\dsh-wolfpack"

:: 创建指向 wolfpack-unified 的 junction
mklink /J "C:\Users\13398\.dsh\profiles\web\node_modules\wolfpack-unified" "D:\DSH-Plugins\wolfpack-unified"
```

### 步骤 5：优雅重启 DSH 宿主
1. 在宿主托盘或终端正常终止 DSH 服务进程。
2. 重新启动 DSH：`dsh start` 或通过图形界面拉起。
3. 检查控制台日志输出，确认出现：
   ```
   wolfpack: 委派机制已挂载（provider "agy" + 工具 wolf_delegate/wolf_status/wolf_kill/wolf_team，台账 ...）
   wolfpack: live route mounted at /wolfpack/live
   ```

### 步骤 6：功能冒烟验收
在 DSH 对话窗口中执行工具调用验证：
1. **测试只读状态**：调用 `wolf_status`，验证能读出已有任务台账，且未触发进程启动。
2. **测试小试委派**：调用 `wolf_delegate`，委派简单任务（例如 `task: "echo hello", verify: ["echo hello"]`），验证裁决为 `pass` 且两段式 digest 正常渲染。
3. **检查客户端 UI**：确认输入框狼群模式开关浮现，右侧 live 面板可正常打开。

---

## 3. 回滚方案 (Rollback Procedure)

如果在切换后发现任何不兼容异常、进程启动异常或 UI 渲染失败，立即执行回滚：

### 步骤 1：恢复 Profile 配置文件
```powershell
Copy-Item "$BACKUP_DIR\package.json" -Destination "$PROFILE_DIR\package.json" -Force
Copy-Item "$BACKUP_DIR\cordis.patch.yml" -Destination "$PROFILE_DIR\cordis.patch.yml" -Force
```
或直接将 `cordis.patch.yml` 中的插件项改回：
```yaml
- insert:
    - id: wolfpack
      name: dsh-wolfpack
```

### 步骤 2：恢复 Junction 链接
```cmd
rmdir "C:\Users\13398\.dsh\profiles\web\node_modules\wolfpack-unified"
mklink /J "C:\Users\13398\.dsh\profiles\web\node_modules\dsh-wolfpack" "D:\DSH-Plugins\dsh-wolfpack"
```

### 步骤 3：重启宿主
重启 DSH 宿主服务，验证旧版 `dsh-wolfpack` 重新加载成功。

---

## 4. 回滚判定准则 (Rollback Criteria)

遇下列任一情况，应立即执行回滚并停止切换：
1. 宿主启动时报 `Cannot find module 'wolfpack-unified'` 或插件激活失败。
2. `wolf_status` 执行报错导致会话崩溃。
3. 原有历史台账任务状态丢失或 `runs.ndjson` 解析损坏。
4. 客户端界面输入框无法输入或控制台持续报错。
