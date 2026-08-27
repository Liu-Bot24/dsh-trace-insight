import test from 'node:test'
import assert from 'node:assert/strict'
import { TraceInsightService } from '../src/analysis-service.mjs'
import { normalizeAnalysisSettings, stableInputHash } from '../src/analysis-policy.mjs'
import { ANALYZER_VERSION } from '../src/core.mjs'
import { MemoryHistoryStore } from '../src/history-store.mjs'
import { SemanticModelError } from '../src/model-analysis.mjs'

function completedTurn(turn, startSeq, assistantText = `Turn ${turn} complete`) {
  return [
    { type: 'turn/start', seq: startSeq, time: 1_000 + startSeq, data: { turn } },
    { type: 'step/start', seq: startSeq + 1, time: 1_001 + startSeq, data: { turn, step: 1 } },
    {
      type: 'user/message', seq: startSeq + 2, time: 1_002 + startSeq, surfaceOp: 'append', data: {
        id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Task ${turn}` }],
      },
    },
    {
      type: 'assistant/message', seq: startSeq + 3, time: 1_003 + startSeq, surfaceOp: 'append', data: {
        turn, step: 1,
        message: {
          id: `a-${turn}`, role: 'assistant', source: { kind: 'model', provider: 'main', model: 'large' },
          content: [{ type: 'text', text: assistantText }],
        },
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    },
    { type: 'step/end', seq: startSeq + 4, time: 1_004 + startSeq, data: { turn, step: 1 } },
    { type: 'turn/end', seq: startSeq + 5, time: 1_005 + startSeq, data: { turn, reason: { kind: 'completed' } } },
  ]
}

function fixture(events) {
  return {
    async readSession(sessionId) { return { session: { id: sessionId, version: 0, createdAt: 900 }, events } },
    async listEvents(sessionId) { return events.map(event => ({ sessionId, seq: event.seq, type: event.type, time: event.time })) },
    async readSurface(sessionId) { return { session: { id: sessionId }, capturedThroughSeq: events.at(-1)?.seq ?? -1, events: events.filter(event => event.surfaceOp) } },
    async traceSession() { return { complete: true, target: {}, ancestors: [], descendants: [], root: {} } },
  }
}

function semanticResult(label = '正常') {
  return {
    output: {
      verdict: label,
      narrative: `${label} narrative`,
      assessment: '合理',
      rootCauses: [],
      nextSteps: ['继续'],
      lessons: ['验证'],
      evidenceRefs: [{ seq: 3, turn: 1, note: 'assistant' }],
      risk: 'low',
      confidence: 'high',
      continuitySummary: `${label} continuity`,
    },
    rawText: `{"verdict":"${label}"}`,
    usage: { inputTokens: 30, outputTokens: 10 },
    finish: { kind: 'stop' },
  }
}

async function enroll(store, sessionId, seq = 0) {
  await store.updateSession(sessionId, history => {
    history.automatic.enrolled = true
    history.automatic.enrolledAt = new Date(1_000).toISOString()
    history.automatic.lastLiveTurnSeq = seq
    return history
  })
}

async function flushTasks() {
  await new Promise(resolve => setImmediate(resolve))
}

async function waitFor(predicate, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await flushTasks()
  }
  throw new Error('Timed out waiting for the test condition.')
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function serviceFor({ events, sessionQuery = fixture(events), modelRunner, settings, analyzer, logger, maxSegmentsPerCycle = 3 }) {
  let tick = 10_000
  const store = new MemoryHistoryStore({
    now: () => tick += 1,
    initialSettings: normalizeAnalysisSettings(settings),
  })
  const timers = []
  const service = new TraceInsightService({
    sessionQuery,
    llm: {},
    store,
    modelRunner,
    ...(analyzer ? { analyzer } : {}),
    ...(logger ? { logger } : {}),
    modelLister: async () => ({ models: [], diagnostics: [] }),
    now: () => tick += 1,
    setTimer(fn, delay) { timers.push({ fn, delay }); return timers.length },
    clearTimer() {},
    maxSegmentsPerCycle,
  })
  return { service, store, timers, advanceTime(milliseconds) { tick += milliseconds } }
}

test('turn-end waits for sessionQuery projection catch-up before making one semantic call', async () => {
  const complete = completedTurn(1, 0)
  let projected = complete.slice(0, 4)
  const dynamicQuery = {
    async readSession(sessionId) { return { session: { id: sessionId, version: 0, createdAt: 900 }, events: projected } },
    async listEvents(sessionId) { return projected.map(event => ({ sessionId, seq: event.seq, type: event.type, time: event.time })) },
    async readSurface(sessionId) { return { session: { id: sessionId }, capturedThroughSeq: projected.at(-1)?.seq ?? -1, events: projected.filter(event => event.surfaceOp) } },
    async traceSession() { return { complete: true, target: {}, ancestors: [], descendants: [], root: {} } },
  }
  let modelCalls = 0
  const { service, store, timers } = serviceFor({
    events: complete,
    sessionQuery: dynamicQuery,
    settings: { defaultRoute: { provider: 'analysis-provider', model: 'small-model' }, auto: { everyTurns: 1 } },
    modelRunner: async () => { modelCalls += 1; return semanticResult('投影已稳定') },
  })

  service.observeLiveEvent({ id: 'session-lag' }, complete.at(-1))
  await Promise.resolve()
  const firstSettle = timers.find(timer => timer.delay === 250)
  assert.ok(firstSettle)
  firstSettle.fn()
  await service.enqueue('session-lag', async () => {})
  assert.equal(modelCalls, 0)

  projected = complete
  const retrySettle = [...timers].reverse().find(timer => timer.delay === 250 && timer !== firstSettle)
  assert.ok(retrySettle)
  retrySettle.fn()
  await service.enqueue('session-lag', async () => {})

  const history = await store.getSession('session-lag')
  assert.equal(modelCalls, 1)
  assert.equal(history.semantic.runs.length, 1)
  assert.equal(history.semantic.runs[0].fromSeq, 0)
  assert.equal(history.semantic.runs[0].toSeq, 5)
})

test('automatic analysis creates per-turn programmatic checkpoints and one contiguous semantic checkpoint', async () => {
  const events = [...completedTurn(1, 0), ...completedTurn(2, 6)]
  const calls = []
  const { service, store } = serviceFor({
    events,
    settings: {
      defaultRoute: { provider: 'analysis-provider', model: 'small-model' },
      auto: { everyTurns: 2 },
    },
    modelRunner: async (_llm, request) => { calls.push(request); return semanticResult('两轮完成') },
  })
  await enroll(store, 'session-1', 11)
  const result = await service.maybeRunPrimary('session-1', 'turn-end')
  const history = await store.getSession('session-1')
  assert.equal(result.run.status, 'succeeded')
  assert.equal(history.programmatic.checkpoints.length, 2)
  assert.deepEqual(history.programmatic.checkpoints.map(item => [item.fromSeq, item.toSeq]), [[0, 5], [6, 11]])
  assert.equal(history.semantic.coveredThroughSeq, 11)
  assert.equal(history.semantic.runs.length, 1)
  assert.equal(history.semantic.runs[0].fromSeq, 0)
  assert.equal(history.semantic.runs[0].toSeq, 11)
  assert.equal(history.semantic.runs[0].inputChars <= 22_000, true)
  assert.equal(history.semantic.runs[0].settingsSnapshot.defaultRoute.model, 'small-model')
  assert.equal(calls[0].route.model, 'small-model')
  assert.equal(calls[0].envelope.evidence.every(item => item.seq >= 0 && item.seq <= 11), true)
})

test('segmented semantic analysis cannot see deterministic conclusions from a future segment', async () => {
  const events = [
    ...completedTurn(1, 0, 'FIRST_MARKER '.repeat(320)),
    ...completedTurn(2, 6, 'FUTURE_MARKER '.repeat(320)),
  ]
  const calls = []
  const analyzer = ({ rawSession, sessionId }) => {
    const serialized = JSON.stringify(rawSession.log.events)
    const seesFuture = serialized.includes('FUTURE_MARKER')
    return {
      schemaVersion: 1,
      analyzerVersion: 'test',
      generatedAt: new Date(0).toISOString(),
      sessionId,
      source: {},
      status: { kind: 'completed', label: '已完成', tone: 'success' },
      summary: seesFuture ? 'future conclusion' : 'first-segment conclusion',
      strategy: '',
      rootCause: seesFuture ? 'future root cause' : 'first root cause',
      metrics: {},
      phases: [],
      findings: [],
      lessons: [],
      finalAnswer: '',
      userGoal: seesFuture ? 'goal recovered from overall report' : '',
      limitations: [],
    }
  }
  const { service, store } = serviceFor({
    events,
    analyzer,
    maxSegmentsPerCycle: 1,
    settings: {
      defaultRoute: { provider: 'analysis-provider', model: 'small-model' },
      auto: { everyTurns: 2, maxInputChars: 4_000 },
    },
    modelRunner: async (_llm, request) => { calls.push(request); return semanticResult('第一段') },
  })
  await enroll(store, 'session-no-lookahead', 11)

  await service.maybeRunPrimary('session-no-lookahead', 'turn-end')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].envelope.coverage.toSeq, 5)
  assert.equal(calls[0].envelope.deterministic.summary, 'first-segment conclusion')
  assert.equal(calls[0].envelope.deterministic.rootCause, 'first root cause')
  assert.equal(calls[0].envelope.userGoal, 'goal recovered from overall report')
  assert.doesNotMatch(JSON.stringify(calls[0].envelope), /FUTURE_MARKER|future conclusion|future root cause/)
})

test('failed primary model run is recorded but cannot advance semantic coverage', async () => {
  const events = completedTurn(1, 0)
  const { service, store, timers } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { throw new SemanticModelError('rate limited', 'RATE_LIMIT') },
  })
  await enroll(store, 'session-failed', 5)
  const result = await service.maybeRunPrimary('session-failed', 'quiet-period')
  const history = await store.getSession('session-failed')
  assert.equal(result.run.status, 'failed')
  assert.equal(result.run.error.code, 'RATE_LIMIT')
  assert.equal(history.semantic.coveredThroughSeq, -1)
  assert.equal(history.semantic.runs.length, 1)
  assert.equal(history.semantic.retry.attempt, 1)
  assert.equal(history.semantic.retry.fromSeq, 0)
  assert.equal(timers.length, 1)
})

test('persisted retry backoff blocks every automatic trigger from repeating a failed paid call', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1 } },
    modelRunner: async () => {
      modelCalls += 1
      throw new SemanticModelError('provider unavailable', 'NO_ADAPTER')
    },
  })
  await enroll(store, 'session-backoff', 5)
  await service.maybeRunPrimary('session-backoff', 'turn-end')
  const second = await service.maybeRunPrimary('session-backoff', 'turn-end')
  const third = await service.maybeRunPrimary('session-backoff', 'settings-change')
  const history = await store.getSession('session-backoff')
  assert.equal(modelCalls, 1)
  assert.equal(second.decision.reason, 'retry-backoff')
  assert.equal(third.decision.reason, 'retry-backoff')
  assert.equal(history.semantic.runs.length, 1)
})

test('read insight surfaces an active retry backoff before accumulation thresholds are met', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 4, quietPeriodMs: 90_000 } },
    modelRunner: async () => {
      modelCalls += 1
      throw new SemanticModelError('temporarily unavailable', 'RATE_LIMIT')
    },
  })
  await enroll(store, 'session-visible-backoff', 5)
  await service.maybeRunPrimary('session-visible-backoff', 'quiet-period')

  const insight = await service.readInsight('session-visible-backoff')
  assert.equal(insight.autoDecision.reason, 'retry-backoff')
  assert.equal(insight.autoDecision.retryAttempt, 1)
  assert.equal(insight.autoDecision.retryCode, 'RATE_LIMIT')
  assert.equal(insight.autoDecision.retryAt, insight.history.semantic.retry.notBefore)
  assert.equal(modelCalls, 1)
})

test('retryable automatic failures pause after three paid attempts', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store, advanceTime } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1 } },
    modelRunner: async () => {
      modelCalls += 1
      throw new SemanticModelError('temporarily unavailable', 'RATE_LIMIT')
    },
  })
  await enroll(store, 'session-retry-limit', 5)

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await service.maybeRunPrimary('session-retry-limit', 'quiet-period')
    assert.equal(result.run.retryAttempt, attempt)
    assert.equal(result.run.retryPaused, attempt === 3)
    advanceTime(4_000_000)
  }
  const paused = await service.maybeRunPrimary('session-retry-limit', 'quiet-period')
  const history = await store.getSession('session-retry-limit')
  assert.equal(paused.decision.reason, 'retry-paused')
  assert.equal(modelCalls, 3)
  assert.equal(history.semantic.retry.pauseReason, 'attempt-limit')
  assert.equal(history.semantic.runs.length, 3)
})

test('paused retry resolves the exact automatic failure, not later backlog or a manual failure', async () => {
  const events = Array.from({ length: 10 }, (_, index) => completedTurn(index + 1, index * 6)).flat()
  let failing = true
  let calls = 0
  const { service, store, advanceTime } = serviceFor({ events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1, maxPendingEvents: 20, maxInputChars: 4000 } },
    modelRunner: async () => { calls++; if (failing) throw new SemanticModelError('offline', 'TRANSPORT'); return semanticResult() },
  })
  await enroll(store, 'exact-retry', 59)
  for (let attempt = 0; attempt < 3; attempt++) {
    await service.maybeRunPrimary('exact-retry', 'quiet-period')
    advanceTime(4_000_000)
  }
  const before = await store.getSession('exact-retry')
  const original = before.semantic.runs.at(-1)
  assert.ok(original.toSeq < 59)
  await store.updateSession('exact-retry', current => {
    current.semantic.runs.push({ ...original, id: 'later-manual', mode: 'manual', toSeq: 59, completedAt: new Date(99_000_000).toISOString() })
    return current
  })
  const status = await service.readStatus('exact-retry')
  assert.equal(status.autoDecision.reason, 'retry-paused')
  assert.equal(status.latest.semanticFailure.id, 'later-manual')
  assert.equal(status.retry.runId, original.id)
  assert.equal(status.retry.toSeq, original.toSeq)
  assert.equal(calls, 3, 'reading retry state does not call a model')
  failing = false
  const request = { sessionId: 'exact-retry', mode: 'primary', fromSeq: status.retry.fromSeq, toSeq: status.retry.toSeq, route: status.retry.route }
  const preview = await service.previewAnalysis(request)
  const started = await service.startAnalysis({ ...request, previewToken: preview.previewToken })
  await service.enqueue('exact-retry', async () => {})
  assert.equal((await service.readAnalysisJob(started.jobId, 'exact-retry')).job.status, 'succeeded')
  const after = await service.readStatus('exact-retry')
  assert.equal(after.retry, null)
  assert.equal(after.coverage.semanticThroughSeq, original.toSeq)
  assert.equal(calls, 3 + preview.modelCalls)
})

test('multi-batch primary job automatically reaches the final range without an override', async () => {
  const events = Array.from({ length: 12 }, (_, index) => completedTurn(index + 1, index * 6)).flat()
  const observedBatches = []
  const inputSizes = []
  const { service, store } = serviceFor({ events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { maxPendingEvents: 20, maxInputChars: 4000 },
      resourcePolicy: { maxCallsPerJob: 1, maxInputCharsPerJob: 4000 } },
    modelRunner: async (_llm, request) => {
      const status = await service.readStatus('all-batches')
      observedBatches.push(status.activeJobs[0].batchProgress.current)
      inputSizes.push(JSON.stringify(request.envelope).length)
      return semanticResult('batch complete')
    },
  })
  const request = { sessionId: 'all-batches', mode: 'primary', fromSeq: 0, toSeq: 71, route: { provider: 'p', model: 'm' }, force: true }
  const preview = await service.previewAnalysis(request)
  assert.ok(preview.batchPlan.totalBatches >= 3)
  assert.equal(preview.budgetAssessment.hardLimitExceeded, false)
  const started = await service.startAnalysis({ ...request, previewToken: preview.previewToken })
  await service.enqueue('all-batches', async () => {})
  const job = (await service.readAnalysisJob(started.jobId, 'all-batches')).job
  assert.equal(job.status, 'succeeded')
  assert.equal(job.batchProgress.completed, preview.batchPlan.totalBatches)
  assert.deepEqual(observedBatches, preview.batchPlan.batches.map(batch => batch.index))
  assert.ok(inputSizes.every(size => size <= 4000))
  assert.equal((await store.getSession('all-batches')).semantic.coveredThroughSeq, 71)
  assert.equal(job.resourceOverride, null)
})

test('failure in a later batch preserves previous work and stops every following batch', async () => {
  const events = Array.from({ length: 12 }, (_, index) => completedTurn(index + 1, index * 6)).flat()
  let calls = 0
  const { service, store } = serviceFor({ events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { maxPendingEvents: 20, maxInputChars: 4000 }, resourcePolicy: { maxCallsPerJob: 1 } },
    modelRunner: async () => { if (++calls === 2) throw new SemanticModelError('batch two failed', 'TRANSPORT'); return semanticResult() },
  })
  const request = { sessionId: 'failed-batch', mode: 'primary', fromSeq: 0, toSeq: 71, route: { provider: 'p', model: 'm' } }
  const preview = await service.previewAnalysis(request)
  const started = await service.startAnalysis({ ...request, previewToken: preview.previewToken })
  await service.enqueue('failed-batch', async () => {})
  const job = (await service.readAnalysisJob(started.jobId, 'failed-batch')).job
  assert.equal(job.status, 'failed')
  assert.equal(job.batchProgress.completed, 1)
  assert.equal(calls, 2)
  assert.equal((await store.getSession('failed-batch')).semantic.coveredThroughSeq, preview.segments[0].toSeq)
  assert.equal(job.retrySegment.fromSeq, preview.segments[1].fromSeq)
  assert.equal(job.segmentStatusCounts.planned, preview.segments.length - 2)
})

test('cancelling during a later batch stops the remainder without losing completed batches', async () => {
  const events = Array.from({ length: 12 }, (_, index) => completedTurn(index + 1, index * 6)).flat()
  let calls = 0
  const waiting = deferred()
  const { service, store } = serviceFor({ events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { maxPendingEvents: 20, maxInputChars: 4000 }, resourcePolicy: { maxCallsPerJob: 1 } },
    modelRunner: async (_llm, { signal }) => {
      if (++calls === 1) return semanticResult()
      waiting.resolve()
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new SemanticModelError('cancelled', 'MODEL_ABORTED')), { once: true }))
    },
  })
  const request = { sessionId: 'cancel-batch', mode: 'primary', fromSeq: 0, toSeq: 71, route: { provider: 'p', model: 'm' } }
  const preview = await service.previewAnalysis(request)
  const started = await service.startAnalysis({ ...request, previewToken: preview.previewToken })
  await waiting.promise
  await service.cancelAnalysis(started.jobId, { sessionId: 'cancel-batch' })
  await service.enqueue('cancel-batch', async () => {})
  const job = (await service.readAnalysisJob(started.jobId, 'cancel-batch')).job
  assert.equal(job.status, 'cancelled')
  assert.equal(job.batchProgress.completed, 1)
  assert.equal(calls, 2)
  assert.equal((await store.getSession('cancel-batch')).semantic.coveredThroughSeq, preview.segments[0].toSeq)
})

test('non-retryable model output pauses immediately and preserves partial failure evidence', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1 } },
    modelRunner: async () => {
      modelCalls += 1
      throw new SemanticModelError('invalid report', 'MODEL_INVALID_FORMAT', {
        rawText: 'partial non-JSON analysis',
        usage: { inputTokens: 40, outputTokens: 12 },
        finish: { kind: 'stop' },
      })
    },
  })
  await enroll(store, 'session-non-retryable', 5)

  const first = await service.maybeRunPrimary('session-non-retryable', 'quiet-period')
  const second = await service.maybeRunPrimary('session-non-retryable', 'quiet-period')
  const run = (await store.getSession('session-non-retryable')).semantic.runs[0]
  assert.equal(first.run.retryPaused, true)
  assert.equal(second.decision.reason, 'retry-paused')
  assert.equal(modelCalls, 1)
  assert.equal(run.rawText, 'partial non-JSON analysis')
  assert.deepEqual(run.usage, { inputTokens: 40, outputTokens: 12 })
  assert.deepEqual(run.finish, { kind: 'stop' })
})

test('a new Turn cannot cancel the persisted retry wake-up', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store, timers } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1, quietPeriodMs: 600_000 } },
    modelRunner: async () => {
      modelCalls += 1
      throw new SemanticModelError('provider unavailable', 'NO_ADAPTER')
    },
  })
  await enroll(store, 'session-retry-wakeup', 5)
  await service.maybeRunPrimary('session-retry-wakeup', 'turn-end')
  const originalRetryDelay = timers.at(-1).delay

  service.observeLiveEvent({ id: 'session-retry-wakeup' }, events.at(-1))
  await service.enqueue('session-retry-wakeup', async () => {})
  assert.equal(Math.abs(timers.at(-1).delay - originalRetryDelay) < 100, true)
  const settle = [...timers].reverse().find(timer => timer.delay === 250)
  assert.ok(settle)
  settle.fn()
  await service.enqueue('session-retry-wakeup', async () => {})

  assert.equal(modelCalls, 1)
  assert.equal((await store.getSession('session-retry-wakeup')).semantic.retry.attempt, 1)
  assert.equal(timers.at(-1).delay > 250_000, true)
  assert.equal(Math.abs(timers.at(-1).delay - originalRetryDelay) < 100, true)
})

test('model dispatch is globally serialized across sessions during recovery bursts', async () => {
  const events = completedTurn(1, 0)
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  let calls = 0
  let active = 0
  let peak = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1 } },
    modelRunner: async () => {
      calls += 1
      active += 1
      peak = Math.max(peak, active)
      if (calls === 1) await firstGate
      active -= 1
      return semanticResult(`call-${calls}`)
    },
  })
  await enroll(store, 'session-burst-a', 5)
  await enroll(store, 'session-burst-b', 5)

  const first = service.maybeRunPrimary('session-burst-a', 'quiet-period')
  await flushTasks()
  const second = service.maybeRunPrimary('session-burst-b', 'quiet-period')
  await flushTasks()
  assert.equal(calls, 1)
  assert.equal(active, 1)

  releaseFirst()
  await Promise.all([first, second])
  assert.equal(calls, 2)
  assert.equal(peak, 1)
})

test('disposing the service aborts active and queued model work without rearming timers', async () => {
  const events = completedTurn(1, 0)
  const { service, store, timers } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1 } },
    modelRunner: async (_llm, request) => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'MODEL_ABORTED' })), { once: true })
    }),
  })
  await enroll(store, 'session-dispose-a', 5)
  await enroll(store, 'session-dispose-b', 5)

  const first = service.maybeRunPrimary('session-dispose-a', 'quiet-period')
  const second = service.maybeRunPrimary('session-dispose-b', 'quiet-period')
  await flushTasks()
  service.dispose()
  const results = await Promise.all([first, second])

  assert.deepEqual(results.map(result => result.run.status), ['failed', 'failed'])
  assert.equal(timers.length, 0)
  assert.equal(service.modelWaiters.length, 0)
})

test('read polling is model-side-effect free and cannot postpone the anchored quiet timer', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, timers } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 4, quietPeriodMs: 90_000 } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  service.observeLiveEvent({ id: 'session-poll' }, events.at(-1))
  await service.enqueue('session-poll', async () => {})
  const timerCount = timers.length
  await service.readInsight('session-poll')
  await service.readInsight('session-poll')
  assert.equal(modelCalls, 0)
  assert.equal(timers.length, timerCount)
})

test('startup recovery re-anchors a known pending session to its original Turn-end quiet deadline', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store, timers } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 4, quietPeriodMs: 5_000 } },
    modelRunner: async () => { modelCalls += 1; return semanticResult('重启恢复') },
  })
  await store.updateSession('session-startup', history => history)
  await enroll(store, 'session-startup', 5)
  await service.start()
  const recoveryTimer = timers.find(timer => timer.delay === 0)
  assert.ok(recoveryTimer)
  assert.equal(modelCalls, 0)
  recoveryTimer.fn()
  await service.enqueue('session-startup', async () => {})
  assert.equal(modelCalls, 1)
  assert.equal((await store.getSession('session-startup')).semantic.coveredThroughSeq, 5)
})

test('viewing a historical session does not enroll it for model calls on restart', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store, timers } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1, quietPeriodMs: 5_000 } },
    modelRunner: async () => { modelCalls += 1; return semanticResult('历史回填') },
  })

  const view = await service.readInsight('session-view-only')
  assert.equal(view.autoDecision.reason, 'manual-backfill-required')
  assert.equal((await store.getSession('session-view-only')).automatic.enrolled, false)
  await service.start()
  assert.equal(modelCalls, 0)
  assert.equal(timers.length, 0)

  service.observeLiveEvent({ id: 'session-view-only' }, events.at(-1))
  await service.enqueue('session-view-only', async () => {})
  const settle = timers.find(timer => timer.delay === 250)
  assert.ok(settle)
  settle.fn()
  await service.enqueue('session-view-only', async () => {})
  assert.equal(modelCalls, 1)
  assert.equal((await store.getSession('session-view-only')).automatic.enrolled, true)
})

test('a process restart converts stale running records to interrupted failures', async () => {
  const events = completedTurn(1, 0)
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => semanticResult(),
  })
  await store.updateSession('session-stale', history => {
    history.semantic.runs.push({
      id: 'stale-run',
      kind: 'semantic',
      mode: 'auto',
      coverageRole: 'primary',
      status: 'running',
      fromSeq: 0,
      toSeq: 5,
      route: { provider: 'p', model: 'm' },
      startedAt: new Date(0).toISOString(),
      createdAt: new Date(0).toISOString(),
    })
    return history
  })
  await service.readInsight('session-stale')
  const history = await store.getSession('session-stale')
  assert.equal(history.semantic.runs[0].status, 'failed')
  assert.equal(history.semantic.runs[0].error.code, 'ANALYSIS_INTERRUPTED')
  assert.equal(history.semantic.retry.code, 'ANALYSIS_INTERRUPTED')
  assert.equal(history.diagnostics.at(-1).operation, 'startup-recovery')
})

test('Job recovery preserves a terminal linked segment instead of erasing completed work', async () => {
  const events = completedTurn(1, 0)
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => semanticResult(),
  })
  await store.updateSession('session-job-recovery', history => {
    history.semantic.runs.push({
      id: 'linked-run', kind: 'semantic', mode: 'manual', coverageRole: 'primary', status: 'succeeded',
      fromSeq: 0, toSeq: 5, route: { provider: 'p', model: 'm' }, output: semanticResult('done').output,
      startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), createdAt: new Date(0).toISOString(),
    })
    history.jobs.push({
      id: 'stale-job', kind: 'manual-analysis', status: 'running', coverageRole: 'primary',
      createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(), completedAt: null,
      progress: { completed: 0, total: 1, current: 0 },
      segments: [{ index: 0, status: 'running', runId: 'linked-run', fromSeq: 0, toSeq: 5 }],
    })
    return history
  })
  await service.readInsight('session-job-recovery')
  const history = await store.getSession('session-job-recovery')
  assert.equal(history.jobs[0].status, 'succeeded')
  assert.equal(history.jobs[0].segments[0].status, 'succeeded')
  assert.equal(history.jobs[0].progress.completed, 1)
  assert.equal(history.semantic.retry, null)
})

test('crash recovery preserves the retry ceiling instead of resetting a third attempt', async () => {
  const events = completedTurn(1, 0)
  const settings = normalizeAnalysisSettings({
    defaultRoute: { provider: 'p', model: 'm' },
    auto: { everyTurns: 1 },
  })
  let modelCalls = 0
  const { service, store, timers } = serviceFor({
    events,
    settings,
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  await store.updateSession('session-stale-third', history => {
    history.automatic.enrolled = true
    history.semantic.retry = {
      fromSeq: 0,
      route: { provider: 'p', model: 'm' },
      attempt: 2,
      notBefore: new Date(0).toISOString(),
      code: 'RATE_LIMIT',
      paused: false,
    }
    history.semantic.runs.push({
      id: 'stale-third-run',
      kind: 'semantic',
      mode: 'auto',
      coverageRole: 'primary',
      status: 'running',
      fromSeq: 0,
      toSeq: 5,
      route: { provider: 'p', model: 'm' },
      settingsSnapshot: settings,
      startedAt: new Date(0).toISOString(),
      createdAt: new Date(0).toISOString(),
    })
    return history
  })

  await service.start()
  const history = await store.getSession('session-stale-third')
  assert.equal(modelCalls, 0)
  assert.equal(timers.length, 0)
  assert.equal(history.semantic.runs[0].retryAttempt, 3)
  assert.equal(history.semantic.runs[0].retryPaused, true)
  assert.equal(history.semantic.retry.attempt, 3)
  assert.equal(history.semantic.retry.paused, true)
  assert.equal(history.semantic.retry.notBefore, null)
})

test('background failures are logged and persisted as visible session diagnostics', async () => {
  const events = completedTurn(1, 0)
  const warnings = []
  const { service, store } = serviceFor({
    events,
    logger: { warn: (...args) => warnings.push(args) },
    settings: { defaultRoute: null },
    modelRunner: async () => semanticResult(),
  })
  service.handleBackgroundFailure('session-diagnostic', 'projection-settle', Object.assign(new Error('projection failed'), { code: 'PROJECTION_FAILED' }))
  await store.enqueue('session:session-diagnostic', async () => {})
  const history = await store.getSession('session-diagnostic')
  assert.equal(warnings.length, 1)
  assert.equal(history.diagnostics.at(-1).code, 'PROJECTION_FAILED')
  assert.equal(history.diagnostics.at(-1).operation, 'projection-settle')
  assert.equal(history.diagnostics.at(-1).resolvedAt, null)
})

test('diagnostic lifecycle resolves restart leftovers and clears a current alert after the same operation succeeds', async () => {
  const events = completedTurn(1, 0)
  const warnings = []
  const { service, store } = serviceFor({
    events,
    logger: { warn: (...args) => warnings.push(args) },
    settings: { defaultRoute: null },
    modelRunner: async () => semanticResult(),
  })
  await store.updateSession('session-diagnostic-age', history => {
    history.diagnostics.push({
      id: 'diagnostic-before-restart',
      kind: 'service-error',
      operation: 'turn-observation',
      code: 'EPERM',
      message: 'old process rename failed',
      at: new Date(service.startedAtMs - 1).toISOString(),
    })
    return history
  })

  await service.start()
  const restartedStatus = await service.readStatus('session-diagnostic-age')
  let historyPage = await service.historyPage('session-diagnostic-age', { limit: 10 })
  assert.equal(restartedStatus.latest.diagnostic, null)
  assert.ok(historyPage.items.find(item => item.id === 'diagnostic-before-restart')?.resolvedAt)

  service.handleBackgroundFailure('session-diagnostic-age', 'projection-settle', Object.assign(new Error('current failure'), { code: 'PROJECTION_FAILED' }))
  await store.enqueue('session:session-diagnostic-age', async () => {})
  const currentStatus = await service.readStatus('session-diagnostic-age')
  assert.equal(currentStatus.latest.diagnostic.code, 'PROJECTION_FAILED')
  assert.equal(currentStatus.latest.diagnostic.operation, 'projection-settle')
  assert.equal(warnings.length, 1)

  service.runInBackground('session-diagnostic-age', 'projection-settle', Promise.resolve())
  await flushTasks()
  await store.enqueue('session:session-diagnostic-age', async () => {})
  const recoveredStatus = await service.readStatus('session-diagnostic-age')
  historyPage = await service.historyPage('session-diagnostic-age', { limit: 10 })
  assert.equal(recoveredStatus.latest.diagnostic, null)
  assert.ok(historyPage.items.find(item => item.operation === 'projection-settle')?.resolvedAt)
})

test('a late failure cannot resurrect a diagnostic after a newer operation succeeded', async () => {
  const events = completedTurn(1, 0)
  const { service, store } = serviceFor({
    events,
    logger: { warn() {} },
    settings: { defaultRoute: null },
    modelRunner: async () => semanticResult(),
  })
  const diagnosticWriteEntered = deferred()
  const releaseDiagnosticWrite = deferred()
  const originalUpdate = store.updateSession.bind(store)
  store.updateSession = (sessionId, updater, options) => originalUpdate(sessionId, async history => {
    const before = history.diagnostics.length
    const proposed = await updater(history)
    if (proposed.diagnostics.length > before && proposed.diagnostics.at(-1)?.operation === 'race-operation') {
      diagnosticWriteEntered.resolve()
      await releaseDiagnosticWrite.promise
    }
    return proposed
  }, options)

  const slowFailure = deferred()
  service.runInBackground('session-diagnostic-race', 'race-operation', slowFailure.promise)
  slowFailure.reject(Object.assign(new Error('late failure'), { code: 'LATE_FAILURE' }))
  await diagnosticWriteEntered.promise
  service.runInBackground('session-diagnostic-race', 'race-operation', Promise.resolve())
  await flushTasks()
  releaseDiagnosticWrite.resolve()
  await store.enqueue('session:session-diagnostic-race', async () => {})
  await flushTasks()

  const history = await store.getSession('session-diagnostic-race')
  assert.equal(history.diagnostics.length, 1)
  assert.ok(history.diagnostics[0].resolvedAt)
  assert.equal(history.diagnostics[0].resolution, 'superseded-by-later-success')
})

test('manual segment can use a stronger alternate model without mutating primary coverage', async () => {
  const events = [...completedTurn(1, 0), ...completedTurn(2, 6)]
  const calls = []
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'cheap', model: 'small' }, auto: { everyTurns: 99 } },
    modelRunner: async (_llm, request) => { calls.push(request.route); return semanticResult(request.route.model) },
  })
  const response = await service.runManual({
    sessionId: 'session-manual',
    fromSeq: 6,
    toSeq: 11,
    route: { provider: 'premium', model: 'large-reasoning' },
  })
  const history = await store.getSession('session-manual')
  assert.equal(response.results[0].run.status, 'succeeded')
  assert.deepEqual(calls, [{ provider: 'premium', model: 'large-reasoning' }])
  assert.equal(history.semantic.coveredThroughSeq, -1)
  assert.equal(history.semantic.runs[0].coverageRole, 'supplemental')
  assert.equal(history.semantic.runs[0].fromSeq, 6)
  assert.equal(history.semantic.runs[0].toSeq, 11)
  assert.equal((await service.readStatus('session-manual')).latest.semanticSuccess, null)
})

test('a cached manual rerun appends a distinct auditable timeline record', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'cheap', model: 'small' }, auto: { everyTurns: 99 } },
    modelRunner: async () => { modelCalls += 1; return semanticResult('cached manual') },
  })
  const request = {
    sessionId: 'session-manual-cache',
    fromSeq: 0,
    toSeq: 5,
    route: { provider: 'premium', model: 'strong' },
  }
  const first = await service.runManual(request)
  const second = await service.runManual(request)
  const history = await store.getSession('session-manual-cache')

  assert.equal(modelCalls, 1)
  assert.equal(second.results[0].cached, true)
  assert.equal(history.semantic.runs.length, 2)
  assert.notEqual(history.semantic.runs[0].id, history.semantic.runs[1].id)
  assert.equal(history.semantic.runs[1].cachedFromRunId, first.results[0].run.id)
  assert.equal(history.semantic.runs[1].coverageRole, 'supplemental')
  assert.equal(history.semantic.coveredThroughSeq, -1)
})

test('legacy manual analysis enforces the configured resource policy before any model call', async () => {
  const events = [
    ...completedTurn(1, 0), ...completedTurn(2, 6),
    ...completedTurn(3, 12), ...completedTurn(4, 18),
  ]
  let modelCalls = 0
  const { service } = serviceFor({
    events,
    settings: {
      defaultRoute: { provider: 'p', model: 'm' },
      auto: { maxPendingEvents: 20 },
      resourcePolicy: { maxCallsPerJob: 1, warnCallsPerJob: 1 },
    },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  await assert.rejects(
    service.runManual({ sessionId: 'legacy-budget', fromSeq: 0, toSeq: 23, route: { provider: 'p', model: 'm' } }),
    error => error?.code === 'RESOURCE_LIMIT_EXCEEDED',
  )
  assert.equal(modelCalls, 0)
})

test('legacy settings updates use an optimistic revision instead of silently overwriting each other', async () => {
  const { service } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  const outcomes = await Promise.allSettled([
    service.updateSettings({ auto: { enabled: false } }),
    service.updateSettings({ auto: { everyTurns: 9 } }),
  ])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason?.code === 'REVISION_CONFLICT').length, 1)
})

test('without a configured default route automatic processing stays deterministic-only', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: null },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  const response = await service.maybeRunPrimary('session-waiting', 'quiet-period')
  const history = await store.getSession('session-waiting')
  assert.equal(response.decision.reason, 'waiting-for-model')
  assert.equal(modelCalls, 0)
  assert.equal(history.programmatic.coveredThroughSeq, 5)
  assert.equal(history.semantic.coveredThroughSeq, -1)
})

test('saving a global default model resumes every enrolled Session, not only the visible one', async () => {
  const events = completedTurn(1, 0)
  const calls = []
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: null, auto: { everyTurns: 1 } },
    modelRunner: async (_llm, request) => {
      calls.push(request.route)
      return semanticResult(request.route.model)
    },
  })
  await enroll(store, 'session-settings-a', 5)
  await enroll(store, 'session-settings-b', 5)

  await service.updateSettings({ defaultRoute: { provider: 'analysis', model: 'cheap' } }, 'session-settings-a')
  await waitFor(() => calls.length === 2)
  await service.enqueue('session-settings-a', async () => {})
  await service.enqueue('session-settings-b', async () => {})

  assert.equal(calls.length, 2)
  assert.equal((await store.getSession('session-settings-a')).semantic.coveredThroughSeq, 5)
  assert.equal((await store.getSession('session-settings-b')).semantic.coveredThroughSeq, 5)
})

test('raw, analysis, and bundle exports keep their data planes distinct', async () => {
  const events = completedTurn(1, 0)
  const { service } = serviceFor({
    events,
    settings: { defaultRoute: null },
    modelRunner: async () => semanticResult(),
  })
  await service.readInsight('session-export')
  const raw = await service.exportSession('session-export', 'raw')
  const analysis = await service.exportSession('session-export', 'analysis')
  const bundle = await service.exportSession('session-export', 'bundle')
  assert.ok(raw.raw.log.events)
  assert.equal(raw.analysis, undefined)
  assert.ok(analysis.analysis.history)
  assert.equal(analysis.raw, undefined)
  assert.ok(bundle.raw.log.events)
  assert.ok(bundle.analysis.history)
})

test('effective settings isolate Session overrides and enforce optimistic revisions', async () => {
  const events = completedTurn(1, 0)
  const { service } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'global', model: 'flash', reasoningEffort: 'low' } },
    modelRunner: async () => semanticResult(),
  })
  const initial = await service.readEffectiveSettings('session-a')
  assert.equal(initial.revision.global, 0)
  assert.equal(initial.revision.session, 0)

  const overridden = await service.updateSessionSettings('session-a', {
    defaultRoute: { provider: 'premium', model: 'reasoning', reasoningEffort: 'high' },
    resourcePolicy: { maxCallsPerJob: 5, warnCallsPerJob: 3 },
  }, { expectedRevision: 0 })
  assert.equal(overridden.effective.defaultRoute.model, 'reasoning')
  assert.equal(overridden.effective.defaultRoute.reasoningEffort, 'high')
  assert.equal(overridden.effective.resourcePolicy.maxCallsPerJob, 5)
  assert.equal(overridden.source.resourcePolicy, 'mixed')
  assert.equal((await service.readEffectiveSettings('session-b')).effective.defaultRoute.model, 'flash')
  await assert.rejects(
    service.updateSessionSettings('session-a', { auto: { enabled: false } }, { expectedRevision: 0 }),
    error => error?.code === 'REVISION_CONFLICT',
  )

  const reset = await service.updateSessionSettings('session-a', {}, { reset: true, expectedRevision: 1 })
  assert.equal(reset.sessionOverride, null)
  assert.equal(reset.effective.defaultRoute.model, 'flash')
  const global = await service.updateGlobalSettings({ auto: { enabled: false }, resourcePolicy: { maxCallsPerJob: 7 } }, 0)
  assert.equal(global.revision, 1)
  assert.equal(global.global.resourcePolicy.maxCallsPerJob, 7)
  await assert.rejects(service.updateGlobalSettings({ auto: { enabled: true } }, 0), error => error?.code === 'REVISION_CONFLICT')
})

test('manual preview is side-effect free, closed-Turn bounded, and stale-token protected', async () => {
  const events = [...completedTurn(1, 0), { type: 'turn/start', seq: 6, time: 2_000, data: { turn: 2 } }]
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  const before = await store.getSession('session-preview')
  const preview = await service.previewAnalysis({
    sessionId: 'session-preview', mode: 'supplemental', fromSeq: 0, toSeq: 5,
  })
  const after = await store.getSession('session-preview')
  assert.equal(preview.segments.length, 1)
  assert.equal(preview.bindings.closedThroughSeq, 5)
  assert.equal(after.revision, before.revision)
  assert.equal(modelCalls, 0)
  await assert.rejects(
    service.previewAnalysis({ sessionId: 'session-preview', mode: 'supplemental', fromSeq: 0, toSeq: 6 }),
    error => error?.code === 'INVALID_RANGE',
  )
  await store.updateSession('session-preview', history => history)
  await assert.rejects(
    service.startAnalysis({ ...preview, previewToken: preview.previewToken, idempotencyKey: 'stale-preview' }),
    error => error?.code === 'PREVIEW_STALE',
  )
})

test('async manual Jobs are idempotent and keep supplemental and primary watermarks distinct', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult('job') },
  })
  const supplementalPreview = await service.previewAnalysis({
    sessionId: 'session-job', mode: 'supplemental', fromSeq: 0, toSeq: 5,
  })
  const request = {
    sessionId: 'session-job', mode: 'supplemental', fromSeq: 0, toSeq: 5,
    route: supplementalPreview.route, previewToken: supplementalPreview.previewToken, idempotencyKey: 'job-once',
  }
  const first = await service.startAnalysis(request)
  const duplicate = await service.startAnalysis(request)
  assert.equal(duplicate.jobId, first.jobId)
  assert.equal(first.job.segments, undefined)
  assert.equal(first.job.totalSegments, 1)
  assert.equal(duplicate.job.segments, undefined)
  await service.enqueue('session-job', async () => {})
  let history = await store.getSession('session-job')
  assert.equal(history.jobs.find(job => job.id === first.jobId).status, 'succeeded')
  assert.equal(history.semantic.coveredThroughSeq, -1)

  const primaryPreview = await service.previewAnalysis({
    sessionId: 'session-job', mode: 'primary', fromSeq: 0, toSeq: 5,
  })
  const primary = await service.startAnalysis({
    sessionId: 'session-job', mode: 'primary', fromSeq: 0, toSeq: 5,
    route: primaryPreview.route, previewToken: primaryPreview.previewToken, idempotencyKey: 'primary-once',
  })
  await service.enqueue('session-job', async () => {})
  history = await store.getSession('session-job')
  const primaryJob = history.jobs.find(job => job.id === primary.jobId)
  assert.equal(primaryJob.status, 'succeeded')
  assert.equal(primaryJob.segments[0].runId !== null, true)
  assert.equal(history.semantic.coveredThroughSeq, 5)
  assert.equal(modelCalls, 1)
})

test('a supplemental retry can continue from the immediately preceding supplemental summary', async () => {
  const events = [...completedTurn(1, 0), ...completedTurn(2, 6)]
  const envelopes = []
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async (_llm, request) => { envelopes.push(request.envelope); return semanticResult('continued') },
  })
  await store.updateSession('session-supplemental-continuity', history => {
    history.semantic.runs.push({
      id: 'prior-supplemental', status: 'succeeded', mode: 'manual', coverageRole: 'supplemental',
      fromSeq: 0, toSeq: 5, route: { provider: 'p', model: 'm' },
      output: { ...semanticResult('prior').output, continuitySummary: 'supplemental checkpoint' },
      createdAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(),
    })
    return history
  })
  const preview = await service.previewAnalysis({
    sessionId: 'session-supplemental-continuity', mode: 'supplemental', fromSeq: 6, toSeq: 11,
  })
  await service.startAnalysis({
    sessionId: 'session-supplemental-continuity', mode: 'supplemental', fromSeq: 6, toSeq: 11,
    route: preview.route, previewToken: preview.previewToken,
  })
  await service.enqueue('session-supplemental-continuity', async () => {})
  assert.equal(envelopes[0].previousContinuitySummary, 'supplemental checkpoint')
})

test('cancelling a running manual primary Job preserves completed facts without creating automatic retry state', async () => {
  const events = completedTurn(1, 0)
  let modelStarted = false
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async (_llm, request) => new Promise((resolve, reject) => {
      modelStarted = true
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'MODEL_ABORTED' })), { once: true })
    }),
  })
  const preview = await service.previewAnalysis({ sessionId: 'session-cancel', mode: 'primary', fromSeq: 0, toSeq: 5 })
  const started = await service.startAnalysis({
    sessionId: 'session-cancel', mode: 'primary', fromSeq: 0, toSeq: 5,
    route: preview.route, previewToken: preview.previewToken,
  })
  await waitFor(() => modelStarted)
  const running = (await service.readAnalysisJob(started.jobId)).job
  await service.cancelAnalysis(started.jobId, { expectedRevision: running.revision })
  await service.enqueue('session-cancel', async () => {})
  const history = await store.getSession('session-cancel')
  const job = history.jobs.find(item => item.id === started.jobId)
  assert.equal(job.status, 'cancelled')
  assert.equal(job.segments[0].runId !== null, true)
  assert.equal(history.semantic.runs[0].status, 'cancelled')
  assert.equal(history.semantic.coveredThroughSeq, -1)
  assert.equal(history.semantic.retry, null)
})

test('status is a pure store read and history page/delta expose revisioned records', async () => {
  const events = completedTurn(1, 0)
  let observationReads = 0
  const sessionQuery = fixture(events)
  const originalRead = sessionQuery.readSession
  sessionQuery.readSession = async (...args) => { observationReads += 1; return originalRead(...args) }
  const { service, store } = serviceFor({
    events,
    sessionQuery,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => semanticResult(),
  })
  await store.updateSession('session-status', history => {
    history.lastObservedSeq = 5
    history.lastClosedSeq = 5
    history.programmatic.checkpoints.push({ id: 'checkpoint-status', toSeq: 5, capturedAt: new Date(0).toISOString() })
    return history
  })
  const revision = (await store.getSession('session-status')).revision
  const status = await service.readStatus('session-status')
  assert.equal(status.coverage.closedThroughSeq, 5)
  assert.equal(status.revisions.history, revision)
  assert.equal(observationReads, 0)
  assert.equal((await store.getSession('session-status')).revision, revision)

  const page = await service.historyPage('session-status', { limit: 1 })
  assert.equal(page.total, 1)
  assert.equal(page.items[0].id, 'checkpoint-status')
  const delta = await service.historyDelta('session-status', 0)
  assert.equal(delta.reset, false)
  assert.deepEqual(delta.added.map(item => item.id), ['checkpoint-status'])
})

test('evidence reads mark missing references unverified instead of inventing a Seq', async () => {
  const events = completedTurn(1, 0)
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: null },
    modelRunner: async () => semanticResult(),
  })
  const direct = await service.readEvidence({ sessionId: 'session-evidence', seq: 3 })
  assert.equal(direct.verified, true)
  await store.updateSession('session-evidence', history => {
    history.semantic.runs.push({
      id: 'run-without-evidence', status: 'succeeded', fromSeq: 0, toSeq: 5,
      output: { verdict: 'inference only', evidenceRefs: [] }, createdAt: new Date(0).toISOString(),
    })
    history.semantic.runs.push({
      id: 'run-with-out-of-range-evidence', status: 'succeeded', fromSeq: 0, toSeq: 2,
      output: { verdict: 'bad reference', evidenceRefs: [{ seq: 3 }] }, createdAt: new Date(0).toISOString(),
    })
    history.programmatic.checkpoints.push({
      id: 'checkpoint-explicit-evidence', fromSeq: 0, toSeq: 5,
      report: { findings: [
        { severity: 'low', evidence: [{ seq: 1 }] },
        { severity: 'high', evidence: [{ seq: 3 }] },
      ] },
    })
    return history
  })
  const inferred = await service.readEvidence({ sessionId: 'session-evidence', runId: 'run-without-evidence' })
  assert.equal(inferred.verified, false)
  assert.deepEqual(inferred.events, [])
  assert.match(inferred.limitations[0], /does not contain/)
  const outside = await service.readEvidence({ sessionId: 'session-evidence', runId: 'run-with-out-of-range-evidence' })
  assert.equal(outside.verified, false)
  assert.deepEqual(outside.events, [])
  assert.match(outside.limitations[0], /outside its owner range/)
  const checkpointSummaryOnly = await service.readEvidence({ sessionId: 'session-evidence', checkpointId: 'checkpoint-explicit-evidence' })
  assert.equal(checkpointSummaryOnly.verified, false)
  assert.deepEqual(checkpointSummaryOnly.events, [])
  assert.equal(checkpointSummaryOnly.reference.findingIndex, undefined)
  const exactCheckpointEvidence = await service.readEvidence({
    sessionId: 'session-evidence', checkpointId: 'checkpoint-explicit-evidence', findingIndex: 1, evidenceIndex: 0,
  })
  assert.equal(exactCheckpointEvidence.verified, true)
  assert.equal(exactCheckpointEvidence.reference.seq, 3)
  await assert.rejects(
    service.readEvidence({ sessionId: 'session-evidence', seq: 3, runId: 'run-without-evidence' }),
    error => error?.code === 'INVALID_EVIDENCE_REFERENCE',
  )
})

test('raw export requires a current preview token bound to source revisions', async () => {
  const events = completedTurn(1, 0)
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: null },
    modelRunner: async () => semanticResult(),
  })
  await assert.rejects(service.exportWithConfirmation('session-safe-export', 'raw'), error => error?.code === 'EXPORT_CONFIRMATION_REQUIRED')
  const originalBuildExport = service.buildExport.bind(service)
  service.buildExport = async () => { throw new Error('preview must not materialize a full export') }
  const preview = await service.previewExport('session-safe-export', 'raw', { redactRaw: true })
  assert.equal(preview.privacyFlags.includes('raw-session-text'), true)
  assert.equal(preview.estimateBasis, 'bounded-sample')
  assert.equal(preview.manifest.contentHash, undefined)
  service.buildExport = originalBuildExport
  await store.updateSession('session-safe-export', history => history)
  await assert.rejects(
    service.exportWithConfirmation('session-safe-export', 'raw', { redactRaw: true }, preview.confirmationToken),
    error => error?.code === 'EXPORT_CONFIRMATION_STALE',
  )
  const current = await service.previewExport('session-safe-export', 'raw', { redactRaw: true })
  const exported = await service.exportWithConfirmation('session-safe-export', 'raw', { redactRaw: true }, current.confirmationToken)
  assert.ok(exported.raw.log.events)
  assert.equal(typeof exported.manifest.contentHash, 'string')
  assert.deepEqual(exported.manifest.rawRange, { fromSeq: 0, toSeq: 5, eventCount: 6, sourceObservedThroughSeq: 5 })
  assert.deepEqual(exported.raw.log.events.find(event => event.type === 'assistant/message').data.usage, { inputTokens: 10, outputTokens: 4 })
  const analysisPreview = await service.previewExport('session-safe-export', 'analysis')
  assert.equal(analysisPreview.privacyFlags.includes('analysis-model-output'), true)
  assert.ok((await service.exportWithConfirmation('session-safe-export', 'analysis')).analysis.history)
})

test('bootstrap is a bounded pure store read and derives closed Turn descriptors from checkpoints', async () => {
  const events = completedTurn(1, 0)
  let observationReads = 0
  let modelCalls = 0
  const query = fixture(events)
  const originalRead = query.readSession
  query.readSession = async (...args) => { observationReads += 1; return originalRead(...args) }
  const { service, store } = serviceFor({
    events,
    sessionQuery: query,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  await store.updateSession('session-bootstrap', history => {
    history.lastObservedSeq = 5
    history.lastClosedSeq = 5
    history.programmatic.coveredThroughSeq = 5
    history.programmatic.checkpoints.push({
      id: 'checkpoint-bootstrap', fromSeq: 0, toSeq: 5, fromTurn: 1, toTurn: 1,
      startedAt: new Date(1_000).toISOString(), completedAt: new Date(1_005).toISOString(),
      report: { status: { code: 'complete' }, findings: [], phases: [] },
    })
    return history
  })
  const revision = (await store.getSession('session-bootstrap')).revision
  assert.ok(service.capabilities().endpoints.includes('models/list'))
  assert.equal(service.capabilities().endpoints.some(endpoint => endpoint.startsWith('annotations/')), false)
  assert.equal(service.capabilities().features.humanAuditLayer, undefined)
  const bootstrap = await service.readBootstrap('session-bootstrap', { historyLimit: 1 })
  assert.equal(bootstrap.history.items.length, 1)
  assert.deepEqual(bootstrap.turns.map(turn => [turn.turn, turn.fromSeq, turn.toSeq]), [[1, 0, 5]])
  assert.equal(bootstrap.turnIndex.truncated, false)
  assert.equal(bootstrap.reportSummary.id, 'checkpoint-bootstrap')
  assert.equal(bootstrap.latest.programmatic.id, 'checkpoint-bootstrap')
  assert.equal(bootstrap.status.reportSummary.id, 'checkpoint-bootstrap')
  assert.equal(bootstrap.autoDecision.reason, 'manual-backfill-required')
  assert.equal(bootstrap.annotations.activeCount, 0)
  assert.equal(observationReads, 0)
  assert.equal(modelCalls, 0)
  assert.equal((await store.getSession('session-bootstrap')).revision, revision)
})

test('5k history records paginate by signed revision-bound keysets without omission or duplication', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  const expected = new Set()
  await store.updateSession('session-5k', history => {
    for (let index = 0; index < 5_000; index += 1) {
      const id = `checkpoint-${String(index).padStart(5, '0')}`
      expected.add(id)
      history.programmatic.checkpoints.push({
        id, fromSeq: index * 2, toSeq: index * 2 + 1, fromTurn: index, toTurn: index,
        capturedAt: new Date(10_000 + index).toISOString(), trigger: index % 2 ? 'quiet-period' : 'turn-threshold',
        report: { status: { code: index % 3 ? 'complete' : 'partial' }, findings: [], phases: [] },
      })
    }
    return history
  })
  const bootstrap = await service.readBootstrap('session-5k', { historyLimit: 1 })
  assert.equal(bootstrap.history.items.length, 1)
  assert.equal(bootstrap.turns.length, 200)
  assert.deepEqual(bootstrap.turnIndex, { total: 5_000, returned: 200, truncated: true, fromTurn: 4_800, toTurn: 4_999 })
  const seen = new Set()
  let cursor
  let pages = 0
  do {
    const page = await service.historyPage('session-5k', { cursor, limit: 200 })
    assert.equal(page.total, 5_000)
    for (const item of page.items) {
      assert.equal(seen.has(item.id), false)
      seen.add(item.id)
    }
    cursor = page.nextCursor
    pages += 1
  } while (cursor)
  assert.equal(pages, 25)
  assert.deepEqual(seen, expected)
  const truncatedDelta = await service.historyDelta('session-5k', 0)
  assert.equal(truncatedDelta.reset, true)
  assert.equal(truncatedDelta.reason, 'change-log-truncated')

  const first = await service.historyPage('session-5k', { limit: 10, filters: { triggers: ['quiet-period'] } })
  const restarted = new TraceInsightService({
    sessionQuery: fixture([]), llm: {}, store,
    modelRunner: async () => semanticResult(), modelLister: async () => ({ models: [], diagnostics: [] }),
  })
  const samePage = await service.historyPage('session-5k', { cursor: first.nextCursor, limit: 10, filters: { triggers: ['quiet-period'] } })
  await assert.rejects(
    restarted.historyPage('session-5k', { cursor: first.nextCursor, limit: 10, filters: { triggers: ['quiet-period'] } }),
    error => error?.code === 'CURSOR_STALE',
  )
  restarted.dispose()
  await assert.rejects(
    service.historyPage('session-5k', { cursor: first.nextCursor, limit: 10, filters: { triggers: ['turn-threshold'] } }),
    error => error?.code === 'CURSOR_STALE',
  )
  await assert.rejects(
    service.historyPage('another-session', { cursor: first.nextCursor, limit: 10, filters: { triggers: ['quiet-period'] } }),
    error => error?.code === 'CURSOR_STALE',
  )
  const tampered = `${first.nextCursor.slice(0, -3)}abc`
  await assert.rejects(service.historyPage('session-5k', { cursor: tampered, filters: { triggers: ['quiet-period'] } }), error => error?.code === 'INVALID_CURSOR')
  await assert.rejects(
    service.historyPage('session-5k', { cursor: 'x'.repeat((16 * 1024) + 1), filters: { triggers: ['quiet-period'] } }),
    error => error?.code === 'INVALID_CURSOR',
  )
  const decodedPublicForgery = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))
  const { signature: ignoredSignature, ...forgedPayload } = decodedPublicForgery
  forgedPayload.last = { ...forgedPayload.last, id: 'attacker-selected-anchor' }
  const publiclyChecksummed = Buffer.from(JSON.stringify({
    ...forgedPayload,
    signature: stableInputHash({ secret: 'trace-insight-keyset-cursor-v1', payload: forgedPayload }),
  }), 'utf8').toString('base64url')
  await assert.rejects(
    service.historyPage('session-5k', { cursor: publiclyChecksummed, filters: { triggers: ['quiet-period'] } }),
    error => error?.code === 'INVALID_CURSOR',
  )
  await service.upsertAnnotation('session-5k', { kind: 'note', target: { kind: 'session' }, text: 'does not invalidate timeline paging' })
  assert.deepEqual(
    (await service.historyPage('session-5k', { cursor: first.nextCursor, limit: 10, filters: { triggers: ['quiet-period'] } })).items.map(item => item.id),
    samePage.items.map(item => item.id),
  )
  await store.updateSession('session-5k', history => {
    history.programmatic.checkpoints.push({ id: 'new-head', fromSeq: 20_000, toSeq: 20_001, capturedAt: new Date(99_999).toISOString(), trigger: 'quiet-period' })
    return history
  })
  const continued = await service.historyPage('session-5k', { cursor: first.nextCursor, limit: 10, filters: { triggers: ['quiet-period'] } })
  assert.deepEqual(continued.items.map(item => item.id), samePage.items.map(item => item.id))
  assert.equal(continued.items.some(item => item.id === 'new-head'), false)
})

test('explicit programmatic sync indexes legacy observations without model calls or automatic enrollment', async () => {
  const events = [...completedTurn(1, 0), ...completedTurn(2, 6)]
  let observationReads = 0
  let modelCalls = 0
  const query = fixture(events)
  const originalRead = query.readSession
  query.readSession = async (...args) => { observationReads += 1; return originalRead(...args) }
  const { service, store } = serviceFor({
    events,
    sessionQuery: query,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  const first = await service.syncProgrammatic('legacy-unsynced', { historyLimit: 1 })
  assert.equal(first.sync.changed, true)
  assert.equal(first.history.items.length, 1)
  assert.equal(first.turnIndex.total, 2)
  assert.deepEqual(first.turns.map(turn => turn.turn), [1, 2])
  const indexed = await store.getSession('legacy-unsynced')
  assert.equal(indexed.programmatic.checkpoints.length, 2)
  assert.equal(indexed.automatic.enrolled, false)
  const revision = indexed.revision
  const second = await service.syncProgrammatic('legacy-unsynced', { historyLimit: 1 })
  assert.equal(second.sync.changed, false)
  assert.equal((await store.getSession('legacy-unsynced')).revision, revision)
  assert.equal(observationReads, 2)
  assert.equal(modelCalls, 0)
  assert.ok(service.capabilities().endpoints.includes('programmatic/sync'))
})

test('programmatic sync reindexes stale analyzer checkpoints in place without model calls', async () => {
  const events = completedTurn(1, 0)
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  await store.updateSession('stale-analyzer', history => {
    history.lastObservedSeq = 5
    history.lastClosedSeq = 5
    history.programmatic.coveredThroughSeq = 5
    history.programmatic.checkpoints.push({
      id: 'stable-checkpoint-id', kind: 'programmatic', trigger: 'turn-end',
      fromSeq: 0, toSeq: 5, fromTurn: 1, toTurn: 1,
      analyzerVersion: '0.3.0', capturedAt: new Date(1_000).toISOString(),
      report: { analyzerVersion: '0.3.0', status: { code: 'blocked' }, summary: '误判为失败', findings: [{ severity: 'high', category: 'repeated_failure' }], phases: [] },
    })
    return history
  })

  const before = await store.getSession('stale-analyzer')
  const synced = await service.syncProgrammatic('stale-analyzer', { historyLimit: 10 })
  const after = await store.getSession('stale-analyzer')
  assert.equal(synced.sync.changed, true)
  assert.ok(after.revision > before.revision)
  assert.equal(after.programmatic.checkpoints.length, 1)
  assert.equal(after.programmatic.checkpoints[0].id, 'stable-checkpoint-id')
  assert.equal(after.programmatic.checkpoints[0].analyzerVersion, ANALYZER_VERSION)
  assert.notEqual(after.programmatic.checkpoints[0].report.status.code, 'blocked')
  assert.equal(after.programmatic.checkpoints[0].report.findings.some(item => item.category === 'repeated_failure'), false)
  assert.equal(modelCalls, 0)

  const stableRevision = after.revision
  const second = await service.syncProgrammatic('stale-analyzer', { historyLimit: 10 })
  assert.equal(second.sync.changed, false)
  assert.equal((await store.getSession('stale-analyzer')).revision, stableRevision)
})

test('keyset continuation remains complete when a same-Seq non-anchor record becomes terminal', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  await store.updateSession('session-stable-sort', history => {
    for (let index = 1; index <= 4; index += 1) {
      history.jobs.push({
        id: `job-${index}`, kind: 'manual-analysis', status: 'running', fromSeq: 10, toSeq: 10,
        createdAt: new Date(index * 1_000).toISOString(), startedAt: new Date(index * 1_000).toISOString(), completedAt: null,
      })
    }
    return history
  })
  const first = await service.historyPage('session-stable-sort', { limit: 2 })
  assert.deepEqual(first.items.map(item => item.id), ['job-4', 'job-3'])
  await store.updateSession('session-stable-sort', history => {
    const nonAnchor = history.jobs.find(item => item.id === 'job-1')
    nonAnchor.status = 'succeeded'
    nonAnchor.completedAt = new Date(99_000).toISOString()
    return history
  })
  const second = await service.historyPage('session-stable-sort', { cursor: first.nextCursor, limit: 2 })
  assert.deepEqual(second.items.map(item => item.id), ['job-2', 'job-1'])
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 4)
})

test('every Job polling surface stays bounded while persistence and analysis export retain full segments', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  const segments = Array.from({ length: 10_000 }, (_, index) => ({
    index, fromSeq: index, toSeq: index,
    status: index < 5_000 ? 'succeeded' : index === 5_000 ? 'running' : 'planned',
    runId: index <= 5_000 ? `run-${index}` : null,
    error: null,
  }))
  await store.updateSession('session-large-job', history => {
    history.jobs.push({
      id: 'job-large', kind: 'manual-analysis', sessionId: 'session-large-job', mode: 'supplemental', coverageRole: 'supplemental',
      status: 'running', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, fromSeq: 0, toSeq: 9_999,
      createdAt: new Date(1_000).toISOString(), startedAt: new Date(1_001).toISOString(), completedAt: null,
      progress: { completed: 5_000, total: 10_000, current: 5_000 }, segments,
      resourceOverride: { authorized: true, reason: 'approved', authorizedAt: new Date(999).toISOString(), previewToken: 'preview-audit-token', resourceFingerprint: 'resource-hash' },
    })
    return history
  })
  const assertBounded = job => {
    assert.equal(job.segments, undefined)
    assert.equal(job.totalSegments, 10_000)
    assert.equal(job.completedSegments, 5_000)
    assert.equal(job.currentSegment.index, 5_000)
    assert.equal(job.retrySegment.index, 5_001)
    assert.equal(job.resourceOverride.previewToken, 'preview-audit-token')
    assert.ok(JSON.stringify(job).length < 10_000)
  }
  const status = await service.readStatus('session-large-job')
  assertBounded(status.activeJobs[0])
  const read = await service.readAnalysisJob('job-large', 'session-large-job')
  assertBounded(read.job)
  const page = await service.historyPage('session-large-job', { limit: 1 })
  assertBounded(page.items[0])
  const delta = await service.historyDelta('session-large-job', 0)
  assertBounded(delta.added[0])
  const cancelled = await service.cancelAnalysis('job-large', { sessionId: 'session-large-job', expectedRevision: read.job.revision })
  assertBounded(cancelled.job)
  assert.ok(cancelled.job.cancelRequestedAt)
  assert.equal((await store.getSession('session-large-job')).jobs[0].segments.length, 10_000)
  const exported = await service.exportWithConfirmation('session-large-job', 'analysis')
  assert.equal(exported.analysis.history.jobs[0].segments.length, 10_000)
})

test('history filters cover every supported operational dimension against server truth', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  await store.updateSession('session-filters', history => {
    history.programmatic.checkpoints.push({
      id: 'programmatic-needle', fromSeq: 0, toSeq: 9, fromTurn: 1, toTurn: 2, trigger: 'turn-threshold',
      report: { status: { code: 'partial' }, findings: [{ severity: 'high', category: 'tooling', title: 'Needle failure', evidence: [{ seq: 4, toolName: 'shell' }] }], phases: [] },
    })
    history.semantic.runs.push({
      id: 'semantic-target', status: 'succeeded', fromSeq: 10, toSeq: 19, fromTurn: 3, toTurn: 4,
      trigger: 'manual-supplemental-compare', coverageRole: 'supplemental', route: { provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' },
      output: { verdict: 'Target verdict', rootCauses: ['needle cause'], nextSteps: [], risk: 'high' }, createdAt: new Date(2_000).toISOString(),
    })
    history.jobs.push({ id: 'job-other', status: 'failed', fromSeq: 20, toSeq: 29, fromTurn: 5, toTurn: 6, trigger: 'manual' })
    return history
  })
  const expectOnly = async filters => assert.deepEqual((await service.historyPage('session-filters', { filters })).items.map(item => item.id), ['semantic-target'])
  await expectOnly({ layers: ['semantic'] })
  await expectOnly({ kind: 'semantic' })
  await expectOnly({ statuses: ['succeeded'] })
  await expectOnly({ triggers: ['manual-supplemental-compare'] })
  await expectOnly({ severities: ['high'], fromSeq: 10 })
  await expectOnly({ coverageRoles: ['supplemental'] })
  await expectOnly({ providers: ['provider-a'] })
  await expectOnly({ models: ['provider-a/model-b'] })
  await expectOnly({ reasoningEfforts: ['high'] })
  await expectOnly({ fromSeq: 11, toSeq: 18, fromTurn: 3, toTurn: 4 })
  await expectOnly({ query: 'target verdict' })
  assert.deepEqual((await service.historyPage('session-filters', { filters: { severity: 'high', toSeq: 9 } })).items.map(item => item.id), ['programmatic-needle'])
})

test('run comparison is pure, explicit about non-comparable ranges, and exposes resource differences', async () => {
  let observationReads = 0
  let modelCalls = 0
  const query = fixture([])
  query.readSession = async () => { observationReads += 1; throw new Error('must not read observation') }
  const { service, store } = serviceFor({
    events: [], sessionQuery: query, settings: { defaultRoute: null },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  await store.updateSession('session-compare', history => {
    history.semantic.runs.push(
      { id: 'left', status: 'succeeded', fromSeq: 0, toSeq: 9, inputHash: 'same-source', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, promptVersion: 'p1', analyzerVersion: 'a1', settingsSnapshot: { model: { maxOutputTokens: 1_800 } }, startedAt: new Date(1_000).toISOString(), completedAt: new Date(1_100).toISOString(), inputChars: 100, usage: { inputTokens: 10, outputTokens: 2 }, output: { verdict: 'A', narrative: 'A narrative', assessment: 'A assessment', rootCauses: ['one'], nextSteps: ['x'], lessons: ['A lesson'], evidenceRefs: [{ seq: 1 }], risk: 'low' } },
      { id: 'right', status: 'succeeded', fromSeq: 0, toSeq: 9, inputHash: 'same-source', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, promptVersion: 'p1', analyzerVersion: 'a1', settingsSnapshot: { model: { maxOutputTokens: 1_800 } }, startedAt: new Date(2_000).toISOString(), completedAt: new Date(2_250).toISOString(), inputChars: 120, usage: { inputTokens: 12, outputTokens: 4 }, output: { verdict: 'B', narrative: 'B narrative', assessment: 'B assessment', rootCauses: ['two'], nextSteps: ['y'], lessons: ['B lesson'], evidenceRefs: [{ seq: 2 }], risk: 'high' } },
      { id: 'different-source', status: 'succeeded', fromSeq: 0, toSeq: 9, inputHash: 'changed-source', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, promptVersion: 'p1', analyzerVersion: 'a1', output: { verdict: 'D', rootCauses: ['different'], nextSteps: [], risk: 'high' } },
      { id: 'missing-source', status: 'succeeded', fromSeq: 0, toSeq: 9, route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, promptVersion: 'p1', analyzerVersion: 'a1', output: { verdict: 'M', rootCauses: [], nextSteps: [], risk: 'low' } },
      { id: 'different-generation', status: 'succeeded', fromSeq: 0, toSeq: 9, inputHash: 'same-source', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, promptVersion: 'p1', analyzerVersion: 'a1', settingsSnapshot: { model: { maxOutputTokens: 2_400 } }, output: { verdict: 'G', rootCauses: ['generation'], nextSteps: [], risk: 'high' } },
      { id: 'missing-generation', status: 'succeeded', fromSeq: 0, toSeq: 9, inputHash: 'same-source', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, promptVersion: 'p1', analyzerVersion: 'a1', output: { verdict: 'L', rootCauses: ['legacy'], nextSteps: [], risk: 'high' } },
      { id: 'missing-version', status: 'succeeded', fromSeq: 0, toSeq: 9, inputHash: 'same-source', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, settingsSnapshot: { model: { maxOutputTokens: 1_800 } }, output: { verdict: 'V', rootCauses: ['version'], nextSteps: [], risk: 'high' } },
      { id: 'different-range', status: 'succeeded', fromSeq: 10, toSeq: 19, route: { provider: 'p', model: 'm' }, promptVersion: 'p1', analyzerVersion: 'a1', output: { verdict: 'C', rootCauses: [], nextSteps: [], risk: 'low' } },
      { id: 'failed', status: 'failed', fromSeq: 0, toSeq: 9, route: { provider: 'p', model: 'm' } },
    )
    return history
  })
  const before = await store.getSession('session-compare')
  const compared = await service.compareRuns('session-compare', 'left', 'right')
  assert.equal(compared.comparable, true)
  assert.equal(compared.conflict.detected, true)
  assert.equal(compared.drift.detected, true)
  assert.equal(compared.differences.durationMs.changed, true)
  assert.equal(compared.left.narrative, 'A narrative')
  assert.equal(compared.left.assessment, 'A assessment')
  assert.deepEqual(compared.left.lessons, ['A lesson'])
  assert.deepEqual(compared.left.evidenceRefs, [{ seq: 1 }])
  assert.equal((await service.compareRuns('session-compare', 'left', 'different-range')).comparable, false)
  assert.equal((await service.compareRuns('session-compare', 'left', 'failed')).drift.assessable, false)
  const sourceMismatch = await service.compareRuns('session-compare', 'left', 'different-source')
  assert.equal(sourceMismatch.comparable, false)
  assert.ok(sourceMismatch.reasons.includes('source-mismatch'))
  const sourceMissing = await service.compareRuns('session-compare', 'left', 'missing-source')
  assert.equal(sourceMissing.conflict.assessable, false)
  assert.equal(sourceMissing.drift.assessable, false)
  assert.ok(sourceMissing.reasons.includes('input-hash-missing'))
  assert.ok(compared.conflict.basis.includes('same-input-hash'))
  assert.ok(compared.drift.basis.includes('same-input-hash'))
  assert.ok(compared.drift.basis.includes('same-generation-configuration'))
  const generationMismatch = await service.compareRuns('session-compare', 'left', 'different-generation')
  assert.equal(generationMismatch.comparable, true)
  assert.equal(generationMismatch.conflict.assessable, true)
  assert.equal(generationMismatch.drift.assessable, false)
  assert.equal(generationMismatch.drift.reason, 'configuration-mismatch')
  assert.ok(generationMismatch.drift.configurationReasons.includes('generation-configuration-mismatch'))
  const generationMissing = await service.compareRuns('session-compare', 'left', 'missing-generation')
  assert.equal(generationMissing.conflict.assessable, true)
  assert.equal(generationMissing.drift.assessable, false)
  assert.equal(generationMissing.drift.reason, 'configuration-evidence-missing')
  assert.ok(generationMissing.drift.configurationReasons.includes('generation-configuration-missing'))
  const versionMissing = await service.compareRuns('session-compare', 'left', 'missing-version')
  assert.equal(versionMissing.drift.assessable, false)
  assert.ok(versionMissing.drift.configurationReasons.includes('prompt-version-missing'))
  assert.ok(versionMissing.drift.configurationReasons.includes('analyzer-version-missing'))
  await assert.rejects(service.compareRuns('session-compare', 'left', 'left'), error => error?.code === 'INVALID_COMPARISON')
  assert.deepEqual(await store.getSession('session-compare'), before)
  assert.equal(observationReads, 0)
  assert.equal(modelCalls, 0)
})

test('historical annotations remain intact and exports disclose the legacy layer', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  await store.updateSession('session-audit', history => {
    history.lastObservedSeq = 20
    history.semantic.runs.push({ id: 'run-audit', status: 'succeeded', fromSeq: 0, toSeq: 9, output: { verdict: 'model original' } })
    return history
  })
  const originalRun = (await store.getSession('session-audit')).semantic.runs[0]
  const note = await service.upsertAnnotation('session-audit', { kind: 'note', target: { kind: 'semantic', id: 'run-audit' }, text: '人工复核' }, 0)
  const bookmark = await service.upsertAnnotation('session-audit', { kind: 'bookmark', target: { kind: 'range', fromSeq: 2, toSeq: 5 }, tags: ['important'] }, note.revision)
  const verdict = await service.upsertAnnotation('session-audit', { kind: 'verdict', target: { kind: 'seq', seq: 3 }, verdict: 'disputed', text: '证据不足' }, bookmark.revision)
  assert.equal((await service.listAnnotations('session-audit')).total, 3)
  const archived = await service.archiveAnnotation('session-audit', note.annotation.id, verdict.revision)
  assert.ok(archived.annotation.archivedAt)
  assert.equal((await service.listAnnotations('session-audit')).total, 2)
  assert.equal((await service.listAnnotations('session-audit', { includeArchived: true })).total, 3)
  await assert.rejects(service.upsertAnnotation('session-audit', { kind: 'note', target: { kind: 'semantic', id: 'missing' }, text: 'x' }), error => error?.code === 'ANNOTATION_TARGET_NOT_FOUND')
  await assert.rejects(service.upsertAnnotation('session-audit', { kind: 'note', target: { kind: 'session' } }), error => error?.code === 'INVALID_ANNOTATION')
  await assert.rejects(service.archiveAnnotation('session-audit', 'missing'), error => error?.code === 'ANNOTATION_NOT_FOUND')
  assert.deepEqual((await store.getSession('session-audit')).semantic.runs[0], originalRun)
  const preview = await service.previewExport('session-audit', 'analysis')
  assert.ok(preview.privacyFlags.includes('legacy-annotations'))
  assert.equal(preview.manifest.annotations.total, 3)
  assert.equal(preview.manifest.annotations.included, true)
  const rawPreview = await service.previewExport('session-audit', 'raw')
  assert.deepEqual(rawPreview.manifest.annotations, { included: false })
  assert.equal(rawPreview.privacyFlags.includes('legacy-annotations'), false)
  const exported = await service.exportWithConfirmation('session-audit', 'analysis')
  assert.equal(exported.analysis.history.annotations.items.length, 3)
})

test('export preview opportunistically removes expired confirmation state', async () => {
  const events = completedTurn(1, 0)
  const { service, advanceTime } = serviceFor({ events, settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  await service.previewExport('session-export-cleanup', 'raw')
  assert.equal(service.exportConfirmations.size, 1)
  advanceTime(5 * 60_000 + 1)
  await service.previewExport('session-export-cleanup', 'analysis')
  assert.equal(service.exportConfirmations.size, 0)
  service.dispose()
  assert.equal(service.exportConfirmations.size, 0)
})

test('research aggregation is filter-true, drillable, and only infers conflict or drift from comparable evidence', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  await store.updateSession('session-research', history => {
    history.programmatic.checkpoints.push(
      { id: 'cp-1', historyKind: 'programmatic', fromSeq: 0, toSeq: 4, fromTurn: 1, toTurn: 1, trigger: 'turn-threshold', report: { status: { code: 'blocked' }, phases: [{ title: '定位', seqStart: 0, seqEnd: 4 }, { title: '定位', seqStart: 0, seqEnd: 4 }], findings: [{ severity: 'low', category: 'context', evidence: [] }, { severity: 'high', category: 'tooling', evidence: [{ seq: 2 }, { seq: 3, toolName: 'shell' }] }, { severity: 'medium', category: 'loop', title: '出现 5 步无进展重试循环', evidence: [] }] } },
      { id: 'cp-2', historyKind: 'programmatic', fromSeq: 5, toSeq: 9, fromTurn: 2, toTurn: 2, trigger: 'turn-threshold', report: { status: { code: 'complete' }, phases: [{ title: '验证', seqStart: 5, seqEnd: 9 }], findings: [{ severity: 'medium', category: 'loop', title: '出现 3 步无进展重试循环', evidence: [{ seq: 7, toolName: 'loop-tool' }] }] } },
    )
    const common = { status: 'succeeded', fromSeq: 0, toSeq: 9, inputHash: 'same-research-source', route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, promptVersion: 'prompt-1', analyzerVersion: 'analyzer-1', settingsSnapshot: { model: { maxOutputTokens: 1_800 } }, trigger: 'manual', coverageRole: 'supplemental' }
    history.semantic.runs.push(
      { id: 'run-low', ...common, createdAt: new Date(1_000).toISOString(), inputChars: 100, usage: { inputTokens: 10, outputTokens: 2 }, output: { verdict: 'low verdict', rootCauses: ['same cause'], nextSteps: ['one'], risk: 'low' } },
      { id: 'run-high', ...common, createdAt: new Date(2_000).toISOString(), inputChars: 120, usage: { inputTokens: 12, outputTokens: 3 }, output: { verdict: 'high verdict', rootCauses: ['changed cause'], nextSteps: ['two'], risk: 'high' } },
      { id: 'run-other-range', ...common, fromSeq: 10, toSeq: 19, createdAt: new Date(3_000).toISOString(), output: { verdict: 'other', rootCauses: [], nextSteps: [], risk: 'high' } },
      { id: 'run-failed', ...common, status: 'failed', createdAt: new Date(4_000).toISOString() },
    )
    return history
  })
  const summary = await service.researchSummary('session-research')
  assert.equal(summary.dimensions.tools.find(bucket => bucket.key === 'shell').count, 1)
  assert.equal(summary.dimensions.phases.find(bucket => bucket.key === '定位').count, 2)
  assert.equal(summary.dimensions.models.find(bucket => bucket.key === 'p/m/low').count, 4)
  const loopBucket = summary.dimensions.findings.find(bucket => bucket.key === 'programmatic:loop')
  assert.equal(loopBucket.label, '出现 5 步无进展重试循环')
  assert.equal(loopBucket.count, 2)
  assert.equal(loopBucket.preciseRefCount, 1)
  assert.ok(summary.conflicts.some(item => item.type === 'programmatic-semantic-risk-mismatch' && item.inference))
  const semanticConflict = summary.conflicts.find(item => item.type === 'semantic-run-conflict')
  assert.deepEqual(semanticConflict.comparison, { leftRunId: 'run-low', rightRunId: 'run-high' })
  assert.equal(summary.drift.length, 1)
  assert.deepEqual(summary.drift[0].comparison, { leftRunId: 'run-low', rightRunId: 'run-high' })
  const crossLayer = summary.conflicts.find(item => item.type === 'programmatic-semantic-risk-mismatch')
  const crossRefs = []
  let crossCursor
  do {
    const page = await service.researchMembers('session-research', {
      dimension: 'conflicts', key: crossLayer.drilldown.key, limit: 2, ...(crossCursor ? { cursor: crossCursor } : {}),
    })
    crossRefs.push(...page.items)
    crossCursor = page.nextCursor
    assert.equal(page.total, crossLayer.refCount)
  } while (crossCursor)
  assert.equal(crossRefs.length, crossLayer.refCount)
  assert.deepEqual(new Set(crossRefs.map(item => item.id)), new Set(['run-low', 'cp-1', 'cp-2']))
  assert.ok(crossRefs.some(item => item.id === 'cp-1' && item.findingIndex === 1 && item.evidenceIndex === 1 && item.basisRole === 'programmatic-high-finding-evidence'))
  const modelBucket = summary.dimensions.models.find(bucket => bucket.key === 'p/m/low')
  assert.equal(modelBucket.refCount, 4)
  assert.equal(modelBucket.drilldown.endpoint, 'research/members')
  const first = await service.researchMembers('session-research', { dimension: 'models', key: 'p/m/low', limit: 2 })
  const second = await service.researchMembers('session-research', { dimension: 'models', key: 'p/m/low', limit: 2, cursor: first.nextCursor })
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 4)
  const phaseFirst = await service.researchMembers('session-research', { dimension: 'phases', key: '定位', limit: 1 })
  const phaseSecond = await service.researchMembers('session-research', { dimension: 'phases', key: '定位', limit: 1, cursor: phaseFirst.nextCursor })
  assert.deepEqual([phaseFirst.items[0].phaseIndex, phaseSecond.items[0].phaseIndex].sort(), [0, 1])
  assert.equal(phaseSecond.nextCursor, null)
  const filtered = await service.researchSummary('session-research', { statuses: ['succeeded'], fromSeq: 10 })
  assert.equal(filtered.dimensions.models[0].count, 1)
  assert.equal(filtered.conflicts.length, 0)
  assert.equal(filtered.drift.length, 0)
})

test('research comparison groups interleaved runs by exact source hash', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  const shared = {
    status: 'succeeded', fromSeq: 0, toSeq: 9,
    route: { provider: 'p', model: 'm', reasoningEffort: 'low' },
    promptVersion: 'p1', analyzerVersion: 'a1', settingsSnapshot: { model: { maxOutputTokens: 1_800 } }, trigger: 'manual', coverageRole: 'supplemental',
  }
  await store.updateSession('session-interleaved-sources', history => {
    history.semantic.runs.push(
      { ...shared, id: 'source-a-first', inputHash: 'source-a', createdAt: new Date(1_000).toISOString(), output: { verdict: 'A1', rootCauses: ['one'], nextSteps: [], risk: 'low' } },
      { ...shared, id: 'source-b', inputHash: 'source-b', createdAt: new Date(2_000).toISOString(), output: { verdict: 'B', rootCauses: [], nextSteps: [], risk: 'low' } },
      { ...shared, id: 'source-a-second', inputHash: 'source-a', createdAt: new Date(3_000).toISOString(), output: { verdict: 'A2', rootCauses: ['two'], nextSteps: [], risk: 'high' } },
    )
    return history
  })
  const summary = await service.researchSummary('session-interleaved-sources')
  assert.equal(summary.comparisonCount, 1)
  assert.deepEqual(summary.conflicts[0].comparison, { leftRunId: 'source-a-first', rightRunId: 'source-a-second' })
})

test('filtered cross-layer conflict drilldown is bound to the exact summary filters', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  await store.updateSession('session-filtered-conflict', history => {
    history.programmatic.checkpoints.push(
      { id: 'filtered-cp-1', fromSeq: 0, toSeq: 4, trigger: 'turn-threshold', report: { status: { code: 'blocked' }, findings: [{ severity: 'high', evidence: [{ seq: 2 }] }], phases: [] } },
      { id: 'filtered-cp-2', fromSeq: 5, toSeq: 9, trigger: 'turn-threshold', report: { status: { code: 'complete' }, findings: [], phases: [] } },
      // This overlapping checkpoint makes the unfiltered coverage ambiguous;
      // it must not reappear when drilling a conflict created under filters.
      { id: 'excluded-overlap', fromSeq: 0, toSeq: 9, trigger: 'excluded', report: { status: { code: 'complete' }, findings: [], phases: [] } },
    )
    history.semantic.runs.push({
      id: 'filtered-semantic', status: 'succeeded', fromSeq: 0, toSeq: 9, trigger: 'manual', inputHash: 'filtered-source',
      output: { verdict: 'low', rootCauses: [], nextSteps: [], risk: 'low' },
    })
    return history
  })
  const filters = { triggers: ['manual', 'turn-threshold'] }
  const summary = await service.researchSummary('session-filtered-conflict', filters)
  const conflict = summary.conflicts.find(item => item.type === 'programmatic-semantic-risk-mismatch')
  assert.ok(conflict)
  assert.deepEqual(conflict.drilldown.filters, summary.filters)
  const exact = await service.researchMembers('session-filtered-conflict', {
    dimension: conflict.drilldown.dimension, key: conflict.drilldown.key, filters: conflict.drilldown.filters,
  })
  assert.ok(exact.total > 0)
  assert.equal(exact.items.some(item => item.id === 'excluded-overlap'), false)
  const lostFilter = await service.researchMembers('session-filtered-conflict', {
    dimension: conflict.drilldown.dimension, key: conflict.drilldown.key, filters: {},
  })
  assert.equal(lostFilter.total, 0)
})

test('cross-layer conflict drilldown paginates every exact member beyond its bounded summary sample', async () => {
  const { service, store } = serviceFor({ events: [], settings: { defaultRoute: null }, modelRunner: async () => semanticResult() })
  await store.updateSession('session-conflict-members', history => {
    for (let seq = 0; seq < 25; seq += 1) {
      history.programmatic.checkpoints.push({
        id: `cp-${seq}`, fromSeq: seq, toSeq: seq,
        report: {
          status: { code: seq === 7 ? 'blocked' : 'complete' },
          findings: seq === 7 ? [{ severity: 'high', evidence: [{ seq }] }] : [],
          phases: [],
        },
      })
    }
    history.semantic.runs.push({
      id: 'semantic-low', status: 'succeeded', fromSeq: 0, toSeq: 24, inputHash: 'source',
      output: { verdict: 'low', rootCauses: [], nextSteps: [], risk: 'low' },
    })
    return history
  })
  const summary = await service.researchSummary('session-conflict-members')
  const conflict = summary.conflicts.find(item => item.type === 'programmatic-semantic-risk-mismatch')
  assert.equal(conflict.refs.length, 20)
  assert.ok(conflict.refCount > conflict.refs.length)
  const seen = []
  let cursor
  do {
    const page = await service.researchMembers('session-conflict-members', {
      dimension: 'conflicts', key: conflict.drilldown.key, limit: 7, ...(cursor ? { cursor } : {}),
    })
    seen.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(seen.length, conflict.refCount)
  assert.ok(seen.some(ref => ref.checkpointId === 'cp-7' && ref.findingIndex === 0 && ref.evidenceIndex === 0))
})

test('manual batches preserve explicit override audit requirements and idempotency', async () => {
  const events = Array.from({ length: 8 }, (_, index) => completedTurn(index + 1, index * 6)).flat()
  let modelCalls = 0
  const { service, store } = serviceFor({
    events,
    settings: {
      defaultRoute: { provider: 'p', model: 'm' },
      auto: { maxPendingEvents: 20, maxInputChars: 4_000 },
      resourcePolicy: { maxCallsPerJob: 1, warnCallsPerJob: 1, maxInputCharsPerJob: 1_000_000, warnInputCharsPerJob: 1_000 },
    },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  const request = { sessionId: 'session-budget', mode: 'supplemental', fromSeq: 0, toSeq: 47, route: { provider: 'p', model: 'm' } }
  const preview = await service.previewAnalysis(request)
  assert.ok(preview.resources.modelCalls > 1)
  assert.equal(preview.budgetAssessment.hardLimitExceeded, false)
  assert.equal(preview.budgetAssessment.scope, 'batch')
  assert.equal(preview.batchPlan.totalBatches, preview.segments.length)
  await assert.rejects(service.startAnalysis({ ...request, previewToken: preview.previewToken, overrideBudget: true }), error => error?.code === 'RESOURCE_OVERRIDE_REASON_REQUIRED')
  const started = await service.startAnalysis({ ...request, previewToken: preview.previewToken, overrideBudget: true, overrideReason: '经人工批准进行全段复盘', idempotencyKey: 'budget-job' })
  const duplicate = await service.startAnalysis({ ...request, previewToken: preview.previewToken, overrideBudget: true, overrideReason: '经人工批准进行全段复盘', idempotencyKey: 'budget-job' })
  assert.equal(duplicate.jobId, started.jobId)
  assert.equal(duplicate.created, undefined)
  const job = (await service.readAnalysisJob(started.jobId, 'session-budget')).job
  assert.equal(job.resourceOverride.reason, '经人工批准进行全段复盘')
  assert.equal(job.resourceOverride.previewToken, preview.previewToken)
  assert.equal(job.resourcePlan, undefined)
  assert.equal((await store.getSession('session-budget')).jobs.find(item => item.id === started.jobId).resourcePlan.modelCalls, preview.resources.modelCalls)
  await service.enqueue('session-budget', async () => {})
  assert.ok(modelCalls <= preview.resources.modelCalls)
})
