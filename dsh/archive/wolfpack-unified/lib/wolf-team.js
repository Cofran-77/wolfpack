/**
 * wolf-team 兼容重导出薄壳 (≤ 2000 字节)。
 * 所有实现已统一收敛至 lib/core/team.mjs 与 lib/index.js。
 */

export {
  buildTeamSummary,
  DEFAULT_TEAM_CONCURRENCY,
  MAX_TEAM_CONCURRENCY,
  MAX_TEAM_TASKS,
  renderTeamDigest,
  runTeamTasks,
  TEAM_ERROR_MAX_CHARS,
  TEAM_REPORT_HEAD_CHARS,
  TEAM_SUMMARY_MAX_CHARS,
  TEAM_TOOL_NAME,
} from './core/team.mjs'

export {
  registerWolfTeam,
} from './index.js'
