// Runtime-only geometry. This module never reads or writes DSH installation files.
const TI_DOCK_MIN = 320
const TI_DOCK_MAIN_MIN = 720
const TI_DOCK_DEFAULT = 480
const TI_DOCK_STORAGE = 'trace-insight:dock:v1'

function dockGeometry(viewport, preferred, visible, competing = false) {
  const available = Math.max(1, Math.floor(viewport))
  const drawer = competing || available < TI_DOCK_MAIN_MIN + TI_DOCK_MIN
  const max = Math.max(1, drawer ? available - 16 : available - TI_DOCK_MAIN_MIN)
  const min = Math.min(TI_DOCK_MIN, max)
  const width = Math.min(max, Math.max(min, Number.isFinite(preferred) ? preferred : TI_DOCK_DEFAULT))
  return { width, min, max, drawer, push: visible && !drawer ? width : 0 }
}

function createTraceInsightDock(win, doc) {
  let preference = { open: true, width: TI_DOCK_DEFAULT }
  let sessionId
  let root
  let host
  let resizeFrame
  let drag
  let observer
  let error = ''
  const subscribers = new Set()
  let snapshot = { open: true, visible: false, width: TI_DOCK_DEFAULT, min: TI_DOCK_MIN, max: TI_DOCK_DEFAULT, drawer: false, competing: false, error: '' }
  const notify = () => {
    const next = { ...geometry(), open: preference.open, visible: Boolean(preference.open && sessionId), error }
    if (Object.keys(next).some(key => next[key] !== snapshot[key])) {
      snapshot = next
      for (const callback of subscribers) callback()
    }
  }
  const competing = () => Number.parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue('--dsh-sidebar-width')) > 0
  const geometry = () => {
    const other = Boolean(host && competing())
    return { ...dockGeometry(doc.documentElement.clientWidth || win.innerWidth, preference.width, Boolean(preference.open && sessionId && !error), other), competing: other }
  }
  const setStyle = (element, name, value) => {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
  }
  function paint(publish = true) {
    if (!host) return
    const current = geometry()
    setStyle(host, '--ti-dock-width', `${current.width}px`)
    if (root && current.push > 0) {
      setStyle(root, '--ti-dock-push', `${current.push}px`)
      root.setAttribute('data-ti-dock-push', '')
    } else if (root) {
      root.removeAttribute('data-ti-dock-push')
      root.style.removeProperty('--ti-dock-push')
    }
    if (publish) notify()
  }
  function persist() {
    // Optional browser preferences must not prevent opening the analysis view.
    try { win.localStorage.setItem(TI_DOCK_STORAGE, JSON.stringify(preference)) } catch {}
  }
  function schedulePaint() {
    if (resizeFrame !== undefined) return
    resizeFrame = win.requestAnimationFrame(() => {
      resizeFrame = undefined
      paint()
    })
  }
  function stopDrag(commit = true) {
    if (!drag) return
    const previous = drag
    drag = undefined
    win.removeEventListener('pointermove', moveDrag)
    win.removeEventListener('pointerup', endDrag)
    win.removeEventListener('pointercancel', cancelDrag)
    win.removeEventListener('blur', cancelDrag)
    previous.element.removeEventListener('lostpointercapture', cancelDrag)
    if (previous.element.hasPointerCapture?.(previous.id)) previous.element.releasePointerCapture(previous.id)
    doc.documentElement.removeAttribute('data-ti-dock-dragging')
    if (resizeFrame !== undefined) win.cancelAnimationFrame(resizeFrame)
    resizeFrame = undefined
    if (!commit) preference.width = previous.width
    else persist()
    paint()
  }
  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.id) return
    const limits = geometry()
    preference.width = Math.min(limits.max, Math.max(limits.min, drag.width + drag.x - event.clientX))
    if (resizeFrame !== undefined) return
    resizeFrame = win.requestAnimationFrame(() => {
      resizeFrame = undefined
      paint(false)
    })
  }
  function endDrag(event) { if (event.pointerId === drag?.id) stopDrag() }
  function cancelDrag() { stopDrag(false) }
  return {
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback) },
    getSnapshot() { return snapshot },
    mount() {
      if (host) throw new Error('Trace Insight sidebar is already mounted.')
      try {
        const stored = JSON.parse(win.localStorage.getItem(TI_DOCK_STORAGE))
        if (typeof stored?.open === 'boolean') preference.open = stored.open
        if (Number.isFinite(stored?.width) && stored.width >= TI_DOCK_MIN && stored.width <= 8192) preference.width = stored.width
      } catch {}
      const candidate = doc.getElementById('root')
      if (candidate?.hasAttribute('data-ti-dock-push') || doc.querySelector('[data-trace-insight-dock]')) {
        throw new Error('Trace Insight sidebar is already active. Refresh DSH before enabling it again.')
      }
      root = candidate
      if (!root) error = '无法找到 DSH 主界面。解读侧栏没有改变页面布局，请刷新页面后重试。'
      host = doc.createElement('div')
      host.setAttribute('data-trace-insight-dock', '')
      doc.body.appendChild(host)
      win.addEventListener('resize', schedulePaint)
      observer = new win.MutationObserver(schedulePaint)
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style'] })
      paint()
      return host
    },
    setSession(value) { sessionId = value; stopDrag(false); paint() },
    toggle() { this.setOpen(!preference.open) },
    setOpen(value) { stopDrag(false); preference.open = Boolean(value); persist(); paint() },
    resize(value) {
      const limits = geometry()
      preference.width = Math.min(limits.max, Math.max(limits.min, value))
      persist()
      paint()
    },
    startDrag(event) {
      if (event.button !== 0 || drag || !snapshot.visible) return
      event.preventDefault()
      drag = { id: event.pointerId, element: event.currentTarget, x: event.clientX, width: geometry().width }
      drag.element.setPointerCapture(event.pointerId)
      drag.element.addEventListener('lostpointercapture', cancelDrag)
      doc.documentElement.setAttribute('data-ti-dock-dragging', '')
      win.addEventListener('pointermove', moveDrag)
      win.addEventListener('pointerup', endDrag)
      win.addEventListener('pointercancel', cancelDrag)
      win.addEventListener('blur', cancelDrag)
    },
    dispose() {
      stopDrag(false)
      if (resizeFrame !== undefined) win.cancelAnimationFrame(resizeFrame)
      resizeFrame = undefined
      observer?.disconnect()
      observer = undefined
      win.removeEventListener('resize', schedulePaint)
      if (root) {
        root.removeAttribute('data-ti-dock-push')
        root.style.removeProperty('--ti-dock-push')
      }
      host?.remove()
      host = undefined
      root = undefined
      error = ''
    },
  }
}
