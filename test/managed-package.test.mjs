import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ManagedPackageError,
  cleanupManagedPackages,
  finalizeManagedPackage,
  inspectPluginArchive,
  migrateManagedReference,
  stageManagedPackage,
  verifyManagedReference,
} from '../scripts/managed-package.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const VERSION = '1.3.2'
const PLUGIN = 'dsh-plugin-trace-insight'
const NPM_COMMAND = 'npm'
const PNPM_COMMAND = 'pnpm'
const WINDOWS_COMMAND_SHIM = process.platform === 'win32'
const PNPM_AVAILABLE = spawnPackageManager(PNPM_COMMAND, ['--version'], { encoding: 'utf8' }).status === 0

function quoteCmdArgument(value) {
  const text = String(value)
  if (/\0|\r|\n/u.test(text)) throw new Error('Windows command arguments cannot contain control characters.')
  if (/^[0-9A-Za-z_./:@\\=+-]+$/u.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

function spawnPackageManager(command, args, options) {
  if (!WINDOWS_COMMAND_SHIM) return spawnSync(command, args, options)
  const commandLine = [command, ...args].map(quoteCmdArgument).join(' ')
  return spawnSync(commandLine, { ...options, shell: true })
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function packageArchive(root) {
  const destination = join(root, 'archive output')
  const cache = join(root, 'npm cache')
  mkdirSync(destination, { recursive: true })
  const result = spawnPackageManager(NPM_COMMAND, [
    'pack',
    '--ignore-scripts',
    '--silent',
    '--pack-destination', destination,
    '--cache', cache,
  ], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const path = join(destination, `${PLUGIN}-${VERSION}.tgz`)
  assert.ok(existsSync(path))
  return path
}

function profileManifest(dshHome, spec) {
  const path = join(dshHome, 'profiles', 'web', 'package.json')
  writeJson(path, {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { [PLUGIN]: spec },
  })
  return path
}

test('managed package validates, stages, migrates, prunes, and cleans an explicit DSH_HOME with spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'trace insight managed package '))
  try {
    const archive = packageArchive(root)
    const dshHome = join(root, 'explicit DSH home with spaces')
    const profileRoot = join(dshHome, 'profiles', 'web')
    const missingExternal = join(root, 'deleted source checkout', basename(archive))
    profileManifest(dshHome, `file:${missingExternal}`)

    const inspected = inspectPluginArchive(archive, VERSION)
    assert.equal(inspected.name, PLUGIN)
    assert.equal(inspected.version, VERSION)

    const staged = stageManagedPackage({ source: archive, version: VERSION, dshHome })
    assert.equal(staged.path, join(dshHome, 'trace-insight', 'packages', `${PLUGIN}-${VERSION}.tgz`))
    assert.ok(existsSync(staged.path))

    const migrated = migrateManagedReference({ profile: 'web', packagePath: staged.path, dshHome })
    assert.equal(migrated.state, 'migrated')
    assert.equal(verifyManagedReference({ profile: 'web', packagePath: staged.path, dshHome }).path, realpathSync(staged.path))

    const stale = join(dirname(staged.path), `${PLUGIN}-1.2.2.tgz`)
    copyFileSync(archive, stale)
    const otherProfile = join(dshHome, 'profiles', 'research', 'package.json')
    writeJson(otherProfile, {
      name: 'dsh-profile-research',
      private: true,
      dependencies: { [PLUGIN]: `file:${relative(dirname(otherProfile), stale)}` },
    })
    const finalized = finalizeManagedPackage({ profile: 'web', packagePath: staged.path, dshHome })
    assert.deepEqual(finalized.removed, [])
    assert.ok(existsSync(stale))

    assert.throws(
      () => cleanupManagedPackages({ profile: 'web', dshHome }),
      error => error instanceof ManagedPackageError && /仍在引用/u.test(error.message),
    )
    assert.ok(existsSync(staged.path))

    const manifestPath = join(profileRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    delete manifest.dependencies[PLUGIN]
    writeJson(manifestPath, manifest)
    const partiallyCleaned = cleanupManagedPackages({ profile: 'web', dshHome })
    assert.equal(existsSync(staged.path), false)
    assert.ok(existsSync(stale))
    assert.deepEqual(partiallyCleaned.retained, [stale])

    const researchManifest = JSON.parse(readFileSync(otherProfile, 'utf8'))
    delete researchManifest.dependencies[PLUGIN]
    writeJson(otherProfile, researchManifest)
    cleanupManagedPackages({ profile: 'research', dshHome })
    assert.equal(existsSync(stale), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed package defaults to DSH_HOME under the user home without touching the real home', () => {
  const root = mkdtempSync(join(tmpdir(), 'trace insight default home '))
  try {
    const archive = packageArchive(root)
    const fakeHome = join(root, 'user home with spaces')
    mkdirSync(fakeHome, { recursive: true })
    const environment = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome }
    delete environment.DSH_HOME
    const result = spawnSync(process.execPath, [
      join(ROOT, 'scripts', 'managed-package.mjs'),
      'stage', '--source', archive, '--version', VERSION,
    ], { encoding: 'utf8', env: environment })
    assert.equal(result.status, 0, result.stderr)
    const expected = join(fakeHome, '.dsh', 'trace-insight', 'packages', `${PLUGIN}-${VERSION}.tgz`)
    assert.equal(result.stdout.trim(), expected)
    assert.ok(existsSync(expected))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real pnpm recovers a broken external archive and accepts a later local plugin', {
  skip: !PNPM_AVAILABLE,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'trace insight real pnpm '))
  try {
    const sourceArchive = packageArchive(root)
    const dshHome = join(root, 'DSH HOME with spaces')
    const profileRoot = join(dshHome, 'profiles', 'web')
    const store = join(root, 'pnpm store with spaces')
    profileManifest(dshHome, `file:${sourceArchive}`)
    const environment = {
      ...process.env,
      CI: 'true',
      npm_config_cache: join(root, 'npm cache for pnpm'),
      npm_config_ignore_scripts: 'true',
      npm_config_store_dir: store,
    }
    const pnpm = args => runPackageManager(PNPM_COMMAND, args, {
      cwd: profileRoot,
      env: environment,
    })

    const installed = pnpm(['install'])
    assert.equal(installed.status, 0, installed.combined)
    const staged = stageManagedPackage({ source: sourceArchive, version: VERSION, dshHome })
    rmSync(dirname(sourceArchive), { recursive: true, force: true })
    assert.equal(existsSync(sourceArchive), false)

    const otherSource = join(root, 'other package source')
    writeJson(join(otherSource, 'package.json'), { name: 'other-local-plugin', version: '1.0.0', main: 'index.js' })
    writeFileSync(join(otherSource, 'index.js'), 'module.exports = {}\n')
    const otherOutput = join(root, 'other package archive')
    mkdirSync(otherOutput, { recursive: true })
    const packedOther = runPackageManager(NPM_COMMAND, [
      'pack', '--ignore-scripts', '--silent', '--pack-destination', otherOutput,
      '--cache', join(root, 'other npm cache'),
    ], { cwd: otherSource, env: environment })
    assert.equal(packedOther.status, 0, packedOther.combined)
    const otherArchive = join(otherOutput, 'other-local-plugin-1.0.0.tgz')

    const brokenAdd = pnpm(['add', otherArchive])
    assert.notEqual(brokenAdd.status, 0)
    assert.match(brokenAdd.combined, /ENOENT|no such file/iu)

    const migrated = migrateManagedReference({ profile: 'web', packagePath: staged.path, dshHome })
    assert.equal(migrated.state, 'migrated')
    const repaired = pnpm(['add', staged.path])
    assert.equal(repaired.status, 0, repaired.combined)
    finalizeManagedPackage({ profile: 'web', packagePath: staged.path, dshHome })

    const listed = pnpm(['list', '--depth=0'])
    assert.equal(listed.status, 0, listed.combined)
    const addedOther = pnpm(['add', otherArchive])
    assert.equal(addedOther.status, 0, addedOther.combined)
    const lock = readFileSync(join(profileRoot, 'pnpm-lock.yaml'), 'utf8')
    assert.doesNotMatch(lock, /archive output/u)
    assert.ok(JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8')).dependencies['other-local-plugin'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function copyInstallMedia(target, { install = true, uninstall = true } = {}) {
  mkdirSync(target, { recursive: true })
  for (const name of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']) {
    copyFileSync(join(ROOT, name), join(target, name))
  }
  for (const name of ['src', 'patches', 'scripts']) cpSync(join(ROOT, name), join(target, name), { recursive: true })
  if (install) {
    copyFileSync(join(ROOT, 'install.sh'), join(target, 'install.sh'))
    chmodSync(join(target, 'install.sh'), 0o755)
  }
  if (uninstall) {
    copyFileSync(join(ROOT, 'uninstall.sh'), join(target, 'uninstall.sh'))
    chmodSync(join(target, 'uninstall.sh'), 0o755)
  }
}

function createOriginalDshTree(installRoot, version = '0.1.1-rc.2') {
  const dshRoot = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const webAppRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  const layoutRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout')
  writeJson(join(dshRoot, 'package.json'), { name: '@deepseek-ai/dsh', version })
  writeJson(join(webAppRoot, 'package.json'), {
    name: '@deepseek-ai/dsh-web-app',
    version,
    exports: { './package.json': './package.json' },
  })
  writeJson(join(layoutRoot, 'package.json'), {
    name: '@deepseek-ai/dsh-client-ui-layout',
    version,
    exports: { './package.json': './package.json' },
  })
  const targets = [
    ['client.js', 'lib/client.js'],
    ['index.d.ts', 'lib/types/client/index.d.ts'],
    ['service.d.ts', 'lib/types/client/service.d.ts'],
    ['stores.d.ts', 'lib/types/client/stores.d.ts'],
    ['AppFrame.d.ts', 'lib/types/client/AppFrame.d.ts'],
  ]
  const originals = {}
  const patched = {}
  for (const [payload, target] of targets) {
    const targetPath = join(layoutRoot, target)
    mkdirSync(dirname(targetPath), { recursive: true })
    const original = `synthetic original:${payload}\n`
    const replacement = `synthetic patched:${payload}\n`
    writeFileSync(targetPath, original)
    originals[payload] = createHash('sha256').update(original).digest('hex')
    patched[payload] = createHash('sha256').update(replacement).digest('hex')
  }
  return { dshRoot, layoutRoot, targets, originals, patched, version }
}

function configureSyntheticShellPatch(mediaRoot, tree, additionalTrees = []) {
  const files = tree.targets.map(([name, target]) => {
    const payload = join('dsh-client-ui-layout', name)
    const payloadPath = join(mediaRoot, 'patches', payload)
    mkdirSync(dirname(payloadPath), { recursive: true })
    writeFileSync(payloadPath, `synthetic patched:${name}\n`)
    return { name, target, payload, patchedSha256: tree.patched[name] }
  })
  writeJson(join(mediaRoot, 'patches', 'shell-patch-manifest.json'), {
    schemaVersion: 1,
    patchId: 'synthetic-installer-lifecycle',
    targetPackage: '@deepseek-ai/dsh-client-ui-layout',
    files,
    targets: [tree, ...additionalTrees].map((targetTree, index) => ({
      id: `synthetic-${index}-${targetTree.version}`,
      dshVersions: [targetTree.version],
      webAppVersions: [targetTree.version],
      layoutVersion: targetTree.version,
      originalSha256: targetTree.originals,
    })),
  })
}

const FAKE_DSH = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex === -1 ? 'web' : args[profileIndex + 1]
const profileRoot = path.join(dshHome, 'profiles', profile)
const manifestPath = path.join(profileRoot, 'package.json')

function readManifest() {
  if (!fs.existsSync(manifestPath)) return { name: 'dsh-profile-' + profile, private: true, dependencies: {} }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}
function writeManifest(value) {
  fs.mkdirSync(profileRoot, { recursive: true })
  const stage = manifestPath + '.' + process.pid + '.tmp'
  fs.writeFileSync(stage, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(stage, manifestPath)
}
function fromFileSpec(spec) {
  let value = decodeURIComponent(spec.slice('file:'.length))
  return path.isAbsolute(value) ? value : path.resolve(profileRoot, value)
}
function validateAll() {
  const manifest = readManifest()
  for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
    if (typeof spec === 'string' && spec.startsWith('file:') && !fs.existsSync(fromFileSpec(spec))) {
      console.error('ENOENT: missing dependency archive for ' + name + ': ' + fromFileSpec(spec))
      process.exit(44)
    }
  }
}
function localSpec(target) {
  return 'file:' + path.relative(profileRoot, target).split(path.sep).join('/')
}

if (args.length === 1 && args[0] === '--version') {
  console.log('0.1.1-rc.2')
  process.exit(0)
}
if (args[0] === 'plugin') {
  validateAll()
  const operation = args[profileIndex + 2]
  if (operation === 'add') {
    if (process.env.FAKE_DSH_ADD_FAIL === '1') process.exit(48)
    const target = path.resolve(args[profileIndex + 3])
    if (!fs.existsSync(target)) {
      console.error('ENOENT: ' + target)
      process.exit(45)
    }
    const name = path.basename(target).startsWith('dsh-plugin-trace-insight-')
      ? 'dsh-plugin-trace-insight'
      : 'other-local-plugin'
    const manifest = readManifest()
    manifest.dependencies ||= {}
    manifest.dependencies[name] = localSpec(target)
    writeManifest(manifest)
    const installed = path.join(profileRoot, 'node_modules', name)
    fs.mkdirSync(installed, { recursive: true })
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name, version: 'test', main: 'index.js' }))
    fs.writeFileSync(path.join(installed, 'index.js'), 'module.exports = {}\n')
    process.exit(0)
  }
  if (operation === 'remove') {
    if (process.env.FAKE_DSH_REMOVE_FAIL === '1') process.exit(46)
    const name = args[profileIndex + 3]
    const manifest = readManifest()
    delete manifest.dependencies?.[name]
    writeManifest(manifest)
    fs.rmSync(path.join(profileRoot, 'node_modules', name), { recursive: true, force: true })
    process.exit(0)
  }
  if (operation === 'list' || operation === 'install') {
    console.log(Object.keys(readManifest().dependencies || {}).join('\n'))
    process.exit(0)
  }
}
if (args[0] === '--profile' && args.includes('--dump-config')) {
  validateAll()
  if (readManifest().dependencies?.['dsh-plugin-trace-insight']) console.log('name: dsh-plugin-trace-insight')
  process.exit(0)
}
console.error('unsupported fake dsh invocation: ' + args.join(' '))
process.exit(47)
`

function createFakeCommand(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function shellDoubleQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`
}

function createToolShims(fakeBin, { fakeDsh, activeNpxBin, globalRoot }) {
  const npmPath = spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim()
  assert.ok(npmPath)
  createFakeCommand(join(fakeBin, 'node'), `#!/bin/sh\nexec ${shellDoubleQuote(process.execPath)} "$@"\n`)
  createFakeCommand(join(fakeBin, 'npm'), `#!/bin/sh
if [ "$1" = "root" ] && [ "$2" = "--global" ]; then
  printf '%s\\n' ${shellDoubleQuote(globalRoot)}
  exit 0
fi
exec ${shellDoubleQuote(npmPath)} "$@"
`)
  createFakeCommand(join(fakeBin, 'npx'), `#!/bin/sh
shift 2
tool="$1"
shift
if [ "$tool" = "dsh" ]; then exec ${shellDoubleQuote(fakeDsh)} "$@"; fi
if [ "$tool" = "node" ]; then PATH=${shellDoubleQuote(`${activeNpxBin}:${fakeBin}:/usr/bin:/bin`)} exec ${shellDoubleQuote(process.execPath)} "$@"; fi
echo "unsupported fake npx tool: $tool" >&2
exit 49
`)
  createFakeCommand(join(fakeBin, 'lsof'), '#!/bin/sh\nexit 1\n')
  createFakeCommand(join(fakeBin, 'pgrep'), '#!/bin/sh\nexit 1\n')
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { ...result, combined: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function runPackageManager(command, args, options) {
  const result = spawnPackageManager(command, args, { encoding: 'utf8', ...options })
  return { ...result, combined: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('shell installer migrates a missing external file reference and survives source deletion and later plugin changes', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync('/private/tmp/trace insight shell lifecycle ')
  try {
    const installRoot = join(root, 'fake DSH installation')
    const fakeBin = join(installRoot, 'bin')
    const tree = createOriginalDshTree(installRoot)
    const dshRoot = tree.dshRoot
    mkdirSync(fakeBin, { recursive: true })
    createFakeCommand(join(fakeBin, 'dsh'), FAKE_DSH)
    createFakeCommand(join(fakeBin, 'npx'), `#!/bin/sh\nshift 3\nexec "${join(fakeBin, 'dsh')}" "$@"\n`)
    createFakeCommand(join(fakeBin, 'lsof'), '#!/bin/sh\nexit 1\n')
    createFakeCommand(join(fakeBin, 'pgrep'), '#!/bin/sh\nexit 1\n')

    const dshHome = join(root, 'explicit DSH HOME with spaces')
    const profileRoot = join(dshHome, 'profiles', 'web')
    const deletedArchive = join(root, 'deleted original checkout', `${PLUGIN}-${VERSION}.tgz`)
    profileManifest(dshHome, `file:${deletedArchive}`)
    assert.equal(existsSync(deletedArchive), false)

    const source = join(root, 'source checkout with spaces')
    const uninstallMedia = join(root, 'separate uninstall media with spaces')
    copyInstallMedia(source)
    copyInstallMedia(uninstallMedia, { install: false, uninstall: true })
    configureSyntheticShellPatch(source, tree)
    configureSyntheticShellPatch(uninstallMedia, tree)
    const environment = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_PACKAGE_ROOT: dshRoot,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TMPDIR: join(root, 'temporary files with spaces'),
      npm_config_cache: join(root, 'npm cache with spaces'),
    }
    mkdirSync(environment.TMPDIR, { recursive: true })

    const initialPatch = run(process.execPath, [
      join(source, 'patches', 'shell-patch.mjs'),
      'status', '--dsh-root', dshRoot, '--json',
    ], { cwd: source, env: environment })
    assert.equal(initialPatch.status, 0, initialPatch.combined)
    assert.equal(JSON.parse(initialPatch.stdout).state, 'original')

    const first = run('bash', [join(source, 'install.sh')], { cwd: source, env: environment })
    assert.equal(first.status, 0, first.combined)
    const second = run('bash', [join(source, 'install.sh')], { cwd: source, env: environment })
    assert.equal(second.status, 0, second.combined)
    for (const [name, target] of tree.targets) {
      assert.equal(createHash('sha256').update(readFileSync(join(tree.layoutRoot, target))).digest('hex'), tree.patched[name])
    }

    const stable = join(dshHome, 'trace-insight', 'packages', `${PLUGIN}-${VERSION}.tgz`)
    assert.ok(existsSync(stable))
    assert.equal(verifyManagedReference({ profile: 'web', packagePath: stable, dshHome }).path, realpathSync(stable))
    const installedSpec = JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8')).dependencies[PLUGIN]
    assert.doesNotMatch(installedSpec, /source checkout with spaces/u)
    assert.equal(existsSync(join(source, `${PLUGIN}-${VERSION}.tgz`)), false)

    const failedReinstall = run('bash', [join(source, 'install.sh')], {
      cwd: source,
      env: { ...environment, FAKE_DSH_ADD_FAIL: '1' },
    })
    assert.notEqual(failedReinstall.status, 0)
    assert.ok(existsSync(stable))
    assert.ok(JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8')).dependencies[PLUGIN])

    rmSync(source, { recursive: true, force: true })
    assert.equal(existsSync(source), false)
    const list = run(join(fakeBin, 'dsh'), ['plugin', '--profile', 'web', 'list'], { env: environment })
    assert.equal(list.status, 0, list.combined)

    const installedRequire = createRequire(join(profileRoot, 'package.json'))
    assert.equal(installedRequire.resolve(`${PLUGIN}/package.json`), join(profileRoot, 'node_modules', PLUGIN, 'package.json'))

    const otherArchive = join(root, 'other plugin source with spaces', 'other-local-plugin.tgz')
    mkdirSync(dirname(otherArchive), { recursive: true })
    writeFileSync(otherArchive, 'other plugin fixture')
    const addOther = run(join(fakeBin, 'dsh'), ['plugin', '--profile', 'web', 'add', otherArchive], { env: environment })
    assert.equal(addOther.status, 0, addOther.combined)

    const failedEnvironment = { ...environment, FAKE_DSH_REMOVE_FAIL: '1' }
    const failedRemove = run('bash', [join(uninstallMedia, 'uninstall.sh')], { cwd: uninstallMedia, env: failedEnvironment })
    assert.notEqual(failedRemove.status, 0)
    assert.ok(existsSync(stable))
    assert.ok(JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8')).dependencies[PLUGIN])
    for (const [name, target] of tree.targets) {
      assert.equal(createHash('sha256').update(readFileSync(join(tree.layoutRoot, target))).digest('hex'), tree.patched[name])
    }

    const removed = run('bash', [join(uninstallMedia, 'uninstall.sh')], { cwd: uninstallMedia, env: environment })
    assert.equal(removed.status, 0, removed.combined)
    const finalManifest = JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8'))
    assert.equal(finalManifest.dependencies[PLUGIN], undefined)
    assert.ok(finalManifest.dependencies['other-local-plugin'])
    assert.equal(existsSync(stable), false)
    for (const [name, target] of tree.targets) {
      assert.equal(createHash('sha256').update(readFileSync(join(tree.layoutRoot, target))).digest('hex'), tree.originals[name])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Shell and PowerShell entrypoints use the shared persistent lifecycle in the same order', () => {
  const shellInstall = readFileSync(join(ROOT, 'install.sh'), 'utf8')
  const shellUninstall = readFileSync(join(ROOT, 'uninstall.sh'), 'utf8')
  const psInstall = readFileSync(join(ROOT, 'install.ps1'), 'utf8')
  const psUninstall = readFileSync(join(ROOT, 'uninstall.ps1'), 'utf8')

  for (const [name, body] of [['install.sh', shellInstall], ['install.ps1', psInstall]]) {
    const stage = body.indexOf("'stage'") === -1 ? body.indexOf(' stage ') : body.indexOf("'stage'")
    const migrate = body.indexOf("'migrate'") === -1 ? body.indexOf(' migrate ') : body.indexOf("'migrate'")
    const add = name === 'install.sh'
      ? body.indexOf('add "$MANAGED_PACKAGE"')
      : body.indexOf("'add', $managedPackagePath")
    const finalize = body.indexOf("'finalize'") === -1 ? body.indexOf(' finalize ') : body.indexOf("'finalize'")
    assert.ok(stage >= 0 && migrate > stage && add > migrate && finalize > add, `${name} lifecycle order`)
    assert.match(body, /--pack-destination/u)
  }
  assert.doesNotMatch(shellInstall, /plugin --profile "\$PROFILE" add "\$PACKAGE"/u)
  assert.doesNotMatch(psInstall, /'add', \$PackagePath/u)

  for (const [name, body] of [['uninstall.sh', shellUninstall], ['uninstall.ps1', psUninstall]]) {
    const remove = body.indexOf('remove')
    const cleanup = body.indexOf('cleanup')
    assert.ok(remove >= 0 && cleanup > remove, `${name} cleanup must follow successful removal`)
  }
})

test('shell lifecycle works with npx only and with global plus npx roots without cross-root state loss', {
  skip: process.platform === 'win32',
}, () => {
  for (const mode of ['npx-only', 'global-and-npx']) {
    const root = mkdtempSync(join(tmpdir(), `trace insight ${mode} `))
    try {
      const media = join(root, 'installer media with spaces')
      const dshHome = join(root, 'DSH HOME with spaces')
      const cacheRoot = join(root, 'npm cache with spaces')
      const npxInstallRoot = join(cacheRoot, '_npx', 'active')
      const npxTree = createOriginalDshTree(npxInstallRoot)
      const staleNpxTree = mode === 'global-and-npx'
        ? createOriginalDshTree(join(cacheRoot, '_npx', 'stale-old-version'), '0.1.0-rc.7')
        : undefined
      const activeNpxBin = join(npxInstallRoot, 'node_modules', '.bin')
      mkdirSync(activeNpxBin, { recursive: true })

      const globalTree = mode === 'global-and-npx'
        ? createOriginalDshTree(join(root, 'global DSH installation'))
        : undefined
      copyInstallMedia(media)
      configureSyntheticShellPatch(media, npxTree, staleNpxTree ? [staleNpxTree] : [])

      const fakeBin = join(root, 'command shims')
      const hiddenBin = join(root, 'hidden commands')
      mkdirSync(fakeBin, { recursive: true })
      mkdirSync(hiddenBin, { recursive: true })
      const fakeDsh = join(hiddenBin, 'dsh-handler')
      createFakeCommand(fakeDsh, FAKE_DSH)
      createToolShims(fakeBin, {
        fakeDsh,
        activeNpxBin,
        globalRoot: join(root, 'empty npm global root'),
      })
      const globalBin = globalTree ? join(root, 'global DSH installation', 'bin') : undefined
      if (globalBin) {
        mkdirSync(globalBin, { recursive: true })
        createFakeCommand(join(globalBin, 'dsh'), FAKE_DSH)
      }

      const environment = {
        ...process.env,
        DSH_HOME: dshHome,
        PATH: `${globalBin ? `${globalBin}${delimiter}` : ''}${fakeBin}${delimiter}/usr/bin${delimiter}/bin`,
        TMPDIR: join(root, 'temporary files with spaces'),
        npm_config_cache: cacheRoot,
      }
      delete environment.DSH_PACKAGE_ROOT
      mkdirSync(environment.TMPDIR, { recursive: true })

      if (staleNpxTree) {
        const discovered = run(process.execPath, [join(media, 'patches', 'shell-patch.mjs'), 'status-all', '--json'], {
          cwd: media,
          env: environment,
        })
        assert.equal(discovered.status, 0, discovered.combined)
        const status = JSON.parse(discovered.stdout)
        assert.equal(status.installations.length, 2)
        assert.deepEqual(status.ignoredInactive.map(item => item.root), [realpathSync(staleNpxTree.dshRoot)])
      }

      const failedFresh = run('bash', [join(media, 'install.sh')], {
        cwd: media,
        env: { ...environment, FAKE_DSH_ADD_FAIL: '1' },
      })
      assert.notEqual(failedFresh.status, 0, `${mode} fresh failure must be reported`)
      for (const tree of (globalTree ? [globalTree, npxTree] : [npxTree])) {
        for (const [name, target] of tree.targets) {
          assert.equal(
            createHash('sha256').update(readFileSync(join(tree.layoutRoot, target))).digest('hex'),
            tree.originals[name],
            `${mode} fresh failure restored ${name}`,
          )
        }
      }

      const first = run('bash', [join(media, 'install.sh')], { cwd: media, env: environment })
      assert.equal(first.status, 0, `${mode}: ${first.combined}`)
      const second = run('bash', [join(media, 'install.sh')], { cwd: media, env: environment })
      assert.equal(second.status, 0, `${mode} repeat: ${second.combined}`)

      const trees = globalTree ? [globalTree, npxTree] : [npxTree]
      for (const tree of trees) {
        for (const [name, target] of tree.targets) {
          assert.equal(
            createHash('sha256').update(readFileSync(join(tree.layoutRoot, target))).digest('hex'),
            tree.patched[name],
            `${mode} patched ${name}`,
          )
        }
      }
      const stateRoot = join(dshHome, 'trace-insight', 'shell-patches')
      assert.equal(readdirSync(stateRoot).filter(name => existsSync(join(stateRoot, name, 'active.json'))).length, trees.length)
      if (staleNpxTree) {
        for (const [name, target] of staleNpxTree.targets) {
          assert.equal(
            createHash('sha256').update(readFileSync(join(staleNpxTree.layoutRoot, target))).digest('hex'),
            staleNpxTree.originals[name],
            `inactive cache preserved ${name}`,
          )
        }
      }

      const removed = run('bash', [join(media, 'uninstall.sh')], { cwd: media, env: environment })
      assert.equal(removed.status, 0, `${mode} uninstall: ${removed.combined}`)
      for (const tree of trees) {
        for (const [name, target] of tree.targets) {
          assert.equal(
            createHash('sha256').update(readFileSync(join(tree.layoutRoot, target))).digest('hex'),
            tree.originals[name],
            `${mode} restored ${name}`,
          )
        }
      }
      const removedAgain = run('bash', [join(media, 'uninstall.sh')], { cwd: media, env: environment })
      assert.equal(removedAgain.status, 0, `${mode} repeated uninstall: ${removedAgain.combined}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
