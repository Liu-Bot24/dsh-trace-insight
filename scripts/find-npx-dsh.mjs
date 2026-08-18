#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const version = process.argv[2]
if (!version) throw new Error('DSH version is required.')

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
    const manifestPath = join(packageRoot, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === '@deepseek-ai/dsh' && manifest.version === version) {
        matches.add(realpathSync(packageRoot))
      }
    } catch {
      // Ignore incomplete cache entries.
    }
  }
}

if (matches.size !== 1) {
  throw new Error(`Expected one cached @deepseek-ai/dsh@${version} installation, found ${matches.size}.`)
}
process.stdout.write(`${[...matches][0]}\n`)
