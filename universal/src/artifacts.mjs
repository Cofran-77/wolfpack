import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Bounded local fallback; never follow symlinks or report a partial scan as complete.
export async function filesystemSnapshot(cwd, { maxFiles = 10000, excludePaths = [] } = {}) {
  const files = new Map()
  const excluded = excludePaths.filter(Boolean).map(path => resolve(path))
  let visited = 0
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > maxFiles) throw new Error('snapshot limit exceeded')
      const path = join(dir, entry.name)
      const absolute = resolve(path)
      if (excluded.some(root => absolute === root || absolute.startsWith(root + '/')) ||
          excluded.some(root => absolute.startsWith(root + '\\'))) continue
      const name = prefix + entry.name
      if (entry.isDirectory()) {
        if (!['.git', '.wolfpack', '.dsh', 'node_modules'].includes(entry.name)) await walk(path, name + '/')
      } else if (entry.isFile()) {
        const info = await stat(path)
        files.set(name, `${info.size}:${info.mtimeMs}`)
      }
    }
  }
  try { await walk(cwd); return { isGit: false, filesystem: files } }
  catch { return { isGit: false, files: new Set() } }
}
