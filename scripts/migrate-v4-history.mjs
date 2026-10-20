// Offline, fail-closed migration of analysis metadata. Session files are never written.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { migrateCoordinatePreservingHistory } from '../src/migration-coordinates.mjs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const homeArg = option('--home')
const packageArg = option('--dsh-package')
const backupArg = option('--backup-dir')
const apply = args.includes('--apply')
if (!homeArg || !packageArg || (apply && !backupArg)) {
  throw new Error('Usage: node scripts/migrate-v4-history.mjs --home <DSH_HOME> --dsh-package <DSH package.json> [--apply --backup-dir <private backup directory>]. Stop DSH before --apply.')
}
const home = path.resolve(homeArg)
const requireDsh = createRequire(path.resolve(packageArg))
const importDsh = name => import(pathToFileURL(requireDsh.resolve(name)).href)
const { historicalSessionFormatCatalog, createSessionFormatCatalogWithChildren } = await importDsh('@deepseek-ai/dsh-session-format-catalog')
const { historicalChildCatalogSource } = await importDsh('@deepseek-ai/dsh-session-format-v3-to-v4')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const revisions = new Map()
async function read(filename) {
  const bytes = await fs.readFile(filename)
  revisions.set(filename, digest(bytes))
  return bytes
}
async function files(dir) {
  const output = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) output.push(...await files(filename))
    else if (entry.isFile()) output.push(filename)
    else throw new Error('Linked or special files require manual corpus review.')
  }
  return output
}
async function rows(filename) {
  let bytes = await read(filename)
  if (filename.endsWith('.zstd')) bytes = zstdDecompressSync(bytes)
  else if (filename.endsWith('.gz')) throw new Error('Gzip is not a current official generation encoding; manual corpus review is required.')
  return bytes.toString('utf8').trim().split('\n').map(JSON.parse)
}
function restore(catalog, data) {
  const reader = catalog.createRestore(data[0], { recovery: 'strict', validation: 'current' })
  data.slice(1).forEach(row => reader.decodeRow(row))
  return reader.finish()
}
const sessionFiles = await files(path.join(home, 'sessions'))
const sources = new Map()
const childrenByParent = new Map()
const currentArtifacts = new Map()
function addChild(artifact) {
  const { origin, parentSession } = artifact.header
  // Forks also have parentSession but are not subagent catalog members.
  if (origin !== 'subagent' || !parentSession) return
  const children = childrenByParent.get(parentSession) ?? []
  children.push(historicalChildCatalogSource(artifact))
  childrenByParent.set(parentSession, children)
}
for (const filename of sessionFiles.filter(name => /[/\\]session\.v3\.jsonl(?:\.zstd|\.gz)?$/u.test(name))) {
  const data = await rows(filename)
  const artifact = restore(historicalSessionFormatCatalog, data)
  if (sources.has(artifact.header.id)) throw new Error('Duplicate session identity in v3 source corpus.')
  sources.set(artifact.header.id, { filename, data, artifact })
}
// Use the current generation of a child when available, as the official
// persistence layer does. Never pass another parent's children to a catalog.
for (const filename of sessionFiles.filter(name => /[/\\]session\.v4\.jsonl(?:\.zstd|\.gz)?$/u.test(name))) {
  const data = await rows(filename)
  const artifact = restore(createSessionFormatCatalogWithChildren([]), data)
  if (currentArtifacts.has(artifact.header.id)) throw new Error('Duplicate session identity in v4 corpus.')
  currentArtifacts.set(artifact.header.id, { filename, artifact })
}
for (const [id, source] of sources) if (!currentArtifacts.has(id)) addChild(source.artifact)
for (const { artifact } of currentArtifacts.values()) addChild(artifact)
// Refuse an incomplete source corpus instead of silently treating old children
// as absent. Preserved older generations alongside v3/v4 are harmless.
const representedDirectories = new Set([...sources.values(), ...currentArtifacts.values()].map(item => path.dirname(item.filename)))
if (sessionFiles.some(filename => /[/\\]session(?:\.v\d+)?\.jsonl(?:\.zstd|\.gz)?$/u.test(filename)
  && (!representedDirectories.has(path.dirname(filename)) || /session\.v(?:[5-9]|\d{2,})\./u.test(filename)))) {
  throw new Error('Unsupported session generation in corpus; child completeness cannot be established.')
}
const changes = []
const checked = []
const historyIds = new Set()
const histories = (await files(path.join(home, 'trace-insight', 'sessions'))).filter(name => name.endsWith('.json'))
for (const filename of histories) {
  const before = await read(filename)
  const history = JSON.parse(before)
  if (history.schemaVersion !== 1 || typeof history.sessionId !== 'string'
    || !Array.isArray(history.semantic?.runs) || !Array.isArray(history.programmatic?.checkpoints)) {
    throw new Error('Unsupported analysis history schema.')
  }
  if (historyIds.has(history.sessionId)) throw new Error('Duplicate history identity.')
  historyIds.add(history.sessionId)
  if (history.sourceFormatVersion === 4) {
    checked.push({ sessionId: history.sessionId, status: 'already-v4' })
    continue
  }
  const source = sources.get(history.sessionId)
  if (!source) throw new Error(`No preserved v3 source for history ${history.sessionId}.`)
  const target = restore(createSessionFormatCatalogWithChildren(childrenByParent.get(history.sessionId) ?? []), source.data)
  const current = currentArtifacts.get(history.sessionId)?.artifact
  if (current && (!isDeepStrictEqual(current.header, target.header)
    || current.inheritedEventCount !== target.inheritedEventCount
    || current.events.length < target.events.length
    || target.events.some((event, index) => !isDeepStrictEqual(event, current.events[index])))) {
    throw new Error(`Existing v4 generation differs from the official migration: ${history.sessionId}.`)
  }
  if (apply && !current) throw new Error(`No validated v4 generation exists yet: ${history.sessionId}. Restore the session with official DSH on a copy first.`)
  const migrated = migrateCoordinatePreservingHistory(history, source.artifact, target)
  const after = Buffer.from(JSON.stringify(migrated, null, 2) + '\n')
  changes.push({ filename, before, after })
  checked.push({
    sessionId: history.sessionId, status: current ? 'coordinates-preserved' : 'awaiting-official-v4',
    from: 3, to: 4, sourceEvents: source.artifact.events.length, targetEvents: target.events.length,
    sourceSha256: revisions.get(source.filename), historyBeforeSha256: digest(before), historyAfterSha256: digest(after),
  })
}
// Detect a concurrent writer before making any changes.
for (const [filename, hash] of revisions) {
  if (digest(await fs.readFile(filename)) !== hash) throw new Error('A source changed during preflight; stop DSH and retry.')
}
async function revalidateSources() {
  const latestFiles = await files(path.join(home, 'sessions'))
  if (!isDeepStrictEqual(sessionFiles.slice().sort(), latestFiles.sort())) throw new Error('Session corpus changed after preflight.')
  for (const [filename, hash] of revisions) {
    if (changes.some(item => item.filename === filename)) continue
    if (digest(await fs.readFile(filename)) !== hash) throw new Error('A session source changed after preflight.')
  }
}
if (apply && changes.length) {
  const backup = path.resolve(backupArg)
  if (backup === home || backup.startsWith(home + path.sep)) throw new Error('Backup must be outside DSH_HOME.')
  // A fresh private directory prevents collisions with prior recovery material.
  await fs.mkdir(backup, { mode: 0o700 })
  for (const [index, item] of changes.entries()) {
    item.backupName = `${index}.json`
    await fs.writeFile(path.join(backup, item.backupName), item.before, { mode: 0o600, flag: 'wx' })
  }
  await fs.writeFile(path.join(backup, 'migration-audit.json'), JSON.stringify({
    sessions: checked, files: changes.map(item => ({
      path: path.relative(home, item.filename), backup: item.backupName,
      before: digest(item.before), after: digest(item.after),
    })),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  const written = []
  try {
    for (const item of changes) {
      await revalidateSources()
      if (digest(await fs.readFile(item.filename)) !== digest(item.before)) throw new Error('History changed after backup.')
      const temporary = `${item.filename}.${randomUUID()}.migration`
      await fs.writeFile(temporary, item.after, { mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, item.filename)
      written.push(item)
    }
    await revalidateSources()
  } catch (error) {
    const rollbackErrors = []
    for (const item of written.reverse()) {
      try {
        if (digest(await fs.readFile(item.filename)) !== digest(item.after)) throw new Error('Concurrent history edit prevents rollback.')
        const temporary = `${item.filename}.${randomUUID()}.rollback`
        await fs.writeFile(temporary, item.before, { mode: 0o600, flag: 'wx' })
        await fs.rename(temporary, item.filename)
      } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], `Migration failed; restore using ${path.join(backup, 'migration-audit.json')}.`)
    throw error
  }
}
console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', sessions: checked, changed: apply ? changes.length : 0 }, null, 2))
