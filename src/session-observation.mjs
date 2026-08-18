function diagnostic(operation, reason) {
  return {
    operation,
    code: typeof reason?.code === 'string' ? reason.code : 'UNKNOWN',
  }
}
/** Read the raw source of truth plus optional surface and lineage observations. */
export async function readSessionObservation(sessionQuery, sessionId, signal) {
  signal?.throwIfAborted?.()
  const log = await sessionQuery.readSession(sessionId)
  signal?.throwIfAborted?.()
  const companions = await Promise.allSettled([
    sessionQuery.listEvents(sessionId),
    sessionQuery.readSurface(sessionId),
    sessionQuery.traceSession(sessionId, signal),
  ])
  signal?.throwIfAborted?.()
  const names = ['listEvents', 'readSurface', 'traceSession']
  const values = companions.map(result => result.status === 'fulfilled' ? result.value : null)
  return {
    log,
    records: values[0],
    surface: values[1],
    lineage: values[2],
    diagnostics: companions.flatMap((result, index) => result.status === 'rejected'
      ? [diagnostic(names[index], result.reason)]
      : []),
  }
}
