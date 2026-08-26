import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/find-npx-dsh.mjs', import.meta.url))
const VERSION = '0.1.0-test.1'

function addCachedDsh(cacheRoot, key, version = VERSION) {
  const root = join(cacheRoot, '_npx', key, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`)
  return root
}

function run(cacheRoot) {
  return spawnSync(process.execPath, [SCRIPT, VERSION], {
    encoding: 'utf8',
    env: { ...process.env, DSH_NPX_CACHE_ROOT: cacheRoot },
  })
}

test('find-npx-dsh prefers the exact package selected by the active npx PATH', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'trace-insight-npx-cache-'))
  try {
    addCachedDsh(cacheRoot, 'inactive')
    const expected = addCachedDsh(cacheRoot, 'active')
    const activeBin = join(cacheRoot, '_npx', 'active', 'node_modules', '.bin')
    mkdirSync(activeBin, { recursive: true })
    const result = spawnSync(process.execPath, [SCRIPT, VERSION], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_NPX_CACHE_ROOT: cacheRoot,
        PATH: `${activeBin}${delimiter}${process.env.PATH || ''}`,
      },
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), realpathSync(expected))
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('find-npx-dsh returns the only exact cached package root', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'trace-insight-npx-cache-'))
  try {
    const expected = addCachedDsh(cacheRoot, 'exact')
    addCachedDsh(cacheRoot, 'other-version', '0.1.0-test.2')
    const result = run(cacheRoot)
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), realpathSync(expected))
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('find-npx-dsh rejects missing and ambiguous cache state', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'trace-insight-npx-cache-'))
  try {
    const missing = run(cacheRoot)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /found 0/u)

    addCachedDsh(cacheRoot, 'first')
    addCachedDsh(cacheRoot, 'second')
    const ambiguous = run(cacheRoot)
    assert.notEqual(ambiguous.status, 0)
    assert.match(ambiguous.stderr, /found 2/u)
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})
