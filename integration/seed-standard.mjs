import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const [homeArg, workspaceArg] = process.argv.slice(2)
if (!homeArg || !workspaceArg) throw new Error('Usage: node integration/seed-standard.mjs <isolated DSH_HOME> <isolated workspace>')
const dshHome = resolve(homeArg)
const workspace = resolve(workspaceArg)
if (dshHome === resolve(homedir(), '.dsh')) throw new Error('Refusing to seed the real DSH_HOME.')
mkdirSync(workspace, { recursive: true })
function json(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}
function projectKey(path) {
  let slug = ''
  let separator = false
  for (let i = 0; i < path.length; i++) {
    const char = path[i]
    if ('/\\:'.includes(char)) {
      if (!separator) slug += '-'
      separator = true
    } else {
      slug += /^[A-Za-z0-9._-]$/.test(char) ? char : `~${path.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
      separator = false
    }
  }
  return `--${(slug.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
const sessionIds = ['session-standard-demo-0001', 'session-standard-demo-0002']
const now = Date.now() - 60_000
json(join(dshHome, 'storages/workspace.json'), {
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-standard-demo'], archivedSessionIds: [] },
  tables: { workspaces: { 'ws-standard-demo': {
    path: workspace, title: 'Trace Insight 标准版验收', sessionIds,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  } } },
})
for (const [index, id] of sessionIds.entries()) {
  const header = { type: 'session', version: 0, id, createdAt: now, cwd: workspace, delegationDepth: 0, agentPreset: 'standard' }
  const text = index === 0 ? '检查标准标签版的轨迹解读。' : '第二个会话用于检查数据隔离。'
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: { role: 'user', id: `${id}-user`, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: `${id}-call`, name: 'read_file', arguments: '{"path":"missing-demo.txt"}' } },
    { type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: {
      role: 'user', id: `${id}-result`, source: { kind: 'tool', callId: `${id}-call` },
      content: [{ type: 'tool-result', toolCallId: `${id}-call`, isError: true, content: [{ type: 'text', text: 'ENOENT: missing-demo.txt does not exist' }] }],
    } } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: {
      role: 'assistant', id: `${id}-assistant`, source: { kind: 'model', provider: 'trace-insight-fixture', model: 'fixture-small' },
      content: [{ type: 'text', text: '文件不存在，保留失败结果并等待正确路径。' }],
    } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: now + seq + index * 100 }))
  const path = join(dshHome, 'sessions', projectKey(workspace), id, 'session.jsonl.zstd')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([header, ...events].map(value => zstdCompressSync(Buffer.from(JSON.stringify(value) + '\n')))))
}
json(join(dshHome, 'trace-insight/settings.json'), {
  schemaVersion: 1, revision: 0, updatedAt: null,
  settings: { defaultRoute: null, auto: { enabled: false } },
})
console.log(JSON.stringify({ dshHome, workspace, sessionIds }))
