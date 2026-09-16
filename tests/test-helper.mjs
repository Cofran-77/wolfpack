import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const projectRoot = join(__dirname, '..')
export const fakeWorkerPath = join(__dirname, 'fixtures', 'fake-worker.mjs')

export function createTempDir(prefix = 'wolf-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}
