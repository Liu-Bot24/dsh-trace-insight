import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const STANDARD = join(ROOT, 'packages', 'standard')
const manifest = JSON.parse(readFileSync(join(STANDARD, 'package.json'), 'utf8'))

function loadClient() {
  let descriptor
  const styles = new Map()
  const context = {
    window: { __ModuleLoader__: { load(value) { descriptor = value } } },
    document: {
      querySelector() { return styles.get('plugin') ?? null },
      createElement() { return { dataset: {}, remove() { styles.delete('plugin') } } },
      head: { appendChild(style) { styles.set('plugin', style) } },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  const source = readFileSync(join(STANDARD, 'client.js'), 'utf8')
  vm.runInNewContext(source, context)
  assert.equal(descriptor.id, manifest.name)
  const plugin = descriptor.factory(id => {
    assert.equal(id, 'react')
    return { createElement() {}, useCallback() {}, useEffect() {}, useMemo() {}, useRef() {}, useState() {} }
  })
  return { plugin, source, styles }
}

test('standard metadata is a prebuilt standard DSH plugin with no shell lifecycle or external workspace dependency', () => {
  assert.equal(manifest.name, 'dsh-plugin-trace-insight')
  assert.equal(manifest.version, '1.5.0-dev.3')
  assert.equal(manifest.repository.directory, 'packages/standard')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.scripts, undefined)
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'), false)
  assert.equal(manifest.files.some(file => /patches\/|install\.|managed-package|find-npx/.test(file)), false)
  const host = readFileSync(join(STANDARD, 'index.js'), 'utf8')
  assert.doesNotMatch(host, /\.\.\/|shell-patch|managed-package|spawnSync|execSync/)
})

test('standard owns only an overlay, header button and private session slot, independently of host inspector/details', () => {
  const { plugin, source, styles } = loadClient()
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'sessions', 'connection'])
  assert.doesNotMatch(source, /InspectorToggle|toggleInspector|ctx\.layout|slots\.spec/)
  const registrations = new Map()
  const disposers = []
  const ctx = {
    effect(callback) { disposers.push(callback()) },
    connection: { rpc: { async call() { return { ok: true, value: {} } } } },
    sessions: { binding() { return { session: {} } } },
    get layout() { throw new Error('standard must not read layout') },
    slots: {
      spec() { throw new Error('standard must not probe inspector availability') },
      inject(name, callback) {
        assert.ok(['shell.overlay', 'conversation.session.header.utilities', 'trace-insight.panel'].includes(name))
        disposers.push(callback())
      },
      register(options, component) {
        assert.ok(['shell.overlay', 'conversation.session.header.utilities', 'trace-insight.panel'].includes(options.name))
        assert.equal(typeof component, 'function')
        assert.equal(registrations.has(options.id), false)
        registrations.set(options.id, options)
        return () => registrations.delete(options.id)
      },
    },
  }
  for (let cycle = 0; cycle < 3; cycle++) {
    plugin.apply(ctx)
    assert.equal(registrations.size, 3)
    assert.equal(registrations.get('trace-insight-dock').children['trace-insight.panel'].scope, 'session')
    assert.equal(registrations.get('trace-insight-dock').children['trace-insight.panel'].kind, 'single')
    assert.equal(registrations.get('trace-insight-dock').inject().dock, registrations.get('trace-insight-dock-toggle').inject().dock)
    assert.equal(styles.size, 1)
    const face = registrations.get('trace-insight').inject('session-standard')
    assert.equal(face.sessionId, 'session-standard')
    assert.equal(typeof face.api.readBootstrap, 'function')
    for (const dispose of disposers.splice(0).reverse()) dispose?.()
    assert.equal(registrations.size, 0)
    assert.equal(styles.size, 0)
  }
})

test('standard host artifacts share the source core and are generated deterministically', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/build.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  for (const name of readdirSync(join(ROOT, 'src')).filter(name => name.endsWith('.mjs') && name !== 'version.mjs')) {
    const source = readFileSync(join(ROOT, 'src', name), 'utf8').replace(/\r\n?/gu, '\n')
    const generated = readFileSync(join(STANDARD, 'lib', name), 'utf8')
    assert.equal(generated.slice(generated.indexOf('\n') + 1), source, name)
  }
})

function npm(args, options) {
  const cli = process.env.npm_execpath
  if (cli && /npm-cli\.js$/i.test(cli) && existsSync(cli)) {
    return spawnSync(process.execPath, [cli, ...args], options)
  }
  if (process.platform !== 'win32') return spawnSync('npm', args, options)
  const quote = value => `"${String(value).replaceAll('"', '""')}"`
  return spawnSync(['npm', ...args.map(quote)].join(' '), { ...options, shell: true })
}

test('standard archive imports independently after its source and parent checkout are unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trace insight standard archive '))
  try {
    const source = join(root, 'standalone source')
    const output = join(root, 'archive output')
    const extracted = join(root, 'extracted package')
    cpSync(STANDARD, source, { recursive: true })
    mkdirSync(output)
    mkdirSync(extracted)
    const packed = npm(['pack', '--ignore-scripts', '--silent', '--pack-destination', output, '--cache', join(root, 'npm cache')], {
      cwd: source,
      encoding: 'utf8',
    })
    assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`)
    const archive = join(output, `dsh-plugin-trace-insight-${manifest.version}.tgz`)
    assert.ok(existsSync(archive))
    rmSync(source, { recursive: true, force: true })
    const untar = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' })
    assert.equal(untar.status, 0, untar.stderr)
    const packageRoot = join(extracted, 'package')
    const files = readdirSync(packageRoot, { recursive: true }).map(String)
    assert.equal(files.some(file => /(^|[\/\\])(patches|scripts|install\.sh|install\.ps1|uninstall\.sh|uninstall\.ps1)([\/\\]|$)/u.test(file)), false)
    assert.equal(files.some(file => /(^|[\/\\])(test|node_modules|DEVELOPMENT_LOG\.md)([\/\\]|$)/u.test(file)), false)
    const host = await import(pathToFileURL(join(packageRoot, 'index.js')).href)
    assert.equal(host.name, 'trace-insight')
    assert.equal(typeof host.apply, 'function')
    const version = await import(pathToFileURL(join(packageRoot, 'lib', 'version.mjs')).href)
    assert.equal(version.TRACE_INSIGHT_SERVICE_VERSION, manifest.version)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
