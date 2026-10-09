/**
 * 0.2.0 设置契约：开关是插件自己的 volatile Config，不再是 settings 服务。
 *
 * 这份套件锁住三件事：
 *   1. `Config.enabled` 标了 `.volatile()`，解析后是引用（`.get()`）；
 *   2. `apply(ctx, config)` 从配置读开关，`inject` 不再依赖 `settings` 服务；
 *   3. 开关翻转走 `loader/volatile-update` 事件——挂载与摘除都在同一次运行内完成，
 *      不需要重启宿主，也不会留下残余工具。
 *
 * 与 wolfpack.test.mjs 同样放在 $DSH_HOME/profiles/ 下，因此这里解析到的是
 * 真的 schemastery / defineTool，不是 stub。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as liveRoute from './live-route.js'

const here = dirname(fileURLToPath(import.meta.url))

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

/* ── 假宿主 ────────────────────────────────────────────────────────── */

/** 只记录注册与注销的工具注册表；mount() 的 disposer 会把它清空。 */
function toolsRegistry() {
  const entries = new Map()
  return {
    entries,
    register(definition) {
      entries.set(definition.name, definition)
      return () => { entries.delete(definition.name) }
    },
    names() { return [...entries.keys()].sort() },
  }
}

/**
 * 造一个够 apply() 用的 ctx。
 *
 * @param {object} tools - toolsRegistry()
 * @param {object} opts - `listeners` 收集 volatile 事件监听器
 */
function makeCtx(tools, opts = {}) {
  const listeners = opts.listeners ?? []
  const sections = []
  return {
    listeners,
    sections,
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subprocess') return { spawn: () => { throw new Error('测试不得启动进程') } }
      if (name === 'subagents') return { registerProvider: () => ({ dispose() {} }) }
      return undefined
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => { sections.length = 0 }
      },
    },
    on(event, callback) {
      if (event === 'loader/volatile-update') listeners.push(callback)
      return () => {
        const index = listeners.indexOf(callback)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }
}

/** 触发一次 volatile 配置更新，等价于设置面板写入后的 loader 通知。 */
function fireVolatile(ctx) {
  for (const listener of [...ctx.listeners]) listener([])
}

const previousAgy = process.env.WOLFPACK_AGY
// 预检失败不影响挂载（工具仍注册），但指向一个不存在的路径可以避免任何真实查找。
process.env.WOLFPACK_AGY = process.env.WOLFPACK_AGY ?? 'wolfpack-not-installed-test-agy.exe'
const indexMod = await import('./index.js')
if (previousAgy === undefined) delete process.env.WOLFPACK_AGY
else process.env.WOLFPACK_AGY = previousAgy

console.log('\nX. 0.2.0 设置契约（volatile Config）')

t('X-a: inject 只声明 systemPrompt，不再依赖 settings 服务', () => {
  assert.ok(Array.isArray(indexMod.inject), 'inject 必须是数组')
  assert.ok(indexMod.inject.includes('systemPrompt'), 'systemPrompt 是硬依赖')
  assert.ok(!indexMod.inject.includes('settings'), 'settings 服务在 0.2.0 已不是开关的载体')
})

t('X-b: Config.enabled 是 volatile 字段——解析得到引用，默认 false', () => {
  const parsed = indexMod.Config({ })
  assert.equal(typeof parsed.enabled?.get, 'function', 'volatile 字段必须是 .get() 引用')
  assert.equal(parsed.enabled.get(), false, '默认值必须是 false（狼群模式默认关）')

  const on = indexMod.Config({ enabled: true })
  assert.equal(on.enabled.get(), true, '显式开启必须读回 true')
})

t('X-c: 开关关闭时不注册任何工具，但登记了 volatile 更新监听', async () => {
  const tools = toolsRegistry()
  const listeners = []
  const ctx = makeCtx(tools, { listeners })
  indexMod.apply(ctx, { enabled: { get: () => false } })
  assert.deepEqual(tools.names(), [], '关闭时不得留下任何工具')
  assert.equal(listeners.length, 1, '必须监听 loader/volatile-update 才能就地响应开关')
})

await ta('X-d: 打开开关（volatile 事件）立即挂载四个工具，关掉立即摘除', async () => {
  const tools = toolsRegistry()
  const ctx = makeCtx(tools)
  let enabled = false
  indexMod.apply(ctx, { enabled: { get: () => enabled } })
  assert.deepEqual(tools.names(), [])

  enabled = true
  fireVolatile(ctx)
  assert.deepEqual(
    tools.names(),
    ['wolf_delegate', 'wolf_kill', 'wolf_status', 'wolf_team'],
    '打开后必须挂上四个工具',
  )

  enabled = false
  fireVolatile(ctx)
  assert.deepEqual(tools.names(), [], '关掉后必须整体摘除，不留残余工具')
})

t('X-e: 裸布尔配置（未包成引用）同样生效——避免将来加字段时静默失效', async () => {
  const tools = toolsRegistry()
  const ctx = makeCtx(tools)
  indexMod.apply(ctx, { enabled: true })
  assert.deepEqual(
    tools.names(),
    ['wolf_delegate', 'wolf_kill', 'wolf_status', 'wolf_team'],
  )
})

t('X-f: 队长指令 section 跟随开关，关闭时正文为空', () => {
  const tools = toolsRegistry()
  let enabled = false
  const ctx = makeCtx(tools)
  indexMod.apply(ctx, { enabled: { get: () => enabled } })

  const section = ctx.sections[0]
  assert.ok(section !== undefined, '必须注册队长指令 section')
  assert.equal(section.name, 'wolfpack', 'section 名必须是设置命名空间')
  assert.equal(section.text(), '', '关闭时不得注入任何指令')

  enabled = true
  const text = section.text()
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0, '开启时必须注入队长指令正文')
})

t('X-g: 缺 tools/subagents 服务时不抛，只降级（预检/服务缺失都不得挂掉宿主）', () => {
  const ctx = makeCtx(toolsRegistry())
  ctx.get = () => undefined
  indexMod.apply(ctx, { enabled: true })
})

t('X-h: 机械闸门：软获取的服务绝不做属性访问（0.2.0 会抛 without inject）', () => {
  // 0.2.0 的 cordis 对未在 inject 里声明的服务做属性访问会直接抛错：
  //   Error: cannot get property "subprocess" without inject
  // 本插件刻意软获取这些服务（缺服务时降级机制半、保住队长指令），
  // 所以源码里只允许 ctx.get('x')，以及白名单里的 cordis 核心成员与已注入服务。
  const libRoot = existsSync(join(here, 'index.js')) ? here : resolve(here, '..', 'lib')
  // systemPrompt 是唯一硬注入的服务（见 index.js 的 inject）；其余都是 cordis 核心成员。
  const allowed = new Set([
    'get', 'set', 'provide', 'inject', 'effect', 'on', 'once', 'off', 'emit',
    'parallel', 'waterfall', 'bail', 'start', 'stop', 'plugin', 'logger', 'fiber',
    'scope', 'reflect', 'root', 'systemPrompt', 'name', 'dispose', 'then', 'catch',
  ])
  const stripComments = source => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      // staging 根里同时躺着测试文件，它们造的假 ctx 不是被测对象。
      else if (/\.(js|mjs)$/.test(name) && !/\.test\.mjs$/.test(name) && name !== 'run.mjs') files.push(full)
    }
  }
  walk(libRoot)
  assert.ok(files.length >= 10, `必须扫到 lib 源码，实际 ${files.length} 个文件`)

  const offenders = []
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const match of code.matchAll(/\bctx\??\.([A-Za-z_$][\w$]*)/g)) {
      const member = match[1]
      if (allowed.has(member)) continue
      offenders.push(`${file.slice(libRoot.length)} -> ctx.${member}`)
    }
  }
  assert.deepEqual(offenders, [], `这些属性访问会在 0.2.0 挂载期抛错，必须改成 ctx.get(...)：\n${offenders.join('\n')}`)
})

t('X-i: live 路由用嵌套 inject 等服务就位（启动时拿不到 webServer 也能挂上）', () => {
  // 桌面端实测：插件挂载时 ctx.get('webServer') 还是 undefined（webserver 等 webStartup），
  // 一次性软获取会静默跳过 → /wolfpack/live 永远 404、右侧面板空着。
  const registered = []
  const scoped = {
    webServer: { register(definition) { registered.push(definition); return () => {} } },
    connection: { requestRejection: () => undefined },
  }
  let injected
  const ctx = {
    get: () => undefined, // 启动时确实拿不到
    inject(deps, callback) {
      injected = { deps, callback }
      return { dispose() {} }
    },
  }

  liveRoute.registerLiveRoute(ctx, {})
  assert.ok(injected, '必须通过 ctx.inject 等 webServer/connection，而不是只做一次 ctx.get')
  assert.deepEqual(injected.deps, ['webServer', 'connection'])
  assert.equal(registered.length, 0, '服务还没就位时不得假装挂载')

  injected.callback(scoped)
  assert.equal(registered.length, 1, '服务就位后必须把路由挂上')
  assert.equal(registered[0].path, '/wolfpack/live')
})

t('X-j: 服务始终不就位时只失去实时面板：不抛、不注册、可安全卸载', () => {
  const ctx = {
    get: () => undefined,
    inject: () => ({ dispose() {} }),
  }
  const dispose = liveRoute.registerLiveRoute(ctx, {})
  assert.equal(typeof dispose, 'function')
  dispose()
})

t('X-k: 老宿主（没有 ctx.inject）回退到一次性软获取，仍然能挂上', () => {
  const registered = []
  const ctx = {
    get: (name) => (name === 'webServer'
      ? { register(definition) { registered.push(definition); return () => {} } }
      : { requestRejection: () => undefined }),
  }
  const dispose = liveRoute.registerLiveRoute(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, '/wolfpack/live')
  dispose()
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
