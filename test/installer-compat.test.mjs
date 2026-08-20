import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const files = Object.fromEntries(
  ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'README.md', 'README.en.md']
    .map(name => [name, readFileSync(new URL(name, root), 'utf8')]),
)

test('release metadata and installers agree on Trace Insight 1.2.0', () => {
  assert.equal(packageJson.version, '1.2.0')
  assert.equal(packageJson.dshCompatibility.version, '0.1.0-rc.7 || 0.1.0-rc.8')
  assert.match(files['install.sh'], /dsh-plugin-trace-insight-1\.2\.0\.tgz/u)
  assert.match(files['install.ps1'], /\$PluginVersion = '1\.2\.0'/u)
})

test('public installers and uninstallers accept RC.7 and RC.8 but not RC.6', () => {
  for (const name of ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1']) {
    assert.match(files[name], /0\.1\.0-rc\.7/u, `${name} must accept RC.7`)
    assert.match(files[name], /0\.1\.0-rc\.8/u, `${name} must accept RC.8`)
    assert.doesNotMatch(files[name], /0\.1\.0-rc\.6/u, `${name} must reject RC.6`)
  }
})

test('public lifecycle uses one global DSH installation and never downloads a hidden npx copy', () => {
  assert.equal(packageJson.files.includes('scripts/find-npx-dsh.mjs'), false)
  for (const name of ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'README.md', 'README.en.md']) {
    assert.doesNotMatch(files[name], /npx\s+(?:--yes\s+)?@deepseek-ai\/dsh/u, `${name} must not launch a temporary DSH`)
  }
  assert.match(files['install.sh'], /command -v dsh/u)
  assert.match(files['uninstall.sh'], /command -v dsh/u)
  assert.match(files['install.ps1'], /Get-Command dsh/u)
  assert.match(files['uninstall.ps1'], /Get-Command dsh/u)
})

test('published instructions describe the same RC.7 and RC.8 requirement', () => {
  for (const name of ['README.md', 'README.en.md']) {
    assert.match(files[name], /0\.1\.0-rc\.7/u)
    assert.match(files[name], /0\.1\.0-rc\.8/u)
    assert.doesNotMatch(files[name], /0\.1\.0-rc\.6/u)
  }
})
