/**
 * Live open-turn tracking: the deep module that separates real-time
 * observation from final turn settlement.
 *
 * Pure functions only — no I/O, no model access:
 *  - classifyTraceEvent: noise vs meaningful vs progress vs failure;
 *  - openTurnState: observed/stable waterlines, meaningful-event and
 *    compressed-char budgets, failure clusters, no-progress streaks;
 *  - evaluateProvisionalTrigger: the controlled policy deciding whether the
 *    current stable prefix is due for a provisional semantic run.
 *
 * Side-effect execution (persistence, model dispatch, finalization) belongs
 * to TraceInsightService; these decisions stay independently testable.
 */
import { compressTraceEvent, normalizeAnalysisSettings } from './analysis-policy.mjs'

/** Classification of one raw event for live-turn purposes. */
export function classifyTraceEvent(event) {
  const type = event?.type
  if (type === 'assistant/chunk') {
    return { noise: true, meaningful: false, progress: false, failure: null }
  }
  if (type === 'turn/start') {
    return { noise: false, meaningful: true, progress: false, failure: null }
  }
  if (type === 'step/start') {
    return { noise: true, meaningful: false, progress: false, failure: null }
  }
  if (type === 'step/end') {
    return { noise: false, meaningful: true, progress: false, failure: null }
  }
  if (type === 'user/message') {
    return { noise: false, meaningful: true, progress: false, failure: null }
  }
  if (type === 'assistant/message') {
    const hasText = Boolean(event?.data?.message?.content?.some?.(block => block?.type === 'text' && String(block.text ?? '').trim()))
    return { noise: false, meaningful: true, progress: hasText, failure: null }
  }
  if (type === 'tool/call') {
    return { noise: false, meaningful: true, progress: false, failure: null }
  }
  if (type === 'tool/result') {
    const error = Boolean(event?.data?.error)
    return { noise: false, meaningful: true, progress: !error, failure: error }
  }
  // request/header, request/context, assistant/end and anything unknown are
  // structural noise: they never advance the stable prefix on their own.
  return { noise: true, meaningful: false, progress: false, failure: null }
}

function resultCallId(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {}
  const result = data.message?.content?.find?.(block => block?.type === 'tool-result')
  return data.message?.source?.callId ?? result?.toolCallId ?? data.callId ?? null
}

function callToolName(event) {
  return typeof event?.data?.name === 'string' ? event.data.name : null
}

function eventTime(value, fallback = null) {
  if (Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function compressedCharsOf(events) {
  let chars = 0
  for (const event of events) {
    const compressed = compressTraceEvent(event)
    if (compressed) chars += JSON.stringify(compressed).length + 1
  }
  return chars
}

/**
 * Derive the live state of the current open turn from the raw event stream.
 *
 * @param events raw session events (any order; deduped and sorted by seq here)
 * @param options.provisionalThroughSeq - the provisional waterline used to
 *   compute "since last provisional" budgets.
 * @returns null when no turn is currently open.
 */
export function openTurnState(events, { provisionalThroughSeq = -1 } = {}) {
  const sorted = [...new Map(
    (Array.isArray(events) ? events : [])
      .filter(event => event && Number.isSafeInteger(event.seq))
      .sort((left, right) => left.seq - right.seq)
      .map(event => [event.seq, event]),
  ).values()]

  // Locate the current open turn: the last turn/start whose turn number has
  // no matching turn/end after it.
  let turn = null
  let turnStartSeq = null
  let turnStartedAt = null
  const endedTurns = new Set()
  for (const event of sorted) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      turn = event.data.turn
      turnStartSeq = event.seq
      turnStartedAt = eventTime(event.time, null)
    }
    if (event.type === 'turn/end' && Number.isSafeInteger(event.data?.turn)) {
      endedTurns.add(event.data.turn)
      if (event.data.turn === turn) {
        turn = null
        turnStartSeq = null
        turnStartedAt = null
      }
    }
  }
  if (turn === null) return null

  const turnEvents = sorted.filter(event => event.seq >= turnStartSeq)
  const observedThroughSeq = turnEvents.at(-1)?.seq ?? turnStartSeq

  // Stable waterline: the last seq such that every tool/call at or before it
  // has a matching tool/result at or before it. Streaming noise never moves
  // the waterline; a closed tool pair does.
  const openCalls = new Map() // callId -> tool name
  let stableThroughSeq = turnStartSeq
  let lastMeaningfulAt = turnStartedAt
  let meaningfulEvents = 0
  let meaningfulSinceProvisional = 0
  const failures = new Map() // tool name -> count (whole open turn)
  const failuresSinceProvisional = new Map() // tool name -> count (new since provisional waterline)
  const stepProgress = new Map() // step -> bool
  const currentStep = new Map() // step -> accumulated progress
  const closedSteps = []
  let lastStep = null

  const countFailure = (toolName, seq) => {
    const key = toolName ?? 'unknown'
    failures.set(key, (failures.get(key) ?? 0) + 1)
    if (seq > provisionalThroughSeq) failuresSinceProvisional.set(key, (failuresSinceProvisional.get(key) ?? 0) + 1)
  }

  for (const event of turnEvents) {
    const classification = classifyTraceEvent(event)
    const step = Number.isSafeInteger(event.data?.step) ? event.data.step : null
    if (event.type === 'tool/call') {
      const callId = event.data?.callId
      if (callId) openCalls.set(callId, callToolName(event))
      classification.meaningful = true
      classification.noise = false
    } else if (event.type === 'tool/result') {
      const callId = resultCallId(event)
      if (callId && openCalls.has(callId)) {
        const toolName = openCalls.get(callId)
        if (classification.failure) countFailure(toolName, event.seq)
        openCalls.delete(callId)
      } else if (classification.failure) {
        countFailure(resultCallId(event) ?? null, event.seq)
      }
    }
    if (classification.meaningful) {
      meaningfulEvents += 1
      if (event.seq > provisionalThroughSeq) meaningfulSinceProvisional += 1
      lastMeaningfulAt = eventTime(event.time, lastMeaningfulAt)
    }
    if (step !== null) {
      if (step !== lastStep) {
        lastStep = step
        currentStep.set(step, false)
      }
      if (classification.progress) currentStep.set(step, true)
    }
    if (event.type === 'step/end') {
      const progressed = currentStep.get(step) === true
      stepProgress.set(step, progressed)
      closedSteps.push({ step, progressed })
      currentStep.delete(step)
    }
    if (!classification.noise && event.type !== 'tool/call' && openCalls.size === 0) {
      stableThroughSeq = event.seq
    }
  }

  let noProgressSteps = 0
  for (let index = closedSteps.length - 1; index >= 0; index -= 1) {
    if (closedSteps[index].progressed) break
    noProgressSteps += 1
  }

  const stableEvents = turnEvents.filter(event => event.seq <= stableThroughSeq)
  const charsSinceProvisional = compressedCharsOf(turnEvents.filter(event => event.seq > provisionalThroughSeq && event.seq <= stableThroughSeq))

  return {
    turn,
    turnStartSeq,
    turnStartedAt,
    observedThroughSeq,
    stableThroughSeq,
    lastMeaningfulAt,
    meaningfulEvents,
    meaningfulSinceProvisional,
    compressedChars: compressedCharsOf(stableEvents),
    charsSinceProvisional,
    failures: Object.fromEntries(failures),
    failuresSinceProvisional: Object.fromEntries(failuresSinceProvisional),
    noProgressSteps,
    closedSteps,
    endedTurns: [...endedTurns],
  }
}

const EMPTY_PROVISIONAL = Object.freeze({
  turn: null,
  throughSeq: -1,
  callsInTurn: 0,
  lastDispatchedAt: null,
  lastSucceededAt: null,
})

/**
 * Decide whether the open turn's stable prefix is due for a provisional
 * semantic run under the controlled policy. Pure: no timers, no writes.
 */
export function evaluateProvisionalTrigger({ state, provisional = EMPTY_PROVISIONAL, settings, now }) {
  const normalized = normalizeAnalysisSettings(settings)
  const policy = normalized.auto.provisional
  const provisionalThroughSeq = Number.isSafeInteger(provisional?.throughSeq) ? provisional.throughSeq : -1
  const callsInTurn = Number.isSafeInteger(provisional?.callsInTurn) ? provisional.callsInTurn : 0
  const lastDispatchedAtMs = eventTime(provisional?.lastDispatchedAt, null)
  const lastMeaningfulAtMs = state?.lastMeaningfulAt ?? null
  const turnStartedAtMs = state?.turnStartedAt ?? null
  const base = {
    turn: state?.turn ?? null,
    stableThroughSeq: state?.stableThroughSeq ?? -1,
    provisionalThroughSeq,
    meaningfulSinceProvisional: state?.meaningfulSinceProvisional ?? 0,
    charsSinceProvisional: state?.charsSinceProvisional ?? 0,
    failureCounts: state?.failuresSinceProvisional ?? {},
    noProgressSteps: state?.noProgressSteps ?? 0,
    callsInTurn,
  }
  if (!normalized.auto.enabled) return { ...base, due: false, reason: 'disabled' }
  if (!policy.enabled) return { ...base, due: false, reason: 'provisional-disabled' }
  if (!normalized.defaultRoute) return { ...base, due: false, reason: 'waiting-for-model' }
  if (state?.turn === null || state === null) return { ...base, due: false, reason: 'no-open-turn' }
  if (base.stableThroughSeq <= provisionalThroughSeq) return { ...base, due: false, reason: 'nothing-new-stable' }
  if (callsInTurn >= policy.maxCallsPerTurn) return { ...base, due: false, reason: 'provisional-quota' }
  if (lastDispatchedAtMs !== null && now - lastDispatchedAtMs < policy.cooldownMs) {
    return { ...base, due: false, reason: 'provisional-cooldown', cooldownRemainingMs: lastDispatchedAtMs + policy.cooldownMs - now }
  }
  const failureKind = Object.entries(base.failureCounts).find(([, count]) => count >= policy.failureThreshold)
  if (failureKind) return { ...base, due: true, reason: 'provisional-failure-pattern', failureKind: failureKind[0] }
  if (base.noProgressSteps >= policy.noProgressSteps) return { ...base, due: true, reason: 'provisional-no-progress' }
  if (base.meaningfulSinceProvisional >= policy.meaningfulEvents) return { ...base, due: true, reason: 'provisional-events' }
  if (base.charsSinceProvisional >= policy.compressedChars) return { ...base, due: true, reason: 'provisional-input' }
  if (lastMeaningfulAtMs !== null && now - lastMeaningfulAtMs >= policy.quietMs && base.meaningfulSinceProvisional > 0) {
    return { ...base, due: true, reason: 'provisional-quiet' }
  }
  const ageMs = lastDispatchedAtMs !== null
    ? now - lastDispatchedAtMs
    : (turnStartedAtMs !== null ? now - turnStartedAtMs : 0)
  if (ageMs >= policy.maxAgeMs) return { ...base, due: true, reason: 'provisional-age' }
  return { ...base, due: false, reason: 'accumulating' }
}

/**
 * Return the next wall-clock deadline at which an accumulating open Turn must
 * be re-evaluated. Pure: the service owns the single-shot timer.
 */
export function provisionalDeadlineAt({ state, provisional = EMPTY_PROVISIONAL, settings, now }) {
  const decision = evaluateProvisionalTrigger({ state, provisional, settings, now })
  if (decision.due) return now
  if (decision.reason === 'provisional-cooldown') return now + decision.cooldownRemainingMs
  if (decision.reason !== 'accumulating') return null

  const normalized = normalizeAnalysisSettings(settings)
  const policy = normalized.auto.provisional
  const deadlines = []
  if (decision.meaningfulSinceProvisional > 0 && state?.lastMeaningfulAt !== null) {
    deadlines.push(state.lastMeaningfulAt + policy.quietMs)
  }
  const lastDispatchedAtMs = eventTime(provisional?.lastDispatchedAt, null)
  const ageBase = lastDispatchedAtMs ?? state?.turnStartedAt
  if (ageBase !== null && ageBase !== undefined) deadlines.push(ageBase + policy.maxAgeMs)
  if (deadlines.length === 0) return null
  return Math.max(now, Math.min(...deadlines))
}
