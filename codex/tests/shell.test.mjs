import assert from 'node:assert/strict'
import { evaluateBaseline, runVerify } from '../src/verify.mjs'

export const tests = [
  {
    name: 'shell-resolves',
    async run() {
      // 不传任何 shellArgv 覆盖，用一个真实命令 node -e "process.exit(0)" 走 runVerify
      const results = await runVerify({
        cwd: process.cwd(),
        commands: ['node -e "process.exit(0)"'],
      })
      assert.equal(results.length, 1)
      assert.equal(results[0].ran, true, '命令必须真正跑起来')
      assert.equal(results[0].ok, true, 'exit 0 判定为 ok: true')
      assert.equal(results[0].exitCode, 0)
    },
  },
  {
    name: 'shell-exit1-is-proceed',
    async run() {
      // node -e "process.exit(1)" 走 runVerify
      const results = await runVerify({
        cwd: process.cwd(),
        commands: ['node -e "process.exit(1)"'],
      })
      assert.equal(results.length, 1)
      assert.equal(results[0].ran, true, '命令必须真正跑起来')
      assert.equal(results[0].ok, false, 'exit 1 判定为 ok: false')
      assert.equal(results[0].exitCode, 1)

      const evalResult = evaluateBaseline(results)
      assert.equal(
        evalResult.decision,
        'proceed',
        '跑了且失败 = 问题仍在 = 放行 proceed，绝不是工具故障',
      )
    },
  },
  {
    name: 'shell-unresolvable-diagnostic',
    async run() {
      const nonexistentCmd = 'non_existent_shell_cmd_123456789'
      const customEnv = {
        ...process.env,
        WOLFPACK_SHELL: nonexistentCmd,
      }
      const results = await runVerify({
        cwd: process.cwd(),
        commands: ['node -e "process.exit(0)"'],
        env: customEnv,
      })
      assert.equal(results.length, 1)
      assert.equal(results[0].ran, false, '不存在的 shell 不应该成功执行')

      const err = results[0].error || results[0].tail
      assert(err, '必须包含错误诊断信息')
      // 断言产出的诊断里含候选列表 / WOLFPACK_SHELL 提示，而不是裸 ENOENT
      assert.match(err, /WOLFPACK_SHELL/i)
      assert.match(err, /请设置 WOLFPACK_SHELL/i)
      assert.match(err, /候选/i)
    },
  },
]
