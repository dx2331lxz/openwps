import React, { useState } from 'react'
import type { CommentData } from './CommentPopover'

export interface SidebarCommentData extends CommentData {
  selectionText: string
}

interface CommentSidebarProps {
  comments: SidebarCommentData[]
  pageWidth: number
  canvasHeight: number
  activeCommentId?: string | null
  onActivate?: (id: string) => void
  onDelete: (id: string) => void
  onResolve: (id: string) => void
}

interface PositionedSidebarComment extends SidebarCommentData {
  cardTop: number
  cardLeft: number
  leaderStartX: number
  leaderStartY: number
  leaderEndX: number
  leaderEndY: number
}

const COMMENT_CARD_WIDTH = 280
const COMMENT_GUTTER_GAP = 28
const COMMENT_CARD_SPACING = 18
const COMMENT_CARD_MIN_HEIGHT = 104

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
  for (let i = 0; i < name.length; i += 1) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function layoutComments(
  comments: SidebarCommentData[],
  pageWidth: number,
  canvasHeight: number
): PositionedSidebarComment[] {
  const cardLeft = pageWidth + COMMENT_GUTTER_GAP
  let nextTop = 16

  return comments.map((comment) => {
    const anchorMidY = comment.anchorRect.top + (comment.anchorRect.height / 2)
    const desiredTop = Math.max(16, anchorMidY - 36)
    const cardTop = Math.max(
      16,
      Math.min(
        Math.max(desiredTop, nextTop),
        Math.max(16, canvasHeight - COMMENT_CARD_MIN_HEIGHT - 16),
      ),
    )
    nextTop = cardTop + COMMENT_CARD_MIN_HEIGHT + COMMENT_CARD_SPACING

    return {
      ...comment,
      cardTop,
      cardLeft,
      leaderStartX: Math.min(pageWidth - 10, comment.anchorRect.right + 8),
      leaderStartY: anchorMidY,
      leaderEndX: cardLeft - 14,
      leaderEndY: cardTop + 38,
    }
  })
}

const CommentCard: React.FC<{
  comment: PositionedSidebarComment
  active: boolean
  onActivate?: (id: string) => void
  onDelete: (id: string) => void
  onResolve: (id: string) => void
}> = ({ comment, active, onActivate, onDelete, onResolve }) => {
  const [replyMode, setReplyMode] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [replies, setReplies] = useState<Array<{ id: string; author: string; date: string; content: string }>>([])

  const handleReplySubmit = () => {
    const trimmed = replyText.trim()
    if (!trimmed) return
    setReplies((prev) => [...prev, {
      id: String(Date.now()),
      author: '我',
      date: new Date().toISOString(),
      content: trimmed,
    }])
    setReplyText('')
    setReplyMode(false)
  }

  const color = avatarColor(comment.author || '?')
  const initial = (comment.author || '?')[0]?.toUpperCase() ?? '?'

  return (
    <div
      data-comment-card="true"
      data-comment-id={comment.id}
      data-active={active ? 'true' : 'false'}
      onMouseDown={(event) => {
        event.stopPropagation()
        onActivate?.(comment.id)
      }}
      style={{
        position: 'absolute',
        top: comment.cardTop,
        left: comment.cardLeft,
        width: COMMENT_CARD_WIDTH,
        background: 'rgba(255,255,255,0.98)',
        borderRadius: 10,
        borderStyle: 'solid',
        borderColor: active ? 'rgba(239,68,68,0.28)' : '#f1f5f9',
        borderWidth: '1px 1px 1px 3px',
        boxShadow: active
          ? '0 10px 26px rgba(239,68,68,0.14)'
          : '0 8px 22px rgba(15,23,42,0.08)',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: active ? 2 : 1,
      }}
    >
      <div style={{ padding: '12px 14px 10px' }}>
        {comment.selectionText && (
          <div style={{
            fontSize: 12,
            color: '#94a3b8',
            marginBottom: 8,
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {comment.selectionText}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: color,
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0,
          }}>
            {initial}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#ef4444' }}>{comment.author || '未知用户'}</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>{formatDate(comment.date)}</div>
          </div>
        </div>

        <div style={{ fontSize: 14, color: '#111827', lineHeight: 1.6 }}>
          {comment.content || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>（无内容）</span>}
        </div>
      </div>

      {replies.length > 0 && (
        <div style={{ borderTop: '1px solid #f1f5f9' }}>
          {replies.map((reply) => (
            <div key={reply.id} style={{ padding: '10px 14px', borderBottom: '1px solid #f8fafc' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: avatarColor(reply.author),
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                }}>
                  {reply.author[0]?.toUpperCase() ?? '?'}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{reply.author}</div>
                <div style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8' }}>{formatDate(reply.date)}</div>
              </div>
              <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6 }}>{reply.content}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid #f1f5f9' }}>
        {[
          { label: replyMode ? '收起答复' : '答复', action: () => setReplyMode((value) => !value), color: '#6b7280' },
          { label: '解决', action: () => onResolve(comment.id), color: '#16a34a' },
          { label: '删除', action: () => onDelete(comment.id), color: '#dc2626' },
        ].map((item) => (
          <button
            key={item.label}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              item.action()
            }}
            style={{
              flex: 1,
              border: 'none',
              background: '#f8fafc',
              color: item.color,
              borderRadius: 6,
              padding: '5px 8px',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {replyMode && (
        <div style={{ borderTop: '1px solid #f1f5f9', padding: '10px 12px 12px' }}>
          <textarea
            autoFocus
            value={replyText}
            onChange={(event) => setReplyText(event.target.value)}
            placeholder="输入答复…"
            rows={2}
            style={{
              width: '100%',
              resize: 'none',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              padding: '6px 8px',
              fontSize: 13,
              boxSizing: 'border-box',
              outline: 'none',
              fontFamily: 'inherit',
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) handleReplySubmit()
              if (event.key === 'Escape') {
                setReplyMode(false)
                setReplyText('')
              }
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            <button
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setReplyMode(false)
                setReplyText('')
              }}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                border: '1px solid #d1d5db',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'white',
                color: '#374151',
              }}
            >
              取消
            </button>
            <button
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                handleReplySubmit()
              }}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                background: '#2563eb',
                color: 'white',
              }}
            >
              发送
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export const COMMENT_SIDEBAR_WIDTH = COMMENT_CARD_WIDTH + COMMENT_GUTTER_GAP + 24

export const CommentSidebar: React.FC<CommentSidebarProps> = ({
  comments,
  pageWidth,
  canvasHeight,
  activeCommentId,
  onActivate,
  onDelete,
  onResolve,
}) => {
  if (comments.length === 0) return null

  const positionedComments = layoutComments(comments, pageWidth, canvasHeight)
  const inactiveComments = positionedComments.filter((comment) => comment.id !== activeCommentId)
  const activeComments = positionedComments.filter((comment) => comment.id === activeCommentId)
  const layeredComments = [...inactiveComments, ...activeComments]

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 4,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <svg
        width={pageWidth + COMMENT_SIDEBAR_WIDTH}
        height={canvasHeight}
        style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}
      >
        {layeredComments.map((comment) => {
          const bendX = pageWidth + 6
          return (
            <path
              key={`leader-${comment.id}`}
              d={`M ${comment.leaderStartX} ${comment.leaderStartY} L ${pageWidth - 8} ${comment.leaderStartY} C ${bendX} ${comment.leaderStartY} ${comment.leaderEndX - 26} ${comment.leaderEndY} ${comment.leaderEndX} ${comment.leaderEndY}`}
              fill="none"
              stroke={comment.id === activeCommentId ? '#ef4444' : '#f87171'}
              strokeWidth={comment.id === activeCommentId ? 1.6 : 1.2}
              strokeDasharray="3 4"
              opacity={0.9}
            />
          )
        })}
      </svg>

      {layeredComments.map((comment) => (
        <div
          key={comment.id}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: comment.id === activeCommentId ? 2 : 1,
            pointerEvents: 'none',
          }}
        >
          <CommentCard
            comment={comment}
            active={comment.id === activeCommentId}
            onActivate={onActivate}
            onDelete={onDelete}
            onResolve={onResolve}
          />
        </div>
      ))}
    </div>
  )
}
