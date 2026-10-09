import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { runDelegateTask } from '../src/delegate.mjs'
import { cleanTempDir, createTempDir } from './test-helper.mjs'

export const tests = [{
  name: 'windows-launch-error-preserves-spawn-cause',
  async run() {
    if (process.platform !== 'win32') return;
    const cwd = createTempDir();
    try {
      const wrapper = join(cwd, 'invalid.cmd');
      writeFileSync(wrapper, '@echo off\r\necho unexpected\r\n');
      const config = loadConfig({ worker: 'claude', claudePath: wrapper,
        agyPath: join(cwd, 'absent.exe'), rawDir: join(cwd, 'raw'),
        ledgerPath: join(cwd, 'runs.ndjson'), workerHealth: { enabled: false },
        taskTimeoutMs: 5000 }, cwd, {});
      const result = await runDelegateTask({ config, cwd,
        args: { task_id: 'launch-error', task: 'unused' } });
      assert.match(result.diagnostic, /EINVAL/, 'must expose actual launch error');
    } finally { cleanTempDir(cwd); }
  }
}];
