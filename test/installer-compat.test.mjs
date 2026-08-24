import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const files = Object.fromEntries(
  ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'README.md', 'README.en.md']
    .map(name => [name, readFileSync(new URL(name, root), 'utf8')]),
)

test('release metadata and installers agree on Trace Insight 1.3.0', () => {
  assert.equal(packageJson.version, '1.3.0')
  assert.equal(packageJson.dshCompatibility.version, '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.1 || 0.1.1-rc.2')
  assert.match(files['install.sh'], /dsh-plugin-trace-insight-1\.3\.0\.tgz/u)
  assert.match(files['install.ps1'], /\$PluginVersion = '1\.3\.0'/u)
})

test('public installers and uninstallers accept every supported DSH release but not unknown releases', () => {
  for (const name of ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1']) {
    assert.match(files[name], /0\.1\.0-rc\.7/u, `${name} must accept RC.7`)
    assert.match(files[name], /0\.1\.0-rc\.8/u, `${name} must accept RC.8`)
    assert.match(files[name], /0\.1\.1-rc\.1/u, `${name} must accept 0.1.1 RC.1`)
    assert.match(files[name], /0\.1\.1-rc\.2/u, `${name} must accept 0.1.1 RC.2`)
    assert.doesNotMatch(files[name], /0\.1\.0-rc\.6/u, `${name} must reject RC.6`)
    assert.doesNotMatch(files[name], /0\.1\.1-rc\.3/u, `${name} must reject an unknown future release`)
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

test('published instructions describe the same supported DSH releases', () => {
  for (const name of ['README.md', 'README.en.md']) {
    assert.match(files[name], /0\.1\.0-rc\.7/u)
    assert.match(files[name], /0\.1\.0-rc\.8/u)
    assert.match(files[name], /0\.1\.1-rc\.1/u)
    assert.match(files[name], /0\.1\.1-rc\.2/u)
    assert.doesNotMatch(files[name], /0\.1\.0-rc\.6/u)
  }
})
