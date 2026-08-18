import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileHistoryStore,
  MemoryHistoryStore,
  createEmptySessionHistory,
} from '../src/history-store.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('memory store serializes concurrent updates without losing checkpoints', async () => {
  let tick = 1_000
  const store = new MemoryHistoryStore({ now: () => tick += 1 })
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.updateSession('session-1', history => {
    history.programmatic.checkpoints.push({ id: `checkpoint-${index}` })
    return history
  })))
  const history = await store.getSession('session-1')
  assert.equal(history.programmatic.checkpoints.length, 12)
  assert.equal(new Set(history.programmatic.checkpoints.map(item => item.id)).size, 12)
})

for (const [label, createStore] of [
  ['memory', async () => ({ store: new MemoryHistoryStore(), cleanup: async () => {} })],
  ['file', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-cross-write-'))
    return { store: new FileHistoryStore({ rootDir }), cleanup: () => rm(rootDir, { recursive: true, force: true }) }
  }],
]) {
  test(`${label} store serializes final-history and live updates to the same session`, async t => {
    const { store, cleanup } = await createStore()
    t.after(cleanup)
    const updaterEntered = deferred()
    const releaseUpdater = deferred()

    const finalWrite = store.updateSession('cross-write', async history => {
      updaterEntered.resolve()
      await releaseUpdater.promise
      history.lastObservedSeq = 17
      return history
    })
    await updaterEntered.promise
    const liveWrite = store.updateLiveSession('cross-write', history => {
      history.live.items.push({ turn: 1, state: 'open', revision: 0 })
      return history
    })
    releaseUpdater.resolve()
    await Promise.all([finalWrite, liveWrite])

    const history = await store.getSession('cross-write')
    assert.equal(history.lastObservedSeq, 17)
    assert.equal(history.live.items.length, 1)
    assert.equal(history.live.revision, 1)
  })
}

test('file store persists settings and one isolated file per session', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-store-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const store = new FileHistoryStore({ rootDir })
  await store.updateSettings(settings => ({
    ...settings,
    defaultRoute: { provider: 'provider-low', model: 'model-small' },
  }))
  await store.updateSession('session-a', history => {
    history.lastObservedSeq = 8
    return history
  })
  const reopened = new FileHistoryStore({ rootDir })
  assert.deepEqual((await reopened.getSettings()).defaultRoute, { provider: 'provider-low', model: 'model-small' })
  assert.equal((await reopened.getSession('session-a')).lastObservedSeq, 8)
  assert.equal((await reopened.listSessions()).length, 1)
  assert.match(await readFile(reopened.settingsPath, 'utf8'), /provider-low/)
})

test('file store retries a transient Windows rename lock without losing the update', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-rename-retry-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const waits = []
  let attempts = 0
  const store = new FileHistoryStore({
    rootDir,
    renameFile: async (source, destination) => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' })
      return rename(source, destination)
    },
    sleep: async milliseconds => waits.push(milliseconds),
    renameRetryDelaysMs: [5, 10],
  })

  await store.updateSession('session-retry', history => {
    history.lastObservedSeq = 12
    return history
  })

  assert.equal(attempts, 2)
  assert.deepEqual(waits, [5])
  assert.equal((await store.getSession('session-retry')).lastObservedSeq, 12)
})

test('file store does not retry unrelated rename errors and cleans the temporary file', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-rename-fail-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const failure = Object.assign(new Error('invalid rename'), { code: 'EINVAL' })
  const waits = []
  let attempts = 0
  const store = new FileHistoryStore({
    rootDir,
    renameFile: async () => {
      attempts += 1
      throw failure
    },
    sleep: async milliseconds => waits.push(milliseconds),
    renameRetryDelaysMs: [5, 10],
  })

  await assert.rejects(
    store.updateSession('session-no-retry', history => history),
    error => error === failure,
  )
  assert.equal(attempts, 1)
  assert.deepEqual(waits, [])
  assert.deepEqual((await readdir(store.sessionsDir)).filter(name => name.endsWith('.tmp')), [])
})

test('file store stops after the bounded rename retry schedule and preserves the original error', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-rename-exhausted-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const failure = Object.assign(new Error('still locked'), { code: 'EBUSY' })
  const waits = []
  let attempts = 0
  const store = new FileHistoryStore({
    rootDir,
    renameFile: async () => {
      attempts += 1
      throw failure
    },
    sleep: async milliseconds => waits.push(milliseconds),
    renameRetryDelaysMs: [5, 10],
  })

  await assert.rejects(
    store.updateSession('session-exhausted', history => history),
    error => error === failure,
  )
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [5, 10])
  assert.deepEqual((await readdir(store.sessionsDir)).filter(name => name.endsWith('.tmp')), [])
})

test('malformed history fails loud and is not replaced by a default record', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-corrupt-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const store = new FileHistoryStore({ rootDir })
  await store.initialize()
  const path = store.sessionPath('session-corrupt')
  await writeFile(path, '{ not valid json', 'utf8')
  await assert.rejects(store.getSession('session-corrupt'), /refused malformed JSON/)
  assert.equal(await readFile(path, 'utf8'), '{ not valid json')
})

test('empty history starts both coverage watermarks before seq zero', () => {
  const history = createEmptySessionHistory('session-empty', () => 1_000)
  assert.equal(history.programmatic.coveredThroughSeq, -1)
  assert.equal(history.semantic.coveredThroughSeq, -1)
  assert.deepEqual(history.diagnostics, [])
  assert.deepEqual(history.automatic, { enrolled: false, enrolledAt: null, lastLiveTurnSeq: null })
  assert.equal(history.semantic.retry, null)
  assert.deepEqual(history.semantic.runs, [])
  assert.deepEqual(history.annotations, { revision: 0, items: [] })
  assert.equal(history.changesFloorRevision, 0)
  assert.equal(history.timelineRevision, 0)
  assert.equal(history.programmaticRevision, 0)
})

test('legacy schema v1 history is upgraded in memory without dropping existing records', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-v1-migration-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const store = new FileHistoryStore({ rootDir })
  await store.initialize()
  const legacy = {
    schemaVersion: 1,
    sessionId: 'legacy-session',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastObservedSeq: 5,
    programmatic: { coveredThroughSeq: 5, checkpoints: [{ id: 'legacy-checkpoint', toSeq: 5 }] },
    semantic: { coveredThroughSeq: -1, continuitySummary: '', primaryRunId: null, retry: null, runs: [] },
  }
  await writeFile(store.sessionPath('legacy-session'), JSON.stringify(legacy), 'utf8')

  const migrated = await store.getSession('legacy-session')
  assert.equal(migrated.revision, 0)
  assert.equal(migrated.lastClosedSeq, 5)
  assert.equal(migrated.programmatic.checkpoints[0].id, 'legacy-checkpoint')
  assert.deepEqual(migrated.jobs, [])
  assert.deepEqual(migrated.annotations, { revision: 0, items: [] })

  const persisted = await store.updateSession('legacy-session', history => {
    history.diagnostics.push({ id: 'diagnostic-new', message: 'kept' })
    return history
  })
  assert.equal(persisted.revision, 1)
  assert.equal(persisted.programmatic.checkpoints[0].id, 'legacy-checkpoint')
  assert.equal(persisted.diagnostics[0].revision, 1)
})

test('annotation records have an independent revision and never rewrite semantic runs', async () => {
  const store = new MemoryHistoryStore()
  await store.updateSession('session-annotations', history => {
    history.semantic.runs.push({ id: 'run-original', status: 'succeeded', output: { verdict: 'original' } })
    return history
  })
  const before = await store.getSession('session-annotations')
  const first = await store.updateSession('session-annotations', history => {
    history.annotations.items.push({ id: 'annotation-1', kind: 'note', target: { kind: 'semantic', id: 'run-original' }, text: 'human note' })
    return history
  })
  assert.equal(first.annotations.revision, 1)
  assert.equal(first.timelineRevision, before.timelineRevision)
  assert.equal(first.annotations.items[0].revision, first.revision)
  assert.deepEqual(first.semantic.runs[0], before.semantic.runs[0])

  const second = await store.updateSession('session-annotations', history => {
    history.annotations.items[0].archivedAt = new Date(0).toISOString()
    return history
  })
  assert.equal(second.annotations.revision, 2)
  assert.equal(second.timelineRevision, before.timelineRevision)
  assert.equal(second.changes.at(-1).kind, 'annotation')
  assert.equal(second.semantic.runs[0].output.verdict, 'original')
})

test('settings state migrates legacy files and rejects stale optimistic revisions', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'trace-insight-settings-revision-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const store = new FileHistoryStore({ rootDir })
  await store.initialize()
  await writeFile(store.settingsPath, JSON.stringify({
    schemaVersion: 1,
    defaultRoute: { provider: 'legacy', model: 'flash', reasoningEffort: 'low' },
    auto: { enabled: true },
  }), 'utf8')

  const legacy = await store.getSettingsState()
  assert.equal(legacy.revision, 0)
  assert.equal(legacy.settings.defaultRoute.reasoningEffort, 'low')
  const updated = await store.updateSettingsState(settings => ({ ...settings, auto: { ...settings.auto, enabled: false } }), { expectedRevision: 0 })
  assert.equal(updated.revision, 1)
  await assert.rejects(
    store.updateSettingsState(settings => settings, { expectedRevision: 0 }),
    error => error?.code === 'REVISION_CONFLICT' && error.details.actualRevision === 1,
  )
})

test('session revisions are monotonic and record-level changes support delta reads', async () => {
  const store = new MemoryHistoryStore()
  const first = await store.updateSession('session-revision', history => {
    history.jobs.push({ id: 'job-1', status: 'queued' })
    return history
  })
  const second = await store.updateSession('session-revision', history => {
    history.jobs[0].status = 'running'
    return history
  })
  assert.equal(first.revision, 1)
  assert.equal(first.jobs[0].revision, 1)
  assert.equal(first.timelineRevision, 1)
  assert.equal(second.revision, 2)
  assert.equal(second.jobs[0].revision, 2)
  assert.equal(second.timelineRevision, 2)
  assert.deepEqual(second.changes.map(change => [change.revision, change.operation]), [[1, 'added'], [2, 'updated']])
})

test('change-log truncation records the earliest revision that requires a full reload', async () => {
  const store = new MemoryHistoryStore()
  const history = await store.updateSession('session-change-floor', current => {
    for (let index = 0; index < 2_500; index += 1) current.jobs.push({ id: `job-${index}`, status: 'queued' })
    return current
  })
  assert.equal(history.changes.length, 2_000)
  assert.equal(history.changesFloorRevision, 1)
})
