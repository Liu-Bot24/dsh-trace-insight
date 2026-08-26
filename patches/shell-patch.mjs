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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MANIFEST = join(HERE, 'shell-patch-manifest.json')
const DSH_PACKAGE = '@deepseek-ai/dsh'
const WEB_APP_PACKAGE = '@deepseek-ai/dsh-web-app'

export class ShellPatchError extends Error {
  constructor(message, details = undefined) {
    super(message)
    this.name = 'ShellPatchError'
    this.details = details
  }
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJson(path, label = path) {
  try {
    const body = readFileSync(path, 'utf8')
    return JSON.parse(body.charCodeAt(0) === 0xFEFF ? body.slice(1) : body)
  } catch (error) {
    throw new ShellPatchError(`无法读取 ${label}: ${error.message}`)
  }
}

function packageInfo(root, expectedName) {
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = readJson(manifestPath, `${expectedName} package.json`)
  if (manifest.name !== expectedName || typeof manifest.version !== 'string') return undefined
  return { root: realpathSync(root), version: manifest.version, manifestPath }
}

function packageRootFromFilesystemLocation(candidate) {
  let start = resolve(candidate)
  if (existsSync(start)) start = realpathSync(start)
  if (existsSync(start) && !statSync(start).isDirectory()) start = dirname(start)

  const directCandidates = [
    start,
    join(start, 'node_modules', '@deepseek-ai', 'dsh'),
    join(start, '@deepseek-ai', 'dsh'),
  ]
  for (const item of directCandidates) {
    const info = packageInfo(item, DSH_PACKAGE)
    if (info) return info.root
  }

  let current = start
  for (;;) {
    const info = packageInfo(current, DSH_PACKAGE)
    if (info) return info.root
    const nested = packageInfo(join(current, 'node_modules', '@deepseek-ai', 'dsh'), DSH_PACKAGE)
    if (nested) return nested.root
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

function commandShimTargets(path) {
  if (!existsSync(path) || statSync(path).isDirectory() || statSync(path).size > 128 * 1024) return []
  let body
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const targets = new Set()
  for (const match of body.matchAll(/["']([^"'\r\n]+)["']/gu)) {
    const value = match[1].trim()
    if (!value || /%[^%]+%|\$[({A-Za-z_]/u.test(value)) continue
    const target = isAbsolute(value) ? value : resolve(dirname(path), value)
    if (existsSync(target)) targets.add(target)
  }
  return [...targets]
}

function packageRootFromCandidate(candidate) {
  if (!candidate) return undefined
  const direct = packageRootFromFilesystemLocation(candidate)
  if (direct) return direct
  const path = resolve(candidate)
  for (const target of commandShimTargets(path)) {
    const root = packageRootFromFilesystemLocation(target)
    if (root) return root
  }
  return undefined
}

function resolveDependencyPackage(dshRoot, packageName) {
  const require = createRequire(join(dshRoot, 'package.json'))
  try {
    return dirname(require.resolve(`${packageName}/package.json`))
  } catch (error) {
    throw new ShellPatchError(`无法从 DSH 安装解析 ${packageName}: ${error.message}`)
  }
}

function commandCandidates() {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(command, ['dsh'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
}

function globalNpmCandidate() {
  const result = spawnSync('npm', ['root', '--global'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || !result.stdout) return undefined
  return join(result.stdout.trim(), '@deepseek-ai', 'dsh')
}

function npxCacheRoots() {
  const roots = new Set()
  if (process.env.npm_config_cache) return [join(process.env.npm_config_cache, '_npx')]
  if (process.env.LOCALAPPDATA) roots.add(join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  roots.add(join(homedir(), '.npm', '_npx'))
  return [...roots]
}

function npxCandidates() {
  const candidates = []
  for (const root of npxCacheRoots()) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      candidates.push(join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh'))
    }
  }
  return candidates
}

function targetForVersions(manifest, versions) {
  return manifest.targets.find(target =>
    target.layoutVersion === versions.layout
    && target.dshVersions.includes(versions.dsh)
    && target.webAppVersions.includes(versions.webApp))
}

export function loadShellPatchManifest(path = DEFAULT_MANIFEST) {
  const manifest = readJson(path, 'shell patch manifest')
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.targets)) {
    throw new ShellPatchError(`不支持的 shell patch manifest: ${path}`)
  }
  return { ...manifest, path: resolve(path), payloadRoot: dirname(resolve(path)) }
}

export function probeDshInstallation(dshRoot, manifest = loadShellPatchManifest()) {
  const normalizedRoot = packageRootFromCandidate(dshRoot)
  if (!normalizedRoot) throw new ShellPatchError(`指定目录不是完整的 DSH 安装: ${dshRoot}`)
  const dsh = packageInfo(normalizedRoot, DSH_PACKAGE)
  const webAppRoot = resolveDependencyPackage(normalizedRoot, WEB_APP_PACKAGE)
  const layoutRoot = resolveDependencyPackage(normalizedRoot, manifest.targetPackage)
  const webApp = packageInfo(webAppRoot, WEB_APP_PACKAGE)
  const layout = packageInfo(layoutRoot, manifest.targetPackage)
  const versions = { dsh: dsh.version, webApp: webApp.version, layout: layout.version }
  const target = targetForVersions(manifest, versions)
  return { dsh, webApp, layout, versions, target }
}

function installationCandidates(explicitRoots = []) {
  if (explicitRoots.length > 0) {
    return explicitRoots.map(candidate => ({ candidate, source: 'explicit', required: true }))
  }
  if (process.env.DSH_PACKAGE_ROOT) {
    return [{ candidate: process.env.DSH_PACKAGE_ROOT, source: 'environment', required: true }]
  }
  const globalCandidate = globalNpmCandidate()
  return [
    ...commandCandidates().map(candidate => ({ candidate, source: 'path', required: true })),
    ...(globalCandidate
      ? [{ candidate: globalCandidate, source: 'npm-global', required: false }]
      : []),
    ...npxCandidates().map(candidate => ({ candidate, source: 'npx-cache', required: false })),
  ]
}

function rootsFromOptions(options = {}) {
  const roots = options.dshRoots ?? (options.dshRoot ? [options.dshRoot] : [])
  return [...new Set(roots.filter(Boolean).map(root => resolve(root)))]
}

export function discoverDshInstallations(manifest = loadShellPatchManifest(), options = {}) {
  const records = new Map()
  const broken = []
  for (const item of installationCandidates(rootsFromOptions(options))) {
    try {
      const root = packageRootFromCandidate(item.candidate)
      if (!root) {
        if (item.required) broken.push({ ...item, error: '不是完整的 DSH 安装' })
        continue
      }
      const existing = records.get(root) ?? { root, sources: new Set(), required: false }
      existing.sources.add(item.source)
      existing.required ||= item.required
      records.set(root, existing)
    } catch (error) {
      if (item.required) broken.push({ ...item, error: error.message })
    }
  }

  let supported = []
  const unsupported = []
  for (const record of records.values()) {
    try {
      const probe = probeDshInstallation(record.root, manifest)
      const result = {
        ...probe,
        sources: [...record.sources].sort(),
        required: record.required,
      }
      if (probe.target) supported.push(result)
      else unsupported.push(result)
    } catch (error) {
      const failure = {
        root: record.root,
        sources: [...record.sources].sort(),
        required: record.required,
        error: error.message,
      }
      if (record.required) broken.push(failure)
    }
  }
  const byRoot = (left, right) => left.dsh.root.localeCompare(right.dsh.root)
  const activeVersions = new Set(supported.filter(item => item.required).map(item => item.versions.dsh))
  const inactive = activeVersions.size === 0
    ? []
    : supported.filter(item => !item.required && !activeVersions.has(item.versions.dsh))
  if (inactive.length > 0) {
    supported = supported.filter(item => item.required || activeVersions.has(item.versions.dsh))
  }
  supported.sort(byRoot)
  unsupported.sort(byRoot)
  inactive.sort(byRoot)
  return { supported, unsupported, inactive, broken }
}

function discoveryError(discovery) {
  const requiredUnsupported = discovery.unsupported.filter(item => item.required)
  if (discovery.broken.length > 0) {
    return new ShellPatchError('发现无法完整解析的 DSH 安装；未修改任何文件。', {
      candidates: discovery.broken,
    })
  }
  if (requiredUnsupported.length > 0) {
    return new ShellPatchError('当前可启动的 DSH 版本组合不受支持；未修改任何文件。', {
      candidates: requiredUnsupported.map(item => ({
        root: item.dsh.root,
        versions: item.versions,
        sources: item.sources,
      })),
    })
  }
  if (discovery.supported.length === 0) {
    return new ShellPatchError('无法定位受支持的 DSH 安装；未修改任何文件。', {
      candidates: discovery.unsupported.map(item => ({
        root: item.dsh.root,
        versions: item.versions,
        sources: item.sources,
      })),
    })
  }
  return undefined
}

function supportedProbes(options, manifest) {
  const discovery = discoverDshInstallations(manifest, options)
  const error = discoveryError(discovery)
  if (error) throw error
  return discovery
}

export function discoverDshInstallation(manifest = loadShellPatchManifest()) {
  const discovery = supportedProbes({}, manifest)
  if (discovery.supported.length === 1) return discovery.supported[0]
  throw new ShellPatchError('检测到多个受支持的 DSH 安装；请使用批量操作或用 --dsh-root 指定单个安装根。', {
    candidates: discovery.supported.map(item => item.dsh.root),
  })
}

function resolveProbe({ dshRoot, manifest }) {
  const probe = dshRoot ? probeDshInstallation(dshRoot, manifest) : discoverDshInstallation(manifest)
  if (!probe.target) {
    throw new ShellPatchError('DSH/web-app/layout 版本组合不受支持；未修改任何文件。', {
      root: probe.dsh.root,
      versions: probe.versions,
    })
  }
  return probe
}

function fileRecords(probe, manifest) {
  return manifest.files.map(file => ({
    ...file,
    targetPath: join(probe.layout.root, file.target),
    payloadPath: join(manifest.payloadRoot, file.payload),
    originalSha256: probe.target.originalSha256[file.name],
  }))
}

function verifyPayloads(records) {
  for (const record of records) {
    if (!existsSync(record.payloadPath)) throw new ShellPatchError(`补丁文件不存在: ${record.payloadPath}`)
    const actual = sha256(record.payloadPath)
    if (actual !== record.patchedSha256) {
      throw new ShellPatchError(`补丁 payload hash 不匹配: ${record.name}`, {
        expected: record.patchedSha256,
        actual,
      })
    }
  }
}

function inspectRecords(records) {
  return records.map(record => {
    if (!existsSync(record.targetPath)) throw new ShellPatchError(`DSH 目标文件不存在: ${record.targetPath}`)
    return { ...record, currentSha256: sha256(record.targetPath) }
  })
}

function stateOf(records) {
  if (records.every(record => record.currentSha256 === record.patchedSha256)) return 'patched'
  if (records.every(record => record.currentSha256 === record.originalSha256)) return 'original'
  return 'unexpected'
}

function defaultBackupRoot() {
  const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(dshHome, 'trace-insight', 'shell-backups')
}

function stateRoot(options = {}) {
  const backupRoot = resolve(options.backupRoot ?? defaultBackupRoot())
  return join(dirname(backupRoot), 'shell-patches')
}

function normalizedPathKey(path) {
  const absolute = resolve(path)
  const normalized = (existsSync(absolute) ? realpathSync(absolute) : absolute).normalize('NFC')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function stateKeyForRoot(dshRoot) {
  return createHash('sha256').update(normalizedPathKey(dshRoot)).digest('hex')
}

export function activeStatePathForRoot(dshRoot, options = {}) {
  if (options.statePath) return resolve(options.statePath)
  return join(stateRoot(options), stateKeyForRoot(dshRoot), 'active.json')
}

function legacyActiveStatePath(options = {}) {
  const backupRoot = resolve(options.backupRoot ?? defaultBackupRoot())
  return join(dirname(backupRoot), 'shell-patch-active.json')
}

function validateActiveState(state, path) {
  if (state.schemaVersion !== 1
    || typeof state.backupDirectory !== 'string'
    || typeof state.dshRoot !== 'string') {
    throw new ShellPatchError(`不支持的 active shell patch state: ${path}`)
  }
  return state
}

function readActiveStateForRoot(dshRoot, options = {}) {
  const path = activeStatePathForRoot(dshRoot, options)
  if (existsSync(path)) {
    const state = validateActiveState(readJson(path, 'active shell patch state'), path)
    if (normalizedPathKey(state.dshRoot) !== normalizedPathKey(dshRoot)) {
      throw new ShellPatchError(`shell patch state 与安装根不匹配: ${path}`)
    }
    return { ...state, statePath: path, legacy: false }
  }
  const legacyPath = legacyActiveStatePath(options)
  if (!existsSync(legacyPath)) return undefined
  const legacy = validateActiveState(readJson(legacyPath, 'legacy active shell patch state'), legacyPath)
  if (normalizedPathKey(legacy.dshRoot) !== normalizedPathKey(dshRoot)) return undefined
  return { ...legacy, statePath: legacyPath, legacy: true }
}

export function listActiveShellPatchStates(options = {}) {
  const states = new Map()
  const root = stateRoot(options)
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name, 'active.json')
      if (!existsSync(path)) continue
      const state = validateActiveState(readJson(path, 'active shell patch state'), path)
      states.set(normalizedPathKey(state.dshRoot), { ...state, statePath: path, legacy: false })
    }
  }
  const legacyPath = legacyActiveStatePath(options)
  if (existsSync(legacyPath)) {
    const legacy = validateActiveState(readJson(legacyPath, 'legacy active shell patch state'), legacyPath)
    const key = normalizedPathKey(legacy.dshRoot)
    if (!states.has(key)) states.set(key, { ...legacy, statePath: legacyPath, legacy: true })
  }
  return [...states.values()].sort((left, right) => left.dshRoot.localeCompare(right.dshRoot))
}

function writeActiveState(state, options = {}) {
  const path = activeStatePathForRoot(state.dshRoot, options)
  mkdirSync(dirname(path), { recursive: true })
  const stage = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(stage, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(stage, path)
  } finally {
    if (existsSync(stage)) rmSync(stage, { force: true })
  }
  const legacyPath = legacyActiveStatePath(options)
  if (legacyPath !== path && existsSync(legacyPath)) {
    const legacy = validateActiveState(readJson(legacyPath, 'legacy active shell patch state'), legacyPath)
    if (normalizedPathKey(legacy.dshRoot) === normalizedPathKey(state.dshRoot)
      && resolve(legacy.backupDirectory) === resolve(state.backupDirectory)) {
      rmSync(legacyPath, { force: true })
    }
  }
  return path
}

function clearActiveState(backupDirectory, dshRoot, options = {}) {
  for (const path of [activeStatePathForRoot(dshRoot, options), legacyActiveStatePath(options)]) {
    if (!existsSync(path)) continue
    const state = validateActiveState(readJson(path, 'active shell patch state'), path)
    if (normalizedPathKey(state.dshRoot) === normalizedPathKey(dshRoot)
      && resolve(state.backupDirectory) === resolve(backupDirectory)) {
      rmSync(path, { force: true })
    }
  }
}

function findMatchingBackup(probe, manifest, records, options = {}) {
  const backupRoot = resolve(options.backupRoot ?? defaultBackupRoot())
  if (!existsSync(backupRoot)) return undefined
  const candidates = []
  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(backupRoot, entry.name)
    const manifestPath = join(directory, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    try {
      const backup = readJson(manifestPath, 'backup manifest')
      if (backup.patchId !== manifest.patchId
        || backup.targetId !== probe.target.id
        || resolve(backup.dshRoot) !== resolve(probe.dsh.root)
        || backup.versions?.dsh !== probe.versions.dsh
        || backup.versions?.webApp !== probe.versions.webApp
        || backup.versions?.layout !== probe.versions.layout
        || !Array.isArray(backup.files)
        || backup.files.length !== records.length) continue
      const files = new Map(backup.files.map(file => [file.name, file]))
      if (!records.every(record => {
        const file = files.get(record.name)
        const path = join(directory, record.name)
        return file?.target === record.target
          && file.originalSha256 === record.originalSha256
          && file.patchedSha256 === record.patchedSha256
          && existsSync(path)
          && sha256(path) === record.originalSha256
      })) continue
      candidates.push({ directory, createdAt: Date.parse(backup.createdAt) || 0 })
    } catch {
      // Ignore unrelated or incomplete backup directories.
    }
  }
  candidates.sort((left, right) => right.createdAt - left.createdAt)
  return candidates[0]?.directory
}

function backupStamp() {
  return `${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID().slice(0, 8)}`
}

function stageCopy(source, target) {
  const stage = `${target}.trace-insight-${randomUUID()}.tmp`
  copyFileSync(source, stage)
  chmodSync(stage, statSync(target).mode)
  return stage
}

function replaceStaged(staged, replaceFile = renameSync) {
  for (const [index, item] of staged.entries()) {
    replaceFile(item.stage, item.target, index)
    item.replaced = true
  }
}

function cleanupStages(staged) {
  for (const item of staged) {
    if (existsSync(item.stage)) rmSync(item.stage, { force: true })
  }
}

function rollbackFromBackup(records, backupDirectory) {
  const staged = []
  try {
    for (const record of records) {
      const backup = join(backupDirectory, record.name)
      const stage = stageCopy(backup, record.targetPath)
      staged.push({ stage, target: record.targetPath })
    }
    replaceStaged(staged)
    const failed = records.filter(record => sha256(record.targetPath) !== record.originalSha256)
    if (failed.length > 0) throw new ShellPatchError(`回滚后 hash 仍不匹配: ${failed.map(item => item.name).join(', ')}`)
  } finally {
    cleanupStages(staged)
  }
}

function rollbackRestore(records, rollbackDirectory) {
  const staged = []
  try {
    for (const record of records) {
      const snapshot = join(rollbackDirectory, record.name)
      const stage = stageCopy(snapshot, record.targetPath)
      staged.push({ stage, target: record.targetPath })
    }
    replaceStaged(staged)
    const failed = records.filter(record => sha256(record.targetPath) !== record.preRestoreSha256)
    if (failed.length > 0) throw new ShellPatchError(`恢复回滚后 hash 仍不匹配: ${failed.map(item => item.name).join(', ')}`)
  } finally {
    cleanupStages(staged)
  }
}

function unsupportedStateError(probe, records) {
  return new ShellPatchError('目标文件不是受支持的原文件或右侧栏文件；为避免覆盖其他修改，未写入任何文件。', {
    root: probe.dsh.root,
    versions: probe.versions,
    files: records.map(record => ({
      name: record.name,
      current: record.currentSha256,
      expectedOriginal: record.originalSha256,
      expectedPatched: record.patchedSha256,
    })),
  })
}

export function inspectShellPatch(options = {}) {
  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  const probe = resolveProbe({ dshRoot: options.dshRoot, manifest })
  const records = fileRecords(probe, manifest)
  verifyPayloads(records)
  const inspected = inspectRecords(records)
  return {
    operation: 'status',
    state: stateOf(inspected),
    targetId: probe.target.id,
    dshRoot: probe.dsh.root,
    layoutRoot: probe.layout.root,
    versions: probe.versions,
    files: inspected.map(record => ({ name: record.name, sha256: record.currentSha256 })),
  }
}

export function applyShellPatch(options = {}) {
  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  const probe = resolveProbe({ dshRoot: options.dshRoot, manifest })
  const records = fileRecords(probe, manifest)
  verifyPayloads(records)
  const inspected = inspectRecords(records)
  const state = stateOf(inspected)
  if (state === 'patched') {
    const backupDirectory = findMatchingBackup(probe, manifest, inspected, options)
    if (!backupDirectory) {
      throw new ShellPatchError('右侧栏文件已打补丁，但没有找到可验证的完整原文件备份；为保证可卸载性，未更改状态。', {
        root: probe.dsh.root,
        versions: probe.versions,
      })
    }
    writeActiveState({
      schemaVersion: 1,
      patchId: manifest.patchId,
      targetId: probe.target.id,
      dshRoot: probe.dsh.root,
      backupDirectory,
      versions: probe.versions,
    }, options)
    return {
      operation: 'apply',
      state: 'already-patched',
      targetId: probe.target.id,
      dshRoot: probe.dsh.root,
      layoutRoot: probe.layout.root,
      versions: probe.versions,
      backupDirectory,
    }
  }
  if (state !== 'original') throw unsupportedStateError(probe, inspected)

  const base = resolve(options.backupRoot ?? defaultBackupRoot())
  const backupDirectory = join(base, backupStamp())
  mkdirSync(backupDirectory, { recursive: true })
  for (const record of inspected) copyFileSync(record.targetPath, join(backupDirectory, record.name))
  const backupManifest = {
    schemaVersion: 1,
    patchId: manifest.patchId,
    targetId: probe.target.id,
    createdAt: new Date().toISOString(),
    dshRoot: probe.dsh.root,
    layoutRoot: probe.layout.root,
    versions: probe.versions,
    files: inspected.map(record => ({
      name: record.name,
      target: record.target,
      originalSha256: record.originalSha256,
      patchedSha256: record.patchedSha256,
    })),
  }
  writeFileSync(join(backupDirectory, 'manifest.json'), `${JSON.stringify(backupManifest, null, 2)}\n`, 'utf8')

  const staged = []
  try {
    for (const record of inspected) {
      const stage = stageCopy(record.payloadPath, record.targetPath)
      if (sha256(stage) !== record.patchedSha256) throw new ShellPatchError(`staging hash 不匹配: ${record.name}`)
      staged.push({ stage, target: record.targetPath })
    }
    replaceStaged(staged, options.replaceFile)
    const failed = inspected.filter(record => sha256(record.targetPath) !== record.patchedSha256)
    if (failed.length > 0) throw new ShellPatchError(`写入后 hash 不匹配: ${failed.map(item => item.name).join(', ')}`)
    writeActiveState({
      schemaVersion: 1,
      patchId: manifest.patchId,
      targetId: probe.target.id,
      dshRoot: probe.dsh.root,
      backupDirectory,
      versions: probe.versions,
    }, options)
  } catch (error) {
    let rollbackError
    try {
      rollbackFromBackup(inspected, backupDirectory)
      clearActiveState(backupDirectory, probe.dsh.root, options)
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError) {
      throw new ShellPatchError(`shell 补丁失败且自动回滚失败；完整备份保留在 ${backupDirectory}`, {
        cause: error.message,
        rollback: rollbackError.message,
      })
    }
    throw new ShellPatchError(`shell 补丁失败，已恢复原文件；备份保留在 ${backupDirectory}`, { cause: error.message })
  } finally {
    cleanupStages(staged)
  }

  return {
    operation: 'apply',
    state: 'patched',
    targetId: probe.target.id,
    dshRoot: probe.dsh.root,
    layoutRoot: probe.layout.root,
    versions: probe.versions,
    backupDirectory,
  }
}

export function restoreShellPatch(backupPath, options = {}) {
  const backupDirectory = resolve(backupPath)
  const backupManifestPath = join(backupDirectory, 'manifest.json')
  if (!existsSync(backupManifestPath)) throw new ShellPatchError(`备份缺少 manifest.json: ${backupDirectory}`)
  const backup = readJson(backupManifestPath, 'backup manifest')
  if (backup.schemaVersion !== 1 || !Array.isArray(backup.files)) {
    throw new ShellPatchError(`不支持的备份 manifest: ${backupManifestPath}`)
  }

  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  if (backup.patchId !== manifest.patchId) {
    throw new ShellPatchError('备份不属于当前 shell 补丁；拒绝恢复。', {
      backupPatchId: backup.patchId,
      expectedPatchId: manifest.patchId,
    })
  }
  const probe = resolveProbe({ dshRoot: options.dshRoot ?? backup.dshRoot, manifest })
  if (probe.target.id !== backup.targetId
    || probe.versions.dsh !== backup.versions.dsh
    || probe.versions.webApp !== backup.versions.webApp
    || probe.versions.layout !== backup.versions.layout) {
    throw new ShellPatchError('当前 DSH 安装与备份的版本组合不一致；拒绝恢复。', {
      backup: backup.versions,
      current: probe.versions,
    })
  }

  const expectedRecords = fileRecords(probe, manifest)
  if (backup.files.length !== expectedRecords.length) {
    throw new ShellPatchError('备份清单文件数量与当前补丁不一致；拒绝恢复。')
  }
  const backupByName = new Map(backup.files.map(file => [file.name, file]))
  if (backupByName.size !== backup.files.length) {
    throw new ShellPatchError('备份清单包含重复文件；拒绝恢复。')
  }
  const records = expectedRecords.map(expected => {
    const file = backupByName.get(expected.name)
    if (!file
      || file.target !== expected.target
      || file.originalSha256 !== expected.originalSha256
      || file.patchedSha256 !== expected.patchedSha256) {
      throw new ShellPatchError(`备份清单与当前补丁定义不一致；拒绝恢复: ${expected.name}`)
    }
    return {
      ...expected,
      backupPath: join(backupDirectory, expected.name),
    }
  })
  for (const record of records) {
    if (!existsSync(record.backupPath) || sha256(record.backupPath) !== record.originalSha256) {
      throw new ShellPatchError(`备份文件 hash 不匹配: ${record.name}`)
    }
    if (!existsSync(record.targetPath)) throw new ShellPatchError(`DSH 目标文件不存在: ${record.targetPath}`)
    const current = sha256(record.targetPath)
    if (current !== record.originalSha256 && current !== record.patchedSha256) {
      throw new ShellPatchError(`目标文件已被其他修改覆盖，拒绝恢复: ${record.name}`, { current })
    }
    record.currentSha256 = current
    record.preRestoreSha256 = current
  }
  if (records.every(record => record.currentSha256 === record.originalSha256)) {
    clearActiveState(backupDirectory, probe.dsh.root, options)
    return {
      operation: 'restore',
      state: 'already-original',
      targetId: probe.target.id,
      dshRoot: probe.dsh.root,
      layoutRoot: probe.layout.root,
      versions: probe.versions,
      backupDirectory,
    }
  }

  const rollbackDirectory = join(backupDirectory, `.restore-rollback-${randomUUID()}`)
  mkdirSync(rollbackDirectory)
  for (const record of records) copyFileSync(record.targetPath, join(rollbackDirectory, record.name))
  const staged = []
  try {
    for (const record of records) {
      const stage = stageCopy(record.backupPath, record.targetPath)
      if (sha256(stage) !== record.originalSha256) throw new ShellPatchError(`恢复 staging hash 不匹配: ${record.name}`)
      staged.push({ stage, target: record.targetPath })
    }
    replaceStaged(staged, options.replaceFile)
    const failed = records.filter(record => sha256(record.targetPath) !== record.originalSha256)
    if (failed.length > 0) throw new ShellPatchError(`恢复后 hash 不匹配: ${failed.map(item => item.name).join(', ')}`)
  } catch (error) {
    let rollbackError
    try {
      rollbackRestore(records, rollbackDirectory)
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError) {
      throw new ShellPatchError(`恢复失败且无法回到恢复前状态；原始备份仍保留在 ${backupDirectory}`, {
        cause: error.message,
        rollback: rollbackError.message,
      })
    }
    throw new ShellPatchError('恢复失败，已回到恢复前状态。', { cause: error.message })
  } finally {
    cleanupStages(staged)
    rmSync(rollbackDirectory, { recursive: true, force: true })
  }

  clearActiveState(backupDirectory, probe.dsh.root, options)

  return {
    operation: 'restore',
    state: 'restored',
    targetId: probe.target.id,
    dshRoot: probe.dsh.root,
    layoutRoot: probe.layout.root,
    versions: probe.versions,
    backupDirectory,
  }
}

export function restoreActiveShellPatch(options = {}) {
  let state
  if (options.dshRoot) {
    state = readActiveStateForRoot(options.dshRoot, options)
  } else {
    const states = listActiveShellPatchStates(options)
    if (states.length > 1) {
      throw new ShellPatchError('存在多个 DSH 安装根的右侧栏状态；请使用 restore-all 或指定 --dsh-root。', {
        candidates: states.map(item => item.dshRoot),
      })
    }
    state = states[0]
  }
  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  const dshRoot = options.dshRoot ?? state?.dshRoot
  if (!state) {
    if (!dshRoot) return { operation: 'restore-active', state: 'not-installed' }
    const probe = resolveProbe({ dshRoot, manifest })
    const records = inspectRecords(fileRecords(probe, manifest))
    const currentState = stateOf(records)
    if (currentState === 'original') return { operation: 'restore-active', state: 'not-installed', dshRoot: probe.dsh.root }
    if (currentState !== 'patched') throw unsupportedStateError(probe, records)
    const backupDirectory = findMatchingBackup(probe, manifest, records, options)
    if (!backupDirectory) {
      throw new ShellPatchError('右侧栏文件已打补丁，但没有找到可验证的完整原文件备份；拒绝伪造卸载成功。', {
        root: probe.dsh.root,
      })
    }
    return restoreShellPatch(backupDirectory, { ...options, manifest, dshRoot: probe.dsh.root })
  }
  const probe = resolveProbe({ dshRoot, manifest })
  const versionChanged = state.versions
    && (state.versions.dsh !== probe.versions.dsh
      || state.versions.webApp !== probe.versions.webApp
      || state.versions.layout !== probe.versions.layout)
  if (versionChanged) {
    const records = fileRecords(probe, manifest)
    verifyPayloads(records)
    const inspected = inspectRecords(records)
    const currentState = stateOf(inspected)
    if (currentState !== 'original') {
      throw new ShellPatchError('DSH 已升级，但当前 shell 文件不是新版原始状态；拒绝清除旧备份指针。', {
        previous: state.versions,
        current: probe.versions,
        state: currentState,
      })
    }
    clearActiveState(state.backupDirectory, probe.dsh.root, options)
    return {
      operation: 'restore-active',
      state: 'superseded-by-upgrade',
      targetId: probe.target.id,
      dshRoot: probe.dsh.root,
      layoutRoot: probe.layout.root,
      versions: probe.versions,
      backupDirectory: state.backupDirectory,
    }
  }
  return restoreShellPatch(state.backupDirectory, {
    ...options,
    manifest,
    dshRoot,
  })
}

function ignoredUnsupported(discovery) {
  return discovery.unsupported
    .filter(item => !item.required)
    .map(item => ({ root: item.dsh.root, versions: item.versions, sources: item.sources }))
}

function ignoredInactive(discovery) {
  return discovery.inactive.map(item => ({ root: item.dsh.root, versions: item.versions, sources: item.sources }))
}

function inspectProbe(probe, manifest) {
  const records = fileRecords(probe, manifest)
  verifyPayloads(records)
  const inspected = inspectRecords(records)
  return { probe, records: inspected, state: stateOf(inspected) }
}

export function inspectAllShellPatches(options = {}) {
  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  const discovery = supportedProbes(options, manifest)
  const installations = discovery.supported.map(probe => {
    const inspected = inspectProbe(probe, manifest)
    return {
      state: inspected.state,
      targetId: probe.target.id,
      dshRoot: probe.dsh.root,
      layoutRoot: probe.layout.root,
      versions: probe.versions,
      sources: probe.sources,
    }
  })
  return {
    operation: 'status-all',
    state: installations.every(item => item.state === 'patched')
      ? 'patched'
      : installations.every(item => item.state === 'original')
        ? 'original'
        : 'mixed',
    installations,
    ignoredUnsupported: ignoredUnsupported(discovery),
    ignoredInactive: ignoredInactive(discovery),
  }
}

export function applyAllShellPatches(options = {}) {
  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  const discovery = supportedProbes(options, manifest)
  const plans = discovery.supported.map(probe => inspectProbe(probe, manifest))
  for (const plan of plans) {
    if (plan.state === 'unexpected') throw unsupportedStateError(plan.probe, plan.records)
    if (plan.state === 'patched' && !findMatchingBackup(plan.probe, manifest, plan.records, options)) {
      throw new ShellPatchError('至少一个 DSH 安装根已打补丁，但没有可验证的原文件备份；未修改任何安装根。', {
        root: plan.probe.dsh.root,
      })
    }
  }

  const results = []
  const newlyPatched = []
  try {
    for (const plan of plans) {
      const result = applyShellPatch({ ...options, manifest, dshRoot: plan.probe.dsh.root })
      results.push({ ...result, previousState: plan.state })
      if (plan.state === 'original') newlyPatched.push(plan.probe.dsh.root)
    }
  } catch (error) {
    const rollbackFailures = []
    for (const dshRoot of newlyPatched.reverse()) {
      try {
        restoreActiveShellPatch({ ...options, manifest, dshRoot })
      } catch (failure) {
        rollbackFailures.push({ dshRoot, error: failure.message })
      }
    }
    if (rollbackFailures.length > 0) {
      throw new ShellPatchError('多安装根补丁失败，且至少一个已修改根无法自动回滚。', {
        cause: error.message,
        rollbackFailures,
      })
    }
    throw new ShellPatchError('多安装根补丁失败，已将本次修改的安装根全部恢复。', { cause: error.message })
  }
  return {
    operation: 'apply-all',
    state: results.every(item => item.state === 'already-patched') ? 'already-patched' : 'patched',
    installations: results,
    ignoredUnsupported: ignoredUnsupported(discovery),
    ignoredInactive: ignoredInactive(discovery),
  }
}

function restoreDiscovery(options, manifest) {
  const explicit = rootsFromOptions(options)
  const discovery = discoverDshInstallations(manifest, options)
  const activeStates = listActiveShellPatchStates(options)
  const requiredUnsupported = discovery.unsupported.filter(item => item.required)
  if (discovery.broken.length > 0 || requiredUnsupported.length > 0) {
    throw discoveryError(discovery)
  }
  const probes = new Map(discovery.supported.map(probe => [normalizedPathKey(probe.dsh.root), probe]))
  if (explicit.length === 0) {
    for (const state of activeStates) {
      const key = normalizedPathKey(state.dshRoot)
      if (probes.has(key)) continue
      try {
        const probe = probeDshInstallation(state.dshRoot, manifest)
        if (!probe.target) {
          throw new ShellPatchError('已记录的 DSH 安装根版本组合不受支持；未修改任何文件。', {
            root: state.dshRoot,
            versions: probe.versions,
          })
        }
        probes.set(key, probe)
      } catch (error) {
        if (error instanceof ShellPatchError) throw error
        throw new ShellPatchError('已记录的 DSH 安装根不可用；保留状态和备份，未修改任何文件。', {
          root: state.dshRoot,
          error: error.message,
        })
      }
    }
  }
  return {
    probes: [...probes.values()].sort((left, right) => left.dsh.root.localeCompare(right.dsh.root)),
    discovery,
    activeStates,
  }
}

export function restoreAllShellPatches(options = {}) {
  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  const { probes, discovery, activeStates } = restoreDiscovery(options, manifest)
  if (probes.length === 0 && activeStates.length === 0) {
    return {
      operation: 'restore-all',
      state: 'not-installed',
      installations: [],
      ignoredUnsupported: ignoredUnsupported(discovery),
      ignoredInactive: ignoredInactive(discovery),
    }
  }
  const activeByRoot = new Map(activeStates.map(state => [normalizedPathKey(state.dshRoot), state]))
  const plans = probes.map(probe => {
    const inspected = inspectProbe(probe, manifest)
    if (inspected.state === 'unexpected') throw unsupportedStateError(probe, inspected.records)
    const active = activeByRoot.get(normalizedPathKey(probe.dsh.root))
    const backupDirectory = inspected.state === 'patched'
      ? findMatchingBackup(probe, manifest, inspected.records, options)
      : active?.backupDirectory
    if (inspected.state === 'patched' && !backupDirectory) {
      throw new ShellPatchError('右侧栏文件已打补丁，但没有可验证的原文件备份；未修改任何安装根。', {
        root: probe.dsh.root,
      })
    }
    return { ...inspected, active, backupDirectory }
  })

  const results = []
  const restoredRoots = []
  try {
    for (const plan of plans) {
      if (plan.state === 'patched') {
        const result = restoreShellPatch(plan.backupDirectory, {
          ...options,
          manifest,
          dshRoot: plan.probe.dsh.root,
        })
        results.push(result)
        restoredRoots.push(plan.probe.dsh.root)
      } else {
        if (plan.active) clearActiveState(plan.active.backupDirectory, plan.probe.dsh.root, options)
        results.push({
          operation: 'restore',
          state: 'already-original',
          dshRoot: plan.probe.dsh.root,
          layoutRoot: plan.probe.layout.root,
          versions: plan.probe.versions,
          ...(plan.backupDirectory ? { backupDirectory: plan.backupDirectory } : {}),
        })
      }
    }
  } catch (error) {
    const rollbackFailures = []
    for (const dshRoot of restoredRoots.reverse()) {
      try {
        applyShellPatch({ ...options, manifest, dshRoot })
      } catch (failure) {
        rollbackFailures.push({ dshRoot, error: failure.message })
      }
    }
    if (rollbackFailures.length > 0) {
      throw new ShellPatchError('多安装根恢复失败，且至少一个已恢复根无法回到补丁状态。', {
        cause: error.message,
        rollbackFailures,
      })
    }
    throw new ShellPatchError('多安装根恢复失败，已将先前恢复的根全部回到补丁状态。', { cause: error.message })
  }
  return {
    operation: 'restore-all',
    state: results.some(item => item.state === 'restored') ? 'restored' : 'already-original',
    installations: results,
    ignoredUnsupported: ignoredUnsupported(discovery),
    ignoredInactive: ignoredInactive(discovery),
  }
}

function parseArgs(argv) {
  const args = [...argv]
  let command = 'apply'
  if (args[0] && !args[0].startsWith('-')) command = args.shift()
  const options = {}
  let restorePath
  if (command === 'restore') {
    restorePath = args.shift()
    if (!restorePath) throw new ShellPatchError('restore 需要备份目录路径。')
  }
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--json') {
      options.json = true
      continue
    }
    if (!['--dsh-root', '--backup-root', '--manifest'].includes(flag)) {
      throw new ShellPatchError(`未知参数: ${flag}`)
    }
    const value = args.shift()
    if (!value) throw new ShellPatchError(`${flag} 缺少参数。`)
    if (flag === '--dsh-root') {
      options.dshRoots ??= []
      options.dshRoots.push(value)
      options.dshRoot = value
    }
    else if (flag === '--backup-root') options.backupRoot = value
    else options.manifestPath = value
  }
  if (!['apply', 'apply-all', 'status', 'status-all', 'discover', 'restore', 'restore-active', 'restore-all'].includes(command)) {
    throw new ShellPatchError(`未知操作: ${command}`)
  }
  if (['apply', 'status', 'restore', 'restore-active'].includes(command) && options.dshRoots?.length > 1) {
    throw new ShellPatchError(`${command} 只接受一个 --dsh-root；多根请使用对应的 -all 操作。`)
  }
  return { command, restorePath, options }
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (result.operation === 'apply-all' || result.operation === 'restore-all' || result.operation === 'status-all') {
    process.stdout.write(`${result.operation}: ${result.state}\n`)
    for (const item of result.installations) process.stdout.write(`DSH: ${item.dshRoot} (${item.state})\n`)
    return
  }
  if (result.operation === 'restore-active' && result.state === 'not-installed') {
    process.stdout.write('没有需要恢复的右侧检查器安装。\n')
    return
  }
  if (result.operation === 'restore-active' && result.state === 'superseded-by-upgrade') {
    process.stdout.write('DSH 升级已经替换旧版 shell 文件；已清除旧补丁状态。\n')
    return
  }
  const versionText = `DSH ${result.versions.dsh} / web-app ${result.versions.webApp} / layout ${result.versions.layout}`
  if (result.operation === 'status') {
    process.stdout.write(`shell 补丁状态: ${result.state} (${versionText})\n`)
    process.stdout.write(`DSH: ${result.dshRoot}\n`)
    return
  }
  if (result.state === 'already-patched') {
    process.stdout.write(`shell 检查器补丁已经完整应用 (${versionText})。\n`)
    return
  }
  if (result.state === 'already-original') {
    process.stdout.write(`shell 文件已经是原始状态 (${versionText})。\n`)
    return
  }
  if (result.operation === 'apply') {
    process.stdout.write(`shell 检查器补丁已安全应用 (${versionText})。\n`)
    process.stdout.write(`完整备份: ${result.backupDirectory}\n`)
    process.stdout.write(`恢复命令: node ${JSON.stringify(fileURLToPath(import.meta.url))} restore ${JSON.stringify(result.backupDirectory)}\n`)
    return
  }
  process.stdout.write(`shell 文件已从完整备份恢复 (${versionText})。\n`)
}

function cli() {
  try {
    const { command, restorePath, options } = parseArgs(process.argv.slice(2))
    const result = command === 'apply'
      ? applyShellPatch(options)
      : command === 'apply-all'
        ? applyAllShellPatches(options)
        : command === 'status'
          ? inspectShellPatch(options)
          : command === 'status-all'
            ? inspectAllShellPatches(options)
            : command === 'discover'
              ? discoverDshInstallations(loadShellPatchManifest(options.manifestPath), options)
              : command === 'restore'
                ? restoreShellPatch(restorePath, options)
                : command === 'restore-active'
                  ? restoreActiveShellPatch(options)
                  : restoreAllShellPatches(options)
    printResult(result, options.json)
  } catch (error) {
    const body = error instanceof ShellPatchError
      ? { error: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
      : { error: error?.stack ?? String(error) }
    if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify(body)}\n`)
    else {
      process.stderr.write(`${body.error}\n`)
      if (body.details) process.stderr.write(`${JSON.stringify(body.details, null, 2)}\n`)
    }
    process.exitCode = 1
  }
}

if (process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) cli()
