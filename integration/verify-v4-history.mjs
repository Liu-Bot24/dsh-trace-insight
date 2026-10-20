// Exercise the offline migrator against the actual installed official codecs.
// All data is synthetic and lives under a fresh OS temporary directory.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createEmptySessionHistory } from '../src/history-store.mjs'

const packagePath = process.argv[2]
if (!packagePath) throw new Error('Usage: node integration/verify-v4-history.mjs <official DSH package.json>')
const requireDsh = createRequire(path.resolve(packagePath))
const load = name => import(pathToFileURL(requireDsh.resolve(name)).href)
const { createSessionFormatCatalogWithChildren } = await load('@deepseek-ai/dsh-session-format-catalog')
const { releasedV3SessionFormatCodec: v3, releasedV4SessionFormatCodec: v4, historicalChildCatalogSource } =
  await load('@deepseek-ai/dsh-session-format-v3-to-v4')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-v4-migration-'))
const home = path.join(root, 'home')
const sessions = path.join(home, 'sessions', 'synthetic')
const historyDir = path.join(home, 'trace-insight', 'sessions')
await fs.mkdir(historyDir, { recursive: true })
function artifact(id, parentSession, subagent = false) {
  return {
    header: { version: 3, id, createdAt: 100, cwd: root, isSeeded: false, delegationDepth: parentSession ? 1 : 0,
      ...(parentSession ? { parentSession } : {}), ...(subagent ? { origin: 'subagent' } : {}) },
    inheritedEventCount: 0, events: [],
  }
}
function encode(item, codec) {
  return [codec.encodeHeader(item.header, item.inheritedEventCount), ...item.events.map(event => codec.encodeEvent(event))]
    .map(row => JSON.stringify(row) + '\n').join('')
}
function restore(item, children) {
  const rows = encode(item, v3).trim().split('\n').map(JSON.parse)
  const reader = createSessionFormatCatalogWithChildren(children).createRestore(rows[0], { recovery: 'strict', validation: 'current' })
  rows.slice(1).forEach(row => reader.decodeRow(row))
  return reader.finish()
}
const originals = new Map()
async function write(item, codec) {
  const dir = path.join(sessions, item.header.id)
  await fs.mkdir(dir, { recursive: true })
  const filename = path.join(dir, `session.v${item.header.version}.jsonl`)
  const content = encode(item, codec)
  await fs.writeFile(filename, content)
  originals.set(filename, content)
  return filename
}
const parentA = artifact('parent-a'), parentB = artifact('parent-b')
const childA = artifact('child-a', 'parent-a', true), childB = artifact('child-b', 'parent-b', true)
const currentChild = artifact('current-child', 'parent-b', true), fork = artifact('fork', 'parent-a')
for (const item of [childA, childB, fork]) {
  await write(item, v3)
  await write(restore(item, []), v4)
}
await write(restore(currentChild, []), v4)
const historyFiles = []
for (const [item, children] of [[parentA, [childA]], [parentB, [childB, currentChild]]]) {
  await write(item, v3)
  await write(restore(item, children.map(historicalChildCatalogSource)), v4)
  const filename = path.join(historyDir, `${item.header.id}.json`)
  await fs.writeFile(filename, JSON.stringify({ ...createEmptySessionHistory(item.header.id), sourceFormatVersion: 3 }))
  historyFiles.push(filename)
}
const originalHistories = await Promise.all(historyFiles.map(filename => fs.readFile(filename, 'utf8')))
function run(...args) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/migrate-v4-history.mjs', import.meta.url)),
    '--home', home, '--dsh-package', path.resolve(packagePath), ...args], { encoding: 'utf8' })
}
function succeeds(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) }
const dry = succeeds(run())
assert.deepEqual(dry.sessions.map(item => item.targetEvents), [1, 2], 'catalogs must contain only each parent’s direct subagents')
assert.deepEqual(await Promise.all(historyFiles.map(filename => fs.readFile(filename, 'utf8'))), originalHistories)

const parentFile = path.join(sessions, 'parent-a', 'session.v4.jsonl')
await fs.rename(parentFile, parentFile + '.held')
const absent = run('--apply', '--backup-dir', path.join(root, 'must-not-exist'))
assert.notEqual(absent.status, 0)
assert.match(absent.stderr, /No validated v4 generation/)
await fs.rename(parentFile + '.held', parentFile)
await fs.access(path.join(root, 'must-not-exist')).then(() => assert.fail('preflight wrote a backup'), error => assert.equal(error.code, 'ENOENT'))

const rows = originals.get(parentFile).trim().split('\n').map(JSON.parse)
rows[0].createdAt += 1
await fs.writeFile(parentFile, rows.map(row => JSON.stringify(row) + '\n').join(''))
const changed = run()
assert.notEqual(changed.status, 0)
assert.match(changed.stderr, /differs from the official migration/)
await fs.writeFile(parentFile, originals.get(parentFile))

const backup = path.join(root, 'backup')
await fs.mkdir(backup)
assert.notEqual(run('--apply', '--backup-dir', backup).status, 0, 'existing backup must never be reused')
assert.deepEqual(await Promise.all(historyFiles.map(filename => fs.readFile(filename, 'utf8'))), originalHistories)
const finalBackup = path.join(root, 'backup-complete')
const applied = succeeds(run('--apply', '--backup-dir', finalBackup))
assert.equal(applied.changed, 2)
for (const [index, filename] of historyFiles.entries()) {
  const updated = JSON.parse(await fs.readFile(filename, 'utf8'))
  assert.equal(updated.sourceFormatVersion, 4)
  assert.deepEqual({ ...updated, sourceFormatVersion: 3 }, JSON.parse(originalHistories[index]))
  assert.equal(await fs.readFile(path.join(finalBackup, `${index}.json`), 'utf8'), originalHistories[index])
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(finalBackup, `${index}.json`))).mode & 0o777, 0o600)
}
if (process.platform !== 'win32') assert.equal((await fs.stat(finalBackup)).mode & 0o777, 0o700)
for (const [filename, content] of originals) assert.equal(await fs.readFile(filename, 'utf8'), content, 'sessions must stay byte-identical')
assert.equal(succeeds(run('--apply', '--backup-dir', path.join(root, 'unused'))).changed, 0)
console.log(JSON.stringify({ ok: true, checks: ['parent-specific children', 'fork excluded', 'v4-only child',
  'dry-run no writes', 'missing successor refused', 'changed successor refused', 'backup collision refused',
  'private backups', 'history-only apply', 'session bytes preserved', 'idempotency'], fixture: root }))
