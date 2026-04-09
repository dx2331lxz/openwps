import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { EditorView } from 'prosemirror-view'
import { marked } from 'marked'
import { prepareWithSegments, layout, walkLineRanges } from '@chenglou/pretext'
import type { PreparedTextWithSegments } from '@chenglou/pretext'
import { executeTool, type ExecuteResult } from '../ai/executor'
import type { PageConfig } from '../layout/paginator'

type View = 'history' | 'chat'

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface StoredMessage {
  role: 'user' | 'assistant' | 'tool'
  content?: string | null
  thinking?: string
  toolCalls?: ToolCallResult[]
  tool_calls?: Array<{ id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
}

interface ConversationDetail extends ConversationSummary {
  messages: StoredMessage[]
}

interface ToolCallResult {
  id?: string
  name: string
  params: Record<string, unknown>
  status: 'pending' | 'ok' | 'err'
  message?: string
}

interface Message {
  id: string
  role: 'user' | 'ai'
  text: string
  thinking: string
  isThinkingExpanded: boolean
  toolCalls: ToolCallResult[]
  streaming: boolean
  prepared?: PreparedTextWithSegments
  tightWidth: number
}

interface AskContinueState {
  visible: boolean
  rounds: number
  message: string
}

interface TodoItem {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

interface Props {
  view: EditorView | null
  pageConfig: PageConfig
  onPageConfigChange: (cfg: PageConfig) => void
  onDocumentStyleMutation?: () => void
  onClose: () => void
}

const SIDEBAR_MIN = 280
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 320
const FONT = '14px -apple-system, BlinkMacSystemFont, sans-serif'
const LINE_HEIGHT = 20
const PADDING_H = 12
const PADDING_V = 8
const BUBBLE_MAX_RATIO = 0.85
const TEXTAREA_MIN_HEIGHT = 72
const TEXTAREA_MAX_HEIGHT = 200
const MAX_TOOL_ROUNDS = 50

let msgIdCounter = 0

function newId() {
  msgIdCounter += 1
  return `m${msgIdCounter}`
}

function findTightBubbleWidth(prepared: PreparedTextWithSegments, maxWidth: number): number {
  if (maxWidth <= 0) return 0
  const targetLineCount = layout(prepared, maxWidth, LINE_HEIGHT).lineCount

  let lo = 1
  let hi = Math.ceil(maxWidth)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (layout(prepared, mid, LINE_HEIGHT).lineCount <= targetLineCount) hi = mid
    else lo = mid + 1
  }

  let maxLineWidth = 0
  walkLineRanges(prepared, lo, line => {
    if (line.width > maxLineWidth) maxLineWidth = line.width
  })
  return Math.ceil(maxLineWidth) + PADDING_H * 2
}

function bubbleContentMax(sidebarWidth: number): number {
  return Math.floor(sidebarWidth * BUBBLE_MAX_RATIO) - PADDING_H * 2
}

function truncateTitle(title: string, maxLength = 20) {
  return title.length > maxLength ? `${title.slice(0, maxLength)}...` : title
}

function formatConversationTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

  if (targetDay.getTime() === today.getTime()) return `今天${time}`
  if (targetDay.getTime() === yesterday.getTime()) return `昨天${time}`
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function fmtToolCall(tc: ToolCallResult): string {
  const short = Object.entries(tc.params)
    .map(([k, v]) => {
      const vs = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${vs}`
    })
    .join(', ')
  return `${tc.name}(${short})`
}

function toHtml(markdown: string) {
  const parsed = marked.parse(markdown)
  return typeof parsed === 'string' ? parsed : markdown
}

function normalizeToolParams(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function makeUserMessage(text: string, sidebarWidth: number): Message {
  const message: Message = {
    id: newId(),
    role: 'user',
    text,
    thinking: '',
    isThinkingExpanded: false,
    toolCalls: [],
    streaming: false,
    tightWidth: 0,
  }

  try {
    const prepared = prepareWithSegments(text || ' ', FONT)
    message.prepared = prepared
    message.tightWidth = findTightBubbleWidth(prepared, bubbleContentMax(sidebarWidth))
  } catch {
    // Canvas may be unavailable briefly; CSS max-width is the fallback.
  }

  return message
}

function makeAiMessage(text = '', streaming = false): Message {
  return {
    id: newId(),
    role: 'ai',
    text,
    thinking: '',
    isThinkingExpanded: false,
    toolCalls: [],
    streaming,
    tightWidth: 0,
  }
}

interface ToolCallRecord {
  id: string
  name: string
  params: Record<string, unknown>
  result: ExecuteResult
}

type ReactMessagePayload =
  | { role: 'user' | 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

function normalizeReactToolCalls(
  toolCalls: StoredMessage['tool_calls'] | ToolCallResult[] | undefined,
): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined

  if ('params' in toolCalls[0]) {
    return (toolCalls as ToolCallResult[]).map(tool => ({
      id: tool.id ?? tool.name,
      type: 'function',
      function: {
        name: tool.name,
        arguments: JSON.stringify(tool.params),
      },
    }))
  }

  return (toolCalls as NonNullable<StoredMessage['tool_calls']>)
    .map(call => {
      const name = call.function?.name
      if (!call.id || !name) return null
      return {
        id: call.id,
        type: 'function' as const,
        function: {
          name,
          arguments: String(call.function?.arguments ?? '{}'),
        },
      }
    })
    .filter((call): call is { id: string; type: 'function'; function: { name: string; arguments: string } } => Boolean(call))
}

function serializeToolResult(result: ExecuteResult) {
  return JSON.stringify({
    success: result.success,
    message: result.message,
    data: result.data ?? null,
  })
}

function normalizeStoredToolCalls(message: StoredMessage): ToolCallResult[] {
  if (Array.isArray(message.toolCalls)) {
    return message.toolCalls.map(toolCall => ({
      id: toolCall.id,
      name: toolCall.name,
      params: normalizeToolParams(toolCall.params),
      status: toolCall.status,
      message: toolCall.message,
    }))
  }

  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map(call => {
      let params: Record<string, unknown> = {}
      const rawArguments = call.function?.arguments
      if (typeof rawArguments === 'string') {
        try {
          params = normalizeToolParams(JSON.parse(rawArguments))
        } catch {
          params = {}
        }
      }
      return {
        id: call.id,
        name: String(call.function?.name ?? ''),
        params,
        status: 'pending' as const,
      }
    })
  }

  return []
}

function applyStoredToolResult(message: Message | undefined, stored: StoredMessage) {
  if (!message || message.role !== 'ai' || stored.role !== 'tool') return

  let parsed: { success?: boolean; message?: string } | null = null
  if (typeof stored.content === 'string') {
    try {
      parsed = JSON.parse(stored.content) as { success?: boolean; message?: string }
    } catch {
      parsed = null
    }
  }

  const nextStatus = parsed?.success === false ? 'err' : 'ok'
  const nextMessage = parsed?.message ?? (typeof stored.content === 'string' ? stored.content : '')
  const targetId = stored.tool_call_id
  let matched = false

  message.toolCalls = message.toolCalls.map((toolCall, index, array) => {
    const shouldUse =
      (!matched && targetId && toolCall.id === targetId) ||
      (!matched && !targetId && index === array.length - 1)
    if (!shouldUse) return toolCall
    matched = true
    return { ...toolCall, status: nextStatus, message: nextMessage }
  })
}

function fromStoredMessages(messages: StoredMessage[], sidebarWidth: number): Message[] {
  const restored: Message[] = []

  for (const stored of messages) {
    if (stored.role === 'user') {
      restored.push(makeUserMessage(stored.content ?? '', sidebarWidth))
      continue
    }

    if (stored.role === 'assistant') {
      const aiMessage = makeAiMessage(stored.content ?? '', false)
      aiMessage.thinking = stored.thinking ?? ''
      aiMessage.toolCalls = normalizeStoredToolCalls(stored)
      restored.push(aiMessage)
      continue
    }

    applyStoredToolResult(restored.at(-1), stored)
  }

  return restored
}

function buildReactMessages(messages: StoredMessage[], userText: string): ReactMessagePayload[] {
  const history = messages
    .map(message => {
      if (message.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: String(message.tool_call_id ?? ''),
          content: typeof message.content === 'string' ? message.content : '',
        }
      }

      if (message.role === 'assistant') {
        return {
          role: 'assistant' as const,
          content: typeof message.content === 'string' ? message.content : null,
          tool_calls: normalizeReactToolCalls(message.tool_calls ?? message.toolCalls),
        }
      }

      return {
        role: 'user' as const,
        content: typeof message.content === 'string' ? message.content : '',
      }
    })
    .slice(-40)

  return [...history, { role: 'user', content: userText }]
}

function buildErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return `❌ 请求失败：${message}\n\n请确认后端服务已启动（端口 5174）并已配置 API Key。`
}

function makeConversationTitle(text: string) {
  return text.trim().slice(0, 30) || '新会话'
}

export default function AISidebar({ view: editorView, pageConfig, onPageConfigChange, onDocumentStyleMutation, onClose }: Props) {
  const [viewMode, setViewMode] = useState<View>('history')
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [currentConversationTitle, setCurrentConversationTitle] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [askContinue, setAskContinue] = useState<AskContinueState>({ visible: false, rounds: 0, message: '' })
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(true)

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const isDragging = useRef(false)
  const currentConversationIdRef = useRef<string | null>(null)
  const conversationMessagesRef = useRef<StoredMessage[]>([])

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId
  }, [currentConversationId])

  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT)}px`
  }, [])

  const resetTextareaHeight = useCallback(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`
  }, [])

  const getContext = useCallback(() => {
    if (!editorView) return {}
    let paragraphCount = 0
    let wordCount = 0
    const paragraphs: Array<{index: number, text: string, charCount: number}> = []
    editorView.state.doc.forEach((node, _pos, _index) => {
      if (node.type.name === 'paragraph') {
        const text = node.textContent
        paragraphs.push({ index: paragraphCount, text: text.slice(0, 100), charCount: text.length })
        paragraphCount += 1
        wordCount += text.length
      }
    })
    return { paragraphCount, wordCount, pageCount: 1, paragraphs }
  }, [editorView])

  const loadConversations = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const response = await fetch('/api/conversations')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as ConversationSummary[]
      setConversations(data)
    } catch (error) {
      console.error('[AISidebar] load conversations failed', error)
      setConversations([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (viewMode !== 'chat') return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, askContinue, viewMode])

  useEffect(() => {
    setMessages(prev =>
      prev.map(message => {
        if (message.role !== 'user' || message.streaming || !message.prepared) return message
        const tightWidth = findTightBubbleWidth(message.prepared, bubbleContentMax(sidebarWidth))
        return tightWidth !== message.tightWidth ? { ...message, tightWidth } : message
      }),
    )
  }, [sidebarWidth])

  useEffect(() => {
    resetTextareaHeight()
    if (textareaRef.current) autoResize(textareaRef.current)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [viewMode, autoResize, resetTextareaHeight])

  const onDragStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    isDragging.current = true

    const handleMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - moveEvent.clientX)))
    }

    const handleUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [])

  const openConversation = useCallback(async (conversationId: string) => {
    if (loading) return
    setAskContinue({ visible: false, rounds: 0, message: '' })
    try {
      const response = await fetch(`/api/conversations/${conversationId}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as ConversationDetail
      setCurrentConversationId(data.id)
      setCurrentConversationTitle(data.title || '新会话')
      conversationMessagesRef.current = data.messages ?? []
      setMessages(fromStoredMessages(conversationMessagesRef.current, sidebarWidth))
      setViewMode('chat')
    } catch (error) {
      console.error('[AISidebar] open conversation failed', error)
    }
  }, [loading, sidebarWidth])

  const deleteConversation = useCallback(async (conversationId: string) => {
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setConversations(prev => prev.filter(conversation => conversation.id !== conversationId))
      if (currentConversationIdRef.current === conversationId) {
        setCurrentConversationId(null)
        setCurrentConversationTitle('')
        conversationMessagesRef.current = []
        setMessages([])
        setAskContinue({ visible: false, rounds: 0, message: '' })
      }
    } catch (error) {
      console.error('[AISidebar] delete conversation failed', error)
    }
  }, [])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    if (!text || loading) return

    const shouldStartNewConversation = viewMode === 'history'
    const nextTitle = makeConversationTitle(text)
    const previousConversationMessages = shouldStartNewConversation ? [] : conversationMessagesRef.current
    const userMessage = makeUserMessage(text, sidebarWidth)
    const aiMessage = makeAiMessage('', true)

    setAskContinue({ visible: false, rounds: 0, message: '' })
    setTodos([])
    setIsTodoPanelExpanded(true)
    setInput('')
    resetTextareaHeight()

    if (shouldStartNewConversation) {
      setCurrentConversationId(null)
      setCurrentConversationTitle(nextTitle)
      conversationMessagesRef.current = []
      setMessages([userMessage, aiMessage])
      setViewMode('chat')
    } else {
      setMessages(prev => [...prev, userMessage, aiMessage])
    }

    setLoading(true)
    const controller = new AbortController()
    abortRef.current = controller

    const updateMessage = (updater: (message: Message) => Message) => {
      setMessages(prev => prev.map(message => (message.id === aiMessage.id ? updater(message) : message)))
    }

    let conversationId = shouldStartNewConversation ? null : currentConversationIdRef.current
    const context = getContext()
    let persistedAssistantText = ''
    let conversationPersisted = false
    const persistedRecords: StoredMessage[] = [{ role: 'user', content: text }]

    const appendAssistantRound = (
      assistantText: string,
      thinkingText: string,
      toolResults: ToolCallRecord[],
    ) => {
      if (!assistantText && !thinkingText && toolResults.length === 0) return
      persistedRecords.push({
        role: 'assistant',
        content: assistantText || null,
        thinking: thinkingText || undefined,
        tool_calls: toolResults.length > 0
          ? toolResults.map(tool => ({
              id: tool.id,
              type: 'function' as const,
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.params),
              },
            }))
          : undefined,
        toolCalls: toolResults.length > 0
          ? toolResults.map(tool => ({
              id: tool.id,
              name: tool.name,
              params: tool.params,
              status: tool.result.success ? 'ok' : 'err',
              message: tool.result.message,
            }))
          : undefined,
      })
    }

    try {
      if (!conversationId) {
        const createResponse = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle }),
        })
        if (!createResponse.ok) throw new Error(`HTTP ${createResponse.status}`)
        const created = (await createResponse.json()) as { id: string }
        conversationId = created.id
        currentConversationIdRef.current = created.id
        setCurrentConversationId(created.id)
        setCurrentConversationTitle(nextTitle)
        void loadConversations()
      }

      let reactMessages = buildReactMessages(previousConversationMessages, text)
      let finished = false

      for (let round = 1; round <= MAX_TOOL_ROUNDS && !finished; round += 1) {
        const response = await fetch('/api/ai/react/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            message: text,
            history: previousConversationMessages.filter(message => message.role !== 'tool').slice(-20),
            context,
            conversationId,
            reactMessages,
          }),
        })

        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let awaitingToolResults = false
        let roundAssistantText = ''
        let roundThinkingText = ''
        const toolResults: ToolCallRecord[] = []

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            let event: Record<string, unknown>
            try {
              event = JSON.parse(line.slice(6)) as Record<string, unknown>
            } catch {
              continue
            }

            switch (event.type) {
              case 'thinking':
                roundThinkingText += String(event.content ?? '')
                updateMessage(message => ({ ...message, thinking: message.thinking + String(event.content ?? '') }))
                break

              case 'content': {
                const chunk = String(event.content ?? '')
                roundAssistantText += chunk
                persistedAssistantText += chunk
                updateMessage(message => ({ ...message, text: message.text + chunk }))
                break
              }

              case 'tool_call': {
                const toolCall: ToolCallResult = {
                  id: typeof event.id === 'string' ? event.id : undefined,
                  name: String(event.name ?? ''),
                  params: normalizeToolParams(event.params),
                  status: 'pending',
                }

                // Intercept update_todo_list: update UI state locally instead of running on editor
                let result: { success: boolean; message: string; data?: unknown }
                if (toolCall.name === 'update_todo_list') {
                  const rawTodos = Array.isArray(toolCall.params.todos) ? toolCall.params.todos : []
                  const nextTodos: TodoItem[] = rawTodos
                    .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
                    .map(t => ({
                      id: String(t.id ?? ''),
                      title: String(t.title ?? ''),
                      status: (['pending', 'in_progress', 'completed', 'failed'].includes(String(t.status))
                        ? t.status
                        : 'pending') as TodoItem['status'],
                    }))
                  setTodos(nextTodos)
                  const hasActive = nextTodos.some(t => t.status !== 'completed' && t.status !== 'failed')
                  setIsTodoPanelExpanded(hasActive)
                  result = { success: true, message: 'todo list updated' }
                } else {
                  result = editorView
                    ? executeTool(editorView, toolCall.name, toolCall.params, { pageConfig, onPageConfigChange, onDocumentStyleMutation })
                    : { success: false, message: '编辑器尚未就绪' }
                }

                toolCall.status = result.success ? 'ok' : 'err'
                toolCall.message = result.message
                toolResults.push({
                  id: toolCall.id ?? toolCall.name,
                  name: toolCall.name,
                  params: toolCall.params,
                  result,
                })
                if (!result.success) {
                  console.error('[AISidebar] tool call failed', toolCall.name, toolCall.params, result.message)
                }
                updateMessage(message => ({ ...message, toolCalls: [...message.toolCalls, toolCall] }))
                break
              }

              case 'awaiting_tool_results':
                awaitingToolResults = true
                break

              case 'done':
                finished = true
                updateMessage(message => ({ ...message, streaming: false }))
                break

              case 'error':
                throw new Error(String(event.message ?? 'AI 请求失败'))

              case 'ask_continue':
              case 'round':
                break
            }
          }
        }

        if (finished) {
          appendAssistantRound(roundAssistantText, roundThinkingText, toolResults)
          break
        }
        if (!awaitingToolResults || toolResults.length === 0) {
          appendAssistantRound(roundAssistantText, roundThinkingText, toolResults)
          updateMessage(message => ({ ...message, streaming: false }))
          finished = true
          break
        }

        appendAssistantRound(roundAssistantText, roundThinkingText, toolResults)
        persistedRecords.push(
          ...toolResults.map(tool => ({
            role: 'tool' as const,
            tool_call_id: tool.id,
            content: serializeToolResult(tool.result),
          })),
        )

        reactMessages = [
          ...reactMessages,
          {
            role: 'assistant',
            content: roundAssistantText || null,
            tool_calls: toolResults.map(tool => ({
                id: tool.id,
                type: 'function',
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.params),
                },
              })),
          },
          ...toolResults.map(tool => ({
            role: 'tool' as const,
            tool_call_id: tool.id,
            content: serializeToolResult(tool.result),
          })),
        ]

        if (round === MAX_TOOL_ROUNDS) {
          setAskContinue({
            visible: true,
            rounds: round,
            message: `已执行 ${round} 轮操作，请重新发起下一步指令。`,
          })
          updateMessage(message => ({ ...message, streaming: false }))
        }
      }

      if (conversationId) {
        await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: persistedRecords,
          }),
        })
        conversationPersisted = true
        conversationMessagesRef.current = [...previousConversationMessages, ...persistedRecords]
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        persistedAssistantText = '（已取消）'
        if (!persistedRecords.some(message => message.role === 'assistant')) {
          persistedRecords.push({ role: 'assistant', content: persistedAssistantText })
        }
        setMessages(prev =>
          prev.map(message =>
            message.id === aiMessage.id
              ? { ...message, text: message.text || '（已取消）', streaming: false }
              : message,
          ),
        )
      } else {
        const errorText = buildErrorText(error)
        persistedAssistantText = errorText
        if (!persistedRecords.some(message => message.role === 'assistant')) {
          persistedRecords.push({ role: 'assistant', content: errorText })
        }
        setMessages(prev =>
          prev.map(message =>
            message.id === aiMessage.id
              ? { ...message, text: errorText, streaming: false }
              : message,
          ),
        )
      }

      if (conversationId && !conversationPersisted) {
        try {
          await fetch(`/api/conversations/${conversationId}/messages`, {
            method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              messages: persistedRecords,
            }),
          })
          conversationMessagesRef.current = [...previousConversationMessages, ...persistedRecords]
        } catch (persistError) {
          console.error('[AISidebar] persist conversation failed', persistError)
        }
      }
    } finally {
      setLoading(false)
      abortRef.current = null
      void loadConversations()
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [editorView, getContext, input, loadConversations, loading, onDocumentStyleMutation, onPageConfigChange, pageConfig, resetTextareaHeight, sidebarWidth, viewMode])

  const historyEmpty = !historyLoading && conversations.length === 0

  return (
    <div
      className="relative flex flex-col flex-shrink-0 bg-white border-l border-gray-200 shadow-lg"
      style={{ width: sidebarWidth }}
    >
      <div
        onMouseDown={onDragStart}
        className="absolute left-0 top-0 bottom-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-blue-400 active:bg-blue-500"
        style={{ touchAction: 'none' }}
      />

      {viewMode === 'history' ? (
        <div className="flex items-center justify-between px-3 py-2.5 bg-blue-600 text-white flex-shrink-0 select-none">
          <div className="min-w-0">
            <span className="font-semibold text-sm truncate">🤖 AI 排版助手</span>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-500 text-lg leading-none flex-shrink-0"
            title="关闭侧边栏"
          >
            ×
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-600 text-white flex-shrink-0 select-none">
          <button
            onClick={() => {
              setViewMode('history')
              setAskContinue({ visible: false, rounds: 0, message: '' })
            }}
            className="px-1.5 py-0.5 rounded hover:bg-blue-500 text-sm flex-shrink-0"
            title="返回会话历史"
          >
            ←
          </button>
          <div className="min-w-0 flex-1 font-semibold text-sm truncate">{currentConversationTitle || '新会话'}</div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-500 text-lg leading-none flex-shrink-0"
            title="关闭侧边栏"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {viewMode === 'history' ? (
          historyEmpty ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-400">
              暂无会话，输入指令开始
            </div>
          ) : (
            <div className="space-y-2">
              {historyLoading && conversations.length === 0 && (
                <div className="text-sm text-gray-400 text-center py-8">加载中...</div>
              )}
              {conversations.map(conversation => (
                <div
                  key={conversation.id}
                  className="group w-full flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => void openConversation(conversation.id)}
                    className="min-w-0 flex-1"
                  >
                    <div className="text-sm text-gray-800 truncate">{truncateTitle(conversation.title || '新会话')}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{formatConversationTime(conversation.updatedAt || conversation.createdAt)}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteConversation(conversation.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-red-500 text-sm flex-shrink-0"
                    title="删除会话"
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-3">
            {messages.length === 0 && (
              <div className="text-sm text-gray-400 text-center py-8">开始一段新的排版对话</div>
            )}

            {/* Todo Panel */}
            {todos.length > 0 && (
              <div className="border border-blue-200 rounded-xl overflow-hidden bg-blue-50 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setIsTodoPanelExpanded(prev => !prev)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-blue-100 hover:bg-blue-200 transition-colors text-left select-none"
                >
                  <span className="text-xs font-semibold text-blue-700 tracking-wide">📋 任务计划</span>
                  <span className="text-xs text-blue-500 flex items-center gap-1.5">
                    <span>
                      {todos.filter(t => t.status === 'completed').length}/{todos.length}
                    </span>
                    <span>{isTodoPanelExpanded ? '▲' : '▼'}</span>
                  </span>
                </button>
                {isTodoPanelExpanded && (
                  <ul className="px-3 py-2 space-y-1.5">
                    {todos.map(todo => (
                      <li key={todo.id} className="flex items-start gap-2 text-xs">
                        <span className="flex-shrink-0 mt-px">
                          {todo.status === 'completed' ? '✅' :
                           todo.status === 'in_progress' ? '🔄' :
                           todo.status === 'failed' ? '❌' :
                           '⬜'}
                        </span>
                        <span
                          className={
                            todo.status === 'completed'
                              ? 'text-gray-400 line-through'
                              : todo.status === 'in_progress'
                                ? 'text-blue-700 font-medium'
                                : todo.status === 'failed'
                                  ? 'text-red-500'
                                  : 'text-gray-600'
                          }
                        >
                          {todo.title}
                          {todo.status === 'in_progress' && (
                            <span
                              className="ml-1.5 inline-block text-blue-400"
                              style={{ animation: 'blink 1.2s step-end infinite' }}
                            >
                              …
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/* End Todo Panel */}

            {messages.map(message => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {message.role === 'user' ? (
                  <div
                    className="bg-blue-500 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm"
                    style={{
                      width: message.tightWidth > 0 ? message.tightWidth : undefined,
                      maxWidth: message.tightWidth > 0 ? undefined : '85%',
                      wordBreak: 'break-word',
                      whiteSpace: 'pre-wrap',
                      paddingTop: PADDING_V,
                      paddingBottom: PADDING_V,
                    }}
                  >
                    {message.text}
                  </div>
                ) : (
                  <div className="w-full min-w-0 space-y-1.5">
                    {message.thinking && (
                      <div className="border border-gray-200 rounded-lg overflow-hidden text-xs">
                        <button
                          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-left"
                          onClick={() => {
                            setMessages(prev =>
                              prev.map(item =>
                                item.id === message.id
                                  ? { ...item, isThinkingExpanded: !item.isThinkingExpanded }
                                  : item,
                              ),
                            )
                          }}
                        >
                          <span className="flex-shrink-0">{message.isThinkingExpanded ? '▼' : '▶'}</span>
                          <span>思考过程</span>
                          {message.streaming && (
                            <span className="ml-auto animate-pulse text-blue-400">思考中…</span>
                          )}
                        </button>
                        {message.isThinkingExpanded && (
                          <div
                            className="px-3 py-2 text-gray-600 bg-white border-t border-gray-100 max-h-48 overflow-y-auto"
                            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}
                          >
                            {message.thinking}
                          </div>
                        )}
                      </div>
                    )}

                    {(message.text || message.streaming) && (
                      message.streaming ? (
                        <div
                          className="w-full text-sm text-gray-800 leading-6"
                          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                        >
                          {message.text}
                          <span
                            className="inline-block w-0.5 h-4 bg-gray-600 ml-0.5 align-middle"
                            style={{ animation: 'blink 1s step-end infinite' }}
                          />
                        </div>
                      ) : (
                        <div
                          className="ai-markdown w-full text-sm text-gray-800 leading-6"
                          dangerouslySetInnerHTML={{ __html: toHtml(message.text) }}
                        />
                      )
                    )}

                    {message.toolCalls.filter(tc => tc.name !== 'update_todo_list').length > 0 && (
                      <div className="bg-gray-50 border border-gray-200 rounded-xl px-2.5 py-2 space-y-1">
                        {message.toolCalls.filter(tc => tc.name !== 'update_todo_list').map((toolCall, index) => (
                          <div
                            key={`${toolCall.id ?? toolCall.name}-${index}`}
                            className={`text-xs font-mono ${
                              toolCall.status === 'ok'
                                ? 'text-green-700'
                                : toolCall.status === 'err'
                                  ? 'text-red-600'
                                  : 'text-gray-400'
                            }`}
                          >
                            <div className="flex items-start gap-1.5">
                              <span className="flex-shrink-0">
                                {toolCall.status === 'ok' ? '✅' : toolCall.status === 'err' ? '❌' : '⏳'}
                              </span>
                              <span className="break-all">{fmtToolCall(toolCall)}</span>
                            </div>
                            {toolCall.message && (
                              <div className="pl-5 mt-0.5 break-all opacity-80">{toolCall.message}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {loading && !messages.find(message => message.streaming) && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-tl-sm px-3 py-2 bg-gray-100">
                  <span className="inline-flex gap-1">
                    {[0, 150, 300].map(delay => (
                      <span
                        key={delay}
                        className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                        style={{ animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </span>
                </div>
              </div>
            )}

            {askContinue.visible && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-3 py-2.5 space-y-2 text-sm">
                <p className="text-yellow-800 text-xs">{askContinue.message}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setAskContinue(state => ({ ...state, visible: false }))
                      void handleSend('继续执行刚才的操作')
                    }}
                    className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs rounded-lg"
                  >
                    ✅ 继续执行
                  </button>
                  <button
                    onClick={() => setAskContinue(state => ({ ...state, visible: false }))}
                    className="px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs rounded-lg"
                  >
                    ⏹ 停止
                  </button>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 p-2 flex gap-1.5 items-end flex-shrink-0">
        <textarea
          ref={textareaRef}
          className="flex-1 text-sm border border-gray-300 rounded-xl px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          rows={3}
          placeholder={viewMode === 'history' ? '输入排版指令，自动新建会话…' : '继续输入排版指令…'}
          value={input}
          style={{ minHeight: '72px', maxHeight: '200px', resize: 'none', overflowY: 'auto' }}
          onChange={event => {
            setInput(event.target.value)
            autoResize(event.target)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleSend()
            }
          }}
          disabled={loading}
        />
        {loading ? (
          <button
            onClick={handleCancel}
            className="px-2.5 py-1.5 bg-red-400 hover:bg-red-500 text-white text-xs rounded-xl flex-shrink-0 whitespace-nowrap"
            title="取消"
          >
            ⏹
          </button>
        ) : (
          <button
            onClick={() => void handleSend()}
            disabled={!input.trim()}
            className="px-2.5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm rounded-xl flex-shrink-0 transition-colors"
            title="发送 (Enter)"
          >
            ↵
          </button>
        )}
      </div>

      <style>{'@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }'}</style>
    </div>
  )
}
