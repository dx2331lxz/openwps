import { readConfig } from './configService.js'
import { layoutTools } from '../../src/ai/tools.js'

export interface ToolCall {
  name: string
  params: Record<string, unknown>
}

export interface AIResponse {
  reply: string
  toolCalls: ToolCall[]
}

export async function processAIMessage(
  message: string,
  context: Record<string, unknown>
): Promise<AIResponse> {
  const config = readConfig()

  if (!config.apiKey) {
    return {
      reply: '⚠️ 未配置 API Key，请点击左下角 ⚙️ 设置 AI 配置后重试。',
      toolCalls: [],
    }
  }

  const systemPrompt = `你是一个文档排版助手，帮助用户对文档进行排版操作。
你必须通过工具调用来完成排版，不要只用文字回复。
当前文档信息：段落数=${context.paragraphCount ?? 0}，字数=${context.wordCount ?? 0}，页数=${context.pageCount ?? 1}。
请根据用户指令，调用合适的工具完成排版，并简洁地描述你做了什么。`

  try {
    if (config.provider === 'anthropic') {
      return await callAnthropic(message, systemPrompt, config.apiKey, config.model)
    } else {
      return await callOpenAICompat(
        message,
        systemPrompt,
        config.apiKey,
        config.model,
        config.endpoint
      )
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { reply: `❌ AI 调用失败：${msg}`, toolCalls: [] }
  }
}

async function callOpenAICompat(
  message: string,
  systemPrompt: string,
  apiKey: string,
  model: string,
  endpoint: string
): Promise<AIResponse> {
  const tools = layoutTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  const url = endpoint.endsWith('/') ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 1024,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  const data = await res.json() as {
    choices: Array<{
      message: {
        content: string | null
        tool_calls?: Array<{
          function: { name: string; arguments: string }
        }>
      }
    }>
  }

  const msg = data.choices[0]?.message
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map(tc => ({
    name: tc.function.name,
    params: JSON.parse(tc.function.arguments),
  }))
  const reply = msg?.content ?? buildReplyFromToolCalls(toolCalls)
  return { reply, toolCalls }
}

async function callAnthropic(
  message: string,
  systemPrompt: string,
  apiKey: string,
  model: string
): Promise<AIResponse> {
  const tools = layoutTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
      tools,
      max_tokens: 1024,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  const data = await res.json() as {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; name: string; input: Record<string, unknown> }
    >
  }

  const toolCalls: ToolCall[] = data.content
    .filter(b => b.type === 'tool_use')
    .map(b => {
      const block = b as { type: 'tool_use'; name: string; input: Record<string, unknown> }
      return { name: block.name, params: block.input }
    })
  const textBlock = data.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined
  const reply = textBlock?.text ?? buildReplyFromToolCalls(toolCalls)
  return { reply, toolCalls }
}

function buildReplyFromToolCalls(toolCalls: ToolCall[]): string {
  if (toolCalls.length === 0) return '已处理完成。'
  const lines = toolCalls.map(tc => `✅ ${tc.name}`)
  return lines.join('\n') + '\n已完成。'
}
