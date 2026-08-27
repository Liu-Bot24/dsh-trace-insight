// Read-only audit of the dedicated real-DSH fixture installation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = realpathSync(process.argv[2])
const home = join(root, 'home')
assert.notEqual(realpathSync(home), realpathSync(join(homedir(), '.dsh')))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const profileRoot = join(home, 'profiles', 'web')
const profile = readJson(join(profileRoot, 'package.json'))
assert.ok(profile.dependencies['dsh-plugin-trace-insight-fixture-llm'], 'Only audit the dedicated fixture profile.')
const packageRoot = join(profileRoot, 'node_modules', 'dsh-plugin-trace-insight')
const manifest = readJson(new URL('../packages/standard/package.json', import.meta.url))
const absent = process.argv.includes('--absent')
if (absent) {
  assert.equal(profile.dependencies[manifest.name], undefined)
  assert.equal(existsSync(packageRoot), false)
} else {
  assert.equal(readJson(join(packageRoot, 'package.json')).version, manifest.version)
  assert.equal(hash(join(packageRoot, 'client.js')), hash(new URL('../packages/standard/client.js', import.meta.url)))
  assert.equal(hash(join(packageRoot, 'index.js')), hash(new URL('../packages/standard/index.js', import.meta.url)))
  const reference = profile.dependencies[manifest.name]
  assert.equal(reference, `file:${join(home, 'trace-insight', 'packages', `${manifest.name}-${manifest.version}.tgz`)}`)
  assert.ok(existsSync(reference.slice(5)))
}
const dsh = join(root, 'dsh')
const version = readJson(join(dsh, 'package.json')).version
const layout = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout')
const compatibility = readJson(new URL('../patches/shell-patch-manifest.json', import.meta.url))
const original = compatibility.targets.find(item => item.dshVersions.includes(version) && item.layoutVersion === readJson(join(layout, 'package.json')).version)
assert.ok(original, `Missing reference hashes for DSH ${version}`)
const layoutHashes = Object.fromEntries(compatibility.files.map(file => [file.name, hash(join(layout, file.target))]))
assert.deepEqual(layoutHashes, original.originalSha256, 'The real DSH layout must remain byte-for-byte original.')
const dataRoot = join(home, 'trace-insight')
const dataHashes = Object.fromEntries(readdirSync(dataRoot, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !/shell-(?:patches|backups)/u.test(entry.parentPath))
  .map(entry => { const path = join(entry.parentPath, entry.name); return [path.slice(dataRoot.length + 1), hash(path)] }).sort())
console.log(JSON.stringify({ dshVersion: version, pluginVersion: absent ? null : manifest.version, layoutHashes, dataHashes,
  otherPlugins: Object.keys(profile.dependencies).filter(name => name !== manifest.name).sort() }, null, 2))
