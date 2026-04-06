import { useState, useRef, useEffect } from 'react'
import { EditorView } from 'prosemirror-view'
import { executeTool } from '../ai/executor'

interface Message {
  role: 'user' | 'ai'
  text: string
  toolCalls?: Array<{ name: string; status: 'ok' | 'err' }>
}

interface Props {
  view: EditorView | null
  onClose: () => void
}

export default function AISidebar({ view, onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'ai', text: '你好！我是 AI 排版助手。\n\n请输入排版指令，例如：\n• 帮我排成公文格式\n• 标题居中，正文首行缩进2字符\n• 插入3行4列表格' },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
    setMessages(prev => [...prev, { role: 'user', text: msg }])
    setLoading(true)

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, context: getDocContext() }),
      })
      const data = await res.json() as { reply: string; toolCalls: Array<{ name: string; params: Record<string, unknown> }> }

      const executed: Array<{ name: string; status: 'ok' | 'err' }> = []
      if (view) {
        for (const tc of data.toolCalls ?? []) {
          try {
            executeTool(view, tc.name, tc.params)
            executed.push({ name: tc.name, status: 'ok' })
          } catch {
            executed.push({ name: tc.name, status: 'err' })
          }
        }
      }

      setMessages(prev => [
        ...prev,
        { role: 'ai', text: data.reply ?? '完成。', toolCalls: executed },
      ])
    } catch {
      setMessages(prev => [
        ...prev,
        { role: 'ai', text: '❌ 网络错误，请检查后端服务是否启动（npm run server）。' },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200" style={{ width: 300, minWidth: 260, maxWidth: 400 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-blue-600 text-white">
        <span className="font-medium text-sm">🤖 AI 排版助手</span>
        <button onClick={onClose} className="text-white hover:text-blue-200 text-lg leading-none">×</button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-sm">
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <div className="bg-blue-500 text-white rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap">{m.text}</div>
            ) : (
              <div className="bg-gray-100 rounded-lg px-3 py-2 max-w-[95%]">
                <div className="whitespace-pre-wrap text-gray-800">{m.text}</div>
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="mt-2 space-y-1 text-xs">
                    {m.toolCalls.map((tc, j) => (
                      <div key={j} className={tc.status === 'ok' ? 'text-green-600' : 'text-red-500'}>
                        {tc.status === 'ok' ? '✅' : '❌'} {tc.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="bg-gray-100 rounded-lg px-3 py-2 text-gray-500 text-sm">
            <span className="animate-pulse">AI 正在思考...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 p-2 flex gap-1">
        <textarea
          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
          rows={2}
          placeholder="输入排版指令…"
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
          className="px-2 py-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white text-sm rounded"
        >
          ↵
        </button>
      </div>
    </div>
  )
}
