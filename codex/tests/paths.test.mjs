import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { projectRoot } from './test-helper.mjs'

function getSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      files.push(...getSourceFiles(full))
    } else if (entry.endsWith('.mjs') || entry.endsWith('.js')) {
      files.push(full)
    }
  }
  return files
}

export const tests = [
  {
    name: 'no-absolute-paths',
    async run() {
      const targetDirs = [
        join(projectRoot, 'src'),
        join(projectRoot, 'bin'),
      ]

      const violations = []

      // 检测 Windows 盘符绝对路径（如 C:\ 或 D:/）以及 Unix 家目录绝对路径（如 /Users/ 或 /home/）
      const drivePattern = /(?:^|['"`\s=:(\[])[a-zA-Z]:[\\\/]/
      const homePattern = /\/(?:Users|home)\//

      for (const dir of targetDirs) {
        const files = getSourceFiles(dir)
        for (const file of files) {
          const content = readFileSync(file, 'utf8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (drivePattern.test(line) || homePattern.test(line)) {
              violations.push(`${file}:${i + 1} -> ${line.trim()}`)
            }
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `src/ 与 bin/ 中严禁硬编码盘符或家目录绝对路径！发现违规：\n${violations.join('\n')}`,
      )
    },
  },
]
