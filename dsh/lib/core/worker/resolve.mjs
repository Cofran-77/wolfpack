/**
 * 工人可执行文件路径与 PATH/PATHEXT 解析（叶子模块）。
 *
 * 铁律：
 *   - 禁止 import 任何非 node: 模块（禁止 import index.mjs / claude.mjs / roster.mjs / config.mjs）；
 *   - 作为纯叶子模块，保证任何工人模块（如 claude.mjs）均可安全 import 而不引入循环依赖。
 */

import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/**
 * 在 PATH 中查找可执行文件。
 *
 * Windows 下特性：
 * 1. 裸名字按 PATHEXT 逐个尝试；
 * 2. 带扩展名的名字（如 claude.exe）在未找到时，支持回退到剥离扩展名后的候选（如 claude.cmd）；
 * 3. 包含路径分隔符的目标直接探测磁盘，并在未找到时做 win32 扩展名回退。
 *
 * @param {string} cmd
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {string|undefined}
 */
export function findInPath(cmd, env = process.env) {
  if (!cmd || typeof cmd !== 'string') return undefined
  const pathEnv = env.PATH || env.Path || process.env.PATH || process.env.Path || ''
  const isWin = process.platform === 'win32'
  const extensions = isWin
    ? (env.PATHEXT ? env.PATHEXT.split(';') : ['.exe', '.cmd', '.bat', '']).map(e => e.trim()).filter(Boolean)
    : ['']

  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    try {
      if (existsSync(cmd)) return cmd
      if (isWin) {
        let matchedExt = extensions.find(ext => ext && cmd.toLowerCase().endsWith(ext.toLowerCase()))
        if (!matchedExt) {
          const dotIdx = cmd.lastIndexOf('.')
          if (dotIdx > 0) matchedExt = cmd.slice(dotIdx)
        }
        if (matchedExt) {
          const stripped = cmd.slice(0, -matchedExt.length)
          if (stripped) {
            for (const e of extensions) {
              const candidate = `${stripped}${e}`
              if (existsSync(candidate)) return candidate
            }
          }
        }
      }
    } catch {}
    return undefined
  }

  const dirs = pathEnv.split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, cmd.toLowerCase().endsWith(ext.toLowerCase()) && ext !== '' ? cmd : `${cmd}${ext}`)
      try {
        if (existsSync(candidate)) return candidate
      } catch {}
    }
  }

  if (isWin) {
    let matchedExt = extensions.find(ext => ext && cmd.toLowerCase().endsWith(ext.toLowerCase()))
    if (!matchedExt) {
      const dotIdx = cmd.lastIndexOf('.')
      if (dotIdx > 0) matchedExt = cmd.slice(dotIdx)
    }
    if (matchedExt) {
      const stripped = cmd.slice(0, -matchedExt.length)
      if (stripped) {
        for (const dir of dirs) {
          if (!dir) continue
          for (const ext of extensions) {
            const candidate = join(dir, `${stripped}${ext}`)
            try {
              if (existsSync(candidate)) return candidate
            } catch {}
          }
        }
      }
    }
  }

  return undefined
}

/**
 * 默认可执行文件探测（纯文件系统存在性判断，不 spawn 子进程）。
 *
 * @param {string} bin
 * @returns {string|undefined}
 */
export function defaultFind(bin) {
  if (typeof bin !== 'string' || bin.trim() === '') return undefined
  const target = bin.trim()

  const isWin = process.platform === 'win32'
  const extensions = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim().toLowerCase()).filter(Boolean)
    : ['']

  // 若显式包含路径分隔符，直接验证文件是否存在
  if (target.includes('/') || target.includes('\\')) {
    try {
      if (existsSync(target)) return resolve(target)
      if (isWin) {
        let matchedExt = extensions.find(ext => target.toLowerCase().endsWith(ext))
        if (!matchedExt) {
          const dotIdx = target.lastIndexOf('.')
          if (dotIdx > 0) matchedExt = target.slice(dotIdx).toLowerCase()
        }
        if (matchedExt) {
          const stripped = target.slice(0, -matchedExt.length)
          for (const ext of extensions) {
            const candidate = stripped + ext
            if (existsSync(candidate)) return resolve(candidate)
          }
        }
      }
    } catch {
      // 忽略文件系统异常
    }
    return undefined
  }

  const pathEnv = process.env.PATH || process.env.Path || ''
  if (!pathEnv) return undefined

  const dirs = pathEnv.split(delimiter).map(d => d.trim()).filter(Boolean)
  const hasExt = isWin && extensions.some(ext => target.toLowerCase().endsWith(ext))

  for (const dir of dirs) {
    if (hasExt || !isWin) {
      const candidate = join(dir, target)
      try {
        if (existsSync(candidate)) return candidate
      } catch {}
    } else {
      const plain = join(dir, target)
      try {
        if (existsSync(plain)) return plain
      } catch {}
      for (const ext of extensions) {
        const candidate = join(dir, target + ext)
        try {
          if (existsSync(candidate)) return candidate
        } catch {}
      }
    }
  }

  // 如果带扩展名在 win32 上未找到，回退：剥离扩展名重新按 PATHEXT 搜索
  if (isWin) {
    let matchedExt = extensions.find(ext => target.toLowerCase().endsWith(ext))
    if (!matchedExt) {
      const dotIdx = target.lastIndexOf('.')
      if (dotIdx > 0) matchedExt = target.slice(dotIdx).toLowerCase()
    }
    if (matchedExt) {
      const stripped = target.slice(0, -matchedExt.length)
      if (stripped) {
        for (const dir of dirs) {
          const plain = join(dir, stripped)
          try {
            if (existsSync(plain)) return plain
          } catch {}
          for (const ext of extensions) {
            const candidate = join(dir, stripped + ext)
            try {
              if (existsSync(candidate)) return candidate
            } catch {}
          }
        }
      }
    }
  }

  return undefined
}
