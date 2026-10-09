import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
for (const edition of ['universal', 'codex']) {
  console.log(`\nWolfpack: ${edition}`)
  const result = spawnSync(process.execPath, ['tests/run.mjs'], {
    cwd: fileURLToPath(new URL(`../${edition}/`, import.meta.url)),
    stdio: 'inherit', windowsHide: true,
  })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
