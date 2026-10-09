import { agyWorker } from './agy.mjs'

const WORKERS = {
  agy: agyWorker,
}

/**
 * 获取指定名称的工人适配器。
 *
 * @param {string} [name='agy']
 * @returns {typeof agyWorker}
 */
export function getWorker(name = 'agy') {
  const norm = String(name || 'agy').trim().toLowerCase()
  const worker = WORKERS[norm]
  if (!worker) {
    throw new Error(`[wolfpack/worker] 未知的工人类型: "${name}"，支持的类型: ${Object.keys(WORKERS).join(', ')}`)
  }
  return worker
}
