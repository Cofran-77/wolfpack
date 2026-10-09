/**
 * 运行时注入表（宿主无关）。
 *
 * 核心层（src/delegate.mjs、src/team.mjs、src/verify.mjs）**绝不**直接 import 任何
 * 宿主模块：所有进程派生都走这里解析出来的 Runtime。宿主在自己的入口处
 * 显式注入实现（Node 宿主见 src/runtime/node.mjs，DSH 一类宿主见 src/runtime/dsh.mjs）。
 */

/** @type {{ spawn: Function, killTree?: Function }|undefined} */
let defaultRuntime

/**
 * 注入默认运行时。
 *
 * @param {{ spawn: Function, killTree?: Function }} runtime
 */
export function setDefaultRuntime(runtime) {
  defaultRuntime = runtime
}

/**
 * 读取当前默认运行时（未注入时为 undefined）。
 *
 * @returns {{ spawn: Function, killTree?: Function }|undefined}
 */
export function getDefaultRuntime() {
  return defaultRuntime
}

/**
 * 解析实际要用的运行时：显式传入的优先，其次默认注入的，最后返回 undefined
 * （此时调用方回退到内置的 Node 实现，绝不隐式借用别的宿主）。
 *
 * @param {object} [runtimeOrCtx]
 * @returns {{ spawn: Function, killTree?: Function }|undefined}
 */
export function resolveRuntime(runtimeOrCtx) {
  if (runtimeOrCtx && typeof runtimeOrCtx.spawn === 'function') return runtimeOrCtx
  return defaultRuntime
}

/**
 * 清空注入（测试用，避免用例之间互相污染）。
 */
export function resetDefaultRuntime() {
  defaultRuntime = undefined
}
