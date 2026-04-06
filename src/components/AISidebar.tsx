import { useState, useRef, useEffect, useCallback } from 'react'
import { EditorView } from 'prosemirror-view'
import { prepareWithSegments, layout, walkLineRanges } from '@chenglou/pretext'
import type { PreparedTextWithSegments } from '@chenglou/pretext'
import { executeTool } from '../ai/executor'

// ── Types ──────────────────────────────────────────────────────────────────

interface ToolCallResult {
  id?: string
  name: string
  params: Record<string, unknown>
  status: 'pending' | 'ok' | 'err'
}

interface Message {
  id: string
  role: 'user' | 'ai'
  text: string
  thinking: string
  isThinkingExpanded: boolean
  toolCalls: ToolCallResult[]
  streaming: boolean
  /** cached PreparedTextWithSegments — set once on finalization */
  prepared?: PreparedTextWithSegments
  /** tight bubble width in px; 0 = use CSS max-width (while streaming) */
  tightWidth: number
}

interface AskContinueState {
  visible: boolean
  rounds: number
  message: string
}

interface Props {
  view: EditorView | null
  onClose: () => void
}

const MAX_HISTORY = 20
const SIDEBAR_MIN = 280
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 320
const FONT = '14px -apple-system, BlinkMacSystemFont, sans-serif'
const LINE_HEIGHT = 20
const PADDING_H = 12   // horizontal padding inside bubble (each side)
const PADDING_V = 8    // vertical padding
const BUBBLE_MAX_RATIO = 0.85

// ── Pretext shrink-wrap ────────────────────────────────────────────────────

/**
 * Binary-search for the minimum wrap width that produces the same number of
 * lines as `maxWidth`, then return the max line width at that minimum width.
 * Mirrors findTightWrapMetrics from the pretext bubbles demo.
 */
function findTightBubbleWidth(prepared: PreparedTextWithSegments, maxWidth: number): number {
  if (maxWidth <= 0) return 0
  const targetLineCount = layout(prepared, maxWidth, LINE_HEIGHT).lineCount

  let lo = 1
  let hi = Math.ceil(maxWidth)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (layout(prepared, mid, LINE_HEIGHT).lineCount <= targetLineCount) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }

  let maxLineWidth = 0
  walkLineRanges(prepared, lo, line => { if (line.width > maxLineWidth) maxLineWidth = line.width })

  return Math.ceil(maxLineWidth) + PADDING_H * 2
}

/** Content width limit for a bubble given current sidebar width */
function bubbleContentMax(sidebarWidth: number): number {
  return Math.floor(sidebarWidth * BUBBLE_MAX_RATIO) - PADDING_H * 2
}

// ── Helpers ────────────────────────────────────────────────────────────────

let msgIdCounter = 0
function newId() { return `m${++msgIdCounter}` }

function mkMsg(role: 'user' | 'ai', text = ''): Message {
  return { id: newId(), role, text, thinking: '', isThinkingExpanded: false, toolCalls: [], streaming: false, tightWidth: 0 }
}

function fmtToolCall(tc: ToolCallResult): string {
  const short = Object.entries(tc.params).map(([k, v]) => {
    const vs = typeof v === 'string' ? v : JSON.stringify(v)
    return `${k}=${vs}`
  }).join(', ')
  return `${tc.name}(${short})`
}

// ── Component ──────────────────────────────────────────────────────────────

export default function AISidebar({ view, onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>(() => {
    const welcomeText = '你好！我是 AI 排版助手 🤖\n\n示例指令：\n• 帮我排成公文格式\n• 正文宋体小四号，首行缩进2字符\n• 插入3行4列表格\n• 标题居中加粗'
    const m = mkMsg('ai', welcomeText)
    try {
      const prepared = prepareWithSegments(welcomeText, FONT)
      m.prepared = prepared
      m.tightWidth = findTightBubbleWidth(prepared, bubbleContentMax(SIDEBAR_DEFAULT))
    } catch { /* canvas may not be ready; resize effect will pick it up */ }
    return [m]
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [askContinue, setAskContinue] = useState<AskContinueState>({ visible: false, rounds: 0, message: '' })

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const isDragging = useRef(false)

  // History for multi-turn context (user + ai text messages)
  const historyRef = useRef<Array<{ role: string; content: string }>>([])

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // ── Recompute tight widths on sidebar resize ──────────────────────────────
  useEffect(() => {
    const contentMax = bubbleContentMax(sidebarWidth)
    setMessages(prev => prev.map(m => {
      if (m.streaming || !m.prepared) return m
      const tw = findTightBubbleWidth(m.prepared, contentMax)
      return tw !== m.tightWidth ? { ...m, tightWidth: tw } : m
    }))
  }, [sidebarWidth])

  // ── Drag-resize handle ────────────────────────────────────────────────────
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    const handleMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - ev.clientX)))
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

  // ── Textarea auto-resize ──────────────────────────────────────────────────
  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  // ── Doc context ───────────────────────────────────────────────────────────
  function getContext() {
    if (!view) return {}
    let paragraphCount = 0, wordCount = 0
    view.state.doc.forEach(n => {
      if (n.type.name === 'paragraph') { paragraphCount++; wordCount += n.textContent.length }
    })
    return { paragraphCount, wordCount, pageCount: 1 }
  }

  // ── SSE send ──────────────────────────────────────────────────────────────
  async function handleSend(overrideText?: string) {
    const text = (overrideText ?? input).trim()
    if (!text || loading) return

    setAskContinue({ visible: false, rounds: 0, message: '' })
    setInput('')
    if (textareaRef.current) { textareaRef.current.style.height = 'auto' }

    const userMsg = mkMsg('user', text)
    // Pre-compute tight width for user bubble
    try {
      const prepared = prepareWithSegments(text, FONT)
      userMsg.prepared = prepared
      userMsg.tightWidth = findTightBubbleWidth(prepared, bubbleContentMax(sidebarWidth))
    } catch { /* fallback to CSS max-width */ }
    setMessages(prev => [...prev, userMsg].slice(-MAX_HISTORY))
    historyRef.current.push({ role: 'user', content: text })

    const aiMsg = mkMsg('ai')
    aiMsg.streaming = true
    setMessages(prev => [...prev, aiMsg].slice(-MAX_HISTORY))

    setLoading(true)
    abortRef.current = new AbortController()

    try {
      const res = await fetch('/api/ai/react/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          message: text,
          history: historyRef.current.slice(-20),
          context: getContext(),
        }),
      })

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      const updateMsg = (updater: (m: Message) => Message) => {
        setMessages(prev => prev.map(m => m.id === aiMsg.id ? updater(m) : m))
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event: Record<string, unknown>
          try { event = JSON.parse(line.slice(6)) } catch { continue }

          switch (event.type) {
            case 'thinking':
              updateMsg(m => ({ ...m, thinking: m.thinking + (event.content as string) }))
              break

            case 'content':
              updateMsg(m => ({ ...m, text: m.text + (event.content as string) }))
              break

            case 'tool_call': {
              const tc: ToolCallResult = {
                id: event.id as string | undefined,
                name: event.name as string,
                params: (event.params ?? {}) as Record<string, unknown>,
                status: 'pending',
              }
              // Execute tool on editor
              if (view) {
                try {
                  executeTool(view, tc.name, tc.params)
                  tc.status = 'ok'
                } catch (e) {
                  console.error('[AISidebar] tool error', tc.name, e)
                  tc.status = 'err'
                }
              }
              updateMsg(m => ({ ...m, toolCalls: [...m.toolCalls, tc] }))
              break
            }

            case 'done':
              updateMsg(m => {
                const contentMax = bubbleContentMax(sidebarWidth)
                try {
                  const prepared = prepareWithSegments(m.text || ' ', FONT)
                  const tw = findTightBubbleWidth(prepared, contentMax)
                  return { ...m, streaming: false, prepared, tightWidth: tw }
                } catch {
                  return { ...m, streaming: false }
                }
              })
              break

            case 'ask_continue':
              setAskContinue({
                visible: true,
                rounds: event.rounds as number,
                message: event.message as string,
              })
              updateMsg(m => {
                try {
                  const prepared = prepareWithSegments(m.text || ' ', FONT)
                  const tw = findTightBubbleWidth(prepared, bubbleContentMax(sidebarWidth))
                  return { ...m, streaming: false, prepared, tightWidth: tw }
                } catch {
                  return { ...m, streaming: false }
                }
              })
              break

            case 'error':
              updateMsg(m => ({
                ...m,
                text: m.text + `\n❌ ${event.message as string}`,
                streaming: false,
              }))
              break

            case 'round':
              // Could show round indicator; skip for now
              break
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setMessages(prev => prev.map(m => {
          if (m.id !== aiMsg.id) return m
          const finalText = m.text || '（已取消）'
          try {
            const prepared = prepareWithSegments(finalText, FONT)
            return { ...m, text: finalText, streaming: false, prepared, tightWidth: findTightBubbleWidth(prepared, bubbleContentMax(sidebarWidth)) }
          } catch { return { ...m, text: finalText, streaming: false } }
        }))
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        const errText = `❌ 请求失败：${msg}\n\n请确认后端服务已启动（端口 5174）并已配置 API Key。`
        setMessages(prev => prev.map(m => {
          if (m.id !== aiMsg.id) return m
          try {
            const prepared = prepareWithSegments(errText, FONT)
            return { ...m, text: errText, streaming: false, prepared, tightWidth: findTightBubbleWidth(prepared, bubbleContentMax(sidebarWidth)) }
          } catch { return { ...m, text: errText, streaming: false } }
        }))
      }
    } finally {
      setLoading(false)
      abortRef.current = null
      // Update history with AI response
      setMessages(prev => {
        const last = prev.find(m => m.id === aiMsg.id)
        if (last?.text) historyRef.current.push({ role: 'assistant', content: last.text })
        return prev
      })
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }

  function handleCancel() {
    abortRef.current?.abort()
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col bg-white border-l border-gray-200 shadow-lg relative flex-shrink-0"
      style={{ width: sidebarWidth }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="absolute left-0 top-0 bottom-0 w-1 hover:bg-blue-400 active:bg-blue-500 cursor-col-resize z-10 transition-colors"
        style={{ touchAction: 'none' }}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-blue-600 text-white flex-shrink-0 select-none">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm">🤖</span>
          <span className="font-semibold text-sm truncate">AI 排版助手</span>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-500 text-lg leading-none flex-shrink-0"
          title="关闭侧边栏"
        >×</button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'user' ? (
              <div
                className="bg-blue-500 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm"
                style={{
                  // tightWidth already includes PADDING_H*2; fall back to CSS max-width
                  width: m.tightWidth > 0 ? m.tightWidth : undefined,
                  maxWidth: m.tightWidth > 0 ? undefined : '85%',
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                  paddingTop: PADDING_V,
                  paddingBottom: PADDING_V,
                }}
              >
                {m.text}
              </div>
            ) : (
              <div className="max-w-[95%] space-y-1.5 min-w-0">
                {/* Thinking section */}
                {m.thinking && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden text-xs">
                    <button
                      className="w-full flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-left"
                      onClick={() => setMessages(prev => prev.map(msg =>
                        msg.id === m.id ? { ...msg, isThinkingExpanded: !msg.isThinkingExpanded } : msg
                      ))}
                    >
                      <span className="flex-shrink-0">{m.isThinkingExpanded ? '▼' : '▶'}</span>
                      <span>思考过程</span>
                      {m.streaming && m.thinking && (
                        <span className="ml-auto animate-pulse text-blue-400">思考中…</span>
                      )}
                    </button>
                    {m.isThinkingExpanded && (
                      <div
                        className="px-3 py-2 text-gray-600 bg-white border-t border-gray-100 max-h-48 overflow-y-auto"
                        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}
                      >
                        {m.thinking}
                      </div>
                    )}
                  </div>
                )}

                {/* AI text bubble */}
                {(m.text || m.streaming) && (
                  <div
                    className="bg-gray-100 text-gray-800 rounded-2xl rounded-tl-sm px-3 py-2 text-sm"
                    style={{
                      width: m.tightWidth > 0 ? m.tightWidth : undefined,
                      maxWidth: m.tightWidth > 0 ? undefined : '95%',
                      wordBreak: 'break-word',
                      whiteSpace: 'pre-wrap',
                      paddingTop: PADDING_V,
                      paddingBottom: PADDING_V,
                    }}
                  >
                    {m.text}
                    {m.streaming && (
                      <span
                        className="inline-block w-0.5 h-4 bg-gray-600 ml-0.5 align-middle"
                        style={{ animation: 'blink 1s step-end infinite' }}
                      />
                    )}
                  </div>
                )}

                {/* Tool calls */}
                {m.toolCalls.length > 0 && (
                  <div className="bg-gray-50 border border-gray-200 rounded-xl px-2.5 py-2 space-y-1">
                    {m.toolCalls.map((tc, j) => (
                      <div
                        key={j}
                        className={`flex items-start gap-1.5 text-xs font-mono ${tc.status === 'ok' ? 'text-green-700' : tc.status === 'err' ? 'text-red-600' : 'text-gray-400'}`}
                      >
                        <span className="flex-shrink-0">
                          {tc.status === 'ok' ? '✅' : tc.status === 'err' ? '❌' : '⏳'}
                        </span>
                        <span className="break-all">{fmtToolCall(tc)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Loading dots */}
        {loading && !messages.find(m => m.streaming) && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-3 py-2">
              <span className="inline-flex gap-1">
                {[0, 150, 300].map(d => (
                  <span key={d} className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
            </div>
          </div>
        )}

        {/* Ask-continue confirmation */}
        {askContinue.visible && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-3 py-2.5 space-y-2 text-sm">
            <p className="text-yellow-800 text-xs">{askContinue.message}</p>
            <div className="flex gap-2">
              <button
                onClick={() => { setAskContinue(s => ({ ...s, visible: false })); handleSend('继续执行刚才的操作') }}
                className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs rounded-lg"
              >✅ 继续执行</button>
              <button
                onClick={() => setAskContinue(s => ({ ...s, visible: false }))}
                className="px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs rounded-lg"
              >⏹ 停止</button>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 p-2 flex gap-1.5 items-end flex-shrink-0">
        <textarea
          ref={textareaRef}
          className="flex-1 text-sm border border-gray-300 rounded-xl px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          rows={1}
          placeholder="输入排版指令… (Enter 发送)"
          value={input}
          style={{ minHeight: 36, maxHeight: 200, resize: 'none', overflowY: 'auto' }}
          onChange={e => { setInput(e.target.value); autoResize(e.target) }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
          }}
          disabled={loading}
        />
        {loading ? (
          <button
            onClick={handleCancel}
            className="px-2.5 py-1.5 bg-red-400 hover:bg-red-500 text-white text-xs rounded-xl flex-shrink-0 whitespace-nowrap"
            title="取消"
          >⏹</button>
        ) : (
          <button
            onClick={() => handleSend()}
            disabled={!input.trim()}
            className="px-2.5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm rounded-xl flex-shrink-0 transition-colors"
            title="发送 (Enter)"
          >↵</button>
        )}
      </div>

      {/* Blinking cursor CSS */}
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  )
}
