import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { ANALYZER_VERSION, analyzeTrace } from './core.mjs'
import {
  buildSemanticEnvelope,
  closedTurnWindows,
  compressTraceEvent,
  evaluateAutomaticTrigger,
  normalizeAnalysisSettings,
  planCoverageSegments,
  stableInputHash,
} from './analysis-policy.mjs'
import { evaluateProvisionalTrigger, openTurnState, provisionalDeadlineAt } from './live-turn.mjs'
import {
  SEMANTIC_PROMPT_VERSION,
  listAnalysisModels,
  recommendLowCostRoute,
  runSemanticModel,
} from './model-analysis.mjs'
import { readSessionObservation } from './session-observation.mjs'

export const TRACE_INSIGHT_SERVICE_VERSION = '1.2.0'
const MAX_DIAGNOSTICS = 100
const RETRY_BASE_MS = 300_000
const RETRY_MAX_MS = 3_600_000
const INTERRUPTED_RETRY_MS = 60_000
const MAX_AUTOMATIC_RETRY_ATTEMPTS = 3
const MAX_HISTORY_PAGE = 200
const MAX_BOOTSTRAP_TURNS = 200
const MAX_CURSOR_CHARS = 16 * 1024
const EXPORT_CONFIRMATION_TTL_MS = 5 * 60_000
const LIVE_FLUSH_DEBOUNCE_MS = 4_000
const EMPTY_PROVISIONAL = Object.freeze({
  turn: null,
  throughSeq: -1,
  callsInTurn: 0,
  lastDispatchedAt: null,
  lastSucceededAt: null,
})
const NON_RETRYABLE_MODEL_CODES = new Set([
  'ENVELOPE_TOO_LARGE',
  'MODEL_EMPTY_OUTPUT',
  'MODEL_FINISH_UNSUPPORTED',
  'MODEL_INVALID_FORMAT',
  'MODEL_MAX_TOKENS',
  'MODEL_NOT_CONFIGURED',
  'MODEL_TOOL_CALL',
])

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function cloneLiveItems(items) {
  return asArray(items).map(item => ({
    ...(item && typeof item === 'object' ? item : {}),
    report: item?.report && typeof item.report === 'object' ? item.report : null,
  }))
}

function iso(now) {
  return new Date(now()).toISOString()
}

function lastSeq(observation) {
  return asArray(observation?.log?.events).at(-1)?.seq ?? -1
}

function routeEquals(left, right) {
  return left?.provider === right?.provider
    && left?.model === right?.model
    && (left?.reasoningEffort ?? '') === (right?.reasoningEffort ?? '')
}

function retryDelay(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)))
}

function retryConfigurationKey(route, settings) {
  return JSON.stringify({
    route,
    analyzerVersion: ANALYZER_VERSION,
    promptVersion: SEMANTIC_PROMPT_VERSION,
    model: settings?.model ?? null,
    input: settings?.auto ? {
      maxPendingEvents: settings.auto.maxPendingEvents,
      maxInputChars: settings.auto.maxInputChars,
    } : null,
  })
}

function evidenceCharsLimit(totalChars) {
  const reserve = Math.min(4_000, Math.floor(totalChars * 0.25))
  return Math.max(1_000, totalChars - reserve)
}

function envelopeCharsLimit(totalChars) {
  return Math.max(1_000, totalChars - 64)
}

function eventTimeMs(value, fallback) {
  if (Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function diagnosticKey(sessionId, operation) {
  return `${sessionId}\u0000${operation}`
}

function sliceObservation(observation, fromSeq, toSeq) {
  const inRange = event => event?.seq >= fromSeq && event?.seq <= toSeq
  return {
    ...observation,
    log: {
      ...observation.log,
      events: asArray(observation.log?.events).filter(inRange),
    },
    records: asArray(observation.records).filter(inRange),
    surface: observation.surface ? {
      ...observation.surface,
      events: asArray(observation.surface.events).filter(inRange),
      capturedThroughSeq: toSeq,
    } : null,
  }
}

function runError(error) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {}
  return {
    code: typeof error?.code === 'string' ? error.code : 'ANALYSIS_FAILED',
    message: typeof error?.message === 'string' ? error.message : 'Trace Insight model analysis failed.',
    ...(typeof details.rawText === 'string' ? { rawText: details.rawText } : {}),
    ...(details.usage !== undefined ? { usage: details.usage } : {}),
    ...(details.finish !== undefined ? { finish: details.finish } : {}),
    ...(typeof details.cause === 'string' ? { cause: details.cause } : {}),
  }
}

function compactCheckpointReport(report) {
  return {
    schemaVersion: report.schemaVersion,
    analyzerVersion: report.analyzerVersion,
    generatedAt: report.generatedAt,
    sessionId: report.sessionId,
    source: report.source,
    status: report.status,
    summary: report.summary,
    strategy: report.strategy,
    rootCause: report.rootCause,
    metrics: report.metrics,
    phases: report.phases,
    findings: report.findings,
    lessons: report.lessons,
    finalAnswer: report.finalAnswer,
    userGoal: report.userGoal,
    limitations: report.limitations,
  }
}

function coverageView(history, events) {
  const windows = closedTurnWindows(events)
  const closedThroughSeq = windows.at(-1)?.toSeq ?? -1
  const semanticThrough = history.semantic.coveredThroughSeq
  return {
    observedThroughSeq: events.at(-1)?.seq ?? -1,
    closedThroughSeq,
    programmaticThroughSeq: history.programmatic.coveredThroughSeq,
    semanticThroughSeq: semanticThrough,
    semanticPendingFromSeq: semanticThrough < closedThroughSeq ? semanticThrough + 1 : null,
    semanticPendingToSeq: semanticThrough < closedThroughSeq ? closedThroughSeq : null,
    complete: semanticThrough >= closedThroughSeq,
  }
}

function checkpointFor(window, fromSeq, report, trigger, now) {
  return {
    id: `programmatic-${randomUUID()}`,
    kind: 'programmatic',
    trigger,
    fromSeq,
    toSeq: window.toSeq,
    fromTurn: window.turn,
    toTurn: window.turn,
    startedAt: window.startedAt,
    completedAt: window.completedAt,
    capturedAt: iso(now),
    analyzerVersion: ANALYZER_VERSION,
    report: compactCheckpointReport(report),
  }
}

function reportForSegment(analyzer, observation, sessionId, segment, overallReport) {
  const report = analyzer({
    rawSession: sliceObservation(observation, segment.fromSeq, segment.toSeq),
    sessionId,
  })
  return {
    ...report,
    userGoal: report.userGoal || overallReport?.userGoal || '',
  }
}

function validateRange(events, fromSeq, toSeq) {
  const end = closedTurnWindows(events).at(-1)?.toSeq ?? -1
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 0 || toSeq < fromSeq || toSeq > end) {
    throw Object.assign(new Error(`Analysis range must be within closed Turns at Seq 0..${end}.`), { code: 'INVALID_RANGE' })
  }
}

function validateRoute(candidate) {
  const provider = typeof candidate?.provider === 'string' ? candidate.provider.trim() : ''
  const model = typeof candidate?.model === 'string' ? candidate.model.trim() : ''
  if (!provider || !model || provider.length > 256 || model.length > 256) {
    throw Object.assign(new Error('A non-empty analysis provider and model are required.'), { code: 'MODEL_NOT_CONFIGURED' })
  }
  const reasoningEffort = typeof candidate.reasoningEffort === 'string' ? candidate.reasoningEffort.trim() : ''
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

function revisionError(expectedRevision, actualRevision) {
  return Object.assign(new Error(`Expected revision ${expectedRevision}, but the current revision is ${actualRevision}.`), {
    code: 'REVISION_CONFLICT',
    details: { expectedRevision, actualRevision },
  })
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key)
}

function mergeSettingsOverride(current, patch, globalSettings) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const merged = {
    ...existing,
    ...(hasOwn(source, 'defaultRoute') ? { defaultRoute: source.defaultRoute } : {}),
    auto: { ...(existing.auto ?? {}), ...(source.auto ?? {}) },
    model: { ...(existing.model ?? {}), ...(source.model ?? {}) },
    resourcePolicy: { ...(existing.resourcePolicy ?? {}), ...(source.resourcePolicy ?? {}) },
  }
  const normalized = normalizeAnalysisSettings(merged, globalSettings)
  const result = {}
  if (hasOwn(merged, 'defaultRoute')) result.defaultRoute = normalized.defaultRoute
  const autoKeys = ['enabled', 'everyTurns', 'maxPendingEvents', 'maxInputChars', 'quietPeriodMs']
  const provisionalKeys = ['enabled', 'failureThreshold', 'noProgressSteps', 'meaningfulEvents', 'compressedChars', 'maxAgeMs', 'quietMs', 'cooldownMs', 'maxCallsPerTurn']
  const modelKeys = ['maxOutputTokens', 'timeoutMs']
  const resourcePolicyKeys = ['maxCallsPerJob', 'maxInputCharsPerJob', 'warnCallsPerJob', 'warnInputCharsPerJob']
  const auto = Object.fromEntries(autoKeys.filter(key => hasOwn(merged.auto, key)).map(key => [key, normalized.auto[key]]))
  if (hasOwn(merged.auto, 'provisional') && merged.auto.provisional && typeof merged.auto.provisional === 'object') {
    auto.provisional = Object.fromEntries(provisionalKeys
      .filter(key => hasOwn(merged.auto.provisional, key))
      .map(key => [key, normalized.auto.provisional[key]]))
  }
  const model = Object.fromEntries(modelKeys.filter(key => hasOwn(merged.model, key)).map(key => [key, normalized.model[key]]))
  const resourcePolicy = Object.fromEntries(resourcePolicyKeys
    .filter(key => hasOwn(merged.resourcePolicy, key))
    .map(key => [key, normalized.resourcePolicy[key]]))
  if (Object.keys(auto).length > 0) result.auto = auto
  if (Object.keys(model).length > 0) result.model = model
  if (Object.keys(resourcePolicy).length > 0) result.resourcePolicy = resourcePolicy
  return Object.keys(result).length > 0 ? result : null
}

function applySettingsOverride(globalSettings, override) {
  if (!override) return normalizeAnalysisSettings(globalSettings)
  return normalizeAnalysisSettings({
    ...globalSettings,
    ...override,
    auto: { ...globalSettings.auto, ...(override.auto ?? {}) },
    model: { ...globalSettings.model, ...(override.model ?? {}) },
    resourcePolicy: { ...globalSettings.resourcePolicy, ...(override.resourcePolicy ?? {}) },
  }, globalSettings)
}

function effectiveSettingsSource(override) {
  return {
    defaultRoute: hasOwn(override, 'defaultRoute') ? 'session' : 'global',
    auto: override?.auto && Object.keys(override.auto).length > 0 ? 'mixed' : 'global',
    model: override?.model && Object.keys(override.model).length > 0 ? 'mixed' : 'global',
    resourcePolicy: override?.resourcePolicy && Object.keys(override.resourcePolicy).length > 0 ? 'mixed' : 'global',
  }
}

function jobTerminal(status) {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
}

function boundedJobError(error) {
  if (!error || typeof error !== 'object') return null
  return {
    code: typeof error.code === 'string' ? boundedText(error.code, 200) : null,
    message: boundedText(error.message, 2_000),
    ...(typeof error.cause === 'string' ? { cause: boundedText(error.cause, 1_000) } : {}),
  }
}

function boundedJobSegment(segment) {
  if (!segment || typeof segment !== 'object') return null
  return {
    index: Number.isSafeInteger(segment.index) ? segment.index : null,
    status: segment.status ?? null,
    runId: segment.runId ?? null,
    fromSeq: Number.isSafeInteger(segment.fromSeq) ? segment.fromSeq : null,
    toSeq: Number.isSafeInteger(segment.toSeq) ? segment.toSeq : null,
    fromTurn: Number.isSafeInteger(segment.fromTurn) ? segment.fromTurn : null,
    toTurn: Number.isSafeInteger(segment.toTurn) ? segment.toTurn : null,
    startedAt: segment.startedAt ?? null,
    completedAt: segment.completedAt ?? null,
    error: boundedJobError(segment.error),
  }
}

function boundedJobSummary(job) {
  if (!job || typeof job !== 'object') return null
  const segments = asArray(job.segments)
  const progressCurrent = Number.isSafeInteger(job.progress?.current) ? job.progress.current : null
  const current = progressCurrent === null
    ? segments.find(segment => segment?.status === 'running')
    : segments[progressCurrent]
  const retry = segments.find(segment => ['failed', 'interrupted', 'cancelled', 'planned'].includes(segment?.status))
  const totalSegments = Number.isSafeInteger(job.progress?.total) && job.progress.total >= 0
    ? job.progress.total
    : segments.length
  const completedSegments = Number.isSafeInteger(job.progress?.completed) && job.progress.completed >= 0
    ? job.progress.completed
    : segments.filter(segment => segment?.status === 'succeeded').length
  const statusCounts = { planned: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0, cancelled: 0, unknown: 0 }
  for (const segment of segments) {
    const status = String(segment?.status ?? 'unknown')
    statusCounts[Object.hasOwn(statusCounts, status) ? status : 'unknown'] += 1
  }
  return {
    id: job.id,
    kind: job.kind ?? 'manual-analysis',
    ...(job.historyKind ? { historyKind: job.historyKind } : {}),
    sessionId: job.sessionId ?? null,
    mode: job.mode ?? null,
    coverageRole: job.coverageRole ?? null,
    trigger: job.trigger ?? null,
    status: job.status ?? null,
    route: job.route ?? null,
    fromSeq: Number.isSafeInteger(job.fromSeq) ? job.fromSeq : null,
    toSeq: Number.isSafeInteger(job.toSeq) ? job.toSeq : null,
    range: {
      fromSeq: Number.isSafeInteger(job.fromSeq) ? job.fromSeq : null,
      toSeq: Number.isSafeInteger(job.toSeq) ? job.toSeq : null,
    },
    totalSegments,
    completedSegments,
    currentSegment: boundedJobSegment(current),
    retrySegment: boundedJobSegment(retry),
    segmentStatusCounts: statusCounts,
    progress: { completed: completedSegments, total: totalSegments, current: progressCurrent },
    error: boundedJobError(job.error),
    resourceOverride: job.resourceOverride?.authorized ? {
      authorized: true,
      reason: boundedText(job.resourceOverride.reason, 1_000),
      authorizedAt: job.resourceOverride.authorizedAt ?? null,
      previewToken: boundedText(job.resourceOverride.previewToken, 2_000),
      resourceFingerprint: job.resourceOverride.resourceFingerprint ?? null,
    } : null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    cancelRequestedAt: job.cancelRequestedAt ?? null,
    revision: Number.isSafeInteger(job.revision) ? job.revision : 0,
  }
}

function exportOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    redactRaw: source.redactRaw === true,
    ...(Number.isSafeInteger(source.fromSeq) ? { fromSeq: source.fromSeq } : {}),
    ...(Number.isSafeInteger(source.toSeq) ? { toSeq: source.toSeq } : {}),
  }
}

function redactExportValue(value, key = '') {
  const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()
  const sensitive = normalizedKey === 'authorization'
    || normalizedKey === 'apikey'
    || normalizedKey === 'token'
    || normalizedKey.endsWith('token')
    || normalizedKey.endsWith('secret')
    || normalizedKey.endsWith('password')
    || normalizedKey.endsWith('cookie')
  if (sensitive && value !== null && value !== undefined) return '[REDACTED]'
  if (typeof value === 'string') {
    return value
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
      .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_KEY]')
  }
  if (Array.isArray(value)) return value.map(item => redactExportValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactExportValue(child, childKey)]))
}

function sampledJsonChars(items, sampleSize = 24) {
  const values = asArray(items)
  if (values.length === 0) return 0
  const count = Math.min(sampleSize, values.length)
  let sampledChars = 0
  for (let index = 0; index < count; index += 1) {
    const position = count === 1 ? 0 : Math.round(index * (values.length - 1) / (count - 1))
    sampledChars += JSON.stringify(values[position]).length
  }
  return Math.ceil((sampledChars / count) * values.length)
}

function estimatedHistoryChars(history, scopedSettings) {
  const jobs = asArray(history.jobs).reduce((sum, job) => {
    const { segments, ...summary } = job
    return sum + JSON.stringify(summary).length + sampledJsonChars(segments)
  }, 0)
  return 2_000
    + JSON.stringify(scopedSettings).length
    + sampledJsonChars(history.programmatic?.checkpoints)
    + sampledJsonChars(history.semantic?.runs)
    + sampledJsonChars(history.diagnostics)
    + sampledJsonChars(history.annotations?.items)
    + jobs
}

function historyItemCollections(history) {
  return [
    ...asArray(history.programmatic?.checkpoints).map(item => ({ ...item, historyKind: 'programmatic' })),
    ...asArray(history.semantic?.runs).map(item => ({ ...item, historyKind: 'semantic' })),
    ...asArray(history.diagnostics).map(item => ({ ...item, historyKind: 'diagnostic' })),
    ...asArray(history.jobs).map(item => ({ ...item, historyKind: 'job' })),
  ]
}

function itemTime(item) {
  const value = item.completedAt ?? item.capturedAt ?? item.startedAt ?? item.createdAt ?? item.at ?? ''
  if (Number.isFinite(value)) return Number(value)
  return Date.parse(value) || 0
}

function itemStableSortTime(item) {
  // completedAt is intentionally excluded: running semantic/job records gain
  // it later, and a mutable key would move records across an issued keyset.
  const value = item.createdAt ?? item.startedAt ?? item.capturedAt ?? item.at ?? item.completedAt ?? ''
  if (Number.isFinite(value)) return Number(value)
  return Date.parse(value) || 0
}

function annotationTime(item) {
  const value = item?.updatedAt ?? item?.createdAt ?? ''
  if (Number.isFinite(value)) return Number(value)
  return Date.parse(value) || 0
}

function boundedText(value, limit = 4_000) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

function normalizedStrings(...values) {
  return [...new Set(values.flatMap(value => Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []))
    .map(value => String(value).trim().toLowerCase())
    .filter(Boolean))].sort()
}

function normalizeHistoryFilters(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const integer = key => {
    if (source[key] === undefined || source[key] === null || source[key] === '') return null
    if (!Number.isSafeInteger(source[key]) || source[key] < 0) {
      throw Object.assign(new Error(`History filter ${key} must be a non-negative integer.`), { code: 'INVALID_FILTERS' })
    }
    return source[key]
  }
  const result = {
    query: typeof source.query === 'string' ? source.query.trim().toLowerCase().slice(0, 1_000) : '',
    fromSeq: integer('fromSeq'),
    toSeq: integer('toSeq'),
    fromTurn: integer('fromTurn'),
    toTurn: integer('toTurn'),
    layers: normalizedStrings(source.layers, source.kinds, source.layer, source.kind),
    statuses: normalizedStrings(source.statuses, source.status),
    triggers: normalizedStrings(source.triggers, source.trigger),
    severities: normalizedStrings(source.severities, source.severity),
    coverageRoles: normalizedStrings(source.coverageRoles, source.coverageRole),
    providers: normalizedStrings(source.providers, source.provider),
    models: normalizedStrings(source.models, source.model),
    reasoningEfforts: normalizedStrings(source.reasoningEfforts, source.reasoningEffort),
  }
  if (result.fromSeq !== null && result.toSeq !== null && result.fromSeq > result.toSeq) {
    throw Object.assign(new Error('History Seq filter range is invalid.'), { code: 'INVALID_FILTERS' })
  }
  if (result.fromTurn !== null && result.toTurn !== null && result.fromTurn > result.toTurn) {
    throw Object.assign(new Error('History Turn filter range is invalid.'), { code: 'INVALID_FILTERS' })
  }
  return result
}

function itemRange(item) {
  const seq = Number.isSafeInteger(item?.seq) ? item.seq : null
  const fromSeq = Number.isSafeInteger(item?.fromSeq) ? item.fromSeq : seq
  const toSeq = Number.isSafeInteger(item?.toSeq) ? item.toSeq : seq
  const turn = Number.isSafeInteger(item?.turn) ? item.turn : null
  const fromTurn = Number.isSafeInteger(item?.fromTurn) ? item.fromTurn : turn
  const toTurn = Number.isSafeInteger(item?.toTurn) ? item.toTurn : turn
  return { fromSeq, toSeq, fromTurn, toTurn }
}

function itemSeverities(item) {
  const values = [item?.severity, item?.output?.risk]
  for (const finding of asArray(item?.report?.findings)) values.push(finding?.severity)
  return normalizedStrings(values)
}

function itemStatus(item) {
  return String(item?.status ?? item?.report?.status?.code ?? item?.error?.code ?? '').trim().toLowerCase()
}

function itemMatchesFilters(item, filters) {
  const range = itemRange(item)
  if (filters.fromSeq !== null && (range.toSeq === null || range.toSeq < filters.fromSeq)) return false
  if (filters.toSeq !== null && (range.fromSeq === null || range.fromSeq > filters.toSeq)) return false
  if (filters.fromTurn !== null && (range.toTurn === null || range.toTurn < filters.fromTurn)) return false
  if (filters.toTurn !== null && (range.fromTurn === null || range.fromTurn > filters.toTurn)) return false
  const layer = String(item.historyKind ?? item.kind ?? '').toLowerCase()
  if (filters.layers.length > 0 && !filters.layers.includes(layer) && !filters.layers.includes(String(item.kind ?? '').toLowerCase())) return false
  const status = itemStatus(item)
  if (filters.statuses.length > 0 && !filters.statuses.includes(status)) return false
  const trigger = String(item.trigger ?? '').toLowerCase()
  if (filters.triggers.length > 0 && !filters.triggers.includes(trigger)) return false
  const severities = itemSeverities(item)
  if (filters.severities.length > 0 && !filters.severities.some(value => severities.includes(value))) return false
  const coverageRole = String(item.coverageRole ?? '').toLowerCase()
  if (filters.coverageRoles.length > 0 && !filters.coverageRoles.includes(coverageRole)) return false
  const provider = String(item.route?.provider ?? '').toLowerCase()
  const model = String(item.route?.model ?? '').toLowerCase()
  const effort = String(item.route?.reasoningEffort ?? '').toLowerCase()
  if (filters.providers.length > 0 && !filters.providers.includes(provider)) return false
  if (filters.models.length > 0) {
    const modelKeys = [model, `${provider}/${model}`, `${provider}:${model}`, `${provider}/${model}/${effort}`]
    if (!filters.models.some(value => modelKeys.includes(value))) return false
  }
  if (filters.reasoningEfforts.length > 0 && !filters.reasoningEfforts.includes(effort)) return false
  if (filters.query && !JSON.stringify(item).toLowerCase().includes(filters.query)) return false
  return true
}

function historySortTuple(item) {
  const range = itemRange(item)
  return {
    seq: range.toSeq ?? range.fromSeq ?? -1,
    time: itemStableSortTime(item),
    kind: String(item.historyKind ?? item.kind ?? ''),
    id: String(item.id ?? ''),
  }
}

function compareSortTuple(left, right) {
  return right.seq - left.seq
    || right.time - left.time
    || left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id)
}

function cursorSignature(payload, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
}

function encodeCursor(payload, secret, issuer) {
  const body = { ...payload, issuer }
  const signed = { ...body, signature: cursorSignature(body, secret) }
  return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url')
}

function decodeCursor(cursor, secret, issuer) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS) {
    throw Object.assign(new Error('History cursor is invalid.'), { code: 'INVALID_CURSOR' })
  }
  let decoded
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw Object.assign(new Error('History cursor is invalid.'), { code: 'INVALID_CURSOR' })
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw Object.assign(new Error('History cursor is invalid.'), { code: 'INVALID_CURSOR' })
  }
  const { signature, ...payload } = decoded
  if (payload.issuer !== issuer) {
    throw Object.assign(new Error('History cursor was issued by a previous service instance.'), { code: 'CURSOR_STALE' })
  }
  const expected = Buffer.from(cursorSignature(payload, secret), 'hex')
  const actual = typeof signature === 'string' && /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw Object.assign(new Error('History cursor integrity check failed.'), { code: 'INVALID_CURSOR' })
  }
  return payload
}

function tokenCount(usage, names) {
  for (const name of names) if (Number.isFinite(usage?.[name])) return Number(usage[name])
  return null
}

function semanticResources(runs) {
  const resources = {
    calls: { total: 0, model: 0, cached: 0, notDispatched: 0 },
    inputChars: 0,
    tokens: { input: 0, output: 0, total: 0, knownRuns: 0, unknownRuns: 0 },
    durationMs: 0,
    cache: { hits: 0, misses: 0 },
    pricing: null,
  }
  for (const run of asArray(runs)) {
    const cached = Boolean(run?.cachedFromRunId) || run?.finish?.kind === 'cache'
    const modelCalled = !cached && Boolean(run?.modelDispatchedAt
      || run?.status === 'succeeded'
      || run?.usage
      || run?.rawText
      || run?.finish)
    resources.calls.total += 1
    if (cached) resources.calls.cached += 1
    else if (modelCalled) resources.calls.model += 1
    else resources.calls.notDispatched += 1
    if (cached) resources.cache.hits += 1
    else if (modelCalled) resources.cache.misses += 1
    if (Number.isFinite(run?.inputChars)) resources.inputChars += Number(run.inputChars)
    const started = Date.parse(run?.startedAt ?? '')
    const completed = Date.parse(run?.completedAt ?? '')
    if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) resources.durationMs += completed - started
    const input = tokenCount(run?.usage, ['inputTokens', 'promptTokens', 'input_tokens', 'prompt_tokens'])
    const output = tokenCount(run?.usage, ['outputTokens', 'completionTokens', 'output_tokens', 'completion_tokens'])
    const total = tokenCount(run?.usage, ['totalTokens', 'total_tokens']) ?? (input !== null && output !== null ? input + output : null)
    if (input === null && output === null && total === null) resources.tokens.unknownRuns += 1
    else {
      resources.tokens.knownRuns += 1
      resources.tokens.input += input ?? 0
      resources.tokens.output += output ?? 0
      resources.tokens.total += total ?? 0
    }
  }
  resources.totalCalls = resources.calls.total
  resources.modelCalls = resources.calls.model
  resources.cachedCalls = resources.calls.cached
  return resources
}

function latestByTime(items, predicate = () => true) {
  return asArray(items)
    .filter(predicate)
    .sort((left, right) => itemTime(right) - itemTime(left) || String(right?.id ?? '').localeCompare(String(left?.id ?? '')))
    .at(0) ?? null
}

/** Synchronous best-effort estimate of the next provisional analysis moment. */
function provisionalEstimate(openLive, provisional, settings) {
  if (!openLive) return null
  const policy = settings?.auto?.provisional
  if (!policy || !settings.auto?.enabled || !settings.defaultRoute) {
    return { reason: settings?.defaultRoute ? 'disabled' : 'waiting-for-model', at: null }
  }
  if ((provisional?.callsInTurn ?? 0) >= policy.maxCallsPerTurn) return { reason: 'provisional-quota', at: null }
  const lastMeaningful = eventTimeMs(openLive?.lastMeaningfulAt, 0)
  const lastDispatched = eventTimeMs(provisional?.lastDispatchedAt, 0)
  const at = Math.max(lastMeaningful + policy.quietMs, lastDispatched + policy.cooldownMs)
  return { reason: 'provisional-estimate', at: new Date(at).toISOString() }
}

function boundedProgrammaticSummary(checkpoint) {
  if (!checkpoint) return null
  const report = checkpoint.report ?? {}
  const severityCounts = {}
  for (const finding of asArray(report.findings)) {
    const severity = String(finding?.severity ?? 'unknown').toLowerCase()
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1
  }
  return {
    id: checkpoint.id,
    fromSeq: checkpoint.fromSeq,
    toSeq: checkpoint.toSeq,
    fromTurn: checkpoint.fromTurn ?? null,
    toTurn: checkpoint.toTurn ?? null,
    capturedAt: checkpoint.capturedAt ?? checkpoint.completedAt ?? null,
    analyzerVersion: checkpoint.analyzerVersion ?? report.analyzerVersion ?? null,
    trigger: checkpoint.trigger ?? null,
    status: report.status ?? null,
    summary: boundedText(report.summary, 4_000),
    metrics: report.metrics ?? null,
    phaseCount: asArray(report.phases).length,
    findingCount: asArray(report.findings).length,
    severityCounts,
    sampleFindings: asArray(report.findings).slice(0, 5).map(finding => ({
      severity: finding?.severity ?? null,
      category: boundedText(finding?.category, 200),
      title: boundedText(finding?.title, 500),
    })),
  }
}

function boundedSemanticSummary(run) {
  if (!run) return null
  return {
    id: run.id,
    status: run.status,
    fromSeq: run.fromSeq,
    toSeq: run.toSeq,
    fromTurn: run.fromTurn ?? null,
    toTurn: run.toTurn ?? null,
    trigger: run.trigger ?? null,
    coverageRole: run.coverageRole ?? null,
    route: run.route ?? null,
    promptVersion: run.promptVersion ?? null,
    analyzerVersion: run.analyzerVersion ?? null,
    inputHash: run.inputHash ?? null,
    startedAt: run.startedAt ?? run.createdAt ?? null,
    completedAt: run.completedAt ?? null,
    verdict: boundedText(run.output?.verdict, 2_000),
    risk: run.output?.risk ?? null,
    confidence: run.output?.confidence ?? null,
    rootCauses: asArray(run.output?.rootCauses).slice(0, 8).map(value => boundedText(value, 1_000)),
    nextSteps: asArray(run.output?.nextSteps).slice(0, 8).map(value => boundedText(value, 1_000)),
    error: run.error ? { code: run.error.code ?? null, message: boundedText(run.error.message, 2_000) } : null,
    usage: run.usage ?? null,
    inputChars: Number.isFinite(run.inputChars) ? run.inputChars : null,
    cachedFromRunId: run.cachedFromRunId ?? null,
  }
}

function boundedDiagnosticSummary(diagnostic) {
  if (!diagnostic) return null
  return {
    id: diagnostic.id,
    kind: diagnostic.kind ?? null,
    operation: diagnostic.operation ?? null,
    code: diagnostic.code ?? null,
    message: boundedText(diagnostic.message, 2_000),
    at: diagnostic.at ?? diagnostic.createdAt ?? null,
    resolvedAt: diagnostic.resolvedAt ?? null,
    resolution: diagnostic.resolution ?? null,
  }
}

function storedAutomaticDecision(history, settings, nextTrigger) {
  const closedThroughSeq = history.lastClosedSeq ?? history.programmatic.coveredThroughSeq
  const semanticThroughSeq = history.semantic.coveredThroughSeq
  const retry = history.semantic.retry
  if (settings?.auto?.enabled !== true) return { due: false, reason: 'disabled', closedThroughSeq }
  if (!settings?.defaultRoute) return { due: false, reason: 'waiting-for-model', closedThroughSeq }
  if (retry?.paused) {
    return { due: false, reason: 'retry-paused', closedThroughSeq, retryAttempt: retry.attempt ?? null, retryCode: retry.code ?? null }
  }
  if (retry?.notBefore) {
    return { due: false, reason: 'retry-backoff', closedThroughSeq, retryAt: retry.notBefore, retryAttempt: retry.attempt ?? null, retryCode: retry.code ?? null }
  }
  if (semanticThroughSeq >= closedThroughSeq) return { due: false, reason: 'covered', closedThroughSeq }
  if (!history.automatic?.enrolled) return { due: false, reason: 'manual-backfill-required', closedThroughSeq }
  return { due: false, reason: 'accumulating', closedThroughSeq, nextTriggerAt: nextTrigger ?? null }
}

function comparisonRun(run) {
  const started = Date.parse(run?.startedAt ?? '')
  const completed = Date.parse(run?.completedAt ?? '')
  const maxOutputTokens = run?.settingsSnapshot?.model?.maxOutputTokens
  const generationConfiguration = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0
    ? { maxOutputTokens }
    : null
  return {
    id: run.id,
    status: run.status,
    range: { fromSeq: run.fromSeq, toSeq: run.toSeq, fromTurn: run.fromTurn ?? null, toTurn: run.toTurn ?? null },
    route: run.route ?? null,
    promptVersion: run.promptVersion ?? null,
    analyzerVersion: run.analyzerVersion ?? null,
    inputHash: typeof run.inputHash === 'string' && run.inputHash ? run.inputHash : null,
    generationConfiguration,
    generationConfigurationFingerprint: generationConfiguration ? stableInputHash(generationConfiguration) : null,
    verdict: run.output?.verdict ?? null,
    rootCauses: asArray(run.output?.rootCauses),
    nextSteps: asArray(run.output?.nextSteps),
    risk: run.output?.risk ?? null,
    confidence: run.output?.confidence ?? null,
    usage: run.usage ?? null,
    inputChars: Number.isFinite(run.inputChars) ? run.inputChars : null,
    durationMs: Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : null,
    cache: { hit: Boolean(run.cachedFromRunId) || run.finish?.kind === 'cache', fromRunId: run.cachedFromRunId ?? null },
    modelCalled: Boolean(run.modelDispatchedAt || (run.status === 'succeeded' && !run.cachedFromRunId && run.finish?.kind !== 'cache')),
  }
}

function difference(left, right) {
  return { changed: JSON.stringify(left) !== JSON.stringify(right), left, right }
}

function compareSemanticRuns(leftRun, rightRun) {
  const left = comparisonRun(leftRun)
  const right = comparisonRun(rightRun)
  const sameRange = left.range.fromSeq === right.range.fromSeq && left.range.toSeq === right.range.toSeq
  const succeeded = left.status === 'succeeded' && right.status === 'succeeded'
  const structured = Boolean(left.verdict) && Boolean(right.verdict)
  const sourceKnown = Boolean(left.inputHash) && Boolean(right.inputHash)
  const sameSource = sourceKnown && left.inputHash === right.inputHash
  const reasons = [
    ...(!sameRange ? ['range-mismatch'] : []),
    ...(!succeeded ? ['both-runs-must-succeed'] : []),
    ...(!structured ? ['structured-output-missing'] : []),
    ...(!sourceKnown ? ['input-hash-missing'] : []),
    ...(sourceKnown && !sameSource ? ['source-mismatch'] : []),
  ]
  const comparable = reasons.length === 0
  const routeKnown = Boolean(left.route?.provider && left.route?.model && right.route?.provider && right.route?.model)
  const promptKnown = Boolean(left.promptVersion && right.promptVersion)
  const analyzerKnown = Boolean(left.analyzerVersion && right.analyzerVersion)
  const generationKnown = Boolean(left.generationConfigurationFingerprint && right.generationConfigurationFingerprint)
  const configurationReasons = [
    ...(!routeKnown ? ['route-missing'] : []),
    ...(!promptKnown ? ['prompt-version-missing'] : []),
    ...(!analyzerKnown ? ['analyzer-version-missing'] : []),
    ...(!generationKnown ? ['generation-configuration-missing'] : []),
    ...(routeKnown && !routeEquals(left.route, right.route) ? ['route-mismatch'] : []),
    ...(promptKnown && left.promptVersion !== right.promptVersion ? ['prompt-version-mismatch'] : []),
    ...(analyzerKnown && left.analyzerVersion !== right.analyzerVersion ? ['analyzer-version-mismatch'] : []),
    ...(generationKnown && left.generationConfigurationFingerprint !== right.generationConfigurationFingerprint ? ['generation-configuration-mismatch'] : []),
  ]
  const sameConfiguration = configurationReasons.length === 0
  const verdictChanged = comparable && (left.verdict !== right.verdict
    || JSON.stringify(left.rootCauses) !== JSON.stringify(right.rootCauses))
  const outputChanged = verdictChanged
    || JSON.stringify(left.nextSteps) !== JSON.stringify(right.nextSteps)
    || left.risk !== right.risk
  return {
    comparable,
    reasons,
    left,
    right,
    differences: {
      range: difference(left.range, right.range),
      provider: difference(left.route?.provider ?? null, right.route?.provider ?? null),
      model: difference(left.route?.model ?? null, right.route?.model ?? null),
      reasoningEffort: difference(left.route?.reasoningEffort ?? null, right.route?.reasoningEffort ?? null),
      promptVersion: difference(left.promptVersion, right.promptVersion),
      analyzerVersion: difference(left.analyzerVersion, right.analyzerVersion),
      inputHash: difference(left.inputHash, right.inputHash),
      generationConfiguration: difference(left.generationConfiguration, right.generationConfiguration),
      verdict: difference(left.verdict, right.verdict),
      rootCauses: difference(left.rootCauses, right.rootCauses),
      nextSteps: difference(left.nextSteps, right.nextSteps),
      usage: difference(left.usage, right.usage),
      durationMs: difference(left.durationMs, right.durationMs),
      cache: difference(left.cache, right.cache),
    },
    conflict: {
      inference: true,
      assessable: comparable,
      detected: comparable ? verdictChanged : null,
      basis: comparable ? ['same-input-hash', 'verdict', 'rootCauses'] : [],
    },
    drift: {
      inference: true,
      assessable: comparable && sameConfiguration,
      detected: comparable && sameConfiguration ? outputChanged : null,
      basis: comparable && sameConfiguration ? ['same-range', 'same-input-hash', 'same-route', 'same-prompt', 'same-analyzer', 'same-generation-configuration'] : [],
      configurationReasons,
      ...(!sameConfiguration && comparable ? {
        reason: configurationReasons.some(value => value.endsWith('-missing')) ? 'configuration-evidence-missing' : 'configuration-mismatch',
      } : {}),
    },
  }
}

function referenceFor(item, extra = {}) {
  const range = itemRange(item)
  return {
    kind: item.historyKind,
    id: item.id,
    ...(item.historyKind === 'semantic' ? { runId: item.id } : {}),
    ...(item.historyKind === 'programmatic' ? { checkpointId: item.id } : {}),
    fromSeq: range.fromSeq,
    toSeq: range.toSeq,
    ...extra,
  }
}

function addBucket(map, key, label, ref, meta = {}) {
  const normalizedKey = boundedText(key || 'unknown', 500) || 'unknown'
  let bucket = map.get(normalizedKey)
  if (!bucket) {
    bucket = { key: normalizedKey, label: boundedText(label || normalizedKey, 500), count: 0, refs: [], ...meta }
    map.set(normalizedKey, bucket)
  }
  bucket.count += 1
  bucket.refs.push(ref)
}

function budgetAssessment(resources, policy) {
  const limits = {
    maxCallsPerJob: policy.maxCallsPerJob,
    maxInputCharsPerJob: policy.maxInputCharsPerJob,
    warnCallsPerJob: policy.warnCallsPerJob,
    warnInputCharsPerJob: policy.warnInputCharsPerJob,
  }
  const warnings = []
  if (resources.modelCalls >= policy.warnCallsPerJob) warnings.push({ code: 'CALLS_WARNING', actual: resources.modelCalls, limit: policy.warnCallsPerJob })
  if (resources.inputChars >= policy.warnInputCharsPerJob) warnings.push({ code: 'INPUT_CHARS_WARNING', actual: resources.inputChars, limit: policy.warnInputCharsPerJob })
  const violations = []
  if (resources.modelCalls > policy.maxCallsPerJob) violations.push({ code: 'MAX_CALLS_EXCEEDED', actual: resources.modelCalls, limit: policy.maxCallsPerJob })
  if (resources.inputChars > policy.maxInputCharsPerJob) violations.push({ code: 'MAX_INPUT_CHARS_EXCEEDED', actual: resources.inputChars, limit: policy.maxInputCharsPerJob })
  return { limits, warnings, violations, hardLimitExceeded: violations.length > 0, requiresOverride: violations.length > 0 }
}

/** Host orchestration module behind the small Trace Insight RPC interface. */
export class TraceInsightService {
  constructor({
    sessionQuery,
    llm,
    store,
    analyzer = analyzeTrace,
    modelRunner = runSemanticModel,
    modelLister = listAnalysisModels,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = console,
    maxSegmentsPerCycle = 3,
    maxConcurrentModelRuns = 1,
    projectionSettleDelayMs = 250,
    maxProjectionSettleAttempts = 20,
    liveDebounceMs = LIVE_FLUSH_DEBOUNCE_MS,
  }) {
    if (!sessionQuery?.readSession) throw new TypeError('Trace Insight requires sessionQuery.')
    if (!store?.getSession || !store?.updateSession || !store?.updateLiveSession) {
      throw new TypeError('Trace Insight requires an Analysis History Store with a live write path.')
    }
    this.sessionQuery = sessionQuery
    this.llm = llm
    this.store = store
    this.analyzer = analyzer
    this.modelRunner = modelRunner
    this.modelLister = modelLister
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.logger = logger
    this.maxSegmentsPerCycle = maxSegmentsPerCycle
    this.maxConcurrentModelRuns = Math.max(1, Number.isSafeInteger(maxConcurrentModelRuns) ? maxConcurrentModelRuns : 1)
    this.projectionSettleDelayMs = projectionSettleDelayMs
    this.maxProjectionSettleAttempts = maxProjectionSettleAttempts
    this.liveDebounceMs = Math.max(10, Number.isSafeInteger(liveDebounceMs) ? liveDebounceMs : LIVE_FLUSH_DEBOUNCE_MS)
    this.startedAtMs = this.now()
    this.queues = new Map()
    this.quietTimers = new Map()
    this.quietDueAt = new Map()
    this.projectionTimers = new Map()
    this.liveFlushTimers = new Map()
    this.liveLastFlushAt = new Map()
    this.provisionalDeadlineTimers = new Map()
    this.provisionalDeadlineDueAt = new Map()
    this.activeProvisional = new Set()
    this.expectedObservedSeqs = new Map()
    this.projectionAttempts = new Map()
    this.controllers = new Set()
    this.jobControllers = new Map()
    this.jobSessions = new Map()
    this.activeDiagnosticKeys = new Set()
    this.diagnosticGenerations = new Map()
    this.diagnosticSuccessGenerations = new Map()
    this.exportConfirmations = new Map()
    // Cursors are opaque integrity tokens. Per-instance HMAC material keeps a
    // local caller from forging query bindings; a Host restart makes an issued
    // cursor explicitly stale instead of silently accepting a public checksum.
    this.cursorIssuer = randomUUID()
    this.cursorSecret = randomUUID()
    this.activeModelRuns = 0
    this.modelWaiters = []
    this.catalogCache = null
    this.recoveredSessions = new Set()
    this.startPromise = null
    this.disposed = false
  }

  logFailure(error) {
    const warn = typeof this.logger?.warn === 'function' ? this.logger.warn.bind(this.logger) : console.warn
    warn('[trace-insight]', error)
  }

  async recordDiagnostic(sessionId, operation, error, generation = 0) {
    const key = diagnosticKey(sessionId, operation)
    this.activeDiagnosticKeys.add(key)
    const supersededBeforeWrite = (this.diagnosticSuccessGenerations.get(key) ?? 0) > generation
    const recordedAt = iso(this.now)
    const diagnostic = {
      id: `diagnostic-${randomUUID()}`,
      kind: 'service-error',
      operation,
      code: typeof error?.code === 'string' ? error.code : 'BACKGROUND_FAILED',
      message: typeof error?.message === 'string' ? error.message : 'Trace Insight background operation failed.',
      at: recordedAt,
      resolvedAt: supersededBeforeWrite ? recordedAt : null,
      resolution: supersededBeforeWrite ? 'superseded-by-later-success' : null,
    }
    try {
      await this.store.updateSession(sessionId, history => {
        history.diagnostics ??= []
        history.diagnostics.push(diagnostic)
        if (history.diagnostics.length > MAX_DIAGNOSTICS) history.diagnostics.splice(0, history.diagnostics.length - MAX_DIAGNOSTICS)
        return history
      })
    } catch (recordError) {
      this.activeDiagnosticKeys.delete(key)
      throw recordError
    }
    if ((this.diagnosticSuccessGenerations.get(key) ?? 0) > generation && !diagnostic.resolvedAt) {
      await this.resolveDiagnostics(sessionId, operation, this.now(), 'superseded-by-later-success')
    }
    const current = await this.store.getSession(sessionId)
    if (!asArray(current.diagnostics).some(item => item.operation === operation && !item.resolvedAt)) {
      this.activeDiagnosticKeys.delete(key)
    }
  }

  async resolveDiagnostics(sessionId, operation, throughMs = this.now(), resolution = 'operation-succeeded') {
    const current = await this.store.getSession(sessionId)
    const unresolved = asArray(current.diagnostics).filter(diagnostic => diagnostic.operation === operation
      && !diagnostic.resolvedAt
      && eventTimeMs(diagnostic.at ?? diagnostic.createdAt, throughMs) <= throughMs)
    if (unresolved.length === 0) {
      this.activeDiagnosticKeys.delete(diagnosticKey(sessionId, operation))
      return current
    }
    const unresolvedIds = new Set(unresolved.map(diagnostic => diagnostic.id))
    const resolvedAt = iso(this.now)
    const resolved = await this.store.updateSession(sessionId, history => {
      for (const diagnostic of asArray(history.diagnostics)) {
        if (!unresolvedIds.has(diagnostic.id) || diagnostic.resolvedAt) continue
        diagnostic.resolvedAt = resolvedAt
        diagnostic.resolution = resolution
      }
      return history
    })
    if (!asArray(resolved.diagnostics).some(diagnostic => diagnostic.operation === operation && !diagnostic.resolvedAt)) {
      this.activeDiagnosticKeys.delete(diagnosticKey(sessionId, operation))
    }
    return resolved
  }

  handleBackgroundFailure(sessionId, operation, error, generation = 0) {
    this.logFailure(error)
    if (!sessionId) return
    void this.recordDiagnostic(sessionId, operation, error, generation).catch(recordError => this.logFailure(recordError))
  }

  runInBackground(sessionId, operation, promise) {
    const key = sessionId ? diagnosticKey(sessionId, operation) : null
    const generation = key ? (this.diagnosticGenerations.get(key) ?? 0) + 1 : 0
    if (key) {
      this.diagnosticGenerations.set(key, generation)
    }
    const throughMs = this.now()
    void promise.then(
      () => {
        if (!sessionId || !key) return
        this.diagnosticSuccessGenerations.set(key, Math.max(this.diagnosticSuccessGenerations.get(key) ?? 0, generation))
        if (!this.activeDiagnosticKeys.has(key)) return
        return this.resolveDiagnostics(sessionId, operation, throughMs).catch(error => this.logFailure(error))
      },
      error => this.handleBackgroundFailure(sessionId, operation, error, generation),
    )
  }

  async recoverStaleRuns(sessionId) {
    if (this.recoveredSessions.has(sessionId)) return this.store.getSession(sessionId)
    const current = await this.store.getSession(sessionId)
    const stale = current.semantic.runs.filter(run => run.status === 'running'
      && eventTimeMs(run.startedAt, this.startedAtMs - 1) < this.startedAtMs)
    const staleJobs = asArray(current.jobs).filter(job => ['queued', 'running'].includes(job.status)
      && eventTimeMs(job.startedAt ?? job.createdAt, this.startedAtMs - 1) < this.startedAtMs)
    const staleDiagnostics = asArray(current.diagnostics).filter(diagnostic => !diagnostic.resolvedAt
      && eventTimeMs(diagnostic.at ?? diagnostic.createdAt, this.startedAtMs - 1) < this.startedAtMs)
    if (stale.length === 0 && staleJobs.length === 0 && staleDiagnostics.length === 0) {
      this.recoveredSessions.add(sessionId)
      return current
    }
    const nowMs = this.now()
    const completedAt = new Date(nowMs).toISOString()
    const recovered = await this.store.updateSession(sessionId, history => {
      for (const run of history.semantic.runs) {
        if (!stale.some(item => item.id === run.id) || run.status !== 'running') continue
        run.status = 'failed'
        run.completedAt = completedAt
        run.error = {
          code: 'ANALYSIS_INTERRUPTED',
          message: 'The previous DSH process ended before this analysis reached a terminal state.',
        }
        if (run.mode === 'auto' && run.coverageRole === 'primary' && history.semantic.coveredThroughSeq === run.fromSeq - 1) {
          const configurationKey = retryConfigurationKey(run.route, run.settingsSnapshot)
          const previous = history.semantic.retry
          const attempt = previous?.fromSeq === run.fromSeq
            && routeEquals(previous.route, run.route)
            && (!previous.configurationKey || previous.configurationKey === configurationKey)
            ? previous.attempt + 1
            : 1
          const paused = attempt >= MAX_AUTOMATIC_RETRY_ATTEMPTS
          const retryAt = paused ? null : new Date(nowMs + INTERRUPTED_RETRY_MS).toISOString()
          run.retryAt = retryAt
          run.retryAttempt = attempt
          run.retryPaused = paused
          if (paused) run.retryPauseReason = 'attempt-limit'
          history.semantic.retry = {
            fromSeq: run.fromSeq,
            route: run.route,
            attempt,
            notBefore: retryAt,
            code: 'ANALYSIS_INTERRUPTED',
            paused,
            configurationKey,
            ...(paused ? { pauseReason: 'attempt-limit' } : {}),
          }
        }
      }
      for (const job of asArray(history.jobs)) {
        if (!staleJobs.some(item => item.id === job.id) || !['queued', 'running'].includes(job.status)) continue
        job.completedAt = completedAt
        for (const segment of asArray(job.segments)) {
          const linkedRun = segment.runId ? history.semantic.runs.find(run => run.id === segment.runId) : null
          if (linkedRun && ['succeeded', 'failed'].includes(linkedRun.status)) {
            segment.status = linkedRun.status
            segment.completedAt = linkedRun.completedAt ?? completedAt
            segment.error = linkedRun.error ?? null
          } else if (segment.status === 'running') segment.status = 'interrupted'
          else if (segment.status === 'planned') segment.status = 'cancelled'
        }
        const segments = asArray(job.segments)
        const failedSegment = segments.find(segment => segment.status === 'failed')
        const allSucceeded = segments.length > 0 && segments.every(segment => segment.status === 'succeeded')
        job.status = allSucceeded ? 'succeeded' : failedSegment ? 'failed' : 'interrupted'
        job.progress ??= { completed: 0, total: segments.length, current: null }
        job.progress.completed = segments.filter(segment => segment.status === 'succeeded').length
        job.progress.current = null
        job.error = allSucceeded
          ? null
          : failedSegment?.error ?? {
              code: 'ANALYSIS_INTERRUPTED',
              message: 'The previous DSH process ended before this manual analysis Job reached a terminal state.',
            }
      }
      history.diagnostics ??= []
      const staleDiagnosticIds = new Set(staleDiagnostics.map(diagnostic => diagnostic.id))
      for (const diagnostic of history.diagnostics) {
        if (!staleDiagnosticIds.has(diagnostic.id) || diagnostic.resolvedAt) continue
        diagnostic.resolvedAt = completedAt
        diagnostic.resolution = 'process-restarted'
      }
      if (stale.length > 0 || staleJobs.length > 0) {
        history.diagnostics.push({
          id: `diagnostic-${randomUUID()}`,
          kind: 'service-error',
          operation: 'startup-recovery',
          code: 'ANALYSIS_INTERRUPTED',
          message: `${stale.length} non-terminal analysis run(s) and ${staleJobs.length} Job(s) were recovered after a process restart.`,
          at: completedAt,
          resolvedAt: completedAt,
          resolution: 'recovered-on-startup',
        })
      }
      if (history.diagnostics.length > MAX_DIAGNOSTICS) history.diagnostics.splice(0, history.diagnostics.length - MAX_DIAGNOSTICS)
      return history
    })
    this.recoveredSessions.add(sessionId)
    return recovered
  }

  async start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      const histories = typeof this.store.listSessions === 'function' ? await this.store.listSessions() : []
      for (const history of histories) {
        if (!history?.sessionId || this.disposed) continue
        try {
          await this.enqueue(history.sessionId, async () => {
            const recovered = await this.recoverStaleRuns(history.sessionId)
            if (recovered.automatic?.enrolled) await this.resumeAutomatic(history.sessionId, 'startup-recovery')
          })
        } catch (error) {
          this.handleBackgroundFailure(history.sessionId, 'startup-recovery', error)
        }
      }
    })()
    return this.startPromise
  }

  async resumeEnrolledSessions(trigger, prioritizedSessionId) {
    const histories = typeof this.store.listSessions === 'function' ? await this.store.listSessions() : []
    const sessionIds = histories
      .filter(history => history?.sessionId && history.automatic?.enrolled)
      .map(history => history.sessionId)
    if (prioritizedSessionId && sessionIds.includes(prioritizedSessionId)) {
      sessionIds.splice(sessionIds.indexOf(prioritizedSessionId), 1)
      sessionIds.unshift(prioritizedSessionId)
    }
    for (const sessionId of sessionIds) {
      if (this.disposed) return
      try {
        await this.enqueue(sessionId, () => this.resumeAutomatic(sessionId, trigger))
      } catch (error) {
        this.handleBackgroundFailure(sessionId, trigger, error)
      }
    }
  }

  enqueue(sessionId, operation) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => {
      if (this.disposed) throw Object.assign(new Error('Trace Insight is disposed.'), { code: 'DISPOSED' })
      return operation()
    })
    const tail = current.catch(() => {}).finally(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId)
    })
    this.queues.set(sessionId, tail)
    return current
  }

  linkedSignal(parent) {
    const controller = new AbortController()
    const forward = () => controller.abort(parent?.reason)
    if (parent?.aborted) forward()
    else parent?.addEventListener?.('abort', forward, { once: true })
    this.controllers.add(controller)
    return {
      signal: controller.signal,
      dispose: () => {
        parent?.removeEventListener?.('abort', forward)
        this.controllers.delete(controller)
      },
    }
  }

  modelSlot() {
    this.activeModelRuns += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeModelRuns -= 1
      while (this.modelWaiters.length > 0) {
        const waiter = this.modelWaiters.shift()
        waiter.signal?.removeEventListener?.('abort', waiter.abort)
        if (waiter.signal?.aborted) {
          waiter.reject(Object.assign(new Error('Trace Insight model analysis was cancelled before dispatch.'), { code: 'MODEL_ABORTED' }))
          continue
        }
        waiter.resolve(this.modelSlot())
        break
      }
    }
  }

  async acquireModelSlot(signal) {
    if (this.disposed) throw Object.assign(new Error('Trace Insight is disposed.'), { code: 'DISPOSED' })
    if (signal?.aborted) throw Object.assign(new Error('Trace Insight model analysis was cancelled before dispatch.'), { code: 'MODEL_ABORTED' })
    if (this.activeModelRuns < this.maxConcurrentModelRuns) return this.modelSlot()
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, abort: null }
      waiter.abort = () => {
        const index = this.modelWaiters.indexOf(waiter)
        if (index >= 0) this.modelWaiters.splice(index, 1)
        reject(Object.assign(new Error('Trace Insight model analysis was cancelled before dispatch.'), { code: 'MODEL_ABORTED' }))
      }
      signal?.addEventListener?.('abort', waiter.abort, { once: true })
      this.modelWaiters.push(waiter)
    })
  }

  async withModelSlot(signal, operation) {
    const release = await this.acquireModelSlot(signal)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async observation(sessionId, signal) {
    return readSessionObservation(this.sessionQuery, sessionId, signal)
  }

  async ensureProgrammatic(observation, trigger) {
    const sessionId = String(observation.log?.session?.id ?? '')
    const events = asArray(observation.log?.events)
    const windows = closedTurnWindows(events)
    const current = await this.store.getSession(sessionId)
    const windowByToSeq = new Map(windows.map(window => [window.toSeq, window]))
    const replacements = []
    for (const checkpoint of current.programmatic.checkpoints) {
      if (checkpoint?.analyzerVersion === ANALYZER_VERSION) continue
      const window = windowByToSeq.get(checkpoint?.toSeq)
      if (!window || !Number.isSafeInteger(checkpoint?.fromSeq) || checkpoint.fromSeq > window.toSeq) continue
      const report = this.analyzer({ rawSession: sliceObservation(observation, checkpoint.fromSeq, window.toSeq), sessionId })
      replacements.push({
        id: checkpoint.id,
        checkpoint: {
          ...checkpointFor(window, checkpoint.fromSeq, report, checkpoint.trigger ?? trigger, this.now),
          id: checkpoint.id,
          capturedAt: checkpoint.capturedAt,
        },
      })
    }
    let covered = current.programmatic.coveredThroughSeq
    const additions = []
    for (const window of windows) {
      if (window.toSeq <= covered) continue
      const fromSeq = covered + 1
      const report = this.analyzer({ rawSession: sliceObservation(observation, fromSeq, window.toSeq), sessionId })
      additions.push(checkpointFor(window, fromSeq, report, trigger, this.now))
      covered = window.toSeq
    }
    const observed = lastSeq(observation)
    const closed = windows.at(-1)?.toSeq ?? -1
    if (replacements.length === 0 && additions.length === 0 && current.lastObservedSeq === observed && current.lastClosedSeq === closed) return current
    return this.store.updateSession(sessionId, history => {
      for (const replacement of replacements) {
        const index = history.programmatic.checkpoints.findIndex(item => item.id === replacement.id)
        if (index < 0 || history.programmatic.checkpoints[index]?.analyzerVersion === ANALYZER_VERSION) continue
        history.programmatic.checkpoints[index] = replacement.checkpoint
      }
      for (const checkpoint of additions) {
        if (checkpoint.toSeq <= history.programmatic.coveredThroughSeq) continue
        history.programmatic.checkpoints.push(checkpoint)
        history.programmatic.coveredThroughSeq = checkpoint.toSeq
      }
      history.lastObservedSeq = Math.max(history.lastObservedSeq, observed)
      history.lastClosedSeq = Math.max(history.lastClosedSeq ?? -1, closed)
      return history
    })
  }

  async catalog({ refresh = false } = {}) {
    const now = this.now()
    if (!refresh && this.catalogCache && now - this.catalogCache.at < 30_000) return this.catalogCache.value
    const value = await this.modelLister(this.llm)
    const result = { ...value, recommendedRoute: recommendLowCostRoute(value.models) }
    this.catalogCache = { at: now, value: result }
    return result
  }

  capabilities() {
    const endpoints = [
      'capabilities/read',
      'models/list',
      'insight/bootstrap',
      'programmatic/sync',
      'settings/effective',
      'settings/update-global',
      'settings/update-session',
      'analysis/preview',
      'analysis/start',
      'analysis/job',
      'analysis/cancel',
      'insight/status',
      'history/page',
      'history/delta',
      'compare/read',
      'research/summary',
      'research/members',
      'evidence/read',
      'export/preview',
      'export/read',
      'live/read',
    ]
    return {
      serviceVersion: TRACE_INSIGHT_SERVICE_VERSION,
      endpoints,
      features: {
        settingsScopes: true,
        asyncJobs: true,
        statusRead: true,
        historyPaging: true,
        historyDelta: true,
        evidenceRead: true,
        exportPreview: true,
        safeRawExport: true,
        nonFullBootstrap: true,
        explicitProgrammaticSync: true,
        stableKeysetPaging: true,
        historyFiltering: true,
        runComparison: true,
        researchSummary: true,
        resourcePolicy: true,
        liveRead: true,
      },
    }
  }

  async globalSettingsState() {
    if (typeof this.store.getSettingsState === 'function') return this.store.getSettingsState()
    return { schemaVersion: 1, revision: 0, updatedAt: null, settings: await this.store.getSettings() }
  }

  async effectiveSettings(sessionId, knownHistory) {
    const [globalState, history] = await Promise.all([
      this.globalSettingsState(),
      knownHistory ? Promise.resolve(knownHistory) : this.store.getSession(sessionId),
    ])
    const sessionOverride = history.settingsOverride ?? null
    return {
      global: globalState.settings,
      sessionOverride,
      effective: applySettingsOverride(globalState.settings, sessionOverride),
      source: effectiveSettingsSource(sessionOverride),
      revision: {
        global: globalState.revision,
        session: history.settingsRevision ?? 0,
        history: history.revision ?? 0,
      },
    }
  }

  async readEffectiveSettings(sessionId) {
    return this.effectiveSettings(sessionId)
  }

  async updateGlobalSettings(patch, expectedRevision) {
    const state = typeof this.store.updateSettingsState === 'function'
      ? await this.store.updateSettingsState(current => normalizeAnalysisSettings(patch, current), { expectedRevision })
      : { revision: 0, settings: await this.store.updateSettings(current => normalizeAnalysisSettings(patch, current)) }
    this.catalogCache = null
    if (state.settings.auto.enabled && state.settings.defaultRoute) {
      this.runInBackground(null, 'settings-change-scan', this.resumeEnrolledSessions('settings-change'))
    }
    return { global: state.settings, revision: state.revision, updatedAt: state.updatedAt ?? null }
  }

  async updateSessionSettings(sessionId, patch, { reset = false, expectedRevision } = {}) {
    const globalState = await this.globalSettingsState()
    const history = await this.store.updateSession(sessionId, current => {
      const actualRevision = current.settingsRevision ?? 0
      if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
        throw revisionError(expectedRevision, actualRevision)
      }
      current.settingsOverride = reset ? null : mergeSettingsOverride(current.settingsOverride, patch, globalState.settings)
      current.settingsRevision = actualRevision + 1
      return current
    })
    const result = await this.effectiveSettings(sessionId, history)
    if (result.effective.auto.enabled && result.effective.defaultRoute) {
      this.runInBackground(sessionId, 'session-settings-change', this.enqueue(sessionId, () => this.resumeAutomatic(sessionId, 'settings-change')))
    }
    return result
  }

  async readInsight(sessionId, signal) {
    await this.recoverStaleRuns(sessionId)
    const observation = await this.observation(sessionId, signal)
    await this.ensureProgrammatic(observation, 'read-recovery')
    const events = asArray(observation.log?.events)
    const report = this.analyzer({ rawSession: observation, sessionId })
    const [history, catalog] = await Promise.all([
      this.store.getSession(sessionId),
      this.catalog(),
    ])
    const scopedSettings = await this.effectiveSettings(sessionId, history)
    const settings = scopedSettings.effective
    const evaluatedDecision = evaluateAutomaticTrigger({ events, history, report, settings, reason: 'read-recovery' })
    const enrollmentDecision = this.withAutomaticEnrollment(evaluatedDecision, history)
    const autoDecision = this.withRetryBackoff(enrollmentDecision, history, settings)
    return {
      serviceVersion: TRACE_INSIGHT_SERVICE_VERSION,
      report,
      history,
      settings,
      settingsScope: scopedSettings,
      catalog,
      turns: closedTurnWindows(events),
      coverage: coverageView(history, events),
      autoDecision,
    }
  }

  async updateSettings(patch, sessionId) {
    const current = await this.globalSettingsState()
    const result = await this.updateGlobalSettings(patch, current.revision)
    return result.global
  }

  scheduleQuiet(sessionId, delayMs) {
    if (this.disposed) return
    const existing = this.quietTimers.get(sessionId)
    if (existing !== undefined) this.clearTimer(existing)
    this.quietDueAt.set(sessionId, new Date(this.now() + delayMs).toISOString())
    const timer = this.setTimer(() => {
      this.quietTimers.delete(sessionId)
      this.quietDueAt.delete(sessionId)
      this.runInBackground(sessionId, 'quiet-period', this.enqueue(sessionId, () => this.maybeRunAfterProjection(sessionId, 'quiet-period')))
    }, delayMs)
    this.quietTimers.set(sessionId, timer)
  }

  scheduleQuietFromObservation(sessionId, observation, quietPeriodMs) {
    const lastTurn = closedTurnWindows(asArray(observation?.log?.events)).at(-1)
    if (!lastTurn) return
    const dueAt = eventTimeMs(lastTurn.completedAt, this.now()) + quietPeriodMs
    this.scheduleQuiet(sessionId, Math.max(0, dueAt - this.now()))
  }

  scheduleProjectionSettle(sessionId) {
    if (this.disposed) return
    const existing = this.projectionTimers.get(sessionId)
    if (existing !== undefined) this.clearTimer(existing)
    const timer = this.setTimer(() => {
      this.projectionTimers.delete(sessionId)
      this.runInBackground(sessionId, 'turn-end', this.enqueue(sessionId, () => this.maybeRunAfterProjection(sessionId, 'turn-end')))
    }, this.projectionSettleDelayMs)
    this.projectionTimers.set(sessionId, timer)
  }

  async maybeRunAfterProjection(sessionId, trigger) {
    const expectedSeq = this.expectedObservedSeqs.get(sessionId)
    if (Number.isSafeInteger(expectedSeq)) {
      const observation = await this.observation(sessionId)
      if (lastSeq(observation) < expectedSeq) {
        const attempts = (this.projectionAttempts.get(sessionId) ?? 0) + 1
        this.projectionAttempts.set(sessionId, attempts)
        if (attempts <= this.maxProjectionSettleAttempts) this.scheduleProjectionSettle(sessionId)
        else this.scheduleQuiet(sessionId, 30_000)
        return {
          decision: {
            due: false,
            reason: attempts <= this.maxProjectionSettleAttempts ? 'projection-catching-up' : 'projection-lagged',
            expectedSeq,
            observedThroughSeq: lastSeq(observation),
          },
        }
      }
      this.expectedObservedSeqs.delete(sessionId)
      this.projectionAttempts.delete(sessionId)
    }
    const result = await this.maybeRunPrimary(sessionId, trigger)
    await this.finalizeLiveForSession(sessionId)
    return result
  }

  observeLiveEvent(session, event) {
    if (this.disposed || !session?.id) return
    if (!Number.isSafeInteger(event?.seq)) return
    if (event.type === 'turn/end') {
      const expected = this.expectedObservedSeqs.get(session.id) ?? -1
      this.expectedObservedSeqs.set(session.id, Math.max(expected, event.seq))
      this.projectionAttempts.set(session.id, 0)
      this.runInBackground(session.id, 'turn-observation', this.enqueue(session.id, async () => {
        await this.store.updateSession(session.id, history => {
          history.automatic.enrolled = true
          history.automatic.enrolledAt ??= iso(this.now)
          history.automatic.lastLiveTurnSeq = Number.isSafeInteger(event.seq) ? event.seq : history.automatic.lastLiveTurnSeq
          history.lastObservedSeq = Math.max(history.lastObservedSeq, event.seq)
          history.lastClosedSeq = Math.max(history.lastClosedSeq ?? -1, event.seq)
          return history
        })
        await this.markLiveFinalizing(session.id, event)
        const history = await this.store.getSession(session.id)
        const settings = (await this.effectiveSettings(session.id, history)).effective
        if (!settings.auto.enabled || !settings.defaultRoute) return
        const retryAt = Date.parse(history.semantic.retry?.notBefore)
        const retryConfigurationMatches = !history.semantic.retry?.configurationKey
          || history.semantic.retry.configurationKey === retryConfigurationKey(settings.defaultRoute, settings)
        if (history.semantic.retry?.fromSeq === history.semantic.coveredThroughSeq + 1
          && routeEquals(history.semantic.retry?.route, settings.defaultRoute)
          && retryConfigurationMatches
          && !history.semantic.retry?.paused
          && Number.isFinite(retryAt)
          && retryAt > this.now()) {
          this.scheduleQuiet(session.id, retryAt - this.now())
          return
        }
        const dueAt = eventTimeMs(event.time, this.now()) + settings.auto.quietPeriodMs
        this.scheduleQuiet(session.id, Math.max(0, dueAt - this.now()))
      }))
      this.scheduleProjectionSettle(session.id)
      return
    }
    // Open-turn live path: debounced. The flush below enrolls the session,
    // updates lastObservedSeq, and refreshes the live programmatic card —
    // without writing the history file per event.
    this.scheduleLiveFlush(session.id)
  }

  scheduleLiveFlush(sessionId) {
    if (this.disposed) return
    // Throttled trailing debounce: flush immediately when nothing ran within
    // the window, otherwise coalesce and flush once the burst settles. This
    // keeps the live card fresh during long steady streams (e.g. chunk
    // floods) without writing per event.
    const now = this.now()
    const lastFlush = this.liveLastFlushAt.get(sessionId) ?? 0
    const existing = this.liveFlushTimers.get(sessionId)
    const runFlush = () => {
      this.liveFlushTimers.delete(sessionId)
      if (this.disposed) return
      this.liveLastFlushAt.set(sessionId, this.now())
      this.runInBackground(sessionId, 'live-flush', this.enqueue(sessionId, () => this.flushLive(sessionId)))
    }
    if (now - lastFlush >= this.liveDebounceMs) {
      if (existing !== undefined) this.clearTimer(existing)
      const timer = this.setTimer(runFlush, 0)
      this.liveFlushTimers.set(sessionId, timer)
      return
    }
    if (existing !== undefined) return
    const timer = this.setTimer(runFlush, Math.max(0, this.liveDebounceMs - (now - lastFlush)))
    this.liveFlushTimers.set(sessionId, timer)
  }

  clearProvisionalDeadline(sessionId) {
    const timer = this.provisionalDeadlineTimers.get(sessionId)
    if (timer !== undefined) this.clearTimer(timer)
    this.provisionalDeadlineTimers.delete(sessionId)
    this.provisionalDeadlineDueAt.delete(sessionId)
  }

  scheduleProvisionalDeadline(sessionId, dueAt) {
    if (this.disposed || !Number.isFinite(dueAt)) {
      this.clearProvisionalDeadline(sessionId)
      return
    }
    const existingDueAt = this.provisionalDeadlineDueAt.get(sessionId)
    if (existingDueAt === dueAt && this.provisionalDeadlineTimers.has(sessionId)) return
    this.clearProvisionalDeadline(sessionId)
    const timer = this.setTimer(() => {
      this.provisionalDeadlineTimers.delete(sessionId)
      this.provisionalDeadlineDueAt.delete(sessionId)
      if (this.disposed) return
      this.runInBackground(sessionId, 'provisional-deadline', this.enqueue(sessionId, () => this.evaluateAndRunProvisional(sessionId)))
    }, Math.max(0, dueAt - this.now()))
    this.provisionalDeadlineTimers.set(sessionId, timer)
    this.provisionalDeadlineDueAt.set(sessionId, dueAt)
  }

  /** Rebuild the live card for the current open turn from the raw log. */
  async flushLive(sessionId) {
    const observation = await this.observation(sessionId)
    const events = asArray(observation.log?.events)
    const history = await this.store.getSession(sessionId)
    const settings = (await this.effectiveSettings(sessionId, history)).effective
    let state = openTurnState(events, { provisionalThroughSeq: history.live?.provisional?.throughSeq ?? -1 })
    if (state !== null && history.live?.provisional?.turn !== state.turn) {
      state = openTurnState(events, { provisionalThroughSeq: state.turnStartSeq - 1 })
    }
    if (state === null) {
      this.clearProvisionalDeadline(sessionId)
      return { decision: { due: false, reason: 'no-open-turn' } }
    }
    const observed = lastSeq(observation)
    const existing = asArray(history.live?.items).find(item => item.turn === state.turn)
    const provisionalTurnChanged = history.live?.provisional?.turn !== state.turn
    const liveChanged = !existing
      || existing.stableThroughSeq < state.stableThroughSeq
      || existing.observedThroughSeq < observed
      || existing.state !== 'open'
      || existing.analyzerVersion !== ANALYZER_VERSION
    if (liveChanged || provisionalTurnChanged || !history.automatic?.enrolled || history.lastObservedSeq < observed) {
      const report = state.stableThroughSeq >= state.turnStartSeq
        ? this.analyzer({ rawSession: sliceObservation(observation, state.turnStartSeq, state.stableThroughSeq), sessionId })
        : null
      await this.store.updateLiveSession(sessionId, current => {
        if (!current.automatic.enrolled) {
          current.automatic.enrolled = true
          current.automatic.enrolledAt ??= iso(this.now)
        }
        if (observed > current.lastObservedSeq) current.lastObservedSeq = observed
        if (provisionalTurnChanged) current.live.provisional = { ...EMPTY_PROVISIONAL, turn: state.turn, throughSeq: state.turnStartSeq - 1 }
        const item = current.live.items.find(candidate => candidate.turn === state.turn)
        const payload = {
          fromSeq: state.turnStartSeq,
          observedThroughSeq: observed,
          stableThroughSeq: state.stableThroughSeq,
          lastMeaningfulAt: state.lastMeaningfulAt !== null ? new Date(state.lastMeaningfulAt).toISOString() : null,
          state: 'open',
          analyzerVersion: ANALYZER_VERSION,
          report: report ? compactCheckpointReport(report) : null,
          updatedAt: iso(this.now),
        }
        if (item) Object.assign(item, payload)
        else {
          current.live.items.push({
            id: `live-${state.turn}`,
            turn: state.turn,
            createdAt: iso(this.now),
            revision: 0,
            ...payload,
          })
        }
        current.live.items.sort((left, right) => left.turn - right.turn)
        return current
      })
    }
    const decision = await this.evaluateAndRunProvisional(sessionId)
    return { state, decision }
  }

  /** Re-evaluate the provisional policy; dispatch exactly one controlled run. */
  async evaluateAndRunProvisional(sessionId) {
    if (this.activeProvisional.has(sessionId)) return { due: false, reason: 'provisional-running' }
    const observation = await this.observation(sessionId)
    const events = asArray(observation.log?.events)
    const history = await this.store.getSession(sessionId)
    const settings = (await this.effectiveSettings(sessionId, history)).effective
    const live = history.live ?? { items: [], provisional: { ...EMPTY_PROVISIONAL } }
    let state = openTurnState(events, { provisionalThroughSeq: live.provisional?.throughSeq ?? -1 })
    if (state !== null && live.provisional?.turn !== state.turn) {
      state = openTurnState(events, { provisionalThroughSeq: state.turnStartSeq - 1 })
    }
    const decision = evaluateProvisionalTrigger({
      state,
      provisional: live.provisional ?? EMPTY_PROVISIONAL,
      settings,
      now: this.now(),
    })
    if (!decision.due) {
      const dueAt = provisionalDeadlineAt({ state, provisional: live.provisional ?? EMPTY_PROVISIONAL, settings, now: this.now() })
      if (dueAt === null) this.clearProvisionalDeadline(sessionId)
      else this.scheduleProvisionalDeadline(sessionId, dueAt)
      return decision
    }
    this.clearProvisionalDeadline(sessionId)
    this.activeProvisional.add(sessionId)
    this.runInBackground(sessionId, 'provisional-semantic', this.enqueue(sessionId, async () => {
      try {
        return await this.runProvisional(sessionId)
      } finally {
        this.activeProvisional.delete(sessionId)
        if (!this.disposed) this.runInBackground(sessionId, 'provisional-reschedule', this.enqueue(sessionId, () => this.evaluateAndRunProvisional(sessionId)))
      }
    }))
    return decision
  }

  /** Execute one provisional semantic run over the current stable prefix. */
  async runProvisional(sessionId) {
    const observation = await this.observation(sessionId)
    const events = asArray(observation.log?.events)
    const history = await this.store.getSession(sessionId)
    const settings = (await this.effectiveSettings(sessionId, history)).effective
    const live = history.live ?? { items: [], provisional: { ...EMPTY_PROVISIONAL } }
    let state = openTurnState(events, { provisionalThroughSeq: live.provisional?.throughSeq ?? -1 })
    if (state !== null && live.provisional?.turn !== state.turn) {
      state = openTurnState(events, { provisionalThroughSeq: state.turnStartSeq - 1 })
    }
    const decision = evaluateProvisionalTrigger({
      state,
      provisional: live.provisional ?? EMPTY_PROVISIONAL,
      settings,
      now: this.now(),
    })
    if (!decision.due || state === null) return { decision }
    const fromSeq = Math.max(state.turnStartSeq, (live.provisional?.throughSeq ?? state.turnStartSeq - 1) + 1)
    const segments = planCoverageSegments({
      events,
      fromSeq,
      throughSeq: state.stableThroughSeq,
      maxInputChars: evidenceCharsLimit(settings.auto.maxInputChars),
      maxEvents: settings.auto.maxPendingEvents,
    })
    const segment = segments[0]
    if (!segment) return { decision: { ...decision, due: false, reason: 'no-segment' } }
    const route = validateRoute(settings.defaultRoute)
    const report = this.analyzer({ rawSession: observation, sessionId })
    const segmentReport = reportForSegment(this.analyzer, observation, sessionId, segment, report)
    const envelope = buildSemanticEnvelope({
      rawSession: observation,
      segment,
      report: segmentReport,
      previousSummary: this.priorSummary(history, fromSeq, { coverageRole: 'provisional', route }),
      maxChars: envelopeCharsLimit(settings.auto.maxInputChars),
    })
    const result = await this.executeSemanticRun({
      sessionId,
      segment,
      route,
      envelope,
      mode: 'auto',
      coverageRole: 'provisional',
      trigger: decision.reason,
      settingsSnapshot: settings,
    })
    await this.store.updateLiveSession(sessionId, current => {
      const provisional = current.live.provisional
      provisional.turn = state.turn
      if (!result.cached) {
        provisional.callsInTurn += 1
        provisional.lastDispatchedAt = iso(this.now)
      }
      if (result.run.status === 'succeeded') {
        provisional.throughSeq = Math.max(provisional.throughSeq, result.run.toSeq)
        provisional.lastSucceededAt = iso(this.now)
      }
      return current
    })
    return { decision, result }
  }

  /** Mark the live card of a closing turn as finalizing (settlement pending). */
  async markLiveFinalizing(sessionId, turnEndEvent) {
    const turn = Number.isSafeInteger(turnEndEvent?.data?.turn) ? turnEndEvent.data.turn : null
    if (turn === null) return
    const history = await this.store.getSession(sessionId)
    if (!asArray(history.live?.items).some(item => item.turn === turn)) return
    await this.store.updateLiveSession(sessionId, current => {
      for (const item of current.live.items) {
        if (item.turn === turn && item.state === 'open') {
          item.state = 'finalizing'
          item.updatedAt = iso(this.now)
        }
      }
      return current
    })
  }

  /** After settlement: mark closed turns finalized and reset the provisional chain. */
  async finalizeLiveForSession(sessionId) {
    const history = await this.store.getSession(sessionId)
    const liveItems = asArray(history.live?.items)
    if (liveItems.length === 0 && (history.live?.provisional?.turn ?? null) === null) return history
    const observation = await this.observation(sessionId)
    const events = asArray(observation.log?.events)
    const closedByTurn = new Map(closedTurnWindows(events).map(window => [window.turn, window]))
    const open = openTurnState(events)
    await this.store.updateLiveSession(sessionId, current => {
      for (const item of current.live.items) {
        if (!closedByTurn.has(item.turn)) continue
        const finalCheckpoint = current.programmatic.checkpoints.find(checkpoint => checkpoint.fromTurn === item.turn && checkpoint.toTurn === item.turn)
        item.state = finalCheckpoint ? 'finalized' : 'finalizing'
        item.updatedAt = iso(this.now)
      }
      if (open === null) current.live.provisional = { ...EMPTY_PROVISIONAL }
      return current
    })
    if (open === null) this.clearProvisionalDeadline(sessionId)
    return this.store.getSession(sessionId)
  }

  /**
   * Repair leftover live state after a Host restart: rebuild the open turn,
   * finalize closed turns whose checkpoints exist, and mark unreachable
   * leftovers interrupted. No model calls, no enrollment side effects.
   */
  async recoverLive(sessionId) {
    const history = await this.store.getSession(sessionId)
    if (asArray(history.live?.items).length === 0) return history
    const observation = await this.observation(sessionId)
    const events = asArray(observation.log?.events)
    const state = openTurnState(events)
    const closedByTurn = new Map(closedTurnWindows(events).map(window => [window.turn, window]))
    await this.store.updateLiveSession(sessionId, current => {
      for (const item of current.live.items) {
        if (state !== null && state.turn === item.turn) {
          Object.assign(item, {
            fromSeq: state.turnStartSeq,
            observedThroughSeq: state.observedThroughSeq,
            stableThroughSeq: state.stableThroughSeq,
            lastMeaningfulAt: state.lastMeaningfulAt !== null ? new Date(state.lastMeaningfulAt).toISOString() : null,
            state: 'open',
            analyzerVersion: ANALYZER_VERSION,
            updatedAt: iso(this.now),
          })
        } else if (closedByTurn.has(item.turn)) {
          const finalCheckpoint = current.programmatic.checkpoints.find(checkpoint => checkpoint.fromTurn === item.turn && checkpoint.toTurn === item.turn)
          item.state = finalCheckpoint ? 'finalized' : 'finalizing'
          item.updatedAt = iso(this.now)
        } else if (item.state !== 'finalized') {
          item.state = 'interrupted'
          item.updatedAt = iso(this.now)
        }
      }
      if (state !== null) current.live.provisional.turn = state.turn
      else current.live.provisional = { ...EMPTY_PROVISIONAL }
      return current
    })
    if (state !== null) {
      // Rebuild the report for the open turn and let the policy resume
      // provisional analysis (cooldown/quota persist across the restart).
      await this.flushLive(sessionId)
    } else this.clearProvisionalDeadline(sessionId)
    return this.store.getSession(sessionId)
  }

  /** Pure read of the live section (lightweight RPC for the inspector). */
  async readLive(sessionId) {
    const history = await this.store.getSession(sessionId)
    return {
      revision: history.live?.revision ?? 0,
      items: cloneLiveItems(history.live?.items ?? []),
      provisional: { ...(history.live?.provisional ?? EMPTY_PROVISIONAL) },
    }
  }

  cachedRun(history, inputHash, route) {
    return history.semantic.runs.find(run => run.status === 'succeeded'
      && run.inputHash === inputHash
      && run.promptVersion === SEMANTIC_PROMPT_VERSION
      && run.analyzerVersion === ANALYZER_VERSION
      && routeEquals(run.route, route))
  }

  async appendCachedRun(sessionId, base, cached) {
    const timestamp = iso(this.now)
    const record = {
      ...base,
      id: base.id ?? `semantic-${randomUUID()}`,
      status: 'succeeded',
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      cachedFromRunId: cached.id,
      modelDispatchedAt: null,
      output: cached.output,
      rawText: cached.rawText,
      usage: null,
      finish: { kind: 'cache' },
    }
    await this.store.updateSession(sessionId, history => {
      if (record.coverageRole === 'primary') {
        if (record.mode === 'auto' && asArray(history.jobs).some(job => job.coverageRole === 'primary' && ['queued', 'running'].includes(job.status))) {
          throw Object.assign(new Error('A manual primary Job owns the current coverage gap.'), { code: 'PRIMARY_JOB_ACTIVE' })
        }
        if (record.mode === 'manual' && history.semantic.coveredThroughSeq !== record.fromSeq - 1) {
          throw Object.assign(new Error('Primary coverage changed before the cached run could be recorded.'), { code: 'PRIMARY_COVERAGE_CONFLICT' })
        }
      }
      history.semantic.runs.push(record)
      if (record.coverageRole === 'primary' && history.semantic.coveredThroughSeq === record.fromSeq - 1) {
        history.semantic.coveredThroughSeq = record.toSeq
        history.semantic.continuitySummary = record.output.continuitySummary
        history.semantic.primaryRunId = record.id
        history.semantic.retry = null
      }
      return history
    })
    return record
  }

  async executeSemanticRun({
    sessionId,
    segment,
    route,
    envelope,
    mode,
    coverageRole,
    trigger,
    force = false,
    signal,
    settingsSnapshot,
    runId,
    jobId,
    jobSegmentIndex,
  }) {
    const inputHash = stableInputHash(envelope)
    const history = await this.store.getSession(sessionId)
    const settingsAtStart = settingsSnapshot ?? (await this.effectiveSettings(sessionId, history)).effective
    const cached = !force ? this.cachedRun(history, inputHash, route) : null
    const base = {
      kind: 'semantic',
      mode,
      coverageRole,
      trigger,
      fromSeq: segment.fromSeq,
      toSeq: segment.toSeq,
      fromTurn: segment.fromTurn ?? null,
      toTurn: segment.toTurn ?? null,
      route,
      analyzerVersion: ANALYZER_VERSION,
      promptVersion: SEMANTIC_PROMPT_VERSION,
      inputHash,
      inputChars: JSON.stringify(envelope).length,
      settingsSnapshot: settingsAtStart,
      ...(runId ? { id: runId } : {}),
      ...(jobId ? { jobId } : {}),
      ...(Number.isSafeInteger(jobSegmentIndex) ? { jobSegmentIndex } : {}),
    }
    if (cached) return { run: await this.appendCachedRun(sessionId, base, cached), cached: true }

    const timestamp = iso(this.now)
    const run = {
      ...base,
      id: runId ?? `semantic-${randomUUID()}`,
      status: 'running',
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
    }
    await this.store.updateSession(sessionId, current => {
      if (coverageRole === 'primary') {
        if (mode === 'auto' && asArray(current.jobs).some(job => job.coverageRole === 'primary' && ['queued', 'running'].includes(job.status))) {
          throw Object.assign(new Error('A manual primary Job owns the current coverage gap.'), { code: 'PRIMARY_JOB_ACTIVE' })
        }
        if (mode === 'manual' && current.semantic.coveredThroughSeq !== run.fromSeq - 1) {
          throw Object.assign(new Error('Primary coverage changed before the model run could start.'), { code: 'PRIMARY_COVERAGE_CONFLICT' })
        }
      }
      current.semantic.runs.push(run)
      return current
    })

    const linked = this.linkedSignal(signal)
    try {
      const result = await this.withModelSlot(linked.signal, async () => {
        run.modelDispatchedAt = iso(this.now)
        await this.store.updateSession(sessionId, current => {
          const index = current.semantic.runs.findIndex(item => item.id === run.id)
          if (index < 0) throw new Error('Trace Insight lost a running analysis record before model dispatch.')
          current.semantic.runs[index] = { ...current.semantic.runs[index], modelDispatchedAt: run.modelDispatchedAt }
          return current
        })
        return this.modelRunner(this.llm, {
          route,
          envelope,
          maxOutputTokens: settingsAtStart.model.maxOutputTokens,
          timeoutMs: settingsAtStart.model.timeoutMs,
          signal: linked.signal,
        })
      })
      const completedAt = iso(this.now)
      const completed = {
        ...run,
        status: 'succeeded',
        completedAt,
        output: result.output,
        rawText: result.rawText,
        usage: result.usage,
        finish: result.finish,
      }
      await this.store.updateSession(sessionId, current => {
        const index = current.semantic.runs.findIndex(item => item.id === run.id)
        if (index < 0) throw new Error('Trace Insight lost a running analysis record.')
        current.semantic.runs[index] = completed
        if (coverageRole === 'primary' && current.semantic.coveredThroughSeq === completed.fromSeq - 1) {
          current.semantic.coveredThroughSeq = completed.toSeq
          current.semantic.continuitySummary = completed.output.continuitySummary
          current.semantic.primaryRunId = completed.id
          current.semantic.retry = null
        }
        return current
      })
      return { run: completed, cached: false }
    } catch (error) {
      const normalizedError = runError(error)
      const manualCancellation = mode === 'manual' && (normalizedError.code === 'MODEL_ABORTED' || signal?.aborted)
      let failed = {
        ...run,
        status: manualCancellation ? 'cancelled' : 'failed',
        completedAt: iso(this.now),
        error: normalizedError,
        rawText: normalizedError.rawText ?? '',
        usage: normalizedError.usage ?? null,
        finish: normalizedError.finish ?? null,
      }
      await this.store.updateSession(sessionId, current => {
        const index = current.semantic.runs.findIndex(item => item.id === run.id)
        if (mode === 'auto' && coverageRole === 'primary') {
          const previous = current.semantic.retry
          const configurationKey = retryConfigurationKey(route, settingsAtStart)
          const attempt = previous?.fromSeq === run.fromSeq
            && routeEquals(previous.route, route)
            && (!previous.configurationKey || previous.configurationKey === configurationKey)
            ? previous.attempt + 1
            : 1
          const retryable = !NON_RETRYABLE_MODEL_CODES.has(failed.error.code)
          const paused = !retryable || attempt >= MAX_AUTOMATIC_RETRY_ATTEMPTS
          const retryAt = paused ? null : new Date(this.now() + retryDelay(attempt)).toISOString()
          failed = {
            ...failed,
            retryAttempt: attempt,
            retryAt,
            retryPaused: paused,
            ...(paused ? { retryPauseReason: retryable ? 'attempt-limit' : 'non-retryable-error' } : {}),
          }
          current.semantic.retry = {
            fromSeq: run.fromSeq,
            route,
            attempt,
            notBefore: retryAt,
            code: failed.error.code,
            paused,
            configurationKey,
            ...(paused ? { pauseReason: retryable ? 'attempt-limit' : 'non-retryable-error' } : {}),
          }
        }
        if (index >= 0) current.semantic.runs[index] = failed
        return current
      })
      return { run: failed, cached: false }
    } finally {
      linked.dispose()
    }
  }

  withRetryBackoff(decision, history, settings) {
    if (!decision || decision.reason === 'disabled') return decision
    const retry = history.semantic.retry
    const route = settings?.defaultRoute
    const configurationMatches = !retry?.configurationKey
      || retry.configurationKey === retryConfigurationKey(route, settings)
    const retryAt = Date.parse(retry?.notBefore)
    if (retry?.fromSeq !== history.semantic.coveredThroughSeq + 1
      || !routeEquals(retry?.route, route)
      || !configurationMatches
      || decision.closedThroughSeq < retry.fromSeq) return decision
    if (retry.paused) {
      return {
        ...decision,
        due: false,
        reason: 'retry-paused',
        retryAttempt: retry.attempt,
        retryCode: retry.code,
        retryPauseReason: retry.pauseReason,
      }
    }
    if (!Number.isFinite(retryAt) || retryAt <= this.now()) return decision
    return {
      ...decision,
      due: false,
      reason: 'retry-backoff',
      retryAt: retry.notBefore,
      retryAttempt: retry.attempt,
      retryCode: retry.code,
    }
  }

  withAutomaticEnrollment(decision, history) {
    if (history.automatic?.enrolled
      || ['disabled', 'waiting-for-model', 'covered'].includes(decision?.reason)
      || decision?.closedThroughSeq <= history.semantic.coveredThroughSeq) return decision
    return {
      ...decision,
      due: false,
      reason: 'manual-backfill-required',
    }
  }

  async resumeAutomatic(sessionId, trigger) {
    const result = await this.maybeRunPrimary(sessionId, trigger)
    await this.recoverLive(sessionId)
    const observation = await this.observation(sessionId)
    const events = asArray(observation.log?.events)
    const report = this.analyzer({ rawSession: observation, sessionId })
    const history = await this.store.getSession(sessionId)
    const settings = (await this.effectiveSettings(sessionId, history)).effective
    const decision = this.withRetryBackoff(
      this.withAutomaticEnrollment(
        evaluateAutomaticTrigger({ events, history, report, settings, reason: 'resume-check' }),
        history,
      ),
      history,
      settings,
    )
    if (decision.reason === 'accumulating' && settings.defaultRoute) {
      this.scheduleQuietFromObservation(sessionId, observation, settings.auto.quietPeriodMs)
    } else if (decision.reason === 'retry-backoff') {
      this.scheduleQuiet(sessionId, Math.max(0, Date.parse(decision.retryAt) - this.now()))
    }
    return result
  }

  async maybeRunPrimary(sessionId, trigger) {
    let result = null
    for (let count = 0; count < this.maxSegmentsPerCycle; count += 1) {
      const observation = await this.observation(sessionId)
      await this.ensureProgrammatic(observation, trigger)
      const events = asArray(observation.log?.events)
      const report = this.analyzer({ rawSession: observation, sessionId })
      const history = await this.store.getSession(sessionId)
      const settings = (await this.effectiveSettings(sessionId, history)).effective
      const activePrimaryJob = asArray(history.jobs).find(job => job.coverageRole === 'primary' && ['queued', 'running'].includes(job.status))
      if (activePrimaryJob) {
        return result ?? { decision: { due: false, reason: 'manual-primary-active', jobId: activePrimaryJob.id } }
      }
      const evaluatedDecision = evaluateAutomaticTrigger({ events, history, report, settings, reason: trigger })
      const enrollmentDecision = this.withAutomaticEnrollment(evaluatedDecision, history)
      const decision = this.withRetryBackoff(enrollmentDecision, history, settings)
      if (!decision.due) {
        if (decision.reason === 'retry-backoff') {
          this.scheduleQuiet(sessionId, Math.max(0, Date.parse(decision.retryAt) - this.now()))
        }
        return result ?? { decision }
      }
      const fromSeq = history.semantic.coveredThroughSeq + 1
      const segments = planCoverageSegments({
        events,
        fromSeq,
        throughSeq: decision.closedThroughSeq,
        maxInputChars: evidenceCharsLimit(settings.auto.maxInputChars),
        maxEvents: settings.auto.maxPendingEvents,
      })
      const segment = segments[0]
      if (!segment) return result ?? { decision: { ...decision, due: false, reason: 'no-segment' } }
      const route = validateRoute(settings.defaultRoute)
      const segmentReport = reportForSegment(this.analyzer, observation, sessionId, segment, report)
      const envelope = buildSemanticEnvelope({
        rawSession: observation,
        segment,
        report: segmentReport,
        previousSummary: history.semantic.continuitySummary,
        maxChars: envelopeCharsLimit(settings.auto.maxInputChars),
      })
      try {
        result = await this.executeSemanticRun({
          sessionId,
          segment,
          route,
          envelope,
          mode: 'auto',
          coverageRole: 'primary',
          trigger: decision.reason,
        })
      } catch (error) {
        if (error?.code === 'PRIMARY_JOB_ACTIVE') {
          const current = await this.store.getSession(sessionId)
          const job = asArray(current.jobs).find(item => item.coverageRole === 'primary' && ['queued', 'running'].includes(item.status))
          return result ?? { decision: { due: false, reason: 'manual-primary-active', jobId: job?.id ?? null } }
        }
        throw error
      }
      if (result.run.status !== 'succeeded') {
        const retryAt = Date.parse(result.run.retryAt)
        if (!result.run.retryPaused) {
          this.scheduleQuiet(sessionId, Number.isFinite(retryAt)
            ? Math.max(0, retryAt - this.now())
            : RETRY_BASE_MS)
        }
        return result
      }
    }
    const settings = (await this.effectiveSettings(sessionId)).effective
    this.scheduleQuiet(sessionId, Math.min(settings.auto.quietPeriodMs, 5_000))
    return result
  }

  priorSummary(history, fromSeq, { coverageRole = 'primary', route } = {}) {
    if (coverageRole === 'provisional' || coverageRole === 'supplemental') {
      const chain = history.semantic.runs
        .filter(run => run.coverageRole === coverageRole
          && run.status === 'succeeded'
          && run.toSeq === fromSeq - 1
          && (!route || routeEquals(run.route, route)))
        .sort((left, right) => itemTime(right) - itemTime(left))[0]
      if (chain?.output?.continuitySummary) return chain.output.continuitySummary
    }
    const prior = history.semantic.runs
      .filter(run => run.coverageRole === 'primary' && run.status === 'succeeded' && run.toSeq < fromSeq)
      .sort((left, right) => right.toSeq - left.toSeq)[0]
    return prior?.output?.continuitySummary ?? ''
  }

  async previewAnalysis({ sessionId, mode = 'supplemental', fromSeq, toSeq, route, force = false }, signal) {
    if (!['primary', 'supplemental'].includes(mode)) {
      throw Object.assign(new Error('Manual analysis mode must be primary or supplemental.'), { code: 'INVALID_JOB_MODE' })
    }
    const observation = await this.observation(sessionId, signal)
    const events = asArray(observation.log?.events)
    validateRange(events, fromSeq, toSeq)
    const history = await this.store.getSession(sessionId)
    const scoped = await this.effectiveSettings(sessionId, history)
    const settings = scoped.effective
    const selectedRoute = validateRoute(route ?? settings.defaultRoute)
    const coverageRole = mode
    if (coverageRole === 'primary' && fromSeq !== history.semantic.coveredThroughSeq + 1) {
      throw Object.assign(new Error(`Primary backfill must start at Seq ${history.semantic.coveredThroughSeq + 1}.`), {
        code: 'PRIMARY_RANGE_GAP',
      })
    }
    const planned = planCoverageSegments({
      events,
      fromSeq,
      throughSeq: toSeq,
      maxInputChars: evidenceCharsLimit(settings.auto.maxInputChars),
      maxEvents: settings.auto.maxPendingEvents,
    })
    const report = this.analyzer({ rawSession: observation, sessionId })
    let previousSummary = this.priorSummary(history, fromSeq, { coverageRole, route: selectedRoute })
    let cacheCertain = true
    const segments = planned.map((segment, index) => {
      const segmentReport = reportForSegment(this.analyzer, observation, sessionId, segment, report)
      const envelope = buildSemanticEnvelope({
        rawSession: observation,
        segment,
        report: segmentReport,
        previousSummary,
        maxChars: envelopeCharsLimit(settings.auto.maxInputChars),
      })
      const cached = cacheCertain && !force ? this.cachedRun(history, stableInputHash(envelope), selectedRoute) : null
      if (cached) previousSummary = cached.output?.continuitySummary ?? previousSummary
      else cacheCertain = false
      return {
        index,
        fromSeq: segment.fromSeq,
        toSeq: segment.toSeq,
        fromTurn: segment.fromTurn ?? null,
        toTurn: segment.toTurn ?? null,
        estimatedChars: JSON.stringify(envelope).length,
        meaningfulEvents: segment.meaningfulEvents,
        cached: Boolean(cached),
        cacheCertain,
      }
    })
    const bindings = {
      historyRevision: history.revision ?? 0,
      globalSettingsRevision: scoped.revision.global,
      sessionSettingsRevision: scoped.revision.session,
      observedThroughSeq: events.at(-1)?.seq ?? -1,
      closedThroughSeq: closedTurnWindows(events).at(-1)?.toSeq ?? -1,
      analyzerVersion: ANALYZER_VERSION,
      promptVersion: SEMANTIC_PROMPT_VERSION,
    }
    const normalizedRequest = {
      sessionId,
      mode,
      fromSeq,
      toSeq,
      route: selectedRoute,
      force: force === true,
    }
    const previewToken = stableInputHash({ schemaVersion: 1, request: normalizedRequest, bindings })
    const cachedCalls = segments.filter(segment => segment.cached).length
    const resources = {
      plannedCalls: segments.length,
      modelCalls: segments.length - cachedCalls,
      cachedCalls,
      inputChars: segments.reduce((sum, segment) => sum + segment.estimatedChars, 0),
      tokens: null,
      durationMs: null,
      pricing: null,
      basis: 'serialized-current-plan',
    }
    return {
      previewToken,
      ...normalizedRequest,
      coverageRole,
      range: { fromSeq, toSeq },
      segments,
      calls: segments.length,
      modelCalls: segments.length - cachedCalls,
      cachedCalls,
      estimatedInputChars: segments.reduce((sum, segment) => sum + segment.estimatedChars, 0),
      resources,
      budgetAssessment: budgetAssessment(resources, settings.resourcePolicy),
      watermarkImpact: {
        currentThroughSeq: history.semantic.coveredThroughSeq,
        targetThroughSeq: coverageRole === 'primary' ? toSeq : history.semantic.coveredThroughSeq,
        advances: coverageRole === 'primary' && toSeq > history.semantic.coveredThroughSeq,
      },
      bindings,
      settingsSnapshot: settings,
    }
  }

  async startAnalysis(request, signal) {
    const sessionId = request.sessionId
    const started = await this.enqueue(sessionId, async () => {
      if (request.idempotencyKey) {
        const existingHistory = await this.store.getSession(sessionId)
        const prior = asArray(existingHistory.jobs).find(job => job.idempotencyKey === request.idempotencyKey)
        if (prior) {
          const requestedRoute = request.route ? validateRoute(request.route) : prior.route
          const sameRequest = prior.previewToken === request.previewToken
            && prior.mode === request.mode
            && prior.fromSeq === request.fromSeq
            && prior.toSeq === request.toSeq
            && prior.force === (request.force === true)
            && routeEquals(prior.route, requestedRoute)
          if (!sameRequest) {
            throw Object.assign(new Error('The idempotency key is already bound to another analysis request.'), { code: 'IDEMPOTENCY_CONFLICT' })
          }
          this.jobSessions.set(prior.id, sessionId)
          return { job: prior, created: false }
        }
      }
      const preview = await this.previewAnalysis(request, signal)
      if (request.previewToken && request.previewToken !== preview.previewToken) {
        throw Object.assign(new Error('The analysis preview is stale; preview the range again before starting.'), { code: 'PREVIEW_STALE' })
      }
      const overrideBudget = request.overrideBudget === true
      const overrideReason = boundedText(request.overrideReason, 1_000)
      if (overrideBudget && !overrideReason) {
        throw Object.assign(new Error('A resource override requires an audit reason.'), { code: 'RESOURCE_OVERRIDE_REASON_REQUIRED' })
      }
      if (preview.budgetAssessment.hardLimitExceeded && !overrideBudget) {
        throw Object.assign(new Error('The planned analysis exceeds the configured resource policy.'), {
          code: 'RESOURCE_LIMIT_EXCEEDED',
          details: { budgetAssessment: preview.budgetAssessment },
        })
      }
      const history = await this.store.getSession(sessionId)
      if (preview.coverageRole === 'primary') {
        const active = asArray(history.jobs).find(job => job.coverageRole === 'primary' && ['queued', 'running'].includes(job.status))
        const activeRun = asArray(history.semantic?.runs).find(run => run.coverageRole === 'primary' && run.status === 'running')
        if (active || activeRun) throw Object.assign(new Error('Another primary analysis already owns the current coverage gap.'), { code: 'PRIMARY_JOB_ACTIVE' })
        if (preview.fromSeq !== history.semantic.coveredThroughSeq + 1) {
          throw Object.assign(new Error('Primary coverage changed after preview; preview the range again.'), { code: 'PREVIEW_STALE' })
        }
      }
      const timestamp = iso(this.now)
      const job = {
        id: `job-${randomUUID()}`,
        kind: 'manual-analysis',
        sessionId,
        mode: preview.mode,
        coverageRole: preview.coverageRole,
        status: 'queued',
        route: preview.route,
        fromSeq: preview.fromSeq,
        toSeq: preview.toSeq,
        force: preview.force,
        previewToken: preview.previewToken,
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
        settingsSnapshot: preview.settingsSnapshot,
        bindings: preview.bindings,
        resourcePlan: preview.resources,
        budgetAssessment: preview.budgetAssessment,
        resourceOverride: overrideBudget ? {
          authorized: true,
          reason: overrideReason,
          authorizedAt: timestamp,
          previewToken: preview.previewToken,
          resourceFingerprint: stableInputHash(preview.resources),
        } : null,
        createdAt: timestamp,
        startedAt: null,
        completedAt: null,
        cancelRequestedAt: null,
        error: null,
        progress: { completed: 0, total: preview.segments.length, current: null },
        segments: preview.segments.map(segment => ({ ...segment, status: 'planned', runId: null, error: null })),
      }
      let saved
      try {
        saved = await this.store.updateSession(sessionId, current => {
          current.jobs.push(job)
          return current
        }, { expectedRevision: preview.bindings.historyRevision })
      } catch (error) {
        if (error?.code === 'REVISION_CONFLICT') {
          throw Object.assign(new Error('The analysis source changed after preview; preview the range again.'), { code: 'PREVIEW_STALE' })
        }
        throw error
      }
      const persisted = saved.jobs.find(item => item.id === job.id)
      this.jobSessions.set(job.id, sessionId)
      return { job: persisted, created: true }
    })
    if (started.created) {
      this.runInBackground(sessionId, 'manual-job', this.enqueue(sessionId, () => this.runAnalysisJob(sessionId, started.job.id)))
    }
    const job = boundedJobSummary(started.job)
    return { jobId: job.id, status: job.status, revision: job.revision, job }
  }

  async updateJob(sessionId, jobId, updater) {
    const history = await this.store.updateSession(sessionId, current => {
      const index = asArray(current.jobs).findIndex(job => job.id === jobId)
      if (index < 0) throw Object.assign(new Error('The requested analysis Job does not exist.'), { code: 'JOB_NOT_FOUND' })
      current.jobs[index] = updater(current.jobs[index]) ?? current.jobs[index]
      return current
    })
    return history.jobs.find(job => job.id === jobId)
  }

  async runAnalysisJob(sessionId, jobId) {
    const controller = new AbortController()
    this.jobControllers.set(jobId, controller)
    try {
      let job = await this.updateJob(sessionId, jobId, current => {
        if (jobTerminal(current.status)) return current
        if (current.cancelRequestedAt) {
          current.status = 'cancelled'
          current.completedAt = iso(this.now)
          for (const segment of current.segments) if (segment.status === 'planned') segment.status = 'cancelled'
          return current
        }
        current.status = 'running'
        current.startedAt = iso(this.now)
        return current
      })
      if (jobTerminal(job.status)) return { job }
      const observation = await this.observation(sessionId, controller.signal)
      const events = asArray(observation.log?.events)
      validateRange(events, job.fromSeq, job.toSeq)
      await this.ensureProgrammatic(observation, 'manual-job')
      const report = this.analyzer({ rawSession: observation, sessionId })
      let history = await this.store.getSession(sessionId)
      let previousSummary = this.priorSummary(history, job.fromSeq, { coverageRole: job.coverageRole, route: job.route })
      for (let index = 0; index < job.segments.length; index += 1) {
        history = await this.store.getSession(sessionId)
        job = history.jobs.find(item => item.id === jobId)
        if (controller.signal.aborted || job?.cancelRequestedAt) break
        const segment = job.segments[index]
        if (segment.status !== 'planned') continue
        if (job.coverageRole === 'primary' && history.semantic.coveredThroughSeq !== segment.fromSeq - 1) {
          throw Object.assign(new Error(`Primary coverage no longer begins at Seq ${segment.fromSeq}.`), { code: 'PRIMARY_COVERAGE_CONFLICT' })
        }
        const segmentRunId = `semantic-${randomUUID()}`
        await this.updateJob(sessionId, jobId, current => {
          current.progress.current = index
          current.segments[index].status = 'running'
          current.segments[index].runId = segmentRunId
          current.segments[index].startedAt = iso(this.now)
          return current
        })
        const segmentReport = reportForSegment(this.analyzer, observation, sessionId, segment, report)
        const envelope = buildSemanticEnvelope({
          rawSession: observation,
          segment,
          report: segmentReport,
          previousSummary,
          maxChars: envelopeCharsLimit(job.settingsSnapshot.auto.maxInputChars),
        })
        const result = await this.executeSemanticRun({
          sessionId,
          segment,
          route: job.route,
          envelope,
          mode: 'manual',
          coverageRole: job.coverageRole,
          trigger: job.coverageRole === 'primary' ? 'manual-primary-backfill' : 'manual-supplemental-compare',
          force: job.force,
          signal: controller.signal,
          settingsSnapshot: job.settingsSnapshot,
          runId: segmentRunId,
          jobId,
          jobSegmentIndex: index,
        })
        const cancelled = controller.signal.aborted || result.run.error?.code === 'MODEL_ABORTED'
        job = await this.updateJob(sessionId, jobId, current => {
          const currentSegment = current.segments[index]
          currentSegment.runId = result.run.id
          currentSegment.completedAt = iso(this.now)
          currentSegment.status = cancelled ? 'cancelled' : result.run.status
          currentSegment.error = result.run.error ?? null
          if (result.run.status === 'succeeded') current.progress.completed += 1
          current.progress.current = null
          return current
        })
        if (result.run.status !== 'succeeded') break
        previousSummary = result.run.output?.continuitySummary ?? previousSummary
      }
      job = await this.updateJob(sessionId, jobId, current => {
        const cancelled = controller.signal.aborted || current.cancelRequestedAt
          || current.segments.some(segment => segment.status === 'cancelled')
        const failedSegment = current.segments.find(segment => segment.status === 'failed' || segment.status === 'interrupted')
        if (cancelled) {
          current.status = 'cancelled'
          for (const segment of current.segments) if (segment.status === 'planned') segment.status = 'cancelled'
        } else if (failedSegment) {
          current.status = 'failed'
          current.error = failedSegment.error ?? { code: 'ANALYSIS_FAILED', message: 'A manual analysis segment failed.' }
        } else {
          current.status = 'succeeded'
        }
        current.progress.current = null
        current.completedAt = iso(this.now)
        return current
      })
      return { job }
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.code === 'MODEL_ABORTED'
      const job = await this.updateJob(sessionId, jobId, current => {
        if (jobTerminal(current.status)) return current
        current.status = cancelled ? 'cancelled' : 'failed'
        current.completedAt = iso(this.now)
        current.progress.current = null
        current.error = cancelled ? null : runError(error)
        for (const segment of current.segments) {
          if (segment.status === 'running') {
            segment.status = cancelled ? 'cancelled' : 'failed'
            if (!cancelled) segment.error = runError(error)
          } else if (cancelled && segment.status === 'planned') segment.status = 'cancelled'
        }
        return current
      })
      return { job }
    } finally {
      this.jobControllers.delete(jobId)
    }
  }

  async locateJob(jobId, sessionId) {
    const knownSession = sessionId ?? this.jobSessions.get(jobId)
    if (knownSession) {
      const history = await this.store.getSession(knownSession)
      const job = asArray(history.jobs).find(item => item.id === jobId)
      if (job) {
        this.jobSessions.set(jobId, knownSession)
        return { sessionId: knownSession, history, job }
      }
    }
    const histories = typeof this.store.listSessions === 'function' ? await this.store.listSessions() : []
    for (const history of histories) {
      const job = asArray(history.jobs).find(item => item.id === jobId)
      if (!job) continue
      this.jobSessions.set(jobId, history.sessionId)
      return { sessionId: history.sessionId, history, job }
    }
    throw Object.assign(new Error('The requested analysis Job does not exist.'), { code: 'JOB_NOT_FOUND' })
  }

  async readAnalysisJob(jobId, sessionId) {
    const found = await this.locateJob(jobId, sessionId)
    return { job: boundedJobSummary(found.job) }
  }

  async cancelAnalysis(jobId, { sessionId, expectedRevision } = {}) {
    const found = await this.locateJob(jobId, sessionId)
    const job = await this.updateJob(found.sessionId, jobId, current => {
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw revisionError(expectedRevision, current.revision)
      }
      if (jobTerminal(current.status)) return current
      current.cancelRequestedAt = iso(this.now)
      if (current.status === 'queued') {
        current.status = 'cancelled'
        current.completedAt = current.cancelRequestedAt
        for (const segment of current.segments) if (segment.status === 'planned') segment.status = 'cancelled'
      }
      return current
    })
    this.jobControllers.get(jobId)?.abort(Object.assign(new Error('Manual analysis was cancelled.'), { code: 'MODEL_ABORTED' }))
    return { job: boundedJobSummary(job) }
  }

  async runManual({ sessionId, fromSeq, toSeq, route, force = false }, signal) {
    const preview = await this.previewAnalysis({ sessionId, mode: 'supplemental', fromSeq, toSeq, route, force }, signal)
    if (preview.budgetAssessment.hardLimitExceeded) {
      throw Object.assign(new Error('The legacy manual analysis exceeds the configured resource policy.'), {
        code: 'RESOURCE_LIMIT_EXCEEDED',
        details: { budgetAssessment: preview.budgetAssessment },
      })
    }
    return this.enqueue(sessionId, async () => {
      const observation = await this.observation(sessionId, signal)
      const events = asArray(observation.log?.events)
      validateRange(events, fromSeq, toSeq)
      await this.ensureProgrammatic(observation, 'manual')
      const history = await this.store.getSession(sessionId)
      const settings = (await this.effectiveSettings(sessionId, history)).effective
      const currentBudget = budgetAssessment(preview.resources, settings.resourcePolicy)
      if (currentBudget.hardLimitExceeded) {
        throw Object.assign(new Error('The legacy manual analysis exceeds the current resource policy.'), {
          code: 'RESOURCE_LIMIT_EXCEEDED',
          details: { budgetAssessment: currentBudget },
        })
      }
      const selectedRoute = validateRoute(route ?? settings.defaultRoute)
      const report = this.analyzer({ rawSession: observation, sessionId })
      const segments = planCoverageSegments({
        events,
        fromSeq,
        throughSeq: toSeq,
        maxInputChars: evidenceCharsLimit(settings.auto.maxInputChars),
        maxEvents: settings.auto.maxPendingEvents,
      })
      let previousSummary = this.priorSummary(history, fromSeq, { coverageRole: 'supplemental', route: selectedRoute })
      const results = []
      for (const segment of segments) {
        const segmentReport = reportForSegment(this.analyzer, observation, sessionId, segment, report)
        const envelope = buildSemanticEnvelope({
          rawSession: observation,
          segment,
          report: segmentReport,
          previousSummary,
          maxChars: envelopeCharsLimit(settings.auto.maxInputChars),
        })
        const result = await this.executeSemanticRun({
          sessionId,
          segment,
          route: selectedRoute,
          envelope,
          mode: 'manual',
          coverageRole: 'supplemental',
          trigger: 'manual-segment',
          force,
          signal,
          settingsSnapshot: settings,
        })
        results.push(result)
        if (result.run.status !== 'succeeded') break
        previousSummary = result.run.output.continuitySummary
      }
      return { results }
    })
  }

  async readStatus(sessionId) {
    const history = await this.store.getSession(sessionId)
    const scoped = await this.effectiveSettings(sessionId, history)
    return this.statusForHistory(sessionId, history, scoped)
  }

  statusForHistory(sessionId, history, scoped) {
    const closedThroughSeq = history.lastClosedSeq ?? history.programmatic.coveredThroughSeq
    const semanticThroughSeq = history.semantic.coveredThroughSeq
    const nextTrigger = this.quietDueAt.get(sessionId) ?? history.semantic.retry?.notBefore ?? null
    const latestProgrammatic = latestByTime(history.programmatic?.checkpoints)
    const latestSemanticSuccess = latestByTime(history.semantic?.runs, run => run.status === 'succeeded')
    const latestSemanticFailure = latestByTime(history.semantic?.runs, run => ['failed', 'cancelled', 'interrupted'].includes(run.status))
    const latestDiagnostic = latestByTime(history.diagnostics, diagnostic => !diagnostic.resolvedAt)
    const liveItems = asArray(history.live?.items)
    const openLive = liveItems.find(item => item.state === 'open' || item.state === 'finalizing') ?? null
    const provisional = history.live?.provisional ?? EMPTY_PROVISIONAL
    const stableThroughSeq = openLive && Number.isSafeInteger(openLive.stableThroughSeq)
      ? openLive.stableThroughSeq
      : (openLive ? openLive.fromSeq - 1 : closedThroughSeq)
    return {
      sessionId,
      coverage: {
        observedThroughSeq: history.lastObservedSeq,
        closedThroughSeq,
        stableThroughSeq,
        provisionalThroughSeq: Number.isSafeInteger(provisional.throughSeq) ? provisional.throughSeq : -1,
        openTurn: openLive?.turn ?? null,
        programmaticThroughSeq: history.programmatic.coveredThroughSeq,
        semanticThroughSeq,
        semanticPendingFromSeq: semanticThroughSeq < closedThroughSeq ? semanticThroughSeq + 1 : null,
        semanticPendingToSeq: semanticThroughSeq < closedThroughSeq ? closedThroughSeq : null,
        complete: semanticThroughSeq >= closedThroughSeq,
      },
      activeJobs: asArray(history.jobs).filter(job => ['queued', 'running'].includes(job.status)).map(boundedJobSummary),
      retry: history.semantic.retry ?? null,
      nextTrigger,
      autoDecision: storedAutomaticDecision(history, scoped.effective, nextTrigger),
      live: {
        revision: history.live?.revision ?? 0,
        active: Boolean(openLive),
        item: openLive ? {
          id: openLive.id,
          turn: openLive.turn,
          fromSeq: openLive.fromSeq,
          observedThroughSeq: openLive.observedThroughSeq,
          stableThroughSeq: openLive.stableThroughSeq,
          lastMeaningfulAt: openLive.lastMeaningfulAt ?? null,
          updatedAt: openLive.updatedAt ?? null,
          state: openLive.state,
          analyzerVersion: openLive.analyzerVersion ?? null,
          report: openLive.report ?? null,
        } : null,
        provisional: {
          turn: provisional.turn ?? null,
          throughSeq: Number.isSafeInteger(provisional.throughSeq) ? provisional.throughSeq : -1,
          callsInTurn: provisional.callsInTurn ?? 0,
          lastDispatchedAt: provisional.lastDispatchedAt ?? null,
          lastSucceededAt: provisional.lastSucceededAt ?? null,
          running: this.activeProvisional.has(sessionId),
          estimate: provisionalEstimate(openLive, provisional, scoped.effective),
        },
      },
      latest: {
        semanticSuccess: boundedSemanticSummary(latestSemanticSuccess),
        semanticFailure: boundedSemanticSummary(latestSemanticFailure),
        diagnostic: boundedDiagnosticSummary(latestDiagnostic),
        programmatic: boundedProgrammaticSummary(latestProgrammatic),
      },
      reportSummary: boundedProgrammaticSummary(latestProgrammatic),
      revisions: {
        history: history.revision ?? 0,
        timeline: history.timelineRevision ?? history.revision ?? 0,
        programmatic: history.programmaticRevision ?? 0,
        annotations: history.annotations?.revision ?? 0,
        settingsGlobal: scoped.revision.global,
        settingsSession: scoped.revision.session,
        live: history.live?.revision ?? 0,
      },
      effectiveSettings: scoped.effective,
      settingsSource: scoped.source,
      settingsScope: scoped,
      lastUpdatedAt: history.updatedAt,
    }
  }

  historyPageFromHistory(sessionId, history, { cursor, limit = 80, filters = {} } = {}) {
    const appliedFilters = normalizeHistoryFilters(filters)
    const filtersHash = stableInputHash(appliedFilters)
    const revision = history.revision ?? 0
    const cursorRevision = history.timelineRevision ?? revision
    const boundedLimit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Number.isSafeInteger(limit) ? limit : 80))
    const items = historyItemCollections(history)
      .map(item => item.historyKind === 'job' ? boundedJobSummary(item) : item)
      .filter(item => itemMatchesFilters(item, appliedFilters))
      .sort((left, right) => compareSortTuple(historySortTuple(left), historySortTuple(right)))

    let start = 0
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      if (typeof cursor === 'string' && cursor.length > MAX_CURSOR_CHARS) {
        throw Object.assign(new Error('History cursor is invalid.'), { code: 'INVALID_CURSOR' })
      }
      if (Number.isSafeInteger(cursor) || /^\d+$/.test(String(cursor))) {
        // Request-only compatibility for the old offset cursor. Every response
        // below emits the revision-bound keyset form.
        start = Number(cursor)
      } else {
        const decoded = decodeCursor(cursor, this.cursorSecret, this.cursorIssuer)
        if (decoded.kind !== 'history' || decoded.version !== 1) {
          throw Object.assign(new Error('History cursor type is invalid.'), { code: 'INVALID_CURSOR' })
        }
        if (decoded.sessionId !== sessionId || decoded.filtersHash !== filtersHash
          || !Number.isSafeInteger(decoded.revision) || decoded.revision < 0 || decoded.revision > cursorRevision) {
          throw Object.assign(new Error('History changed or the cursor belongs to another query.'), { code: 'CURSOR_STALE' })
        }
        const index = items.findIndex(item => JSON.stringify(historySortTuple(item)) === JSON.stringify(decoded.last))
        if (index < 0) throw Object.assign(new Error('History cursor no longer identifies a stable record.'), { code: 'CURSOR_STALE' })
        start = index + 1
      }
    }
    if (!Number.isSafeInteger(start) || start < 0 || start > items.length) {
      throw Object.assign(new Error('History cursor is invalid.'), { code: 'INVALID_CURSOR' })
    }
    const page = items.slice(start, start + boundedLimit)
    const nextCursor = start + page.length < items.length && page.length > 0
      ? encodeCursor({
          kind: 'history', version: 1, sessionId, revision: cursorRevision, filtersHash,
          last: historySortTuple(page.at(-1)),
        }, this.cursorSecret, this.cursorIssuer)
      : null
    return { items: page, nextCursor, total: items.length, revision, cursorRevision, appliedFilters }
  }

  async historyPage(sessionId, { cursor, limit = 80, filters = {} } = {}) {
    const history = await this.store.getSession(sessionId)
    return this.historyPageFromHistory(sessionId, history, { cursor, limit, filters })
  }

  async historyDelta(sessionId, sinceRevision, filters = {}) {
    const history = await this.store.getSession(sessionId)
    const currentRevision = history.revision ?? 0
    if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0 || sinceRevision > currentRevision) {
      throw Object.assign(new Error('History revision is invalid.'), { code: 'INVALID_REVISION' })
    }
    const appliedFilters = normalizeHistoryFilters(filters)
    if (sinceRevision === currentRevision) return { reset: false, added: [], updated: [], removed: [], revision: currentRevision, appliedFilters }
    const changes = asArray(history.changes).filter(change => change.revision > sinceRevision)
    const oldestTracked = asArray(history.changes).at(0)?.revision
    const floorRevision = Number.isSafeInteger(history.changesFloorRevision)
      ? history.changesFloorRevision
      : (Number.isSafeInteger(oldestTracked) ? Math.max(0, oldestTracked - 1) : 0)
    if (sinceRevision < floorRevision) {
      return { reset: true, reload: true, reason: 'change-log-truncated', added: [], updated: [], removed: [], revision: currentRevision, appliedFilters }
    }
    const hasFilters = stableInputHash(appliedFilters) !== stableInputHash(normalizeHistoryFilters({}))
    if (hasFilters && changes.some(change => !['settings', 'annotation'].includes(change.kind))) {
      return { reset: true, reload: true, reason: 'filtered-membership-may-have-changed', added: [], updated: [], removed: [], revision: currentRevision, appliedFilters }
    }
    const currentItems = new Map(historyItemCollections(history)
      .map(item => item.historyKind === 'job' ? boundedJobSummary(item) : item)
      .map(item => [`${item.historyKind}:${item.id}`, item]))
    const collapsed = new Map()
    for (const change of changes) {
      if (change.kind === 'settings' || change.kind === 'annotation') continue
      const key = `${change.kind}:${change.id}`
      const prior = collapsed.get(key)
      collapsed.set(key, {
        ...change,
        operation: prior?.operation === 'added' && change.operation !== 'removed' ? 'added' : change.operation,
      })
    }
    const added = []
    const updated = []
    const removed = []
    for (const [key, change] of collapsed) {
      if (change.operation === 'removed') removed.push({ kind: change.kind, id: change.id })
      else if (change.operation === 'added') {
        const item = currentItems.get(key)
        if (item) added.push(item)
      } else {
        const item = currentItems.get(key)
        if (item) updated.push(item)
      }
    }
    return { reset: false, added, updated, removed, revision: currentRevision, appliedFilters }
  }

  async readBootstrap(sessionId, { historyLimit = 80, filters = {} } = {}) {
    const history = await this.store.getSession(sessionId)
    const scoped = await this.effectiveSettings(sessionId, history)
    const status = this.statusForHistory(sessionId, history, scoped)
    const historyPage = this.historyPageFromHistory(sessionId, history, { limit: historyLimit, filters })
    const annotations = history.annotations ?? { revision: 0, items: [] }
    const allTurns = [...new Map(asArray(history.programmatic?.checkpoints)
      .filter(item => Number.isSafeInteger(item.fromTurn) && item.fromTurn === item.toTurn)
      .sort((left, right) => itemTime(left) - itemTime(right))
      .map(item => [item.fromTurn, {
        turn: item.fromTurn,
        fromSeq: item.fromSeq,
        toSeq: item.toSeq,
        startedAt: item.startedAt ?? null,
        completedAt: item.completedAt ?? item.capturedAt ?? null,
        reason: item.report?.status?.code ?? null,
      }])).values()].sort((left, right) => left.turn - right.turn)
    const turns = allTurns.slice(-MAX_BOOTSTRAP_TURNS)
    const reportSummary = status.reportSummary ?? null
    return {
      serviceVersion: TRACE_INSIGHT_SERVICE_VERSION,
      status,
      settingsScope: scoped,
      history: historyPage,
      annotations: {
        revision: annotations.revision ?? 0,
        total: asArray(annotations.items).length,
        activeCount: asArray(annotations.items).filter(item => !item.archivedAt).length,
      },
      latest: status.latest,
      reportSummary,
      report: reportSummary ? { status: reportSummary.status, summary: reportSummary.summary } : null,
      autoDecision: status.autoDecision,
      turns,
      turnIndex: {
        total: allTurns.length,
        returned: turns.length,
        truncated: turns.length < allTurns.length,
        fromTurn: turns.at(0)?.turn ?? null,
        toTurn: turns.at(-1)?.turn ?? null,
      },
      resources: semanticResources(history.semantic.runs),
      live: {
        revision: history.live?.revision ?? 0,
        items: cloneLiveItems(history.live?.items ?? []),
        provisional: { ...(history.live?.provisional ?? EMPTY_PROVISIONAL) },
      },
      researchRevision: history.timelineRevision ?? history.revision ?? 0,
    }
  }

  async syncProgrammatic(sessionId, { historyLimit = 80, filters = {} } = {}, signal) {
    return this.enqueue(sessionId, async () => {
      const before = await this.store.getSession(sessionId)
      const previousRevision = before.programmaticRevision ?? 0
      const observation = await this.observation(sessionId, signal)
      const after = await this.ensureProgrammatic(observation, 'explicit-sync')
      const bootstrap = await this.readBootstrap(sessionId, { historyLimit, filters })
      const programmaticRevision = after.programmaticRevision ?? previousRevision
      return {
        ...bootstrap,
        sync: {
          changed: programmaticRevision !== previousRevision,
          previousProgrammaticRevision: previousRevision,
          programmaticRevision,
          observedThroughSeq: after.lastObservedSeq,
        },
      }
    })
  }

  async compareRuns(sessionId, leftRunId, rightRunId) {
    if (leftRunId === rightRunId) throw Object.assign(new Error('Comparison requires two distinct analysis runs.'), { code: 'INVALID_COMPARISON' })
    const history = await this.store.getSession(sessionId)
    const left = asArray(history.semantic?.runs).find(run => run.id === leftRunId)
    const right = asArray(history.semantic?.runs).find(run => run.id === rightRunId)
    if (!left || !right) throw Object.assign(new Error('One or both analysis runs do not exist.'), { code: 'RUN_NOT_FOUND' })
    return { sessionId, revision: history.revision ?? 0, ...compareSemanticRuns(left, right) }
  }

  normalizeAnnotation(annotation, existing = null) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
      throw Object.assign(new Error('Annotation must be an object.'), { code: 'INVALID_ANNOTATION' })
    }
    const kind = String(annotation.kind ?? existing?.kind ?? '').trim().toLowerCase()
    if (!['note', 'bookmark', 'verdict'].includes(kind)) {
      throw Object.assign(new Error('Annotation kind must be note, bookmark, or verdict.'), { code: 'INVALID_ANNOTATION' })
    }
    const target = annotation.target ?? existing?.target
    const targetKind = String(target?.kind ?? '').trim().toLowerCase()
    if (!['session', 'seq', 'range', 'semantic', 'programmatic'].includes(targetKind)) {
      throw Object.assign(new Error('Annotation target is invalid.'), { code: 'INVALID_ANNOTATION' })
    }
    const normalizedTarget = { kind: targetKind }
    if (targetKind === 'seq') {
      if (!Number.isSafeInteger(target.seq) || target.seq < 0) throw Object.assign(new Error('Annotation Seq target is invalid.'), { code: 'INVALID_ANNOTATION' })
      normalizedTarget.seq = target.seq
    } else if (targetKind === 'range') {
      if (!Number.isSafeInteger(target.fromSeq) || !Number.isSafeInteger(target.toSeq) || target.fromSeq < 0 || target.toSeq < target.fromSeq) {
        throw Object.assign(new Error('Annotation range target is invalid.'), { code: 'INVALID_ANNOTATION' })
      }
      normalizedTarget.fromSeq = target.fromSeq
      normalizedTarget.toSeq = target.toSeq
    } else if (targetKind === 'semantic' || targetKind === 'programmatic') {
      const id = String(target.id ?? '').trim()
      if (!id || id.length > 512) throw Object.assign(new Error('Annotation record target is invalid.'), { code: 'INVALID_ANNOTATION' })
      normalizedTarget.id = id
    }
    const text = boundedText(annotation.text ?? existing?.text ?? '', 12_000)
    const verdict = String(annotation.verdict ?? existing?.verdict ?? '').trim().toLowerCase()
    const allowedVerdicts = new Set(['confirmed', 'disputed', 'needs-review', 'accepted', 'rejected', 'inconclusive'])
    if (kind === 'note' && !text) throw Object.assign(new Error('A note requires text.'), { code: 'INVALID_ANNOTATION' })
    if (kind === 'verdict' && !allowedVerdicts.has(verdict)) {
      throw Object.assign(new Error('A verdict annotation requires a supported verdict.'), { code: 'INVALID_ANNOTATION' })
    }
    const tags = normalizedStrings(annotation.tags ?? existing?.tags).slice(0, 20).map(tag => tag.slice(0, 100))
    return {
      kind,
      target: normalizedTarget,
      ...(text ? { text } : {}),
      ...(kind === 'verdict' ? { verdict } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    }
  }

  assertAnnotationTarget(history, target) {
    if (target.kind === 'semantic' && !asArray(history.semantic?.runs).some(run => run.id === target.id)) {
      throw Object.assign(new Error('The annotation semantic target does not exist.'), { code: 'ANNOTATION_TARGET_NOT_FOUND' })
    }
    if (target.kind === 'programmatic' && !asArray(history.programmatic?.checkpoints).some(item => item.id === target.id)) {
      throw Object.assign(new Error('The annotation programmatic target does not exist.'), { code: 'ANNOTATION_TARGET_NOT_FOUND' })
    }
    const upper = target.kind === 'seq' ? target.seq : (target.kind === 'range' ? target.toSeq : null)
    if (Number.isSafeInteger(upper) && upper > history.lastObservedSeq) {
      throw Object.assign(new Error('The annotation target lies beyond observed history.'), { code: 'ANNOTATION_TARGET_NOT_FOUND' })
    }
  }

  async listAnnotations(sessionId, { includeArchived = false, cursor, limit = 100, kinds = [], target } = {}) {
    const history = await this.store.getSession(sessionId)
    const annotationState = history.annotations ?? { revision: 0, items: [] }
    const normalizedKinds = normalizedStrings(kinds)
    const targetFilter = target && typeof target === 'object' ? target : null
    const filtersHash = stableInputHash({ includeArchived: includeArchived === true, kinds: normalizedKinds, target: targetFilter })
    const items = asArray(annotationState.items)
      .filter(item => includeArchived === true || !item.archivedAt)
      .filter(item => normalizedKinds.length === 0 || normalizedKinds.includes(String(item.kind).toLowerCase()))
      .filter(item => !targetFilter || Object.entries(targetFilter).every(([key, value]) => item.target?.[key] === value))
      .sort((left, right) => annotationTime(right) - annotationTime(left) || String(left.id).localeCompare(String(right.id)))
    let start = 0
    if (cursor) {
      const decoded = decodeCursor(cursor, this.cursorSecret, this.cursorIssuer)
      if (decoded.kind !== 'annotations' || decoded.sessionId !== sessionId || decoded.revision !== annotationState.revision || decoded.filtersHash !== filtersHash) {
        throw Object.assign(new Error('Annotation cursor is stale.'), { code: 'CURSOR_STALE' })
      }
      const index = items.findIndex(item => item.id === decoded.last?.id && annotationTime(item) === decoded.last?.time)
      if (index < 0) throw Object.assign(new Error('Annotation cursor is stale.'), { code: 'CURSOR_STALE' })
      start = index + 1
    }
    const boundedLimit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Number.isSafeInteger(limit) ? limit : 100))
    const page = items.slice(start, start + boundedLimit)
    const nextCursor = start + page.length < items.length && page.length > 0
      ? encodeCursor({ kind: 'annotations', version: 1, sessionId, revision: annotationState.revision, filtersHash, last: { time: annotationTime(page.at(-1)), id: page.at(-1).id } }, this.cursorSecret, this.cursorIssuer)
      : null
    return { items: page, nextCursor, total: items.length, revision: annotationState.revision ?? 0 }
  }

  async upsertAnnotation(sessionId, annotation, expectedRevision) {
    const timestamp = iso(this.now)
    let savedId
    const history = await this.store.updateSession(sessionId, current => {
      const actualRevision = current.annotations?.revision ?? 0
      if (expectedRevision !== undefined && expectedRevision !== actualRevision) throw revisionError(expectedRevision, actualRevision)
      const id = typeof annotation?.id === 'string' && annotation.id.trim() ? annotation.id.trim() : `annotation-${randomUUID()}`
      if (id.length > 512) throw Object.assign(new Error('Annotation id is invalid.'), { code: 'INVALID_ANNOTATION' })
      const index = asArray(current.annotations?.items).findIndex(item => item.id === id)
      const existing = index >= 0 ? current.annotations.items[index] : null
      const normalized = this.normalizeAnnotation(annotation, existing)
      this.assertAnnotationTarget(current, normalized.target)
      const item = {
        ...existing,
        ...normalized,
        id,
        author: 'human',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        archivedAt: existing?.archivedAt ?? null,
      }
      if (index >= 0) current.annotations.items[index] = item
      else current.annotations.items.push(item)
      savedId = id
      return current
    })
    return { annotation: history.annotations.items.find(item => item.id === savedId), revision: history.annotations.revision }
  }

  async archiveAnnotation(sessionId, id, expectedRevision) {
    const timestamp = iso(this.now)
    const history = await this.store.updateSession(sessionId, current => {
      const actualRevision = current.annotations?.revision ?? 0
      if (expectedRevision !== undefined && expectedRevision !== actualRevision) throw revisionError(expectedRevision, actualRevision)
      const index = asArray(current.annotations?.items).findIndex(item => item.id === id)
      if (index < 0) throw Object.assign(new Error('Annotation does not exist.'), { code: 'ANNOTATION_NOT_FOUND' })
      if (!current.annotations.items[index].archivedAt) {
        current.annotations.items[index] = { ...current.annotations.items[index], archivedAt: timestamp, updatedAt: timestamp }
      }
      return current
    })
    return { annotation: history.annotations.items.find(item => item.id === id), revision: history.annotations.revision }
  }

  researchMaps(selected) {
    const maps = { phases: new Map(), findings: new Map(), tools: new Map(), models: new Map(), triggers: new Map() }
    for (const item of selected) {
      const baseRef = referenceFor(item)
      if (item.trigger) addBucket(maps.triggers, String(item.trigger).toLowerCase(), item.trigger, baseRef)
      if (item.historyKind === 'semantic') {
        const modelKey = `${item.route?.provider ?? 'unknown'}/${item.route?.model ?? 'unknown'}${item.route?.reasoningEffort ? `/${item.route.reasoningEffort}` : ''}`
        addBucket(maps.models, modelKey.toLowerCase(), modelKey, baseRef)
        for (const [rootCauseIndex, rootCause] of asArray(item.output?.rootCauses).entries()) {
          addBucket(maps.findings, `semantic:${rootCause}`.toLowerCase(), rootCause, referenceFor(item, { rootCauseIndex }), { layer: 'semantic' })
        }
      }
      if (item.historyKind === 'programmatic') {
        for (const [phaseIndex, phase] of asArray(item.report?.phases).entries()) {
          addBucket(maps.phases, String(phase.title ?? phase.status ?? 'phase').toLowerCase(), phase.title ?? phase.status ?? 'Phase', referenceFor(item, { phaseIndex, fromSeq: phase.seqStart ?? item.fromSeq, toSeq: phase.seqEnd ?? item.toSeq }))
        }
        for (const [findingIndex, finding] of asArray(item.report?.findings).entries()) {
          const findingKey = String(finding.category ?? finding.title ?? 'finding').toLowerCase()
          addBucket(maps.findings, `programmatic:${findingKey}`, finding.category ?? finding.title ?? 'Finding', referenceFor(item, { findingIndex }), { layer: 'programmatic', severity: finding.severity ?? null })
          for (const [evidenceIndex, evidence] of asArray(finding.evidence).entries()) {
            if (!evidence?.toolName) continue
            addBucket(maps.tools, String(evidence.toolName).toLowerCase(), evidence.toolName, referenceFor(item, { findingIndex, evidenceIndex, seq: evidence.seq ?? null }))
          }
        }
      }
    }
    return maps
  }

  researchComparisons(selected) {
    const semantic = selected.filter(item => item.historyKind === 'semantic')
    const groups = new Map()
    for (const run of semantic) {
      if (typeof run.inputHash !== 'string' || !run.inputHash) continue
      const key = `${run.fromSeq}:${run.toSeq}:${run.inputHash}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(run)
    }
    const comparisons = []
    for (const runs of groups.values()) {
      const ordered = runs.sort((left, right) => itemTime(left) - itemTime(right) || String(left.id).localeCompare(String(right.id)))
      for (let index = 1; index < ordered.length; index += 1) {
        const value = compareSemanticRuns(ordered[index - 1], ordered[index])
        if (value.comparable) comparisons.push(value)
      }
    }
    const pairRefs = comparison => [comparison.left, comparison.right].map(run => ({
      kind: 'semantic', id: run.id, runId: run.id,
      fromSeq: run.range.fromSeq, toSeq: run.range.toSeq,
    }))
    const crossLayerConflicts = []
    const programmatic = selected.filter(item => item.historyKind === 'programmatic')
    for (const run of semantic.filter(item => item.status === 'succeeded')) {
      const checkpoints = programmatic
        .filter(item => item.fromSeq >= run.fromSeq && item.toSeq <= run.toSeq)
        .sort((left, right) => left.fromSeq - right.fromSeq || left.toSeq - right.toSeq)
      if (checkpoints.length === 0 || checkpoints[0].fromSeq !== run.fromSeq || checkpoints.at(-1).toSeq !== run.toSeq) continue
      let expected = run.fromSeq
      let continuous = true
      for (const checkpoint of checkpoints) {
        if (checkpoint.fromSeq !== expected) { continuous = false; break }
        expected = checkpoint.toSeq + 1
      }
      if (!continuous || expected !== run.toSeq + 1) continue
      const statuses = checkpoints.map(item => String(item.report?.status?.code ?? '').toLowerCase())
      const highFinding = checkpoints.some(item => asArray(item.report?.findings).some(finding => finding?.severity === 'high'))
      const programmaticRisk = highFinding || statuses.some(status => status === 'blocked' || status === 'failed')
      const programmaticClean = !highFinding && statuses.every(status => status === 'complete')
      const modelRisk = run.output?.risk
      if (!((programmaticRisk && modelRisk === 'low') || (programmaticClean && modelRisk === 'high'))) continue
      const semanticRef = referenceFor(run, { basisRole: 'semantic-risk', risk: modelRisk })
      const coverageRefs = checkpoints.map(item => referenceFor(item, {
        basisRole: programmaticClean ? 'programmatic-complete-coverage' : 'programmatic-range-coverage',
        status: item.report?.status?.code ?? null,
      }))
      const riskRefs = []
      if (programmaticRisk) {
        for (const checkpoint of checkpoints) {
          const status = String(checkpoint.report?.status?.code ?? '').toLowerCase()
          if (status === 'blocked' || status === 'failed') {
            riskRefs.push(referenceFor(checkpoint, { basisRole: 'programmatic-status', status }))
          }
          for (const [findingIndex, finding] of asArray(checkpoint.report?.findings).entries()) {
            if (finding?.severity !== 'high') continue
            const evidence = asArray(finding.evidence)
            if (evidence.length === 0) {
              riskRefs.push(referenceFor(checkpoint, { basisRole: 'programmatic-high-finding', severity: 'high', findingIndex }))
            } else {
              for (const [evidenceIndex, item] of evidence.entries()) {
                riskRefs.push(referenceFor(checkpoint, {
                  basisRole: 'programmatic-high-finding-evidence', severity: 'high', findingIndex, evidenceIndex,
                  ...(Number.isSafeInteger(item?.seq) ? { seq: item.seq } : {}),
                  ...(item?.toolName ? { toolName: item.toolName } : {}),
                }))
              }
            }
          }
        }
      }
      const allRefs = [semanticRef, ...riskRefs, ...coverageRefs]
      const researchKey = `programmatic-semantic-risk-mismatch:${run.id}`
      crossLayerConflicts.push({
        inference: true,
        type: 'programmatic-semantic-risk-mismatch',
        key: researchKey,
        summary: '规则分析得出的风险结论与模型分析的风险等级不一致。',
        basis: programmaticRisk
          ? ['complete-programmatic-coverage', 'programmatic-high-or-failed', 'semantic-risk-low']
          : ['complete-programmatic-coverage', 'programmatic-complete-no-high', 'semantic-risk-high'],
        refs: allRefs.slice(0, 20),
        memberRefs: allRefs,
        refCount: allRefs.length,
        drilldown: { endpoint: 'research/members', dimension: 'conflicts', key: researchKey },
      })
    }
    return { semantic, comparisons, pairRefs, crossLayerConflicts }
  }

  async researchSummary(sessionId, filters = {}) {
    const history = await this.store.getSession(sessionId)
    const appliedFilters = normalizeHistoryFilters(filters)
    const selected = historyItemCollections(history).filter(item => itemMatchesFilters(item, appliedFilters))
    const maps = this.researchMaps(selected)
    const { semantic, comparisons, pairRefs, crossLayerConflicts } = this.researchComparisons(selected)
    const dimensions = Object.fromEntries(Object.entries(maps).map(([dimension, map]) => [dimension, [...map.values()]
      .map(bucket => ({
        ...bucket,
        refCount: bucket.refs.length,
        sampleRefs: bucket.refs.slice(0, 12),
        refs: bucket.refs.slice(0, 12),
        drilldown: { endpoint: 'research/members', dimension, key: bucket.key, filters: appliedFilters },
      }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))]))
    return {
      revision: history.timelineRevision ?? history.revision ?? 0,
      filters: appliedFilters,
      dimensions,
      comparisonCount: comparisons.length,
      conflicts: [
        ...comparisons.filter(item => item.conflict.detected).map(item => ({
          inference: true,
          type: 'semantic-run-conflict',
          summary: '同一份输入证据的两次可比模型分析给出了不同裁决或根因。',
          basis: item.conflict.basis,
          refs: pairRefs(item),
          refCount: 2,
          comparison: { leftRunId: item.left.id, rightRunId: item.right.id },
        })),
        ...crossLayerConflicts.map(({ memberRefs, ...summary }) => ({
          ...summary,
          drilldown: { ...summary.drilldown, filters: appliedFilters },
        })),
      ],
      drift: comparisons.filter(item => item.drift.detected).map(item => ({
        inference: true,
        summary: '同一份输入证据和同一分析配置的结果发生变化。',
        basis: item.drift.basis,
        refs: pairRefs(item),
        refCount: 2,
        comparison: { leftRunId: item.left.id, rightRunId: item.right.id },
      })),
      resources: semanticResources(semantic),
    }
  }

  async researchMembers(sessionId, { dimension, key, cursor, limit = 100, filters = {} }) {
    if (!['phases', 'findings', 'tools', 'models', 'triggers', 'conflicts'].includes(dimension) || typeof key !== 'string' || !key) {
      throw Object.assign(new Error('Research bucket is invalid.'), { code: 'INVALID_RESEARCH_BUCKET' })
    }
    const history = await this.store.getSession(sessionId)
    const appliedFilters = normalizeHistoryFilters(filters)
    const filtersHash = stableInputHash({ filters: appliedFilters, dimension, key })
    const selected = historyItemCollections(history).filter(item => itemMatchesFilters(item, appliedFilters))
    const bucket = dimension === 'conflicts'
      ? this.researchComparisons(selected).crossLayerConflicts.find(item => item.key === key)
      : this.researchMaps(selected)[dimension].get(key)
    const refs = asArray(bucket?.memberRefs ?? bucket?.refs).sort((left, right) => {
      const leftTuple = { seq: left.toSeq ?? left.seq ?? -1, time: 0, kind: left.kind ?? '', id: `${left.id ?? ''}:${left.findingIndex ?? ''}:${left.evidenceIndex ?? ''}:${left.seq ?? ''}` }
      const rightTuple = { seq: right.toSeq ?? right.seq ?? -1, time: 0, kind: right.kind ?? '', id: `${right.id ?? ''}:${right.findingIndex ?? ''}:${right.evidenceIndex ?? ''}:${right.seq ?? ''}` }
      return compareSortTuple(leftTuple, rightTuple)
    })
    const occurrenceCounts = new Map()
    const keyedRefs = refs.map(ref => {
      const hash = stableInputHash(ref)
      const occurrence = occurrenceCounts.get(hash) ?? 0
      occurrenceCounts.set(hash, occurrence + 1)
      return { ref, hash, occurrence }
    })
    let start = 0
    if (cursor) {
      const decoded = decodeCursor(cursor, this.cursorSecret, this.cursorIssuer)
      const researchRevision = history.timelineRevision ?? history.revision ?? 0
      if (decoded.kind !== 'research' || decoded.sessionId !== sessionId || decoded.filtersHash !== filtersHash
        || !Number.isSafeInteger(decoded.revision) || decoded.revision < 0 || decoded.revision > researchRevision) {
        throw Object.assign(new Error('Research cursor is stale.'), { code: 'CURSOR_STALE' })
      }
      const lastOccurrence = Number.isSafeInteger(decoded.lastOccurrence) && decoded.lastOccurrence >= 0 ? decoded.lastOccurrence : 0
      const index = keyedRefs.findIndex(item => item.hash === decoded.lastHash && item.occurrence === lastOccurrence)
      if (index < 0) throw Object.assign(new Error('Research cursor is stale.'), { code: 'CURSOR_STALE' })
      start = index + 1
    }
    const boundedLimit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Number.isSafeInteger(limit) ? limit : 100))
    const pageEntries = keyedRefs.slice(start, start + boundedLimit)
    const items = pageEntries.map(item => item.ref)
    const nextCursor = start + items.length < refs.length && items.length > 0
      ? encodeCursor({
          kind: 'research', version: 1, sessionId, revision: history.timelineRevision ?? history.revision ?? 0,
          filtersHash, lastHash: pageEntries.at(-1).hash, lastOccurrence: pageEntries.at(-1).occurrence,
        }, this.cursorSecret, this.cursorIssuer)
      : null
    return { dimension, key, items, nextCursor, total: refs.length, revision: history.timelineRevision ?? history.revision ?? 0, filters: appliedFilters }
  }

  async readEvidence({ sessionId, seq, runId, checkpointId, findingIndex, evidenceIndex, before = 2, after = 2 }, signal) {
    const history = await this.store.getSession(sessionId)
    const referenceCount = [Number.isSafeInteger(seq), Boolean(runId), Boolean(checkpointId)].filter(Boolean).length
    if (referenceCount !== 1) {
      throw Object.assign(new Error('Evidence requires exactly one of seq, runId, or checkpointId.'), { code: 'INVALID_EVIDENCE_REFERENCE' })
    }
    let resolvedSeq = Number.isSafeInteger(seq) ? seq : null
    let verifiedReference = resolvedSeq !== null
    let ownerRange = null
    let reference = resolvedSeq === null ? null : { kind: 'seq', seq: resolvedSeq }
    if (resolvedSeq === null && runId) {
      const run = history.semantic.runs.find(item => item.id === runId)
      if (!run) throw Object.assign(new Error('The requested semantic run does not exist.'), { code: 'EVIDENCE_NOT_FOUND' })
      const selectedEvidenceIndex = Number.isSafeInteger(evidenceIndex) ? evidenceIndex : 0
      const evidence = asArray(run.output?.evidenceRefs)[selectedEvidenceIndex]
      resolvedSeq = Number.isSafeInteger(evidence?.seq) ? evidence.seq : null
      ownerRange = { fromSeq: run.fromSeq, toSeq: run.toSeq }
      verifiedReference = resolvedSeq !== null && resolvedSeq >= run.fromSeq && resolvedSeq <= run.toSeq
      reference = { kind: 'semantic', runId, evidenceIndex: selectedEvidenceIndex, seq: resolvedSeq }
    }
    if (resolvedSeq === null && checkpointId) {
      const checkpoint = history.programmatic.checkpoints.find(item => item.id === checkpointId)
      if (!checkpoint) throw Object.assign(new Error('The requested programmatic checkpoint does not exist.'), { code: 'EVIDENCE_NOT_FOUND' })
      ownerRange = { fromSeq: checkpoint.fromSeq, toSeq: checkpoint.toSeq }
      const hasExactIndices = Number.isSafeInteger(findingIndex) && Number.isSafeInteger(evidenceIndex)
      if (hasExactIndices) {
        const finding = asArray(checkpoint.report?.findings)[findingIndex]
        const evidence = asArray(finding?.evidence)[evidenceIndex]
        resolvedSeq = Number.isSafeInteger(evidence?.seq) ? evidence.seq : null
        verifiedReference = resolvedSeq !== null && resolvedSeq >= checkpoint.fromSeq && resolvedSeq <= checkpoint.toSeq
      } else {
        verifiedReference = false
      }
      reference = {
        kind: 'programmatic', checkpointId,
        ...(hasExactIndices ? { findingIndex, evidenceIndex } : {}),
        seq: resolvedSeq,
        range: ownerRange,
      }
    }
    const beforeCount = Math.min(20, Math.max(0, Number.isSafeInteger(before) ? before : 2))
    const afterCount = Math.min(20, Math.max(0, Number.isSafeInteger(after) ? after : 2))
    if (!Number.isSafeInteger(resolvedSeq) || resolvedSeq < 0) {
      if (reference) {
        return {
          reference,
          verified: false,
          events: [],
          limitations: ['The selected conclusion does not contain a concrete Seq evidence reference.'],
          limits: { before: beforeCount, after: afterCount, maxContextEvents: 41 },
        }
      }
      throw Object.assign(new Error('Evidence requires a Seq, runId, or checkpointId reference.'), { code: 'EVIDENCE_NOT_FOUND' })
    }
    if (!verifiedReference) {
      return {
        reference,
        verified: false,
        events: [],
        limitations: [`The referenced Seq is outside its owner range ${ownerRange?.fromSeq ?? '?'}..${ownerRange?.toSeq ?? '?'}.`],
        limits: { before: beforeCount, after: afterCount, maxContextEvents: 41 },
      }
    }
    const observation = await this.observation(sessionId, signal)
    const rawEvents = asArray(observation.log?.events)
    const events = rawEvents
      .filter(event => event?.seq >= resolvedSeq - beforeCount && event?.seq <= resolvedSeq + afterCount)
      .map(compressTraceEvent)
      .filter(Boolean)
    return {
      reference,
      verified: verifiedReference && rawEvents.some(event => event?.seq === resolvedSeq),
      events,
      limits: { before: beforeCount, after: afterCount, maxContextEvents: 41 },
    }
  }

  async buildExport(sessionId, kind, options = {}, signal, { ensureProgrammatic = false } = {}) {
    if (!['raw', 'analysis', 'bundle'].includes(kind)) throw Object.assign(new Error('Unsupported export kind.'), { code: 'INVALID_EXPORT_KIND' })
    const normalizedOptions = exportOptions(options)
    let observation = null
    let sourceObservedThroughSeq = null
    if (kind === 'raw' || kind === 'bundle') {
      observation = await this.observation(sessionId, signal)
      sourceObservedThroughSeq = observation.log?.events?.at(-1)?.seq ?? -1
      if (ensureProgrammatic) await this.ensureProgrammatic(observation, 'export')
      if (Number.isSafeInteger(normalizedOptions.fromSeq) || Number.isSafeInteger(normalizedOptions.toSeq)) {
        const events = asArray(observation.log?.events)
        const fromSeq = normalizedOptions.fromSeq ?? 0
        const toSeq = normalizedOptions.toSeq ?? (events.at(-1)?.seq ?? -1)
        if (toSeq < fromSeq) throw Object.assign(new Error('Export range is invalid.'), { code: 'INVALID_RANGE' })
        observation = sliceObservation(observation, fromSeq, toSeq)
      }
      if (normalizedOptions.redactRaw) observation = redactExportValue(observation)
    }
    const history = await this.store.getSession(sessionId)
    const scoped = await this.effectiveSettings(sessionId, history)
    const base = {
      schemaVersion: 1,
      serviceVersion: TRACE_INSIGHT_SERVICE_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      promptVersion: SEMANTIC_PROMPT_VERSION,
      exportedAt: iso(this.now),
      kind,
      sessionId,
    }
    const payload = kind === 'raw'
      ? { ...base, raw: observation }
      : kind === 'analysis'
        ? { ...base, analysis: { settings: scoped, history } }
        : { ...base, raw: observation, analysis: { settings: scoped, history } }
    const rawEvents = asArray(observation?.log?.events)
    payload.manifest = {
      schemaVersion: 1,
      kind,
      sessionId,
      options: normalizedOptions,
      historyRevision: history.revision ?? 0,
      settingsRevision: scoped.revision,
      annotations: kind === 'raw'
        ? { included: false }
        : {
            included: true,
            revision: history.annotations?.revision ?? 0,
            total: asArray(history.annotations?.items).length,
            activeCount: asArray(history.annotations?.items).filter(item => !item.archivedAt).length,
          },
      observedThroughSeq: sourceObservedThroughSeq,
      rawRange: observation ? {
        fromSeq: rawEvents.at(0)?.seq ?? null,
        toSeq: rawEvents.at(-1)?.seq ?? null,
        eventCount: rawEvents.length,
        sourceObservedThroughSeq,
      } : null,
      contentHash: stableInputHash(payload),
    }
    return payload
  }

  async previewExport(sessionId, kind, options = {}, signal) {
    if (!['raw', 'analysis', 'bundle'].includes(kind)) throw Object.assign(new Error('Unsupported export kind.'), { code: 'INVALID_EXPORT_KIND' })
    this.cleanupExportConfirmations()
    const normalizedOptions = exportOptions(options)
    let sourceObservedThroughSeq = null
    let rawRange = null
    let rawEstimatedChars = 0
    if (kind === 'raw' || kind === 'bundle') {
      const observation = await this.observation(sessionId, signal)
      const events = asArray(observation.log?.events)
      sourceObservedThroughSeq = events.at(-1)?.seq ?? -1
      const fromSeq = normalizedOptions.fromSeq ?? 0
      const toSeq = normalizedOptions.toSeq ?? sourceObservedThroughSeq
      if ((Number.isSafeInteger(normalizedOptions.fromSeq) || Number.isSafeInteger(normalizedOptions.toSeq)) && toSeq < fromSeq) {
        throw Object.assign(new Error('Export range is invalid.'), { code: 'INVALID_RANGE' })
      }
      const selected = events.filter(event => event?.seq >= fromSeq && event?.seq <= toSeq)
      rawRange = {
        fromSeq: selected.at(0)?.seq ?? null,
        toSeq: selected.at(-1)?.seq ?? null,
        eventCount: selected.length,
        sourceObservedThroughSeq,
      }
      rawEstimatedChars = 2_000 + sampledJsonChars(selected, 32)
    }
    const history = await this.store.getSession(sessionId)
    const scoped = await this.effectiveSettings(sessionId, history)
    const analysisEstimatedChars = kind === 'analysis' || kind === 'bundle'
      ? estimatedHistoryChars(history, scoped)
      : 0
    const manifest = {
      schemaVersion: 1,
      kind,
      sessionId,
      options: normalizedOptions,
      historyRevision: history.revision ?? 0,
      settingsRevision: scoped.revision,
      annotations: kind === 'raw'
        ? { included: false }
        : {
            included: true,
            revision: history.annotations?.revision ?? 0,
            total: asArray(history.annotations?.items).length,
            activeCount: asArray(history.annotations?.items).filter(item => !item.archivedAt).length,
          },
      observedThroughSeq: sourceObservedThroughSeq,
      rawRange,
    }
    const expiresAtMs = this.now() + EXPORT_CONFIRMATION_TTL_MS
    const previewToken = `export-${randomUUID()}`
    const observedThroughSeq = manifest.observedThroughSeq ?? null
    if (kind === 'raw' || kind === 'bundle') {
      this.exportConfirmations.set(previewToken, {
        sessionId,
        kind,
        optionsHash: stableInputHash(normalizedOptions),
        historyRevision: manifest.historyRevision,
        settingsRevision: manifest.settingsRevision,
        observedThroughSeq,
        expiresAtMs,
      })
    }
    return {
      previewToken,
      ...(kind === 'raw' || kind === 'bundle' ? { confirmationToken: previewToken } : {}),
      manifest,
      estimatedChars: rawEstimatedChars + analysisEstimatedChars,
      estimateBasis: 'bounded-sample',
      privacyFlags: [
        ...(kind === 'raw' || kind === 'bundle' ? ['raw-session-text', 'tool-inputs-and-results'] : []),
        ...(kind === 'analysis' || kind === 'bundle' ? ['analysis-model-output', 'analysis-evidence-excerpts'] : []),
        ...(manifest.annotations.included && manifest.annotations.total > 0 ? ['legacy-annotations'] : []),
        ...(normalizedOptions.redactRaw ? ['raw-redaction-enabled'] : []),
      ],
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  async exportWithConfirmation(sessionId, kind, options = {}, confirmationToken, signal) {
    this.cleanupExportConfirmations()
    if (kind === 'analysis') return this.buildExport(sessionId, kind, options, signal)
    if (!confirmationToken) {
      throw Object.assign(new Error('Raw and bundle exports require a current export preview confirmation.'), { code: 'EXPORT_CONFIRMATION_REQUIRED' })
    }
    const confirmation = this.exportConfirmations.get(confirmationToken)
    if (!confirmation) throw Object.assign(new Error('The export confirmation is missing or stale.'), { code: 'EXPORT_CONFIRMATION_STALE' })
    if (confirmation.expiresAtMs < this.now()) {
      this.exportConfirmations.delete(confirmationToken)
      throw Object.assign(new Error('The export confirmation expired.'), { code: 'EXPORT_CONFIRMATION_EXPIRED' })
    }
    const optionsHash = stableInputHash(exportOptions(options))
    if (confirmation.sessionId !== sessionId || confirmation.kind !== kind || confirmation.optionsHash !== optionsHash) {
      throw Object.assign(new Error('The export confirmation does not match this request.'), { code: 'EXPORT_CONFIRMATION_STALE' })
    }
    const payload = await this.buildExport(sessionId, kind, options, signal)
    const observedThroughSeq = payload.manifest.observedThroughSeq ?? null
    if (confirmation.historyRevision !== payload.manifest.historyRevision
      || JSON.stringify(confirmation.settingsRevision) !== JSON.stringify(payload.manifest.settingsRevision)
      || confirmation.observedThroughSeq !== observedThroughSeq) {
      throw Object.assign(new Error('The export source changed after preview.'), { code: 'EXPORT_CONFIRMATION_STALE' })
    }
    this.exportConfirmations.delete(confirmationToken)
    return payload
  }

  async exportSession(sessionId, kind, signal) {
    return this.buildExport(sessionId, kind, {}, signal, { ensureProgrammatic: true })
  }

  cleanupExportConfirmations() {
    const now = this.now()
    for (const [token, confirmation] of this.exportConfirmations) {
      if (!confirmation || confirmation.expiresAtMs < now) this.exportConfirmations.delete(token)
    }
  }

  dispose() {
    this.disposed = true
    for (const timer of this.quietTimers.values()) this.clearTimer(timer)
    this.quietTimers.clear()
    this.quietDueAt.clear()
    for (const timer of this.projectionTimers.values()) this.clearTimer(timer)
    this.projectionTimers.clear()
    for (const timer of this.liveFlushTimers.values()) this.clearTimer(timer)
    this.liveFlushTimers.clear()
    this.liveLastFlushAt.clear()
    for (const timer of this.provisionalDeadlineTimers.values()) this.clearTimer(timer)
    this.provisionalDeadlineTimers.clear()
    this.provisionalDeadlineDueAt.clear()
    this.activeProvisional.clear()
    this.expectedObservedSeqs.clear()
    this.projectionAttempts.clear()
    for (const controller of this.controllers) controller.abort(new Error('Trace Insight stopped.'))
    this.controllers.clear()
    for (const controller of this.jobControllers.values()) controller.abort(new Error('Trace Insight stopped.'))
    this.jobControllers.clear()
    this.jobSessions.clear()
    this.exportConfirmations.clear()
    this.activeDiagnosticKeys.clear()
    this.diagnosticGenerations.clear()
    this.diagnosticSuccessGenerations.clear()
    const disposalError = Object.assign(new Error('Trace Insight stopped before a queued model analysis could start.'), { code: 'DISPOSED' })
    for (const waiter of this.modelWaiters.splice(0)) {
      waiter.signal?.removeEventListener?.('abort', waiter.abort)
      waiter.reject(disposalError)
    }
  }
}
