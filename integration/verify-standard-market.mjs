import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:3184')
assert.equal(base.protocol, 'http:')
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname))
assert.ok(base.port && base.port !== '3080', 'Never test against the daily DSH port.')
const name = 'dsh-plugin-trace-insight'
const url = 'https://github.com/Liu-Bot24/dsh-trace-insight/tree/main/packages/standard'
const fixture = 'dsh-plugin-trace-insight-fixture-llm'
const sessionId = 'session-standard-demo-0001'
async function market(action, payload, status = 200) {
  const response = await fetch(new URL(`/dsh-market/${action}`, base), {
    method: payload ? 'POST' : 'GET',
    headers: { origin: base.origin, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(120_000),
  })
  const result = await response.json()
  assert.equal(response.status, status, `${action}: ${JSON.stringify(result)}`)
  if (payload && status === 200) assert.equal(result.ok, true, JSON.stringify(result))
  return result
}
async function rpc(method, payload = {}) {
  const response = await fetch(new URL(`/trace-insight/${method}`, base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status !== 200) return null
  const result = await response.json()
  return result.result?.ok ? result.result.value : null
}
async function activation(enabled) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await rpc('capabilities/read')
    if (enabled ? result?.serviceVersion === '1.4.0' : result === null) return
    await delay(100)
  }
  throw new Error(`Host did not become ${enabled ? 'active' : 'inactive'}.`)
}
function dataFingerprint(value) {
  assert.ok(value?.analysis)
  return {
    global: value.analysis.settings.global,
    override: value.analysis.settings.sessionOverride,
    runs: value.analysis.history.semantic.runs,
    checkpoints: value.analysis.history.programmatic.checkpoints,
  }
}
let status = await market('status')
assert.ok(status.installed[fixture], 'Only run in the dedicated fixture profile.')
assert.equal(status.installed[name], undefined, 'Start after the CLI uninstall check.')
const installed = await market('install', { url })
assert.equal(installed.activation[name].state, 'live')
assert.equal(installed.compatibility, undefined)
assert.equal(installed.installed[name], 'github:Liu-Bot24/dsh-trace-insight#path:/packages/standard')
await activation(true)
const before = dataFingerprint(await rpc('export/read', { sessionId, kind: 'analysis' }))
console.log('PASS public prebuilt GitHub subpackage and real market hot activation')
await market('install', { url }, 400)
assert.equal((await market('status')).installed[name], installed.installed[name])
console.log('PASS duplicate install is rejected without a second plugin')
for (let cycle = 0; cycle < 2; cycle++) {
  const off = await market('toggle', { name, enabled: false })
  assert.equal(off.activation[name].state, 'disabled')
  await activation(false)
  const on = await market('toggle', { name, enabled: true })
  assert.equal(on.activation[name].state, 'live')
  await activation(true)
}
console.log('PASS two real disable/enable cycles')
await market('uninstall', { name })
await activation(false)
status = await market('status')
assert.equal(status.installed[name], undefined)
assert.ok(status.installed[fixture])
assert.ok(status.installed.dshmarket)
const reinstalled = await market('install', { url })
assert.equal(reinstalled.activation[name].state, 'live')
await activation(true)
assert.deepEqual(dataFingerprint(await rpc('export/read', { sessionId, kind: 'analysis' })), before)
console.log('PASS market uninstall/reinstall preserves settings/history and other plugins')
console.log(JSON.stringify({ ok: true, base: base.origin, version: '1.4.0', target: installed.installed[name] }))
