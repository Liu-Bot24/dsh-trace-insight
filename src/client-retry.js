function budgetMessages(budget = {}) {
  const violations = budget.violations || []
  const warningShadowed = code => (code === 'CALLS_WARNING' && violations.some(v => v.code === 'MAX_CALLS_EXCEEDED'))
    || (code === 'INPUT_CHARS_WARNING' && violations.some(v => v.code === 'MAX_INPUT_CHARS_EXCEEDED'))
  return [...violations, ...(budget.warnings || []).filter(value => !warningShadowed(value.code))].map(value => {
    if (typeof value === 'string') return value
    const actual = formatNumber(value.actual)
    const limit = formatNumber(value.limit)
    switch (value.code) {
      case 'MAX_CALLS_EXCEEDED': return `单批预计调用 ${actual} 次，超过上限 ${limit} 次`
      case 'MAX_INPUT_CHARS_EXCEEDED': return `单批预计输入 ${actual} 字符，超过上限 ${limit} 字符`
      case 'CALLS_WARNING': return `本次合计预计调用 ${actual} 次，达到提醒阈值 ${limit} 次`
      case 'INPUT_CHARS_WARNING': return `本次合计预计输入 ${actual} 字符，达到提醒阈值 ${limit} 字符`
      default: return value.message || value.code || '资源用量需要确认'
    }
  })
}

function batchPlanText(preview) {
  const plan = preview?.batchPlan
  if (!plan?.totalBatches) return ''
  return `共 ${plan.totalBatches} 批，将自动接续执行。每批最多 ${formatNumber(plan.limits.calls)} 次调用、${formatNumber(plan.limits.inputChars)} 输入字符；遇到调用失败或手动取消时停止。`
}

function batchProgressText(job) {
  const progress = job?.batchProgress
  if (!progress?.total) return ''
  return `${Number.isSafeInteger(progress.current) ? `正在执行第 ${progress.current + 1}/${progress.total} 批 · ` : ''}已完成 ${progress.completed}/${progress.total} 批`
}

function automaticRetryRequest(status, route, force = false) {
  const retry = status?.retry
  const coverage = status?.coverage
  if (!retry || (!retry.paused && !retry.notBefore)) throw new Error('自动重试状态已变化，请刷新时间线后重试。')
  if (!Number.isSafeInteger(retry.fromSeq) || !Number.isSafeInteger(retry.toSeq) || retry.toSeq < retry.fromSeq) {
    throw new Error('无法定位上次失败段的完整范围，请刷新后重试。不会自动扩大到全部未分析区间。')
  }
  if (retry.fromSeq !== coverage?.semanticPendingFromSeq || retry.toSeq > coverage?.closedThroughSeq) {
    throw new Error('正式分析范围已变化，请刷新时间线后重试。')
  }
  if (status.activeJobs?.some(job => (job.coverageRole || job.mode) === 'primary')) {
    throw new Error('已有正式分析任务正在运行，请等待完成或取消后再重试。')
  }
  if (!route?.provider || !route?.model) throw new Error('请选择本次重试使用的模型。')
  return { mode: 'primary', fromSeq: retry.fromSeq, toSeq: retry.toSeq, route, force }
}

function AutomaticRetryPanel({ api, sessionId, models, initialRoute, onCompleted, onClose }) {
  const [modelKey, setModelKey] = useState(() => routeKey(initialRoute))
  const [force, setForce] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [preview, setPreview] = useState(null)
  const [preparing, setPreparing] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState(null)
  const [override, setOverride] = useState(false)
  const [reason, setReason] = useState('')
  const startInFlight = useRef(false)
  const selection = `${sessionId}:${modelKey}:${force}:${attempt}`
  const selected = useRef(selection)
  selected.current = selection

  useEffect(() => {
    let active = true
    setPreparing(true)
    setPreview(null)
    setJob(null)
    setError('')
    setOverride(false)
    setReason('')
    const prepare = async () => {
      try {
        const status = await api.readStatus()
        if (!active) return
        const request = automaticRetryRequest(status, parseRouteKey(modelKey), force)
        const value = await api.previewAnalysis(request)
        if (!active) return
        setPreview({ ...value, request, selection, idempotencyKey: `retry-${stableClientKey(`${sessionId}:${value.previewToken}:${attempt}`)}` })
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (active) setPreparing(false)
      }
    }
    prepare()
    return () => { active = false }
  }, [api, sessionId, modelKey, force, attempt])

  useEffect(() => {
    if (!job?.id || !['queued', 'running', 'cancelling'].includes(job.status)) return
    let active = true
    let pending = false
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const value = await api.readJob(job.id)
        if (!active) return
        const next = normalizeJob(value, job)
        setJob(current => commitJobIfFresh(current, value))
        if (next && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(next.status)) await onCompleted()
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : String(failure))
      } finally { pending = false }
    }
    poll()
    const interval = setInterval(poll, 2500)
    return () => { active = false; clearInterval(interval) }
  }, [api, job?.id, job?.status, onCompleted])

  const start = async () => {
    if (!preview || preview.selection !== selection || preparing || startInFlight.current || job) return
    const exceeded = preview.budgetAssessment?.hardLimitExceeded
    if (exceeded && (!override || !reason.trim())) return
    startInFlight.current = true
    setStarting(true)
    setError('')
    try {
      const value = await api.startAnalysis({ ...preview.request, previewToken: preview.previewToken,
        idempotencyKey: preview.idempotencyKey,
        ...(exceeded ? { overrideBudget: true, overrideReason: reason.trim() } : {}),
      })
      if (selected.current !== selection) return
      setJob(normalizeJob(value))
    } catch (failure) {
      if (selected.current !== selection) return
      setError(failure instanceof Error ? failure.message : String(failure))
      if (['PREVIEW_STALE', 'PRIMARY_RANGE_GAP', 'PRIMARY_JOB_ACTIVE'].includes(failure?.code)) setPreview(null)
    } finally {
      startInFlight.current = false
      setStarting(false)
    }
  }
  const cancel = async () => {
    try { const value = await api.cancelAnalysis(job.id, job.revision); setJob(current => commitJobIfFresh(current, value)) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const reprepare = () => setAttempt(value => value + 1)
  const item = preview?.request || job
  if (!item) return h('section', { className: 'tiSegmentAnalysis', 'aria-label': '手动重试' },
    h('div', { className: 'tiSegmentAnalysisHead' }, h('div', { className: 'tiSegmentAnalysisTitle' }, '手动重试'),
      h('button', { className: 'tiButton tiButton--quiet', type: 'button', onClick: onClose }, '收起')),
    h('label', { className: 'tiField' }, h('span', { className: 'tiLabel' }, '本次使用的模型'),
      h('select', { className: 'tiSelect', value: modelKey, onChange: event => setModelKey(event.target.value) }, ...modelOptions(models, true))),
    preparing ? h('div', { role: 'status' }, '正在读取失败段并预览用量，不会调用模型。') : null,
    error ? h('div', { className: 'tiNotice tiNotice--error', role: 'alert' }, error,
      h('button', { className: 'tiButton', type: 'button', onClick: reprepare }, '重新预览')) : null)
  return h(SegmentAnalysisPanel, { primaryRetry: true, item, models, modelKey, onModelChange: setModelKey,
    forceRun: force, onForceChange: setForce, preview, previewLoading: preparing, previewReady: preview?.selection === selection,
    startLoading: starting, error, job, blockedByOtherJob: false, supportsJobs: true,
    overrideBudget: override, overrideReason: reason, onOverrideBudget: setOverride, onOverrideReason: setReason,
    onStart: start, onCancel: cancel, onRetry: reprepare, onRetryPreview: reprepare, onClose })
}
