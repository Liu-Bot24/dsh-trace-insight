#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const PLUGIN_NAME = 'dsh-plugin-trace-insight'
const MANAGED_DIRECTORY = join('trace-insight', 'packages')
const MANAGED_ARCHIVE = /^dsh-plugin-trace-insight-[0-9A-Za-z.-]+\.tgz$/u
const REQUIRED_ARCHIVE_ENTRIES = [
  'package/package.json',
  'package/index.js',
  'package/client.js',
  'package/cordis.patch.yml',
  'package/patches/shell-patch.mjs',
  'package/scripts/managed-package.mjs',
]

export class ManagedPackageError extends Error {
  constructor(message, details = undefined) {
    super(message)
    this.name = 'ManagedPackageError'
    this.details = details
  }
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function tarText(buffer, offset, length) {
  const end = buffer.indexOf(0, offset)
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end
  return buffer.subarray(offset, boundedEnd).toString('utf8')
}

function tarSize(buffer, offset) {
  const value = tarText(buffer, offset, 12).trim().replace(/\0.*$/u, '')
  if (!/^[0-7]+$/u.test(value)) throw new ManagedPackageError('插件包包含无效的 tar 文件大小字段。')
  return Number.parseInt(value, 8)
}

function readTarEntries(archive) {
  let tar
  try {
    tar = gunzipSync(archive)
  } catch (error) {
    throw new ManagedPackageError(`插件包不是有效的 gzip tarball: ${error.message}`)
  }
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = tarText(header, 0, 100)
    const prefix = tarText(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const size = tarSize(header, 124)
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    if (bodyEnd > tar.length) throw new ManagedPackageError(`插件包条目越界: ${path}`)
    entries.set(path, tar.subarray(bodyStart, bodyEnd))
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return entries
}

export function inspectPluginArchive(path, expectedVersion) {
  const source = resolve(path)
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new ManagedPackageError(`插件包不存在: ${source}`)
  }
  const archive = readFileSync(source)
  const entries = readTarEntries(archive)
  const missing = REQUIRED_ARCHIVE_ENTRIES.filter(entry => !entries.has(entry))
  if (missing.length > 0) {
    throw new ManagedPackageError('插件包缺少安装所需文件。', { missing })
  }
  let manifest
  try {
    manifest = JSON.parse(entries.get('package/package.json').toString('utf8'))
  } catch (error) {
    throw new ManagedPackageError(`插件包 package.json 无效: ${error.message}`)
  }
  if (manifest.name !== PLUGIN_NAME || manifest.version !== expectedVersion) {
    throw new ManagedPackageError('插件包名称或版本与安装器不一致。', {
      expected: { name: PLUGIN_NAME, version: expectedVersion },
      actual: { name: manifest.name, version: manifest.version },
    })
  }
  return {
    source: realpathSync(source),
    name: manifest.name,
    version: manifest.version,
    sha256: sha256Buffer(archive),
    size: archive.length,
  }
}

export function resolveDshHome(explicit = undefined, environment = process.env) {
  const configured = explicit ?? environment.DSH_HOME
  return resolve(typeof configured === 'string' && configured.trim() ? configured : join(homedir(), '.dsh'))
}

export function managedPackageDirectory(dshHome) {
  return join(resolveDshHome(dshHome), MANAGED_DIRECTORY)
}

function packageDestination(dshHome, version) {
  return join(managedPackageDirectory(dshHome), `${PLUGIN_NAME}-${version}.tgz`)
}

function replaceAtomically(stage, destination) {
  if (!existsSync(destination)) {
    renameSync(stage, destination)
    return
  }
  const displaced = `${destination}.${randomUUID()}.previous`
  renameSync(destination, displaced)
  try {
    renameSync(stage, destination)
    rmSync(displaced, { force: true })
  } catch (error) {
    if (existsSync(destination)) rmSync(destination, { force: true })
    renameSync(displaced, destination)
    throw error
  }
}

export function stageManagedPackage({ source, version, dshHome } = {}) {
  if (typeof version !== 'string' || !/^[0-9A-Za-z.-]+$/u.test(version)) {
    throw new ManagedPackageError(`无效的插件版本: ${String(version)}`)
  }
  const inspected = inspectPluginArchive(source, version)
  const root = managedPackageDirectory(dshHome)
  const destination = packageDestination(dshHome, version)
  mkdirSync(root, { recursive: true })
  if (existsSync(destination) && realpathSync(destination) === inspected.source) {
    return { ...inspected, path: destination, state: 'already-managed', dshHome: resolveDshHome(dshHome) }
  }
  if (existsSync(destination)) {
    const current = readFileSync(destination)
    if (sha256Buffer(current) === inspected.sha256) {
      return { ...inspected, path: destination, state: 'already-managed', dshHome: resolveDshHome(dshHome) }
    }
  }
  const stage = join(root, `.${basename(destination)}.${randomUUID()}.tmp`)
  try {
    copyFileSync(inspected.source, stage)
    chmodSync(stage, 0o600)
    const staged = readFileSync(stage)
    if (sha256Buffer(staged) !== inspected.sha256 || staged.length !== inspected.size) {
      throw new ManagedPackageError('持久化插件包复制后校验失败。')
    }
    replaceAtomically(stage, destination)
  } finally {
    if (existsSync(stage)) rmSync(stage, { force: true })
  }
  return { ...inspected, path: destination, state: 'staged', dshHome: resolveDshHome(dshHome) }
}

function validateProfile(profile) {
  if (typeof profile !== 'string' || !profile || profile === '.' || profile === '..' || /[/\\]/u.test(profile)) {
    throw new ManagedPackageError(`无效的 DSH profile: ${String(profile)}`)
  }
  return profile
}

function profileManifestPath(dshHome, profile) {
  return join(resolveDshHome(dshHome), 'profiles', validateProfile(profile), 'package.json')
}

function readProfileManifest(dshHome, profile) {
  const path = profileManifestPath(dshHome, profile)
  if (!existsSync(path)) throw new ManagedPackageError(`DSH profile package.json 不存在: ${path}`)
  try {
    return { path, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    throw new ManagedPackageError(`无法读取 DSH profile package.json: ${error.message}`)
  }
}

function dependencySpec(manifest) {
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const spec = manifest?.[field]?.[PLUGIN_NAME]
    if (typeof spec === 'string') return { field, spec }
  }
  return undefined
}

function pathFromFileSpec(spec, profileRoot) {
  if (!spec.startsWith('file:')) throw new ManagedPackageError(`Trace Insight 不是本地持久包引用: ${spec}`)
  if (spec.startsWith('file://')) return fileURLToPath(spec)
  let value = spec.slice('file:'.length)
  try {
    value = decodeURIComponent(value)
  } catch {
    throw new ManagedPackageError(`Trace Insight file: 引用包含无效编码: ${spec}`)
  }
  return isAbsolute(value) ? resolve(value) : resolve(profileRoot, value)
}

function sameRealPath(left, right) {
  const normalized = value => {
    const path = realpathSync(value).normalize('NFC')
    return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
  }
  return normalized(left) === normalized(right)
}

function fileSpecForPath(path, profileRoot) {
  const relativePath = relative(profileRoot, path).split(sep).join('/')
  return `file:${relativePath.startsWith('.') ? relativePath : `./${relativePath}`}`
}

function writeJsonAtomically(path, value) {
  const stage = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(stage, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: statSync(path).mode })
    replaceAtomically(stage, path)
  } finally {
    if (existsSync(stage)) rmSync(stage, { force: true })
  }
}

export function migrateManagedReference({ profile = 'web', packagePath, dshHome } = {}) {
  const expected = resolve(packagePath)
  if (!existsSync(expected)) throw new ManagedPackageError(`持久插件包不存在: ${expected}`)
  const path = profileManifestPath(dshHome, profile)
  if (!existsSync(path)) return { profile, state: 'profile-not-created', path: expected }
  const manifest = readProfileManifest(dshHome, profile)
  const dependency = dependencySpec(manifest.value)
  if (!dependency) return { profile, state: 'not-installed', path: expected }
  if (!dependency.spec.startsWith('file:')) {
    return { profile, state: 'non-file-reference', spec: dependency.spec, path: expected }
  }
  const nextSpec = fileSpecForPath(expected, dirname(manifest.path))
  let referenced
  try {
    referenced = pathFromFileSpec(dependency.spec, dirname(manifest.path))
  } catch {
    referenced = undefined
  }
  if (referenced && existsSync(referenced) && sameRealPath(referenced, expected)) {
    return { profile, state: 'already-managed', spec: dependency.spec, path: expected }
  }
  manifest.value[dependency.field][PLUGIN_NAME] = nextSpec
  writeJsonAtomically(manifest.path, manifest.value)
  return {
    profile,
    state: 'migrated',
    previousSpec: dependency.spec,
    spec: nextSpec,
    path: expected,
  }
}

export function verifyManagedReference({ profile = 'web', packagePath, dshHome } = {}) {
  const expected = resolve(packagePath)
  if (!existsSync(expected)) throw new ManagedPackageError(`持久插件包不存在: ${expected}`)
  const manifest = readProfileManifest(dshHome, profile)
  const dependency = dependencySpec(manifest.value)
  if (!dependency) throw new ManagedPackageError(`DSH profile ${profile} 没有引用 Trace Insight。`)
  const referenced = pathFromFileSpec(dependency.spec, dirname(manifest.path))
  if (!existsSync(referenced) || !sameRealPath(referenced, expected)) {
    throw new ManagedPackageError('DSH profile 没有引用 Trace Insight 的持久包。', {
      profile,
      spec: dependency.spec,
      referenced,
      expected,
    })
  }
  return { profile, field: dependency.field, spec: dependency.spec, path: realpathSync(expected) }
}

function managedArchives(dshHome) {
  const root = managedPackageDirectory(dshHome)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && MANAGED_ARCHIVE.test(entry.name))
    .map(entry => join(root, entry.name))
}

function pathKey(path) {
  const normalized = resolve(path).normalize('NFC')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function referencedManagedArchives(dshHome) {
  const home = resolveDshHome(dshHome)
  const profilesRoot = join(home, 'profiles')
  const managedRoot = `${pathKey(managedPackageDirectory(home))}${sep}`
  const references = new Map()
  if (!existsSync(profilesRoot)) return references
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(profilesRoot, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readProfileManifest(home, entry.name)
    const dependency = dependencySpec(manifest.value)
    if (!dependency || !dependency.spec.startsWith('file:')) continue
    const referenced = pathFromFileSpec(dependency.spec, dirname(manifest.path))
    const key = pathKey(referenced)
    if (key.startsWith(managedRoot)) references.set(key, { profile: entry.name, spec: dependency.spec })
  }
  return references
}

export function finalizeManagedPackage({ profile = 'web', packagePath, dshHome } = {}) {
  const reference = verifyManagedReference({ profile, packagePath, dshHome })
  const references = referencedManagedArchives(dshHome)
  const removed = []
  for (const path of managedArchives(dshHome)) {
    if (sameRealPath(path, reference.path)) continue
    if (references.has(pathKey(path))) continue
    rmSync(path, { force: true })
    removed.push(path)
  }
  return { ...reference, removed }
}

export function cleanupManagedPackages({ profile = 'web', dshHome } = {}) {
  const manifestPath = profileManifestPath(dshHome, profile)
  if (existsSync(manifestPath)) {
    const manifest = readProfileManifest(dshHome, profile)
    const dependency = dependencySpec(manifest.value)
    if (dependency) {
      throw new ManagedPackageError('DSH profile 仍在引用 Trace Insight；拒绝删除持久插件包。', {
        profile,
        spec: dependency.spec,
      })
    }
  }
  const references = referencedManagedArchives(dshHome)
  const removed = []
  const retained = []
  for (const path of managedArchives(dshHome)) {
    if (references.has(pathKey(path))) {
      retained.push(path)
      continue
    }
    rmSync(path, { force: true })
    removed.push(path)
  }
  const root = managedPackageDirectory(dshHome)
  if (existsSync(root) && readdirSync(root).length === 0) rmdirSync(root)
  return { profile, dshHome: resolveDshHome(dshHome), removed, retained }
}

function parseArgs(argv) {
  const args = [...argv]
  const command = args.shift()
  const options = {}
  let json = false
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--json') {
      json = true
      continue
    }
    if (!['--source', '--version', '--dsh-home', '--profile', '--package'].includes(flag)) {
      throw new ManagedPackageError(`未知参数: ${flag}`)
    }
    const value = args.shift()
    if (!value) throw new ManagedPackageError(`${flag} 缺少参数。`)
    if (flag === '--source') options.source = value
    else if (flag === '--version') options.version = value
    else if (flag === '--dsh-home') options.dshHome = value
    else if (flag === '--profile') options.profile = value
    else options.packagePath = value
  }
  if (!['stage', 'migrate', 'finalize', 'cleanup'].includes(command)) throw new ManagedPackageError(`未知操作: ${String(command)}`)
  return { command, options, json }
}

function cli() {
  try {
    const { command, options, json } = parseArgs(process.argv.slice(2))
    const result = command === 'stage'
      ? stageManagedPackage(options)
      : command === 'migrate'
        ? migrateManagedReference(options)
      : command === 'finalize'
        ? finalizeManagedPackage(options)
        : cleanupManagedPackages(options)
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.path ?? result.dshHome}\n`)
  } catch (error) {
    const body = error instanceof ManagedPackageError
      ? { error: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
      : { error: error?.stack ?? String(error) }
    process.stderr.write(`${body.error}\n`)
    if (body.details) process.stderr.write(`${JSON.stringify(body.details, null, 2)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli()
