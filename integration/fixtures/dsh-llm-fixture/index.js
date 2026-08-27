export const name = 'trace-insight-fixture-llm'
export const inject = ['llm']

const PROVIDER = 'trace-insight-fixture'
const MODELS = [
  { id: 'fixture-small', name: 'Fixture Small' },
  { id: 'fixture-strong', name: 'Fixture Strong' },
  { id: 'fixture-fail', name: 'Fixture Failure' },
]

function reportFor(options) {
  const prompt = options.messages?.flatMap(message => message.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n') ?? ''
  const coverage = /"fromSeq":(\d+),"toSeq":(\d+)/.exec(prompt)
  const fromSeq = Number(coverage?.[1] ?? 0)
  const toSeq = Number(coverage?.[2] ?? fromSeq)
  return JSON.stringify({
    verdict: `${options.model} 已分析 Seq ${fromSeq}–${toSeq}`,
    narrative: '隔离模型通过 DSH 的旁路 llm.stream 接口完成了这一段轨迹的结构化分析。',
    assessment: '该结果只用于集成验证，不代表真实模型质量。',
    rootCauses: ['集成测试轨迹中的模拟问题'],
    nextSteps: ['核对持久化的覆盖范围和模型版本'],
    lessons: ['模型分析必须独立于主 Agent 会话保存'],
    evidenceRefs: [{ seq: fromSeq, note: '所选区间起点' }, { seq: toSeq, note: '所选区间终点' }],
    risk: options.model === 'fixture-strong' ? 'low' : 'medium',
    confidence: 'high',
    continuitySummary: `已连续覆盖至 Seq ${toSeq}；本结果来自 ${options.model}。`,
  })
}

const adapter = {
  providerInfo(provider) {
    return { id: provider, name: 'Trace Insight Fixture' }
  },
  providerRetryPolicy() {},
  async listModels() {
    return MODELS.map(model => ({ provider: PROVIDER, ...model }))
  },
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: MODELS.find(item => item.id === model)?.name ?? model,
      context: { contextWindow: 65_536 },
    }
  },
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  },
  async *stream(options) {
    if (options.model === 'fixture-fail') {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'FIXTURE_FAILURE', message: 'Intentional isolated provider failure.' } },
      }
      return
    }
    const text = reportFor(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: { inputTokens: 128, outputTokens: 96, totalTokens: 224 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
