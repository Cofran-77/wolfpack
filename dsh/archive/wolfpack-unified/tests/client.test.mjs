/**
 * 客户端半边的验证（不需要浏览器）。
 *
 * `lib/client.js` 是给浏览器用的手写模块：它没有 import/export，只做一件事——
 * 调 `window.__ModuleLoader__.load({ id, factory })`。所以只要先把 window /
 * document / React 摆好，就能在 Node 里把它的 apply() 真正跑一遍。
 *
 * 为什么值得测：client.js 里的笔误不会在 host 测试里暴露，却会让**当前已经
 * 能用的**设置行一起消失。改 UI 的人最需要的就是这条安全网。
 *
 * 后半段是「外观契约」：把用户对开关的明确要求（默认完全融入界面、悬停才
 * 浮现、状态只由滑块表达）写成断言，防止下次改动又漂回「一块显眼的绿牌子」。
 */

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

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/* ── 摆好浏览器环境 ───────────────────────────────────────────────── */

const SNAPSHOT = {
  status: 'ready',
  value: { enabled: true },
  base: { enabled: false },
  user: { enabled: true },
  revision: 3,
  writable: true,
  mode: 'user',
}

const created = []
const FakeReact = {
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: fn => { fn() },
  createElement: (type, props, ...children) => {
    const node = { type, props: props ?? {}, children }
    created.push(node)
    return node
  },
}

const styles = []
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}
globalThis.document = {
  createElement: () => ({ textContent: '', remove() {} }),
  head: { appendChild: node => { styles.push(node.textContent) } },
}

const clientModulePath = existsSync(resolve(here, './client.js'))
  ? './client.js'
  : '../lib/client.js'
await import(clientModulePath)

/* ── 工具 ──────────────────────────────────────────────────────────── */

/** 在元素树里按 role/className 找节点。 */
const byClass = (node, className) => (node.children ?? []).find(child => child && child.props && child.props.className === className)
const byRole = (node, role) => {
  if (node && node.props && node.props.role === role) return node
  for (const child of node?.children ?? []) {
    const found = byRole(child, role)
    if (found !== undefined) return found
  }
  return undefined
}
const componentFor = slot => registered.slice().reverse().find(entry => entry.options.name === slot).component
const keyedComponentFor = (slot, key) => registered.slice().reverse().find(entry => entry.options.name === slot && entry.options.key === key)?.component

/* ── 假 ctx ────────────────────────────────────────────────────────── */

const registered = []
const injected = []
const disposers = []

function makeCtx(overrides) {
  const slots = {
    inject(name, factory) {
      if (!injected.includes(name)) injected.push(name)
      return factory()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  }
  const settingsScope = {
    bind: () => ({
      getSnapshot: () => SNAPSHOT,
      subscribe: () => () => {},
      set: () => Promise.resolve(),
    }),
  }
  const resolveService = name => (overrides && Object.prototype.hasOwnProperty.call(overrides, name)
    ? overrides[name]
    : name === 'slots' ? slots : name === 'settingsScope' ? settingsScope : undefined)

  return {
    get: resolveService,
    inject: (deps, callback) => {
      const scope = {}
      let allAvailable = true
      for (const dep of deps) {
        const val = resolveService(dep)
        if (val === undefined) allAvailable = false
        scope[dep] = val
      }
      if (allAvailable && typeof callback === 'function') {
        callback(scope)
      }
    },
    effect: fn => { disposers.push(fn()) },
  }
}

/* ── 测试 ──────────────────────────────────────────────────────────── */

console.log('\n客户端半边')

t('模块契约：调用了 __ModuleLoader__.load 且 id 正确', () => {
  if (loaded === undefined) throw new Error('client.js 没有调用 __ModuleLoader__.load')
  if (loaded.id !== 'dsh-wolfpack') throw new Error(`id 应为 dsh-wolfpack，实际 ${loaded.id}`)
  if (typeof loaded.factory !== 'function') throw new Error('factory 不是函数')
})

t('factory 返回 { name, inject, apply }', () => {
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  if (plugin.name !== 'wolfpack') throw new Error(`name 应为 wolfpack，实际 ${plugin.name}`)
  if (!Array.isArray(plugin.inject)) throw new Error('inject 不是数组')
  if (typeof plugin.apply !== 'function') throw new Error('apply 不是函数')
})

t('缺服务时不抛异常，只报错并退出', () => {
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  plugin.apply(makeCtx({ slots: undefined }))
})

await ta('apply 把两处 UI 都注册上了（输入框开关 + 设置行 + 两个工具卡片）', async () => {
  registered.length = 0
  injected.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  plugin.apply(makeCtx())

  const names = registered.map(entry => entry.options.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(['conversation.input.right', 'settings.general.item', 'tool.call.toolview', 'tool.call.toolview'])) {
    throw new Error(`注册的槽位不对：${JSON.stringify(names)}`)
  }
  const chip = registered.find(entry => entry.options.name === 'conversation.input.right')
  if (chip.options.id !== 'wolfpack') throw new Error('输入框开关缺 id')
  if (typeof chip.component !== 'function') throw new Error('输入框开关不是组件')
  const row = registered.find(entry => entry.options.name === 'settings.general.item')
  if (typeof row.component !== 'function') throw new Error('设置行不是组件')

  const statusReg = registered.find(entry => entry.options.name === 'tool.call.toolview' && entry.options.key === 'wolf_status')
  if (!statusReg || typeof statusReg.component !== 'function') throw new Error('wolf_status 工具卡片未正确注册')
  const killReg = registered.find(entry => entry.options.name === 'tool.call.toolview' && entry.options.key === 'wolf_kill')
  if (!killReg || typeof killReg.component !== 'function') throw new Error('wolf_kill 工具卡片未正确注册')

  if (JSON.stringify(injected.slice().sort()) !== JSON.stringify(['conversation.input.right', 'settings.general.item', 'tool.call.toolview'])) {
    throw new Error(`inject 的槽位不对：${JSON.stringify(injected)}`)
  }
})

await ta('输入框开关与设置行状态一致（两处不能互相说谎）', async () => {
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  plugin.apply(makeCtx())
  const chip = componentFor('conversation.input.right')
  const row = componentFor('settings.general.item')

  // 开启
  SNAPSHOT.value = { enabled: true }
  const chipOn = byRole(chip(), 'switch')
  const rowOn = byRole(row(), 'switch')
  if (chipOn === undefined || rowOn === undefined) throw new Error('找不到开关按钮')
  if (!String(chipOn.props.className).includes('on')) throw new Error('开启时输入框开关应有 on 类')
  if (!String(rowOn.props.className).includes('on')) throw new Error('开启时设置行开关应有 on 类')

  // 关闭
  SNAPSHOT.value = { enabled: false }
  if (String(byRole(chip(), 'switch').props.className).includes('on')) throw new Error('关闭时输入框开关不应有 on 类')
  if (String(byRole(row(), 'switch').props.className).includes('on')) throw new Error('关闭时设置行开关不应有 on 类')

  SNAPSHOT.value = { enabled: true }
})

await ta('两处开关都是合法的 switch 语义且带状态文案', async () => {
  const chip = componentFor('conversation.input.right')
  const on = byRole(chip(), 'switch')
  if (on.props.role !== 'switch') throw new Error('role 应为 switch')
  if (on.props['aria-checked'] !== 'true') throw new Error('aria-checked 应为 true')
  if (!String(on.props.title).includes('已开启')) throw new Error(`title 应说明已开启，实际 "${on.props.title}"`)
  if (typeof on.props.onClick !== 'function') throw new Error('缺少 onClick')

  SNAPSHOT.value = { enabled: false }
  const off = byRole(chip(), 'switch')
  if (off.props['aria-checked'] !== 'false') throw new Error('aria-checked 应为 false')
  if (!String(off.props.title).includes('已关闭')) throw new Error(`title 应说明已关闭，实际 "${off.props.title}"`)
  SNAPSHOT.value = { enabled: true }
})

await ta('设置只读时两处都禁用', async () => {
  const chip = componentFor('conversation.input.right')
  const row = componentFor('settings.general.item')
  SNAPSHOT.writable = false
  if (byRole(chip(), 'switch').props.disabled !== true) throw new Error('只读时输入框开关应禁用')
  if (byRole(row(), 'switch').props.disabled !== true) throw new Error('只读时设置行开关应禁用')
  SNAPSHOT.writable = true
})

await ta('输入框开关结构：标签 + 滑块（滑块由轨道与旋钮组成）', async () => {
  const chip = componentFor('conversation.input.right')
  const root = chip()
  if (!/^wp-mini( on)?$/.test(root.props.className)) throw new Error(`根元素应为 .wp-mini[.on]，实际 "${root.props.className}"`)
  const label = byClass(root, 'wp-mini-label')
  if (label === undefined) throw new Error('缺少标签元素 .wp-mini-label')
  const track = byClass(root, 'wp-mini-switch') ?? byRole(root, 'switch')
  if (track === undefined) throw new Error('缺少滑块轨道')
  if (byClass(track, 'wp-mini-knob') === undefined) throw new Error('滑块里缺少旋钮')
})

/* ── 外观契约 ──────────────────────────────────────────────────────── */

t('外观契约：容器默认完全融入界面，悬停才浮现', () => {
  const css = styles.join('\n')
  if (css === '') throw new Error('没有注入任何样式')

  const base = /\.wp-mini\{([^}]*)\}/.exec(css)
  if (base === null) throw new Error('找不到 .wp-mini 基础规则')
  if (!base[1].includes('background:transparent')) throw new Error('默认底色必须完全透明')
  if (!base[1].includes('border:1px solid transparent')) throw new Error('默认边框必须完全透明')

  const hover = /\.wp-mini:hover[^{]*\{([^}]*)\}/.exec(css)
  if (hover === null) throw new Error('找不到 .wp-mini:hover 规则')
  if (!hover[1].includes('background:rgba')) throw new Error('悬停时应浮现底色')
  if (!hover[1].includes('border-color:rgba')) throw new Error('悬停时应浮现描边')
})

t('外观契约：容器级 on 规则被禁止，状态只能落在滑块本体上', () => {
  const css = styles.join('\n')
  // \`.wp-mini.on { ... }\` 这种写法等于「整块变色」——用户明确否掉过。
  if (/\.wp-mini\.on\s*\{/.test(css)) {
    throw new Error('.wp-mini.on 不应存在容器级规则')
  }
  const trackOn = /\.wp-mini-switch\.on\{([^}]*)\}/.exec(css)
  if (trackOn === null) throw new Error('找不到 .wp-mini-switch.on 规则')
  if (!trackOn[1].includes('#2f9e63')) throw new Error('开启状态滑块轨道应为绿色')
  // 压暗只作用于标签，否则滑块会被一起压暗
  const base = /\.wp-mini\{([^}]*)\}/.exec(css)
  if (/opacity\s*:/.test(base[1])) throw new Error('.wp-mini 容器上不应设 opacity（会连滑块一起压暗）')
  if (!/\.wp-mini-label\{[^}]*opacity/.test(css)) throw new Error('应由 .wp-mini-label 承担压暗')
})

t('交互契约：绝不用 :focus-within（鼠标点一下会让边框一直挂着）', () => {
  const css = styles.join('\n')
  // 真机上出现过：点一下开关后描边一直不消失，直到在别处点一下。
  // 根因就是 :focus-within——鼠标点击让按钮保持聚焦。
  if (css.includes(':focus-within')) {
    throw new Error('不得使用 :focus-within：鼠标点击后它会一直命中，边框会挂住')
  }
  if (!css.includes(':has(:focus-visible)')) {
    throw new Error('键盘可达性应由 :has(:focus-visible) 提供（鼠标点击不会命中它）')
  }
})

t('交互契约：键盘聚焦的样式必须与悬停分开写', () => {
  const css = styles.join('\n')
  // 逗号列表里一旦有浏览器不认识的选择器，整条规则会被丢弃——
  // 那会连悬停效果一起弄没。所以 :has(...) 必须独立成条。
  for (const rule of css.split('}')) {
    const selectors = rule.split('{')[0]
    if (selectors.includes(':has(') && selectors.includes(',')) {
      throw new Error(`:has() 不能出现在逗号选择器列表里：${selectors.trim()}`)
    }
  }
})

t('交互契约：开启后标签完全展现，关闭时保持若隐若现', () => {
  const css = styles.join('\n')
  const base = /\.wp-mini-label\{([^}]*)\}/.exec(css)
  if (base === null) throw new Error('找不到 .wp-mini-label 规则')
  const offOpacity = Number(/opacity:([\d.]+)/.exec(base[1])[1])
  if (!(offOpacity > 0 && offOpacity < 1)) throw new Error(`关闭时应是若隐若现的半透明，实际 ${offOpacity}`)

  const on = /\.wp-mini\.on \.wp-mini-label\{([^}]*)\}/.exec(css)
  if (on === null) throw new Error('找不到 .wp-mini.on .wp-mini-label 规则')
  const onOpacity = Number(/opacity:([\d.]+)/.exec(on[1])[1])
  if (onOpacity !== 1) throw new Error(`开启后应完全展现（opacity 1），实际 ${onOpacity}`)
})

t('外观契约：滑块旋钮的位移与轨道尺寸匹配（不会滑出轨道）', () => {
  const css = styles.join('\n')
  const track = /\.wp-mini-switch\{([^}]*)\}/.exec(css)
  const knob = /\.wp-mini-knob\{([^}]*)\}/.exec(css)
  const moved = /\.wp-mini-switch\.on \.wp-mini-knob\{transform:translateX\((-?[\d.]+)px\);?\}/.exec(css)
  if (track === null || knob === null || moved === null) throw new Error('找不到滑块尺寸规则')
  const width = Number(/width:([\d.]+)px/.exec(track[1])[1])
  const border = Number(/border:([\d.]+)px/.exec(track[1])[1])
  const knobWidth = Number(/width:([\d.]+)px/.exec(knob[1])[1])
  const left = Number(/left:([\d.]+)px/.exec(knob[1])[1])
  const shift = Number(moved[1])
  const inner = width - border * 2
  const rightEdge = left + shift + knobWidth
  if (rightEdge > inner) {
    throw new Error(`旋钮会滑出轨道：右边缘 ${rightEdge} > 轨道内宽 ${inner}`)
  }
  if (shift <= 0) throw new Error('位移必须为正')
})

/* ── 工具卡片测试 ──────────────────────────────────────────────────── */

/** 递归展开虚拟 DOM 中的所有组件函数并平铺 children。 */
const renderTree = node => {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderTree).filter(Boolean)
  if (typeof node.type === 'function') {
    return renderTree(node.type(node.props))
  }
  return {
    ...node,
    children: (node.children ?? []).map(renderTree).filter(Boolean).flat(),
  }
}

/** 深度查找所有满足条件的节点。 */
const findAll = (node, predicate) => {
  const result = []
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (predicate(n)) result.push(n)
    for (const child of n.children ?? []) {
      walk(child)
    }
  }
  walk(node)
  return result
}

/** 递归收集虚拟 DOM 树中所有文本内容。 */
const allText = node => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(allText).join(' ')
  if (node.children) return allText(node.children)
  return ''
}

t('U-a: 两个 keyed 注册存在，options.key 分别是 wolf_status / wolf_kill，组件都是函数', () => {
  registered.length = 0
  injected.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  plugin.apply(makeCtx())

  const statusReg = keyedComponentFor('tool.call.toolview', 'wolf_status')
  const killReg = keyedComponentFor('tool.call.toolview', 'wolf_kill')

  if (typeof statusReg !== 'function') throw new Error('wolf_status keyed 组件不存在或不是函数')
  if (typeof killReg !== 'function') throw new Error('wolf_kill keyed 组件不存在或不是函数')
})

t('U-b: WolfStatusCard 对 2 行样例 meta（一行 pass+在跑、一行 fail+未在跑）渲染出的树里能找到：两个 task_id、轮次、verdict、运行状态文案、tokens、改动文件数', () => {
  const WolfStatusCard = keyedComponentFor('tool.call.toolview', 'wolf_status')
  const sampleMeta = {
    total: 2,
    truncated: false,
    tasks: [
      {
        task_id: 'task-alpha-run',
        round: 3,
        last_verdict: 'pass',
        last_stop_reason: 'completed',
        total_tokens: 15000,
        running: true,
        changed_files_count: 4,
      },
      {
        task_id: 'task-beta-idle',
        round: 1,
        last_verdict: 'fail',
        last_stop_reason: 'aborted',
        total_tokens: 800,
        running: false,
        changed_files_count: 0,
      },
    ],
  }
  const block = {
    kind: 'tool-result',
    callId: 'call-status-ub',
    content: [{ type: 'text', text: 'status summary' }],
    isError: false,
    meta: sampleMeta,
  }

  const tree = renderTree(WolfStatusCard({ block }))
  const text = allText(tree)

  // 1. 两个 task_id
  if (!text.includes('task-alpha-run') || !text.includes('task-beta-idle')) {
    throw new Error(`树中未找到两个 task_id：${text}`)
  }
  // 2. 轮次
  if (!text.includes('第 3 轮') || !text.includes('第 1 轮')) {
    throw new Error(`树中未找到轮次：${text}`)
  }
  // 3. verdict
  if (!text.includes('pass') || !text.includes('fail')) {
    throw new Error(`树中未找到 verdict (pass/fail)：${text}`)
  }
  // 4. 运行状态文案
  if (!text.includes('正在跑') || !text.includes('未在跑')) {
    throw new Error(`树中未找到运行状态文案（正在跑/未在跑）：${text}`)
  }
  // 5. tokens
  if (!text.includes('15K') || !text.includes('800')) {
    throw new Error(`树中未找到 tokens (15K/800)：${text}`)
  }
  // 6. 改动文件数
  if (!text.includes('改动 4 个文件') || !text.includes('改动 0 个文件')) {
    throw new Error(`树中未找到改动文件数：${text}`)
  }
})

t('U-c: meta 为 undefined / null / { tasks: "nope" } 三种畸形输入都不抛，且回退渲染 block.content 文本', () => {
  const WolfStatusCard = keyedComponentFor('tool.call.toolview', 'wolf_status')
  const cases = [
    { meta: undefined, text: 'fallback-text-undefined' },
    { meta: null, text: 'fallback-text-null' },
    { meta: { tasks: 'nope' }, text: 'fallback-text-bad-tasks' },
  ]

  for (const c of cases) {
    const block = {
      kind: 'tool-result',
      callId: 'call-malformed',
      content: [{ type: 'text', text: c.text }],
      isError: false,
      meta: c.meta,
    }
    let vdom
    try {
      vdom = WolfStatusCard({ block })
    } catch (err) {
      throw new Error(`畸形 meta (${JSON.stringify(c.meta)}) 抛出了异常: ${err.message}`)
    }
    const tree = renderTree(vdom)
    const text = allText(tree)
    if (!text.includes(c.text)) {
      throw new Error(`畸形 meta (${JSON.stringify(c.meta)}) 未回退渲染 block.content 文本，实际输出: ${text}`)
    }
    const pres = findAll(tree, n => n.type === 'pre')
    if (pres.length === 0) {
      throw new Error(`畸形 meta (${JSON.stringify(c.meta)}) 回退时未渲染 <pre> 元素`)
    }
  }
})

t('U-d: 运行中形态（无 kind）不抛且给出运行中文案', () => {
  const WolfStatusCard = keyedComponentFor('tool.call.toolview', 'wolf_status')
  const runningBlock = {
    callId: 'call-running-ud',
    name: 'wolf_status',
    argsRaw: '{}',
  }
  let vdom
  try {
    vdom = WolfStatusCard({ block: runningBlock })
  } catch (err) {
    throw new Error(`运行中形态抛出了异常: ${err.message}`)
  }
  const tree = renderTree(vdom)
  const text = allText(tree)
  if (!text.includes('🐺 wolf_status 运行中…')) {
    throw new Error(`运行中文案不符，实际: "${text}"`)
  }
})

t('U-e: WolfKillCard 的 ok=true / ok=false 两种渲染', () => {
  const WolfKillCard = keyedComponentFor('tool.call.toolview', 'wolf_kill')

  // 1. ok=true
  const okBlock = {
    kind: 'tool-result',
    callId: 'kill-ok',
    meta: { ok: true, task_id: 'task-target-99', run_id: 'run-777' },
  }
  const okTree = renderTree(WolfKillCard({ block: okBlock }))
  const okText = allText(okTree)
  if (!okText.includes('✅ 已终止 task_id=task-target-99（run_id=run-777）')) {
    throw new Error(`ok=true 渲染文案不符，实际: "${okText}"`)
  }

  // 2. ok=false
  const failBlock = {
    kind: 'tool-result',
    callId: 'kill-fail',
    meta: { ok: false, reason: '该 task_id 未在运行' },
  }
  const failTree = renderTree(WolfKillCard({ block: failBlock }))
  const failText = allText(failTree)
  if (!failText.includes('❌ 终止失败——该 task_id 未在运行')) {
    throw new Error(`ok=false 渲染文案不符，实际: "${failText}"`)
  }

  // 3. 运行中形态
  const runningTree = renderTree(WolfKillCard({ block: { callId: 'kill-run', name: 'wolf_kill' } }))
  if (!allText(runningTree).includes('🐺 wolf_kill 运行中…')) {
    throw new Error('WolfKillCard 运行中文案不符')
  }

  // 4. 畸形 meta 兜底不抛
  const fallbackTree = renderTree(WolfKillCard({
    block: {
      kind: 'tool-result',
      callId: 'kill-fb',
      meta: null,
      content: [{ type: 'text', text: 'kill fallback text' }],
    },
  }))
  if (!allText(fallbackTree).includes('kill fallback text')) {
    throw new Error('WolfKillCard 畸形 meta 未回退 content 文本')
  }
})

t('U-f: 机械闸门：读 lib/client.js 源码，断言不含 host.call、不含 ctx.get("host")', () => {
  const clientPath = existsSync(resolve(here, './client.js'))
    ? resolve(here, './client.js')
    : resolve(here, '../lib/client.js')
  const src = readFileSync(clientPath, 'utf8')
  if (src.includes('host.call')) {
    throw new Error('lib/client.js 中仍包含 host.call')
  }
  if (/ctx\.get\(\s*['"]host['"]\s*\)/.test(src)) {
    throw new Error('lib/client.js 中仍包含 ctx.get(\'host\')')
  }
})

/* ── 防回归：inject 白名单与通道隔离 ────────────────────────────── */

t('防回归：inject 白名单严格等于 [slots, settingsScope]', () => {
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  const expected = ['slots', 'settingsScope']
  const actual = plugin.inject
  if (!Array.isArray(actual)) {
    throw new Error('plugin.inject 必须是数组')
  }
  const isMatch = actual.length === expected.length && actual.every((v, i) => v === expected[i])
  if (!isMatch) {
    throw new Error(
      `inject 必须严格等于 ${JSON.stringify(expected)}，实际为 ${JSON.stringify(actual)}。` +
      '新增服务名之前，必须先在该平面真实运行时里核实它存在'
    )
  }
})

t('防回归：inject 白名单不包含 host（host.call 是动态插件专用通道）', () => {
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  if (!Array.isArray(plugin.inject)) {
    throw new Error('plugin.inject 必须是数组')
  }
  if (plugin.inject.includes('host')) {
    throw new Error(
      'inject 绝不得包含 "host"：host.call 是动态插件专用通道，静态插件拿不到它，声明硬依赖会导致 web boot 永久 pending。'
    )
  }
})

/* ── 第 2 轮：右侧栏实时面板 ───────────────────────────────────── */

t('V-a: 机械闸门：源码含 sidebar.right.pane.tab、含 /wolfpack/live，且不含 host.call 与 ctx.get("host")', () => {
  const clientPath = existsSync(resolve(here, './client.js'))
    ? resolve(here, './client.js')
    : resolve(here, '../lib/client.js')
  const src = readFileSync(clientPath, 'utf8')
  if (!src.includes('sidebar.right.pane.tab')) {
    throw new Error('lib/client.js 中未包含 sidebar.right.pane.tab')
  }
  if (!src.includes('/wolfpack/live')) {
    throw new Error('lib/client.js 中未包含 /wolfpack/live')
  }
  if (src.includes('host.call')) {
    throw new Error('lib/client.js 中仍包含 host.call')
  }
  if (/ctx\.get\(\s*['"]host['"]\s*\)/.test(src)) {
    throw new Error('lib/client.js 中仍包含 ctx.get(\'host\')')
  }
})

t('V-b: 注册：sidebarRightTabs.register 被调用一次且 id/kind 正确；slots.register 里出现 { name:"sidebar.right.pane.tab", key:<id> }', () => {
  registered.length = 0
  injected.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  let registeredDef = null
  let regCount = 0
  const mockTabs = {
    register: def => {
      regCount++
      registeredDef = def
      return () => {}
    },
  }
  plugin.apply(makeCtx({ sidebarRightTabs: mockTabs }))

  if (regCount !== 1) {
    throw new Error(`sidebarRightTabs.register 应被调用 1 次，实际调用了 ${regCount} 次`)
  }
  if (!registeredDef) {
    throw new Error('未获取到 tab definition')
  }
  if (registeredDef.id !== 'dsh-wolfpack') {
    throw new Error(`definition.id 应为 dsh-wolfpack，实际 ${registeredDef.id}`)
  }
  if (registeredDef.kind !== 'wolfpack') {
    throw new Error(`definition.kind 应为 wolfpack，实际 ${registeredDef.kind}`)
  }
  if (typeof registeredDef.title !== 'function') {
    throw new Error('definition.title 应为函数')
  }

  const paneReg = registered.find(entry => entry.options.name === 'sidebar.right.pane.tab' && entry.options.key === 'dsh-wolfpack')
  if (!paneReg) {
    throw new Error('未在 slots.register 中找到 { name: "sidebar.right.pane.tab", key: "dsh-wolfpack" }')
  }
  if (typeof paneReg.component !== 'function') {
    throw new Error('sidebar.right.pane.tab 注册的组件不是函数')
  }
})

t('V-c: 渲染：喂一份含 1 个 running（带 transcript thinking 文本）+ 1 个 idle 的样例 payload，断言树里能找到两个 task_id、轮次、tokens、verdict、运行状态文案，以及那段思考原文', () => {
  registered.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  const mockTabs = { register: () => () => {} }
  plugin.apply(makeCtx({ sidebarRightTabs: mockTabs }))

  const WolfLivePanel = keyedComponentFor('sidebar.right.pane.tab', 'dsh-wolfpack')
  if (typeof WolfLivePanel !== 'function') throw new Error('WolfLivePanel 未正确注册')

  const thinkingSample = '正在分析多文件改动并准备生成补丁计划'
  const samplePayload = {
    generated_at: Date.now(),
    ledger_total: 5,
    runs: [
      {
        task_id: 'task-live-running-01',
        run_id: 'run-01',
        status: 'running',
        round: 3,
        elapsed_ms: 25000,
        total_tokens: 18500,
        verdict: 'pass',
        stop_reason: 'completed',
        transcript: {
          available: true,
          events: [
            { at: '2026-09-16T09:10:00Z', kind: 'action', text: '检查代码仓库' },
            { at: '2026-09-16T09:10:05Z', kind: 'thinking', text: thinkingSample },
          ],
        },
      },
      {
        task_id: 'task-live-idle-02',
        status: 'idle',
        round: 1,
        total_tokens: 800,
        verdict: 'fail',
        stop_reason: 'aborted',
        transcript: {
          available: true,
          events: [],
        },
      },
    ],
  }

  const vdom = WolfLivePanel({ payload: samplePayload })
  const tree = renderTree(vdom)
  const text = allText(tree)

  // 1. 两个 task_id
  if (!text.includes('task-live-running-01') || !text.includes('task-live-idle-02')) {
    throw new Error(`树中未找到两个 task_id：${text}`)
  }
  // 2. 轮次
  if (!text.includes('第 3 轮') || !text.includes('第 1 轮')) {
    throw new Error(`树中未找到轮次：${text}`)
  }
  // 3. tokens (19K / 800)
  if (!text.includes('19K') || !text.includes('800')) {
    throw new Error(`树中未找到 tokens：${text}`)
  }
  // 4. verdict
  if (!text.includes('pass') || !text.includes('fail')) {
    throw new Error(`树中未找到 verdict：${text}`)
  }
  // 5. 运行状态文案 (正在跑 / 未在跑)
  if (!text.includes('正在跑') || !text.includes('未在跑')) {
    throw new Error(`树中未找到运行状态文案：${text}`)
  }
  // 6. 那段思考原文
  if (!text.includes(thinkingSample)) {
    throw new Error(`树中未找到思考原文：${text}`)
  }
})

await ta('V-d: 空态与错误态：runs: [] → 空态文案；fetch 抛错/reject → 显示错误行且不抛', async () => {
  registered.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  const mockTabs = { register: () => () => {} }
  plugin.apply(makeCtx({ sidebarRightTabs: mockTabs }))

  const WolfLivePanel = keyedComponentFor('sidebar.right.pane.tab', 'dsh-wolfpack')
  if (typeof WolfLivePanel !== 'function') throw new Error('WolfLivePanel 未正确注册')

  // 1. runs: [] 空态
  const emptyPayload = {
    generated_at: Date.now(),
    ledger_total: 16,
    runs: [],
  }
  const emptyTree = renderTree(WolfLivePanel({ payload: emptyPayload }))
  const emptyText = allText(emptyTree)
  if (!emptyText.includes('当前没有在跑的 agy 任务')) {
    throw new Error(`空态文案不符，实际: "${emptyText}"`)
  }
  if (!emptyText.includes('16')) {
    throw new Error(`空态未显示台账总数 16，实际: "${emptyText}"`)
  }

  // 2. fetch 抛错/reject 模拟
  let errorVdom
  try {
    errorVdom = WolfLivePanel({ error: 'ECONNREFUSED 连接拒绝' })
  } catch (err) {
    throw new Error(`渲染错误态时抛出了异常: ${err.message}`)
  }
  const errTree = renderTree(errorVdom)
  const errText = allText(errTree)
  if (!errText.includes('拉取失败：ECONNREFUSED 连接拒绝')) {
    throw new Error(`错误行文案不符，实际: "${errText}"`)
  }
})

t('V-e: transcript.available === false → 显示 reason，不抛', () => {
  registered.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  const mockTabs = { register: () => () => {} }
  plugin.apply(makeCtx({ sidebarRightTabs: mockTabs }))

  const WolfLivePanel = keyedComponentFor('sidebar.right.pane.tab', 'dsh-wolfpack')
  const unavailPayload = {
    generated_at: Date.now(),
    ledger_total: 1,
    runs: [
      {
        task_id: 'task-transcript-unavail',
        status: 'running',
        round: 1,
        transcript: {
          available: false,
          reason: '未获取到 conversationId',
          events: [],
        },
      },
    ],
  }

  let vdom
  try {
    vdom = WolfLivePanel({ payload: unavailPayload })
  } catch (err) {
    throw new Error(`渲染 transcript.available === false 抛出异常: ${err.message}`)
  }
  const tree = renderTree(vdom)
  const text = allText(tree)
  if (!text.includes('未获取到 conversationId')) {
    throw new Error(`未显示 transcript 不可用原因，实际: "${text}"`)
  }
})

t('V-f: 轮询生命周期：挂载后创建了定时器，卸载（cleanup）后被清掉', () => {
  registered.length = 0
  let capturedCleanup = null
  const LifecycleReact = {
    ...FakeReact,
    useEffect: fn => {
      capturedCleanup = fn()
    },
  }

  let intervalCleared = false
  const origClearInterval = globalThis.clearInterval
  globalThis.clearInterval = id => {
    intervalCleared = true
    origClearInterval(id)
  }

  try {
    const plugin = loaded.factory(name => (name === 'react' ? LifecycleReact : undefined))
    const mockTabs = { register: () => () => {} }
    plugin.apply(makeCtx({ sidebarRightTabs: mockTabs }))

    const WolfLivePanel = keyedComponentFor('sidebar.right.pane.tab', 'dsh-wolfpack')
    WolfLivePanel({})

    if (typeof capturedCleanup !== 'function') {
      throw new Error('WolfLivePanel 挂载后未返回 cleanup 函数')
    }

    // 执行卸载 cleanup
    capturedCleanup()

    if (!intervalCleared) {
      throw new Error('卸载时未调用 clearInterval')
    }
  } finally {
    globalThis.clearInterval = origClearInterval
  }
})

t('V-g: 输入框 📊 按钮：sidebarRight 可用时点击打开面板，不可用时禁用并显示说明 title', () => {
  registered.length = 0
  injected.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))

  let openedKind = null
  let openedOpts = null
  const mockSidebarRight = {
    openTab: (kind, opts) => {
      openedKind = kind
      openedOpts = opts
    },
  }

  // 1. 服务可用
  plugin.apply(makeCtx({ sidebarRight: mockSidebarRight }))
  const chipWithService = componentFor('conversation.input.right')
  const root1 = chipWithService()
  const liveBtn1 = byClass(root1, 'wp-live-btn')
  if (!liveBtn1) throw new Error('输入框中未找到 .wp-live-btn 按钮')
  if (liveBtn1.props.disabled) throw new Error('服务可用时 📊 按钮不应被禁用')
  if (!String(liveBtn1.props.title).includes('打开狼群实时面板')) {
    throw new Error(`title 应说明打开面板，实际: "${liveBtn1.props.title}"`)
  }
  liveBtn1.props.onClick()
  if (openedKind !== 'wolfpack' || !openedOpts || openedOpts.revealIfOpened !== true) {
    throw new Error(`openTab 调用参数不正确: ${openedKind}, ${JSON.stringify(openedOpts)}`)
  }

  // 2. 服务不可用
  registered.length = 0
  plugin.apply(makeCtx({ sidebarRight: undefined }))
  const chipWithoutService = componentFor('conversation.input.right')
  const root2 = chipWithoutService()
  const liveBtn2 = byClass(root2, 'wp-live-btn')
  if (!liveBtn2.props.disabled) throw new Error('服务不可用时 📊 按钮应被禁用')
  if (!String(liveBtn2.props.title).includes('不可用')) {
    throw new Error(`服务不可用时 title 应诚实交代不可用，实际: "${liveBtn2.props.title}"`)
  }
})

/* ── 第 3 轮：右侧栏服务动态注入与容错 ───────────────────────────── */

t('W-a: 回归守卫：get("sidebarRightTabs")/get("sidebarRight") 返回 undefined 时，通过 inject 仍能正确注册 tab 类型与面板内容体', () => {
  registered.length = 0
  injected.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))

  let registeredDef = null
  let regCount = 0
  const mockTabs = {
    register: def => {
      regCount++
      registeredDef = def
      return () => {}
    },
  }
  const mockSidebarRight = {
    openTab: () => {},
  }

  // 严格模拟真实宿主：get('sidebarRightTabs') 与 get('sidebarRight') 一律返回 undefined
  const fakeCtx = makeCtx()
  const origGet = fakeCtx.get
  fakeCtx.get = name => {
    if (name === 'sidebarRightTabs' || name === 'sidebarRight') return undefined
    return origGet(name)
  }
  fakeCtx.inject = (deps, callback) => {
    const scope = {}
    for (const dep of deps) {
      if (dep === 'sidebarRightTabs') scope[dep] = mockTabs
      else if (dep === 'sidebarRight') scope[dep] = mockSidebarRight
      else scope[dep] = fakeCtx.get(dep)
    }
    if (typeof callback === 'function') callback(scope)
  }

  plugin.apply(fakeCtx)

  if (regCount !== 1) {
    throw new Error(`sidebarRightTabs.register 应被调用 1 次，实际调用了 ${regCount} 次（若为 0 说明仍在用 ctx.get 试图取服务）`)
  }
  if (!registeredDef) {
    throw new Error('未获取到 tab definition')
  }
  if (registeredDef.id !== 'dsh-wolfpack') {
    throw new Error(`definition.id 应为 dsh-wolfpack，实际 ${registeredDef.id}`)
  }
  if (registeredDef.kind !== 'wolfpack') {
    throw new Error(`definition.kind 应为 wolfpack，实际 ${registeredDef.kind}`)
  }
  if (typeof registeredDef.title !== 'function') {
    throw new Error('definition.title 应为函数')
  }

  const paneReg = registered.find(entry => entry.options.name === 'sidebar.right.pane.tab' && entry.options.key === 'dsh-wolfpack')
  if (!paneReg) {
    throw new Error('未在 slots.register 中找到 { name: "sidebar.right.pane.tab", key: "dsh-wolfpack" }')
  }
  if (typeof paneReg.component !== 'function') {
    throw new Error('sidebar.right.pane.tab 注册的组件不是函数')
  }
})

t('W-b: 机械闸门：lib/client.js 不再出现 ctx.get("sidebarRightTabs") 与 ctx.get("sidebarRight")，且出现了 ctx.inject 动态等待', () => {
  const clientPath = existsSync(resolve(here, './client.js'))
    ? resolve(here, './client.js')
    : resolve(here, '../lib/client.js')
  const src = readFileSync(clientPath, 'utf8')

  if (/ctx\.get\(\s*['"]sidebarRightTabs['"]\s*\)/.test(src)) {
    throw new Error('lib/client.js 中仍在使用 ctx.get("sidebarRightTabs")')
  }
  if (/ctx\.get\(\s*['"]sidebarRight['"]\s*\)/.test(src)) {
    throw new Error('lib/client.js 中仍在使用 ctx.get("sidebarRight")')
  }
  if (/ctx\.get\(\s*['"]sidebarRight/.test(src)) {
    throw new Error('lib/client.js 中仍在通过 ctx.get 读取 sidebarRight 相关服务')
  }
  if (!src.includes("ctx.inject(['sidebarRightTabs']")) {
    throw new Error('lib/client.js 中缺少 ctx.inject([\'sidebarRightTabs\']')
  }
  if (!src.includes("ctx.inject(['sidebarRight']")) {
    throw new Error('lib/client.js 中缺少 ctx.inject([\'sidebarRight\']')
  }
})

t('W-c: 📊 按钮点击行为：sidebarRight 可用时调 openTab("wolfpack", …)，不可用时点击不抛异常且显式暴露（console.error 与人话提示）', () => {
  registered.length = 0
  injected.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))

  let openedKind = null
  let openedOpts = null
  const mockSidebarRight = {
    openTab: (kind, opts) => {
      openedKind = kind
      openedOpts = opts
    },
  }

  // 1. 服务可用时点击 📊
  plugin.apply(makeCtx({ sidebarRight: mockSidebarRight }))
  const chipWithService = componentFor('conversation.input.right')
  const root1 = chipWithService()
  const liveBtn1 = byClass(root1, 'wp-live-btn')
  if (!liveBtn1) throw new Error('未找到 📊 按钮')
  if (liveBtn1.props.disabled) throw new Error('服务可用时 📊 按钮不应 disabled')
  liveBtn1.props.onClick()
  if (openedKind !== 'wolfpack' || !openedOpts || openedOpts.revealIfOpened !== true) {
    throw new Error(`openTab 调用参数不正确: kind=${openedKind}, opts=${JSON.stringify(openedOpts)}`)
  }

  // 2. 服务不可用时点击 📊
  registered.length = 0
  const loggedErrors = []
  const origError = console.error
  console.error = (...args) => {
    loggedErrors.push(args.join(' '))
    origError(...args)
  }

  try {
    plugin.apply(makeCtx({ sidebarRight: undefined }))
    const chipWithoutService = componentFor('conversation.input.right')
    const root2 = chipWithoutService()
    const liveBtn2 = byClass(root2, 'wp-live-btn')
    if (!liveBtn2) throw new Error('未找到 📊 按钮')

    // 点击时不抛异常
    try {
      liveBtn2.props.onClick()
    } catch (e) {
      throw new Error(`服务不可用时点击 📊 抛出了未捕获异常: ${e.message}`)
    }

    // 显式暴露：console.error 出现提示
    const hasConsoleError = loggedErrors.some(msg => msg.includes('sidebarRight') && msg.includes('不可用'))
    if (!hasConsoleError) {
      throw new Error(`服务不可用时点击未在 console.error 显式报错: ${JSON.stringify(loggedErrors)}`)
    }
  } finally {
    console.error = origError
  }
})

t('W-d: 实时面板：顶部显示「并行运行 N 个」，卡片显示「第 N 步」，思考区如实标注「思考在每步完成后写入」', () => {
  registered.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  const mockTabs = { register: () => () => {} }
  plugin.apply(makeCtx({ sidebarRightTabs: mockTabs }))

  const WolfLivePanel = keyedComponentFor('sidebar.right.pane.tab', 'dsh-wolfpack')
  if (typeof WolfLivePanel !== 'function') throw new Error('WolfLivePanel 未正确注册')

  const samplePayload = {
    generated_at: Date.now(),
    ledger_total: 8,
    runs: [
      {
        task_id: 'task-parallel-1',
        status: 'running',
        round: 2,
        step_index: 4,
        transcript: {
          available: true,
          step_index: 4,
          step_total: 5,
          events: [{ at: '2026-09-16T10:00:00Z', kind: 'thinking', text: '正在进行第4步分析' }],
        },
      },
      {
        task_id: 'task-parallel-2',
        status: 'running',
        round: 1,
        step_index: 2,
        transcript: {
          available: true,
          step_index: 2,
          step_total: 3,
          events: [{ at: '2026-09-16T10:00:01Z', kind: 'thinking', text: '正在进行第2步分析' }],
        },
      },
      {
        task_id: 'task-idle-3',
        status: 'idle',
        round: 1,
        step_index: null,
        transcript: { available: true, step_index: null, step_total: 0, events: [] },
      },
    ],
  }

  const vdom = WolfLivePanel({ payload: samplePayload })
  const tree = renderTree(vdom)
  const text = allText(tree)

  // 1. 顶部显示并行运行 2 个
  if (!text.includes('并行运行 2 个')) {
    throw new Error(`顶部未正确显示并行度，实际: "${text}"`)
  }

  // 2. 卡片显示第 N 步
  if (!text.includes('第 4 步')) {
    throw new Error(`卡片未显示第 4 步，实际: "${text}"`)
  }
  if (!text.includes('第 2 步')) {
    throw new Error(`卡片未显示第 2 步，实际: "${text}"`)
  }

  // 3. 思考区如实标注
  if (!text.includes('思考在每步完成后写入，显示的是最近完成的一步')) {
    throw new Error(`思考区缺少如实标注文案，实际: "${text}"`)
  }
})

t('W-e: 耗时语义 — 已结束任务必须显示台账真实总耗时（固定），绝不能拿 started_at 算成永远在涨的活时钟；正在跑才显示「已跑」', () => {
  registered.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  const mockTabs = { register: () => () => {} }
  plugin.apply(makeCtx({ sidebarRightTabs: mockTabs }))

  const WolfLivePanel = keyedComponentFor('sidebar.right.pane.tab', 'dsh-wolfpack')
  if (typeof WolfLivePanel !== 'function') throw new Error('WolfLivePanel 未正确注册')

  // 台账里的真实总耗时：242883ms = 4m 2s
  const realDurationMs = 242883
  // 「最后一次活动时刻」——若被当成起点算 now - started_at，就会显示 1h 0m 且每秒上涨
  const oneHourAgo = Date.now() - 3600 * 1000

  const payload = {
    generated_at: Date.now(),
    ledger_total: 3,
    runs: [
      { task_id: 'task-done', status: 'idle', round: 1, elapsed_ms: realDurationMs, total_tokens: 100 },
      { task_id: 'task-done-nodata', status: 'idle', round: 1, started_at: oneHourAgo, total_tokens: 100 },
      { task_id: 'task-running', status: 'running', round: 1, started_at: Date.now() - 5000, total_tokens: 100 },
    ],
  }

  const text = allText(renderTree(WolfLivePanel({ payload })))

  // 1. 已结束 + 有真实总耗时 → 显示这个固定值
  if (!text.includes('耗时 4m 2s')) {
    throw new Error(`已结束任务未显示台账真实总耗时「耗时 4m 2s」，实际: "${text}"`)
  }
  // 2. 已结束但只有「最后活动时刻」→ 绝不能把它当起点算成耗时（这正是用户看到的假增长）
  if (text.includes('耗时 1h 0m')) {
    throw new Error(`已结束任务把「距最后活动时间」当成了耗时，实际: "${text}"`)
  }
  // 3. 无真实耗时数据 → 如实说未知，不编数字、也不显示 '—'
  if (!text.includes('耗时 未知')) {
    throw new Error(`无耗时数据时未如实显示「耗时 未知」，实际: "${text}"`)
  }
  // 4. 正在跑的任务才用活时钟，文案是「已跑」
  if (!text.includes('已跑 ')) {
    throw new Error(`正在跑的任务未显示「已跑」，实际: "${text}"`)
  }
})

t('W-f: 「显示全部」出口与结束时刻 — 台账任务多于返回条数时必须给出口，已结束卡片显示「结束于」', () => {
  registered.length = 0
  const plugin = loaded.factory(name => (name === 'react' ? FakeReact : undefined))
  plugin.apply(makeCtx({ sidebarRightTabs: { register: () => () => {} } }))

  const WolfLivePanel = keyedComponentFor('sidebar.right.pane.tab', 'dsh-wolfpack')
  if (typeof WolfLivePanel !== 'function') throw new Error('WolfLivePanel 未正确注册')

  const finished = new Date()
  finished.setHours(9, 5, 3, 0)

  const base = {
    generated_at: Date.now(),
    ledger_total: 15,
    runs: Array.from({ length: 8 }, (_, i) => ({
      task_id: `task-${i}`,
      status: 'idle',
      round: 1,
      elapsed_ms: 60000 + i * 1000,
      finished_at: finished.getTime(),
      total_tokens: 10,
    })),
  }

  const text = allText(renderTree(WolfLivePanel({ payload: base })))
  if (!text.includes('显示全部 15 个')) {
    throw new Error(`台账有 15 个任务却只给 8 个，未提供「显示全部」出口，实际: "${text}"`)
  }
  if (!text.includes('结束于 09:05:03')) {
    throw new Error(`已结束卡片未显示结束时刻，实际: "${text}"`)
  }

  // 任务数与返回条数相等时不该出现这个按钮
  const noMore = Object.assign({}, base, { ledger_total: 8 })
  const text2 = allText(renderTree(WolfLivePanel({ payload: noMore })))
  if (text2.includes('显示全部')) {
    throw new Error(`没有更多任务时不该出现「显示全部」，实际: "${text2}"`)
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
