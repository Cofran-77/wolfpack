import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const specsPath = existsSync(resolve(here, 'core/worker/specs.mjs'))
  ? resolve(here, 'core/worker/specs.mjs')
  : resolve(here, '../lib/core/worker/specs.mjs')
const rosterPath = existsSync(resolve(here, 'core/worker/roster.mjs'))
  ? resolve(here, 'core/worker/roster.mjs')
  : resolve(here, '../lib/core/worker/roster.mjs')

const { CORE_WORKER_NAMES, WORKER_SPECS } = await import(pathToFileURL(specsPath).href)
const { buildWorkerRoster, defaultFind, workerRosterJson } = await import(pathToFileURL(rosterPath).href)

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

console.log('\n工人登记表（Worker Roster）测试')

t('1. buildWorkerRoster() 返回 28 条：前两条核心工人，后 26 条与 WORKER_SPECS 一致且无重复', () => {
  const roster = buildWorkerRoster({ find: () => undefined })
  assert.ok(Array.isArray(roster), 'buildWorkerRoster 必须返回数组')
  assert.equal(roster.length, 28, '登记表总条数必须是 28')

  const names = roster.map(w => w.name)
  assert.equal(names[0], 'agy', '第一条必须是 agy')
  assert.equal(names[1], 'claude', '第二条必须是 claude')

  const specNames = WORKER_SPECS.map(s => s.name)
  assert.deepEqual(names.slice(2), specNames, '后 26 条必须与 WORKER_SPECS 顺序一致')
  assert.equal(new Set(names).size, 28, '28 个工人名字不得重复')

  const expectedNames = [...CORE_WORKER_NAMES, ...specNames]
  assert.deepEqual(names, expectedNames, '名单必须单点来自 specs.mjs')
})

t('2. 字段齐全且类型严格符合契约', () => {
  const roster = buildWorkerRoster({ find: bin => (bin === 'claude' ? '/usr/bin/claude' : undefined) })
  for (const item of roster) {
    assert.equal(typeof item.name, 'string', `${item.name} name 必须是字符串`)
    assert.ok(item.name.trim() !== '', `${item.name} name 不能为空`)

    assert.equal(typeof item.label, 'string', `${item.name} label 必须是字符串`)
    assert.ok(item.label.trim() !== '', `${item.name} label 不能为空`)

    assert.equal(typeof item.bin, 'string', `${item.name} bin 必须是字符串`)
    assert.ok(item.bin.trim() !== '', `${item.name} bin 不能为空`)

    assert.equal(typeof item.installed, 'boolean', `${item.name} installed 必须是布尔`)
    assert.equal(typeof item.core, 'boolean', `${item.name} core 必须是布尔`)
  }
})

t('3. core 标记：CORE_WORKER_NAMES 为 true，其余均为 false', () => {
  const roster = buildWorkerRoster({ find: () => undefined })
  const coreItems = roster.filter(w => w.core)
  const nonCoreItems = roster.filter(w => !w.core)

  assert.equal(coreItems.length, 2, '核心工人必须恰好 2 个')
  assert.deepEqual(coreItems.map(w => w.name).sort(), ['agy', 'claude'].sort(), '核心工人必须是 agy 和 claude')

  assert.equal(nonCoreItems.length, 26, '非核心工人必须恰好 26 个')
  assert.ok(nonCoreItems.every(w => !CORE_WORKER_NAMES.includes(w.name)), '非核心工人不得包含核心工人名')
})

t('4. installed 状态严格跟随注入的 find 结果', () => {
  const installedMap = {
    agy: 'C:/tools/agy.exe',
    codex: 'C:/tools/codex.cmd',
    qwen: '', // 空字符串应判定为 false
    gemini: undefined, // undefined 应判定为 false
  }

  const roster = buildWorkerRoster({
    find: bin => {
      for (const [name, path] of Object.entries(installedMap)) {
        if (bin.includes(name)) return path
      }
      return undefined
    },
  })

  const agy = roster.find(w => w.name === 'agy')
  assert.equal(agy.installed, true, 'agy 找到路径应为 installed=true')

  const codex = roster.find(w => w.name === 'codex')
  assert.equal(codex.installed, true, 'codex 找到路径应为 installed=true')

  const qwen = roster.find(w => w.name === 'qwen')
  assert.equal(qwen.installed, false, 'qwen 探测返回空串应为 installed=false')

  const gemini = roster.find(w => w.name === 'gemini')
  assert.equal(gemini.installed, false, 'gemini 探测返回 undefined 应为 installed=false')
})

t('5. 默认 find 探测：空输入安全兜底，文件存在时能正常返回路径', () => {
  assert.equal(defaultFind(''), undefined, '空字符串返回 undefined')
  assert.equal(defaultFind('   '), undefined, '纯空白返回 undefined')
  assert.equal(defaultFind(null), undefined, 'null 返回 undefined')
  assert.equal(defaultFind(undefined), undefined, 'undefined 返回 undefined')

  // 测试 process.execPath（当前运行的 node）
  const nodeHit = defaultFind(process.execPath)
  assert.ok(nodeHit !== undefined, '绝对路径存在时应找到')
})

t('6. workerRosterJson() JSON 往返与版本包装', () => {
  const jsonStr = workerRosterJson({ find: bin => `/bin/${bin}` })
  assert.equal(typeof jsonStr, 'string', '必须返回 JSON 字符串')

  const parsed = JSON.parse(jsonStr)
  assert.equal(parsed.version, 1, '包装版本号必须是 1')
  assert.ok(Array.isArray(parsed.workers), 'workers 必须是数组')
  assert.equal(parsed.workers.length, 28, 'workers 数组应有 28 项')
  assert.equal(parsed.workers[0].name, 'agy')
  assert.equal(parsed.workers[0].installed, true)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
