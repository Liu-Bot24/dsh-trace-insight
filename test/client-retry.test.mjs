import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../src/client-template.js', import.meta.url), 'utf8')
  + '\n' + readFileSync(new URL('../src/client-retry.js', import.meta.url), 'utf8')
function harness() {
  const states = [], refs = [], effects = []
  let cursor = 0, refCursor = 0, effectCursor = 0, pending = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: Symbol('Fragment'),
    useState(value) { const index = cursor++; if (!(index in states)) states[index] = typeof value === 'function' ? value() : value; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }] },
    useRef(value) { return refs[refCursor++] ??= { current: value } },
    useMemo: callback => callback(), useCallback: callback => callback,
    useEffect(callback, deps) {
      const index = effectCursor++
      if (!effects[index] || deps.some((value, i) => value !== effects[index].deps[i])) pending.push({ index, callback, deps })
    },
  }
  const api = vm.runInNewContext(`${source}\n;({AutomaticRetryPanel, SegmentAnalysisPanel, automaticRetryRequest, budgetMessages, batchPlanText, latestStoredJob})`, {
    require(name) { assert.equal(name, 'react'); return react },
    setInterval() { return 1 }, clearInterval() {}, setTimeout, clearTimeout,
  })
  return { ...api,
    render(props) {
      cursor = 0; refCursor = 0; effectCursor = 0; pending = []
      const tree = api.AutomaticRetryPanel(props)
      for (const effect of pending) { effects[effect.index]?.dispose?.(); effects[effect.index] = { deps: effect.deps, dispose: effect.callback() } }
      return tree
    },
    dispose() { effects.forEach(effect => effect.dispose?.()) },
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const route = { provider: 'p', model: 'm' }
const status = () => ({ retry: { paused: true, fromSeq: 10, toSeq: 19, route }, coverage: { semanticPendingFromSeq: 10, closedThroughSeq: 999 }, activeJobs: [] })
function propsFor(overrides = {}) {
  return { sessionId: 's', initialRoute: route, models: [], onCompleted: async () => {}, onClose() {}, api: {
    async readStatus() { return status() },
    async previewAnalysis(request) { return { previewToken: 'preview', ...request, modelCalls: 1, estimatedInputChars: 1000, budgetAssessment: { hardLimitExceeded: false } } },
    ...overrides,
  } }
}

test('inline retry previews only the failed segment and requires explicit confirmation; double-click is idempotent', async () => {
  const h = harness()
  const requests = [], starts = []
  const props = propsFor({
    async previewAnalysis(request) { requests.push(request); return { previewToken: 'preview', modelCalls: 1, estimatedInputChars: 1000, budgetAssessment: { hardLimitExceeded: false } } },
    async startAnalysis(request) { starts.push(request); return { job: { id: 'retry-job', status: 'queued', fromSeq: 10, toSeq: 19 } } },
    async readJob() { return { job: { id: 'retry-job', status: 'succeeded', fromSeq: 10, toSeq: 19, progress: { completed: 1, total: 1 } } } },
  })
  h.render(props); await flush()
  let panel = h.render(props)
  assert.equal(panel.type.name, 'SegmentAnalysisPanel')
  assert.equal(panel.props.primaryRetry, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].fromSeq, 10)
  assert.equal(requests[0].toSeq, 19)
  assert.equal(requests[0].mode, 'primary')
  assert.equal(starts.length, 0)
  await Promise.all([panel.props.onStart(), panel.props.onStart()])
  assert.equal(starts.length, 1)
  assert.equal(starts[0].overrideBudget, undefined)
  assert.equal(starts[0].previewToken, 'preview')
  h.render(props); await flush(); panel = h.render(props)
  assert.equal(panel.props.job.status, 'succeeded')
  h.dispose()
})

test('a delayed preview cannot replace the newly selected model or enable a stale start', async () => {
  const h = harness()
  let finishOld
  const props = propsFor({ previewAnalysis(request) {
    if (request.route.model === 'm') return new Promise(resolve => { finishOld = resolve })
    return Promise.resolve({ previewToken: 'new', modelCalls: 1, budgetAssessment: { hardLimitExceeded: false } })
  } })
  h.render(props); await flush()
  let tree = h.render(props)
  const selector = tree.children.find(node => node?.type === 'label').children.find(node => node?.type === 'select')
  selector.props.onChange({ target: { value: JSON.stringify(['p', 'other', '']) } })
  h.render(props); await flush(); tree = h.render(props)
  finishOld({ previewToken: 'old', modelCalls: 999 }); await flush(); tree = h.render(props)
  assert.equal(tree.props.preview.previewToken, 'new')
  assert.equal(tree.props.preview.request.route.model, 'other')
  h.dispose()
})

test('missing failure range, changed coverage and active primary jobs never become a full-backlog retry', () => {
  const h = harness()
  assert.throws(() => h.automaticRetryRequest({ ...status(), retry: { ...status().retry, toSeq: null } }, route), /无法定位/)
  assert.throws(() => h.automaticRetryRequest({ ...status(), coverage: { semanticPendingFromSeq: 20, closedThroughSeq: 999 } }, route), /范围已变化/)
  assert.throws(() => h.automaticRetryRequest({ ...status(), activeJobs: [{ mode: 'primary' }] }, route), /任务正在运行/)
  assert.throws(() => h.automaticRetryRequest({ ...status(), retry: null }, route), /状态已变化/)
})

test('resource messages distinguish whole-task estimates from batch caps without raw error codes', () => {
  const h = harness()
  const messages = h.budgetMessages({ warnings: [{ code: 'CALLS_WARNING', actual: 32, limit: 8 }, { code: 'INPUT_CHARS_WARNING', actual: 582259, limit: 120000 }] })
  assert.match(messages.join('；'), /合计预计调用 32 次/)
  assert.match(messages.join('；'), /582,259 字符/)
  assert.doesNotMatch(messages.join('；'), /CALLS_WARNING|INPUT_CHARS_WARNING|超过/)
  assert.match(h.batchPlanText({ batchPlan: { totalBatches: 2, limits: { calls: 24, inputChars: 400000 } } }), /2 批，将自动接续执行/)
})

test('refresh selects the newest job independently of history order or analyzed range size', () => {
  const h = harness()
  const oldFailure = { id: 'old', status: 'failed', toSeq: 999, createdAt: '2026-08-27T01:00:00Z' }
  const newSuccess = { id: 'new', status: 'succeeded', toSeq: 17, createdAt: '2026-08-27T02:00:00Z' }
  assert.equal(h.latestStoredJob([newSuccess, oldFailure]).id, 'new')
  assert.equal(h.latestStoredJob([oldFailure, newSuccess]).id, 'new')
  assert.equal(h.latestStoredJob([]), null)
})
