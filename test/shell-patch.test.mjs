import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  applyShellPatch,
  inspectShellPatch,
  loadShellPatchManifest,
  restoreActiveShellPatch,
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
    assert.ok(existsSync(join(subject.root, 'shell-patch-active.json')))
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
    assert.equal(existsSync(join(subject.root, 'shell-patch-active.json')), false)
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
    rmSync(join(subject.root, 'shell-patch-active.json'))

    const adopted = applyShellPatch({
      dshRoot: subject.dshRoot,
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(adopted.state, 'already-patched')
    assert.equal(adopted.backupDirectory, applied.backupDirectory)
    assert.ok(existsSync(join(subject.root, 'shell-patch-active.json')))

    const restored = restoreActiveShellPatch({
      manifest: subject.manifest,
      backupRoot: subject.backupRoot,
    })
    assert.equal(restored.state, 'restored')
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
    assert.equal(existsSync(join(subject.root, 'shell-patch-active.json')), false)
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
  assert.deepEqual(manifest.targets.map(target => target.layoutVersion), ['0.1.0-rc.6', '0.1.0-rc.7'])
  for (const file of manifest.files) {
    assert.equal(sha256(join(manifest.payloadRoot, file.payload)), file.patchedSha256)
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
