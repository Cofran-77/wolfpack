import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { claudeProjectSlug } from './stall.mjs'

/**
 * 狼群实时面板 — 工人会话流水的只读尾部读取。
 *
 * 两个工人的流水格式完全不同，因此**各有一套定位与摘要实现**，绝不互相套用：
 *   · agy：<store>/brain/<conversationId>/.system_generated/logs/transcript[_full].jsonl
 *          行形如 { step_index, type, status, created_at, content | tool_calls }
 *   · claude（Claude Code CLI，**不是** Claude Desktop）：
 *          <store>/<项目目录>/<session_id>.jsonl
 *          行形如 { type, message: { role, content }, timestamp, uuid, sessionId }
 *
 * 本模块纯只读，永远不写会话流水，也永远不把内容送进模型上下文。
 */

/** 每个运行最多返回的事件条数。 */
export const MAX_TRANSCRIPT_EVENTS = 12
/** 每条事件文本截断上限。 */
export const MAX_EVENT_TEXT_CHARS = 400
/** 尾部读取字节窗口（64KB）。 */
export const TAIL_READ_BYTES = 64 * 1024
/** 已结束任务的尾部读取缓存条数。 */
const TAIL_CACHE_MAX_ENTRIES = 32

/**
 * 提取**单条**流水记录的人类可读摘要。
 *
 * @param {string} worker - 'agy' | 'claude'
 * @param {Record<string, unknown>} entry
 * @param {number} [maxChars]
 * @returns {string}
 */
export function summarizeTranscriptEntry(worker, entry, maxChars = MAX_EVENT_TEXT_CHARS) {
  const text = worker === 'claude'
    ? summarizeClaudeEntry(entry)
    : summarizeAgyEntry(entry)
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/**
 * Claude Code CLI 的流水摘要。
 * thinking 优先；其次工具调用；再次正文；最后状态。
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function summarizeClaudeEntry(entry) {
  if (!entry || typeof entry !== 'object') return ''

  if (entry.type === 'summary' && typeof entry.summary === 'string') {
    return `[summary] ${entry.summary.trim()}`
  }

  const message = entry.message
  if (message && typeof message === 'object') {
    const content = message.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const parts = []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          parts.push(block.thinking.trim())
        } else if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text.trim())
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'tool'
          const brief = typeof block.input?.command === 'string'
            ? block.input.command
            : (typeof block.input?.file_path === 'string'
              ? block.input.file_path
              : (typeof block.input?.pattern === 'string' ? block.input.pattern : ''))
          parts.push(brief ? `[${name}] ${brief}` : `[${name}]`)
        } else if (block.type === 'tool_result') {
          const inner = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content)
              ? block.content.map(item => (typeof item?.text === 'string' ? item.text : '')).join(' ')
              : '')
          parts.push(`[tool_result] ${inner.trim()}`.trim())
        }
      }
      const joined = parts.filter(part => part !== '').join(' ')
      if (joined !== '') return joined
    }
  }

  if (typeof entry.type === 'string') return `[${entry.type}]`
  return ''
}

/**
 * agy 的流水摘要。
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function summarizeAgyEntry(entry) {
  if (!entry || typeof entry !== 'object') return ''

  const toolNames = Array.isArray(entry.tool_calls)
    ? entry.tool_calls
        .map(tc => (typeof tc === 'string' ? tc : (tc?.name || 'tool')))
        .filter(Boolean)
        .join(', ')
    : ''

  const body = entry.thinking !== undefined
    ? String(entry.thinking).trim()
    : (entry.content !== undefined && entry.content !== null
      ? (typeof entry.content === 'string' ? entry.content.trim() : JSON.stringify(entry.content))
      : (entry.status ? String(entry.status) : ''))

  if (toolNames !== '' && body !== '') return `[${toolNames}] ${body}`
  if (toolNames !== '') return toolNames
  return body
}

/**
 * 解析一段 JSONL 文本（跳过半截行）。
 *
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
export function parseJsonl(text) {
  const entries = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed)
      if (item && typeof item === 'object' && Array.isArray(item) === false) entries.push(item)
    } catch {
      // 首行/尾行常是半截，跳过
    }
  }
  return entries
}

/**
 * 尾部读取并摘要一段会话流水（纯函数，便于测试）。
 *
 * @param {string} worker
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxEvents]
 * @param {number} [options.maxChars]
 * @returns {{available: boolean, reason?: string, step_index: number|null, step_total: number, events: Array<{at?: string, kind: string, text: string}>}}
 */
export function summarizeTranscriptText(worker, text, { maxEvents = MAX_TRANSCRIPT_EVENTS, maxChars = MAX_EVENT_TEXT_CHARS } = {}) {
  const entries = parseJsonl(text)
  if (entries.length === 0) {
    return {
      available: false,
      reason: '未解析到有效记录',
      events: [],
      step_index: null,
      step_total: 0,
    }
  }

  const lastEntry = entries[entries.length - 1]
  const stepIndex = worker === 'agy'
    ? (typeof lastEntry?.step_index === 'number' ? lastEntry.step_index : null)
    : entries.length

  const recent = entries.slice(-maxEvents)
  const events = recent
    .map(entry => {
      const event = {
        kind: String(entry.type ?? entry.source ?? 'unknown'),
        text: summarizeTranscriptEntry(worker, entry, maxChars),
      }
      const at = entry.created_at ?? entry.timestamp
      if (at !== undefined && at !== null) event.at = String(at)
      return event
    })
    .filter(event => event.text !== '')

  return { available: true, step_index: stepIndex, step_total: entries.length, events }
}

/**
 * 候选流水文件路径（按优先级）。
 *
 * @param {string} worker
 * @param {object} params
 * @param {string|undefined} params.storeRoot
 * @param {string|undefined} params.conversationId
 * @param {string} [params.cwd]
 * @returns {string[]}
 */
export function transcriptCandidates(worker, { storeRoot, conversationId, cwd }) {
  if (typeof storeRoot !== 'string' || storeRoot === '') return []
  if (typeof conversationId !== 'string' || conversationId === '') return []

  if (worker === 'agy') {
    const logs = join(storeRoot, 'brain', conversationId, '.system_generated', 'logs')
    return [join(logs, 'transcript_full.jsonl'), join(logs, 'transcript.jsonl')]
  }
  if (worker === 'claude') {
    const fileName = `${conversationId}.jsonl`
    const list = []
    if (typeof cwd === 'string' && cwd !== '') {
      list.push(join(storeRoot, claudeProjectSlug(cwd), fileName))
    }
    return list
  }
  return []
}

/**
 * 在 store 根下按文件名搜索会话流水（claude 的项目目录名依赖 cwd，找不到就全库找一遍）。
 *
 * @param {string} root
 * @param {string} fileName
 * @returns {Promise<string|undefined>}
 */
async function searchSessionFile(root, fileName) {
  let names
  try {
    names = await readdir(root)
  } catch {
    return undefined
  }
  for (const name of names) {
    const dir = join(root, name)
    let info
    try {
      info = await stat(dir)
    } catch {
      continue
    }
    if (info.isDirectory() !== true) {
      if (name === fileName) return dir
      continue
    }
    const candidate = join(dir, fileName)
    try {
      const s = await stat(candidate)
      if (s.isFile()) return candidate
    } catch {
      // 继续找下一个项目目录
    }
  }
  return undefined
}

/**
 * 定位某工人本次运行的会话流水文件。
 *
 * @param {string} worker
 * @param {object} params
 * @param {string|undefined} params.storeRoot
 * @param {string|undefined} params.conversationId
 * @param {string} [params.cwd]
 * @returns {Promise<string|undefined>}
 */
export async function resolveTranscriptPath(worker, { storeRoot, conversationId, cwd }) {
  for (const candidate of transcriptCandidates(worker, { storeRoot, conversationId, cwd })) {
    try {
      const s = await stat(candidate)
      if (s.isFile()) return candidate
    } catch {
      // 试下一个候选
    }
  }
  if (worker === 'claude' && typeof storeRoot === 'string' && storeRoot !== '' && typeof conversationId === 'string' && conversationId !== '') {
    return searchSessionFile(storeRoot, `${conversationId}.jsonl`)
  }
  return undefined
}

/** @type {Map<string, {size: number, mtimeMs: number, value: object}>} */
const tailCache = new Map()

/**
 * 防御性副本：enforcePayloadBounds 会就地改写事件文本，不能污染缓存。
 *
 * @param {object} transcript
 * @returns {object}
 */
function cloneTranscript(transcript) {
  return {
    ...transcript,
    events: Array.isArray(transcript.events) ? transcript.events.map(e => ({ ...e })) : [],
  }
}

/**
 * 只读尾部读取会话流水。
 *
 * @param {string} worker
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.maxEvents]
 * @param {number} [options.maxChars]
 * @param {boolean} [options.cache] - 已结束的任务可走 (size, mtime) 缓存
 * @returns {Promise<object>}
 */
export async function readTranscriptTail(worker, filePath, { maxEvents = MAX_TRANSCRIPT_EVENTS, maxChars = MAX_EVENT_TEXT_CHARS, cache = false } = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { available: false, reason: '路径无效', events: [], step_index: null, step_total: 0 }
  }

  if (cache) {
    let size
    let mtimeMs
    try {
      const s = await stat(filePath)
      size = s.size
      mtimeMs = s.mtimeMs
    } catch {
      return readTranscriptTail(worker, filePath, { maxEvents, maxChars, cache: false })
    }
    const hit = tailCache.get(filePath)
    if (hit !== undefined && hit.size === size && hit.mtimeMs === mtimeMs) {
      tailCache.delete(filePath)
      tailCache.set(filePath, hit)
      return cloneTranscript(hit.value)
    }
    const value = await readTranscriptTail(worker, filePath, { maxEvents, maxChars, cache: false })
    tailCache.delete(filePath)
    tailCache.set(filePath, { size, mtimeMs, value })
    while (tailCache.size > TAIL_CACHE_MAX_ENTRIES) {
      const oldest = tailCache.keys().next().value
      tailCache.delete(oldest)
    }
    return cloneTranscript(value)
  }

  let fileHandle
  try {
    fileHandle = await open(filePath, 'r')
    const fileStat = await fileHandle.stat()
    const size = fileStat.size
    if (size === 0) {
      return { available: true, events: [], step_index: null, step_total: 0, path: filePath }
    }

    const readLen = Math.min(size, TAIL_READ_BYTES)
    const position = size - readLen
    const buffer = Buffer.alloc(readLen)
    const { bytesRead } = await fileHandle.read(buffer, 0, readLen, position)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const summary = summarizeTranscriptText(worker, text, { maxEvents, maxChars })
    return { ...summary, path: filePath }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      events: [],
      step_index: null,
      step_total: 0,
      path: filePath,
    }
  } finally {
    if (fileHandle !== undefined) await fileHandle.close().catch(() => {})
  }
}

/**
 * 清空尾部读取缓存（测试与「显示全部」强制刷新用）。
 */
export function clearTranscriptCache() {
  tailCache.clear()
}
