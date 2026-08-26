import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const files = Object.fromEntries(
  ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'README.md', 'README.en.md']
    .map(name => [name, readFileSync(new URL(name, root), 'utf8')]),
)

test('release metadata and installers agree on Trace Insight 1.3.2', () => {
  assert.equal(packageJson.version, '1.3.2')
  assert.equal(packageJson.dshCompatibility.version, '0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.1-rc.1 || 0.1.1-rc.2')
  assert.match(files['install.sh'], /PLUGIN_VERSION="1\.3\.2"/u)
  assert.match(files['install.sh'], /dsh-plugin-trace-insight-\$PLUGIN_VERSION\.tgz/u)
  assert.match(files['install.ps1'], /\$PluginVersion = '1\.3\.2'/u)
})

test('public lifecycle prefers a global DSH and falls back to the exact active npx installation', () => {
  assert.equal(packageJson.files.includes('scripts/find-npx-dsh.mjs'), true)
  for (const name of ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1']) {
    assert.doesNotMatch(files[name], /0\.1\.1-rc\.2/u, `${name} must not force one DSH release`)
  }
  assert.match(files['install.sh'], /command -v npx/u)
  assert.match(files['install.sh'], /command -v dsh/u)
  assert.match(files['uninstall.sh'], /command -v npx/u)
  assert.match(files['uninstall.sh'], /command -v dsh/u)
  assert.match(files['install.ps1'], /Get-Command npx/u)
  assert.match(files['install.ps1'], /Get-Command dsh/u)
  assert.match(files['uninstall.ps1'], /Get-Command npx/u)
  assert.match(files['uninstall.ps1'], /Get-Command dsh/u)
  assert.match(files['install.ps1'], /\$null = Ensure-Pnpm/u)
  assert.match(files['uninstall.ps1'], /\$null = Ensure-Pnpm/u)
  for (const name of ['install.ps1', 'uninstall.ps1']) {
    const guard = files[name].indexOf("throw '未找到全局 dsh 或 npx。'")
    const ensure = files[name].indexOf('$null = Ensure-Pnpm')
    assert.ok(guard >= 0 && ensure > guard, `${name} must fail before Ensure-Pnpm when no DSH runner exists`)
  }
  assert.match(files['install.sh'], /status-all/u)
  assert.match(files['install.sh'], /apply-all/u)
  assert.match(files['uninstall.sh'], /restore-all/u)
})

test('published instructions describe global, npx-only, and coexisting DSH installations', () => {
  for (const name of ['README.md', 'README.en.md']) {
    assert.doesNotMatch(files[name], /0\.1\.1-rc\.2/u)
    assert.match(files[name], /dsh web/u)
    assert.match(files[name], /npx/u)
  }
})

test('shell install and uninstall fail without global dsh or npx before writing user state', {
  skip: process.platform === 'win32',
}, () => {
  const taskRoot = mkdtempSync(join(tmpdir(), 'trace insight no runner '))
  try {
    const fakeBin = join(taskRoot, 'bin')
    const temporary = join(taskRoot, 'temporary')
    const dshHome = join(taskRoot, 'DSH HOME must stay absent')
    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(temporary, { recursive: true })
    const commands = {
      node: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      lsof: '#!/bin/sh\nexit 1\n',
      pgrep: '#!/bin/sh\nexit 1\n',
    }
    for (const [name, body] of Object.entries(commands)) {
      const path = join(fakeBin, name)
      writeFileSync(path, body)
      chmodSync(path, 0o755)
    }
    const environment = {
      ...process.env,
      DSH_HOME: dshHome,
      HOME: join(taskRoot, 'user home must stay absent'),
      PATH: `${fakeBin}:/usr/bin:/bin`,
      TMPDIR: temporary,
    }
    delete environment.DSH_PACKAGE_ROOT

    for (const name of ['install.sh', 'uninstall.sh']) {
      const result = spawnSync('/bin/bash', [join(rootPath, name)], {
        cwd: rootPath,
        encoding: 'utf8',
        env: environment,
      })
      assert.notEqual(result.status, 0, `${name} must reject a missing runner`)
      assert.match(`${result.stdout}${result.stderr}`, /Neither a global dsh command nor npx is available/u)
      assert.equal(existsSync(dshHome), false, `${name} must not create DSH_HOME`)
      assert.deepEqual(readdirSync(temporary), [], `${name} must not create temporary build output`)
    }
  } finally {
    rmSync(taskRoot, { recursive: true, force: true })
  }
})
