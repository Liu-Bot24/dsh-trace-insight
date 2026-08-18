import { writeFile } from 'node:fs/promises'
import { analyzeTrace } from '../src/core.mjs'

function tool(seq, path, text, { command = 'view', error = true } = {}) {
  return {
    kind: 'tool-result',
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    callId: `call-${seq}`,
    call: { name: 'str_replace_editor', argsRaw: JSON.stringify({ command, path }) },
    callTime: 1_700_000_000_000 + seq * 1000 - 300,
    content: [{ type: 'text', text }],
    isError: error,
    ...(error ? { error: { name: 'ToolError', code: text } } : {}),
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

const nodes = [
  { kind: 'user', seq: 1, time: 1_700_000_001_000, content: [{ type: 'text', text: '审计 weread-exporter 项目' }], source: null },
  tool(3, 'D:\\work\\weread-exporter', 'FS_NOT_FOUND'),
  tool(5, 'D:\\tmp\\weread-exporter', 'FS_NOT_FOUND'),
  tool(7, 'D:\\tmp\\weread-exporter-audit\\AUDIT.md', 'New file created successfully.', { command: 'create', error: false }),
  tool(9, 'D:\\Downloads', 'FS_NOT_FOUND'),
  tool(11, 'D:\\download', 'FS_NOT_FOUND'),
  tool(13, 'D:\\Users', 'FS_NOT_FOUND'),
  tool(15, 'D:\\src', 'FS_NOT_FOUND'),
  tool(17, 'D:\\git', 'FS_NOT_FOUND'),
  tool(19, 'https://raw.githubusercontent.com/example/repo/main/README.md', 'FS_NOT_FOUND'),
  tool(21, 'D:\\work\\repo', 'terminal inspection is unsupported on platform win32'),
  {
    kind: 'assistant', seq: 22, time: 1_700_000_022_000, turn: 2, step: 4,
    blocks: [{ kind: 'text', text: '当前环境无法访问 GitHub，也没有可用 Bash。请先克隆仓库或上传文件。' }],
  },
]
const eventLocations = new Map(nodes.map((node, index) => [node.seq, {
  kind: 'step', turn: { turn: index < 8 ? 1 : 2 }, step: { step: index + 1 },
}]))
const report = analyzeTrace({
  snapshot: { sessionId: 'screenshot-like-example', hasMore: false, nodes, runningCalls: [] },
  trace: { eventNodes: nodes, eventLocations, requests: [], runningCalls: [] },
})
await writeFile(new URL('./screenshot-like-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`)
