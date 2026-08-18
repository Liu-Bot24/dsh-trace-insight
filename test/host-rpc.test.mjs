import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../index.js'
import { createTraceInsightRpcHandler } from '../src/host-rpc.mjs'

function fixtureQuery(overrides = {}) {
  return {
    async readSession(sessionId) { return { session: { id: sessionId }, events: [] } },
    async listEvents() { return [] },
    async readSurface(sessionId) { return { session: { id: sessionId }, capturedThroughSeq: null, events: [] } },
    async traceSession() { return { complete: true, target: {}, ancestors: [], descendants: [], root: {} } },
    ...overrides,
  }
}

function fixtureService(overrides = {}) {
  return {
    capabilities() { return { endpoints: ['analysis/start'], features: { asyncJobs: true } } },
    async readInsight(sessionId) { return { sessionId, history: {} } },
    async readBootstrap(sessionId, options) { return { sessionId, history: { items: [], total: 0 }, options } },
    async syncProgrammatic(sessionId, options) { return { sessionId, history: { items: [], total: 0 }, sync: { changed: false }, options } },
    async readStatus(sessionId) { return { sessionId, revisions: { history: 0 } } },
    async catalog() { return { models: [] } },
    async readEffectiveSettings(sessionId) { return { sessionId, effective: {} } },
    async updateGlobalSettings(patch) { return { global: patch, revision: 1 } },
    async updateSessionSettings(sessionId, patch) { return { sessionId, sessionOverride: patch, effective: patch } },
    async updateSettings(settings) { return settings },
    async runManual(request) { return { request } },
    async previewAnalysis(request) { return { ...request, previewToken: 'preview-1', segments: [] } },
    async startAnalysis(request) { return { jobId: 'job-1', status: 'queued', request } },
    async readAnalysisJob(jobId) { return { job: { id: jobId, status: 'running' } } },
    async cancelAnalysis(jobId) { return { job: { id: jobId, status: 'cancelled' } } },
    async historyPage() { return { items: [], nextCursor: null, total: 0, revision: 0 } },
    async historyDelta(_sessionId, sinceRevision) { return { added: [], updated: [], removed: [], revision: sinceRevision } },
    async compareRuns(sessionId, leftRunId, rightRunId) { return { sessionId, leftRunId, rightRunId, comparable: true } },
    async researchSummary(sessionId) { return { sessionId, dimensions: {} } },
    async researchMembers(sessionId, request) { return { sessionId, ...request, items: [] } },
    async readEvidence(request) { return { reference: request, verified: true, events: [] } },
    async previewExport(sessionId, kind) { return { sessionId, kind, confirmationToken: 'confirm-1' } },
    async exportWithConfirmation(sessionId, kind, options, confirmationToken) { return { sessionId, kind, options, confirmationToken } },
    async exportSession(sessionId, kind) { return { sessionId, kind } },
    ...overrides,
  }
}

test('Host plugin registers event-driven analysis and a loopback-only RPC channel', () => {
  let registration
  let eventListener
  let cleanup
  const ctx = {
    sessionQuery: fixtureQuery(),
    llm: {},
    connection: {
      rpc: {
        handle(channel, handler, options) {
          registration = { channel, handler, options }
          return async () => {}
        },
      },
    },
    on(name, listener) {
      if (name === 'session/event') eventListener = listener
    },
    effect(factory) { cleanup = factory() },
  }
  apply(ctx, { autoEnabled: false, dataDir: join(tmpdir(), `trace-insight-host-${randomUUID()}`) })
  assert.deepEqual(inject, ['connection', 'sessionQuery', 'llm'])
  assert.equal(registration.channel, '/trace-insight')
  assert.deepEqual(registration.options, { authority: 'loopback' })
  assert.equal(typeof registration.handler, 'function')
  assert.equal(typeof eventListener, 'function')
  assert.equal(typeof cleanup, 'function')
})
test('session/read returns the detached raw log and companion observations', async () => {
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service: fixtureService() })
  const result = await handler('session/read', { sessionId: 'session-1' }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.value.log.session.id, 'session-1')
  assert.deepEqual(result.value.records, [])
  assert.equal(result.value.surface.capturedThroughSeq, null)
  assert.equal(result.value.lineage.complete, true)
  assert.deepEqual(result.value.diagnostics, [])
})

test('optional companion failure does not hide a valid raw log', async () => {
  const failure = Object.assign(new Error('persistence unavailable'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
  const handler = createTraceInsightRpcHandler({
    sessionQuery: fixtureQuery({ async traceSession() { throw failure } }),
    service: fixtureService(),
  })
  const result = await handler('session/read', { sessionId: 'session-1' }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.value.log.session.id, 'session-1')
  assert.equal(result.value.lineage, null)
  assert.deepEqual(result.value.diagnostics, [{ operation: 'traceSession', code: 'SESSION_QUERY_PERSISTENCE_FAILED' }])
})

test('Host handler exposes insight, settings, manual analysis, and three export modes', async () => {
  const calls = []
  const service = fixtureService({
    async updateSettings(settings, sessionId) { calls.push(['settings', settings, sessionId]); return settings },
    async runManual(request) { calls.push(['manual', request]); return { results: [] } },
  })
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service })
  const signal = new AbortController().signal
  assert.equal((await handler('insight/read', { sessionId: 's' }, signal)).ok, true)
  assert.equal((await handler('models/list', {}, signal)).ok, true)
  assert.equal((await handler('settings/update', { settings: { auto: { enabled: true } }, sessionId: 's' }, signal)).ok, true)
  assert.equal((await handler('analysis/run', {
    sessionId: 's', fromSeq: 0, toSeq: 2, route: { provider: 'p', model: 'm' }, force: false,
  }, signal)).ok, true)
  assert.equal((await handler('analysis/run', {
    sessionId: 's', fromSeq: 0, toSeq: 2, route: { provider: 'p', model: 'm' }, force: true,
  }, signal)).error.code, 'LEGACY_FORCE_UNAVAILABLE')
  for (const kind of ['raw', 'analysis', 'bundle']) {
    const response = await handler('export/read', {
      sessionId: 's',
      kind,
      ...(kind === 'analysis' ? {} : { confirmationToken: 'legacy-confirmed' }),
    }, signal)
    assert.equal(response.ok, true)
    assert.equal(response.value.kind, kind)
  }
  assert.equal(calls.length, 2)
})

test('Host handler rejects unknown endpoints, extra keys, and malformed analysis ranges', async () => {
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service: fixtureService() })
  const signal = new AbortController().signal
  const unknown = await handler('event/delete', { sessionId: 'session-1' }, signal)
  const malformed = await handler('session/read', { sessionId: '', extra: true }, signal)
  const analysis = await handler('analysis/run', { sessionId: 's', fromSeq: 0, toSeq: '2', route: {} }, signal)
  assert.equal(unknown.error.code, 'bad-request')
  assert.equal(malformed.error.code, 'bad-request')
  assert.equal(analysis.error.code, 'bad-request')
})

test('Host handler maps a missing session without leaking internal failures', async () => {
  const missing = Object.assign(new Error('sensitive backend path'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
  const handler = createTraceInsightRpcHandler({
    sessionQuery: fixtureQuery({ async readSession() { throw missing } }),
    service: fixtureService(),
  })
  const result = await handler('session/read', { sessionId: 'missing-session' }, new AbortController().signal)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-not-found')
  assert.equal(result.error.details.sessionId, 'missing-session')
  assert.doesNotMatch(result.error.message, /backend path/)
})

test('Host handler exposes scoped settings, async Jobs, pure status, history, and evidence contracts', async () => {
  const calls = []
  const service = fixtureService({
    async updateGlobalSettings(patch, expectedRevision) { calls.push(['global', patch, expectedRevision]); return { global: patch, revision: 2 } },
    async updateSessionSettings(sessionId, patch, options) { calls.push(['session', sessionId, patch, options]); return { sessionId, effective: patch } },
    async startAnalysis(request) { calls.push(['start', request]); return { jobId: 'job-new', status: 'queued', revision: 1 } },
  })
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service })
  const signal = new AbortController().signal
  assert.equal((await handler('capabilities/read', {}, signal)).value.features.asyncJobs, true)
  assert.equal((await handler('settings/effective', { sessionId: 's' }, signal)).ok, true)
  assert.equal((await handler('settings/update-global', { patch: { auto: { enabled: false } }, expectedRevision: 1 }, signal)).value.revision, 2)
  assert.equal((await handler('settings/update-session', {
    sessionId: 's', patch: { defaultRoute: { provider: 'p', model: 'm', reasoningEffort: 'high' } }, expectedRevision: 0,
  }, signal)).ok, true)
  const preview = await handler('analysis/preview', {
    sessionId: 's', mode: 'supplemental', fromSeq: 0, toSeq: 2,
    route: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  }, signal)
  assert.equal(preview.value.previewToken, 'preview-1')
  const started = await handler('analysis/start', {
    sessionId: 's', mode: 'supplemental', fromSeq: 0, toSeq: 2,
    route: { provider: 'p', model: 'm', reasoningEffort: 'high' }, previewToken: 'preview-1', idempotencyKey: 'once',
  }, signal)
  assert.equal(started.value.jobId, 'job-new')
  assert.equal((await handler('analysis/job', { jobId: 'job-new' }, signal)).value.job.status, 'running')
  assert.equal((await handler('analysis/cancel', { jobId: 'job-new', expectedRevision: 1 }, signal)).value.job.status, 'cancelled')
  assert.equal((await handler('insight/status', { sessionId: 's' }, signal)).value.sessionId, 's')
  assert.equal((await handler('history/page', { sessionId: 's', limit: 20 }, signal)).value.total, 0)
  assert.equal((await handler('history/delta', { sessionId: 's', sinceRevision: 0 }, signal)).value.revision, 0)
  assert.equal((await handler('evidence/read', { sessionId: 's', seq: 2, before: 1, after: 1 }, signal)).value.verified, true)
  assert.equal(calls.length, 3)
})

test('raw export RPC forwards only an explicit preview confirmation token', async () => {
  const calls = []
  const service = fixtureService({
    async exportWithConfirmation(sessionId, kind, options, confirmationToken) {
      calls.push({ sessionId, kind, options, confirmationToken })
      if (kind !== 'analysis' && !confirmationToken) {
        throw Object.assign(new Error('confirmation required'), { code: 'EXPORT_CONFIRMATION_REQUIRED' })
      }
      return { sessionId, kind }
    },
  })
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service })
  const signal = new AbortController().signal
  const preview = await handler('export/preview', { sessionId: 's', kind: 'raw', options: { redactRaw: true } }, signal)
  assert.equal(preview.value.confirmationToken, 'confirm-1')
  const rejected = await handler('export/read', { sessionId: 's', kind: 'raw' }, signal)
  assert.equal(rejected.error.code, 'EXPORT_CONFIRMATION_REQUIRED')
  const accepted = await handler('export/read', {
    sessionId: 's', kind: 'raw', options: { redactRaw: true }, confirmationToken: 'confirm-1',
  }, signal)
  assert.equal(accepted.ok, true)
  assert.equal(calls.at(-1).confirmationToken, 'confirm-1')
})

test('new RPC contracts reject missing preview tokens and invalid optimistic revisions', async () => {
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service: fixtureService() })
  const signal = new AbortController().signal
  const missingPreview = await handler('analysis/start', {
    sessionId: 's', mode: 'primary', fromSeq: 0, toSeq: 2, route: { provider: 'p', model: 'm' },
  }, signal)
  const badRevision = await handler('settings/update-global', { patch: {}, expectedRevision: -1 }, signal)
  const extra = await handler('insight/status', { sessionId: 's', extra: true }, signal)
  const mixedEvidence = await handler('evidence/read', { sessionId: 's', seq: 1, runId: 'run-1' }, signal)
  assert.equal(missingPreview.error.code, 'bad-request')
  assert.equal(badRevision.error.code, 'bad-request')
  assert.equal(extra.error.code, 'bad-request')
  assert.equal(mixedEvidence.error.code, 'bad-request')
})

test('P1/P2 RPC contracts forward strict bootstrap, filters, compare, research, and budget fields', async () => {
  const calls = []
  const service = fixtureService({
    async readBootstrap(sessionId, options) { calls.push(['bootstrap', sessionId, options]); return { history: { items: [], total: 0 } } },
    async syncProgrammatic(sessionId, options) { calls.push(['sync', sessionId, options]); return { history: { items: [], total: 0 }, sync: { changed: true } } },
    async historyPage(sessionId, request) { calls.push(['page', sessionId, request]); return { items: [], total: 0 } },
    async historyDelta(sessionId, revision, filters) { calls.push(['delta', sessionId, revision, filters]); return { revision } },
    async startAnalysis(request) { calls.push(['start', request]); return { jobId: 'budget-job' } },
    async compareRuns(sessionId, left, right) { calls.push(['compare', sessionId, left, right]); return { comparable: true } },
    async researchSummary(sessionId, filters) { calls.push(['summary', sessionId, filters]); return { dimensions: {} } },
    async researchMembers(sessionId, request) { calls.push(['members', sessionId, request]); return { items: [] } },
  })
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service })
  const signal = new AbortController().signal
  const filters = {
    query: 'needle', fromSeq: 1, toSeq: 9, fromTurn: 1, toTurn: 2,
    layers: ['semantic'], statuses: ['succeeded'], triggers: ['manual'], severities: ['high'],
    coverageRoles: ['supplemental'], providers: ['p'], models: ['p/m'], reasoningEfforts: ['high'],
  }
  assert.equal((await handler('insight/bootstrap', { sessionId: 's', historyLimit: 20, filters }, signal)).ok, true)
  assert.equal((await handler('programmatic/sync', { sessionId: 's', historyLimit: 20, filters }, signal)).ok, true)
  assert.equal((await handler('history/page', { sessionId: 's', cursor: 'opaque', limit: 20, filters }, signal)).ok, true)
  assert.equal((await handler('history/delta', { sessionId: 's', sinceRevision: 2, filters }, signal)).ok, true)
  assert.equal((await handler('analysis/start', {
    sessionId: 's', mode: 'supplemental', fromSeq: 0, toSeq: 2, previewToken: 'preview',
    overrideBudget: true, overrideReason: 'approved', idempotencyKey: 'once',
  }, signal)).ok, true)
  assert.equal((await handler('compare/read', { sessionId: 's', leftRunId: 'left', rightRunId: 'right' }, signal)).ok, true)
  assert.equal((await handler('annotations/list', { sessionId: 's' }, signal)).error.code, 'bad-request')
  assert.equal((await handler('research/summary', { sessionId: 's', filters }, signal)).ok, true)
  assert.equal((await handler('research/members', { sessionId: 's', dimension: 'models', key: 'p/m', limit: 20, filters }, signal)).ok, true)
  assert.equal(calls.length, 8)

  assert.equal((await handler('history/page', { sessionId: 's', cursor: 'x'.repeat((16 * 1024) + 1) }, signal)).error.code, 'INVALID_CURSOR')
  assert.equal(calls.length, 8)
  assert.equal((await handler('history/page', { sessionId: 's', filters: { unknown: true } }, signal)).error.code, 'bad-request')
  assert.equal((await handler('programmatic/sync', { sessionId: 's', extra: true }, signal)).error.code, 'bad-request')
  assert.equal((await handler('research/members', { sessionId: 's', dimension: 'models', key: 'p/m', extra: true }, signal)).error.code, 'bad-request')
  assert.equal((await handler('analysis/preview', { sessionId: 's', mode: 'supplemental', fromSeq: 0, toSeq: 2, overrideBudget: true }, signal)).error.code, 'bad-request')
})

test('resource limit failures expose only the bounded assessment needed for an operator decision', async () => {
  const service = fixtureService({
    async startAnalysis() {
      throw Object.assign(new Error('internal plan details'), {
        code: 'RESOURCE_LIMIT_EXCEEDED',
        details: { budgetAssessment: { hardLimitExceeded: true, violations: [{ code: 'MAX_CALLS_EXCEEDED', actual: 3, limit: 1 }] }, secret: 'hidden' },
      })
    },
  })
  const handler = createTraceInsightRpcHandler({ sessionQuery: fixtureQuery(), service })
  const result = await handler('analysis/start', {
    sessionId: 's', mode: 'supplemental', fromSeq: 0, toSeq: 2, previewToken: 'preview',
  }, new AbortController().signal)
  assert.equal(result.error.code, 'RESOURCE_LIMIT_EXCEEDED')
  assert.equal(result.error.details.budgetAssessment.hardLimitExceeded, true)
  assert.equal(result.error.details.secret, undefined)
})
