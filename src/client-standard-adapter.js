const inject = ['slots', 'sessions', 'connection']
const DOCK_SLOT = 'trace-insight.panel'
const ADAPTER_STYLE_TEXT = `
#root[data-ti-dock-push] { width: calc(100% - var(--ti-dock-push)); margin-right: var(--ti-dock-push); }
[data-trace-insight-dock] { position: fixed; inset: 0; pointer-events: none; z-index: 25; }
.tiDock { pointer-events: auto; position: absolute; top: 0; bottom: 0; right: 0; width: var(--ti-dock-width); display: flex; flex-direction: column; min-width: 0; background: var(--dsw-alias-bg-base, #f5f7fb); border-left: 1px solid var(--dsw-alias-border-l2, #dce2eb); color: var(--dsw-alias-label-primary, #182136); font-family: var(--dsw-font-family, sans-serif); box-sizing: border-box; }
.tiDock[hidden] { display: none; }
.tiDock[data-drawer="true"] { box-shadow: -8px 0 28px #0003; }
.tiDockToolbar { flex: 0 0 38px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, #dce2eb); font-size: 12px; }
.tiDockClose { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 4px 8px; font-size: 20px; border-radius: 5px; }
.tiDockContent { flex: 1; min-height: 0; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
.tiDockContent > * { min-height: 0; flex: 1; }
.tiDockResize { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; touch-action: none; z-index: 2; }
.tiDockResize:hover, .tiDockResize:focus-visible { background: #4b6af040; outline: none; }
html[data-ti-dock-dragging], html[data-ti-dock-dragging] * { cursor: col-resize !important; user-select: none !important; }
.tiDockNotice { padding: 10px 14px; margin: 0; font-size: 12px; }
.tiToggle { border: 1px solid var(--dsw-alias-border-l2); min-width: 82px; height: 32px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); cursor: pointer; background: transparent; border-radius: 9px; justify-content: center; align-items: center; gap: 7px; padding: 5px 10px 5px 12px; font-size: 13px; font-weight: 500; line-height: 20px; display: inline-flex; }
.tiToggle:hover, .tiToggle[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.tiToggle:focus-visible, .tiDockClose:focus-visible { outline: 3px solid #3a56d448; outline-offset: 2px; }
.tiToggleIcon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.65; }
`

function useDockSnapshot(dock) {
  return React.useSyncExternalStore(dock.subscribe, dock.getSnapshot, dock.getSnapshot)
}

function DockToggle({ dock }) {
  const state = useDockSnapshot(dock)
  return h('button', {
    className: 'tiToggle', type: 'button',
    'aria-pressed': state.open, 'aria-controls': 'trace-insight-dock-panel',
    'aria-label': state.open ? '收起解读侧栏' : '展开解读侧栏',
    onClick: () => dock.toggle(),
  }, '解读', h('svg', { className: 'tiToggleIcon', viewBox: '0 0 24 24', 'aria-hidden': true },
    h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }), h('path', { d: 'M15 4v16' })))
}

function DockFrame({ dock, useSessions, renderSlot }) {
  const state = useDockSnapshot(dock)
  const sessionId = useSessions(s => s.current !== undefined && s.byId[s.current]?.blank === false ? s.current : undefined)
  const [host, setHost] = useState(null)
  const [visited, setVisited] = useState(false)
  React.useLayoutEffect(() => {
    setHost(dock.mount())
    return () => dock.dispose()
  }, [dock])
  React.useLayoutEffect(() => { dock.setSession(sessionId) }, [dock, sessionId])
  useEffect(() => { if (state.visible) setVisited(true) }, [state.visible])
  if (!host) return null
  const { createPortal } = require('react-dom')
  const close = () => {
    dock.setOpen(false)
    document.querySelector('.tiToggle')?.focus()
  }
  return createPortal(h('aside', {
    id: 'trace-insight-dock-panel', className: 'tiDock', 'aria-label': 'Trace Insight 解读侧栏',
    hidden: !state.visible, 'data-drawer': state.drawer,
    onKeyDown: event => {
      // Nested dialogs and evidence panels retain their own Escape handling.
      if (event.key === 'Escape' && !event.defaultPrevented && !event.target.closest('[role="dialog"]')) {
        event.stopPropagation()
        close()
      }
    },
  }, h('div', { className: 'tiDockToolbar' },
    h('span', null, 'Trace Insight · 解读'),
    h('button', { className: 'tiDockClose', type: 'button', 'aria-label': '关闭解读侧栏', onClick: close }, '×')),
  h('div', {
    className: 'tiDockResize', role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical',
    'aria-label': '调整解读侧栏宽度', 'aria-valuemin': state.min, 'aria-valuemax': state.max, 'aria-valuenow': state.width,
    onPointerDown: event => dock.startDrag(event),
    onKeyDown: event => {
      const values = { ArrowLeft: state.width + 16, ArrowRight: state.width - 16, Home: state.min, End: state.max }
      if (!(event.key in values)) return
      event.preventDefault()
      dock.resize(values[event.key])
    },
  }),
  state.competing ? h('p', { className: 'tiDockNotice', role: 'status' }, '另一个侧栏已打开，解读以浮层显示。') : null,
  state.error ? h('p', { className: 'tiDockNotice', role: 'alert' }, state.error)
    : h('div', { className: 'tiDockContent' }, (visited || state.visible) && sessionId ? renderSlot(DOCK_SLOT, {}) : null)), host)
}

function apply(ctx) {
  const dock = createTraceInsightDock(window, document)
  ctx.effect(() => installStyle(), 'trace-insight: styles')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'trace-insight-dock', order: 20,
    children: { [DOCK_SLOT]: { kind: 'single', scope: 'session' } },
    inject: () => ({ dock }),
  }, DockFrame))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'trace-insight-dock-toggle', order: 20,
    inject: () => ({ dock }),
  }, DockToggle))
  ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
    name: DOCK_SLOT,
    id: VIEW_ID,
    inject: sessionId => buildSessionFace(ctx, sessionId),
  }, TraceInsightView))
}

module.exports = { inject, apply }
