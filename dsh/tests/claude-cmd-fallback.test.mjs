/**
 * 回归测试：npm 全局安装的 Claude Code（只有 claude.cmd、没有 claude.exe）
 * 在 Windows 上的可探测性与可启动性不变式守卫。
 *
 * 铁律：
 * 1. 假工人由测试在临时目录创建并回显参数，绝不依赖本机真实安装的 Claude Code，绝不联网/下载；
 * 2. 覆盖 findInPath 扩展名回退、isWorkerAvailable 判定、roster 登记表状态、buildArgv 实际可启动性；
 * 3. 覆盖 win32 的 .cmd 包装与绝对路径 .exe 不被包装；非 win32 平台按平台自适应；
 * 4. 测试结束后完全恢复 PATH 环境变量并删除临时目录。
 */

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const getMod = (rel) => {
  const p = existsSync(join(here, rel)) ? join(here, rel) : join(here, '..', 'lib', rel)
  return import(pathToFileURL(p).href)
}

const { createNodeRuntime } = await getMod('runtime/node.mjs')
const { loadConfig } = await getMod('core/config.mjs')
const { claudeWorker } = await getMod('core/worker/claude.mjs')
const { findInPath, isWorkerAvailable } = await getMod('core/worker/index.mjs')
const { buildWorkerRoster } = await getMod('core/worker/roster.mjs')

let pass = 0
let fail = 0

const t = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

const ta = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

console.log('\nClaude Code npm 全局安装（claude.cmd）回退与可启动性回归测试')

const isWin = process.platform === 'win32'
const origPath = process.env.PATH
const origPathAlt = process.env.Path
const origPathext = process.env.PATHEXT

// 创建测试用独立临时目录作为隔离 PATH
const T = join(tmpdir(), `wp-claude-cmd-test-${Date.now()}`)
mkdirSync(T, { recursive: true })

const CLAUDE_CMD = join(T, 'claude.cmd')
const CLAUDE_SH = join(T, 'claude')
const AGY_BIN = join(T, isWin ? 'agy.exe' : 'agy')

if (isWin) {
  // Windows: 只有 claude.cmd，绝不创建 claude.exe
  writeFileSync(CLAUDE_CMD, '@echo off\r\necho WP-CLAUDE-STUB %*\r\n', 'utf8')
} else {
  // 非 Windows: 创建可执行 shell 脚本
  writeFileSync(CLAUDE_SH, '#!/bin/sh\necho "WP-CLAUDE-STUB $@"\n', { mode: 0o755 })
}

try {
  copyFileSync(process.execPath, AGY_BIN)
} catch {
  writeFileSync(AGY_BIN, 'stub', 'utf8')
}

const fakeEnv = {
  ...process.env,
  PATH: T,
  Path: T,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  WOLFPACK_CLAUDE: '',
  WOLFPACK_AGY: '',
  WOLFPACK_WORKERS_ENABLED: '',
}

try {
  // 1. findInPath 探测与扩展名回退
  t('1.1 裸名 claude 能在假 PATH 中找到', () => {
    const hit = findInPath('claude', fakeEnv)
    assert.equal(typeof hit, 'string', 'hit 必须为字符串路径')
    if (isWin) {
      assert.ok(hit.toLowerCase().endsWith('claude.cmd'), `必须解析到 claude.cmd: ${hit}`)
    } else {
      assert.ok(hit.endsWith('claude'), `必须解析到 claude: ${hit}`)
    }
  })

  t('1.2 win32 下 claude.exe 未找到时自动回退到 claude.cmd', () => {
    if (isWin) {
      const hit = findInPath('claude.exe', fakeEnv)
      assert.equal(typeof hit, 'string', 'claude.exe 找不到时必须回退到 claude.cmd')
      assert.ok(hit.toLowerCase().endsWith('claude.cmd'), `回退目标必须是 claude.cmd: ${hit}`)
    } else {
      // 非 win32 平台不走 .exe 回退，断言安全
      assert.ok(true)
    }
  })

  t('1.3 未安装的工人（gemini / gemini.exe）必须返回 undefined', () => {
    assert.equal(findInPath('gemini', fakeEnv), undefined)
    assert.equal(findInPath('gemini.exe', fakeEnv), undefined)
  })

  // 2. isWorkerAvailable 判定
  t('2.1 isWorkerAvailable(claude) 在只有 claude.cmd 时判定为 true', () => {
    const cfg = loadConfig({}, here, fakeEnv)
    const claudeOk = isWorkerAvailable('claude', cfg, { env: fakeEnv, find: findInPath })
    assert.equal(claudeOk, true, 'claude 必须被判定为可用')
  })

  t('2.2 isWorkerAvailable(gemini) 对未安装工人必须保持 false', () => {
    const cfg = loadConfig({}, here, fakeEnv)
    const geminiOk = isWorkerAvailable('gemini', cfg, { env: fakeEnv, find: findInPath })
    assert.equal(geminiOk, false, '未安装工人绝不能误判为可用')
  })

  // 3. buildWorkerRoster 登记表状态
  t('3.1 buildWorkerRoster 在隔离 PATH 下 claude installed=true，gemini installed=false', () => {
    const savedPath = process.env.PATH
    const savedPathAlt = process.env.Path
    process.env.PATH = T
    if (isWin) process.env.Path = T

    try {
      const roster = buildWorkerRoster()
      const claude = roster.find(w => w.name === 'claude')
      const agy = roster.find(w => w.name === 'agy')
      const gemini = roster.find(w => w.name === 'gemini')

      assert.equal(claude?.installed, true, 'claude 必须在登记表中显示为 installed=true')
      assert.equal(agy?.installed, true, 'agy 必须在登记表中显示为 installed=true')
      assert.equal(gemini?.installed, false, 'gemini 必须在登记表中显示为 installed=false')
    } finally {
      process.env.PATH = savedPath
      if (savedPathAlt !== undefined) process.env.Path = savedPathAlt
    }
  })

  // 4. claudeWorker.buildArgv 实际可启动性验证
  const rt = createNodeRuntime()

  await ta('4.1 buildArgv 返回的 argv 能被 runtime 实际执行且原样透传带空格参数', async () => {
    const cfg = { ...loadConfig({}, here, fakeEnv), claudePath: 'claude' }
    const argv = claudeWorker.buildArgv(cfg, { task: 'REGRESSION TASK ONE', timeoutMs: 20000 })

    if (isWin) {
      assert.ok(argv[0].toLowerCase().endsWith('cmd.exe'), `win32 .cmd 必须由 cmd.exe 包装: ${argv[0]}`)
      assert.ok(argv.includes('/c'), '必须包含 /c 开关')
    }

    process.env.PATH = T
    if (isWin) process.env.Path = T
    try {
      const proc = rt.spawn({ argv, cwd: T, graceMs: 15000 })
      const outcome = await proc.done
      const out = proc.collected.stdout.readFrom(0).text

      assert.equal(outcome.exitCode, 0, `进程执行退出码必须为 0 (stderr=${proc.collected.stderr.readFrom(0).text})`)
      assert.ok(out.includes('WP-CLAUDE-STUB'), 'stdout 必须包含假工人标头')
      assert.ok(out.includes('--output-format'), 'stdout 必须包含输出格式参数')
      assert.ok(out.includes('REGRESSION TASK ONE'), '带空格的任务参数必须原样传递')
    } finally {
      process.env.PATH = origPath
      if (origPathAlt !== undefined) process.env.Path = origPathAlt
    }
  })

  await ta('4.2 旧配置 claudePath=claude.exe 在 win32 下同样可启动（回退 .cmd）', async () => {
    if (!isWin) return

    const cfg = { ...loadConfig({}, here, fakeEnv), claudePath: 'claude.exe' }
    const argv = claudeWorker.buildArgv(cfg, { task: 'REGRESSION-TASK2', timeoutMs: 20000 })

    process.env.PATH = T
    process.env.Path = T
    try {
      const proc = rt.spawn({ argv, cwd: T, graceMs: 15000 })
      const outcome = await proc.done
      const out = proc.collected.stdout.readFrom(0).text

      assert.equal(outcome.exitCode, 0, 'exitCode 必须为 0')
      assert.ok(out.includes('WP-CLAUDE-STUB'), 'stdout 必须包含假工人回显')
    } finally {
      process.env.PATH = origPath
      if (origPathAlt !== undefined) process.env.Path = origPathAlt
    }
  })

  await ta('4.3 绝对路径 .exe 原样返回，不被 cmd 包裹', async () => {
    const argv = claudeWorker.buildArgv({ claudePath: process.execPath }, { task: 'x', timeoutMs: 20000 })
    assert.equal(argv[0], process.execPath, '绝对路径 .exe 必须作为 argv[0] 原样返回')

    const proc = rt.spawn({ argv: [...argv.slice(0, 1), '--version'], cwd: T, graceMs: 15000 })
    const outcome = await proc.done
    const out = proc.collected.stdout.readFrom(0).text.trim()

    assert.equal(outcome.exitCode, 0, 'node --version 必须 exit 0')
    assert.match(out, /^v\d/, '必须输出版本号')
  })
} finally {
  // 恢复环境与清理临时目录
  process.env.PATH = origPath
  if (origPathAlt !== undefined) process.env.Path = origPathAlt
  if (origPathext !== undefined) process.env.PATHEXT = origPathext
  try {
    rmSync(T, { recursive: true, force: true })
  } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  process.exit(1)
}
