const inject = ['slots', 'sessions', 'connection', 'layout']

const ADAPTER_STYLE_TEXT = `
.tiToggle { border: 1px solid var(--dsw-alias-border-l2); min-width: 82px; height: 32px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); cursor: pointer; background: transparent; border-radius: 9px; justify-content: center; align-items: center; gap: 7px; padding: 5px 10px 5px 12px; font-size: 13px; font-weight: 500; line-height: 20px; display: inline-flex; }
.tiToggle:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.tiToggle[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover); border-color: currentColor; }
.tiToggleIcon { width: 18px; height: 18px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.65; stroke-linecap: round; stroke-linejoin: round; }
.tiToggleIconPanel { fill: transparent; stroke: none; transition: fill .15s ease; }
.tiToggle[aria-pressed="true"] .tiToggleIconPanel { fill: currentColor; opacity: .13; }
.tiToggle:focus-visible { outline: 3px solid rgba(58, 86, 212, .28); outline-offset: 2px; }
`

function InspectorToggle({ layout }) {
  const [open, setOpen] = useState(() => layout.isInspectorOpen())
  useEffect(() => layout.onChange(setOpen), [layout])
  return h('button', {
    className: 'tiToggle',
    type: 'button',
    'aria-pressed': open,
    'aria-label': open ? '收起解读检查器' : '展开解读检查器',
    title: open ? '收起解读检查器' : '展开解读检查器',
    onClick: () => layout.toggleInspector(),
  },
    h('span', null, '解读'),
    h('svg', { className: 'tiToggleIcon', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      h('rect', { className: 'tiToggleIconPanel', x: '15', y: '4', width: '6', height: '16', rx: '1.5' }),
      h('rect', { x: '3', y: '4', width: '18', height: '16', rx: '2.5' }),
      h('path', { d: 'M15 4v16' }),
    ),
  )
}

function apply(ctx) {
  ctx.effect(() => installStyle(), 'trace-insight: styles')
  if (ctx.slots.spec?.('inspector')) {
    ctx.slots.inject('inspector', () => ctx.slots.register({
      name: 'inspector',
      id: VIEW_ID,
      inject: sessionId => buildSessionFace(ctx, sessionId),
    }, TraceInsightView))
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'trace-insight-inspector-toggle',
      order: 20,
      inject: () => ({ layout: ctx.layout }),
    }, InspectorToggle))
  } else {
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: VIEW_ID,
      order: 20,
      label: () => VIEW_LABEL,
      inject: sessionId => buildSessionFace(ctx, sessionId),
    }, TraceInsightView))
  }
}

module.exports = { inject, apply }
