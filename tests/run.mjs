#!/usr/bin/env node

import { tests as baselineTests } from './baseline.test.mjs'
import { tests as verdictTests } from './verdict.test.mjs'
import { tests as continuationTests } from './continuation.test.mjs'
import { tests as concurrencyTests } from './concurrency.test.mjs'
import { tests as ledgerTests } from './ledger.test.mjs'
import { tests as digestTests } from './digest.test.mjs'
import { tests as artifactTests } from './artifact.test.mjs'
import { tests as mcpTests } from './mcp.test.mjs'
import { tests as pathsTests } from './paths.test.mjs'
import { tests as shellTests } from './shell.test.mjs'
import { tests as teamTests } from './team.test.mjs'

const allSuites = [
  ...baselineTests,
  ...verdictTests,
  ...continuationTests,
  ...concurrencyTests,
  ...ledgerTests,
  ...digestTests,
  ...artifactTests,
  ...mcpTests,
  ...pathsTests,
  ...shellTests,
  ...teamTests,
]

async function main() {
  let passed = 0
  let failed = 0

  for (const t of allSuites) {
    try {
      await t.run()
      passed++
      console.log(`PASS ${t.name}`)
    } catch (err) {
      failed++
      console.log(`FAIL ${t.name}`)
      console.error(`     Error: ${err?.message || err}`)
      if (err?.stack) {
        console.error(`     Stack: ${err.stack.split('\n').slice(1, 4).join('\n')}`)
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('测试运行器未捕获异常:', err)
  process.exit(1)
})
