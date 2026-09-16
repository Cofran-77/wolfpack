import { agyWorker } from './agy.mjs'

const registry = new Map([
  [agyWorker.name, agyWorker],
])

/**
 * 注册工人适配器。
 *
 * @param {object} worker
 */
export function registerWorker(worker) {
  if (!worker || typeof worker.name !== 'string') {
    throw new Error('[wolfpack/worker] 工人适配器必须包含有效的 name')
  }
  registry.set(worker.name, worker)
}

/**
 * 获取指定名称的工人适配器。
 *
 * @param {string} [name='agy']
 * @returns {typeof agyWorker}
 */
export function getWorker(name = 'agy') {
  const worker = registry.get(name)
  if (!worker) {
    throw new Error(`[wolfpack/worker] 未找到名为 "${name}" 的工人适配器`)
  }
  return worker
}

export { agyWorker }
