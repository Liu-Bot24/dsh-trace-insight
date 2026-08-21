import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeTrace,
  classifyError,
  collectToolCalls,
  extractPathsAndUrls,
  projectRawSession,
} from '../src/core.mjs'

function tool(seq, name, args, text, { error = false, code } = {}) {
  return {
    kind: 'tool-result',
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    callId: `call-${seq}`,
    call: { name, argsRaw: JSON.stringify(args) },
    callTime: 1_700_000_000_000 + seq * 1000 - 300,
    content: [{ type: 'text', text }],
    isError: error,
    ...(code ? { error: { name: 'ToolError', code } } : {}),
    subCalls: [],
  }
}

function assistant(seq, turn, step, text) {
  return {
    kind: 'assistant',
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    turn,
    step,
    blocks: [{ kind: 'text', text }],
  }
}

function user(seq, text) {
  return {
    kind: 'user',
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    content: [{ type: 'text', text }],
    source: null,
  }
}

test('extracts local paths and URLs without mixing them', () => {
  const result = extractPathsAndUrls(JSON.stringify({
    path: 'D:\\work\\repo',
    url: 'https://raw.githubusercontent.com/example/repo/main/a.ts',
  }))
  assert.deepEqual(result.paths, ['D:\\work\\repo'])
  assert.deepEqual(result.urls, ['https://raw.githubusercontent.com/example/repo/main/a.ts'])
})

test('normalizes common DSH/tool failures', () => {
  assert.equal(classifyError('FS_NOT_FOUND'), 'FS_NOT_FOUND')
  assert.equal(classifyError('terminal inspection is unsupported on platform win32'), 'PLATFORM_UNSUPPORTED')
  assert.equal(classifyError('Permission denied'), 'PERMISSION_DENIED')
  assert.equal(classifyError('process.platform is win32; inspection completed'), null)
})

test('does not mistake a URL inside patch content for a remote path', () => {
  const nodes = [
    tool(1, 'apply_patch', { patch: '+ See https://example.com/docs' }, 'Patch applied successfully.'),
  ]
  const [call] = collectToolCalls(nodes, [], new Map())
  const report = analyzeTrace({
    snapshot: { sessionId: 'patch-url', hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })
  assert.deepEqual(call.urls, ['https://example.com/docs'])
  assert.deepEqual(call.resourceUrls, [])
  assert.equal(report.findings.some(item => item.category === 'tool_semantics'), false)
})

test('collectToolCalls pairs arguments, results, locations and failure status', () => {
  const node = tool(7, 'str_replace_editor', { command: 'view', path: 'D:\\missing' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' })
  const locations = new Map([[7, { kind: 'step', turn: { turn: 2 }, step: { step: 3 } }]])
  const calls = collectToolCalls([node], [], locations)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].turn, 2)
  assert.equal(calls[0].step, 3)
  assert.equal(calls[0].failed, true)
  assert.equal(calls[0].errorCode, 'FS_NOT_FOUND')
  assert.deepEqual(calls[0].paths, ['D:\\missing'])
  assert.equal(calls[0].kind, 'inspect')
  assert.equal(calls[0].mutation, false)
})

test('uses a neutral tool name when a call result has no resolved tool metadata', () => {
  const node = tool(8, undefined, {}, 'completed')
  delete node.call.name
  node.callId = 'call_00_internal'
  const [call] = collectToolCalls([node], [], new Map())
  assert.equal(call.name, 'unknown-tool')
  assert.doesNotMatch(call.name, /call_00_internal/)
})

test('detects the screenshot-like failure chain and marks the run blocked', () => {
  const nodes = [
    user(1, '审计 weread-exporter 项目'),
    tool(3, 'str_replace_editor', { command: 'view', path: 'D:\\work\\weread-exporter' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(5, 'str_replace_editor', { command: 'view', path: 'D:\\tmp\\weread-exporter' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    assistant(6, 1, 2, 'Testing directory creation with file editor'),
    tool(7, 'str_replace_editor', { command: 'create', path: 'D:\\tmp\\weread-exporter-audit\\AUDIT.md', file_text: '# audit' }, 'New file created successfully.'),
    tool(9, 'str_replace_editor', { command: 'view', path: 'D:\\Downloads' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(11, 'str_replace_editor', { command: 'view', path: 'D:\\Users' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(13, 'str_replace_editor', { command: 'view', path: 'D:\\src' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(15, 'str_replace_editor', { command: 'view', path: 'D:\\git' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(17, 'str_replace_editor', { command: 'view', path: 'https://raw.githubusercontent.com/example/repo/main/README.md' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(19, 'str_replace_editor', { command: 'view', path: 'D:\\work\\repo' }, 'terminal inspection is unsupported on platform win32', { error: true }),
    assistant(20, 2, 4, '当前环境无法访问 GitHub，也没有可用 Bash。请先克隆仓库或上传文件。'),
  ]
  const eventLocations = new Map(nodes.map((node, index) => [node.seq, {
    kind: 'step', turn: { turn: index < 8 ? 1 : 2 }, step: { step: index + 1 },
  }]))
  const trace = { eventNodes: nodes, eventLocations, requests: [], runningCalls: [] }
  const report = analyzeTrace({
    snapshot: { sessionId: 'session-test', running: false, hasMore: false, nodes, runningCalls: [] },
    trace,
  })

  assert.equal(report.status.code, 'blocked')
  assert.equal(report.metrics.toolCalls, 9)
  assert.ok(report.metrics.failureRate > 0.8)
  const categories = new Set(report.findings.map(item => item.category))
  assert.ok(categories.has('blind_path'))
  assert.ok(categories.has('tool_semantics'))
  assert.ok(categories.has('capability'))
  assert.ok(categories.has('ordering'))
  assert.ok(categories.has('loop'))
  assert.ok(report.lessons.some(item => item.id === 'no-path-guessing'))
  assert.match(report.summary, /受阻/)
})

test('a clean, verified run does not invent high severity failures', () => {
  const nodes = [
    user(1, '运行测试并修复'),
    tool(3, 'bash', { command: 'npm test' }, '24 tests passed'),
    assistant(4, 1, 1, '测试已完成，24 项通过。'),
  ]
  const report = analyzeTrace({
    snapshot: { sessionId: 'clean', running: false, hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })
  assert.equal(report.status.code, 'complete')
  assert.equal(report.findings.filter(item => item.severity === 'high').length, 0)
  assert.equal(report.metrics.failedTools, 0)
})

test('successful cross-platform documentation does not become a capability failure', () => {
  const nodes = Array.from({ length: 19 }, (_, index) => tool(
    index + 1,
    'read',
    { path: `D:\\work\\repo\\file-${index + 1}.md` },
    index === 18
      ? 'README: Windows users run PowerShell; macOS users run bash in Terminal.'
      : 'File read successfully.',
  ))
  const report = analyzeTrace({
    snapshot: { sessionId: 'successful-platform-docs', running: true, hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })

  assert.equal(report.metrics.toolCalls, 19)
  assert.equal(report.metrics.failedTools, 0)
  assert.equal(report.findings.some(item => item.id === 'platform-capability-mismatch'), false)
})

test('successful file reads do not treat source-code error vocabulary as tool failures', () => {
  const nodes = [
    user(1, '审计源码并给出结论'),
    tool(2, 'read', { path: 'D:\\work\\client.py' }, [
      '<path>D:\\work\\client.py</path>',
      '<content>',
      'response = requests.get(url, timeout=30)',
      "if response.status_code in {401, 403}: raise RuntimeError('authentication failed')",
      '</content>',
    ].join('\n')),
    assistant(3, 1, 1, '源码读取和审计已经完成。'),
  ]
  const [call] = collectToolCalls(nodes, [], new Map())
  const report = analyzeTrace({
    snapshot: { sessionId: 'successful-source-read', running: false, hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })

  assert.equal(call.failed, false)
  assert.equal(call.errorCode, null)
  assert.equal(report.metrics.failedTools, 0)
  assert.equal(report.findings.some(item => item.category === 'repeated_failure' || item.category === 'loop'), false)
  assert.equal(report.status.code, 'complete')
})

test('unmistakable shell fatal output remains a failure when the wrapper omits isError', () => {
  const nodes = [
    tool(1, 'pwsh', { command: 'git clone https://example.invalid/repo.git' }, "[stderr] fatal: unable to access 'https://example.invalid/repo.git': connection refused"),
  ]
  const [call] = collectToolCalls(nodes, [], new Map())
  assert.equal(call.failed, true)
  assert.equal(call.errorCode, 'NETWORK_ERROR')
})

test('classifies str_replace_editor view as inspection rather than mutation', () => {
  const nodes = [
    tool(1, 'str_replace_editor', { command: 'view', path: 'D:\\work\\repo' }, 'Here are the files and directories.'),
  ]
  const [call] = collectToolCalls(nodes, [], new Map())
  assert.equal(call.kind, 'inspect')
  assert.equal(call.mutation, false)
})

test('does not classify a test file path as a verification call', () => {
  const nodes = [
    tool(1, 'read_file', { path: 'D:\\work\\project\\test\\case.js' }, 'export const value = 1'),
  ]
  const [call] = collectToolCalls(nodes, [], new Map())
  assert.equal(call.kind, 'inspect')
})

test('includes durable slash-command lifecycle in execution metrics', () => {
  const nodes = [{
    kind: 'command',
    seq: 2,
    time: 1_700_000_002_000,
    commandId: 'command-1',
    name: 'compact',
    args: '',
    outcome: { kind: 'success', text: 'Compaction complete' },
  }]
  const calls = collectToolCalls(nodes, [], new Map())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, '/compact')
  assert.equal(calls[0].kind, 'execute')
  assert.equal(calls[0].failed, false)
})

test('does not treat a blocked disclosure as an unsupported completion claim', () => {
  const nodes = [
    user(1, '审计项目'),
    tool(2, 'str_replace_editor', { command: 'view', path: 'D:\\missing' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    assistant(3, 1, 1, '已创建临时目录，但当前无法访问目标项目，请上传仓库。'),
  ]
  const report = analyzeTrace({
    snapshot: { sessionId: 'blocked', hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })
  assert.equal(report.status.code, 'blocked')
  assert.equal(report.findings.some(item => item.id === 'completion-evidence-mismatch'), false)
})

test('treats a failed attempt followed by recovery and verification as complete', () => {
  const nodes = [
    user(1, '读取项目并运行测试'),
    tool(2, 'read_file', { path: 'D:\\wrong\\package.json' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(3, 'read_file', { path: 'D:\\work\\package.json' }, '{"scripts":{"test":"node --test"}}'),
    tool(4, 'bash', { command: 'npm test' }, '16 tests passed'),
    assistant(5, 1, 3, '检查已完成，16 项测试全部通过。'),
  ]
  const report = analyzeTrace({
    snapshot: { sessionId: 'recovered', hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })
  assert.equal(report.status.code, 'complete')
  assert.equal(report.findings.some(item => item.id === 'completion-evidence-mismatch'), false)
})

test('completed audit is not blocked by limitation words quoted about the audited code', () => {
  const nodes = [
    user(1, '克隆项目并完成代码审计'),
    tool(2, 'pwsh', { command: 'git clone https://example.invalid/repo.git' }, 'fatal: certificate error', { error: true, code: 'CERTIFICATE_ERROR' }),
    tool(3, 'pwsh', { command: 'git -c http.sslBackend=openssl clone https://example.invalid/repo.git' }, 'Cloning into repo... done.'),
    tool(4, 'read_file', { path: 'D:\\work\\repo\\export.py' }, 'def export(): return True'),
    assistant(5, 1, 3, '代码审计已经完成。目标代码对于非标准目录排版缺少通用的自适应解析算法，但全部计划项均已闭环。'),
  ]
  const report = analyzeTrace({
    snapshot: { sessionId: 'completed-audit', hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })
  assert.equal(report.status.code, 'complete')
  assert.equal(report.findings.some(item => item.id === 'completion-evidence-mismatch'), false)
})

test('keeps an unsupported completion claim partial when failure is unresolved', () => {
  const nodes = [
    user(1, '读取项目并生成报告'),
    tool(2, 'read_file', { path: 'D:\\missing\\package.json' }, 'FS_NOT_FOUND', { error: true, code: 'FS_NOT_FOUND' }),
    tool(3, 'write_file', { path: 'D:\\output\\REPORT.md', content: '# report' }, 'File created successfully.'),
    assistant(4, 1, 2, '报告已经完成。'),
  ]
  const report = analyzeTrace({
    snapshot: { sessionId: 'unsupported-completion', hasMore: false, nodes, runningCalls: [] },
    trace: { eventNodes: nodes, eventLocations: new Map(), requests: [], runningCalls: [] },
  })
  assert.equal(report.status.code, 'partial')
  assert.equal(report.findings.some(item => item.id === 'completion-evidence-mismatch'), true)
})

test('projects and analyzes a complete Host Session Event Log', () => {
  const rawEvents = [
    { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1_010, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 1_020, surfaceOp: 'append', data: {
        id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '读取项目并运行测试' }],
      },
    },
    { type: 'tool/call', seq: 3, time: 1_030, data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"D:\\\\wrong\\\\package.json"}' } },
    {
      type: 'tool/result', seq: 4, time: 1_040, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: {
          id: 'tool-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'FS_NOT_FOUND' }], isError: true }],
        },
        error: { name: 'FsError', code: 'FS_NOT_FOUND' },
      },
    },
    { type: 'tool/call', seq: 5, time: 1_050, data: { turn: 1, step: 1, callId: 'call-2', name: 'read_file', arguments: '{"path":"D:\\\\work\\\\package.json"}' } },
    {
      type: 'tool/result', seq: 6, time: 1_060, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: {
          id: 'tool-2', role: 'user', source: { kind: 'tool', callId: 'call-2' },
          content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: '{"scripts":{"test":"node --test"}}' }] }],
        },
      },
    },
    { type: 'tool/call', seq: 7, time: 1_070, data: { turn: 1, step: 1, callId: 'call-3', name: 'bash', arguments: '{"command":"npm test"}' } },
    {
      type: 'tool/result', seq: 8, time: 1_080, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: {
          id: 'tool-3', role: 'user', source: { kind: 'tool', callId: 'call-3' },
          content: [{ type: 'tool-result', toolCallId: 'call-3', content: [{ type: 'text', text: '16 tests passed' }] }],
        },
      },
    },
    {
      type: 'assistant/message', seq: 9, time: 1_090, surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2], data: {
        turn: 1, step: 1,
        message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: '已经完成，16 项测试通过。' }] },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    },
    { type: 'step/end', seq: 10, time: 1_100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 11, time: 1_110, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const rawSession = {
    log: { session: { id: 'raw-session', version: 0, createdAt: 1_000 }, events: rawEvents },
    records: rawEvents.map(event => ({
      sessionId: 'raw-session', seq: event.seq, type: event.type, time: event.time,
      surface: event.seq === 2 ? 'shadowed' : event.surfaceOp ? 'current' : 'log-only',
    })),
    surface: { session: { id: 'raw-session' }, capturedThroughSeq: 11, events: rawEvents.filter(event => event.surfaceOp && event.seq !== 2) },
    lineage: { complete: true, target: {}, ancestors: [{ session: {} }], descendants: [{ session: {}, descendants: [{ session: {}, descendants: [] }] }], root: {} },
    diagnostics: [],
  }

  const projected = projectRawSession(rawSession)
  assert.equal(projected.snapshot.hasMore, false)
  assert.equal(projected.trace.eventNodes.filter(node => node.kind === 'tool-result').length, 3)
  assert.equal(projected.trace.requests.length, 1)

  const report = analyzeTrace({ rawSession })
  assert.equal(report.source.kind, 'host-session-query')
  assert.equal(report.source.rawEvents, rawEvents.length)
  assert.equal(report.source.surfaceCounts.shadowed, 1)
  assert.equal(report.source.replacementEvents, 1)
  assert.equal(report.source.sourceLinks, 1)
  assert.equal(report.source.ancestors, 1)
  assert.equal(report.source.descendants, 2)
  assert.equal(report.metrics.toolCalls, 3)
  assert.equal(report.metrics.requests, 1)
  assert.equal(report.metrics.usage.input, 10)
  assert.equal(report.status.code, 'complete')
})

test('closed raw turns do not leave unmatched calls falsely running', () => {
  const rawSession = {
    log: {
      session: { id: 'failed-raw-session', version: 0, createdAt: 1_000 },
      events: [
        { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 1_010, data: { turn: 1, step: 1 } },
        { type: 'tool/call', seq: 2, time: 1_020, data: { turn: 1, step: 1, callId: 'call-open', name: 'bash', arguments: '{"command":"npm test"}' } },
        { type: 'step/end', seq: 3, time: 1_030, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 4, time: 1_040, data: { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'missing credential' } } } },
      ],
    },
  }
  const projected = projectRawSession(rawSession)
  assert.equal(projected.snapshot.running, false)
  assert.equal(projected.trace.runningCalls.length, 0)
  const report = analyzeTrace({ rawSession })
  assert.equal(report.metrics.runningTools, 0)
  assert.equal(report.metrics.failedTools, 1)
  assert.equal(report.status.code, 'failed')
})
