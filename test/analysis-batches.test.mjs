import assert from 'node:assert/strict'
import test from 'node:test'
import { planAnalysisBatches, DEFAULT_ANALYSIS_SETTINGS } from '../src/analysis-policy.mjs'

test('32 calls and 582259 estimated characters continue as two bounded batches, not a blocked job', () => {
  const segments = Array.from({ length: 32 }, (_, index) => ({ fromSeq: index * 10, toSeq: index * 10 + 9,
    estimatedChars: index === 31 ? 18_300 : 18_192 + (index === 0 ? 7 : 0), cached: false }))
  const plan = planAnalysisBatches(segments, DEFAULT_ANALYSIS_SETTINGS.resourcePolicy, 21_936)
  assert.equal(segments.reduce((sum, segment) => sum + segment.estimatedChars, 0), 582_259)
  assert.equal(plan.totalBatches, 2)
  assert.deepEqual(plan.batches.map(batch => batch.reservedCalls), [18, 14])
  assert.equal(plan.batches.reduce((sum, batch) => sum + batch.modelCalls, 0), 32)
  for (const batch of plan.batches) {
    assert.ok(batch.reservedCalls <= 24)
    assert.ok(batch.reservedInputChars <= 400_000)
    assert.ok(batch.estimatedInputChars <= batch.reservedInputChars)
  }
  assert.equal(plan.batches[0].toSeq + 1, plan.batches[1].fromSeq)
})

test('batch call ceilings apply independently; cached segments do not add expected model use', () => {
  const segments = Array.from({ length: 5 }, (_, index) => ({ fromSeq: index, toSeq: index, estimatedChars: 100, cached: index === 0 }))
  const plan = planAnalysisBatches(segments, { maxCallsPerJob: 2, maxInputCharsPerJob: 4000 }, 1000)
  assert.equal(plan.totalBatches, 3)
  assert.deepEqual(plan.batches.map(batch => batch.reservedCalls), [2, 2, 1])
  assert.equal(plan.batches.reduce((sum, batch) => sum + batch.modelCalls, 0), 4)
  assert.equal(plan.batches.reduce((sum, batch) => sum + batch.estimatedInputChars, 0), 400)
  assert.throws(() => planAnalysisBatches(segments, { maxCallsPerJob: 2, maxInputCharsPerJob: 4000 }, 5000), /fit within one batch/)
})
