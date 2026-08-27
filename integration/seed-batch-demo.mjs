// Prepare a dedicated paused-state fixture; actual model execution is tested
// through the real DSH fixture adapter after the server starts.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { FileHistoryStore } from '../src/history-store.mjs'
import { TraceInsightService } from '../src/analysis-service.mjs'
import { normalizeAnalysisSettings } from '../src/analysis-policy.mjs'

const dshHome = realpathSync(process.argv[2])
assert.notEqual(dshHome, resolve(homedir(), '.dsh'))
const profile = JSON.parse(readFileSync(join(dshHome, 'profiles/web/package.json'), 'utf8'))
assert.ok(profile.dependencies['dsh-plugin-trace-insight-fixture-llm'], 'Only seed the dedicated fixture profile.')
const registryPath = join(dshHome, 'storages/workspace.json')
const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
const workspace = registry.tables.workspaces['ws-standard-demo']
assert.ok(workspace)
const sessionId = process.argv[3] || `session-retry-batches-${Date.now()}`
assert.match(sessionId, /^session-retry-batches-\d+$/)
const store = new FileHistoryStore({ rootDir: join(dshHome, 'trace-insight') })
const previous = await store.getSession(sessionId)
assert.equal(previous.semantic.coveredThroughSeq, -1, 'Do not overwrite a completed fixture.')
assert.equal(previous.jobs.length + previous.semantic.runs.length, 0, 'Do not overwrite existing test results.')
const now = Date.now()
const events = Array.from({ length: 10 }, (_, index) => {
  const turn = index + 1
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: { id: `${sessionId}-u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `分批执行与失败段重试验收 ${turn}。` }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: { id: `${sessionId}-a-${turn}`, role: 'assistant', source: { kind: 'model', provider: 'trace-insight-fixture', model: 'fixture-small' }, content: [{ type: 'text', text: `第 ${turn} 轮验收记录。${'保留顺序与范围，不跳过后续批次。'.repeat(15)}` }] } } },
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ].map((event, offset) => ({ ...event, seq: index * 6 + offset, time: now + index * 6 + offset }))
}).flat()
let slug = '', separator = false
for (const character of workspace.path) {
  if ('/\\:'.includes(character)) { if (!separator) slug += '-'; separator = true }
  else { slug += /^[A-Za-z0-9._-]$/.test(character) ? character : `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`; separator = false }
}
const key = `--${(slug.replace(/^-+/, '') || 'root').slice(0, 251)}--`
const path = join(dshHome, 'sessions', key, sessionId, 'session.jsonl.zstd')
mkdirSync(dirname(path), { recursive: true })
const header = { type: 'session', version: 0, id: sessionId, createdAt: now, cwd: workspace.path, delegationDepth: 0, agentPreset: 'standard' }
writeFileSync(path, Buffer.concat([header, ...events].map(value => zstdCompressSync(Buffer.from(JSON.stringify(value) + '\n')))))
if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
workspace.updatedAt = new Date(now).toISOString()
writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')
const route = { provider: 'trace-insight-fixture', model: 'fixture-small' }
const settings = normalizeAnalysisSettings({ defaultRoute: route, auto: { enabled: true, maxPendingEvents: 20, maxInputChars: 4000, provisional: { enabled: false } }, resourcePolicy: { maxCallsPerJob: 1, maxInputCharsPerJob: 4000 } })
await store.updateSession(sessionId, history => { history.settingsOverride = settings; history.lastObservedSeq = 59; history.lastClosedSeq = 59; return history })
const service = new TraceInsightService({ store, llm: {}, sessionQuery: {
  async readSession() { return { session: header, events } },
  async listEvents() { return events.map(event => ({ sessionId, seq: event.seq, type: event.type, time: event.time })) },
  async readSurface() { return { session: header, capturedThroughSeq: 59, events: events.filter(event => event.surfaceOp) } },
  async traceSession() { return { complete: true, target: {}, ancestors: [], descendants: [], root: {} } },
} })
const preview = await service.previewAnalysis({ sessionId, mode: 'primary', fromSeq: 0, toSeq: 59, route })
const failed = preview.segments[0]
await store.updateSession(sessionId, history => {
  history.semantic.retry = { fromSeq: failed.fromSeq, route, attempt: 3, notBefore: null, code: 'TRANSPORT', paused: true }
  history.semantic.runs.push({ id: `${sessionId}-automatic-failure`, mode: 'auto', coverageRole: 'primary', status: 'failed',
    fromSeq: failed.fromSeq, toSeq: failed.toSeq, route, createdAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(),
    error: { code: 'TRANSPORT', message: '专用本机重试验收的预置暂停状态。' } })
  return history
})
service.dispose()
console.log(JSON.stringify({ sessionId, failedRange: { fromSeq: failed.fromSeq, toSeq: failed.toSeq }, throughSeq: 59,
  expectedBatches: preview.batchPlan.totalBatches, expectedCalls: preview.modelCalls }))
