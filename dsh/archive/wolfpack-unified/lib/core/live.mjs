import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripBom } from './config.mjs'

/**
 * 检查指定 PID 的进程是否仍存活。
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * 获取任务的活运行登记文件路径。
 *
 * @param {string} rawDir
 * @param {string} taskId
 * @returns {string}
 */
export function getLiveRecordPath(rawDir, taskId) {
  const safeId = String(taskId).replace(/[\\/:*?"<>|]/g, '_')
  return join(rawDir, 'live', `${safeId}.json`)
}

/**
 * 读取任务的活运行登记。
 *
 * @param {string} rawDir
 * @param {string} taskId
 * @returns {Promise<Record<string, any>|undefined>}
 */
export async function readLiveRecord(rawDir, taskId) {
  if (!rawDir || !taskId) return undefined
  const filePath = getLiveRecordPath(rawDir, taskId)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(stripBom(raw))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 写入或更新活运行登记文件。
 *
 * @param {string} rawDir
 * @param {string} taskId
 * @param {Record<string, any>} record
 * @returns {Promise<void>}
 */
export async function writeLiveRecord(rawDir, taskId, record) {
  if (!rawDir || !taskId || !record) return
  const dir = join(rawDir, 'live')
  await mkdir(dir, { recursive: true })
  const filePath = getLiveRecordPath(rawDir, taskId)
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
}

/**
 * 删除活运行登记文件。
 *
 * @param {string} rawDir
 * @param {string} taskId
 * @returns {Promise<void>}
 */
export async function removeLiveRecord(rawDir, taskId) {
  if (!rawDir || !taskId) return
  const filePath = getLiveRecordPath(rawDir, taskId)
  try {
    await rm(filePath, { force: true })
  } catch {}
}

/**
 * 列出所有活运行登记（自动清理孤儿或已退出进程的登记）。
 *
 * @param {string} rawDir
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function listLiveRecords(rawDir) {
  if (!rawDir) return []
  const dir = join(rawDir, 'live')
  try {
    const files = await readdir(dir)
    const records = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const filePath = join(dir, f)
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = JSON.parse(stripBom(raw))
        if (parsed && typeof parsed === 'object') {
          records.push(parsed)
        }
      } catch {}
    }
    return records
  } catch {
    return []
  }
}
