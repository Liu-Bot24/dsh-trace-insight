import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTrace, projectRawSession } from '../src/core.mjs'
import { compressTraceEvent } from '../src/analysis-policy.mjs'
import { classifyTraceEvent } from '../src/live-turn.mjs'
import { migrateCoordinatePreservingHistory } from '../src/migration-coordinates.mjs'

for (const isError of [true, false]) {
  test(`v4 tool-role result preserves text, identity and error=${isError} in all projections`, () => {
    const event = {
      type: 'tool/result', seq: 1, time: 101, data: { turn: 1, step: 1, message: {
        role: 'tool', id: 'result-1', source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1', isError, content: [{ type: 'text', text: isError ? 'ENOENT: missing.txt' : 'file read successfully: sample includes ENOENT and RuntimeError' }],
      } },
    }
    const rawSession = { session: { id: 'one', version: 4 }, events: [
      { type: 'tool/call', seq: 0, time: 100, data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{}' } },
      event,
    ] }
    const projected = projectRawSession(rawSession)
    const result = projected.snapshot.nodes.find(node => node.kind === 'tool-result')
    assert.equal(result.callId, 'call-1')
    assert.equal(result.isError, isError)
    assert.deepEqual(result.content, event.data.message.content)
    assert.equal(compressTraceEvent(event).isError, isError)
    assert.match(compressTraceEvent(event).result, isError ? /ENOENT/ : /read successfully/)
    assert.equal(classifyTraceEvent(event).failure, isError)
    assert.equal(classifyTraceEvent(event).progress, !isError)
    assert.equal(analyzeTrace({ rawSession }).metrics.failedTools, isError ? 1 : 0)
  })
}

const source = { header: { id: 'one', version: 3 }, events: [
  { seq: 0, type: 'turn/start', time: 100, data: { turn: 1 } },
  { seq: 1, type: 'turn/end', time: 200, data: { turn: 1 } },
] }
const history = { sessionId: 'one', sourceFormatVersion: 3, semantic: {
  coveredThroughSeq: 1, runs: [{ fromSeq: 0, toSeq: 1, output: { evidenceRefs: [{ seq: 1 }] } }],
} }
const target = { header: { id: 'one', version: 4 }, events: structuredClone(source.events) }

test('validated identity-preserving migration changes only history format metadata', () => {
  const result = migrateCoordinatePreservingHistory(history, source, target)
  assert.equal(result.sourceFormatVersion, 4)
  assert.deepEqual({ ...result, sourceFormatVersion: 3 }, history)
  assert.equal(history.sourceFormatVersion, 3)
})

test('history migration refuses re-numbered events, mismatched identities and unbounded references', () => {
  const shifted = structuredClone(target)
  shifted.events.unshift({ seq: 0, type: 'system/message', time: 99, data: {} })
  shifted.events.forEach((event, index) => { event.seq = index })
  assert.throws(() => migrateCoordinatePreservingHistory(history, source, shifted), /changes existing event coordinates/)
  assert.throws(() => migrateCoordinatePreservingHistory({ ...history, sessionId: 'other' }, source, target), /identities/)
  assert.throws(() => migrateCoordinatePreservingHistory({ ...history, lastObservedSeq: 5 }, source, target), /outside/)
  assert.throws(() => migrateCoordinatePreservingHistory({ ...history, sourceFormatVersion: undefined }, source, target), /not known/)
  assert.throws(() => migrateCoordinatePreservingHistory({ sessionId: 'one', lastObservedSeq: 1 }, source, target), /not known/)
})

test('matching coordinates do not admit changed evidence, metadata or nonnumeric references', () => {
  const edited = structuredClone(target)
  edited.events[0].data.turn = 999
  assert.throws(() => migrateCoordinatePreservingHistory(history, source, edited), /evidence changed/)
  assert.throws(() => migrateCoordinatePreservingHistory(history, source, { ...target, inheritedEventCount: 1 }), /inherited/)
  assert.throws(() => migrateCoordinatePreservingHistory({ ...history, lastObservedSeq: '1' }, source, target), /outside/)
})

test('lossless tool wrapper promotion retains content, call identity and failure evidence', () => {
  const old = { ...source, events: [{
    seq: 0, time: 100, type: 'tool/result', data: { turn: 1, step: 1, message: {
      role: 'user', id: 'result', source: { kind: 'tool', callId: 'call' },
      content: [{ type: 'tool-result', toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'failure' }] }],
    } },
  }] }
  const next = structuredClone(old)
  next.header = { ...old.header, version: 4 }
  next.events[0].data.message = {
    role: 'tool', id: 'result', source: { kind: 'tool', callId: 'call' },
    toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'failure' }],
  }
  const empty = { sessionId: 'one', sourceFormatVersion: 3 }
  assert.equal(migrateCoordinatePreservingHistory(empty, old, next).sourceFormatVersion, 4)
  next.events[0].data.message.isError = false
  assert.throws(() => migrateCoordinatePreservingHistory(empty, old, next), /evidence changed/)
})

test('official producer renames retain provenance metadata and reject arbitrary attribution changes', () => {
  const old = { ...source, events: [{
    seq: 0, time: 100, type: 'system/message', data: { message: {
      role: 'system', id: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', revision: 2 },
      content: [{ type: 'text', text: 'unchanged system text' }],
    } },
  }] }
  const next = structuredClone(old)
  next.header = { ...old.header, version: 4 }
  next.events[0].data.message.source = { kind: 'system-prompt', revision: 2 }
  const empty = { sessionId: 'one', sourceFormatVersion: 3 }
  assert.equal(migrateCoordinatePreservingHistory(empty, old, next).sourceFormatVersion, 4)
  next.events[0].data.message.source.revision = 3
  assert.throws(() => migrateCoordinatePreservingHistory(empty, old, next), /evidence changed/)
  next.events[0].data.message.source = { kind: 'unrelated', revision: 2 }
  assert.throws(() => migrateCoordinatePreservingHistory(empty, old, next), /evidence changed/)
})
