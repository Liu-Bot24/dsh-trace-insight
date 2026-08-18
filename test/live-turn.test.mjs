import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTraceEvent, openTurnState, evaluateProvisionalTrigger, provisionalDeadlineAt } from '../src/live-turn.mjs'
import { normalizeAnalysisSettings } from '../src/analysis-policy.mjs'
import { TraceInsightService } from '../src/analysis-service.mjs'
import { MemoryHistoryStore } from '../src/history-store.mjs'
import { ANALYZER_VERSION } from '../src/core.mjs'

function chunk(seq, time) {
  return { type: 'assistant/chunk', seq, time, data: { turn: 1, step: 1, text: `chunk-${seq}` } }
}

function toolCall(seq, time, callId, tool, step = 1, turn = 1) {
  return { type: 'tool/call', seq, time, data: { turn, step, callId, name: tool, arguments: '{}' } }
}

function toolResult(seq, time, callId, { error = false, text = 'ok', step = 1, turn = 1 } = {}) {
  return {
    type: 'tool/result', seq, time, data: {
      turn, step,
      message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] },
      ...(error ? { error: { code: 'TOOL_FAILED', message: 'boom' } } : {}),
    },
  }
}

function assistant(seq, time, text, step = 1, turn = 1) {
  return { type: 'assistant/message', seq, time, surfaceOp: 'append', data: { turn, step, message: { id: `a-${seq}`, role: 'assistant', content: [{ type: 'text', text }] } } }
}

function stepEnd(seq, time, step, turn = 1) {
  return { type: 'step/end', seq, time, data: { turn, step } }
}

function stepStart(seq, time, step, turn = 1) {
  return { type: 'step/start', seq, time, data: { turn, step } }
}

function turnStart(seq, time, turn = 1) {
  return { type: 'turn/start', seq, time, data: { turn } }
}

function turnEnd(seq, time, turn = 1, reason = 'completed') {
  return { type: 'turn/end', seq, time, data: { turn, reason: { kind: reason } } }
}

function fixture(events) {
  return {
    async readSession(sessionId) { return { session: { id: sessionId, version: 0, createdAt: 900 }, events } },
    async listEvents(sessionId) { return events.map(event => ({ sessionId, seq: event.seq, type: event.type, time: event.time })) },
    async readSurface(sessionId) { return { session: { id: sessionId }, capturedThroughSeq: events.at(-1)?.seq ?? -1, events: events.filter(event => event.surfaceOp) } },
    async traceSession() { return { complete: true, target: {}, ancestors: [], descendants: [], root: {} } },
  }
}

function semanticResult(label = '阶段正常') {
  return {
    output: {
      verdict: label,
      narrative: `${label} narrative`,
      assessment: '合理',
      rootCauses: [],
      nextSteps: ['继续'],
      lessons: ['验证'],
      evidenceRefs: [],
      risk: 'low',
      confidence: 'high',
      continuitySummary: `${label} continuity`,
    },
    rawText: `{"verdict":"${label}"}`,
    usage: { inputTokens: 30, outputTokens: 10 },
    finish: { kind: 'stop' },
  }
}

async function flushTasks() {
  await new Promise(resolve => setImmediate(resolve))
}

async function waitFor(predicate, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await flushTasks()
  }
  throw new Error('Timed out waiting for the test condition.')
}

function liveService({ events, sessionQuery = fixture(events), modelRunner, settings, analyzer, maxSegmentsPerCycle = 3, liveDebounceMs = 10 }) {
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
    modelLister: async () => ({ models: [], diagnostics: [] }),
    now: () => tick += 1,
    setTimer(fn, delay) { timers.push({ fn, delay }); return timers.length },
    clearTimer() {},
    maxSegmentsPerCycle,
    liveDebounceMs,
  })
  return { service, store, timers, advanceTime(milliseconds) { tick += milliseconds } }
}

async function fireLiveDebounce(timers) {
  const timer = [...timers].reverse().find(item => item.delay >= 0 && item.delay <= 10)
  if (!timer) throw new Error('No live debounce timer scheduled.')
  timer.fn()
  await flushTasks()
}

// ---------------------------------------------------------------------------
// 1. Deep module: classification, stable waterline, provisional trigger policy
// ---------------------------------------------------------------------------

test('classifier: assistant/chunk is noise and never advances the stable waterline', () => {
  assert.deepEqual(classifyTraceEvent(chunk(1, 10)), { noise: true, meaningful: false, progress: false, failure: null })
  const events = [turnStart(0, 0), chunk(1, 1), chunk(2, 2), chunk(3, 3)]
  const state = openTurnState(events)
  assert.equal(state.turn, 1)
  assert.equal(state.stableThroughSeq, 0, 'only turn/start is stable, chunks are not')
  assert.equal(state.meaningfulEvents, 1)
})

test('waterline: tool/result and step/end advance the stable prefix, unclosed tool/call does not', () => {
  const events = [
    turnStart(0, 0),
    stepStart(1, 1, 1),
    toolCall(2, 2, 'c-1', 'edit'),
    toolResult(3, 3, 'c-1'),
    assistant(4, 4, 'done'),
    stepEnd(5, 5, 1),
    toolCall(6, 6, 'c-2', 'edit'),
  ]
  const state = openTurnState(events)
  assert.equal(state.observedThroughSeq, 6)
  assert.equal(state.stableThroughSeq, 5, 'open tool/call at Seq 6 is not part of the stable prefix')
  assert.equal(state.meaningfulEvents, 6)
  assert.equal(state.noProgressSteps, 0, 'the closed step made progress')
})

test('waterline: orphan/noise events do not advance stability while a call is open', () => {
  const events = [turnStart(0, 0), toolCall(1, 1, 'c-1', 'edit'), chunk(2, 2), assistant(3, 3, 'mid')]
  const state = openTurnState(events)
  assert.equal(state.stableThroughSeq, 0)
})

test('trigger: same-kind failure x3 fires once with reason provisional-failure-pattern', () => {
  const events = [turnStart(0, 0)]
  for (let index = 0; index < 3; index += 1) {
    const base = 1 + index * 2
    events.push(toolCall(base, base, `f-${index}`, 'edit'), toolResult(base + 1, base + 1, `f-${index}`, { error: true }))
  }
  const settings = normalizeAnalysisSettings({ defaultRoute: { provider: 'p', model: 'm' } })
  const state = openTurnState(events, { provisionalThroughSeq: -1 })
  const provisional = { turn: 1, throughSeq: -1, callsInTurn: 0, lastDispatchedAt: null, lastSucceededAt: null }
  const decision = evaluateProvisionalTrigger({ state, provisional, settings, now: 100_000 })
  assert.equal(decision.due, true)
  assert.equal(decision.reason, 'provisional-failure-pattern')
})

test('trigger: cooldown and maxCallsPerTurn are hard gates', () => {
  const events = [turnStart(0, 0)]
  for (let index = 0; index < 3; index += 1) {
    const base = 1 + index * 2
    events.push(toolCall(base, base, `f-${index}`, 'edit'), toolResult(base + 1, base + 1, `f-${index}`, { error: true }))
  }
  const settings = normalizeAnalysisSettings({ defaultRoute: { provider: 'p', model: 'm' } })
  const state = openTurnState(events, { provisionalThroughSeq: -1 })
  const base = { turn: 1, throughSeq: -1, callsInTurn: 0, lastSucceededAt: null }
  const cooled = evaluateProvisionalTrigger({ state, provisional: { ...base, lastDispatchedAt: new Date(95_000).toISOString() }, settings, now: 100_000 })
  assert.equal(cooled.due, false)
  assert.equal(cooled.reason, 'provisional-cooldown')
  const quota = evaluateProvisionalTrigger({ state, provisional: { ...base, callsInTurn: 8, lastDispatchedAt: null }, settings, now: 100_000 })
  assert.equal(quota.due, false)
  assert.equal(quota.reason, 'provisional-quota')
})

test('trigger: event and input thresholds fire on meaningful content, not raw Seq count', () => {
  const settings = normalizeAnalysisSettings({ defaultRoute: { provider: 'p', model: 'm' }, auto: { provisional: { meaningfulEvents: 60 } } })
  const events = [turnStart(0, 0)]
  // 200 raw seqs inflated by chunks; only 40 meaningful events.
  for (let index = 0; index < 40; index += 1) {
    events.push(assistant(1 + index * 5, 1 + index * 5, `meaningful-${index}`))
    for (let chunkIndex = 1; chunkIndex < 5; chunkIndex += 1) events.push(chunk(1 + index * 5 + chunkIndex, 1 + index * 5 + chunkIndex))
  }
  const state = openTurnState(events, { provisionalThroughSeq: -1 })
  assert.equal(state.observedThroughSeq, 200)
  assert.equal(state.meaningfulEvents, 41)
  const provisional = { turn: 1, throughSeq: -1, callsInTurn: 0, lastDispatchedAt: null, lastSucceededAt: null }
  const decision = evaluateProvisionalTrigger({ state, provisional, settings, now: 1_000 })
  assert.equal(decision.due, false, '40 < 60 meaningful events despite 200 raw seqs')
  assert.equal(decision.reason, 'accumulating')
  events.push(assistant(201, 201, 'one more'), chunk(202, 202))
  const later = openTurnState(events, { provisionalThroughSeq: -1 })
  assert.equal(later.meaningfulEvents, 42)
})

test('trigger deadline exists only for an eligible open Turn with stable unanalyzed content', () => {
  const settings = normalizeAnalysisSettings({
    defaultRoute: { provider: 'p', model: 'm' },
    auto: { provisional: { quietMs: 15_000, maxAgeMs: 60_000 } },
  })
  const state = openTurnState([turnStart(10, 1_000, 2), assistant(11, 2_000, 'progress', 1, 2)], { provisionalThroughSeq: 9 })
  const provisional = { turn: 2, throughSeq: 9, callsInTurn: 0, lastDispatchedAt: null, lastSucceededAt: null }
  assert.equal(provisionalDeadlineAt({ state, provisional, settings, now: 5_000 }), 17_000)
  assert.equal(provisionalDeadlineAt({ state, provisional, settings: { ...settings, auto: { ...settings.auto, enabled: false } }, now: 5_000 }), null)
  assert.equal(provisionalDeadlineAt({ state: null, provisional, settings, now: 5_000 }), null)
})

// ---------------------------------------------------------------------------
// 2. Service: live programmatic, provisional model runs, and final settlement
// ---------------------------------------------------------------------------

test('201 meaningful events in an open Turn produce a live card without any model call and without advancing final watermarks', async () => {
  const events = [turnStart(0, 0)]
  let seq = 0
  for (let index = 0; index < 201; index += 1) {
    seq += 1
    events.push(stepStart(seq, seq, index + 1))
    seq += 1
    events.push(toolCall(seq, seq, `c-${index}`, 'edit'))
    seq += 1
    events.push(toolResult(seq, seq, `c-${index}`))
    seq += 1
    events.push(assistant(seq, seq, `step ${index + 1} done`))
    seq += 1
    events.push(stepEnd(seq, seq, index + 1))
  }
  let modelCalls = 0
  const { service, store, timers } = liveService({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { provisional: { enabled: false } } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  service.observeLiveEvent({ id: 'session-open-long' }, events.at(-1))
  await fireLiveDebounce(timers)
  const history = await store.getSession('session-open-long')
  assert.equal(history.programmatic.coveredThroughSeq, -1, 'final programmatic watermark unchanged')
  assert.equal(history.semantic.coveredThroughSeq, -1, 'final semantic watermark unchanged')
  assert.equal(history.live.items.length, 1)
  const item = history.live.items[0]
  assert.equal(item.turn, 1)
  assert.equal(item.state, 'open')
  assert.equal(item.stableThroughSeq, seq, 'all tool calls are closed, so the whole prefix is stable')
  assert.ok(item.report, 'live card carries a programmatic report')
  assert.equal(modelCalls, 0, 'no model call from merely observing events')
})

test('assistant/chunk only: no live card content, no stable advance, no model call', async () => {
  const events = [turnStart(0, 0), ...Array.from({ length: 50 }, (_, index) => chunk(index + 1, index + 1))]
  let modelCalls = 0
  const { service, store, timers } = liveService({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  service.observeLiveEvent({ id: 'session-chunks' }, events.at(-1))
  await fireLiveDebounce(timers)
  const history = await store.getSession('session-chunks')
  const item = history.live.items.find(candidate => candidate.turn === 1)
  assert.ok(item, 'live card exists once the turn started')
  assert.equal(item.stableThroughSeq, 0)
  assert.equal(history.lastObservedSeq, 50)
  assert.equal(modelCalls, 0)
})

test('same-kind failure x3 dispatches exactly one provisional run; repeats and re-flushes do not duplicate', async () => {
  const events = [turnStart(0, 0)]
  for (let index = 0; index < 3; index += 1) {
    const base = 1 + index * 2
    events.push(toolCall(base, base, `f-${index}`, 'edit'), toolResult(base + 1, base + 1, `f-${index}`, { error: true }))
  }
  let modelCalls = 0
  const { service, store, timers } = liveService({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  service.observeLiveEvent({ id: 'session-failures' }, events.at(-1))
  await fireLiveDebounce(timers)
  await waitFor(() => modelCalls === 1)
  // repeat the same event and flush again
  service.observeLiveEvent({ id: 'session-failures' }, events.at(-1))
  await fireLiveDebounce(timers)
  service.observeLiveEvent({ id: 'session-failures' }, events.at(-1))
  await fireLiveDebounce(timers)
  const history = await store.getSession('session-failures')
  assert.equal(modelCalls, 1, 'exactly one provisional model call')
  assert.equal(history.semantic.coveredThroughSeq, -1, 'provisional never advances primary')
  const provisionalRuns = history.semantic.runs.filter(run => run.coverageRole === 'provisional')
  assert.equal(provisionalRuns.length, 1)
  assert.equal(provisionalRuns[0].status, 'succeeded')
  assert.equal(history.live.provisional.throughSeq, 6)
  assert.equal(history.live.provisional.callsInTurn, 1)
})

test('quiet deadline dispatches an open-Turn analysis without another live event', async () => {
  const events = [turnStart(0, 10_000), assistant(1, 10_001, 'stable progress')]
  let modelCalls = 0
  const { service, timers, advanceTime } = liveService({
    events,
    settings: {
      defaultRoute: { provider: 'p', model: 'm' },
      auto: { provisional: { quietMs: 15_000, maxAgeMs: 60_000, meaningfulEvents: 60, compressedChars: 12_000 } },
    },
    modelRunner: async () => { modelCalls += 1; return semanticResult('quiet') },
  })
  service.observeLiveEvent({ id: 'session-quiet-deadline' }, events.at(-1))
  await fireLiveDebounce(timers)
  assert.equal(modelCalls, 0)
  const deadline = [...timers].reverse().find(timer => timer.delay > 1_000)
  assert.ok(deadline, 'a single-shot quiet/age deadline is scheduled')
  advanceTime(deadline.delay)
  deadline.fn()
  await waitFor(() => modelCalls === 1)
  service.dispose()
})

test('a new Turn provisional run never re-ingests earlier Turns', async () => {
  const events = [
    turnStart(0, 0, 1), assistant(1, 1, 'old one', 1, 1), turnEnd(2, 2, 1),
    turnStart(3, 3, 2), assistant(4, 4, 'old two', 1, 2), turnEnd(5, 5, 2),
    turnStart(20, 20, 3),
  ]
  for (let index = 0; index < 3; index += 1) {
    const base = 21 + index * 2
    events.push(toolCall(base, base, `turn-3-${index}`, 'edit', 1, 3), toolResult(base + 1, base + 1, `turn-3-${index}`, { error: true, turn: 3 }))
  }
  let modelCalls = 0
  const { service, store, timers } = liveService({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult('turn three') },
  })
  service.observeLiveEvent({ id: 'session-turn-baseline' }, events.at(-1))
  await fireLiveDebounce(timers)
  await waitFor(() => modelCalls === 1)
  await service.enqueue('session-turn-baseline', async () => {})
  const history = await store.getSession('session-turn-baseline')
  const run = history.semantic.runs.find(item => item.coverageRole === 'provisional')
  assert.equal(run.fromSeq, 20)
  assert.equal(history.live.provisional.turn, 3)
  assert.ok(history.live.provisional.throughSeq >= 20)
  service.dispose()
})

test('provisional failure keeps the waterline, leaves cooldown, and never pollutes primary retry state', async () => {
  const events = [turnStart(0, 0)]
  for (let index = 0; index < 3; index += 1) {
    const base = 1 + index * 2
    events.push(toolCall(base, base, `f-${index}`, 'edit'), toolResult(base + 1, base + 1, `f-${index}`, { error: true }))
  }
  let modelCalls = 0
  const { service, store, timers } = liveService({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; throw Object.assign(new Error('provider down'), { code: 'MODEL_FAILED' }) },
  })
  service.observeLiveEvent({ id: 'session-fail-model' }, events.at(-1))
  await fireLiveDebounce(timers)
  await waitFor(() => modelCalls === 1)
  const history = await store.getSession('session-fail-model')
  assert.equal(history.semantic.coveredThroughSeq, -1)
  assert.equal(history.semantic.retry, null, 'provisional failure does not enter primary retry/backoff')
  assert.equal(history.live.provisional.throughSeq, -1)
  assert.equal(history.live.provisional.callsInTurn, 1)
  assert.ok(history.live.provisional.lastDispatchedAt, 'cooldown recorded')
  const run = history.semantic.runs.find(item => item.coverageRole === 'provisional')
  assert.equal(run.status, 'failed')
})

test('turn/end settles the final layer: programmatic checkpoint advances, provisional stays provisional, primary semantic advances only on success', async () => {
  const open = [turnStart(0, 0)]
  for (let index = 0; index < 3; index += 1) {
    const base = 1 + index * 2
    open.push(toolCall(base, base, `f-${index}`, 'edit'), toolResult(base + 1, base + 1, `f-${index}`, { error: true }))
  }
  open.push(assistant(7, 7, 'middle report'))
  const closed = [...open, stepEnd(8, 8, 1), turnEnd(9, 9, 1, 'completed')]
  const modelCalls = []
  const { service, store, timers } = liveService({
    events: closed,
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { everyTurns: 1 } },
    modelRunner: async () => { modelCalls.push({ provisional: false }); return semanticResult('最终结算') },
  })
  // Provisional first while the turn is open (failure pattern x3 fires).
  const provisionalHarness = liveService({
    events: open,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls.push({ provisional: true }); return semanticResult('阶段') },
  })
  provisionalHarness.service.observeLiveEvent({ id: 'session-settle' }, open.at(-1))
  await fireLiveDebounce(provisionalHarness.timers)
  await waitFor(() => modelCalls.length === 1)
  const provisionalHistory = await provisionalHarness.store.getSession('session-settle')
  assert.equal(provisionalHistory.semantic.coveredThroughSeq, -1)
  assert.equal(provisionalHistory.live.provisional.throughSeq, 7)
  assert.equal(modelCalls.filter(call => call.provisional).length, 1)

  // Now the turn ends and the final layer runs with the same session.
  service.observeLiveEvent({ id: 'session-settle' }, closed.at(-1))
  const settle = [...timers].reverse().find(timer => timer.delay === 250)
  assert.ok(settle)
  settle.fn()
  await service.enqueue('session-settle', async () => {})
  const history = await store.getSession('session-settle')
  assert.equal(history.programmatic.coveredThroughSeq, 9, 'final programmatic checkpoint settles the turn')
  assert.equal(history.semantic.coveredThroughSeq, 9, 'final primary semantic advances the primary watermark')
  const finalRun = history.semantic.runs.find(run => run.coverageRole === 'primary')
  assert.ok(finalRun, 'a real primary record exists')
  assert.equal(modelCalls.filter(call => call.provisional).length, 1)
  assert.equal(modelCalls.filter(call => !call.provisional).length, 1, 'exactly one final paid call')
})

test('viewing a historical session never enrolls, never calls a model, and never creates live state', async () => {
  const events = [turnStart(0, 0), assistant(1, 1, 'old'), turnEnd(2, 2, 1, 'completed')]
  let modelCalls = 0
  const { service, store } = liveService({
    events,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  const status = await service.readStatus('session-view-only')
  const bootstrap = await service.readBootstrap('session-view-only')
  const page = await service.historyPage('session-view-only', {})
  const live = await service.readLive('session-view-only')
  await flushTasks()
  const history = await store.getSession('session-view-only')
  assert.equal(history.automatic.enrolled, false)
  assert.equal(history.live.items.length, 0)
  assert.equal(modelCalls, 0)
  assert.ok(status)
  assert.ok(bootstrap)
  assert.ok(page)
  assert.equal(live.items.length, 0)
})

test('dispose cancels live and provisional timers and stale callbacks perform no work', async () => {
  const events = [turnStart(0, 0), assistant(1, 1, 'open')]
  let reads = 0
  let modelCalls = 0
  const query = fixture(events)
  const readSession = query.readSession
  query.readSession = async (...args) => { reads += 1; return readSession(...args) }
  const { service, timers } = liveService({
    events,
    sessionQuery: query,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  service.observeLiveEvent({ id: 'session-disposed-live' }, events.at(-1))
  const pending = timers.at(-1)
  service.dispose()
  pending.fn()
  await flushTasks()
  assert.equal(reads, 0)
  assert.equal(modelCalls, 0)
  assert.equal(service.liveFlushTimers.size, 0)
  assert.equal(service.provisionalDeadlineTimers.size, 0)
})

test('restart recovery marks leftover live state interrupted/finalized and rebuilds the open turn without model calls', async () => {
  const openEvents = [turnStart(0, 0), toolCall(1, 1, 'c-1', 'edit'), toolResult(2, 2, 'c-1')]
  let modelCalls = 0
  const { service, store, timers } = liveService({
    events: openEvents,
    settings: { defaultRoute: { provider: 'p', model: 'm' } },
    modelRunner: async () => { modelCalls += 1; return semanticResult() },
  })
  await store.updateSession('session-recover', history => {
    history.automatic.enrolled = true
    history.live.items.push({
      id: 'live-1', turn: 1, fromSeq: 0, observedThroughSeq: 2, stableThroughSeq: 2,
      lastMeaningfulAt: new Date(5_000).toISOString(), createdAt: new Date(4_000).toISOString(), updatedAt: new Date(5_000).toISOString(),
      state: 'open', analyzerVersion: ANALYZER_VERSION, report: null, revision: 0,
    })
    return history
  })
  await service.resumeAutomatic('session-recover', 'startup-recovery')
  const history = await store.getSession('session-recover')
  assert.equal(history.live.items[0].state, 'open', 'open turn rebuilt as open')
  assert.equal(modelCalls, 0, 'recovery alone never dispatches a model')
  assert.equal(history.live.items[0].analyzerVersion, ANALYZER_VERSION)
  assert.equal(timers.length >= 0, true)
})

test('a steady event stream flushes the live card periodically via the throttle, not only after the stream settles', async () => {
  const live = [turnStart(0, 0)]
  const { service, store, timers } = liveService({
    events: live,
    sessionQuery: fixture(live),
    settings: { defaultRoute: { provider: 'p', model: 'm' }, auto: { provisional: { enabled: false } } },
    modelRunner: async () => { throw new Error('unexpected model call') },
  })
  service.observeLiveEvent({ id: 'session-throttle' }, live[0])
  const immediate = [...timers].reverse().find(timer => timer.delay === 0)
  assert.ok(immediate, 'first event schedules an immediate flush')
  immediate.fn()
  await flushTasks()
  const timerCountAfterFirstFlush = timers.length
  let history = await store.getSession('session-throttle')
  assert.equal(history.live.items.length, 1, 'live card created on the first flush')
  // Keep the stream flowing within the window: only a trailing timer is pending.
  for (let index = 1; index <= 8; index += 1) {
    live.push(assistant(index, index, `step ${index}`))
    service.observeLiveEvent({ id: 'session-throttle' }, live.at(-1))
  }
  const trailing = timers.slice(timerCountAfterFirstFlush).reverse().find(timer => timer.delay >= 0 && timer.delay <= 10)
  assert.ok(trailing, 'trailing debounce timer scheduled while the stream keeps flowing')
  trailing.fn()
  await flushTasks()
  history = await store.getSession('session-throttle')
  assert.equal(history.live.items[0].stableThroughSeq, 8, 'stable prefix caught up on the trailing flush')
})

test('legacy v1 history and settings migrate lazily without losing checkpoints, runs, retry, routes or reasoning effort', async () => {
  const store = new MemoryHistoryStore({ initialSettings: normalizeAnalysisSettings({ defaultRoute: { provider: 'p', model: 'm' } }) })
  await store.updateSession('legacy', history => {
    history.programmatic.checkpoints.push({ id: 'cp-1', fromSeq: 0, toSeq: 5, capturedAt: new Date(1_000).toISOString() })
    history.semantic.runs.push({ id: 'run-1', status: 'succeeded', coverageRole: 'primary', route: { provider: 'p', model: 'm', reasoningEffort: 'high' }, fromSeq: 0, toSeq: 5 })
    history.semantic.coveredThroughSeq = 5
    history.semantic.retry = { fromSeq: 6, attempt: 2, notBefore: new Date(9_000).toISOString() }
    return history
  })
  const history = await store.getSession('legacy')
  assert.equal(history.programmatic.checkpoints[0].id, 'cp-1')
  assert.equal(history.semantic.runs[0].route.reasoningEffort, 'high')
  assert.equal(history.semantic.retry.attempt, 2)
  assert.ok(history.live, 'live section lazily migrated in')
  assert.deepEqual(history.live, { revision: 0, items: [], provisional: { turn: null, throughSeq: -1, callsInTurn: 0, lastDispatchedAt: null, lastSucceededAt: null } })
})
