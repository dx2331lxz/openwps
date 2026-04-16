import React, { useEffect, useRef, useState } from 'react'

export interface CommentData {
  id: string
  author: string
  date: string
  content: string
  /** DOM rect of the annotated text span, used to position the popover */
  anchorRect: DOMRect
}

interface Reply {
  id: string
  author: string
  date: string
  content: string
}

interface CommentPopoverProps {
  comment: CommentData
  onDelete: (id: string) => void
  onResolve: (id: string) => void
  onClose: () => void
}

function formatDate(raw: string) {
  if (!raw) return ''
  try {
    const d = new Date(raw)
    if (isNaN(d.getTime())) return raw
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return raw
  }
}

const AVATAR_COLORS = ['#e53935', '#8e24aa', '#1e88e5', '#43a047', '#fb8c00', '#6d4c41']
function avatarColor(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export const CommentPopover: React.FC<CommentPopoverProps> = ({
  comment,
  onDelete,
  onResolve,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [replyMode, setReplyMode] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [replies, setReplies] = useState<Reply[]>([])

  // Position: right of click point, vertically aligned to it
  // anchorRect is a zero-size rect at the click coordinates
  const viewportWidth = window.innerWidth
  const popoverWidth = 280
  const margin = 12
  const leftIfRight = comment.anchorRect.left + margin
  const leftIfLeft = comment.anchorRect.left - popoverWidth - margin
  const left = leftIfRight + popoverWidth + margin < viewportWidth
    ? leftIfRight
    : leftIfLeft

  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.max(8, Math.min(comment.anchorRect.top - 8, window.innerHeight - 400)),
    left: Math.max(8, left),
    zIndex: 9999,
    width: popoverWidth,
    background: 'white',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
    overflow: 'visible',
  }

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const handleReplySubmit = () => {
    const text = replyText.trim()
    if (!text) return
    setReplies(prev => [...prev, {
      id: String(Date.now()),
      author: '我',
      date: new Date().toISOString(),
      content: text,
    }])
    setReplyText('')
    setReplyMode(false)
  }

  const color = avatarColor(comment.author || '?')
  const initial = (comment.author || '?')[0]?.toUpperCase() ?? '?'

  return (
    <div ref={ref} style={style} onMouseDown={e => e.stopPropagation()}>
      {/* Red left border accent */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: '#ef4444', borderRadius: '8px 0 0 8px' }} />

      {/* Main comment */}
      <div style={{ padding: '12px 12px 12px 16px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          {/* Avatar */}
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: color, color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 600, flexShrink: 0,
          }}>
            {initial}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#ef4444' }}>{comment.author || '未知用户'}</div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>{formatDate(comment.date)}</div>
          </div>
          {/* Menu button */}
          <div style={{ position: 'relative' }}>
            <button
              onMouseDown={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
              style={{
                width: 24, height: 24, border: 'none', background: 'transparent',
                cursor: 'pointer', borderRadius: 4, display: 'flex', alignItems: 'center',
                justifyContent: 'center', color: '#9ca3af', fontSize: 16,
              }}
              title="更多操作"
            >
              ≡
            </button>
            {menuOpen && (
              <div
                onMouseDown={e => e.stopPropagation()}
                style={{
                  position: 'absolute', right: 0, top: '100%', zIndex: 10000,
                  background: 'white', border: '1px solid #e5e7eb', borderRadius: 8,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)', minWidth: 96, overflow: 'hidden',
                }}
              >
                {[
                  { icon: '💬', label: '答复', action: () => { setReplyMode(true); setMenuOpen(false) } },
                  { icon: '✅', label: '解决', action: () => { setMenuOpen(false); onResolve(comment.id) }, color: '#16a34a' },
                  { icon: '🗑', label: '删除', action: () => { setMenuOpen(false); onDelete(comment.id) }, color: '#dc2626' },
                ].map(item => (
                  <button
                    key={item.label}
                    onMouseDown={e => { e.preventDefault(); item.action() }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 14px', border: 'none', background: 'transparent',
                      cursor: 'pointer', fontSize: 13, color: item.color ?? '#374151',
                      textAlign: 'left',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{ fontSize: 14 }}>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Comment content */}
        <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, paddingLeft: 40 }}>
          {comment.content || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>（无内容）</span>}
        </div>
      </div>

      {/* Replies */}
      {replies.length > 0 && (
        <div style={{ borderTop: '1px solid #f3f4f6' }}>
          {replies.map(r => (
            <div key={r.id} style={{ padding: '10px 12px 10px 16px', borderBottom: '1px solid #f9fafb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: avatarColor(r.author), color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 600, flexShrink: 0,
                }}>
                  {r.author[0]?.toUpperCase()}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{r.author}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>{formatDate(r.date)}</div>
              </div>
              <div style={{ fontSize: 13, color: '#374151', paddingLeft: 32 }}>{r.content}</div>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons row */}
      <div style={{ display: 'flex', borderTop: '1px solid #f3f4f6', padding: '6px 8px', gap: 4 }}>
        {[
          { icon: '💬', label: '答复', action: () => setReplyMode(r => !r) },
          { icon: '✅', label: '解决', action: () => onResolve(comment.id), color: '#16a34a' },
          { icon: '🗑', label: '删除', action: () => onDelete(comment.id), color: '#dc2626' },
        ].map(item => (
          <button
            key={item.label}
            onMouseDown={e => { e.preventDefault(); item.action() }}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 4, padding: '4px 6px', border: 'none',
              background: 'transparent', cursor: 'pointer', borderRadius: 4,
              fontSize: 12, color: item.color ?? '#6b7280',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title={item.label}
          >
            <span style={{ fontSize: 13 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      {/* Reply input */}
      {replyMode && (
        <div style={{ borderTop: '1px solid #f3f4f6', padding: '8px 12px 10px' }}>
          <textarea
            autoFocus
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            placeholder="输入答复…"
            rows={2}
            style={{
              width: '100%', resize: 'none', border: '1px solid #d1d5db',
              borderRadius: 6, padding: '6px 8px', fontSize: 13,
              boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleReplySubmit()
              if (e.key === 'Escape') { setReplyMode(false); setReplyText('') }
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
            <button
              onMouseDown={e => { e.preventDefault(); setReplyMode(false); setReplyText('') }}
              style={{ padding: '3px 10px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer', background: 'white', color: '#374151' }}
            >取消</button>
            <button
              onMouseDown={e => { e.preventDefault(); handleReplySubmit() }}
              style={{ padding: '3px 10px', fontSize: 12, border: 'none', borderRadius: 4, cursor: 'pointer', background: '#2563eb', color: 'white' }}
            >提交</button>
          </div>
        </div>
      )}
    </div>
  )
}
