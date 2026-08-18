import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DEFAULT_ANALYSIS_SETTINGS, normalizeAnalysisSettings } from './analysis-policy.mjs'

export const ANALYSIS_HISTORY_VERSION = 1
export const SETTINGS_STATE_VERSION = 1
const MAX_CHANGE_LOG = 2_000
const RETRIABLE_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])
const DEFAULT_RENAME_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400, 800])

function clone(value) {
  return structuredClone(value)
}

function nowIso(now) {
  return new Date(now()).toISOString()
}

export function createEmptySessionHistory(sessionId, now = Date.now) {
  const timestamp = nowIso(now)
  return {
    schemaVersion: ANALYSIS_HISTORY_VERSION,
    revision: 0,
    timelineRevision: 0,
    programmaticRevision: 0,
    sessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastObservedSeq: -1,
    lastClosedSeq: -1,
    settingsOverride: null,
    settingsRevision: 0,
    diagnostics: [],
    jobs: [],
    changes: [],
    changesFloorRevision: 0,
    annotations: {
      revision: 0,
      items: [],
    },
    automatic: {
      enrolled: false,
      enrolledAt: null,
      lastLiveTurnSeq: null,
    },
    live: {
      revision: 0,
      items: [],
      provisional: {
        turn: null,
        throughSeq: -1,
        callsInTurn: 0,
        lastDispatchedAt: null,
        lastSucceededAt: null,
      },
    },
    programmatic: {
      coveredThroughSeq: -1,
      checkpoints: [],
    },
    semantic: {
      coveredThroughSeq: -1,
      continuitySummary: '',
      primaryRunId: null,
      retry: null,
      runs: [],
    },
  }
}

function assertSessionHistory(value, sessionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trace Insight history is not an object.')
  if (value.schemaVersion !== ANALYSIS_HISTORY_VERSION) {
    throw new Error(`Trace Insight history schema ${String(value.schemaVersion)} is unsupported.`)
  }
  if (value.sessionId !== sessionId) throw new Error('Trace Insight history session identity does not match its file.')
  if (!Array.isArray(value.programmatic?.checkpoints) || !Array.isArray(value.semantic?.runs)) {
    throw new Error('Trace Insight history is missing required collections.')
  }
  if (value.diagnostics !== undefined && !Array.isArray(value.diagnostics)) {
    throw new Error('Trace Insight history diagnostics must be an array.')
  }
  value.diagnostics ??= []
  value.jobs ??= []
  value.changes ??= []
  if (!Array.isArray(value.jobs) || !Array.isArray(value.changes)) {
    throw new Error('Trace Insight history jobs and changes must be arrays.')
  }
  if (value.annotations !== undefined
    && (!value.annotations || typeof value.annotations !== 'object' || Array.isArray(value.annotations))) {
    throw new Error('Trace Insight history annotations must be an object.')
  }
  value.annotations ??= { revision: 0, items: [] }
  if (!Array.isArray(value.annotations.items)) throw new Error('Trace Insight history annotation items must be an array.')
  value.annotations.revision = Number.isSafeInteger(value.annotations.revision) && value.annotations.revision >= 0
    ? value.annotations.revision
    : 0
  value.revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0
  value.timelineRevision = Number.isSafeInteger(value.timelineRevision) && value.timelineRevision >= 0
    ? value.timelineRevision
    : value.revision
  value.programmaticRevision = Number.isSafeInteger(value.programmaticRevision) && value.programmaticRevision >= 0
    ? value.programmaticRevision
    : (value.programmatic.checkpoints.length > 0 ? value.timelineRevision : 0)
  value.changesFloorRevision = Number.isSafeInteger(value.changesFloorRevision) && value.changesFloorRevision >= 0
    ? value.changesFloorRevision
    : Math.max(0, (value.changes.at(0)?.revision ?? 1) - 1)
  value.lastClosedSeq = Number.isSafeInteger(value.lastClosedSeq)
    ? value.lastClosedSeq
    : (Number.isSafeInteger(value.programmatic.coveredThroughSeq) ? value.programmatic.coveredThroughSeq : -1)
  value.settingsOverride = value.settingsOverride && typeof value.settingsOverride === 'object' && !Array.isArray(value.settingsOverride)
    ? value.settingsOverride
    : null
  value.settingsRevision = Number.isSafeInteger(value.settingsRevision) && value.settingsRevision >= 0
    ? value.settingsRevision
    : 0
  if (value.automatic !== undefined && (!value.automatic || typeof value.automatic !== 'object' || Array.isArray(value.automatic))) {
    throw new Error('Trace Insight history automatic enrollment is invalid.')
  }
  value.automatic ??= {
    enrolled: value.semantic.runs.some(run => run?.mode === 'auto'),
    enrolledAt: null,
    lastLiveTurnSeq: null,
  }
  value.automatic.enrolled = value.automatic.enrolled === true
  value.automatic.enrolledAt = typeof value.automatic.enrolledAt === 'string' ? value.automatic.enrolledAt : null
  value.automatic.lastLiveTurnSeq = Number.isSafeInteger(value.automatic.lastLiveTurnSeq)
    ? value.automatic.lastLiveTurnSeq
    : null
  // Live open-turn section (lazy migration for pre-live history files).
  if (value.live !== undefined
    && (!value.live || typeof value.live !== 'object' || Array.isArray(value.live))) {
    throw new Error('Trace Insight history live section must be an object.')
  }
  value.live ??= { revision: 0, items: [] }
  if (!Array.isArray(value.live.items)) throw new Error('Trace Insight history live items must be an array.')
  if (value.live.provisional !== undefined
    && (!value.live.provisional || typeof value.live.provisional !== 'object' || Array.isArray(value.live.provisional))) {
    throw new Error('Trace Insight history provisional state is invalid.')
  }
  value.live.provisional ??= { turn: null, throughSeq: -1, callsInTurn: 0, lastDispatchedAt: null, lastSucceededAt: null }
  value.live.provisional = {
    turn: Number.isSafeInteger(value.live.provisional.turn) ? value.live.provisional.turn : null,
    throughSeq: Number.isSafeInteger(value.live.provisional.throughSeq) ? value.live.provisional.throughSeq : -1,
    callsInTurn: Number.isSafeInteger(value.live.provisional.callsInTurn) ? Math.max(0, value.live.provisional.callsInTurn) : 0,
    lastDispatchedAt: typeof value.live.provisional.lastDispatchedAt === 'string' ? value.live.provisional.lastDispatchedAt : null,
    lastSucceededAt: typeof value.live.provisional.lastSucceededAt === 'string' ? value.live.provisional.lastSucceededAt : null,
  }
  value.live.revision = Number.isSafeInteger(value.live.revision) && value.live.revision >= 0
    ? value.live.revision
    : 0
  value.semantic.retry ??= null
  for (const collection of [value.programmatic.checkpoints, value.semantic.runs, value.diagnostics, value.jobs, value.annotations.items]) {
    for (const item of collection) {
      if (item && typeof item === 'object' && !Number.isSafeInteger(item.revision)) item.revision = 0
    }
  }
  return value
}

function revisionConflict(expectedRevision, actualRevision) {
  return Object.assign(new Error(`Expected revision ${expectedRevision}, but the current revision is ${actualRevision}.`), {
    code: 'REVISION_CONFLICT',
    details: { expectedRevision, actualRevision },
  })
}

function assertExpectedRevision(expectedRevision, actualRevision) {
  if (expectedRevision === undefined || expectedRevision === null) return
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== actualRevision) {
    throw revisionConflict(expectedRevision, actualRevision)
  }
}

function withoutRevision(value) {
  if (!value || typeof value !== 'object') return value
  const copy = clone(value)
  delete copy.revision
  return copy
}

function sameRecord(left, right) {
  return JSON.stringify(withoutRevision(left)) === JSON.stringify(withoutRevision(right))
}

function historyCollections(history) {
  return [
    ['programmatic', history.programmatic.checkpoints],
    ['semantic', history.semantic.runs],
    ['diagnostic', history.diagnostics],
    ['job', history.jobs],
    ['annotation', history.annotations?.items ?? []],
  ]
}

function stampHistoryRevision(current, next, revision) {
  const changes = []
  const currentCollections = new Map(historyCollections(current).map(([kind, items]) => [kind, new Map(items.map(item => [item?.id, item]))]))
  for (const [kind, items] of historyCollections(next)) {
    const prior = currentCollections.get(kind) ?? new Map()
    const nextIds = new Set()
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue
      nextIds.add(item.id)
      const previous = prior.get(item.id)
      if (previous && sameRecord(previous, item)) {
        item.revision = Number.isSafeInteger(previous.revision) ? previous.revision : 0
      } else {
        item.revision = revision
        changes.push({ revision, operation: previous ? 'updated' : 'added', kind, id: item.id })
      }
    }
    for (const id of prior.keys()) {
      if (typeof id === 'string' && !nextIds.has(id)) changes.push({ revision, operation: 'removed', kind, id })
    }
  }
  if (JSON.stringify(current.settingsOverride) !== JSON.stringify(next.settingsOverride)
    || current.settingsRevision !== next.settingsRevision) {
    changes.push({ revision, operation: 'updated', kind: 'settings', id: 'session-override' })
  }
  const annotationChanged = changes.some(change => change.kind === 'annotation')
  const timelineChanged = changes.some(change => ['programmatic', 'semantic', 'diagnostic', 'job'].includes(change.kind))
  const programmaticChanged = changes.some(change => change.kind === 'programmatic')
  next.annotations.revision = annotationChanged
    ? (current.annotations?.revision ?? 0) + 1
    : (current.annotations?.revision ?? 0)
  next.timelineRevision = timelineChanged
    ? (current.timelineRevision ?? current.revision ?? 0) + 1
    : (current.timelineRevision ?? current.revision ?? 0)
  next.programmaticRevision = programmaticChanged
    ? (current.programmaticRevision ?? 0) + 1
    : (current.programmaticRevision ?? 0)
  next.revision = revision
  const combinedChanges = [...(Array.isArray(current.changes) ? current.changes : []), ...changes]
  const removedChanges = combinedChanges.length > MAX_CHANGE_LOG
    ? combinedChanges.slice(0, combinedChanges.length - MAX_CHANGE_LOG)
    : []
  next.changesFloorRevision = removedChanges.length > 0
    ? Math.max(current.changesFloorRevision ?? 0, ...removedChanges.map(change => change.revision ?? 0))
    : (current.changesFloorRevision ?? 0)
  next.changes = combinedChanges.slice(-MAX_CHANGE_LOG)
  return next
}

function settingsState(value, initialSettings) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.settings && Number.isSafeInteger(value.revision)) {
    return {
      schemaVersion: SETTINGS_STATE_VERSION,
      revision: Math.max(0, value.revision),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
      settings: normalizeAnalysisSettings(value.settings, initialSettings),
    }
  }
  return {
    schemaVersion: SETTINGS_STATE_VERSION,
    revision: 0,
    updatedAt: null,
    settings: normalizeAnalysisSettings(value ?? initialSettings, initialSettings),
  }
}

function expandTilde(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export function defaultTraceInsightDataDir(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(resolve(expandTilde(configured)), 'trace-insight')
}

function resolveRootDir(rootDir, env) {
  if (rootDir === undefined || rootDir === null || rootDir === '') return defaultTraceInsightDataDir(env)
  if (typeof rootDir !== 'string' || !isAbsolute(expandTilde(rootDir))) {
    throw new TypeError('Trace Insight dataDir must be an absolute path.')
  }
  return resolve(expandTilde(rootDir))
}

function sessionFileName(sessionId) {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`
}

/**
 * File-backed Analysis History Store implementation.
 * Every session update is serialized through the same small update interface.
 */
export class FileHistoryStore {
  constructor({
    rootDir,
    env = process.env,
    now = Date.now,
    initialSettings = DEFAULT_ANALYSIS_SETTINGS,
    renameFile = rename,
    sleep: wait = sleep,
    renameRetryDelaysMs = DEFAULT_RENAME_RETRY_DELAYS_MS,
  } = {}) {
    this.rootDir = resolveRootDir(rootDir, env)
    this.sessionsDir = join(this.rootDir, 'sessions')
    this.settingsPath = join(this.rootDir, 'settings.json')
    this.now = now
    this.initialSettings = normalizeAnalysisSettings(initialSettings)
    this.renameFile = renameFile
    this.sleep = wait
    this.renameRetryDelaysMs = [...renameRetryDelaysMs]
    this.queues = new Map()
  }

  async initialize() {
    await mkdir(this.sessionsDir, { recursive: true })
  }

  sessionPath(sessionId) {
    return join(this.sessionsDir, sessionFileName(sessionId))
  }

  async readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (error instanceof SyntaxError) throw new Error(`Trace Insight refused malformed JSON at ${path}.`, { cause: error })
      throw error
    }
  }

  async atomicWrite(path, value) {
    await mkdir(dirname(path), { recursive: true })
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, serialized, 'utf8')
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.renameFile(temporary, path)
          break
        } catch (error) {
          const retryDelayMs = this.renameRetryDelaysMs[attempt]
          if (!RETRIABLE_RENAME_ERROR_CODES.has(error?.code)
            || !Number.isFinite(retryDelayMs)
            || retryDelayMs < 0) throw error
          await this.sleep(retryDelayMs)
        }
      }
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  enqueue(key, operation) {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    const tail = current.catch(() => {}).finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    this.queues.set(key, tail)
    return current
  }

  async getSettings() {
    return (await this.getSettingsState()).settings
  }

  async getSettingsState() {
    const value = await this.readJson(this.settingsPath)
    return clone(settingsState(value, this.initialSettings))
  }

  async updateSettingsState(updater, { expectedRevision } = {}) {
    return this.enqueue('settings', async () => {
      const current = await this.getSettingsState()
      assertExpectedRevision(expectedRevision, current.revision)
      const proposed = typeof updater === 'function' ? await updater(clone(current.settings)) : updater
      const next = {
        schemaVersion: SETTINGS_STATE_VERSION,
        revision: current.revision + 1,
        updatedAt: nowIso(this.now),
        settings: normalizeAnalysisSettings(proposed, current.settings),
      }
      await this.atomicWrite(this.settingsPath, next)
      return clone(next)
    })
  }

  async updateSettings(updater, options) {
    return (await this.updateSettingsState(updater, options)).settings
  }

  async getSession(sessionId) {
    const value = await this.readJson(this.sessionPath(sessionId))
    return clone(value === undefined
      ? createEmptySessionHistory(sessionId, this.now)
      : assertSessionHistory(value, sessionId))
  }

  async updateSession(sessionId, updater, { expectedRevision } = {}) {
    return this.enqueue(`session:${sessionId}`, async () => {
      const current = await this.getSession(sessionId)
      assertExpectedRevision(expectedRevision, current.revision)
      const proposed = await updater(clone(current))
      const next = stampHistoryRevision(current, assertSessionHistory(proposed, sessionId), current.revision + 1)
      next.updatedAt = nowIso(this.now)
      await this.atomicWrite(this.sessionPath(sessionId), next)
      return clone(next)
    })
  }

  /**
   * Live open-turn write path: bumps only the independent `live.revision`
   * (and each live item's own revision) without touching history revisions,
   * the change log, or timeline cursors. Mutable live state must never
   * contaminate immutable final history.
   */
  async updateLiveSession(sessionId, updater) {
    return this.enqueue(`session:${sessionId}`, async () => {
      const current = await this.getSession(sessionId)
      const proposed = assertSessionHistory(await updater(clone(current)), sessionId)
      proposed.live.revision = (current.live?.revision ?? 0) + 1
      for (const item of proposed.live.items) item.revision = proposed.live.revision
      proposed.updatedAt = nowIso(this.now)
      await this.atomicWrite(this.sessionPath(sessionId), proposed)
      return clone(proposed)
    })
  }

  async listSessions() {
    let files
    try {
      files = await readdir(this.sessionsDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const histories = []
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const value = await this.readJson(join(this.sessionsDir, entry.name))
      if (value?.sessionId) histories.push(clone(assertSessionHistory(value, value.sessionId)))
    }
    return histories.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }
}

/** In-memory implementation used through the same interface in tests. */
export class MemoryHistoryStore {
  constructor({ now = Date.now, initialSettings = DEFAULT_ANALYSIS_SETTINGS } = {}) {
    this.now = now
    this.settings = normalizeAnalysisSettings(initialSettings)
    this.settingsRevision = 0
    this.settingsUpdatedAt = null
    this.sessions = new Map()
    this.queues = new Map()
  }

  async initialize() {}

  enqueue(key, operation) {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    const tail = current.catch(() => {}).finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    this.queues.set(key, tail)
    return current
  }

  async getSettings() { return clone(this.settings) }

  async getSettingsState() {
    return clone({
      schemaVersion: SETTINGS_STATE_VERSION,
      revision: this.settingsRevision,
      updatedAt: this.settingsUpdatedAt,
      settings: this.settings,
    })
  }

  async updateSettingsState(updater, { expectedRevision } = {}) {
    return this.enqueue('settings', async () => {
      assertExpectedRevision(expectedRevision, this.settingsRevision)
      const proposed = typeof updater === 'function' ? await updater(clone(this.settings)) : updater
      this.settings = normalizeAnalysisSettings(proposed, this.settings)
      this.settingsRevision += 1
      this.settingsUpdatedAt = nowIso(this.now)
      return this.getSettingsState()
    })
  }

  async updateSettings(updater, options) {
    return (await this.updateSettingsState(updater, options)).settings
  }

  async getSession(sessionId) {
    const value = this.sessions.get(sessionId)
    return clone(value === undefined
      ? createEmptySessionHistory(sessionId, this.now)
      : assertSessionHistory(clone(value), sessionId))
  }

  async updateSession(sessionId, updater, { expectedRevision } = {}) {
    return this.enqueue(`session:${sessionId}`, async () => {
      const current = await this.getSession(sessionId)
      assertExpectedRevision(expectedRevision, current.revision)
      const proposed = assertSessionHistory(await updater(clone(current)), sessionId)
      const next = stampHistoryRevision(current, proposed, current.revision + 1)
      next.updatedAt = nowIso(this.now)
      this.sessions.set(sessionId, clone(next))
      return clone(next)
    })
  }

  /** Live write path: independent live revision only (see FileHistoryStore). */
  async updateLiveSession(sessionId, updater) {
    return this.enqueue(`session:${sessionId}`, async () => {
      const current = await this.getSession(sessionId)
      const proposed = assertSessionHistory(await updater(clone(current)), sessionId)
      proposed.live.revision = (current.live?.revision ?? 0) + 1
      for (const item of proposed.live.items) item.revision = proposed.live.revision
      proposed.updatedAt = nowIso(this.now)
      this.sessions.set(sessionId, clone(proposed))
      return clone(proposed)
    })
  }

  async listSessions() {
    return [...this.sessions.values()].map(clone)
  }
}
