import React, { useEffect, useRef, useState } from 'react'

interface AddCommentDialogProps {
  anchorRect: DOMRect
  onConfirm: (content: string) => void
  onCancel: () => void
}

export const AddCommentDialog: React.FC<AddCommentDialogProps> = ({ anchorRect, onConfirm, onCancel }) => {
  const [text, setText] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const outsideCloseArmedRef = useRef(false)

  // Position below the selection
  const top = Math.min(anchorRect.bottom + 8, window.innerHeight - 200)
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 300))

  useEffect(() => {
    outsideCloseArmedRef.current = false

    const armOutsideClose = () => {
      outsideCloseArmedRef.current = true
      window.removeEventListener('mouseup', armOutsideClose)
    }

    window.addEventListener('mouseup', armOutsideClose)

    const handler = (e: MouseEvent) => {
      if (!outsideCloseArmedRef.current) return
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel()
    }
    document.addEventListener('mousedown', handler)
    return () => {
      window.removeEventListener('mouseup', armOutsideClose)
      document.removeEventListener('mousedown', handler)
    }
  }, [onCancel])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onConfirm(trimmed)
  }

  return (
    <div
      ref={ref}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: 9999,
        width: 280,
        background: 'white',
        border: '1px solid #d1d5db',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        padding: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>添加批注</div>
      <textarea
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="输入批注内容…"
        rows={3}
        style={{
          width: '100%', resize: 'none', border: '1px solid #d1d5db',
          borderRadius: 6, padding: '6px 8px', fontSize: 13,
          boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button
          onMouseDown={e => { e.preventDefault(); onCancel() }}
          style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer', background: 'white', color: '#374151' }}
        >取消</button>
        <button
          onMouseDown={e => { e.preventDefault(); submit() }}
          style={{ padding: '4px 12px', fontSize: 12, border: 'none', borderRadius: 4, cursor: 'pointer', background: '#2563eb', color: 'white' }}
        >确定</button>
      </div>
    </div>
  )
}
