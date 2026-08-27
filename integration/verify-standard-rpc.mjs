import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

// Run against a real, isolated DSH with seed-standard.mjs and dsh-llm-fixture.
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:3184')
assert.equal(base.protocol, 'http:')
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname))
assert.ok(base.port && base.port !== '3080', 'Never test against the daily DSH port.')
const sessions = ['session-standard-demo-0001', 'session-standard-demo-0002']
const expectedVersion = JSON.parse(readFileSync(new URL('../packages/standard/package.json', import.meta.url), 'utf8')).version
const route = model => ({ provider: 'trace-insight-fixture', model })
const checks = []
async function rpc(method, payload = {}, errorCode) {
  if (payload.sessionId) assert.ok(sessions.includes(payload.sessionId))
  const rpcId = randomUUID()
  const response = await fetch(new URL(`/trace-insight/${method}`, base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200, method)
  const envelope = await response.json()
  assert.equal(envelope.rpcId, rpcId)
  if (errorCode) {
    assert.equal(envelope.result.ok, false, method)
    assert.equal(envelope.result.error.code, errorCode, method)
    return
  }
  assert.equal(envelope.result.ok, true, `${method}: ${JSON.stringify(envelope.result.error)}`)
  return envelope.result.value
}
async function check(name, run) {
  await run()
  checks.push(name)
  console.log(`PASS ${name}`)
}
const sessionId = sessions[0]
await check('real Host API and standard version', async () => {
  assert.equal((await rpc('capabilities/read')).serviceVersion, expectedVersion)
  assert.ok((await rpc('models/list')).models.some(model => model.provider === route('').provider && model.model === 'fixture-small'))
})
await check('rule analysis, bounded bootstrap, and passive reads', async () => {
  for (const id of sessions) {
    const before = await rpc('export/read', { sessionId: id, kind: 'analysis' })
    const result = await rpc('programmatic/sync', { sessionId: id, historyLimit: 2 })
    assert.equal(result.status.coverage.programmaticThroughSeq, 7)
    assert.equal(result.reportSummary.metrics.failedTools, 1)
    assert.ok(result.history.items.length <= 2)
    await rpc('insight/bootstrap', { sessionId: id, historyLimit: 1 })
    const after = await rpc('export/read', { sessionId: id, kind: 'analysis' })
    assert.equal(after.analysis.history.semantic.runs.length, before.analysis.history.semantic.runs.length)
  }
})
await check('global/session settings, isolation, and revision conflict', async () => {
  const before = await rpc('settings/effective', { sessionId })
  const updated = await rpc('settings/update-global', {
    expectedRevision: before.revision.global,
    patch: { defaultRoute: route('fixture-small'), auto: { enabled: false } },
  })
  await rpc('settings/update-global', { expectedRevision: before.revision.global, patch: {} }, 'REVISION_CONFLICT')
  assert.equal(updated.revision, before.revision.global + 1)
  await rpc('settings/update-session', { sessionId, patch: { defaultRoute: route('fixture-strong') }, expectedRevision: before.revision.session })
  assert.equal((await rpc('settings/effective', { sessionId })).effective.defaultRoute.model, 'fixture-strong')
  assert.equal((await rpc('settings/effective', { sessionId: sessions[1] })).effective.defaultRoute.model, 'fixture-small')
  await rpc('settings/update-session', { sessionId, reset: true })
})
async function analyze(model, expected, mode = 'supplemental') {
  const request = { sessionId, mode, fromSeq: 0, toSeq: 7, route: route(model), force: true }
  const preview = await rpc('analysis/preview', request)
  assert.equal(preview.segments.length, 1)
  const startRequest = { ...request, previewToken: preview.previewToken, idempotencyKey: randomUUID() }
  const first = await rpc('analysis/start', startRequest)
  const duplicate = await rpc('analysis/start', startRequest)
  assert.equal(duplicate.jobId, first.jobId)
  for (let attempt = 0; attempt < 120; attempt++) {
    const { job } = await rpc('analysis/job', { sessionId, jobId: first.jobId })
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
      assert.equal(job.status, expected, JSON.stringify(job))
      const exported = await rpc('export/read', { sessionId, kind: 'analysis' })
      const run = exported.analysis.history.semantic.runs.findLast(run => run.route.model === model)
      assert.equal(run.status, expected)
      return run.id
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${first.jobId}`)
}
let leftRunId, rightRunId
await check('real DSH llm.stream success and idempotent start', async () => {
  leftRunId = await analyze('fixture-small', 'succeeded')
  rightRunId = await analyze('fixture-strong', 'succeeded')
})
await check('provider failure stays failed', async () => {
  await analyze('fixture-fail', 'failed')
})
await check('primary analysis advances the formal coverage watermark', async () => {
  const before = await rpc('export/read', { sessionId, kind: 'analysis' })
  if (before.analysis.history.semantic.coveredThroughSeq < 7) await analyze('fixture-small', 'succeeded', 'primary')
  const after = await rpc('export/read', { sessionId, kind: 'analysis' })
  assert.equal(after.analysis.history.semantic.coveredThroughSeq, 7)
  const status = await rpc('insight/bootstrap', { sessionId, historyLimit: 2 })
  assert.equal(status.status.latest.semanticSuccess.status, 'succeeded')
})
await check('comparison, overview, paging, and evidence', async () => {
  const comparison = await rpc('compare/read', { sessionId, leftRunId, rightRunId })
  assert.equal(comparison.comparable, true)
  assert.equal(comparison.differences.model.changed, true)
  await rpc('compare/read', { sessionId, leftRunId, rightRunId: leftRunId }, 'INVALID_COMPARISON')
  const summary = await rpc('research/summary', { sessionId })
  assert.ok(summary.dimensions)
  const page = await rpc('history/page', { sessionId, limit: 1 })
  assert.equal(page.items.length, 1)
  assert.ok(page.nextCursor)
  const next = await rpc('history/page', { sessionId, limit: 1, cursor: page.nextCursor })
  assert.notEqual(next.items[0].id, page.items[0].id)
  const evidence = await rpc('evidence/read', { sessionId, seq: 4 })
  assert.equal(evidence.verified, true)
  assert.ok(evidence.events.some(event => event.seq === 4))
  const semanticEvidence = await rpc('evidence/read', { sessionId, runId: leftRunId, evidenceIndex: 0 })
  assert.equal(semanticEvidence.verified, true)
})
await check('raw/bundle exports require matching single-use confirmation', async () => {
  for (const kind of ['raw', 'bundle']) {
    await rpc('export/read', { sessionId, kind }, 'EXPORT_CONFIRMATION_REQUIRED')
    const preview = await rpc('export/preview', { sessionId, kind, options: { redactRaw: true, fromSeq: 0, toSeq: 7 } })
    const request = { sessionId, kind, options: { redactRaw: true, fromSeq: 0, toSeq: 7 }, confirmationToken: preview.confirmationToken }
    const exported = await rpc('export/read', request)
    assert.equal(exported.manifest.rawRange.eventCount, 8)
    assert.equal(exported.serviceVersion, expectedVersion)
    await rpc('export/read', request, 'EXPORT_CONFIRMATION_STALE')
  }
  const other = await rpc('export/read', { sessionId: sessions[1], kind: 'analysis' })
  assert.equal(other.analysis.history.semantic.runs.length, 0)
})
console.log(JSON.stringify({ ok: true, checks, base: base.origin, sessionIds: sessions }))
