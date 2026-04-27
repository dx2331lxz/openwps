#!/usr/bin/env node

import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'

const DEFAULT_BASE_URL = 'http://localhost:5174'

function usage() {
  return `Usage:
  npm run doc:ai
  npm run doc:ai -- --chat
  npm run doc:ai -- "把标题改成月光下的约定"
  npm run doc:ai -- --chat "把标题改成月光下的约定"
  npm run doc:ai -- --session doc_xxx --mode agent "续写一段正文"

Options:
  --base <url>       Backend base URL, default ${DEFAULT_BASE_URL}
  --session <id>     Explicit documentSessionId. Defaults to active frontend session
  --mode <mode>      AI mode, default agent
  --provider <id>    Provider id override
  --model <name>     Model override
  --chat             Start conversational mode. No message also starts chat mode
  --json             Print raw SSE events as JSON lines
  --help             Show this help

Chat commands:
  /exit, /quit        Exit
  /session            Print current documentSessionId
  /help               Show this help
`
}

function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE_URL,
    session: '',
    mode: 'agent',
    provider: '',
    model: '',
    chat: false,
    json: false,
    help: false,
  }
  const messageParts = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--chat') {
      options.chat = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--base') {
      options.base = argv[++index] || ''
    } else if (arg === '--session') {
      options.session = argv[++index] || ''
    } else if (arg === '--mode') {
      options.mode = argv[++index] || ''
    } else if (arg === '--provider') {
      options.provider = argv[++index] || ''
    } else if (arg === '--model') {
      options.model = argv[++index] || ''
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`)
    } else {
      messageParts.push(arg)
    }
  }
  return { options, message: messageParts.join(' ').trim() }
}

async function readJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { detail: text }
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const data = await readJson(response)
  if (!response.ok) {
    const detail = typeof data.detail === 'string'
      ? data.detail
      : JSON.stringify(data.detail ?? data)
    throw new Error(detail || `HTTP ${response.status}`)
  }
  return data
}

function textFromNode(node) {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  if (!Array.isArray(node.content)) return ''
  return node.content.map(textFromNode).join('')
}

function paragraphTexts(docJson) {
  const paragraphs = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'paragraph' || node.type === 'heading') {
      paragraphs.push(textFromNode(node).trim())
      return
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child)
    }
  }
  visit(docJson)
  return paragraphs.filter(Boolean)
}

function buildContext(session) {
  const paragraphs = paragraphTexts(session.docJson)
  const previewParagraphs = paragraphs.slice(0, 20)
  const text = paragraphs.join('\n')
  return {
    documentSessionId: session.documentSessionId,
    paragraphCount: paragraphs.length,
    wordCount: Array.from(text.replace(/\s+/g, '')).length,
    pageCount: 1,
    preview: {
      paragraphs: previewParagraphs,
      omittedParagraphCount: Math.max(0, paragraphs.length - previewParagraphs.length),
    },
  }
}

function printEvent(event, jsonMode, state) {
  if (jsonMode) {
    console.log(JSON.stringify(event))
    return
  }
  if (event.type === 'tool_call') {
    const params = event.params ? ` ${JSON.stringify(event.params)}` : ''
    process.stdout.write(`\n→ ${event.name || 'tool'}${params}\n`)
  } else if (event.type === 'tool_result') {
    const result = event.result && typeof event.result === 'object' ? event.result : {}
    const ok = result.success === false ? '✗' : '✓'
    const message = result.message ? ` · ${result.message}` : ''
    process.stdout.write(`${ok} ${event.name || 'tool'}${message}\n`)
  } else if (event.type === 'content') {
    const chunk = String(event.content ?? '')
    state.assistantText += chunk
    process.stdout.write(chunk)
    state.hasContent = true
  } else if (event.type === 'done') {
    if (state.hasContent) process.stdout.write('\n')
    process.stdout.write(`done: ${event.reason || 'completed'}\n`)
  } else if (event.type === 'error') {
    process.stdout.write(`error: ${event.message || 'unknown error'}\n`)
  }
}

async function runStream(base, body, jsonMode) {
  const response = await fetch(`${base}/api/ai/react/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok || !response.body) {
    const data = await readJson(response)
    throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data))
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  const state = { hasContent: false, assistantText: '' }
  let buffer = ''
  let failed = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const event = JSON.parse(line.slice(6))
      printEvent(event, jsonMode, state)
      if (event.type === 'error') failed = true
    }
  }

  if (failed) {
    throw new Error('AI run failed')
  }
  return { assistantText: state.assistantText }
}

async function resolveSession(base, sessionId) {
  const session = sessionId
    ? await fetchJson(`${base}/api/doc-sessions/${encodeURIComponent(sessionId)}`)
    : await fetchJson(`${base}/api/doc-sessions/active`)
  const documentSessionId = String(session.documentSessionId || '')
  if (!documentSessionId) {
    throw new Error('后端未返回 documentSessionId')
  }
  return { session, documentSessionId }
}

async function readSession(base, documentSessionId) {
  return await fetchJson(`${base}/api/doc-sessions/${encodeURIComponent(documentSessionId)}`)
}

function buildRequestBody({ message, options, session, documentSessionId, history }) {
  const context = buildContext(session)
  return {
    message,
    mode: options.mode || 'agent',
    documentSessionId,
    context,
    history: history.slice(-20),
    ...(options.provider ? { providerId: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
  }
}

async function runCommand({ base, options, message, documentSessionId, history }) {
  const session = await readSession(base, documentSessionId)
  const body = buildRequestBody({ message, options, session, documentSessionId, history })
  const result = await runStream(base, body, options.json)
  history.push({ role: 'user', content: message })
  const assistantText = result.assistantText.trim()
  if (assistantText) {
    history.push({ role: 'assistant', content: assistantText })
  }
}

async function runChat({ base, options, initialMessage, documentSessionId }) {
  const history = []
  if (!options.json) {
    process.stdout.write(`documentSessionId: ${documentSessionId}\n`)
    process.stdout.write('进入对话模式。输入 /exit 退出，/session 查看当前文档会话。\n')
  }
  if (initialMessage) {
    if (!options.json) process.stdout.write(`\n你：${initialMessage}\nAI：`)
    await runCommand({ base, options, message: initialMessage, documentSessionId, history })
  }

  const rl = createInterface({ input, output })
  const handleLine = async (rawLine) => {
    const line = rawLine.trim()
    if (!line) return true
    if (line === '/exit' || line === '/quit') return false
    if (line === '/help') {
      process.stdout.write(usage())
      return true
    }
    if (line === '/session') {
      process.stdout.write(`${documentSessionId}\n`)
      return true
    }
    try {
      if (!options.json) process.stdout.write('AI：')
      await runCommand({ base, options, message: line, documentSessionId, history })
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
    return true
  }

  try {
    if (!input.isTTY) {
      for await (const line of rl) {
        const shouldContinue = await handleLine(line)
        if (!shouldContinue) break
      }
      return
    }

    while (true) {
      const shouldContinue = await handleLine(await rl.question('\n你> '))
      if (!shouldContinue) break
    }
  } finally {
    rl.close()
  }
}

async function main() {
  const { options, message } = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  const base = String(options.base || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const { documentSessionId } = await resolveSession(base, options.session)
  const chatMode = options.chat || !message
  if (chatMode) {
    await runChat({ base, options, initialMessage: message, documentSessionId })
    return
  }
  const history = []
  if (!options.json) {
    process.stdout.write(`documentSessionId: ${documentSessionId}\n`)
  }
  await runCommand({ base, options, message, documentSessionId, history })
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
