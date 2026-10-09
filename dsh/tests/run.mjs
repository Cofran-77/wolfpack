/**
 * 狼群模式统一测试运行器。
 *
 *   node tests/run.mjs
 *
 * 自动将源码、依赖与测试文件暂存到 staging 目录中执行，
 * 验证宿主无关核与各宿主适配器。
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const libDir = join(pluginRoot, 'lib')
const binDir = join(pluginRoot, 'bin')

/** staging 根下的暂存目录名。 */
export const STAGING_DIRNAME = 'wptest'

/** 覆盖开关名。 */
export const STAGING_ROOT_ENV = 'WP_TEST_HOME'

/** 解析 staging 根时的错误文案（找不到任何可用根时用）。 */
const NO_ROOT_MESSAGE = `run.mjs: 需要 DSH_HOME（测试依赖 $DSH_HOME/profiles/node_modules 的包解析），`
  + `或显式设置覆盖开关 ${STAGING_ROOT_ENV}=<可写目录>`

/**
 * 判定路径是否存在。
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 staging 根。
 *
 * 覆盖开关 `WP_TEST_HOME` 优先；未设置时回退 `$DSH_HOME`。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ok: true, root: string, source: string} | {ok: false, reason: string}}
 */
export function resolveStagingRoot(env = process.env) {
  const override = env[STAGING_ROOT_ENV]
  if (typeof override === 'string' && override.trim() !== '') {
    return { ok: true, root: resolve(override.trim()), source: STAGING_ROOT_ENV }
  }
  const dshHome = env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome !== '') {
    return { ok: true, root: resolve(dshHome), source: 'DSH_HOME' }
  }
  return { ok: false, reason: NO_ROOT_MESSAGE }
}

/**
 * 依赖源候选链。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} 候选目录，按优先级排列
 */
export function depsSourceCandidates(env = process.env) {
  const candidates = []
  const addDshHome = value => {
    if (typeof value !== 'string' || value.trim() === '') return
    candidates.push(join(resolve(value.trim()), 'profiles', 'node_modules'))
  }
  const addUserHome = value => {
    if (typeof value !== 'string' || value.trim() === '') return
    candidates.push(join(resolve(value.trim()), '.dsh', 'profiles', 'node_modules'))
  }
  addDshHome(env.DSH_HOME)
  addUserHome(env.USERPROFILE)
  addUserHome(env.HOME)
  return candidates
}

/**
 * 保证 staging 根下有 `profiles/node_modules`。
 *
 * @param {string} root - staging 根
 * @param {Record<string, string|undefined>} [env]
 * @returns {Promise<{ok: true, action: 'present'|'junction'|'copy', path: string, source?: string} | {ok: false, reason: string}>}
 */
export async function ensurePeerModules(root, env = process.env) {
  const target = join(root, 'profiles', 'node_modules')
  if (await exists(target)) return { ok: true, action: 'present', path: target }

  const candidates = depsSourceCandidates(env)

  let source
  for (const candidate of candidates) {
    if (candidate === target) continue
    if (await exists(candidate)) {
      source = candidate
      break
    }
  }
  if (source === undefined) {
    return {
      ok: false,
      reason: `run.mjs: ${root} 下没有 profiles/node_modules，也找不到可链接的源`
        + `（试过：${candidates.concat(target).join('、')}）。`
        + '请设置 DSH_HOME 指向已安装 peer 依赖的 DSH 主目录。',
    }
  }

  await mkdir(join(root, 'profiles'), { recursive: true })
  const linked = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'mklink', '/J', target, source], { stdio: 'ignore' })
    : spawnSync('ln', ['-s', source, target], { stdio: 'ignore' })
  if (linked.status === 0 && await exists(target)) return { ok: true, action: 'junction', path: target, source }

  try {
    await cp(source, target, { recursive: true })
    return { ok: true, action: 'copy', path: target, source }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `run.mjs: 在 ${target} 建 junction 与复制都失败：${detail}` }
  }
}

/** 少一个就一条 host 用例都跑不到的 peer 依赖。 */
export const PEER_PACKAGES = [
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

/**
 * 验证 peer 依赖真的解析得到。
 *
 * @param {string} staging
 * @returns {{ok: true, resolved: Record<string, string>} | {ok: false, reason: string}}
 */
export function verifyPeerResolution(staging) {
  const require = createRequire(join(staging, 'resolve-probe.cjs'))
  const resolved = {}
  const missing = []
  for (const name of PEER_PACKAGES) {
    try {
      resolved[name] = require.resolve(name)
    } catch {
      missing.push(name)
    }
  }
  if (missing.length === 0) return { ok: true, resolved }

    return {
      ok: false,
      reason: `run.mjs: staging 根的 profiles/node_modules 无法解析 ${missing.join('、')}。`
        + `依赖解析起点：${staging}（Node 从它向上找 node_modules）。`
        + `请把 ${STAGING_ROOT_ENV} 指到一个可写根（脚本会自动从真 DSH_HOME 建目录 junction），`
        + `或确认 DSH_HOME 下的 profiles/node_modules 里确实装了这些 peer 依赖。`,
    }
  }

/**
 * 跑测试。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  // 直接运行时若未指定环境，自动回退到系统临时目录作为安全的 staging 根
  if (!process.env[STAGING_ROOT_ENV] && !process.env.DSH_HOME) {
    process.env[STAGING_ROOT_ENV] = join(tmpdir(), 'wolfpack-staging-root')
  }

  const resolvedRoot = resolveStagingRoot()
  if (!resolvedRoot.ok) {
    console.error(resolvedRoot.reason)
    return 2
  }
  const root = resolvedRoot.root
  const staging = join(root, 'profiles', STAGING_DIRNAME)

  const peers = await ensurePeerModules(root)
  if (!peers.ok) {
    console.error(peers.reason)
    return 2
  }
  if (peers.action !== 'present') {
    console.log(`run.mjs: ${root} 下缺 profiles/node_modules，已用${peers.action === 'junction' ? '目录 junction' : '复制'}补上`)
  }

  const suites = [
    'wolfpack.test.mjs',
    'config-volatile.test.mjs',
    'tool-schema.test.mjs',
    'client.test.mjs',
    'worker-health.test.mjs',
    'claude-worker.test.mjs',
    'worker-selection.test.mjs',
  ]

  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  const resolution = verifyPeerResolution(staging)
  if (!resolution.ok) {
    console.error(resolution.reason)
    return 2
  }

  // 复制 lib 整个目录（包括 runtime 与 core 子目录）
  await cp(libDir, staging, { recursive: true })
  // 复制 bin 目录供 CLI/MCP 跨壳用例使用
  await cp(binDir, join(staging, 'bin'), { recursive: true })

  // run.mjs 自己进 staging
  await cp(fileURLToPath(import.meta.url), join(staging, 'run.mjs'))
  for (const suite of suites) {
    await cp(join(here, suite), join(staging, suite))
  }

  let failed = 0
  for (const suite of suites) {
    console.log(`\n═══ ${suite} ═══`)
    const code = await new Promise(resolveCode => {
      const child = spawn(process.execPath, [join(staging, suite)], { stdio: 'inherit', cwd: staging })
      child.on('exit', code => resolveCode(code ?? 1))
    })
    if (code !== 0) failed += 1
  }

  if (failed === 0) {
    await rm(staging, { recursive: true, force: true })
    console.log('\n全部通过')
  } else {
    console.error(`\nrun.mjs: ${failed} 个测试文件失败，现场保留在 ${staging}`)
  }
  return failed === 0 ? 0 : 1
}

const invokedDirectly = (() => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return pathToFileURL(resolve(invoked)).href.toLowerCase() === import.meta.url.toLowerCase()
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.exit(await main())
}
