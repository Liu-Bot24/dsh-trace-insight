import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const base = new URL(process.argv[2])
const sessionId = process.argv[3]
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname) && base.port && base.port !== '3080')
assert.match(sessionId, /^session-retry-batches-\d+$/)
async function rpc(method, payload) {
  const response = await fetch(new URL(`/trace-insight/${method}`, base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { sessionId, ...payload } }),
  })
  assert.equal(response.status, 200)
  const result = (await response.json()).result
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}
const status = await rpc('insight/status')
assert.equal(status.coverage.semanticThroughSeq, 59)
assert.equal(status.retry, null)
let exercisedJobId
if (process.argv.includes('--exercise')) {
  const request = { mode: 'supplemental', fromSeq: 0, toSeq: 59, route: { provider: 'trace-insight-fixture', model: 'fixture-small' }, force: true }
  const preview = await rpc('analysis/preview', request)
  assert.ok(preview.batchPlan.totalBatches >= 3)
  assert.equal(preview.budgetAssessment.hardLimitExceeded, false)
  const started = await rpc('analysis/start', { ...request, previewToken: preview.previewToken, idempotencyKey: `batch-exercise-${randomUUID()}` })
  exercisedJobId = started.jobId
  let job
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await rpc('analysis/job', { jobId: exercisedJobId })).job
    if (!['queued', 'running'].includes(job.status)) break
    await delay(50)
  }
  assert.equal(job.status, 'succeeded')
  assert.equal(job.batchProgress.completed, preview.batchPlan.totalBatches)
}
const { analysis } = await rpc('export/read', { kind: 'analysis' })
const history = analysis.history
const jobs = history.jobs.filter(job => job.mode === 'primary')
assert.ok(jobs.some(job => job.status === 'failed'), 'The real failure must remain recorded.')
const successful = jobs.filter(job => job.status === 'succeeded').sort((a, b) => a.fromSeq - b.fromSeq)
assert.equal(successful[0].fromSeq, 0)
assert.equal(successful[0].toSeq, 17)
assert.equal(successful[1].fromSeq, 18)
assert.equal(successful[1].toSeq, 59)
assert.ok(successful[1].batchPlan.totalBatches >= 3)
const observed = []
for (const job of [...successful, ...history.jobs.filter(job => job.id === exercisedJobId)]) {
  assert.equal(job.resourceOverride, null)
  const batches = job.batchPlan.batches.map(batch => {
    const segments = job.segments.slice(batch.firstSegment, batch.lastSegment + 1)
    assert.ok(segments.every(segment => segment.status === 'succeeded'))
    const runs = segments.map(segment => history.semantic.runs.find(run => run.id === segment.runId))
    const dispatched = runs.filter(run => run.modelDispatchedAt)
    const inputChars = dispatched.reduce((sum, run) => sum + run.inputChars, 0)
    assert.ok(dispatched.every(run => run.route.provider === 'trace-insight-fixture'))
    assert.ok(dispatched.length <= job.batchPlan.limits.calls)
    assert.ok(inputChars <= job.batchPlan.limits.inputChars)
    return { batch: batch.index + 1, fromSeq: batch.fromSeq, toSeq: batch.toSeq, calls: dispatched.length, inputChars }
  })
  observed.push({ jobId: job.id, batches })
}
console.log(JSON.stringify({ ok: true, sessionId, throughSeq: 59, failedRecordsPreserved: true, noOverrideNeeded: true, observed }, null, 2))
