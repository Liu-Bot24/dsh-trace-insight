import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  ShellPatchError,
  activeStatePathForRoot,
  applyAllShellPatches,
  applyShellPatch,
  inspectShellPatch,
  listActiveShellPatchStates,
  loadShellPatchManifest,
  restoreActiveShellPatch,
  restoreAllShellPatches,
  restoreShellPatch,
  sha256,
} from '../patches/shell-patch.mjs'

const FILES = [
  ['client.js', 'lib/client.js'],
  ['index.d.ts', 'lib/types/client/index.d.ts'],
  ['service.d.ts', 'lib/types/client/service.d.ts'],
  ['stores.d.ts', 'lib/types/client/stores.d.ts'],
  ['AppFrame.d.ts', 'lib/types/client/AppFrame.d.ts'],
]

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trace-insight-shell-test-'))
  const installRoot = join(root, 'install')
  const dshRoot = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const webAppRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  const layoutRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout')
  const payloadRoot = join(root, 'payloads')
  const backupRoot = join(root, 'backups')
  writeJson(join(dshRoot, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-test.1' })
  writeJson(join(webAppRoot, 'package.json'), {
    name: '@deepseek-ai/dsh-web-app',
    version: '0.1.0-test.1',
    exports: { './package.json': './package.json' },
  })
  writeJson(join(layoutRoot, 'package.json'), {
    name: '@deepseek-ai/dsh-client-ui-layout',
    version: '0.1.0-test.1',
    exports: { './package.json': './package.json' },
  })

  const originals = {}
  const patched = {}
  const files = FILES.map(([name, target]) => {
    const original = `original:${name}\n`
    const replacement = `patched:${name}\n`
    const targetPath = join(layoutRoot, target)
    const payloadPath = join(payloadRoot, name)
    mkdirSync(dirname(targetPath), { recursive: true })
    mkdirSync(dirname(payloadPath), { recursive: true })
    writeFileSync(targetPath, original)
    writeFileSync(payloadPath, replacement)
    originals[name] = digest(original)
    patched[name] = digest(replacement)
    return { name, target, payload: name, patchedSha256: patched[name] }
  })
  const manifest = {
    schemaVersion: 1,
    patchId: 'synthetic-test',
    targetPackage: '@deepseek-ai/dsh-client-ui-layout',
    payloadRoot,
    files,
    targets: [{
      id: 'synthetic-target',
      dshVersions: ['0.1.0-test.1'],
      webAppVersions: ['0.1.0-test.1'],
      layoutVersion: '0.1.0-test.1',
      originalSha256: originals,
    }],
  }
  return {
    root,
    installRoot,
    dshRoot,
    webAppRoot,
    layoutRoot,
    payloadRoot,
    backupRoot,
    manifest,
    originals,
    patched,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('shared patcher applies, reports idempotently, and restores every file', () => {
  const subject = fixture()
  try {
    const applied = applyShellPatch({
      dshRoot: subject.installRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(applied.state, 'patched')
    assert.ok(existsSync(join(applied.backupDirectory, 'manifest.json')))
    const activeStates = listActiveShellPatchStates({ backupRoot: subject.backupRoot })
    assert.equal(activeStates.length, 1, JSON.stringify(activeStates))
    assert.ok(existsSync(activeStates[0].statePath))
    assert.equal(activeStates[0].statePath, activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot }))
    for (const [name, target] of FILES) {
      assert.equal(sha256(join(subject.layoutRoot, target)), subject.patched[name])
      assert.equal(sha256(join(applied.backupDirectory, name)), subject.originals[name])
    }

    const backupEntries = readdirSync(subject.backupRoot)
    const second = applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(second.state, 'already-patched')
    assert.deepEqual(readdirSync(subject.backupRoot), backupEntries)

    const restored = restoreActiveShellPatch({
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(restored.state, 'restored')
    assert.equal(existsSync(activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot })), false)
    for (const [name, target] of FILES) {
      assert.equal(sha256(join(subject.layoutRoot, target)), subject.originals[name])
    }
    assert.equal(restoreShellPatch(applied.backupDirectory, { manifest: subject.manifest }).state, 'already-original')
  } finally {
    subject.cleanup()
  }
})

test('restore-active is a no-op when the integrated inspector was not installed', () => {
  const subject = fixture()
  try {
    const result = restoreActiveShellPatch({
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(result.state, 'not-installed')
    assert.equal(existsSync(subject.backupRoot), false)
  } finally {
    subject.cleanup()
  }
})

test('an already patched install reconnects to its exact backup before uninstall', () => {
  const subject = fixture()
  try {
    const applied = applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    rmSync(activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot }))

    const adopted = applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(adopted.state, 'already-patched')
    assert.equal(adopted.backupDirectory, applied.backupDirectory)
    assert.ok(existsSync(activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot })))

    const restored = restoreActiveShellPatch({
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(restored.state, 'restored')
  } finally {
    subject.cleanup()
  }
})

test('an exact supported DSH upgrade clears a stale active backup only after seeing new originals', () => {
  const subject = fixture()
  try {
    applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })

    const nextOriginals = {}
    for (const [name, target] of FILES) {
      const content = `next-original:${name}\n`
      writeFileSync(join(subject.layoutRoot, target), content)
      nextOriginals[name] = digest(content)
    }
    writeJson(join(subject.dshRoot, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-test.2' })
    writeJson(join(subject.webAppRoot, 'package.json'), {
      name: '@deepseek-ai/dsh-web-app',
      version: '0.1.0-test.2',
      exports: { './package.json': './package.json' },
    })
    writeJson(join(subject.layoutRoot, 'package.json'), {
      name: '@deepseek-ai/dsh-client-ui-layout',
      version: '0.1.0-test.2',
      exports: { './package.json': './package.json' },
    })
    subject.manifest.targets.push({
      id: 'synthetic-target-2',
      dshVersions: ['0.1.0-test.2'],
      webAppVersions: ['0.1.0-test.2'],
      layoutVersion: '0.1.0-test.2',
      originalSha256: nextOriginals,
    })

    const result = restoreActiveShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(result.state, 'superseded-by-upgrade')
    assert.equal(result.targetId, 'synthetic-target-2')
    assert.equal(existsSync(activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot })), false)
    for (const [name, target] of FILES) {
      assert.equal(sha256(join(subject.layoutRoot, target)), nextOriginals[name])
    }
  } finally {
    subject.cleanup()
  }
})

test('unknown or mixed target hashes are rejected before creating a backup', () => {
  const subject = fixture()
  try {
    const changed = join(subject.layoutRoot, FILES[0][1])
    writeFileSync(changed, 'third-party modification\n')
    const before = FILES.map(([, target]) => sha256(join(subject.layoutRoot, target)))
    assert.throws(
      () => applyShellPatch({
        dshRoot: subject.dshRoot,
        manifest: subject.manifest,
        backupRoot: subject.backupRoot,
      }),
      error => error instanceof ShellPatchError && /未写入任何文件/u.test(error.message),
    )
    assert.equal(existsSync(subject.backupRoot), false)
    assert.deepEqual(FILES.map(([, target]) => sha256(join(subject.layoutRoot, target))), before)
  } finally {
    subject.cleanup()
  }
})

test('unsupported version tuples are rejected without touching target files', () => {
  const subject = fixture()
  try {
    writeJson(join(subject.webAppRoot, 'package.json'), {
      name: '@deepseek-ai/dsh-web-app',
      version: '0.1.0-unknown',
      exports: { './package.json': './package.json' },
    })
    const before = FILES.map(([, target]) => sha256(join(subject.layoutRoot, target)))
    assert.throws(
      () => applyShellPatch({
        dshRoot: subject.dshRoot,
        manifest: subject.manifest,
        backupRoot: subject.backupRoot,
      }),
      error => error instanceof ShellPatchError && /不受支持/u.test(error.message),
    )
    assert.equal(existsSync(subject.backupRoot), false)
    assert.deepEqual(FILES.map(([, target]) => sha256(join(subject.layoutRoot, target))), before)
  } finally {
    subject.cleanup()
  }
})

test('a mid-transaction replacement failure restores the original hashes', () => {
  const subject = fixture()
  try {
    assert.throws(
      () => applyShellPatch({
        dshRoot: subject.dshRoot,
        manifest: subject.manifest,
        backupRoot: subject.backupRoot,
        replaceFile: (stage, target, index) => {
          renameSync(stage, target)
          if (index === 0) throw new Error('synthetic replacement failure')
        },
      }),
      error => error instanceof ShellPatchError && /已恢复原文件/u.test(error.message),
    )
    for (const [name, target] of FILES) {
      assert.equal(sha256(join(subject.layoutRoot, target)), subject.originals[name])
    }
    assert.equal(existsSync(activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot })), false)
  } finally {
    subject.cleanup()
  }
})

test('restore refuses a third-party modification and preserves it', () => {
  const subject = fixture()
  try {
    const applied = applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    const changed = join(subject.layoutRoot, FILES[2][1])
    writeFileSync(changed, 'newer third-party content\n')
    const before = sha256(changed)
    assert.throws(
      () => restoreShellPatch(applied.backupDirectory, { manifest: subject.manifest }),
      error => error instanceof ShellPatchError && /拒绝恢复/u.test(error.message),
    )
    assert.equal(sha256(changed), before)
  } finally {
    subject.cleanup()
  }
})

test('restore rejects an incomplete backup manifest before touching targets', () => {
  const subject = fixture()
  try {
    const applied = applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    const backupManifestPath = join(applied.backupDirectory, 'manifest.json')
    const backupManifest = JSON.parse(readFileSync(backupManifestPath, 'utf8'))
    backupManifest.files.pop()
    writeJson(backupManifestPath, backupManifest)
    const before = FILES.map(([, target]) => sha256(join(subject.layoutRoot, target)))
    assert.throws(
      () => restoreShellPatch(applied.backupDirectory, { manifest: subject.manifest }),
      error => error instanceof ShellPatchError && /拒绝恢复/u.test(error.message),
    )
    assert.deepEqual(FILES.map(([, target]) => sha256(join(subject.layoutRoot, target))), before)
  } finally {
    subject.cleanup()
  }
})

test('a mid-restore replacement failure returns every file to its patched state', () => {
  const subject = fixture()
  try {
    const applied = applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.throws(
      () => restoreShellPatch(applied.backupDirectory, {
        manifest: subject.manifest,
        replaceFile: (stage, target, index) => {
          renameSync(stage, target)
          if (index === 0) throw new Error('synthetic restore failure')
        },
      }),
      error => error instanceof ShellPatchError && /恢复前状态/u.test(error.message),
    )
    for (const [name, target] of FILES) {
      assert.equal(sha256(join(subject.layoutRoot, target)), subject.patched[name])
    }
  } finally {
    subject.cleanup()
  }
})

test('shipped compatibility manifest matches every bundled payload', () => {
  const manifest = loadShellPatchManifest()
  assert.deepEqual(manifest.targets.map(target => target.layoutVersion), [
    '0.1.0-rc.6',
    '0.1.0-rc.7',
    '0.1.0-rc.8',
    '0.1.1-rc.1',
    '0.1.1-rc.2',
  ])
  const rc8 = manifest.targets.find(target => target.id === 'dsh-rc8-layout-rc8')
  assert.deepEqual(rc8.dshVersions, ['0.1.0-rc.8'])
  assert.deepEqual(rc8.webAppVersions, ['0.1.0-rc.8'])
  assert.equal(rc8.originalSha256['client.js'], '16f001f89a9bc19c54cfa90e37cf52e191113af0abe5efd593e57d7ab30060ad')
  for (const id of ['dsh-0.1.1-rc1-layout-0.1.1-rc1', 'dsh-0.1.1-rc2-layout-0.1.1-rc2']) {
    const target = manifest.targets.find(item => item.id === id)
    assert.ok(target)
    assert.deepEqual(target.originalSha256, rc8.originalSha256)
  }
  for (const file of manifest.files) {
    assert.equal(sha256(join(manifest.payloadRoot, file.payload)), file.patchedSha256)
  }
})

test('an npm command shim resolves to the exact adjacent DSH package tree', () => {
  const subject = fixture()
  try {
    const shim = join(subject.installRoot, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    writeFileSync(shim, '')
    const result = inspectShellPatch({ dshRoot: shim, manifest: subject.manifest })
    assert.equal(result.state, 'original')
    assert.equal(result.dshRoot, realpathSync(subject.dshRoot))
  } finally {
    subject.cleanup()
  }
})

test('a Windows command wrapper resolves an absolute DSH bin target outside the shim directory', () => {
  const subject = fixture()
  try {
    const launcher = join(subject.installRoot, 'runtime', 'node.exe')
    mkdirSync(dirname(launcher), { recursive: true })
    writeFileSync(launcher, '')
    writeFileSync(join(subject.installRoot, 'package.json'), '\uFEFF{"name":"dsh-launcher","private":true}\n')
    const bin = join(subject.dshRoot, 'lib', 'bin.js')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '#!/usr/bin/env node\n')
    const wrapperRoot = join(subject.root, 'unrelated global command directory')
    const shim = join(wrapperRoot, 'dsh.cmd')
    mkdirSync(wrapperRoot, { recursive: true })
    writeFileSync(shim, `@"${launcher}" "${bin}" %*\n`)
    const result = inspectShellPatch({ dshRoot: shim, manifest: subject.manifest })
    assert.equal(result.state, 'original')
    assert.equal(result.dshRoot, realpathSync(subject.dshRoot))
  } finally {
    subject.cleanup()
  }
})

test('a command wrapper pointing outside a DSH package is not accepted as an installation', () => {
  const subject = fixture()
  try {
    const unrelated = join(subject.root, 'unrelated tool', 'bin.js')
    mkdirSync(dirname(unrelated), { recursive: true })
    writeFileSync(unrelated, '#!/usr/bin/env node\n')
    const shim = join(subject.root, 'global commands', 'dsh.cmd')
    mkdirSync(dirname(shim), { recursive: true })
    writeFileSync(shim, `@"node" "${unrelated}" %*\n`)
    assert.throws(
      () => inspectShellPatch({ dshRoot: shim, manifest: subject.manifest }),
      error => error instanceof ShellPatchError && /不是完整/u.test(error.message),
    )
  } finally {
    subject.cleanup()
  }
})

test('Git preserves byte-sensitive patch payloads across platform checkouts', () => {
  const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8')
  assert.match(attributes, /^client\.js text eol=lf$/mu)
  assert.match(attributes, /^src\/client-template\.js text eol=lf$/mu)
  assert.match(attributes, /^patches\/dsh-client-ui-layout\/\* text eol=lf$/mu)
})

test('status is read-only and reports a complete original fixture', () => {
  const subject = fixture()
  try {
    const before = FILES.map(([, target]) => sha256(join(subject.layoutRoot, target)))
    const result = inspectShellPatch({ dshRoot: subject.dshRoot, manifest: subject.manifest })
    assert.equal(result.state, 'original')
    assert.equal(result.targetId, 'synthetic-target')
    assert.deepEqual(FILES.map(([, target]) => sha256(join(subject.layoutRoot, target))), before)
    assert.equal(existsSync(subject.backupRoot), false)
  } finally {
    subject.cleanup()
  }
})

test('two real DSH package trees keep independent state, reinstall idempotently, and restore together', () => {
  const globalTree = fixture()
  const npxTree = fixture()
  const backupRoot = join(globalTree.root, 'shared state', 'shell-backups')
  const options = {
    dshRoots: [globalTree.dshRoot, npxTree.dshRoot],
    manifest: globalTree.manifest,
    backupRoot,
  }
  try {
    const first = applyAllShellPatches(options)
    assert.equal(first.state, 'patched')
    assert.deepEqual(first.installations.map(item => item.previousState), ['original', 'original'])
    assert.equal(listActiveShellPatchStates({ backupRoot }).length, 2)
    for (const tree of [globalTree, npxTree]) {
      for (const [name, target] of FILES) assert.equal(sha256(join(tree.layoutRoot, target)), tree.patched[name])
    }

    const backupEntries = readdirSync(backupRoot).sort()
    const second = applyAllShellPatches(options)
    assert.equal(second.state, 'already-patched')
    assert.deepEqual(readdirSync(backupRoot).sort(), backupEntries)
    assert.equal(listActiveShellPatchStates({ backupRoot }).length, 2)

    const restored = restoreAllShellPatches(options)
    assert.equal(restored.state, 'restored')
    assert.equal(listActiveShellPatchStates({ backupRoot }).length, 0)
    for (const tree of [globalTree, npxTree]) {
      for (const [name, target] of FILES) assert.equal(sha256(join(tree.layoutRoot, target)), tree.originals[name])
    }
  } finally {
    npxTree.cleanup()
    globalTree.cleanup()
  }
})

test('legacy single-root active state migrates without overwriting another root state', () => {
  const legacyTree = fixture()
  const otherTree = fixture()
  const backupRoot = join(legacyTree.root, 'shared state', 'shell-backups')
  try {
    applyShellPatch({ dshRoot: legacyTree.dshRoot, manifest: legacyTree.manifest, backupRoot })
    const legacyState = listActiveShellPatchStates({ backupRoot })[0]
    const legacyPath = join(dirname(backupRoot), 'shell-patch-active.json')
    renameSync(legacyState.statePath, legacyPath)

    applyShellPatch({ dshRoot: otherTree.dshRoot, manifest: legacyTree.manifest, backupRoot })
    assert.ok(existsSync(legacyPath))
    assert.equal(listActiveShellPatchStates({ backupRoot }).length, 2)

    const adopted = applyShellPatch({ dshRoot: legacyTree.dshRoot, manifest: legacyTree.manifest, backupRoot })
    assert.equal(adopted.state, 'already-patched')
    assert.equal(existsSync(legacyPath), false)
    assert.equal(listActiveShellPatchStates({ backupRoot }).length, 2)
    restoreAllShellPatches({
      dshRoots: [legacyTree.dshRoot, otherTree.dshRoot],
      manifest: legacyTree.manifest,
      backupRoot,
    })
  } finally {
    otherTree.cleanup()
    legacyTree.cleanup()
  }
})

test('an unsupported active-state schema is rejected before any DSH file replacement', () => {
  const subject = fixture()
  let replaceCalled = false
  try {
    applyShellPatch({ dshRoot: subject.dshRoot, manifest: subject.manifest, backupRoot: subject.backupRoot })
    const statePath = activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot })
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.schemaVersion = 99
    writeJson(statePath, state)
    const before = FILES.map(([, target]) => sha256(join(subject.layoutRoot, target)))

    assert.throws(
      () => restoreActiveShellPatch({
        dshRoot: subject.dshRoot,
        manifest: subject.manifest,
        backupRoot: subject.backupRoot,
        replaceFile: () => { replaceCalled = true },
      }),
      error => error instanceof ShellPatchError && /active shell patch state/u.test(error.message),
    )
    assert.equal(replaceCalled, false)
    assert.deepEqual(FILES.map(([, target]) => sha256(join(subject.layoutRoot, target))), before)
    assert.ok(existsSync(statePath))
  } finally {
    subject.cleanup()
  }
})

test('an active state stored under the wrong root key is rejected before any DSH file replacement', () => {
  const subject = fixture()
  const other = fixture()
  let replaceCalled = false
  try {
    applyShellPatch({ dshRoot: subject.dshRoot, manifest: subject.manifest, backupRoot: subject.backupRoot })
    const statePath = activeStatePathForRoot(subject.dshRoot, { backupRoot: subject.backupRoot })
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.dshRoot = other.dshRoot
    writeJson(statePath, state)
    const before = FILES.map(([, target]) => sha256(join(subject.layoutRoot, target)))

    assert.throws(
      () => restoreActiveShellPatch({
        dshRoot: subject.dshRoot,
        manifest: subject.manifest,
        backupRoot: subject.backupRoot,
        replaceFile: () => { replaceCalled = true },
      }),
      error => error instanceof ShellPatchError && /安装根不匹配/u.test(error.message),
    )
    assert.equal(replaceCalled, false)
    assert.deepEqual(FILES.map(([, target]) => sha256(join(subject.layoutRoot, target))), before)
    assert.ok(existsSync(statePath))
  } finally {
    other.cleanup()
    subject.cleanup()
  }
})

test('unsupported second root aborts multi-root apply before the supported root changes', () => {
  const supported = fixture()
  const unsupported = fixture()
  const backupRoot = join(supported.root, 'shared state', 'shell-backups')
  try {
    writeJson(join(unsupported.webAppRoot, 'package.json'), {
      name: '@deepseek-ai/dsh-web-app',
      version: '0.1.0-unsupported',
      exports: { './package.json': './package.json' },
    })
    const before = [supported, unsupported].map(tree => FILES.map(([, target]) => sha256(join(tree.layoutRoot, target))))
    assert.throws(
      () => applyAllShellPatches({
        dshRoots: [supported.dshRoot, unsupported.dshRoot],
        manifest: supported.manifest,
        backupRoot,
      }),
      error => error instanceof ShellPatchError && /不受支持/u.test(error.message),
    )
    assert.equal(existsSync(backupRoot), false)
    assert.deepEqual([supported, unsupported].map(tree => FILES.map(([, target]) => sha256(join(tree.layoutRoot, target)))), before)
  } finally {
    unsupported.cleanup()
    supported.cleanup()
  }
})

test('damaged second root aborts multi-root apply before any root changes', () => {
  const first = fixture()
  const damaged = fixture()
  const backupRoot = join(first.root, 'shared state', 'shell-backups')
  try {
    writeFileSync(join(damaged.layoutRoot, FILES[0][1]), 'damaged by another patch\n')
    const before = [first, damaged].map(tree => FILES.map(([, target]) => sha256(join(tree.layoutRoot, target))))
    assert.throws(
      () => applyAllShellPatches({
        dshRoots: [first.dshRoot, damaged.dshRoot],
        manifest: first.manifest,
        backupRoot,
      }),
      error => error instanceof ShellPatchError && /未写入任何文件/u.test(error.message),
    )
    assert.equal(existsSync(backupRoot), false)
    assert.deepEqual([first, damaged].map(tree => FILES.map(([, target]) => sha256(join(tree.layoutRoot, target)))), before)
  } finally {
    damaged.cleanup()
    first.cleanup()
  }
})

test('a failure in the second root rolls the first root back to its original files', () => {
  const first = fixture()
  const second = fixture()
  const backupRoot = join(first.root, 'shared state', 'shell-backups')
  let failed = false
  try {
    assert.throws(
      () => applyAllShellPatches({
        dshRoots: [first.dshRoot, second.dshRoot],
        manifest: first.manifest,
        backupRoot,
        replaceFile: (stage, target) => {
          renameSync(stage, target)
          if (!failed && target.startsWith(realpathSync(second.root))) {
            failed = true
            throw new Error('synthetic second-root failure')
          }
        },
      }),
      error => error instanceof ShellPatchError && /全部恢复/u.test(error.message),
    )
    for (const tree of [first, second]) {
      for (const [name, target] of FILES) assert.equal(sha256(join(tree.layoutRoot, target)), tree.originals[name])
    }
    assert.equal(listActiveShellPatchStates({ backupRoot }).length, 0)
  } finally {
    second.cleanup()
    first.cleanup()
  }
})
