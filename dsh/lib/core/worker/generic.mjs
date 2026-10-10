import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { findInPath } from './index.mjs'
import { reconcileClaimedArtifacts, truncateChars, DIGEST_MAX_CHARS } from './agy.mjs'
import { matchCapacity } from './faults.mjs'

/**
 * 从声明式规格对象创建统一的工人适配器实例。
 *
 * @param {object} spec
 * @returns {object} 工人适配器对象
 */
export function createWorkerFromSpec(spec) {
  if (!spec || typeof spec.name !== 'string') {
    throw new Error('[wolfpack/worker] 规格对象必须包含有效的 name')
  }

  return {
    name: spec.name,
    label: spec.label || spec.name,
    vendor: spec.vendor || '',
    spec,

    preflight(config, { env = process.env, find = findInPath } = {}) {
      if (spec.contract !== 'documented') {
        const nameUpper = spec.name.toUpperCase().replace(/-/g, '_')
        return {
          ok: false,
          path: '',
          reason: `该 CLI 调用契约未核实（本仓库未实测，官方文档亦无原文），请先用 WOLFPACK_${nameUpper}_... 覆盖或自行核对官方文档`,
        }
      }

      if (spec.prompt === 'stdin') {
        return {
          ok: false,
          path: '',
          reason: '该 CLI 的任务书只能走 stdin，当前 spawn 层（lib/core/spawn.mjs）只支持 stdin:"ignore"',
        }
      }

      const rawVal = config?.[`${spec.name}Path`] || spec.bin
      if (!rawVal || (typeof rawVal !== 'string' && !Array.isArray(rawVal))) {
        return { ok: false, path: '', reason: `${spec.name} 路径为空` }
      }

      if (Array.isArray(rawVal)) {
        const head = rawVal[0]
        if (typeof head === 'string' && existsSync(head)) {
          return { ok: true, path: head }
        }
        return {
          ok: false,
          path: String(head),
          reason: `未找到可执行文件或在 PATH 中未找到（配置值: ${JSON.stringify(rawVal)}）`,
        }
      }

      const target = rawVal.trim()
      if (isAbsolute(target) || target.includes('/') || target.includes('\\')) {
        if (existsSync(target)) {
          return { ok: true, path: target }
        }
        return {
          ok: false,
          path: target,
          reason: `未找到可执行文件或在 PATH 中未找到（配置值: ${target}）`,
        }
      }

      const hit = find(target, env)
      if (typeof hit === 'string' && hit !== '') {
        return { ok: true, path: hit }
      }

      if (target === spec.bin && Array.isArray(spec.binAliases)) {
        for (const alias of spec.binAliases) {
          const aliasHit = find(alias, env)
          if (typeof aliasHit === 'string' && aliasHit !== '') {
            return { ok: true, path: aliasHit }
          }
        }
      }

      return {
        ok: false,
        path: target,
        reason: `未找到可执行文件或在 PATH 中未找到（配置值: ${target}）`,
      }
    },

    buildArgv(config, { task, sessionId, timeoutMs, env = process.env, find = findInPath } = {}) {
      let rawBin = config?.[`${spec.name}Path`] || spec.bin
      if (rawBin === spec.bin && Array.isArray(spec.binAliases)) {
        if (!find(spec.bin, env)) {
          for (const alias of spec.binAliases) {
            if (find(alias, env)) {
              rawBin = alias
              break
            }
          }
        }
      }
      const bin = Array.isArray(rawBin)
        ? rawBin
        : (typeof rawBin === 'string' && (rawBin.endsWith('.mjs') || rawBin.endsWith('.js'))
            ? [process.execPath, rawBin]
            : [rawBin])

      if (sessionId && typeof spec.resumeArgv === 'function') {
        const sub = spec.resumeArgv(spec, { task, sessionId })
        return [...bin, ...sub]
      }

      if (typeof spec.argv === 'function') {
        const model = config?.[`${spec.name}Model`] ?? config?.model
        const autoApprove = config?.[`${spec.name}AutoApprove`] !== false
        const sub = spec.argv(spec, { task, sessionId, model, autoApprove })
        return [...bin, ...sub]
      }

      return [...bin, task]
    },

    extractSessionId(stdout) {
      if (typeof stdout !== 'string') return undefined
      if (spec.output === 'json') {
        try {
          const parsed = JSON.parse(stdout)
          if (typeof spec.extractSessionId === 'function') {
            return spec.extractSessionId(parsed)
          }
        } catch {
          return undefined
        }
      } else if (spec.output === 'jsonl') {
        const lines = stdout.split('\n')
        const events = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            events.push(JSON.parse(trimmed))
          } catch {}
        }
        if (typeof spec.extractSessionId === 'function') {
          return spec.extractSessionId(events)
        }
      }
      return undefined
    },

    parse(stdout) {
      if (typeof stdout !== 'string') return undefined

      if (spec.output === 'json') {
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {
          return undefined
        }
        const finalText = typeof spec.extractFinalText === 'function' ? spec.extractFinalText(parsed) : undefined
        const sessionId = typeof spec.extractSessionId === 'function' ? spec.extractSessionId(parsed) : undefined
        const usage = typeof spec.extractUsage === 'function' ? spec.extractUsage(parsed) : undefined
        const error = typeof spec.extractError === 'function' ? spec.extractError(parsed) : undefined
        return {
          finalText,
          sessionId,
          usage,
          error,
          raw: parsed,
          response: finalText,
        }
      }

      if (spec.output === 'jsonl') {
        const lines = stdout.split('\n')
        const events = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            events.push(JSON.parse(trimmed))
          } catch {}
        }
        const finalText = typeof spec.extractFinalText === 'function' ? spec.extractFinalText(events) : undefined
        const sessionId = typeof spec.extractSessionId === 'function' ? spec.extractSessionId(events) : undefined
        const usage = typeof spec.extractUsage === 'function' ? spec.extractUsage(events) : undefined
        const error = typeof spec.extractError === 'function' ? spec.extractError(events) : undefined
        return {
          finalText,
          sessionId,
          usage,
          error,
          raw: events,
          response: finalText,
        }
      }

      // text output
      const finalText = stdout.slice(-4000)
      return {
        finalText,
        sessionId: undefined,
        usage: undefined,
        error: undefined,
        raw: stdout,
        response: finalText,
      }
    },

    classify({ parsed, exitCode, artifacts, timedOut, cancelled, signal, raw, stderr }) {
      const root = artifacts?.root ?? artifacts?.cwd
      const claimedFiles = Array.isArray(parsed?.claimedFiles) ? parsed.claimedFiles : undefined
      const reconciliation = reconcileClaimedArtifacts(claimedFiles, artifacts, root)

      const bodyText = parsed?.finalText || parsed?.response || ''
      const digest = bodyText === '' ? [] : [{ type: 'text', text: truncateChars(bodyText, DIGEST_MAX_CHARS) }]

      if (cancelled || timedOut) {
        return {
          output: digest,
          stopReason: 'aborted',
          diagnostic: timedOut ? `${spec.name} 超时，已终止进程树` : '委派被取消',
          report: bodyText,
          rawParsed: parsed,
          claimedFiles,
          reconciliation,
        }
      }

      const probes = []
      if (typeof parsed?.error === 'string') probes.push(parsed.error)
      if (typeof bodyText === 'string') probes.push(bodyText.slice(0, 500))
      if (typeof stderr === 'string') probes.push(stderr.slice(0, 2000))
      if (typeof raw === 'string') probes.push(raw.slice(0, 2000))

      if (matchCapacity({ texts: probes })) {
        return {
          output: digest,
          stopReason: 'capacity',
          capacity: true,
          diagnostic: `${spec.name} 报服务端容量不足：${parsed?.error || '服务端暂无可用容量'}`,
          report: bodyText,
          rawParsed: parsed,
          claimedFiles,
          reconciliation,
        }
      }

      const hasArtifacts = Array.isArray(artifacts)
        ? artifacts.length > 0
        : Boolean(artifacts?.changed || (Array.isArray(artifacts?.files) && artifacts.files.length > 0))

      if (hasArtifacts) {
        return {
          output: digest,
          stopReason: 'completed',
          diagnostic: (exitCode !== 0 || parsed?.error)
            ? `${spec.name} 自报 exit ${exitCode}，但检测到磁盘产物`
            : undefined,
          report: bodyText,
          rawParsed: parsed,
          claimedFiles,
          reconciliation,
        }
      }

      if (exitCode === 0 && !parsed?.error) {
        return {
          output: digest,
          stopReason: 'completed',
          diagnostic: undefined,
          report: bodyText,
          rawParsed: parsed,
          claimedFiles,
          reconciliation,
        }
      }

      const rawFallback = typeof raw === 'string' && raw.trim() !== '' ? truncateChars(raw.trim(), DIGEST_MAX_CHARS) : ''
      const errorDetail = parsed?.error || rawFallback || '未知错误详情'

      return {
        output: digest,
        stopReason: 'error',
        diagnostic: `${spec.name} exit ${exitCode}: ${errorDetail}`,
        report: bodyText,
        rawParsed: parsed,
        claimedFiles,
        reconciliation,
      }
    },

    progressProbe() {
      return undefined
    },
  }
}
