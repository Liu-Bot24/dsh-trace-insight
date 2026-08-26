#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

const version = process.argv[2]
if (!version) throw new Error('DSH version is required.')

function validPackageRoot(packageRoot) {
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return manifest.name === '@deepseek-ai/dsh' && manifest.version === version
  } catch {
    return false
  }
}

// npm exec/npx prepends the selected package's node_modules/.bin directory to
// PATH. Prefer that exact package over a broad cache scan so multiple cached
// invocations of the same DSH version cannot make installation ambiguous.
const activeMatches = new Set()
for (const pathEntry of (process.env.PATH || '').split(delimiter)) {
  if (!pathEntry) continue
  const binRoot = resolve(pathEntry)
  if (!/node_modules[\\/]\.bin$/u.test(binRoot)) continue
  const packageRoot = join(dirname(binRoot), '@deepseek-ai', 'dsh')
  if (validPackageRoot(packageRoot)) activeMatches.add(realpathSync(packageRoot))
}

if (activeMatches.size === 1) {
  process.stdout.write(`${[...activeMatches][0]}\n`)
  process.exit(0)
}
if (activeMatches.size > 1) {
  throw new Error(`Expected one active @deepseek-ai/dsh@${version} installation, found ${activeMatches.size}.`)
}

const cacheRoots = new Set()
if (process.env.DSH_NPX_CACHE_ROOT) {
  cacheRoots.add(process.env.DSH_NPX_CACHE_ROOT)
} else {
  if (process.env.npm_config_cache) cacheRoots.add(process.env.npm_config_cache)
  if (process.env.LOCALAPPDATA) cacheRoots.add(join(process.env.LOCALAPPDATA, 'npm-cache'))
  cacheRoots.add(join(homedir(), '.npm'))
}

const matches = new Set()
for (const cacheRoot of cacheRoots) {
  const npxRoot = join(cacheRoot, '_npx')
  if (!existsSync(npxRoot)) continue
  for (const entry of readdirSync(npxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageRoot = join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh')
    if (validPackageRoot(packageRoot)) matches.add(realpathSync(packageRoot))
  }
}

if (matches.size !== 1) {
  throw new Error(`Expected one cached @deepseek-ai/dsh@${version} installation, found ${matches.size}.`)
}
process.stdout.write(`${[...matches][0]}\n`)
