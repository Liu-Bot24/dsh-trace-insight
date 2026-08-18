import { readSessionObservation } from './session-observation.mjs'

const BAD_REQUEST = message => ({
  ok: false,
  error: { code: 'bad-request', message, details: { issues: [] } },
})
const MAX_CURSOR_CHARS = 16 * 1024

const INVALID_CURSOR = () => ({
  ok: false,
  error: { code: 'INVALID_CURSOR', message: 'Cursor is invalid.', details: {} },
})

function cursorTooLong(value) {
  return typeof value === 'string' && value.length > MAX_CURSOR_CHARS
}

function internalFailure() {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: 'Trace Insight could not complete this request.',
      details: {},
    },
  }
}
function sessionNotFound(sessionId) {
  return {
    ok: false,
    error: {
      code: 'session-not-found',
      message: 'The requested session is not available.',
      details: { sessionId },
    },
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, required, optional = []) {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  if (required.some(key => !keys.includes(key))) return false
  const allowed = new Set([...required, ...optional])
  return keys.every(key => allowed.has(key))
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
}

function abortFailure(signal) {
  if (!signal?.aborted) return null
  return {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'Trace Insight request was cancelled.',
      details: {},
    },
  }
}

function safeOperationalFailure(error) {
  const safe = new Set([
    'INVALID_RANGE',
    'INVALID_EXPORT_KIND',
    'ENVELOPE_TOO_LARGE',
    'MODEL_NOT_CONFIGURED',
    'MODEL_INVALID_FORMAT',
    'MODEL_MAX_TOKENS',
    'MODEL_TIMEOUT',
    'MODEL_ABORTED',
    'RATE_LIMIT',
    'RATE_LIMITED',
    'AUTH',
    'NO_ADAPTER',
    'DISPOSED',
    'REVISION_CONFLICT',
    'PREVIEW_STALE',
    'PRIMARY_RANGE_GAP',
    'PRIMARY_JOB_ACTIVE',
    'PRIMARY_COVERAGE_CONFLICT',
    'INVALID_JOB_MODE',
    'IDEMPOTENCY_CONFLICT',
    'JOB_NOT_FOUND',
    'INVALID_CURSOR',
    'CURSOR_STALE',
    'INVALID_REVISION',
    'INVALID_FILTERS',
    'RUN_NOT_FOUND',
    'INVALID_COMPARISON',
    'INVALID_ANNOTATION',
    'ANNOTATION_TARGET_NOT_FOUND',
    'ANNOTATION_NOT_FOUND',
    'RESOURCE_LIMIT_EXCEEDED',
    'RESOURCE_OVERRIDE_REASON_REQUIRED',
    'LEGACY_FORCE_UNAVAILABLE',
    'INVALID_RESEARCH_BUCKET',
    'EVIDENCE_NOT_FOUND',
    'INVALID_EVIDENCE_REFERENCE',
    'EXPORT_CONFIRMATION_REQUIRED',
    'EXPORT_CONFIRMATION_STALE',
    'EXPORT_CONFIRMATION_EXPIRED',
  ])
  if (!safe.has(error?.code)) return null
  const details = error?.code === 'REVISION_CONFLICT' && isPlainRecord(error?.details)
    ? {
        expectedRevision: error.details.expectedRevision,
        actualRevision: error.details.actualRevision,
      }
    : error?.code === 'RESOURCE_LIMIT_EXCEEDED' && isPlainRecord(error?.details?.budgetAssessment)
      ? { budgetAssessment: error.details.budgetAssessment }
      : {}
  return {
    ok: false,
    error: {
      code: error.code,
      message: typeof error.message === 'string' ? error.message : 'Trace Insight operation failed.',
      details,
    },
  }
}

function settingsPayload(payload) {
  if (!exactKeys(payload, ['settings'], ['sessionId']) || !isPlainRecord(payload.settings)) return null
  if (payload.sessionId !== undefined && !validSessionId(payload.sessionId)) return null
  return payload
}

function manualPayload(payload) {
  if (!exactKeys(payload, ['sessionId', 'fromSeq', 'toSeq', 'route'], ['force'])) return null
  if (!validSessionId(payload.sessionId) || !Number.isSafeInteger(payload.fromSeq) || !Number.isSafeInteger(payload.toSeq)) return null
  if (!isPlainRecord(payload.route) || typeof payload.route.provider !== 'string' || typeof payload.route.model !== 'string') return null
  if (payload.force !== undefined && typeof payload.force !== 'boolean') return null
  return payload
}

function validRevision(value) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0)
}

function validRoute(value) {
  if (!isPlainRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string') return false
  if (!value.provider.trim() || !value.model.trim()) return false
  return exactKeys(value, ['provider', 'model'], ['reasoningEffort'])
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

function scopedSettingsPayload(payload, session = false) {
  const required = session ? ['sessionId'] : []
  if (!exactKeys(payload, required, ['patch', 'reset', 'expectedRevision'])) return null
  if (session && !validSessionId(payload.sessionId)) return null
  if (payload.patch !== undefined && !isPlainRecord(payload.patch)) return null
  if (payload.reset !== undefined && typeof payload.reset !== 'boolean') return null
  if (!validRevision(payload.expectedRevision)) return null
  if (session && payload.patch === undefined && payload.reset !== true) return null
  if (!session && payload.patch === undefined) return null
  return payload
}

function analysisJobPayload(payload, { start = false } = {}) {
  const optional = ['route', 'force', 'previewToken', 'idempotencyKey', ...(start ? ['overrideBudget', 'overrideReason'] : [])]
  if (!exactKeys(payload, ['sessionId', 'mode', 'fromSeq', 'toSeq'], optional)) return null
  if (!validSessionId(payload.sessionId) || !['primary', 'supplemental'].includes(payload.mode)) return null
  if (!Number.isSafeInteger(payload.fromSeq) || !Number.isSafeInteger(payload.toSeq)) return null
  if (payload.route !== undefined && !validRoute(payload.route)) return null
  if (payload.force !== undefined && typeof payload.force !== 'boolean') return null
  if (start && (typeof payload.previewToken !== 'string' || !payload.previewToken)) return null
  if (payload.previewToken !== undefined && (typeof payload.previewToken !== 'string' || payload.previewToken.length > 512)) return null
  if (payload.idempotencyKey !== undefined && (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey || payload.idempotencyKey.length > 512)) return null
  if (payload.overrideBudget !== undefined && typeof payload.overrideBudget !== 'boolean') return null
  if (payload.overrideReason !== undefined && (typeof payload.overrideReason !== 'string' || payload.overrideReason.length > 1_000)) return null
  return payload
}

function jobReferencePayload(payload, { cancel = false } = {}) {
  if (!exactKeys(payload, ['jobId'], ['sessionId', 'expectedRevision'])) return null
  if (typeof payload.jobId !== 'string' || !payload.jobId || payload.jobId.length > 512) return null
  if (payload.sessionId !== undefined && !validSessionId(payload.sessionId)) return null
  if (cancel && !validRevision(payload.expectedRevision)) return null
  if (!cancel && payload.expectedRevision !== undefined) return null
  return payload
}

function exportPayload(payload, preview = false) {
  const optional = preview ? ['options'] : ['options', 'confirmationToken']
  if (!exactKeys(payload, ['sessionId', 'kind'], optional)) return null
  if (!validSessionId(payload.sessionId) || !['raw', 'analysis', 'bundle'].includes(payload.kind)) return null
  if (payload.options !== undefined && !isPlainRecord(payload.options)) return null
  if (payload.confirmationToken !== undefined && (typeof payload.confirmationToken !== 'string' || !payload.confirmationToken)) return null
  return payload
}

const HISTORY_FILTER_KEYS = [
  'query', 'fromSeq', 'toSeq', 'fromTurn', 'toTurn',
  'layers', 'kinds', 'layer', 'kind', 'statuses', 'status', 'triggers', 'trigger',
  'severities', 'severity', 'coverageRoles', 'coverageRole', 'providers', 'provider',
  'models', 'model', 'reasoningEfforts', 'reasoningEffort',
]

function validHistoryFilters(value) {
  if (value === undefined) return true
  if (!exactKeys(value, [], HISTORY_FILTER_KEYS)) return false
  for (const key of ['fromSeq', 'toSeq', 'fromTurn', 'toTurn']) {
    if (value[key] !== undefined && value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return false
  }
  if (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 1_000)) return false
  const plural = ['layers', 'kinds', 'statuses', 'triggers', 'severities', 'coverageRoles', 'providers', 'models', 'reasoningEfforts']
  for (const key of plural) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string' || item.length > 512))) return false
  }
  const singular = ['layer', 'kind', 'status', 'trigger', 'severity', 'coverageRole', 'provider', 'model', 'reasoningEffort']
  return singular.every(key => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 512))
}

/** Build the one loopback-only RPC handler used by the Host plugin. */
export function createTraceInsightRpcHandler({ sessionQuery, service }) {
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
    throw new TypeError('trace-insight: sessionQuery service is unavailable')
  }
  if (!service || typeof service.readInsight !== 'function') {
    throw new TypeError('trace-insight: analysis service is unavailable')
  }

  return async (endpoint, payload, signal) => {
    const cancelled = abortFailure(signal)
    if (cancelled) return cancelled
    try {
      if (endpoint === 'capabilities/read') {
        if (!exactKeys(payload, [])) return BAD_REQUEST('capabilities/read does not accept parameters.')
        return { ok: true, value: typeof service.capabilities === 'function' ? service.capabilities() : { endpoints: [], features: {} } }
      }
      if (endpoint === 'session/read') {
        if (!exactKeys(payload, ['sessionId']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('session/read requires exactly one non-empty sessionId string.')
        }
        return { ok: true, value: await readSessionObservation(sessionQuery, payload.sessionId, signal) }
      }
      if (endpoint === 'insight/read') {
        if (!exactKeys(payload, ['sessionId']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('insight/read requires exactly one non-empty sessionId string.')
        }
        return { ok: true, value: await service.readInsight(payload.sessionId, signal) }
      }
      if (endpoint === 'insight/bootstrap') {
        if (!exactKeys(payload, ['sessionId'], ['historyLimit', 'filters']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('insight/bootstrap requires sessionId and accepts historyLimit and filters.')
        }
        if (payload.historyLimit !== undefined && (!Number.isSafeInteger(payload.historyLimit) || payload.historyLimit < 1)) {
          return BAD_REQUEST('insight/bootstrap historyLimit must be a positive integer.')
        }
        if (!validHistoryFilters(payload.filters)) return BAD_REQUEST('insight/bootstrap filters are invalid.')
        return { ok: true, value: await service.readBootstrap(payload.sessionId, { historyLimit: payload.historyLimit, filters: payload.filters }) }
      }
      if (endpoint === 'programmatic/sync') {
        if (!exactKeys(payload, ['sessionId'], ['historyLimit', 'filters']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('programmatic/sync requires sessionId and accepts historyLimit and filters.')
        }
        if (payload.historyLimit !== undefined && (!Number.isSafeInteger(payload.historyLimit) || payload.historyLimit < 1)) {
          return BAD_REQUEST('programmatic/sync historyLimit must be a positive integer.')
        }
        if (!validHistoryFilters(payload.filters)) return BAD_REQUEST('programmatic/sync filters are invalid.')
        return { ok: true, value: await service.syncProgrammatic(payload.sessionId, { historyLimit: payload.historyLimit, filters: payload.filters }, signal) }
      }
      if (endpoint === 'models/list') {
        if (!exactKeys(payload, [], ['refresh']) || (payload.refresh !== undefined && typeof payload.refresh !== 'boolean')) {
          return BAD_REQUEST('models/list accepts only an optional refresh boolean.')
        }
        return { ok: true, value: await service.catalog({ refresh: payload.refresh === true }) }
      }
      if (endpoint === 'settings/effective') {
        if (!exactKeys(payload, ['sessionId']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('settings/effective requires exactly one non-empty sessionId string.')
        }
        return { ok: true, value: await service.readEffectiveSettings(payload.sessionId) }
      }
      if (endpoint === 'settings/update-global') {
        const request = scopedSettingsPayload(payload)
        if (!request) return BAD_REQUEST('settings/update-global requires a patch and optional expectedRevision.')
        return { ok: true, value: await service.updateGlobalSettings(request.patch, request.expectedRevision) }
      }
      if (endpoint === 'settings/update-session') {
        const request = scopedSettingsPayload(payload, true)
        if (!request) return BAD_REQUEST('settings/update-session requires sessionId and a patch or reset=true.')
        return {
          ok: true,
          value: await service.updateSessionSettings(request.sessionId, request.patch ?? {}, {
            reset: request.reset === true,
            expectedRevision: request.expectedRevision,
          }),
        }
      }
      if (endpoint === 'settings/update') {
        const request = settingsPayload(payload)
        if (!request) return BAD_REQUEST('settings/update requires settings and an optional sessionId.')
        return { ok: true, value: await service.updateSettings(request.settings, request.sessionId) }
      }
      if (endpoint === 'analysis/run') {
        const request = manualPayload(payload)
        if (!request) return BAD_REQUEST('analysis/run requires sessionId, integer Seq bounds, and a model route.')
        if (request.force) {
          throw Object.assign(new Error('Forced re-analysis requires the previewed async analysis workflow.'), { code: 'LEGACY_FORCE_UNAVAILABLE' })
        }
        return { ok: true, value: await service.runManual(request, signal) }
      }
      if (endpoint === 'analysis/preview') {
        const request = analysisJobPayload(payload)
        if (!request) return BAD_REQUEST('analysis/preview requires sessionId, mode, integer Seq bounds, and an optional model route.')
        return { ok: true, value: await service.previewAnalysis(request, signal) }
      }
      if (endpoint === 'analysis/start') {
        const request = analysisJobPayload(payload, { start: true })
        if (!request) return BAD_REQUEST('analysis/start requires a current previewToken and the previewed analysis parameters.')
        return { ok: true, value: await service.startAnalysis(request, signal) }
      }
      if (endpoint === 'analysis/job') {
        const request = jobReferencePayload(payload)
        if (!request) return BAD_REQUEST('analysis/job requires a jobId and optional sessionId.')
        return { ok: true, value: await service.readAnalysisJob(request.jobId, request.sessionId) }
      }
      if (endpoint === 'analysis/cancel') {
        const request = jobReferencePayload(payload, { cancel: true })
        if (!request) return BAD_REQUEST('analysis/cancel requires jobId and optional sessionId and expectedRevision.')
        return {
          ok: true,
          value: await service.cancelAnalysis(request.jobId, {
            sessionId: request.sessionId,
            expectedRevision: request.expectedRevision,
          }),
        }
      }
      if (endpoint === 'insight/status') {
        if (!exactKeys(payload, ['sessionId']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('insight/status requires exactly one non-empty sessionId string.')
        }
        return { ok: true, value: await service.readStatus(payload.sessionId) }
      }
      if (endpoint === 'live/read') {
        if (!exactKeys(payload, ['sessionId']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('live/read requires exactly one non-empty sessionId string.')
        }
        return { ok: true, value: await service.readLive(payload.sessionId) }
      }
      if (endpoint === 'history/page') {
        if (!exactKeys(payload, ['sessionId'], ['cursor', 'limit', 'filters']) || !validSessionId(payload.sessionId)) {
          return BAD_REQUEST('history/page requires sessionId and accepts cursor, limit, and filters.')
        }
        if (payload.cursor !== undefined && typeof payload.cursor !== 'string' && !Number.isSafeInteger(payload.cursor)) {
          return BAD_REQUEST('history/page cursor must be a string or integer.')
        }
        if (cursorTooLong(payload.cursor)) return INVALID_CURSOR()
        if (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1)) return BAD_REQUEST('history/page limit must be a positive integer.')
        if (!validHistoryFilters(payload.filters)) return BAD_REQUEST('history/page filters are invalid.')
        return { ok: true, value: await service.historyPage(payload.sessionId, payload) }
      }
      if (endpoint === 'history/delta') {
        if (!exactKeys(payload, ['sessionId', 'sinceRevision'], ['filters']) || !validSessionId(payload.sessionId)
          || !Number.isSafeInteger(payload.sinceRevision) || payload.sinceRevision < 0) {
          return BAD_REQUEST('history/delta requires sessionId and a non-negative sinceRevision and accepts filters.')
        }
        if (!validHistoryFilters(payload.filters)) return BAD_REQUEST('history/delta filters are invalid.')
        return { ok: true, value: await service.historyDelta(payload.sessionId, payload.sinceRevision, payload.filters) }
      }
      if (endpoint === 'compare/read') {
        if (!exactKeys(payload, ['sessionId', 'leftRunId', 'rightRunId']) || !validSessionId(payload.sessionId)
          || typeof payload.leftRunId !== 'string' || !payload.leftRunId || typeof payload.rightRunId !== 'string' || !payload.rightRunId) {
          return BAD_REQUEST('compare/read requires sessionId, leftRunId, and rightRunId.')
        }
        return { ok: true, value: await service.compareRuns(payload.sessionId, payload.leftRunId, payload.rightRunId) }
      }
      if (endpoint === 'research/summary') {
        if (!exactKeys(payload, ['sessionId'], ['filters']) || !validSessionId(payload.sessionId) || !validHistoryFilters(payload.filters)) {
          return BAD_REQUEST('research/summary requires sessionId and accepts history filters.')
        }
        return { ok: true, value: await service.researchSummary(payload.sessionId, payload.filters) }
      }
      if (endpoint === 'research/members') {
        if (!exactKeys(payload, ['sessionId', 'dimension', 'key'], ['cursor', 'limit', 'filters']) || !validSessionId(payload.sessionId)
          || typeof payload.dimension !== 'string' || typeof payload.key !== 'string' || !payload.key || !validHistoryFilters(payload.filters)) {
          return BAD_REQUEST('research/members requires sessionId, dimension, key, and accepts paging filters.')
        }
        if (payload.cursor !== undefined && typeof payload.cursor !== 'string') return BAD_REQUEST('research/members cursor must be a string.')
        if (cursorTooLong(payload.cursor)) return INVALID_CURSOR()
        if (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1)) return BAD_REQUEST('research/members limit must be positive.')
        return { ok: true, value: await service.researchMembers(payload.sessionId, payload) }
      }
      if (endpoint === 'evidence/read') {
        if (!exactKeys(payload, ['sessionId'], ['seq', 'runId', 'checkpointId', 'findingIndex', 'evidenceIndex', 'before', 'after'])
          || !validSessionId(payload.sessionId)) return BAD_REQUEST('evidence/read requires sessionId and a valid evidence reference.')
        for (const key of ['seq', 'findingIndex', 'evidenceIndex', 'before', 'after']) {
          if (payload[key] !== undefined && (!Number.isSafeInteger(payload[key]) || payload[key] < 0)) return BAD_REQUEST(`evidence/read ${key} must be a non-negative integer.`)
        }
        for (const key of ['runId', 'checkpointId']) {
          if (payload[key] !== undefined && (typeof payload[key] !== 'string' || !payload[key])) return BAD_REQUEST(`evidence/read ${key} must be a non-empty string.`)
        }
        if ([payload.seq !== undefined, payload.runId !== undefined, payload.checkpointId !== undefined].filter(Boolean).length !== 1) {
          return BAD_REQUEST('evidence/read requires exactly one of seq, runId, or checkpointId.')
        }
        return { ok: true, value: await service.readEvidence(payload, signal) }
      }
      if (endpoint === 'export/preview') {
        const request = exportPayload(payload, true)
        if (!request) return BAD_REQUEST('export/preview requires sessionId, kind, and optional options.')
        return { ok: true, value: await service.previewExport(request.sessionId, request.kind, request.options, signal) }
      }
      if (endpoint === 'export/read') {
        const request = exportPayload(payload)
        if (!request) return BAD_REQUEST('export/read requires sessionId, kind, optional options, and raw confirmationToken.')
        const value = typeof service.exportWithConfirmation === 'function'
          ? await service.exportWithConfirmation(request.sessionId, request.kind, request.options, request.confirmationToken, signal)
          : await service.exportSession(request.sessionId, request.kind, signal)
        return { ok: true, value }
      }
      return BAD_REQUEST('Trace Insight does not expose this endpoint.')
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_ABORTED' || error?.name === 'AbortError' || signal?.aborted) {
        return abortFailure({ aborted: true })
      }
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return sessionNotFound(payload?.sessionId)
      return safeOperationalFailure(error) ?? internalFailure()
    }
  }
}
