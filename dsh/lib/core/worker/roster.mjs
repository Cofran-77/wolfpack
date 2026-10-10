/**
 * 工人登记表（Worker Roster）— 宿主半边。
 *
 * 单点来自 specs.mjs：
 *   - 2 个核心工人（agy, claude，来自 CORE_WORKER_NAMES，core: true）
 *   - 26 个声明式工人规格（来自 WORKER_SPECS，core: false）
 * 合计 28 个工人。
 *
 * 铁律：
 *   - 禁止 import 除 node: 内建以外的任何模块（宿主/三方包不可用）；
 *   - 默认 find 探测仅使用 node:fs/node:path 与 PATH 环境变量，禁止 spawn 任何进程；
 *   - buildWorkerRoster 顺序稳定且支持注入 find。
 */

import { CORE_WORKER_NAMES, WORKER_SPECS } from "./specs.mjs"
import { defaultFind } from "./resolve.mjs"

export { defaultFind }

/**
 * 构建全部 28 个工人的登记表。
 *
 * @param {{ find?: (bin: string) => string|undefined }} [options]
 * @returns {Array<{ name: string, label: string, bin: string, installed: boolean, core: boolean }>}
 */
export function buildWorkerRoster({ find = defaultFind } = {}) {
  const roster = []

  // 1. 核心工人（CORE_WORKER_NAMES: 'agy', 'claude'）
  const agyBin = (process.env.WOLFPACK_AGY && process.env.WOLFPACK_AGY.trim())
    || (process.platform === 'win32' ? 'agy.exe' : 'agy')
  const claudeBin = (process.env.WOLFPACK_CLAUDE && process.env.WOLFPACK_CLAUDE.trim())
    || (process.platform === 'win32' ? 'claude.exe' : 'claude')

  const coreMeta = {
    agy: {
      label: 'Antigravity CLI (agy)',
      bin: agyBin,
    },
    claude: {
      label: 'Claude Code (claude)',
      bin: claudeBin,
    },
  }

  for (const name of CORE_WORKER_NAMES) {
    const meta = coreMeta[name] || {
      label: name,
      bin: name,
    }
    const hit = find(meta.bin)
    const installed = typeof hit === 'string' ? hit.trim() !== '' : Boolean(hit)
    roster.push({
      name,
      label: meta.label,
      bin: meta.bin,
      installed,
      core: true,
    })
  }

  // 2. 声明式工人（WORKER_SPECS: 26 个）
  for (const spec of WORKER_SPECS) {
    const hit = find(spec.bin)
    const installed = typeof hit === 'string' ? hit.trim() !== '' : Boolean(hit)
    roster.push({
      name: spec.name,
      label: spec.label,
      bin: spec.bin,
      installed,
      core: false,
    })
  }

  return roster
}

/**
 * 返回 buildWorkerRoster 的 JSON 序列化字符串。
 *
 * @param {{ find?: (bin: string) => string|undefined }} [options]
 * @returns {string}
 */
export function workerRosterJson({ find } = {}) {
  return JSON.stringify({
    version: 1,
    workers: buildWorkerRoster({ find }),
  })
}
