import { useState, useRef, useEffect } from 'react'
import { EditorView } from 'prosemirror-view'
import { executeTool } from '../ai/executor'

interface ToolCallResult {
  name: string
  params: Record<string, unknown>
  status: 'ok' | 'err'
}

interface Message {
  role: 'user' | 'ai'
  text: string
  toolCalls?: ToolCallResult[]
}

interface Props {
  view: EditorView | null
  onClose: () => void
}

const MAX_HISTORY = 20

function formatToolCall(tc: ToolCallResult): string {
  const paramStr = Object.entries(tc.params)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ')
  return `${tc.name}(${paramStr})`
}

export default function AISidebar({ view, onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'ai',
      text: '你好！我是 AI 排版助手。\n\n请输入排版指令，例如：\n• 帮我排成公文格式\n• 标题居中，正文首行缩进2字符\n• 插入3行4列表格',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  function getDocContext() {
    if (!view) return {}
    let paragraphCount = 0
    let wordCount = 0
    view.state.doc.forEach(node => {
      if (node.type.name === 'paragraph') {
        paragraphCount++
        wordCount += node.textContent.length
      }
    })
    return { paragraphCount, wordCount, pageCount: 1 }
  }

  async function handleSend() {
    const msg = input.trim()
    if (!msg || loading) return

    setInput('')
    const userMsg: Message = { role: 'user', text: msg }
    setMessages(prev => {
      const updated = [...prev, userMsg]
      return updated.slice(-MAX_HISTORY)
    })
    setLoading(true)

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, context: getDocContext() }),
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      const data = await res.json() as {
        reply: string
        toolCalls?: Array<{ name: string; params: Record<string, unknown> }>
      }

      const executed: ToolCallResult[] = []
      if (view && data.toolCalls) {
        for (const tc of data.toolCalls) {
          try {
            executeTool(view, tc.name, tc.params)
            executed.push({ name: tc.name, params: tc.params, status: 'ok' })
          } catch (e) {
            console.error('[AISidebar] tool error', tc.name, e)
            executed.push({ name: tc.name, params: tc.params, status: 'err' })
          }
        }
      }

      const aiMsg: Message = {
        role: 'ai',
        text: data.reply ?? '完成。',
        toolCalls: executed.length > 0 ? executed : undefined,
      }
      setMessages(prev => [...prev, aiMsg].slice(-MAX_HISTORY))
    } catch (e) {
      const errMsg: Message = {
        role: 'ai',
        text: `❌ 请求失败：${e instanceof Error ? e.message : String(e)}\n\n请确认后端服务已启动（python backend，端口 5174）并已在设置中配置 API Key。`,
      }
      setMessages(prev => [...prev, errMsg].slice(-MAX_HISTORY))
    } finally {
      setLoading(false)
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }

  return (
    <div
      className="flex flex-col bg-white border-l border-gray-200 shadow-lg"
      style={{ width: 320, minWidth: 280, flexShrink: 0 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-blue-600 text-white flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-base">🤖</span>
          <span className="font-semibold text-sm">AI 排版助手</span>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-500 text-white text-lg leading-none"
          title="关闭"
        >
          ×
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'user' ? (
              <div
                className="bg-blue-500 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm max-w-[85%]"
                style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
              >
                {m.text}
              </div>
            ) : (
              <div className="max-w-[95%] space-y-1.5">
                <div
                  className="bg-gray-100 text-gray-800 rounded-2xl rounded-tl-sm px-3 py-2 text-sm"
                  style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
                >
                  {m.text}
                </div>
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-2 space-y-1">
                    {m.toolCalls.map((tc, j) => (
                      <div
                        key={j}
                        className={`flex items-start gap-1.5 text-xs font-mono ${
                          tc.status === 'ok' ? 'text-green-700' : 'text-red-600'
                        }`}
                      >
                        <span className="flex-shrink-0">{tc.status === 'ok' ? '✅' : '❌'}</span>
                        <span className="break-all">{formatToolCall(tc)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-500 rounded-2xl rounded-tl-sm px-3 py-2 text-sm">
              <span className="inline-flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: '0ms' }}>●</span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }}>●</span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }}>●</span>
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 p-2 flex gap-1.5 flex-shrink-0">
        <textarea
          ref={textareaRef}
          className="flex-1 text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          rows={2}
          placeholder="输入排版指令… (Enter 发送，Shift+Enter 换行)"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          disabled={loading}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="px-2.5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors flex-shrink-0"
          title="发送 (Enter)"
        >
          ↵
        </button>
      </div>
    </div>
  )
}
