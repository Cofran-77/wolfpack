/**
 * wolf-delegate 兼容重导出薄壳 (≤ 2000 字节)。
 * 所有实现已统一收敛至 lib/index.js 与 lib/core/**。
 */

export {
  DEFAULT_STATUS_LIMIT,
  formatToolBudget,
  MAX_STATUS_LIMIT,
  registerWolfDelegate,
  registerWolfStatus,
  renderDigest,
  renderStatus,
  runDelegateTask,
  STATUS_CHANGED_FILES_PER_TASK,
  STATUS_TOOL_NAME,
  statusMetaFromValue,
  TOOL_NAME,
} from './index.js'
