import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const result = spawnSync(process.execPath, ['--test', 'test/client-bundle.test.mjs'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, TRACE_INSIGHT_TEST_VARIANT: 'standard' },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
