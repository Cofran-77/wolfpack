/**
 * Lossless JSON 规整与防线。
 *
 * 宿主判据（visitJsonValue）：
 *   - string / boolean / null 一律合法
 *   - number 必须有限且不能是 -0
 *   - 原始类型 undefined / function / symbol / bigint 一律非法
 *   - 纯对象与数组之外（Date / Map / Set / 自定义类）一律非法
 *   - 不得成环
 *
 * 本防线行为铁律：
 * 1. 对象属性值为 undefined 时安全丢弃（等价于 JSON.stringify 键缺席语义）；
 * 2. 非有限数字（NaN / Infinity / -Infinity）与 -0 必须显式抛错，禁止静默改成 0；
 * 3. 数组元素出现 undefined / 非法类型属于上游 bug，必须显式抛错，禁止静默抹平；
 * 4. 非纯对象、成环一律显式抛错。
 */

/**
 * 宿主 lossless JSON 违规项探测（等价于宿主 visitJsonValue）。
 *
 * @param {unknown} value
 * @param {string} [path]
 * @param {Set<object>} [ancestors]
 * @returns {string[]} 违规说明列表，为空表示完全合法
 */
export function losslessViolations(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return []
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return [`${path} 是非有限数字 ${String(value)}`]
    if (Object.is(value, -0)) return [`${path} 是 -0`]
    return []
  }
  if (typeof value !== 'object') return [`${path} 是 ${typeof value}（嵌套 undefined 等一律非法）`]
  if (ancestors.has(value)) return [`${path} 成环`]
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    return [`${path} 不是纯对象/数组：${Object.prototype.toString.call(value)}`]
  }
  ancestors.add(value)
  const out = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => out.push(...losslessViolations(item, `${path}[${index}]`, ancestors)))
  } else {
    for (const key of Object.keys(value)) {
      out.push(...losslessViolations(value[key], `${path}.${key}`, ancestors))
    }
  }
  ancestors.delete(value)
  return out
}

/**
 * 将值递归规整为 lossless JSON。
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function toLosslessJson(value) {
  function walk(val, path, ancestors) {
    if (val === null || typeof val === 'string' || typeof val === 'boolean') {
      return val
    }
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        throw new TypeError(`[wolfpack/lossless] ${path} 是非有限数字 ${String(val)}（lossless JSON 仅接受有限数字）`)
      }
      if (Object.is(val, -0)) {
        throw new TypeError(`[wolfpack/lossless] ${path} 是 -0（lossless JSON 禁止 -0）`)
      }
      return val
    }
    if (typeof val !== 'object') {
      throw new TypeError(`[wolfpack/lossless] ${path} 是非法类型 ${typeof val}（lossless JSON 禁止 undefined/function/symbol/bigint）`)
    }
    if (ancestors.has(val)) {
      throw new TypeError(`[wolfpack/lossless] ${path} 检测到循环引用，无法转换为 lossless JSON`)
    }
    const proto = Object.getPrototypeOf(val)
    if (!Array.isArray(val) && proto !== Object.prototype && proto !== null) {
      throw new TypeError(`[wolfpack/lossless] ${path} 不是纯对象或数组：${Object.prototype.toString.call(val)}`)
    }

    ancestors.add(val)
    try {
      if (Array.isArray(val)) {
        const out = new Array(val.length)
        for (let i = 0; i < val.length; i++) {
          const item = val[i]
          if (item === undefined) {
            throw new TypeError(`[wolfpack/lossless] 数组元素 ${path}[${i}] 为 undefined（数组中出现 undefined 属于上游 bug，禁止静默抹平）`)
          }
          out[i] = walk(item, `${path}[${i}]`, ancestors)
        }
        return out
      }

      const out = {}
      for (const key of Object.keys(val)) {
        const item = val[key]
        if (item === undefined) {
          // 丢掉值为 undefined 的对象属性
          continue
        }
        out[key] = walk(item, `${path}.${key}`, ancestors)
      }
      return out
    } finally {
      ancestors.delete(val)
    }
  }

  return walk(value, '$', new Set())
}
