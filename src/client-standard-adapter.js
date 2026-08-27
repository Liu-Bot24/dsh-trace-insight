const inject = ['slots', 'sessions', 'connection']
const ADAPTER_STYLE_TEXT = ''

function apply(ctx) {
  ctx.effect(() => installStyle(), 'trace-insight: styles')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: VIEW_ID,
    order: 20,
    label: () => VIEW_LABEL,
    inject: sessionId => buildSessionFace(ctx, sessionId),
  }, TraceInsightView))
}

module.exports = { inject, apply }
