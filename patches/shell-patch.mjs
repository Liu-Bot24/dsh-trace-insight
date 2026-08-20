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
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
    return JSON.parse(readFileSync(path, 'utf8'))
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

function packageRootFromCandidate(candidate) {
  if (!candidate) return undefined
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
  if (process.env.npm_config_cache) roots.add(join(process.env.npm_config_cache, '_npx'))
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

export function discoverDshInstallation(manifest = loadShellPatchManifest()) {
  const raw = [
    process.env.DSH_PACKAGE_ROOT,
    ...commandCandidates(),
    globalNpmCandidate(),
    ...npxCandidates(),
  ].filter(Boolean)
  const roots = new Set()
  for (const candidate of raw) {
    try {
      const root = packageRootFromCandidate(candidate)
      if (root) roots.add(root)
    } catch {
      // A stale PATH or npx cache entry is not a usable installation candidate.
    }
  }

  const probes = []
  for (const root of roots) {
    try {
      probes.push(probeDshInstallation(root, manifest))
    } catch {
      // Broken package trees are reported only if no supported installation exists.
    }
  }
  const supported = probes.filter(probe => probe.target !== undefined)
  if (supported.length === 1) return supported[0]
  if (supported.length > 1) {
    throw new ShellPatchError('检测到多个受支持的 DSH 安装；请用 --dsh-root 明确指定正在使用的安装根。', {
      candidates: supported.map(item => item.dsh.root),
    })
  }
  if (probes.length > 0) {
    throw new ShellPatchError('发现 DSH，但版本组合不受支持；未修改任何文件。', {
      candidates: probes.map(item => ({ root: item.dsh.root, versions: item.versions })),
    })
  }
  throw new ShellPatchError('无法定位受支持的 DSH 安装；请用 --dsh-root 指定 @deepseek-ai/dsh 包或其安装根。')
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

function activeStatePath(options = {}) {
  if (options.statePath) return resolve(options.statePath)
  const backupRoot = resolve(options.backupRoot ?? defaultBackupRoot())
  return join(dirname(backupRoot), 'shell-patch-active.json')
}

function writeActiveState(state, options = {}) {
  const path = activeStatePath(options)
  mkdirSync(dirname(path), { recursive: true })
  const stage = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(stage, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(stage, path)
  } finally {
    if (existsSync(stage)) rmSync(stage, { force: true })
  }
  return path
}

function clearActiveState(backupDirectory, options = {}) {
  const path = activeStatePath(options)
  if (!existsSync(path)) return
  const state = readJson(path, 'active shell patch state')
  if (resolve(state.backupDirectory) === resolve(backupDirectory)) rmSync(path, { force: true })
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
    if (backupDirectory) {
      writeActiveState({
        schemaVersion: 1,
        patchId: manifest.patchId,
        targetId: probe.target.id,
        dshRoot: probe.dsh.root,
        backupDirectory,
        versions: probe.versions,
      }, options)
    }
    return {
      operation: 'apply',
      state: 'already-patched',
      targetId: probe.target.id,
      dshRoot: probe.dsh.root,
      layoutRoot: probe.layout.root,
      versions: probe.versions,
      ...(backupDirectory ? { backupDirectory } : {}),
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
      clearActiveState(backupDirectory, options)
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
    clearActiveState(backupDirectory, options)
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

  clearActiveState(backupDirectory, options)

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
  const path = activeStatePath(options)
  if (!existsSync(path)) return { operation: 'restore-active', state: 'not-installed' }
  const state = readJson(path, 'active shell patch state')
  if (state.schemaVersion !== 1
    || typeof state.backupDirectory !== 'string'
    || typeof state.dshRoot !== 'string') {
    throw new ShellPatchError(`不支持的 active shell patch state: ${path}`)
  }

  const manifest = options.manifest ?? loadShellPatchManifest(options.manifestPath)
  const dshRoot = options.dshRoot ?? state.dshRoot
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
    clearActiveState(state.backupDirectory, options)
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
    if (flag === '--dsh-root') options.dshRoot = value
    else if (flag === '--backup-root') options.backupRoot = value
    else options.manifestPath = value
  }
  if (!['apply', 'status', 'restore', 'restore-active'].includes(command)) throw new ShellPatchError(`未知操作: ${command}`)
  return { command, restorePath, options }
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
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
      : command === 'status'
        ? inspectShellPatch(options)
        : command === 'restore'
          ? restoreShellPatch(restorePath, options)
          : restoreActiveShellPatch(options)
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli()
