import { createServer } from 'node:http'

// DSH Market's documented DSHM_REGISTRY_URL seam; only the catalog is local.
// Installation still downloads the real, public, prebuilt GitHub subpackage.
const repo = 'https://github.com/Liu-Bot24/dsh-trace-insight'
const catalog = {
  updated: new Date().toISOString(), count: 1,
  categories: { dev: { en: 'Development', zh: '开发工具' } },
  plugins: [{
    url: `${repo}/tree/main/packages/standard`, name: 'Liu-Bot24/dsh-trace-insight#standard',
    category: 'dev', description: {
      en: 'Read-only trajectory review with rule analysis, model explanations, evidence navigation, and run comparison in a conversation tab.',
      zh: '在会话标签中提供只读轨迹复盘、规则分析、模型解读、证据定位和运行对比。',
    },
    npm: null, install: 'dsh plugin --profile web add github:Liu-Bot24/dsh-trace-insight#path:/packages/standard', added: '2026-08-27',
  }],
}
const port = Number(process.argv[2] ?? 3185)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 3080) throw new Error('Use a dedicated test port.')
const server = createServer((request, response) => {
  if (request.url !== '/plugins.json') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(catalog))
})
server.listen(port, '127.0.0.1', () => console.log(`Catalog: http://127.0.0.1:${port}/plugins.json`))
