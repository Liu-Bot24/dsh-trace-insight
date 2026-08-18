import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ANALYSIS_SETTINGS,
  buildSemanticEnvelope,
  evaluateAutomaticTrigger,
  normalizeAnalysisSettings,
  planCoverageSegments,
  redactTraceText,
} from '../src/analysis-policy.mjs'

function turn(turn, startSeq, payload = `turn ${turn}`) {
  return [
    { type: 'turn/start', seq: startSeq, time: 1_000 + startSeq, data: { turn } },
    {
      type: 'user/message', seq: startSeq + 1, time: 1_001 + startSeq, surfaceOp: 'append',
      data: { id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: payload }] },
    },
    { type: 'turn/end', seq: startSeq + 2, time: 1_002 + startSeq, data: { turn, reason: { kind: 'completed' } } },
  ]
}

function settings(overrides = {}) {
  return normalizeAnalysisSettings({
    defaultRoute: { provider: 'test-provider', model: 'small-model' },
    ...overrides,
  })
}

test('coverage planner packs small turns and preserves an exact contiguous range', () => {
  const events = [...turn(1, 0), ...turn(2, 3), ...turn(3, 6), ...turn(4, 9)]
  const segments = planCoverageSegments({ events, fromSeq: 0, throughSeq: 11, maxInputChars: 50_000, maxEvents: 100 })
  assert.equal(segments.length, 1)
  assert.equal(segments[0].fromSeq, 0)
  assert.equal(segments[0].toSeq, 11)
  assert.equal(segments[0].fromTurn, 1)
  assert.equal(segments[0].toTurn, 4)
})

test('coverage planner splits oversized history without gaps or overlaps', () => {
  const events = [
    ...turn(1, 0, 'a'.repeat(1_500)),
    ...turn(2, 3, 'b'.repeat(1_500)),
    ...turn(3, 6, 'c'.repeat(1_500)),
  ]
  const segments = planCoverageSegments({ events, fromSeq: 0, throughSeq: 8, maxInputChars: 4_000, maxEvents: 3 })
  assert.ok(segments.length > 1)
  assert.equal(segments[0].fromSeq, 0)
  assert.equal(segments.at(-1).toSeq, 8)
  for (let index = 1; index < segments.length; index += 1) {
    assert.equal(segments[index].fromSeq, segments[index - 1].toSeq + 1)
  }
})

test('automatic policy triggers immediately for a new high-severity finding', () => {
  const events = turn(1, 0)
  const decision = evaluateAutomaticTrigger({
    events,
    history: { semantic: { coveredThroughSeq: -1 } },
    settings: settings(),
    report: { findings: [{ severity: 'high', evidence: [{ seq: 1 }] }] },
  })
  assert.equal(decision.due, true)
  assert.equal(decision.reason, 'high-severity')
})

test('automatic policy does not retrigger an old finding outside the pending range', () => {
  const events = [...turn(1, 0), ...turn(2, 3)]
  const decision = evaluateAutomaticTrigger({
    events,
    history: { semantic: { coveredThroughSeq: 2 } },
    settings: settings({ auto: { everyTurns: 4, maxPendingEvents: 160, maxInputChars: 22_000 } }),
    report: { findings: [{ severity: 'high', evidence: [{ seq: 1 }] }] },
  })
  assert.equal(decision.due, false)
  assert.equal(decision.reason, 'accumulating')
})

test('automatic policy waits for an explicit default model route', () => {
  const decision = evaluateAutomaticTrigger({
    events: turn(1, 0),
    history: { semantic: { coveredThroughSeq: -1 } },
    settings: DEFAULT_ANALYSIS_SETTINGS,
    report: { findings: [] },
    reason: 'quiet-period',
  })
  assert.equal(decision.due, false)
  assert.equal(decision.reason, 'waiting-for-model')
})

test('semantic envelope carries prior continuity but only selected evidence', () => {
  const events = [...turn(1, 0), ...turn(2, 3)]
  const segment = planCoverageSegments({ events, fromSeq: 3, throughSeq: 5 })[0]
  const envelope = buildSemanticEnvelope({
    rawSession: { log: { session: { id: 'session-1' }, events } },
    segment,
    report: { sessionId: 'session-1', userGoal: 'goal', findings: [], phases: [], lessons: [], metrics: {} },
    previousSummary: 'turn 1 completed normally',
  })
  assert.equal(envelope.coverage.fromSeq, 3)
  assert.equal(envelope.coverage.toSeq, 5)
  assert.equal(envelope.previousContinuitySummary, 'turn 1 completed normally')
  assert.equal(envelope.evidence.some(item => item.seq < 3), false)
})

test('semantic envelope redacts secrets from deterministic summaries as well as raw evidence', () => {
  const events = turn(1, 0, 'Authorization: Bearer abcdefghijklmnop')
  const segment = planCoverageSegments({ events, fromSeq: 0, throughSeq: 2 })[0]
  const envelope = buildSemanticEnvelope({
    rawSession: { log: { session: { id: 'session-secret' }, events } },
    segment,
    report: {
      sessionId: 'session-secret', userGoal: 'api_key=supersecretvalue', summary: 'password=hunter12345',
      findings: [], phases: [], lessons: [], metrics: {},
    },
  })
  const serialized = JSON.stringify(envelope)
  assert.doesNotMatch(serialized, /abcdefghijklmnop|supersecretvalue|hunter12345/)
  assert.match(serialized, /REDACTED/)
})

test('semantic envelope redacts nested credential fields but preserves harmless neighboring data', () => {
  const envelope = buildSemanticEnvelope({
    rawSession: { log: { session: { id: 'session-nested-secret' }, events: [] } },
    segment: {
      fromSeq: 0,
      toSeq: 0,
      entries: [{
        seq: 0,
        type: 'request/header',
        route: {
          apiKey: 'ordinary-looking-key-value',
          credentials: { refreshToken: 'ordinary-refresh-value', clientSecret: 'ordinary-client-value' },
          maxOutputTokens: 1_800,
          model: 'safe-model-name',
        },
      }],
    },
    report: { sessionId: 'session-nested-secret', findings: [], phases: [], lessons: [], metrics: {} },
  })
  const serialized = JSON.stringify(envelope)
  assert.doesNotMatch(serialized, /ordinary-looking-key-value|ordinary-refresh-value|ordinary-client-value/)
  assert.match(serialized, /"apiKey":"\[REDACTED\]"/)
  assert.match(serialized, /"maxOutputTokens":1800/)
  assert.match(serialized, /safe-model-name/)
})

test('semantic envelope enforces the configured total character budget without dropping event identities', () => {
  const entries = Array.from({ length: 12 }, (_, seq) => ({
    seq,
    type: seq % 2 ? 'assistant/message' : 'tool/result',
    text: `evidence-${seq} ${'x'.repeat(1_200)}`,
  }))
  const envelope = buildSemanticEnvelope({
    rawSession: { log: { session: { id: 'session-budget' }, events: [] } },
    segment: { fromSeq: 0, toSeq: 11, entries },
    previousSummary: 'p'.repeat(6_000),
    maxChars: 4_000,
    report: {
      sessionId: 'session-budget',
      userGoal: 'g'.repeat(2_000),
      summary: 's'.repeat(3_000),
      rootCause: 'r'.repeat(3_000),
      findings: [],
      phases: [],
      lessons: [],
      metrics: { input: 1, output: 2 },
    },
  })
  assert.ok(JSON.stringify(envelope).length <= 4_000)
  assert.deepEqual(envelope.evidence.map(item => item.seq), entries.map(item => item.seq))
  assert.equal(envelope.coverage.fromSeq, 0)
  assert.equal(envelope.coverage.toSeq, 11)
})

test('trace prompt redaction removes bearer and named credential values', () => {
  const text = redactTraceText('Authorization: Bearer abcdefghijklmnop api_key=supersecretvalue')
  assert.doesNotMatch(text, /abcdefghijklmnop|supersecretvalue/)
  assert.match(text, /REDACTED/)
})

test('resource policy lazily migrates old settings and keeps warning thresholds within hard guards', () => {
  const migrated = normalizeAnalysisSettings({
    schemaVersion: 1,
    defaultRoute: null,
    auto: { enabled: true, everyTurns: 4, maxPendingEvents: 160, maxInputChars: 22_000, quietPeriodMs: 90_000 },
    model: { maxOutputTokens: 1_800, timeoutMs: 120_000 },
  })
  assert.deepEqual(migrated.resourcePolicy, DEFAULT_ANALYSIS_SETTINGS.resourcePolicy)

  const bounded = normalizeAnalysisSettings({
    resourcePolicy: {
      maxCallsPerJob: 3,
      warnCallsPerJob: 99,
      maxInputCharsPerJob: 10_000,
      warnInputCharsPerJob: 99_000,
    },
  })
  assert.deepEqual(bounded.resourcePolicy, {
    maxCallsPerJob: 3,
    maxInputCharsPerJob: 10_000,
    warnCallsPerJob: 3,
    warnInputCharsPerJob: 10_000,
  })
})
