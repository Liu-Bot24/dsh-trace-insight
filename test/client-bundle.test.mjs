import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const standardEdition = process.env.TRACE_INSIGHT_TEST_VARIANT === 'standard'
const clientUrl = new URL(standardEdition ? '../packages/standard/client.js' : '../client.js', import.meta.url)

async function loadBundle(reactOverride, runtimeOverrides = {}) {
  const source = await readFile(clientUrl, 'utf8')
  let descriptor
  const context = {
    window: { __ModuleLoader__: { load(value) { descriptor = value } } },
    document: {
      querySelector() { return null },
      createElement() { return { dataset: {}, remove() {}, click() {} } },
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    Blob: class {},
    URL: { createObjectURL() { return 'blob:test' }, revokeObjectURL() {} },
    Intl, Map, Set, Date, Error, JSON, Math, Number, String, Array, RegExp, Object, Boolean, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    ...runtimeOverrides,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  assert.equal(descriptor.id, 'dsh-plugin-trace-insight')
  const reactStub = {
    createElement() { return null },
    useCallback(fn) { return fn },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(initial) { return { current: initial } },
    useState(initial) { return [initial, () => {}] },
  }
  return descriptor.factory(id => {
    if (id === 'react') return reactOverride || reactStub
    throw new Error(`unexpected module: ${id}`)
  })
}

function interactiveReactHarness({ runStatusEffects = false, runResearchEffects = false, runJobEffects = false, runCompareEffects = false, runSegmentEffects = false } = {}) {
  const states = []
  const refs = []
  let stateCursor = 0
  let refCursor = 0
  let initializationRan = false
  return {
    react: {
      createElement(type, props, ...children) { return { type, props: props || {}, children } },
      useCallback(fn) { return fn },
      useEffect(fn) {
        const source = String(fn)
        if (!initializationRan && source.includes('api.readCapabilities().then')) {
          initializationRan = true
          fn()
        } else if (runStatusEffects && source.includes('setInterval(() => pollStatus()')) fn()
        else if (runResearchEffects && source.includes("mode === 'research'")) fn()
        else if (runJobEffects && (source.includes('persistedJob') || source.includes('pollJob'))) fn()
        else if (runCompareEffects && source.includes('compare-candidates')) fn()
        else if (runSegmentEffects && (source.includes('segmentPreviewRequested.current') || source.includes("job?.status !== 'succeeded'"))) fn()
      },
      useMemo(fn) { return fn() },
      useRef(initial) {
        const index = refCursor++
        if (!refs[index]) refs[index] = { current: initial }
        return refs[index]
      },
      useState(initial) {
        const index = stateCursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
      Fragment: Symbol('Fragment'),
    },
    render(component, props) {
      stateCursor = 0
      refCursor = 0
      return component(props)
    },
  }
}

function dependencyLifecycleReactHarness() {
  const states = []
  const refs = []
  const callbacks = []
  const effects = []
  let stateCursor = 0
  let refCursor = 0
  let callbackCursor = 0
  let effectCursor = 0
  let pendingEffects = []
  const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  return {
    react: {
      createElement(type, props, ...children) { return { type, props: props || {}, children } },
      useCallback(fn, deps) {
        const index = callbackCursor++
        if (!callbacks[index] || !sameDeps(callbacks[index].deps, deps)) callbacks[index] = { fn, deps }
        return callbacks[index].fn
      },
      useEffect(fn, deps) {
        const index = effectCursor++
        if (!String(fn).includes('api.readCapabilities().then')) return
        if (!effects[index] || !sameDeps(effects[index].deps, deps)) pendingEffects.push({ index, fn, deps })
      },
      useMemo(fn) { return fn() },
      useRef(initial) {
        const index = refCursor++
        if (!refs[index]) refs[index] = { current: initial }
        return refs[index]
      },
      useState(initial) {
        const index = stateCursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
      Fragment: Symbol('Fragment'),
    },
    render(component, props) {
      stateCursor = 0
      refCursor = 0
      callbackCursor = 0
      effectCursor = 0
      pendingEffects = []
      const tree = component(props)
      for (const pending of pendingEffects) {
        effects[pending.index]?.cleanup?.()
        effects[pending.index] = { deps: pending.deps, cleanup: pending.fn() }
      }
      return tree
    },
    unmount() {
      for (const effect of effects) effect?.cleanup?.()
    },
  }
}

function treeText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join('')
  return treeText(node.children || [])
}

function findTreeNodes(node, predicate, output = []) {
  if (node === null || node === undefined) return output
  if (Array.isArray(node)) {
    for (const child of node) findTreeNodes(child, predicate, output)
    return output
  }
  if (typeof node !== 'object') return output
  if (predicate(node)) output.push(node)
  findTreeNodes(node.children || [], predicate, output)
  return output
}

function boundedBootstrap(items = []) {
  return {
    serviceVersion: 'test',
    status: { coverage: { observedThroughSeq: 20, programmaticThroughSeq: 20 } },
    latest: { programmatic: { id: 'checkpoint' } },
    report: { status: { code: 'complete', label: '完成' }, summary: '测试摘要' },
    settingsScope: { global: {}, effective: {} },
    history: { items, total: items.length, revision: 1, nextCursor: null },
    annotations: { total: 0, activeCount: 0, revision: 0 },
    turns: [{ turn: 1, fromSeq: 0, toSeq: 20 }],
    resources: {},
  }
}

test('browser bundle registers the inspector pane and the header toggle on inspector hosts', { skip: standardEdition }, async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'sessions', 'connection', 'layout'])
  const registrations = []
  const ctx = {
    effect(callback) { return callback() },
    connection: { rpc: { async call() { return { ok: true, value: {} } } } },
    sessions: { binding() { return { session: {} } } },
    layout: { toggleInspector() {}, isInspectorOpen() { return true }, onChange() { return () => {} } },
    slots: {
      spec(name) { return name === 'inspector' ? { kind: 'single', scope: 'session' } : undefined },
      inject(name, callback) { if (name === 'inspector' || name === 'conversation.session.header.utilities') callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  const view = registrations.find(item => item.options.name === 'inspector')
  const toggle = registrations.find(item => item.options.name === 'conversation.session.header.utilities')
  assert.ok(view, 'inspector entry registered')
  assert.equal(view.options.id, 'trace-insight')
  assert.equal(typeof view.component, 'function')
  const injected = view.options.inject('session-1')
  assert.equal(injected.sessionId, 'session-1')
  assert.equal(typeof injected.api.readCapabilities, 'function')
  assert.ok(toggle, 'header utilities toggle registered')
  assert.equal(toggle.options.id, 'trace-insight-inspector-toggle')
  const toggleInjected = toggle.options.inject()
  assert.equal(typeof toggleInjected.layout.toggleInspector, 'function')
  assert.equal(typeof toggle.component, 'function')
  const toggleTree = toggle.component(toggleInjected)
  assert.equal(toggleTree.props['aria-pressed'], true)
  assert.equal(findTreeNodes(toggleTree, node => node.props?.className === 'tiToggleDot').length, 0)
  const toggleIcon = findTreeNodes(toggleTree, node => node.type === 'svg' && node.props?.className === 'tiToggleIcon')[0]
  assert.ok(toggleIcon)
  assert.equal(findTreeNodes(toggleIcon, node => node.type === 'rect').length, 2)
  assert.equal(findTreeNodes(toggleIcon, node => node.type === 'path').length, 1)
  assert.match(treeText(toggleTree), /解读/)
})

test('legacy bundle falls back to the 解读 conversation view on hosts without the inspector slot', { skip: standardEdition }, async () => {
  const plugin = await loadBundle()
  let registration
  const ctx = {
    effect(callback) { return callback() },
    connection: { rpc: { async call() { return { ok: true, value: {} } } } },
    sessions: { binding() { return { session: {} } } },
    slots: {
      spec() { return undefined },
      inject(name, callback) { assert.equal(name, 'conversation.view'); callback() },
      register(options, component) { registration = { options, component }; return () => {} },
    },
  }
  plugin.apply(ctx)
  assert.equal(registration.options.id, 'trace-insight')
  assert.equal(registration.options.order, 20)
  assert.equal(registration.options.label(), '解读')
  assert.equal(typeof registration.component, 'function')
})
test('client operations use capability-advertised P0 RPC contracts with exact scope', async () => {
  const plugin = await loadBundle()
  let registration
  const calls = []
  const ctx = {
    effect(callback) { return callback() },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          calls.push({ channel, endpoint, payload })
          if (endpoint === 'capabilities/read') {
            return {
              ok: true,
              value: {
                endpoints: [
                  'insight/bootstrap', 'programmatic/sync', 'history/page', 'history/delta', 'evidence/read',
                  'compare/read',
                  'research/summary', 'research/members',
                  'settings/update-global', 'settings/update-session', 'analysis/preview',
                  'analysis/start', 'analysis/job', 'analysis/cancel', 'insight/status',
                  'export/preview', 'export/read',
                ],
                features: { settingsScopes: true, asyncJobs: true, statusRead: true, historyPaging: true, historyDelta: true, exportPreview: true, safeRawExport: true, nonFullBootstrap: true, runComparison: true, researchSummary: true },
              },
            }
          }
          return { ok: true, value: { endpoint } }
        },
      },
    },
    sessions: { binding() { return { session: {} } } },
    slots: {
      inject(_name, callback) { callback() },
      register(options, component) { registration = { options, component }; return () => {} },
    },
  }
  plugin.apply(ctx)
  const injected = registration.options.inject('session-1')
  assert.equal(injected.sessionId, 'session-1')
  assert.equal(typeof injected.api.readCapabilities, 'function')
  assert.equal(typeof injected.api.readInsight, 'function')
  assert.equal(typeof injected.api.readBootstrap, 'function')
  assert.equal(typeof injected.api.syncProgrammatic, 'function')
  assert.equal(typeof injected.api.readHistoryPage, 'function')
  assert.equal(typeof injected.api.readComparison, 'function')
  assert.equal(injected.api.upsertAnnotation, undefined)
  assert.equal(typeof injected.api.readResearchSummary, 'function')
  assert.equal(typeof injected.api.updateGlobalSettings, 'function')
  assert.equal(typeof injected.api.updateSessionSettings, 'function')
  assert.equal(typeof injected.api.previewAnalysis, 'function')
  assert.equal(typeof injected.api.startAnalysis, 'function')
  assert.equal(typeof injected.api.cancelAnalysis, 'function')
  assert.equal(typeof injected.api.previewExport, 'function')
  assert.equal(typeof injected.api.exportData, 'function')
  await injected.api.readCapabilities()
  await injected.api.readBootstrap({ historyLimit: 80, filters: { layers: ['semantic'] } })
  await injected.api.syncProgrammatic({ historyLimit: 80, filters: { layers: ['programmatic'] } })
  await injected.api.listModels()
  await injected.api.readHistoryPage({ cursor: 'opaque', limit: 80, filters: { query: 'error' } })
  await injected.api.readHistoryDelta({ sinceRevision: 7, filters: { statuses: ['failed'] } })
  await injected.api.readEvidence({ runId: 'run-1', evidenceIndex: 2, before: 2, after: 2 })
  await injected.api.readComparison({ leftRunId: 'run-1', rightRunId: 'run-2' })
  await injected.api.readResearchSummary({ filters: { models: ['provider/model/high'] } })
  await injected.api.readResearchMembers({ dimension: 'models', key: 'provider/model/high', cursor: 'research-cursor', limit: 80, filters: {} })
  await injected.api.readInsight()
  await injected.api.readEffectiveSettings()
  await injected.api.updateGlobalSettings({ patch: { auto: { enabled: true } }, expectedRevision: 2 })
  await injected.api.updateSessionSettings({ patch: { defaultRoute: { provider: 'p', model: 'm' } }, expectedRevision: 3 })
  const request = { mode: 'primary', fromSeq: 2, toSeq: 9, route: { provider: 'p', model: 'm', reasoningEffort: 'low' }, force: true }
  await injected.api.previewAnalysis(request)
  await injected.api.startAnalysis({ ...request, previewToken: 'preview-1' })
  await injected.api.readJob('job-1')
  await injected.api.cancelAnalysis('job-1', 4)
  await injected.api.readStatus()
  await injected.api.previewExport({ kind: 'bundle' })
  await injected.api.exportData('bundle', { confirmationToken: 'confirm-1' })
  assert.deepEqual(calls.map(call => call.endpoint), [
    'capabilities/read', 'insight/bootstrap', 'programmatic/sync', 'models/list', 'history/page', 'history/delta',
    'evidence/read', 'compare/read', 'research/summary', 'research/members', 'insight/read', 'settings/effective', 'settings/update-global',
    'settings/update-session', 'analysis/preview', 'analysis/start', 'analysis/job',
    'analysis/cancel', 'insight/status', 'export/preview', 'export/read',
  ])
  assert.equal(calls.every(call => call.channel === '/trace-insight'), true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].payload)), { sessionId: 'session-1', historyLimit: 80, filters: { layers: ['semantic'] } })
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2].payload)), { sessionId: 'session-1', historyLimit: 80, filters: { layers: ['programmatic'] } })
  assert.deepEqual(JSON.parse(JSON.stringify(calls[4].payload)), { sessionId: 'session-1', cursor: 'opaque', limit: 80, filters: { query: 'error' } })
  assert.deepEqual(JSON.parse(JSON.stringify(calls[5].payload)), { sessionId: 'session-1', sinceRevision: 7, filters: { statuses: ['failed'] } })
  assert.deepEqual(JSON.parse(JSON.stringify(calls[12].payload)), { patch: { auto: { enabled: true } }, expectedRevision: 2 })
  assert.equal(calls[14].payload.sessionId, 'session-1')
  assert.equal(calls[14].payload.route.reasoningEffort, 'low')
  assert.equal(calls[15].payload.previewToken, 'preview-1')
  assert.equal(calls[20].payload.confirmationToken, 'confirm-1')
})

test('legacy Host fallback is explicit and never permits unsafe raw export', async () => {
  const plugin = await loadBundle()
  let registration
  const calls = []
  const ctx = {
    effect(callback) { return callback() },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          calls.push({ channel, endpoint, payload })
          if (endpoint === 'capabilities/read') return { ok: false, error: { code: 'bad-request', message: 'Trace Insight does not expose this endpoint.' } }
          return { ok: true, value: { endpoint, results: [] } }
        },
      },
    },
    sessions: { binding() { return { session: {} } } },
    slots: {
      inject(_name, callback) { callback() },
      register(options, component) { registration = { options, component }; return () => {} },
    },
  }
  plugin.apply(ctx)
  const injected = registration.options.inject('legacy-session')
  const capabilities = await injected.api.readCapabilities()
  assert.equal(capabilities.legacy, true)
  await injected.api.updateGlobalSettings({ patch: { auto: { enabled: false } } })
  await injected.api.runLegacyAnalysis({ fromSeq: 1, toSeq: 2, route: { provider: 'p', model: 'm' }, force: false })
  await injected.api.exportData('analysis')
  await assert.rejects(() => injected.api.exportData('raw', { confirmationToken: 'fake' }), /不支持经过确认的原始轨迹导出/)
  assert.deepEqual(calls.map(call => call.endpoint), ['capabilities/read', 'settings/update', 'analysis/run', 'export/read'])
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].payload)), { settings: { auto: { enabled: false } }, sessionId: 'legacy-session' })
  assert.equal(calls.some(call => call.endpoint === 'export/read' && call.payload.kind === 'raw'), false)
})

test('capability transport failures surface as errors instead of silently entering legacy mode', async () => {
  const harness = dependencyLifecycleReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  const calls = []
  plugin.apply({
    effect(callback) { return callback() },
    connection: { rpc: { async call(_channel, endpoint) { calls.push(endpoint); throw Object.assign(new Error('transport reset'), { code: 'ECONNRESET' }) } } },
    sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const injected = registration.options.inject('transport-error-session')
  const props = { useSession: () => ({ nodes: [] }), ...injected }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  assert.match(treeText(tree), /解读数据不可用：transport reset/)
  assert.deepEqual(calls, ['capabilities/read'])
  harness.unmount()
})

test('new Host first render reads bounded bootstrap and never insight/read', async () => {
  const state = []
  const reactHarness = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(initial) { return { current: initial } },
    useState(initial) { const index = state.length; state.push(initial); return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }] },
    useEffect(fn) { if (String(fn).includes('api.readCapabilities().then')) fn() },
    Fragment: Symbol('Fragment'),
  }
  const plugin = await loadBundle(reactHarness)
  let registration
  const ctx = {
    effect(callback) { return callback() },
    connection: { rpc: { async call() { return { ok: true, value: {} } } } },
    sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  }
  plugin.apply(ctx)
  const calls = []
  const api = {
    async readCapabilities() { calls.push('capabilities/read'); return { endpoints: ['insight/bootstrap', 'programmatic/sync'], features: { nonFullBootstrap: true, programmaticSync: true } } },
    async readBootstrap(request) {
      calls.push(['insight/bootstrap', request])
      return { serviceVersion: 'test', status: { coverage: {} }, settingsScope: { global: {}, effective: {} }, history: { items: [], total: 0, revision: 0, nextCursor: null }, annotations: { total: 0, activeCount: 0, revision: 0 }, turns: [], resources: {} }
    },
    async syncProgrammatic(request) {
      calls.push(['programmatic/sync', request])
      return { serviceVersion: 'test', status: { coverage: { programmaticThroughSeq: 5 } }, settingsScope: { global: {}, effective: {} }, history: { items: [{ id: 'p1', historyKind: 'programmatic', fromSeq: 0, toSeq: 5 }], total: 1, revision: 1, nextCursor: null }, annotations: { total: 0, activeCount: 0, revision: 0 }, turns: [{ turn: 0, fromSeq: 0, toSeq: 5 }], resources: {}, latest: { programmatic: { id: 'p1', toSeq: 5 } }, reportSummary: { status: { code: 'complete', label: '已建立索引' }, summary: '程序化索引已建立。' } }
    },
    async readInsight() { calls.push('insight/read'); throw new Error('must not run on first render') },
  }
  registration.component({ useSession: () => ({ nodes: [] }), api, sessionId: 'bounded-session' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['capabilities/read', ['insight/bootstrap', { historyLimit: 80, filters: {} }], ['programmatic/sync', { historyLimit: 80, filters: {} }]])
})

test('capability state rerender does not cancel the bounded bootstrap result', async () => {
  const harness = dependencyLifecycleReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveBootstrap
  const bootstrap = new Promise(resolve => { resolveBootstrap = resolve })
  const calls = []
  const api = {
    async readCapabilities() { calls.push('capabilities/read'); return { endpoints: ['insight/bootstrap'] } },
    async readBootstrap() { calls.push('insight/bootstrap'); return bootstrap },
    async readInsight() { calls.push('insight/read'); throw new Error('must not enter legacy mode') },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'lifecycle-session' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  harness.render(registration.component, props)
  resolveBootstrap(boundedBootstrap([]))
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  assert.doesNotMatch(treeText(tree), /正在读取轻量状态/)
  assert.match(treeText(tree), /测试摘要/)
  assert.deepEqual(calls, ['capabilities/read', 'insight/bootstrap'])
  harness.unmount()
})

test('a newer live Seq during bootstrap triggers programmatic sync without cancelling initialization', async () => {
  const harness = dependencyLifecycleReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveBootstrap
  const bootstrap = new Promise(resolve => { resolveBootstrap = resolve })
  const calls = []
  const api = {
    async readCapabilities() { calls.push('capabilities/read'); return { endpoints: ['insight/bootstrap', 'programmatic/sync'] } },
    async readBootstrap() { calls.push('insight/bootstrap'); return bootstrap },
    async syncProgrammatic() {
      calls.push('programmatic/sync')
      const value = boundedBootstrap([])
      value.status.coverage = { observedThroughSeq: 21, programmaticThroughSeq: 21 }
      value.latest = { programmatic: { id: 'programmatic-21', toSeq: 21 } }
      value.report.summary = '已同步到 Seq 21'
      return value
    },
    async readInsight() { calls.push('insight/read'); throw new Error('must not enter legacy mode') },
  }
  let seq = 20
  const props = { useSession: () => ({ nodes: [{ seq }] }), api, sessionId: 'live-seq-session' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  harness.render(registration.component, props)
  seq = 21
  harness.render(registration.component, props)
  resolveBootstrap({
    ...boundedBootstrap([]),
    status: { coverage: { observedThroughSeq: 20, programmaticThroughSeq: 20 } },
    latest: { programmatic: { id: 'programmatic-20', toSeq: 20 } },
  })
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  assert.doesNotMatch(treeText(tree), /正在读取轻量状态/)
  assert.match(treeText(tree), /已同步到 Seq 21/)
  assert.deepEqual(calls, ['capabilities/read', 'insight/bootstrap', 'programmatic/sync'])
  harness.unmount()
})

test('a stale analyzer checkpoint triggers programmatic sync without new Seq events', async () => {
  const harness = dependencyLifecycleReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const calls = []
  const api = {
    async readCapabilities() { calls.push('capabilities/read'); return { endpoints: ['insight/bootstrap', 'programmatic/sync'] } },
    async readBootstrap() {
      calls.push('insight/bootstrap')
      return {
        ...boundedBootstrap([]),
        analyzerVersion: '0.3.4',
        status: { coverage: { observedThroughSeq: 20, programmaticThroughSeq: 20 } },
        latest: { programmatic: { id: 'programmatic-20', toSeq: 20, analyzerVersion: '0.3.3' } },
      }
    },
    async syncProgrammatic() {
      calls.push('programmatic/sync')
      return {
        ...boundedBootstrap([]),
        analyzerVersion: '0.3.4',
        status: { coverage: { observedThroughSeq: 20, programmaticThroughSeq: 20 } },
        latest: { programmatic: { id: 'programmatic-20', toSeq: 20, analyzerVersion: '0.3.4' } },
        reportSummary: { status: { code: 'complete', label: '已重新索引' }, summary: '旧分析器记录已更新。' },
        report: { status: { code: 'complete', label: '已重新索引' }, summary: '旧分析器记录已更新。' },
      }
    },
    async readInsight() { calls.push('insight/read'); throw new Error('must not enter legacy mode') },
  }
  harness.render(registration.component, { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'stale-analyzer-session' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['capabilities/read', 'insight/bootstrap', 'programmatic/sync'])
  harness.unmount()
})

test('a delayed legacy read cannot overwrite a newer Session initialization', async () => {
  const harness = dependencyLifecycleReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveSessionA
  const sessionAResult = new Promise(resolve => { resolveSessionA = resolve })
  const calls = []
  const legacyResult = summary => {
    const value = boundedBootstrap([])
    value.serviceVersion = 'legacy'
    value.report.summary = summary
    return value
  }
  const apiA = {
    async readCapabilities() { calls.push('A:capabilities/read'); return { legacy: true, endpoints: [] } },
    async readInsight() { calls.push('A:insight/read'); return sessionAResult },
  }
  const apiB = {
    async readCapabilities() { calls.push('B:capabilities/read'); return { legacy: true, endpoints: [] } },
    async readInsight() { calls.push('B:insight/read'); return legacyResult('SESSION_B_RESULT') },
  }
  const propsA = { useSession: () => ({ nodes: [] }), api: apiA, sessionId: 'legacy-session-a' }
  const propsB = { useSession: () => ({ nodes: [] }), api: apiB, sessionId: 'legacy-session-b' }
  harness.render(registration.component, propsA)
  await new Promise(resolve => setImmediate(resolve))
  harness.render(registration.component, propsA)
  harness.render(registration.component, propsB)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, propsB)
  assert.match(treeText(tree), /SESSION_B_RESULT/)
  resolveSessionA(legacyResult('SESSION_A_RESULT'))
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, propsB)
  assert.match(treeText(tree), /SESSION_B_RESULT/)
  assert.doesNotMatch(treeText(tree), /SESSION_A_RESULT/)
  assert.deepEqual(calls, ['A:capabilities/read', 'A:insight/read', 'B:capabilities/read', 'B:insight/read'])
  harness.unmount()
})

test('indexed new Host bootstrap stays read-only and skips programmatic sync', async () => {
  const reactHarness = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useCallback(fn) { return fn }, useMemo(fn) { return fn() }, useRef(initial) { return { current: initial } },
    useState(initial) { return [initial, () => {}] },
    useEffect(fn) { if (String(fn).includes('api.readCapabilities().then')) fn() },
    Fragment: Symbol('Fragment'),
  }
  const plugin = await loadBundle(reactHarness)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const calls = []
  const api = {
    async readCapabilities() { calls.push('capabilities/read'); return { endpoints: ['insight/bootstrap', 'programmatic/sync'] } },
    async readBootstrap() { calls.push('insight/bootstrap'); return { status: { coverage: { programmaticThroughSeq: 9 } }, latest: { programmatic: { id: 'p1' } }, turns: [{ turn: 1 }], settingsScope: { effective: {} }, history: { items: [], total: 0, revision: 1 }, annotations: {}, resources: {} } },
    async syncProgrammatic() { calls.push('programmatic/sync'); throw new Error('indexed bootstrap must not sync') },
    async readInsight() { calls.push('insight/read'); throw new Error('must not read full history') },
  }
  registration.component({ useSession: () => ({ nodes: [] }), api, sessionId: 'indexed-session' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['capabilities/read', 'insight/bootstrap'])
})

test('new Host explicitly syncs a persisted index that trails the current session snapshot', async () => {
  const reactHarness = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useCallback(fn) { return fn }, useMemo(fn) { return fn() }, useRef(initial) { return { current: initial } },
    useState(initial) { return [initial, () => {}] },
    useEffect(fn) { if (String(fn).includes('api.readCapabilities().then')) fn() },
    Fragment: Symbol('Fragment'),
  }
  const plugin = await loadBundle(reactHarness)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const calls = []
  const api = {
    async readCapabilities() { calls.push('capabilities/read'); return { features: { nonFullBootstrap: true, explicitProgrammaticSync: true }, endpoints: ['insight/bootstrap', 'programmatic/sync'] } },
    async readBootstrap() { calls.push('insight/bootstrap'); return { status: { coverage: { observedThroughSeq: 100, programmaticThroughSeq: 100 } }, latest: { programmatic: { id: 'p1' } }, turns: [{ turn: 1 }], settingsScope: { effective: {} }, history: { items: [], total: 0, revision: 1 }, annotations: {}, resources: {} } },
    async syncProgrammatic() { calls.push('programmatic/sync'); return { status: { coverage: { observedThroughSeq: 1000, programmaticThroughSeq: 999 } }, latest: { programmatic: { id: 'p2' } }, turns: [{ turn: 2 }], settingsScope: { effective: {} }, history: { items: [], total: 0, revision: 2 }, annotations: {}, resources: {} } },
    async readInsight() { calls.push('insight/read'); throw new Error('must not read full history') },
  }
  registration.component({ useSession: () => ({ nodes: [{ seq: 1000 }] }), api, sessionId: 'stale-index-session' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['capabilities/read', 'insight/bootstrap', 'programmatic/sync'])
})

test('a slow evidence response cannot overwrite a newer drawer selection', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveSlowEvidence
  const slowEvidence = new Promise(resolve => { resolveSlowEvidence = resolve })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'evidence/read'] } },
    async readBootstrap() {
      return boundedBootstrap([
        { id: 'run-a', historyKind: 'semantic', status: 'succeeded', fromSeq: 0, toSeq: 9, route: { provider: 'p', model: 'a' }, output: { verdict: 'A', evidenceRefs: [{ seq: 4 }] } },
        { id: 'run-b', historyKind: 'semantic', status: 'succeeded', fromSeq: 10, toSeq: 20, route: { provider: 'p', model: 'b' }, output: { verdict: 'B', evidenceRefs: [{ seq: 14 }] } },
      ])
    },
    async readEvidence(request) {
      if (request.runId === 'run-a') return slowEvidence
      return { verified: true, events: [{ seq: 14, text: 'B_CONTEXT_ONLY' }] }
    },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'evidence-race' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  const timeline = harness.render(registration.component, props)
  const semanticEntries = findTreeNodes(timeline, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
  const evidenceButtons = new Map(semanticEntries.map(entry => [
    entry.props.item.id,
    findTreeNodes(entry.type(entry.props), node => node.type === 'button' && treeText(node).startsWith('查看证据'))[0],
  ]))
  assert.equal(evidenceButtons.size, 2)
  evidenceButtons.get('run-a').props.onClick()
  let drawer = harness.render(registration.component, props)
  let drawerNode = findTreeNodes(drawer, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
  let renderedDrawer = drawerNode.type(drawerNode.props)
  let rawButton = findTreeNodes(renderedDrawer, node => node.type === 'button' && treeText(node) === '查看原文')[0]
  const slowRequest = rawButton.props.onClick()
  drawerNode.props.onClose()
  evidenceButtons.get('run-b').props.onClick()
  drawer = harness.render(registration.component, props)
  drawerNode = findTreeNodes(drawer, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
  renderedDrawer = drawerNode.type(drawerNode.props)
  rawButton = findTreeNodes(renderedDrawer, node => node.type === 'button' && treeText(node) === '查看原文')[0]
  const fastRequest = rawButton.props.onClick()
  await fastRequest
  let settled = harness.render(registration.component, props)
  let settledDrawer = findTreeNodes(settled, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
  assert.equal(settledDrawer.props.selection.context.events[0].text, 'B_CONTEXT_ONLY')
  resolveSlowEvidence({ verified: true, events: [{ seq: 4, text: 'A_CONTEXT_MUST_NOT_APPEAR' }] })
  await slowRequest
  settled = harness.render(registration.component, props)
  settledDrawer = findTreeNodes(settled, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
  assert.equal(settledDrawer.props.selection.context.events[0].text, 'B_CONTEXT_ONLY')
})

test('raw event context stays subordinate to the evidence item that explicitly opens it', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const evidenceRequests = []
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'evidence/read'] } },
    async readBootstrap() {
      return boundedBootstrap([{ id: 'run-with-two-refs', historyKind: 'semantic', status: 'succeeded', fromSeq: 10, toSeq: 30, route: { provider: 'p', model: 'm' }, output: { verdict: 'two refs', evidenceRefs: [{ seq: 14, excerpt: 'first' }, { seq: 24, excerpt: 'second' }] } }])
    },
    async readEvidence(request) {
      evidenceRequests.push(request)
      return request.evidenceIndex === 1
        ? { verified: true, events: [
          { seq: 23, type: 'assistant/message', text: 'BEFORE_CONTEXT' },
          { seq: 24, type: 'tool/call', text: 'RAW_CONTEXT' },
          { seq: 25, type: 'tool/result', text: 'AFTER_CONTEXT' },
        ] }
        : { verified: true, events: [{ seq: 14, text: 'RAW_CONTEXT' }] }
    },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 30 }] }), api, sessionId: 'evidence-hierarchy' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const semanticEntry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')[0]
  const openDrawer = findTreeNodes(semanticEntry.type(semanticEntry.props), node => node.type === 'button' && treeText(node).startsWith('查看证据'))[0]
  await openDrawer.props.onClick()
  assert.deepEqual(evidenceRequests, [], 'opening the drawer must not fetch or inject the first raw context')

  tree = harness.render(registration.component, props)
  let drawerNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
  let drawer = drawerNode.type(drawerNode.props)
  assert.doesNotMatch(treeText(drawer), /原始事件窗口/)
  const rawButtons = findTreeNodes(drawer, node => node.type === 'button' && treeText(node) === '查看原文')
  assert.equal(rawButtons.length, 2)
  await rawButtons[1].props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(evidenceRequests)), [{ runId: 'run-with-two-refs', evidenceIndex: 1, before: 2, after: 2 }])

  tree = harness.render(registration.component, props)
  drawerNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
  drawer = drawerNode.type(drawerNode.props)
  assert.match(treeText(drawer), /原始事件前后文 · 引用位置已定位/)
  assert.match(treeText(drawer), /RAW_CONTEXT/)
  const contextEvents = findTreeNodes(drawer, node => String(node.props?.className || '').split(/\s+/).includes('tiEvidenceContextEvent'))
  assert.equal(contextEvents.length, 3)
  assert.deepEqual(contextEvents.map(node => treeText(node).match(/Seq (\d+)/)?.[1]), ['23', '24', '25'])
  assert.doesNotMatch(contextEvents[0].props.className, /--current/)
  assert.match(contextEvents[1].props.className, /--current/)
  assert.match(treeText(contextEvents[1]), /当前引用/)
  assert.doesNotMatch(contextEvents[2].props.className, /--current/)
})

test('switching evidence items reuses previously loaded raw context without another request', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const evidenceRequests = []
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'evidence/read'] } },
    async readBootstrap() {
      return boundedBootstrap([{ id: 'run-cache', historyKind: 'semantic', status: 'succeeded', fromSeq: 10, toSeq: 30, route: { provider: 'p', model: 'm' }, output: { verdict: 'cache', evidenceRefs: [{ seq: 14, excerpt: 'first' }, { seq: 24, excerpt: 'second' }] } }])
    },
    async readEvidence(request) {
      evidenceRequests.push(request)
      return { verified: true, events: [{ seq: request.evidenceIndex === 0 ? 14 : 24, text: request.evidenceIndex === 0 ? 'FIRST_CONTEXT' : 'SECOND_CONTEXT' }] }
    },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 30 }] }), api, sessionId: 'evidence-cache' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const semanticEntry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')[0]
  findTreeNodes(semanticEntry.type(semanticEntry.props), node => node.type === 'button' && treeText(node).startsWith('查看证据'))[0].props.onClick()

  const openContext = async index => {
    tree = harness.render(registration.component, props)
    const drawerNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
    const drawer = drawerNode.type(drawerNode.props)
    const buttons = findTreeNodes(drawer, node => node.type === 'button' && (treeText(node) === '查看原文' || treeText(node) === '收起原文'))
    await buttons[index].props.onClick()
  }

  await openContext(0)
  await openContext(1)
  await openContext(0)
  assert.deepEqual(JSON.parse(JSON.stringify(evidenceRequests)), [
    { runId: 'run-cache', evidenceIndex: 0, before: 2, after: 2 },
    { runId: 'run-cache', evidenceIndex: 1, before: 2, after: 2 },
  ])
  tree = harness.render(registration.component, props)
  const drawerNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'EvidenceDrawer')[0]
  const drawer = drawerNode.type(drawerNode.props)
  assert.match(treeText(drawer), /FIRST_CONTEXT/)
  assert.doesNotMatch(treeText(drawer), /正在读取这条证据的原始前后文/)
})

test('a research member without a precise evidence reference has no empty drawer action', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const evidenceRequests = []
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'evidence/read'] } },
    async readBootstrap() {
      return boundedBootstrap([{ id: 'research-run', historyKind: 'semantic', referenceOnly: true, fromSeq: 10, toSeq: 20 }])
    },
    async readEvidence(request) { evidenceRequests.push(request); return { verified: true, events: [] } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'research-evidence-state' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const referenceNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchReferenceEntry')[0]
  const referenceEntry = referenceNode.type(referenceNode.props)
  assert.match(treeText(referenceEntry), /仅用于汇总统计/)
  assert.equal(findTreeNodes(referenceEntry, node => node.type === 'button' && treeText(node) === '查看说明').length, 0)
  assert.deepEqual(evidenceRequests, [])
})

test('a slow filter page cannot replace a newer cleared-filter result', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveSlowPage
  const slowPage = new Promise(resolve => { resolveSlowPage = resolve })
  const resultItem = (id, verdict) => ({ id, historyKind: 'semantic', status: 'succeeded', fromSeq: 0, toSeq: 20, route: { provider: 'p', model: id }, output: { verdict, evidenceRefs: [] } })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page'] } },
    async readBootstrap() { return boundedBootstrap([resultItem('initial', 'INITIAL_RESULT')]) },
    async readHistoryPage(request) {
      if (request.filters?.query === 'slow-a') return slowPage
      return { items: [resultItem('fast-b', 'FAST_B_RESULT')], total: 1, revision: 3, nextCursor: null }
    },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'filter-race' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const queryInput = findTreeNodes(tree, node => node.type === 'input' && node.props?.placeholder === '结论、工具、模型或原文')[0]
  queryInput.props.onChange({ target: { value: 'slow-a' } })
  tree = harness.render(registration.component, props)
  const applyButton = findTreeNodes(tree, node => node.type === 'button' && treeText(node) === '应用筛选')[0]
  const slowRequest = applyButton.props.onClick()
  tree = harness.render(registration.component, props)
  const clearButton = findTreeNodes(tree, node => node.type === 'button' && treeText(node) === '清除')[0]
  clearButton.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  let resultEntry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')[0]
  assert.equal(resultEntry.props.item.output.verdict, 'FAST_B_RESULT')
  resolveSlowPage({ items: [resultItem('slow-a', 'SLOW_A_MUST_NOT_APPEAR')], total: 1, revision: 2, nextCursor: null })
  await slowRequest
  tree = harness.render(registration.component, props)
  resultEntry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')[0]
  assert.equal(resultEntry.props.item.output.verdict, 'FAST_B_RESULT')
})

test('a status research ref without finding indices never queries a range as if it were evidence', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const evidenceRequests = []
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'evidence/read'] } },
    async readBootstrap() {
      return boundedBootstrap([{ id: 'checkpoint-with-unrelated-first-finding', historyKind: 'programmatic', referenceOnly: true, referenceOrdinal: 0, fromSeq: 40, toSeq: 45, basisRole: 'coverage-status', status: 'blocked' }])
    },
    async readEvidence(request) { evidenceRequests.push(request); return { verified: true, events: [{ seq: 40, text: 'blocked range context' }] } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'status-ref' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  const referenceNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchReferenceEntry')[0]
  const referenceEntry = referenceNode.type(referenceNode.props)
  assert.match(treeText(referenceEntry), /依据：coverage-status/)
  assert.match(treeText(referenceEntry), /状态：blocked/)
  assert.equal(findTreeNodes(referenceEntry, node => node.type === 'button' && treeText(node) === '查看说明').length, 0)
  assert.deepEqual(evidenceRequests, [])
})

test('status polling replaces stale global report/latest and marks resource and research snapshots stale', async () => {
  let statusTick
  const harness = interactiveReactHarness({ runStatusEffects: true, runResearchEffects: true })
  const plugin = await loadBundle(harness.react, {
    setInterval(callback, delay) { if (delay === 15_000) statusTick = callback; return delay },
    clearInterval() {},
  })
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let researchReads = 0
  const oldReport = { id: 'old-checkpoint', status: { code: 'running', label: '旧状态' }, summary: 'OLD_REPORT' }
  const newReport = { id: 'new-checkpoint', status: { code: 'blocked', label: '新阻断' }, summary: 'NEW_REPORT' }
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'insight/status', 'history/delta', 'research/summary'] } },
    async readBootstrap() {
      const value = boundedBootstrap([])
      value.status = { coverage: { observedThroughSeq: 20, programmaticThroughSeq: 20 }, revisions: { history: 1, timeline: 1 }, latest: { semanticSuccess: { id: 'old-run', completedAt: new Date(1_000).toISOString() }, diagnostic: { code: 'OLD_DIAGNOSTIC', operation: 'old', message: 'old diagnostic' }, programmatic: oldReport }, reportSummary: oldReport, autoDecision: { reason: 'quiet-period' } }
      value.latest = value.status.latest
      value.reportSummary = oldReport
      value.report = { status: oldReport.status, summary: oldReport.summary }
      value.resources = { modelCalls: 1, inputChars: 100 }
      return value
    },
    async readStatus() {
      return { coverage: { observedThroughSeq: 30, programmaticThroughSeq: 30 }, revisions: { history: 2, timeline: 2 }, latest: { semanticSuccess: { id: 'new-run', completedAt: new Date(2_000).toISOString() }, diagnostic: { code: 'NEW_DIAGNOSTIC', operation: 'poll', message: 'new diagnostic' }, programmatic: newReport }, reportSummary: newReport, autoDecision: { reason: 'threshold-not-met' }, activeJobs: [] }
    },
    async readHistoryDelta() { return { revision: 2, added: [], updated: [], removed: [] } },
    async readResearchSummary() { researchReads += 1; return { revision: researchReads, dimensions: {}, conflicts: [], drift: [], resources: {} } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'status-freshness' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const researchTab = findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '概览')[0]
  researchTab.props.onClick()
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  await statusTick()
  tree = harness.render(registration.component, props)
  assert.match(treeText(tree), /NEW_REPORT/)
  assert.match(treeText(tree), /NEW_DIAGNOSTIC/)
  assert.doesNotMatch(treeText(tree), /OLD_REPORT/)
  const statusOverview = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'StatusOverview')[0]
  assert.equal(statusOverview.props.data.latest.semanticSuccess.id, 'new-run')
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '设置')[0].props.onClick()
  tree = harness.render(registration.component, props)
  const resourceGrid = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResourceGrid')[0]
  assert.equal(resourceGrid.props.stale, true)
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '概览')[0].props.onClick()
  tree = harness.render(registration.component, props)
  let researchView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0]
  assert.equal(researchView.props.stale, true)
  const researchPanel = researchView.type(researchView.props)
  const refreshButton = findTreeNodes(researchPanel, node => node.type === 'button' && treeText(node) === '刷新概览')[0]
  await refreshButton.props.onClick()
  tree = harness.render(registration.component, props)
  researchView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0]
  assert.equal(researchView.props.stale, false)
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '复盘')[0].props.onClick()
  tree = harness.render(registration.component, props)
  findTreeNodes(tree, node => node.type === 'input' && node.props?.placeholder === '结论、工具、模型或原文')[0].props.onChange({ target: { value: 'new-research-scope' } })
  tree = harness.render(registration.component, props)
  findTreeNodes(tree, node => node.type === 'button' && treeText(node) === '应用筛选')[0].props.onClick()
  tree = harness.render(registration.component, props)
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '概览')[0].props.onClick()
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  researchView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0]
  assert.equal(researchReads, 3)
  assert.equal(researchView.props.summary.revision, 3)
  assert.equal(researchView.props.stale, false)
})

test('changing a comparison pair invalidates an older in-flight comparison', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveSlowComparison
  const slowComparison = new Promise(resolve => { resolveSlowComparison = resolve })
  const run = (id, seq) => ({ id, historyKind: 'semantic', status: 'succeeded', fromSeq: seq, toSeq: seq, route: { provider: 'p', model: id }, inputHash: id, output: { verdict: id, evidenceRefs: [] } })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'compare/read'] } },
    async readBootstrap() { return boundedBootstrap([run('run-a', 1), run('run-b', 2), run('run-c', 3)]) },
    async readComparison() { return slowComparison },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'compare-race' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '对比')[0].props.onClick()
  tree = harness.render(registration.component, props)
  let compareView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'CompareView')[0]
  compareView.props.onLeft('run-a')
  compareView.props.onRight('run-b')
  tree = harness.render(registration.component, props)
  compareView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'CompareView')[0]
  const oldRequest = compareView.props.onCompare()
  compareView.props.onLeft('run-c')
  resolveSlowComparison({ comparable: true, left: run('run-a', 1), right: run('run-b', 2), differences: {} })
  await oldRequest
  tree = harness.render(registration.component, props)
  compareView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'CompareView')[0]
  assert.equal(compareView.props.leftId, 'run-c')
  assert.equal(compareView.props.comparison, null)
  assert.equal(compareView.props.loading, false)
})

test('an older paged run remains selectable after latest comparison candidates load', async () => {
  const harness = interactiveReactHarness({ runCompareEffects: true })
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const run = (id, seq) => ({ id, historyKind: 'semantic', status: 'succeeded', fromSeq: seq, toSeq: seq, route: { provider: 'p', model: id }, inputHash: id, output: { verdict: id, evidenceRefs: [] } })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page', 'compare/read'] } },
    async readBootstrap() { return boundedBootstrap([run('older-paged-run', 1)]) },
    async readHistoryPage() { return { items: [run('latest-candidate', 20)], total: 200, revision: 1, nextCursor: 'more' } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'compare-candidate-merge' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '对比')[0].props.onClick()
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  const compareView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'CompareView')[0]
  assert.deepEqual(Array.from(compareView.props.runs, item => item.id).sort(), ['latest-candidate', 'older-paged-run'])
})

test('timeline-first UI lands on the true latest record, keeps error squares visible, and limits comparison B to the selected range', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const run = (id, fromSeq, toSeq, turn, createdAt, coverageRole = 'primary') => ({ id, historyKind: 'semantic', status: 'succeeded', coverageRole, fromSeq, toSeq, fromTurn: turn, toTurn: turn, createdAt, route: { provider: 'p', model: id }, inputHash: id, output: { verdict: id, evidenceRefs: [] } })
  const checkpoint = {
    id: 'latest-turn-checkpoint', historyKind: 'programmatic', fromSeq: 0, toSeq: 20, fromTurn: 2, toTurn: 2, analyzerVersion: 'test',
    report: { status: { code: 'blocked', label: '受阻' }, summary: '错误汇总', findings: [{ severity: 'high', title: '重复失败', summary: '连续失败两次', evidence: [] }] },
  }
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'compare/read', 'research/summary'] } },
    async readBootstrap() { return boundedBootstrap([
      run('old-same-range', 0, 9, 2, '2026-08-17T01:00:00.000Z'),
      run('latest-same-range', 0, 9, 2, '2026-08-17T02:00:00.000Z', 'supplemental'),
      checkpoint,
      run('different-range', 10, 20, 2, '2026-08-17T03:00:00.000Z'),
    ]) },
    async readResearchSummary() { return { revision: 1, dimensions: { phases: [{ key: 'build', label: '构建', count: 1 }], findings: [
      { key: 'semantic:free-text', label: '一次性完整根因句子', count: 1, layer: 'semantic', preciseRefCount: 0, refs: [{ kind: 'semantic', id: 'semantic-one', rootCauseIndex: 0 }], drilldown: { dimension: 'findings', key: 'semantic:free-text' } },
      { key: 'programmatic:loop', label: '出现 5 步无进展重试循环', count: 2, layer: 'programmatic', preciseRefCount: 2, refs: [{ kind: 'programmatic', id: 'program-one', findingIndex: 0, evidenceIndex: 0 }], drilldown: { dimension: 'findings', key: 'programmatic:loop' } },
    ], tools: [], models: [], triggers: [] }, conflicts: [], drift: [], resources: null } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'timeline-first' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const semanticEntries = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
  assert.deepEqual(semanticEntries.map(node => [node.props.item.id, node.props.compact]), [
    ['different-range', false], ['old-same-range', true],
  ])
  assert.equal(semanticEntries.some(node => node.props.item.coverageRole === 'supplemental'), false)
  const oldPrimaryEntry = semanticEntries.find(node => node.props.item.id === 'old-same-range')
  const oldPrimaryCard = oldPrimaryEntry.type(oldPrimaryEntry.props)
  findTreeNodes(oldPrimaryCard, node => node.type === 'button' && treeText(node) === '换模型重新分析')[0].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  const selectedPrimaryEntry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
    .find(node => node.props.item.id === 'old-same-range')
  assert.ok(selectedPrimaryEntry.props.analysisPanel)
  assert.match(treeText(selectedPrimaryEntry.props.analysisPanel.type(selectedPrimaryEntry.props.analysisPanel.props)), /分析此段/u)
  const programmaticEntry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ProgrammaticEntry')[0]
  assert.equal(programmaticEntry.props.compact, false)
  assert.match(treeText(programmaticEntry.type(programmaticEntry.props)), /高 · 重复失败/)
  const landingFragment = findTreeNodes(tree, node => node.type === harness.react.Fragment
    && node.children?.some(child => child?.props?.className === 'tiLatestAnchor'))[0]
  assert.equal(landingFragment.children[1].type.name, 'SemanticEntry')
  assert.equal(landingFragment.children[1].props.item.id, 'different-range')
  const statusOverview = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'StatusOverview')[0]
  const statusPanel = statusOverview.type(statusOverview.props)
  assert.equal(statusPanel.type, 'details')
  assert.equal(statusPanel.props.open, undefined)

  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '对比')[0].props.onClick()
  tree = harness.render(registration.component, props)
  let compareView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'CompareView')[0]
  compareView.props.onLeft('old-same-range')
  tree = harness.render(registration.component, props)
  compareView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'CompareView')[0]
  const comparePanel = compareView.type(compareView.props)
  const selects = findTreeNodes(comparePanel, node => node.type === 'select')
  assert.deepEqual(selects[1].children.filter(child => child?.type === 'option').map(option => option.props.value), ['', 'latest-same-range'])
  const directComparison = compareView.type({
    ...compareView.props,
    comparison: {
      comparable: true,
      left: {
        id: 'old-same-range', range: { fromSeq: 0, toSeq: 9 }, route: { provider: 'p', model: 'model-a' },
        risk: 'low', verdict: '继续执行', narrative: '运行 A 执行经过', assessment: '运行 A 总体判断',
        rootCauses: ['未发现阻断'], nextSteps: ['完成检查'], lessons: ['保留证据'], evidenceRefs: [{ seq: 3 }],
      },
      right: {
        id: 'latest-same-range', range: { fromSeq: 0, toSeq: 9 }, route: { provider: 'p', model: 'model-b' },
        risk: 'high', verdict: '暂停执行', narrative: '运行 B 执行经过', assessment: '运行 B 总体判断',
        rootCauses: ['存在高风险操作'], nextSteps: ['先核验证据'], lessons: ['先做验证'], evidenceRefs: [{ seq: 4 }, { seq: 5 }],
      },
      differences: { verdict: { changed: true }, rootCauses: { changed: true }, nextSteps: { changed: true } },
      conflict: { assessable: true, detected: true },
      drift: { assessable: false, detected: null },
    },
  })
  const comparisonRiskBadges = findTreeNodes(directComparison, node => String(node.props?.className || '').includes('tiBadge--risk-'))
  assert.deepEqual(comparisonRiskBadges.map(treeText), ['低风险', '高风险'])
  assert.doesNotMatch(treeText(directComparison), /有差异|冲突提示|漂移提示/u)
  assert.match(treeText(directComparison), /结论继续执行执行经过运行 A 执行经过总体判断运行 A 总体判断/u)
  assert.match(treeText(directComparison), /可复用经验保留证据/u)
  assert.doesNotMatch(treeText(directComparison), /裁决/u)
  assert.ok(findTreeNodes(directComparison, node => node.props?.className === 'tiCompareField').length > 0)

  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '概览')[0].props.onClick()
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  const summaryView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0]
  const overviewSummary = await api.readResearchSummary()
  const overviewPanel = summaryView.type({
    ...summaryView.props,
    summary: {
      ...overviewSummary,
      conflicts: [{ summary: '不应显示的冲突候选', inference: true }],
      drift: [{ summary: '不应显示的漂移候选', inference: true }],
      dimensions: {
        ...overviewSummary.dimensions,
        models: [{ key: 'provider/model', label: 'provider/model', count: 1, drilldown: { dimension: 'models', key: 'provider/model' } }],
      },
    },
    members: {
      items: [{ id: 'problem-member', historyKind: 'programmatic', fromSeq: 33, toSeq: 44 }],
      total: 1,
      label: '添加工作区',
      drilldown: { dimension: 'findings', key: 'programmatic:workspace' },
    },
  })
  assert.match(treeText(overviewPanel), /问题汇总.*一次性完整根因句子.*模型根因/s)
  assert.match(treeText(overviewPanel), /出现 5 步无进展重试循环.*规则发现 · 共 2 条/s)
  assert.doesNotMatch(treeText(overviewPanel), /一次性完整根因句子\s*·\s*1/u)
  const findingCards = findTreeNodes(overviewPanel, node => String(node.props?.className || '').includes('tiBucket'))
  assert.equal(findingCards.find(node => /一次性完整根因句子/.test(treeText(node))).type, 'div')
  assert.equal(findingCards.find(node => /出现 5 步无进展重试循环/.test(treeText(node))).type, 'button')
  assert.doesNotMatch(treeText(overviewPanel), /冲突候选|漂移候选|不应显示/u)
  const researchBody = findTreeNodes(overviewPanel, node => node.props?.className === 'tiResearch')[0]
  const visibleSections = researchBody.children.filter(Boolean)
  const problemIndex = visibleSections.findIndex(node => node.type === 'details' && /tiResearchSection--collapsible/.test(node.props?.className || '') && /问题汇总/.test(treeText(node.children?.[0])))
  const memberIndex = visibleSections.findIndex(node => /tiResearchMembers/.test(node.props?.className || ''))
  assert.ok(problemIndex >= 0)
  assert.equal(memberIndex, -1)
  const runtimeSummary = visibleSections.find(node => node.type === 'details' && /tiResearchRuntime/.test(node.props?.className || ''))
  assert.ok(runtimeSummary)
  assert.match(runtimeSummary.props.className, /tiResearchSection--collapsible/)
  assert.match(treeText(runtimeSummary.children?.[0]), /运行信息.*模型、触发来源与资源用量/s)
  const problemSummaryNode = visibleSections[problemIndex]
  assert.equal(problemSummaryNode.type, 'details')
  assert.match(problemSummaryNode.props.className, /tiResearchSection--collapsible/)
  assert.equal(problemSummaryNode.props.open, undefined)
  assert.doesNotMatch(treeText(overviewPanel), /这些记录没有保存可定位的证据|空白成员卡片/u)
})

test('programmatic cards separate turn outcome from tool results and show real details without implying missing model coverage', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const checkpoint = {
    id: 'programmatic-rich', historyKind: 'programmatic', fromSeq: 10, toSeq: 20, fromTurn: 2, toTurn: 2, analyzerVersion: '0.3.3',
    report: {
      status: { code: 'failed', label: '失败' }, summary: '本次运行失败：1 次工具调用中 0 次失败。',
      metrics: { toolCalls: 1, failedTools: 0, durationMs: 48_000, usage: { input: 100, output: 20 } },
      userGoal: '让两个面板切换时保持稳定',
      phases: [{ title: '调用辅助工具', summary: '调用 call:call_00_internal、edit 共 1 次，未记录失败', seqStart: 12, seqEnd: 18, status: 'completed', tools: ['call:call_00_internal', 'edit'] }],
      strategy: '调用辅助工具', finalAnswer: '完成了布局调整。',
      lessons: [{ id: 'verify', title: '验证优先', text: '交付前核对真实界面。' }],
      limitations: ['程序化规则不会调用模型。'], findings: [],
    },
  }
  const bootstrap = boundedBootstrap([checkpoint])
  bootstrap.status.coverage.semanticThroughSeq = 20
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap'] } },
    async readBootstrap() { return bootstrap },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'programmatic-detail' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  const entry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ProgrammaticEntry')[0]
  const text = treeText(entry.type(entry.props))
  assert.match(text, /轮次失败/)
  assert.match(text, /工具调用 1 次.*工具失败 0 次/)
  assert.match(text, /本段已完成正式模型分析/)
  assert.match(text, /重新分析/)
  assert.match(text, /查看规则分析详情/)
  assert.match(text, /用户目标.*让两个面板切换时保持稳定/s)
  assert.match(text, /执行阶段.*未识别工具、edit/s)
  assert.match(text, /最后输出摘录.*完成了布局调整/s)
  assert.doesNotMatch(text, /选择此段换模分析/)
  assert.doesNotMatch(text, /call:call_00_internal/)
  assert.equal((text.match(/本次运行失败：1 次工具调用中 0 次失败。/g) || []).length, 0)
})

test('semantic cards display the existing aggregate risk without inventing a value for legacy output', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const run = (id, fromSeq, toSeq, risk) => ({
    id, historyKind: 'semantic', status: 'succeeded', coverageRole: 'primary',
    fromSeq, toSeq, fromTurn: 1, toTurn: 1, createdAt: new Date(toSeq * 1_000).toISOString(),
    route: { provider: 'p', model: 'm' }, inputHash: id,
    output: { verdict: id, narrative: `${id} narrative`, assessment: `${id} assessment`, evidenceRefs: [{ seq: fromSeq }], ...(risk ? { risk } : {}) },
  })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap'] } },
    async readBootstrap() { return boundedBootstrap([
      run('risk-high', 0, 4, 'high'),
      run('risk-medium', 5, 9, 'medium'),
      run('risk-low', 10, 14, 'low'),
      run('legacy-without-risk', 15, 19),
    ]) },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'semantic-risk-labels' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  const entries = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
  const textById = new Map(entries.map(node => [node.props.item.id, treeText(node.type(node.props))]))
  assert.match(textById.get('risk-high'), /高风险/)
  assert.match(textById.get('risk-medium'), /中风险/)
  assert.match(textById.get('risk-low'), /低风险/)
  assert.doesNotMatch(textById.get('legacy-without-risk'), /高风险|中风险|低风险/)
  assert.doesNotMatch([...textById.values()].join('\n'), /模型总体风险|风险置信度/)
})

test('analyze-segment stays in review and opens a confirmation on its source card', async () => {
  const harness = interactiveReactHarness({ runSegmentEffects: true })
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const checkpoint = {
    id: 'segment-source', historyKind: 'programmatic', fromSeq: 0, toSeq: 20, fromTurn: 1, toTurn: 1, route: { provider: 'p', model: 'm' },
    report: { status: { code: 'partial', label: '未得出明确结论' }, findings: [], phases: [] },
  }
  const bootstrap = boundedBootstrap([checkpoint])
  bootstrap.status.coverage = { observedThroughSeq: 20, programmaticThroughSeq: 20, closedThroughSeq: 20, semanticThroughSeq: -1 }
  bootstrap.settingsScope = { global: { defaultRoute: { provider: 'p', model: 'm' } }, effective: { defaultRoute: { provider: 'p', model: 'm' } } }
  bootstrap.catalog = { models: [{ provider: 'p', providerName: 'P', model: 'm', modelName: 'M' }] }
  let previewCalls = 0
  let startCalls = 0
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page', 'analysis/preview', 'analysis/start', 'analysis/job', 'analysis/cancel'] } },
    async readBootstrap() { return bootstrap },
    async previewAnalysis() { previewCalls += 1; return { previewToken: 'preview-one', totalSegments: 1, modelCalls: 1, estimatedInputChars: 1200, budgetAssessment: { hardLimitExceeded: false } } },
    async startAnalysis(request) { startCalls += 1; return { jobId: 'job-one', status: 'succeeded', revision: 2, job: { id: 'job-one', status: 'succeeded', revision: 2, mode: request.mode, fromSeq: request.fromSeq, toSeq: request.toSeq, totalSegments: 1, completedSegments: 1 } } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'segment-inline' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  let entry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ProgrammaticEntry')[0]
  findTreeNodes(entry.type(entry.props), node => node.type === 'button' && treeText(node) === '分析此段')[0].props.onClick()
  tree = harness.render(registration.component, props)
  const activeTab = findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && node.props?.['aria-selected'] === true)[0]
  assert.equal(treeText(activeTab), '复盘')
  entry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ProgrammaticEntry')[0]
  const renderedEntry = entry.type(entry.props)
  let panel = findTreeNodes(renderedEntry, node => typeof node.type === 'function' && node.type.name === 'SegmentAnalysisPanel')[0]
  assert.match(treeText(panel.type(panel.props)), /分析此段.*Seq 0–20.*开始分析/s)
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  entry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ProgrammaticEntry')[0]
  panel = findTreeNodes(entry.type(entry.props), node => typeof node.type === 'function' && node.type.name === 'SegmentAnalysisPanel')[0]
  const panelTree = panel.type(panel.props)
  assert.equal(previewCalls, 1)
  assert.match(treeText(panelTree), /1 段.*1 次模型调用.*确认后才会调用模型/s)
  await findTreeNodes(panelTree, node => node.type === 'button' && treeText(node) === '开始分析')[0].props.onClick()
  assert.equal(startCalls, 1)
  tree = harness.render(registration.component, props)
  assert.equal(treeText(findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && node.props?.['aria-selected'] === true)[0]), '复盘')
  tree = harness.render(registration.component, props)
  entry = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ProgrammaticEntry')[0]
  assert.equal(findTreeNodes(entry.type(entry.props), node => typeof node.type === 'function' && node.type.name === 'SegmentAnalysisPanel').length, 0)
})

test('diagnostic and supplemental records stay out of formal review while an active storage alert stays compact', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const range = { fromSeq: 0, toSeq: 20, fromTurn: 1, toTurn: 1 }
  const checkpoint = { id: 'source', historyKind: 'programmatic', ...range, report: { status: { code: 'complete', label: '完成' }, findings: [], phases: [] } }
  const run = { id: 'result', historyKind: 'semantic', status: 'succeeded', coverageRole: 'supplemental', trigger: 'manual-supplemental-compare', jobId: 'job-one', ...range, route: { provider: 'p', model: 'm' }, output: { verdict: '补充结论', evidenceRefs: [] } }
  const job = { id: 'job-one', historyKind: 'job', kind: 'manual-analysis', status: 'succeeded', coverageRole: 'supplemental', fromSeq: 0, toSeq: 20, completedSegments: 1, totalSegments: 1 }
  const diagnostic = { id: 'old-error', historyKind: 'diagnostic', kind: 'service-error', code: 'EPERM', operation: 'turn-observation', message: "EPERM: rename 'C:\\private\\session.tmp' -> 'C:\\private\\session.json'", at: new Date(0).toISOString() }
  const bootstrap = boundedBootstrap([checkpoint, run, job, diagnostic])
  bootstrap.status.latest = { diagnostic }
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page'] } },
    async readBootstrap() { return bootstrap },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'job-folding' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  assert.equal(findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'GenericHistoryEntry').length, 0)
  assert.deepEqual(findTreeNodes(tree, node => typeof node.type === 'function' && ['ProgrammaticEntry', 'SemanticEntry'].includes(node.type.name)).map(node => node.type.name), ['ProgrammaticEntry'])
  assert.match(treeText(tree), /后台保存暂时失败（EPERM）.*下一次成功保存后自动清除/s)
  assert.doesNotMatch(treeText(tree), /C:\\private\\session/)
})

test('a slow research bucket cannot replace a newer exact drilldown', async () => {
  const harness = interactiveReactHarness({ runResearchEffects: true })
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveSlowMembers
  const slowMembers = new Promise(resolve => { resolveSlowMembers = resolve })
  const bucket = key => ({ key, label: key, count: 1, preciseRefCount: 1, drilldown: { endpoint: 'research/members', dimension: 'tools', key, filters: {} } })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page', 'research/summary', 'research/members'] } },
    async readBootstrap() { return boundedBootstrap([]) },
    async readResearchSummary() { return { revision: 1, dimensions: { tools: [bucket('slow-x'), bucket('fast-y')] }, conflicts: [], drift: [], resources: {} } },
    async readResearchMembers(request) {
      if (request.key === 'slow-x') return slowMembers
      return { items: [{ id: 'member-y', kind: 'programmatic', fromSeq: 10, toSeq: 10, findingIndex: 0, evidenceIndex: 0 }], total: 1, revision: 1, nextCursor: null }
    },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'research-race' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '概览')[0].props.onClick()
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  const researchView = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0]
  const researchPanel = researchView.type(researchView.props)
  const buckets = findTreeNodes(researchPanel, node => node.type === 'button' && node.props?.className === 'tiBucket')
  const oldRequest = buckets[0].props.onClick()
  await buckets[1].props.onClick()
  resolveSlowMembers({ items: [{ id: 'member-x', kind: 'programmatic', fromSeq: 1, toSeq: 1, findingIndex: 0, evidenceIndex: 0 }], total: 1, revision: 1, nextCursor: null })
  await oldRequest
  tree = harness.render(registration.component, props)
  const currentOverview = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0]
  const reference = findTreeNodes(currentOverview.type(currentOverview.props), node => typeof node.type === 'function' && node.type.name === 'ResearchReferenceEntry')[0]
  assert.equal(reference.props.item.id, 'member-y')
  assert.ok(findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0], 'member drilldown stays in the overview')
})

test('opening an overview member never replaces the review timeline, filters, or total', async () => {
  const harness = interactiveReactHarness({ runResearchEffects: true })
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const original = { id: 'original-review', historyKind: 'semantic', status: 'succeeded', fromSeq: 1, toSeq: 20, route: { provider: 'p', model: 'm' }, output: { verdict: 'ORIGINAL_REVIEW', evidenceRefs: [] } }
  const bucket = { key: 'issue', label: '问题', count: 1, layer: 'programmatic', preciseRefCount: 1, drilldown: { endpoint: 'research/members', dimension: 'findings', key: 'issue', filters: { layers: ['programmatic'] } } }
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page', 'research/summary', 'research/members', 'evidence/read'] } },
    async readBootstrap() { const value = boundedBootstrap([original]); value.history.total = 9; return value },
    async readResearchSummary() { return { revision: 1, dimensions: { findings: [bucket] }, conflicts: [], drift: [], resources: null } },
    async readResearchMembers() { return { items: [{ id: 'member-only', kind: 'programmatic', fromSeq: 10, toSeq: 10 }], total: 1, revision: 1, nextCursor: null } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'research-isolation' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '概览')[0].props.onClick()
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(registration.component, props)
  const overview = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0]
  const panel = overview.type(overview.props)
  await findTreeNodes(panel, node => node.type === 'button' && node.props?.className === 'tiBucket')[0].props.onClick()
  tree = harness.render(registration.component, props)
  assert.ok(findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ResearchView')[0])
  findTreeNodes(tree, node => node.type === 'button' && node.props?.role === 'tab' && treeText(node) === '复盘')[0].props.onClick()
  tree = harness.render(registration.component, props)
  const semantic = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')[0]
  assert.equal(semantic.props.item.id, 'original-review')
  assert.match(treeText(tree), /当前显示 1 条分析记录/)
})

test('a slow earlier-page request cannot merge into a newer filter result', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveOldPage
  const oldPage = new Promise(resolve => { resolveOldPage = resolve })
  const item = id => ({ id, historyKind: 'semantic', status: 'succeeded', fromSeq: 0, toSeq: 20, route: { provider: 'p', model: id }, output: { verdict: id, evidenceRefs: [] } })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page'] } },
    async readBootstrap() { const value = boundedBootstrap([item('initial')]); value.history = { items: [item('initial')], total: 2, revision: 1, nextCursor: 'old-cursor' }; return value },
    async readHistoryPage(request) {
      if (request.cursor === 'old-cursor') return oldPage
      return { items: [item('filtered-new')], total: 1, revision: 2, nextCursor: null }
    },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'timeline-generation' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const moreButton = findTreeNodes(tree, node => node.type === 'button' && treeText(node).startsWith('加载更早记录'))[0]
  const oldRequest = moreButton.props.onClick()
  const queryInput = findTreeNodes(tree, node => node.type === 'input' && node.props?.placeholder === '结论、工具、模型或原文')[0]
  queryInput.props.onChange({ target: { value: 'new-filter' } })
  tree = harness.render(registration.component, props)
  await findTreeNodes(tree, node => node.type === 'button' && treeText(node) === '应用筛选')[0].props.onClick()
  resolveOldPage({ items: [item('old-page-must-not-merge')], total: 2, revision: 1, nextCursor: null })
  await oldRequest
  tree = harness.render(registration.component, props)
  const entries = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
  assert.deepEqual(entries.map(entry => entry.props.item.id), ['filtered-new'])
})

test('sorting during an in-flight earlier-page load stays local and applies after the page merges', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveEarlierPage
  const earlierPage = new Promise(resolve => { resolveEarlierPage = resolve })
  const pageCalls = []
  const item = (id, turn, seq) => ({ id, historyKind: 'semantic', status: 'succeeded', fromTurn: turn, toTurn: turn, fromSeq: seq, toSeq: seq, route: { provider: 'p', model: id }, output: { verdict: id, evidenceRefs: [] } })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'history/page'] } },
    async readBootstrap() {
      const value = boundedBootstrap([item('t2-s2', 2, 2)])
      value.history = { items: [item('t2-s2', 2, 2)], total: 2, revision: 1, nextCursor: 'earlier' }
      return value
    },
    async readHistoryPage(request) { pageCalls.push(request); return earlierPage },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 2 }] }), api, sessionId: 'sort-during-history-more' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const moreRequest = findTreeNodes(tree, node => node.type === 'button' && treeText(node).startsWith('加载更早记录'))[0].props.onClick()
  tree = harness.render(registration.component, props)
  const selectInLabel = label => {
    const field = findTreeNodes(tree, node => node.type === 'label' && treeText(node).startsWith(label))[0]
    return findTreeNodes(field, node => node.type === 'select')[0]
  }
  selectInLabel('Turn 顺序').props.onChange({ target: { value: 'asc' } })
  tree = harness.render(registration.component, props)
  const withinField = findTreeNodes(tree, node => node.type === 'label' && treeText(node).startsWith('Turn 内顺序'))[0]
  findTreeNodes(withinField, node => node.type === 'select')[0].props.onChange({ target: { value: 'asc' } })
  tree = harness.render(registration.component, props)
  await findTreeNodes(tree, node => node.type === 'button' && treeText(node) === '应用筛选')[0].props.onClick()
  assert.equal(pageCalls.length, 1, 'sorting does not start a second history page request while load-more is pending')
  assert.equal(pageCalls[0].cursor, 'earlier')

  resolveEarlierPage({ items: [item('t1-s1', 1, 1)], total: 2, revision: 2, nextCursor: null })
  await moreRequest
  tree = harness.render(registration.component, props)
  const entries = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
  assert.deepEqual(entries.map(entry => entry.props.item.id), ['t1-s1', 't2-s2'])
  assert.match(treeText(tree), /Turn 正序 · Turn 内正序/)
})

test('a slow delta for an old filter cannot contaminate a newer filter page', async () => {
  let statusTick
  const harness = interactiveReactHarness({ runStatusEffects: true })
  const plugin = await loadBundle(harness.react, {
    setInterval(callback, delay) { if (delay === 15_000) statusTick = callback; return delay },
    clearInterval() {},
  })
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let resolveOldDelta
  const oldDelta = new Promise(resolve => { resolveOldDelta = resolve })
  const item = id => ({ id, historyKind: 'semantic', status: 'succeeded', fromSeq: 0, toSeq: 20, route: { provider: 'p', model: id }, output: { verdict: id, evidenceRefs: [] } })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'insight/status', 'history/page', 'history/delta'] } },
    async readBootstrap() { const value = boundedBootstrap([item('initial')]); value.status.revisions = { history: 1, timeline: 1 }; return value },
    async readStatus() { return { coverage: { observedThroughSeq: 21, programmaticThroughSeq: 21 }, revisions: { history: 2, timeline: 2 }, latest: {}, reportSummary: null, autoDecision: {}, activeJobs: [] } },
    async readHistoryDelta() { return oldDelta },
    async readHistoryPage() { return { items: [item('new-filter-page')], total: 1, revision: 3, nextCursor: null } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'delta-filter-race' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(registration.component, props)
  const oldStatusRequest = statusTick()
  await new Promise(resolve => setImmediate(resolve))
  findTreeNodes(tree, node => node.type === 'input' && node.props?.placeholder === '结论、工具、模型或原文')[0].props.onChange({ target: { value: 'new-filter' } })
  tree = harness.render(registration.component, props)
  await findTreeNodes(tree, node => node.type === 'button' && treeText(node) === '应用筛选')[0].props.onClick()
  resolveOldDelta({ revision: 2, added: [item('old-delta-must-not-merge')], updated: [], removed: [] })
  await oldStatusRequest
  tree = harness.render(registration.component, props)
  const entries = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
  assert.deepEqual(entries.map(entry => entry.props.item.id), ['new-filter-page'])
  assert.match(treeText(tree), /增量返回期间筛选或时间线来源已改变/)
})

test('a stale status poll cannot regress a newer terminal Job summary', async () => {
  let statusTick
  let jobTick
  const harness = interactiveReactHarness({ runStatusEffects: true, runJobEffects: true })
  const plugin = await loadBundle(harness.react, {
    setInterval(callback, delay) {
      if (delay === 15_000) statusTick = callback
      if (delay === 2_500) jobTick = callback
      return delay
    },
    clearInterval() {},
  })
  let registration
  plugin.apply({
    effect(callback) { return callback() }, connection: { rpc: { async call() { return { ok: true, value: {} } } } }, sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  let bootstrapReads = 0
  let resolveSlowStatus
  const slowStatus = new Promise(resolve => { resolveSlowStatus = resolve })
  const runningJob = revision => ({ id: 'job-1', status: 'running', revision, mode: 'supplemental', totalSegments: 2, completedSegments: 1, currentSegment: { index: 1, fromSeq: 10, toSeq: 20 } })
  const terminalJob = { id: 'job-1', status: 'succeeded', revision: 3, mode: 'supplemental', totalSegments: 2, completedSegments: 2, currentSegment: null }
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'insight/status', 'history/delta', 'analysis/start', 'analysis/job', 'analysis/cancel'] } },
    async readBootstrap() {
      bootstrapReads += 1
      const value = boundedBootstrap([])
      const revision = bootstrapReads === 1 ? 1 : 3
      value.history.revision = revision
      value.status = { coverage: { observedThroughSeq: 20, programmaticThroughSeq: 20 }, revisions: { history: revision, timeline: revision }, latest: {}, reportSummary: null, autoDecision: {}, activeJobs: bootstrapReads === 1 ? [runningJob(1)] : [] }
      return value
    },
    async readStatus() { return slowStatus },
    async readJob() { return terminalJob },
    async readHistoryDelta() { return { revision: 4, added: [], updated: [], removed: [] } },
  }
  const props = { useSession: () => ({ nodes: [{ seq: 20 }] }), api, sessionId: 'job-race' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  harness.render(registration.component, props)
  let tree = harness.render(registration.component, props)
  assert.equal(typeof statusTick, 'function')
  assert.equal(typeof jobTick, 'function')
  const slowStatusRequest = statusTick()
  await jobTick()
  resolveSlowStatus({ coverage: { observedThroughSeq: 21, programmaticThroughSeq: 21 }, revisions: { history: 4, timeline: 4 }, latest: {}, reportSummary: null, autoDecision: {}, activeJobs: [runningJob(2)] })
  await slowStatusRequest
  tree = harness.render(registration.component, props)
  const overview = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'StatusOverview')[0]
  assert.equal(overview.props.job.status, 'succeeded')
  assert.equal(overview.props.job.revision, 3)
  assert.equal(overview.props.job.segments, undefined)
})

test('generated client includes the P0 state, timeline, controlled analysis, evidence, and export safeguards', async () => {
  const source = await readFile(clientUrl, 'utf8')
  assert.match(source, /当前有效模型/)
  assert.match(source, /分析进度/)
  assert.match(source, /数据新鲜度/)
  assert.match(source, /可追溯分析时间线/)
  assert.match(source, /模型与自动策略/)
  assert.match(source, /全局默认/)
  assert.match(source, /当前 Session/)
  assert.match(source, /补齐未分析区间/)
  assert.match(source, /补充分析/)
  assert.match(source, /预览切段与调用/)
  assert.match(source, /启动后台分析/)
  assert.match(source, /证据详情/)
  assert.match(source, /未验证/)
  assert.match(source, /精确起始 Seq/)
  assert.match(source, /精确结束 Seq/)
  assert.match(source, /上次分析失败，将在/)
  assert.match(source, /预览导出范围/)
  assert.match(source, /分析历史全部/)
  assert.match(source, /原始范围 Seq/)
  assert.match(source, /sourceObservedThroughSeq/)
  assert.match(source, /确认并下载 JSON/)
  assert.match(source, /旧服务没有导出预览与隐私确认契约/)
  assert.match(source, /reasoningEffort/)
  assert.match(source, /idempotencyKey/)
  assert.match(source, /historyAdvanced/)
  assert.match(source, /modelCalls \?\? preview\?\.estimatedCalls/)
  assert.match(source, /currentJobSegment/)
  assert.match(source, /persistedJobs\.at\?\.\(-1\)/)
  assert.match(source, /PREVIEW_STALE/)
  assert.match(source, /模型分析已取消/)
  assert.match(source, /cancelRequestedAt \? 'cancelling'/)
  assert.match(source, /job\.status === 'cancelling'/)
  assert.match(source, /appliedRevisions/)
  assert.match(source, /const scoped = data\?\.settingsScope/)
  assert.match(source, /从失败段重新预览/)
  assert.match(source, /中止当前调用及后续段/)
  assert.match(source, /状态刷新失败/)
  assert.match(source, /有效设置读取失败，仍显示上次可用配置/)
  assert.match(source, /aria-live/)
  assert.match(source, /tiProgress/)
  assert.match(source, /最近一轮：/)
  assert.match(source, /规则分析/)
  assert.match(source, /模型分析/)
  assert.match(source, /正式分析/)
  assert.match(source, /补充分析/)
  assert.match(source, /阶段分析 · 暂定/)
  assert.match(source, /展开分析详情/)
  assert.match(source, /已按当前条件筛选/)
  assert.doesNotMatch(source, /已纳入模型主覆盖|查看程序化详情|展开完整记录|服务端筛选 · 游标分页|模型旁路调用/)
  assert.doesNotMatch(source, /placeholder: 'high,medium'|placeholder: 'succeeded,failed'|placeholder: 'manual-segment'|placeholder: 'provider\/model\/effort'/)
  assert.doesNotMatch(source, /const \[busy, setBusy\]/)
  assert.doesNotMatch(source, /\[refresh, seqToken\]/)
  assert.match(source, /prefers-reduced-motion/)
  assert.match(source, /focus-visible/)
})

test('review layout uses the full workbench and exposes the timeline without nested scrolling', async () => {
  const source = await readFile(new URL('../src/client-template.js', import.meta.url), 'utf8')
  const style = source.slice(source.indexOf('const STYLE_TEXT'), source.indexOf('function formatNumber'))

  assert.match(style, /\.tiShell\s*\{[^}]*width:\s*100%/s)
  assert.doesNotMatch(style, /width:\s*min\(1540px,\s*100%\)/)
  assert.match(style, /\.tiRoot\s*\{[^}]*container-type:\s*inline-size/s)
  assert.match(style, /\.tiLayout\s*\{[^}]*display:\s*block/s)
  assert.doesNotMatch(style, /\.tiOperationsBar\s*\{/)
  assert.match(style, /\.tiOpsPanel\s*\{[^}]*position:\s*relative[^}]*overflow:\s*clip/s)
  assert.match(style, /\.tiControlStack\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s)
  assert.doesNotMatch(style, /\.tiControlStack\s*\{[^}]*repeat\(auto-fit/s)
  assert.match(style, /@container \(max-width:\s*900px\)[\s\S]*?\.tiFilterPanel\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
  assert.match(style, /\.tiTimelineScroll\s*\{[^}]*overflow:\s*visible/s)
  assert.doesNotMatch(style, /\.tiTimelineScroll\s*\{[^}]*max-height:\s*min\(72vh,\s*920px\)/s)
  assert.match(source, /className: 'tiOpsPanel'/)
  assert.match(source, /\['ops', '设置'\]/)
  assert.match(source, /aria-expanded': toolbarDisclosure === 'filter'/)
  assert.doesNotMatch(source, /toolbarDisclosure === 'audit'/)
  assert.match(source, /open: opsOpen\.resources === true/)
  assert.match(source, /open: opsOpen\.controlled === true/)
  assert.match(source, /open: opsOpen\.export === true/)
  assert.match(source, /setOpsOpen\(current => \(\{ \.\.\.current, controlled: true \}\)\)/)
  assert.match(source, /className: 'tiPanelTop'/)
  assert.match(source, /className: 'tiConsole'/)
  assert.match(source, /className: 'tiGapZone'/)
  const adapter = await readFile(new URL(standardEdition ? '../src/client-standard-adapter.js' : '../src/client-sidebar-adapter.js', import.meta.url), 'utf8')
  assert.match(adapter, /className: 'tiToggle'/)
  assert.match(source, /资源与用量/)
  assert.match(source, /className: 'tiTimelineTools'/)
  assert.match(source, /className: 'tiToolDisclosure'/)
  assert.match(source, /className: 'tiToolPanels'/)
  assert.match(source, /className: 'tiInlineDisclosure'/)
  assert.match(source, /高级触发与资源阈值/)
  assert.match(style, /\.tiResearchSection--collapsible > summary::-webkit-details-marker/)
  assert.match(style, /\.tiResearchSection--collapsible > summary::after/)
})

test('generated client implements bounded P1/P2 investigation workflows without fake legacy controls', async () => {
  const source = await readFile(clientUrl, 'utf8')
  assert.match(source, /insight\/bootstrap/)
  assert.match(source, /programmatic\/sync/)
  assert.match(source, /本地规则分析，不会调用模型/)
  assert.match(source, /historyLimit: 80/)
  assert.match(source, /已按当前条件筛选/)
  assert.match(source, /已加载/)
  assert.match(source, /CURSOR_STALE/)
  assert.match(source, /history\/delta/)
  assert.match(source, /同范围两次运行对比/)
  assert.match(source, /并排查看同一 Seq 范围的模型结论、风险、证据与资源数据/)
  assert.doesNotMatch(source, /冲突提示 · 推断|漂移提示 · 推断|有差异/u)
  assert.match(source, /旧记录未提供输入证据哈希/)
  assert.match(source, /promptVersion/)
  assert.match(source, /analyzerVersion/)
  assert.match(source, /reasoningEffort/)
  assert.match(source, /缓存复用/)
  assert.doesNotMatch(source, /人工审计层|批注与书签|添加批注|加书签/)
  assert.doesNotMatch(source, /annotations\/upsert|annotations\/archive|annotations\/list/)
  assert.match(source, /概览/)
  assert.match(source, /research\/members/)
  assert.match(source, /汇总成员引用/)
  assert.match(source, /findingIndex/)
  assert.match(source, /evidenceIndex/)
  assert.doesNotMatch(source, /冲突候选 · 推断|漂移候选 · 推断/u)
  assert.match(source, /仅显示真实资源量/)
  assert.match(source, /不估算金额/)
  assert.match(source, /overrideBudget/)
  assert.match(source, /overrideReason/)
  assert.match(source, /role: 'progressbar'/)
  assert.match(source, /aria-live/)
  assert.match(source, /'aria-modal': 'false'/)
  assert.match(source, /event\.key === 'Escape'/)
  assert.doesNotMatch(source, /event\.key !== 'Tab'/)
  assert.match(source, /timeZoneName: 'short'/)
  assert.match(source, /当前 DSH 版本仅筛选已加载的记录/)
  assert.match(source, /为保持当前滚动与展开状态，页面没有自动替换/)
  assert.match(source, /Turn 选择器只载入最近/)
  const deltaReset = source.slice(source.indexOf('if (delta.reset)'), source.indexOf('setHistoryPage(current => {', source.indexOf('if (delta.reset)')))
  assert.match(deltaReset, /setHistoryUpdateAvailable/)
  assert.doesNotMatch(deltaReset, /readHistoryPage/)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
})

test('bundle implements open-turn live cards, provisional folding, and 4s live polling', async () => {
  const source = await readFile(new URL('../src/client-template.js', import.meta.url), 'utf8')
  assert.match(source, /readLive: \(\) => call\('live\/read'/)
  assert.match(source, /function LiveEntry/)
  assert.match(source, /function ProvisionalGroupEntry/)
  assert.match(source, /className: 'tiLiveSection'/)
  assert.match(source, /实时规则分析 · 进行中/)
  assert.match(source, /已观测到 Seq /)
  assert.match(source, /阶段分析 · 暂定/)
  assert.match(source, /className: 'tiProvisionalGroup'/)
  assert.match(source, /setStatusPollDelay\(Boolean\(value\.status\?\.live\?\.active\) \? 4_000 : 15_000\)/)
  assert.match(source, /setInterval\(\(\) => pollStatus\(\), supportsStatus \? statusPollDelay : 30_000\)/)
  assert.match(source, /maxCallsPerTurn: Number\(provMaxCallsPerTurn\)/)
  assert.match(source, /允许开放 Turn 的阶段分析/)
  assert.match(source, /const \[turnSortDirection, setTurnSortDirection\] = useState\('desc'\)/)
  assert.match(source, /const \[withinTurnSortDirection, setWithinTurnSortDirection\] = useState\('desc'\)/)
  assert.match(source, /sortTimelineForDisplay\(visibleItems, turnSortDirection, withinTurnSortDirection\)/)
  assert.match(source, /Turn 顺序/)
  assert.match(source, /Turn 内顺序/)
})

test('open-turn live card renders above the timeline and settled provisional runs fold into a group', async () => {
  const harness = interactiveReactHarness()
  const plugin = await loadBundle(harness.react)
  let registration
  plugin.apply({
    effect(callback) { return callback() },
    connection: { rpc: { async call() { return { ok: true, value: {} } } } },
    sessions: { binding() { return { session: {} } } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  })
  const api = {
    async readCapabilities() { return { endpoints: ['insight/bootstrap', 'insight/status', 'live/read'], features: { nonFullBootstrap: true, liveRead: true } } },
    async readBootstrap() {
      return {
        serviceVersion: 'test',
        status: {
          coverage: { closedThroughSeq: 9, programmaticThroughSeq: 9, semanticThroughSeq: 9, observedThroughSeq: 15, stableThroughSeq: 14, openTurn: 2 },
          revisions: {}, live: { active: true },
        },
        settingsScope: { global: {}, effective: {} },
        history: {
          items: [
            { id: 'cp-0', historyKind: 'programmatic', fromSeq: 0, toSeq: 0, fromTurn: 0, toTurn: 0, report: { status: { code: 'complete', label: '已完成' }, summary: '更早检查点' } },
            { id: 'cp-1', historyKind: 'programmatic', fromSeq: 0, toSeq: 9, fromTurn: 1, toTurn: 1, report: { status: { code: 'complete', label: '已完成' }, summary: '最终检查点' } },
            { id: 'run-prov-1', historyKind: 'semantic', coverageRole: 'provisional', status: 'succeeded', fromSeq: 0, toSeq: 3, fromTurn: 1, toTurn: 1, route: { provider: 'p', model: 'm' }, trigger: 'provisional-failure-pattern', output: { verdict: '阶段结论一', narrative: '阶段叙述一' } },
            { id: 'run-prov-2', historyKind: 'semantic', coverageRole: 'provisional', status: 'succeeded', fromSeq: 4, toSeq: 6, fromTurn: 1, toTurn: 1, route: { provider: 'p', model: 'm' }, trigger: 'provisional-quiet', output: { verdict: '阶段结论二', narrative: '阶段叙述二' } },
          ],
          total: 4, revision: 2, nextCursor: null,
        },
        annotations: { total: 0, activeCount: 0, revision: 0 },
        turns: [{ turn: 1, fromSeq: 0, toSeq: 9 }],
        resources: {},
        live: {
          revision: 3,
          items: [{
            id: 'live-2', turn: 2, fromSeq: 10, observedThroughSeq: 15, stableThroughSeq: 14,
            lastMeaningfulAt: new Date(2_000).toISOString(), updatedAt: new Date(2_000).toISOString(),
            state: 'open', analyzerVersion: 'test', revision: 3,
            report: { status: { code: 'running', label: '进行中' }, summary: '实时摘要', findings: [{ severity: 'medium', title: '实时发现', summary: '实时发现摘要' }] },
          }],
          provisional: { turn: 2, throughSeq: 12, callsInTurn: 1, lastDispatchedAt: null, lastSucceededAt: null },
        },
      }
    },
    async readStatus() { return { coverage: { openTurn: 2 }, live: { active: true, revision: 3 }, revisions: {} } },
    async readLive() { return { revision: 3, items: [], provisional: { turn: 2, throughSeq: 12, callsInTurn: 1 } } },
  }
  const props = { useSession: () => ({ nodes: [] }), api, sessionId: 'live-render' }
  harness.render(registration.component, props)
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render(registration.component, props)
  const text = treeText(tree)
  assert.match(text, /当前显示 4 条分析记录/)
  // The harness does not render function components; invoke the live entry
  // and the provisional group manually, like the other view tests.
  const liveSection = findTreeNodes(tree, node => node.props?.className === 'tiLiveSection')[0]
  assert.ok(liveSection, 'live section renders above the timeline')
  const liveNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'LiveEntry')[0]
  assert.ok(liveNode)
  const liveText = treeText(liveNode.type(liveNode.props))
  assert.match(liveText, /实时规则分析 · 进行中/)
  assert.match(liveText, /已观测到 Seq 15 · 稳定到 Seq 14/)
  assert.match(liveText, /实时摘要/)
  assert.match(liveText, /实时发现/)
  assert.match(liveText, /已分析到 Seq 12/)
  const groupNode = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'ProvisionalGroupEntry')[0]
  assert.ok(groupNode, 'settled provisional runs fold into a group')
  const groupText = treeText(groupNode.type(groupNode.props))
  assert.match(groupText, /阶段分析 · 暂定/)
  assert.match(groupText, /Turn 1 · 共 2 次/)
  assert.match(groupText, /最新：阶段结论二/)
  assert.match(groupText, /阶段叙述一/)
  assert.deepEqual(Array.from(groupNode.props.items, item => item.id), ['run-prov-2', 'run-prov-1'], 'descending direction applies inside the provisional group')
  const displayNodes = findTreeNodes(tree, node => typeof node.type === 'function' && ['ProgrammaticEntry', 'ProvisionalGroupEntry'].includes(node.type.name))
  const describe = node => node.type.name === 'ProvisionalGroupEntry' ? `group:${node.props.turn}` : node.props.item.id
  assert.deepEqual(displayNodes.map(describe), ['group:1', 'cp-1', 'cp-0'], 'default descending order applies to Turn and Seq together')
  const descendingGroupFragment = findTreeNodes(tree, node => node.type === harness.react.Fragment && node.children?.some(child => child?.type?.name === 'ProvisionalGroupEntry'))[0]
  assert.equal(descendingGroupFragment.props.key, 'provisional:1')
  assert.ok(descendingGroupFragment.children.some(child => child?.props?.className === 'tiLatestAnchor'), 'latest anchor is attached to the atomic provisional group')
  const selectInLabel = (currentTree, label) => {
    const field = findTreeNodes(currentTree, node => node.type === 'label' && treeText(node).startsWith(label))[0]
    return findTreeNodes(field, node => node.type === 'select')[0]
  }
  const applySort = async (currentTree, field, value) => {
    selectInLabel(currentTree, field).props.onChange({ target: { value } })
    const draftTree = harness.render(registration.component, props)
    const applyButton = findTreeNodes(draftTree, node => node.type === 'button' && treeText(node) === '应用筛选')[0]
    await applyButton.props.onClick()
    return harness.render(registration.component, props)
  }
  assert.equal(findTreeNodes(tree, node => node.type === 'button' && /Turn.*序/u.test(treeText(node))).length, 0, 'sorting controls stay out of the timeline header')

  const turnAscendingTree = await applySort(tree, 'Turn 顺序', 'asc')
  const turnAscendingNodes = findTreeNodes(turnAscendingTree, node => typeof node.type === 'function' && ['ProgrammaticEntry', 'ProvisionalGroupEntry'].includes(node.type.name))
  assert.deepEqual(turnAscendingNodes.map(describe), ['cp-0', 'group:1', 'cp-1'], 'changing Turn order does not change within-Turn order')
  assert.deepEqual(Array.from(turnAscendingNodes.find(node => node.type.name === 'ProvisionalGroupEntry').props.items, item => item.id), ['run-prov-2', 'run-prov-1'])

  const bothAscendingTree = await applySort(turnAscendingTree, 'Turn 内顺序', 'asc')
  const bothAscendingNodes = findTreeNodes(bothAscendingTree, node => typeof node.type === 'function' && ['ProgrammaticEntry', 'ProvisionalGroupEntry'].includes(node.type.name))
  assert.deepEqual(bothAscendingNodes.map(describe), ['cp-0', 'group:1', 'cp-1'])
  assert.deepEqual(Array.from(bothAscendingNodes.find(node => node.type.name === 'ProvisionalGroupEntry').props.items, item => item.id), ['run-prov-1', 'run-prov-2'], 'changing Turn-internal order reverses provisional members')

  const turnDescendingWithinAscendingTree = await applySort(bothAscendingTree, 'Turn 顺序', 'desc')
  const mixedNodes = findTreeNodes(turnDescendingWithinAscendingTree, node => typeof node.type === 'function' && ['ProgrammaticEntry', 'ProvisionalGroupEntry'].includes(node.type.name))
  assert.deepEqual(mixedNodes.map(describe), ['group:1', 'cp-1', 'cp-0'])
  assert.deepEqual(Array.from(mixedNodes.find(node => node.type.name === 'ProvisionalGroupEntry').props.items, item => item.id), ['run-prov-1', 'run-prov-2'])

  for (const currentTree of [turnAscendingTree, bothAscendingTree, turnDescendingWithinAscendingTree]) {
    const groupFragment = findTreeNodes(currentTree, node => node.type === harness.react.Fragment && node.children?.some(child => child?.type?.name === 'ProvisionalGroupEntry'))[0]
    assert.equal(groupFragment.props.key, 'provisional:1', 'the group key stays stable across all direction combinations')
    assert.ok(groupFragment.children.some(child => child?.props?.className === 'tiLatestAnchor'), 'the true latest anchor remains rendered across all direction combinations')
    assert.ok(findTreeNodes(currentTree, node => node.props?.className === 'tiLiveSection')[0], 'the running section remains pinned above the sorted timeline')
  }
  const semanticNodes = findTreeNodes(tree, node => typeof node.type === 'function' && node.type.name === 'SemanticEntry')
  assert.equal(semanticNodes.length, 0, 'the provisional run is folded, not rendered as a standalone entry')
})

test('timeline sorter preserves unknown stability, valid fallbacks, layer order, and post-merge direction', async () => {
  const source = await readFile(new URL('../src/client-template.js', import.meta.url), 'utf8')
  const start = source.indexOf('function historyLayer')
  const end = source.indexOf('function semanticVersionTime')
  assert.ok(start >= 0 && end > start)
  const context = { Date, Number, String }
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.__sort = sortTimelineForDisplay; globalThis.__turn = timelineTurn; globalThis.__time = timelineTime`, context)
  const known = { id: 'known', historyKind: 'semantic', fromTurn: 1, toTurn: 1, fromSeq: 1, toSeq: 1, completedAt: '2026-08-19T01:00:00.000Z' }
  const fallback = { id: 'fallback', historyKind: 'semantic', toTurn: 'invalid', fromTurn: 2, fromSeq: 2, toSeq: 2, createdAt: 'invalid', completedAt: '2026-08-19T02:00:00.000Z' }
  const unknown = ['z', 'a', 'm'].map(id => ({ id, historyKind: 'semantic', toTurn: 'invalid', fromTurn: null, fromSeq: null, toSeq: null, createdAt: 'invalid' }))
  assert.equal(context.__turn(fallback), 2)
  assert.equal(context.__time(fallback), Date.parse(fallback.completedAt))
  assert.deepEqual(Array.from(context.__sort([unknown[0], known, unknown[1], fallback, unknown[2]], 'desc', 'asc'), item => item.id), ['fallback', 'known', 'z', 'a', 'm'])
  assert.deepEqual(Array.from(context.__sort([unknown[0], known, unknown[1], fallback, unknown[2]], 'asc', 'desc'), item => item.id), ['known', 'fallback', 'z', 'a', 'm'])

  const shared = { fromTurn: 1, toTurn: 1, fromSeq: 5, toSeq: 5, completedAt: '2026-08-19T03:00:00.000Z' }
  const semantic = { ...shared, id: 'semantic', historyKind: 'semantic' }
  const programmatic = { ...shared, id: 'programmatic', historyKind: 'programmatic' }
  for (const [turnDirection, withinDirection] of [['desc', 'desc'], ['desc', 'asc'], ['asc', 'desc'], ['asc', 'asc']]) {
    assert.deepEqual(Array.from(context.__sort([semantic, programmatic], turnDirection, withinDirection), item => item.id), ['programmatic', 'semantic'])
  }

  const combinations = [
    { id: 't1-s1', historyKind: 'semantic', fromTurn: 1, toTurn: 1, fromSeq: 1, toSeq: 1 },
    { id: 't1-s2', historyKind: 'semantic', fromTurn: 1, toTurn: 1, fromSeq: 2, toSeq: 2 },
    { id: 't2-s1', historyKind: 'semantic', fromTurn: 2, toTurn: 2, fromSeq: 1, toSeq: 1 },
    { id: 't2-s2', historyKind: 'semantic', fromTurn: 2, toTurn: 2, fromSeq: 2, toSeq: 2 },
  ]
  assert.deepEqual(Array.from(context.__sort(combinations, 'desc', 'desc'), item => item.id), ['t2-s2', 't2-s1', 't1-s2', 't1-s1'])
  assert.deepEqual(Array.from(context.__sort(combinations, 'desc', 'asc'), item => item.id), ['t2-s1', 't2-s2', 't1-s1', 't1-s2'])
  assert.deepEqual(Array.from(context.__sort(combinations, 'asc', 'desc'), item => item.id), ['t1-s2', 't1-s1', 't2-s2', 't2-s1'])
  assert.deepEqual(Array.from(context.__sort(combinations, 'asc', 'asc'), item => item.id), ['t1-s1', 't1-s2', 't2-s1', 't2-s2'])

  const initial = [
    { ...known, id: 'seq-10', fromSeq: 10, toSeq: 10 },
    { ...known, id: 'seq-30', fromSeq: 30, toSeq: 30 },
  ]
  const merged = [...initial, { ...known, id: 'seq-20', fromSeq: 20, toSeq: 20 }]
  const originalOrder = merged.map(item => item.id)
  assert.deepEqual(Array.from(context.__sort(merged, 'asc', 'asc'), item => item.id), ['seq-10', 'seq-20', 'seq-30'])
  assert.deepEqual(Array.from(context.__sort(merged, 'desc', 'desc'), item => item.id), ['seq-30', 'seq-20', 'seq-10'])
  assert.deepEqual(merged.map(item => item.id), originalOrder, 'sorting never mutates merged history input')
})
