import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/client-standard-adapter.js', import.meta.url), 'utf8')
const { bindDockDrawerDismissals } = vm.runInNewContext(`${source}\n;({bindDockDrawerDismissals})`, { module: { exports: {} } })

test('sidebar has no extra title row or close button and retains its original header toggle', () => {
  assert.doesNotMatch(source, /tiDockToolbar|tiDockClose|Trace Insight · 解读|关闭解读侧栏/)
  assert.match(source, /className: 'tiToggle'/)
  assert.match(source, /onClick: \(\) => dock.toggle\(\)/)
})

test('narrow drawer can close without an added button while preserving inner controls and dialogs', () => {
  const listeners = new Map()
  const doc = {
    addEventListener(type, callback) { listeners.set(type, callback) },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type) },
  }
  let closes = 0
  const dispose = bindDockDrawerDismissals(doc, () => closes++)
  const event = (selector = '', extra = {}) => ({
    target: { closest(query) { return selector && query.includes(selector) ? {} : null } },
    ...extra,
  })
  for (const selector of ['.tiDock', '.tiToggle', '[role="dialog"]', '[role="menu"]', '[role="listbox"]']) {
    listeners.get('pointerdown')(event(selector))
  }
  listeners.get('pointerdown')(event('', { defaultPrevented: true }))
  assert.equal(closes, 0)
  listeners.get('pointerdown')(event())
  assert.equal(closes, 1)
  for (const selector of ['[role="dialog"]', '[role="menu"]', '[role="listbox"]']) {
    listeners.get('keydown')(event(selector, { key: 'Escape' }))
  }
  listeners.get('keydown')(event('', { key: 'Escape', defaultPrevented: true }))
  listeners.get('keydown')(event('', { key: 'Enter' }))
  assert.equal(closes, 1)
  listeners.get('keydown')(event('', { key: 'Escape' }))
  assert.equal(closes, 2)
  dispose()
  assert.equal(listeners.size, 0)
})
