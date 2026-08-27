import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/client-dock-controller.js', import.meta.url), 'utf8')
const { dockGeometry, createTraceInsightDock } = vm.runInNewContext(`${source}\n;({dockGeometry, createTraceInsightDock})`)

function environment({ width = 1440, stored = null, missingRoot = false, storageBlocked = false } = {}) {
  const attributes = () => {
    const values = new Map()
    return {
      hasAttribute: name => values.has(name), setAttribute: (name, value) => values.set(name, value), removeAttribute: name => values.delete(name),
      style: { getPropertyValue: name => values.get(`style:${name}`) || '', setProperty: (name, value) => values.set(`style:${name}`, value), removeProperty: name => values.delete(`style:${name}`) },
    }
  }
  const listeners = new Map()
  const events = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
  }
  const frames = new Map()
  const hosts = new Set()
  const root = attributes()
  let otherWidth = 0
  let nextFrame = 0
  let observation = false
  const doc = {
    documentElement: { ...attributes(), clientWidth: width },
    getElementById() { return missingRoot ? null : root },
    querySelector() { return [...hosts][0] || null },
    createElement() { const node = { ...attributes(), remove() { hosts.delete(node) } }; return node },
    body: { appendChild(node) { hosts.add(node) } },
  }
  const win = {
    ...events, innerWidth: width,
    localStorage: { getItem() { if (storageBlocked) throw Error('blocked'); return stored }, setItem(_key, value) { if (storageBlocked) throw Error('blocked'); stored = value } },
    getComputedStyle() { return { getPropertyValue() { return String(otherWidth) } } },
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame }, cancelAnimationFrame(id) { frames.delete(id) },
    MutationObserver: class { observe() { observation = true } disconnect() { observation = false } },
  }
  return {
    win, doc, root, frames, hosts, listeners, events,
    emit(name, event = {}) { for (const fn of [...listeners.get(name) || []]) fn(event) },
    flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()) },
    setOther(value) { otherWidth = value },
    get stored() { return JSON.parse(stored) }, get observing() { return observation },
  }
}

test('dock geometry reserves a usable center, switches to drawer, and clamps malformed preferences', () => {
  assert.equal(dockGeometry(1440, 480, true).push, 480)
  assert.equal(dockGeometry(1200, 900, true).width, 480)
  assert.equal(dockGeometry(1039, 480, true).push, 0)
  assert.equal(dockGeometry(375, 480, true).width, 359)
  assert.equal(dockGeometry(1440, NaN, true).width, 480)
  assert.equal(dockGeometry(1440, 480, false).push, 0)
  assert.equal(dockGeometry(1440, 480, true, true).push, 0)
})

test('mount, no-session, open/close, session switch and repeated dispose restore only owned layout', () => {
  const env = environment()
  env.root.style.setProperty('--other-plugin-width', '12px')
  const dock = createTraceInsightDock(env.win, env.doc)
  for (let cycle = 0; cycle < 3; cycle++) {
    dock.mount()
    dock.setSession(undefined)
    assert.equal(env.root.hasAttribute('data-ti-dock-push'), false)
    dock.setSession('one')
    assert.equal(dock.getSnapshot().visible, true)
    assert.equal(env.root.style.getPropertyValue('--ti-dock-push'), '480px')
    dock.setSession('two')
    assert.equal(env.hosts.size, 1)
    dock.toggle()
    assert.equal(dock.getSnapshot().visible, false)
    assert.equal(env.root.hasAttribute('data-ti-dock-push'), false)
    dock.toggle()
    dock.dispose()
    dock.dispose()
    assert.equal(env.root.style.getPropertyValue('--ti-dock-push'), '')
    assert.equal(env.root.style.getPropertyValue('--other-plugin-width'), '12px')
    assert.equal(env.hosts.size, 0)
    assert.equal(env.observing, false)
    assert.equal([...env.listeners.values()].reduce((n, fns) => n + fns.size, 0), 0)
  }
})

test('resize is batched, narrow windows and other sidebars never receive an additional root push', () => {
  const env = environment()
  const dock = createTraceInsightDock(env.win, env.doc)
  dock.mount(); dock.setSession('one')
  dock.resize(550)
  assert.equal(env.stored.width, 550)
  env.doc.documentElement.clientWidth = 800
  for (let i = 0; i < 30; i++) env.emit('resize')
  assert.equal(env.frames.size, 1)
  env.flush()
  assert.equal(dock.getSnapshot().drawer, true)
  assert.equal(env.root.hasAttribute('data-ti-dock-push'), false)
  env.doc.documentElement.clientWidth = 1600
  env.emit('resize'); env.flush()
  assert.equal(dock.getSnapshot().width, 550)
  env.setOther(400); env.emit('resize'); env.flush()
  assert.equal(dock.getSnapshot().competing, true)
  assert.equal(env.root.hasAttribute('data-ti-dock-push'), false)
  dock.dispose()
})

test('drag batches paint without rerender per pointermove and disposal cancels an active drag', () => {
  const env = environment()
  const dock = createTraceInsightDock(env.win, env.doc)
  dock.mount(); dock.setSession('one')
  let notifications = 0
  const unsubscribe = dock.subscribe(() => notifications++)
  const handle = { ...env.events, setPointerCapture() {}, hasPointerCapture() { return true }, releasePointerCapture() {} }
  const start = () => dock.startDrag({ pointerId: 1, button: 0, clientX: 960, currentTarget: handle, preventDefault() {} })
  start()
  for (let x = 950; x >= 880; x--) env.emit('pointermove', { pointerId: 1, clientX: x })
  assert.equal(env.frames.size, 1)
  env.flush()
  assert.equal(notifications, 0)
  assert.equal(env.root.style.getPropertyValue('--ti-dock-push'), '560px')
  env.emit('pointerup', { pointerId: 1 })
  assert.equal(notifications, 1)
  assert.equal(env.stored.width, 560)
  start(); env.emit('pointermove', { pointerId: 1, clientX: 850 })
  dock.dispose()
  assert.equal(env.frames.size, 0)
  assert.equal(env.doc.documentElement.hasAttribute('data-ti-dock-dragging'), false)
  assert.equal([...env.listeners.values()].reduce((n, fns) => n + fns.size, 0), 0)
  unsubscribe()
})

test('missing root is visible failure without layout writes; blocked storage remains usable', () => {
  const env = environment({ missingRoot: true, storageBlocked: true })
  const dock = createTraceInsightDock(env.win, env.doc)
  dock.mount(); dock.setSession('one')
  assert.match(dock.getSnapshot().error, /无法找到 DSH/)
  assert.equal(env.root.hasAttribute('data-ti-dock-push'), false)
  dock.toggle(); dock.toggle()
  assert.equal(dock.getSnapshot().visible, true)
  dock.dispose()
})

test('duplicate mount refuses without overwriting the first owner', () => {
  const env = environment()
  const one = createTraceInsightDock(env.win, env.doc)
  const two = createTraceInsightDock(env.win, env.doc)
  one.mount(); one.setSession('one')
  assert.throws(() => two.mount(), /already active/)
  two.dispose()
  assert.equal(env.hosts.size, 1)
  assert.equal(env.root.style.getPropertyValue('--ti-dock-push'), '480px')
  one.dispose()
})

test('saved closed state, invalid storage and cancelled pointer drags preserve usable defaults', () => {
  for (const stored of ['invalid json', '{"width":-100,"open":"false"}', '{"width":99999}']) {
    const env = environment({ stored })
    const dock = createTraceInsightDock(env.win, env.doc)
    dock.mount(); dock.setSession('one')
    assert.equal(dock.getSnapshot().width, 480)
    assert.equal(dock.getSnapshot().visible, true)
    dock.dispose()
  }
  const env = environment({ stored: '{"open":false,"width":520}' })
  const dock = createTraceInsightDock(env.win, env.doc)
  dock.mount(); dock.setSession('one')
  assert.equal(dock.getSnapshot().visible, false)
  assert.equal(env.root.hasAttribute('data-ti-dock-push'), false)
  dock.setOpen(true)
  const handle = { ...env.events, setPointerCapture() {}, hasPointerCapture() { return true }, releasePointerCapture() {} }
  dock.startDrag({ pointerId: 2, button: 0, clientX: 920, currentTarget: handle, preventDefault() {} })
  env.emit('pointermove', { pointerId: 2, clientX: 820 }); env.flush()
  env.emit('pointercancel', { pointerId: 2 })
  assert.equal(dock.getSnapshot().width, 520)
  assert.equal(env.root.style.getPropertyValue('--ti-dock-push'), '520px')
  assert.equal(env.doc.documentElement.hasAttribute('data-ti-dock-dragging'), false)
  dock.dispose()
})
