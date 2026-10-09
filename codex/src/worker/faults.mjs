/**
 * 工人故障识别：把「工人自己的毛病」与「任务本身失败」分开。
 *
 * 为什么需要：CLI 装着但没登录、API 中转池子额度耗尽、进程挂住不出声，
 * 这些都不是任务失败，而是工人当前不可用。健康台账据此把工人冷却掉，
 * 下一轮自动改派另一个工人，避免每轮都撞同一堵墙。
 */

/** 容量/额度类 HTTP 状态码（中转池子额度耗尽常以 402/429 返回）。 */
export const CAPACITY_STATUS = [402, 429, 503, 529]

/**
 * 容量/额度类文案：只在结构化错误字段与 stderr 上匹配，避免误判工人正文。
 * 覆盖官方限流、额度用尽，以及常见 API 中转（one-api / new-api 系）的「无可用渠道 / 额度不足」。
 */
const CAPACITY_TEXT = /(no capacity available|overloaded|rate ?limit|too many requests|quota|insufficient[_ ]?(user[_ ]?)?quota|exceeded your current quota|no available channel|无可用渠道|暂无可用渠道|渠道不可用|额度不足|配额不足|余额不足|欠费|容量不足|负载已满|限流)/i

/**
 * 窄模式：允许在整段 raw stdout 上匹配（工人正文里出现这些整串的可能性极低）。
 */
const CAPACITY_TEXT_NARROW = /(no capacity available|insufficient[_ ]?(user[_ ])?quota|exceeded your current quota|no available channel|无可用渠道|暂无可用渠道|额度不足|配额不足|余额不足)/i

/** 鉴权/未登录类文案：这类不算「任务失败」，而是工人当前不可用。 */
const AUTH_TEXT = /(unauthorized|invalid[_ -]?api[_ -]?key|authentication[_ ]error|invalid bearer|not logged in|please (log|sign) in|please run .{0,24}login|登录已过期|未登录|请先登录|凭证(无效|过期)|密钥无效)/i

/**
 * 判定是否为容量/额度类故障。
 *
 * @param {object} [params]
 * @param {number} [params.status] - 结构化 API 状态码
 * @param {string[]} [params.texts] - 结构化错误字段与 stderr（不要传整段 stdout 正文）
 * @param {string} [params.raw] - 整段 stdout（只匹配窄模式）
 * @returns {boolean}
 */
export function matchCapacity({ status, texts = [], raw } = {}) {
  if (typeof status === 'number' && CAPACITY_STATUS.includes(status)) return true
  for (const text of texts) {
    if (typeof text === 'string' && text !== '' && CAPACITY_TEXT.test(text)) return true
  }
  if (typeof raw === 'string' && raw !== '' && CAPACITY_TEXT_NARROW.test(raw)) return true
  return false
}

/**
 * 判定是否为鉴权/未登录类故障。
 *
 * @param {object} [params]
 * @param {Array<string|number>} [params.texts]
 * @returns {boolean}
 */
export function matchAuth({ texts = [] } = {}) {
  for (const text of texts) {
    if (typeof text === 'number' && (text === 401 || text === 403)) return true
    if (typeof text === 'string' && text !== '' && AUTH_TEXT.test(text)) return true
  }
  return false
}

/**
 * 从诊断文本里抠出 API 状态码（claude 适配器把状态码拼成 `API 402: …`）。
 *
 * @param {unknown} text
 * @returns {number|undefined}
 */
export function apiStatusFromText(text) {
  if (typeof text !== 'string') return undefined
  const m = /\bAPI (\d{3})\b/.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/**
 * 判定这一轮的故障属于哪一类。
 * 返回 undefined 表示「不算工人故障」：成功、基线闸门跳过、以及**用户自己取消**。
 *
 * @param {object} [params]
 * @param {string} [params.stopReason]
 * @param {boolean} [params.timedOut]
 * @param {boolean} [params.cancelled]
 * @param {boolean} [params.outputEmpty]
 * @param {number} [params.status]
 * @param {string[]} [params.texts]
 * @param {string} [params.raw]
 * @returns {'capacity'|'auth'|'timeout'|'no-output'|'error'|undefined}
 */
export function classifyFaultKind({
  stopReason,
  timedOut,
  cancelled,
  outputEmpty,
  status,
  texts = [],
  raw,
} = {}) {
  // 用户自己掐的进程不算工人的毛病；超时才算（多半是挂住不说话）
  if (cancelled === true && timedOut !== true) return undefined
  if (timedOut === true) return 'timeout'
  if (stopReason === 'completed' || stopReason === 'skipped') return undefined
  if (stopReason === 'capacity') return 'capacity'
  if (matchCapacity({ status, texts, raw })) return 'capacity'
  // 状态码也要参与鉴权判定（401/403）：中转与 CLI 有时只给码不给文案
  if (matchAuth({ texts: [status, ...texts] })) return 'auth'
  if (outputEmpty === true) return 'no-output'
  if (stopReason === 'error' || stopReason === 'aborted') return 'error'
  return undefined
}
