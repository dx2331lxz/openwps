import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { EditorView } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { marked } from 'marked'
import { prepareWithSegments, layout, walkLineRanges } from '@chenglou/pretext'
import type { PreparedTextWithSegments } from '@chenglou/pretext'
import {
  abortStreamingWrite,
  appendStreamingWrite,
  beginStreamingWrite,
  executeTool,
  type ExecuteResult,
  type StreamingWriteSession,
} from '../ai/executor'
import { agentTools } from '../ai/tools'
import type {
  AIProviderSettings,
  AISettingsData,
  ImageProcessingMode,
  ModelOption,
  OcrConfigData,
} from '../ai/providers'
import { paginate, type PageConfig } from '../layout/paginator'

type View = 'history' | 'chat'
type AssistantMode = 'agent' | 'layout' | 'edit'

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
  originalParams?: Record<string, unknown>
  status: 'pending' | 'ok' | 'err'
  message?: string
  data?: unknown
  isExpanded?: boolean
}

type MessageSegment =
  | { id: string; type: 'content'; text: string }
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'tool'; toolCall: ToolCallResult }

interface ImageAttachment {
  id: string
  name: string
  size: number
  type: string
  dataUrl: string
}

interface Message {
  id: string
  role: 'user' | 'ai'
  text: string
  segments: MessageSegment[]
  thinking: string
  isThinkingExpanded: boolean
  toolCalls: ToolCallResult[]
  streaming: boolean
  activityLabel: string
  prepared?: PreparedTextWithSegments
  tightWidth: number
  selectionTag?: { text: string; paragraphIndex: number } | null
}

interface TodoItem {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

// ─── Selection context ───────────────────────────────────────────────────────

interface TextRun {
  text: string
  startOffset: number
  endOffset: number
  marks: Record<string, unknown>
}

interface SelectionContext {
  from: number
  to: number
  selectedText: string
  paragraphIndex: number
  charOffset: number
  prefixText: string
  suffixText: string
  paragraphText: string
  paragraphAttrs: Record<string, unknown>
  textRuns: TextRun[]
}

function truncatePreviewText(text: string, maxLength = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function serializeSelection(editorState: EditorState): SelectionContext | null {
  const { from, to } = editorState.selection
  if (from === to) return null

  const doc = editorState.doc
  let paraIndex = 0
  let targetParaIndex = -1
  let targetParaStart = -1
  let targetParaNode: ProseMirrorNode | null = null

  doc.forEach((node, pos) => {
    if (node.type.name !== 'paragraph') return
    const paraFrom = pos + 1
    const paraTo = pos + node.nodeSize - 1
    if (targetParaIndex === -1 && from >= paraFrom && from <= paraTo) {
      targetParaIndex = paraIndex
      targetParaStart = paraFrom
      targetParaNode = node
    }
    paraIndex += 1
  })

  const selectedText = doc.textBetween(from, to, '\n')

  if (!targetParaNode || targetParaStart === -1) {
    return {
      from, to, selectedText,
      paragraphIndex: -1, charOffset: 0,
      prefixText: '',
      suffixText: '',
      paragraphText: '',
      paragraphAttrs: {}, textRuns: [],
    }
  }

  const paraNode = targetParaNode as ProseMirrorNode
  const charOffset = from - targetParaStart
  const paragraphText = paraNode.textContent
  const paragraphAttrs = { ...(paraNode.attrs as Record<string, unknown>) }

  // Build textRuns for the selected range inside this paragraph
  const selStartInPara = charOffset
  const selEndInPara = Math.min(paraNode.textContent.length, to - targetParaStart)
  const prefixText = paragraphText.slice(Math.max(0, charOffset - 12), charOffset)
  const suffixText = paragraphText.slice(selEndInPara, Math.min(paragraphText.length, selEndInPara + 12))
  const textRuns: TextRun[] = []
  let runningOffset = 0

  paraNode.forEach((child: ProseMirrorNode) => {
    if (!child.isText) { runningOffset += child.nodeSize; return }
    const text = child.text ?? ''
    const runStart = runningOffset
    const runEnd = runningOffset + text.length
    runningOffset = runEnd

    if (runEnd <= selStartInPara || runStart >= selEndInPara) return

    const sliceStart = Math.max(runStart, selStartInPara)
    const sliceEnd = Math.min(runEnd, selEndInPara)
    const slicedText = text.slice(sliceStart - runStart, sliceEnd - runStart)

    const tm = child.marks.find((m: { type: { name: string } }) => m.type.name === 'textStyle')
    const marks: Record<string, unknown> = tm ? { ...(tm.attrs as Record<string, unknown>) } : {}

    textRuns.push({ text: slicedText, startOffset: sliceStart, endOffset: sliceEnd, marks })
  })

  return {
    from,
    to,
    selectedText,
    paragraphIndex: targetParaIndex,
    charOffset,
    prefixText,
    suffixText,
    paragraphText,
    paragraphAttrs,
    textRuns,
  }
}

function buildContextPreview(editorState: EditorState, pageConfig: PageConfig) {
  const paragraphPreviews: Array<{ index: number; text: string; charCount: number }> = []
  const blockParagraphIndexes: Array<number | null> = []
  let paragraphIndex = 0

  editorState.doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      paragraphPreviews.push({
        index: paragraphIndex,
        text: truncatePreviewText(node.textContent, 100),
        charCount: node.textContent.length,
      })
      blockParagraphIndexes.push(paragraphIndex)
      paragraphIndex += 1
      return
    }

    blockParagraphIndexes.push(null)
  })

  const pagination = paginate(editorState.doc, pageConfig)
  const totalPages = pagination.renderedPages.length
  const pageIndexes = totalPages <= 4 ? [...pagination.renderedPages.keys()] : [0, 1, totalPages - 1]
  const pages = pageIndexes.map(pageIndex => {
    const page = pagination.renderedPages[pageIndex]
    const paragraphIndexes = [...new Set(
      page.lines
        .map(line => blockParagraphIndexes[line.blockIndex] ?? null)
        .filter((value): value is number => typeof value === 'number')
    )]

    return {
      page: pageIndex + 1,
      paragraphRange: paragraphIndexes.length > 0
        ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
        : null,
      previewText: truncatePreviewText(page.lines.map(line => line.text).join(' '), 160),
    }
  })

  return {
    firstParagraphs: paragraphPreviews.slice(0, 4),
    lastParagraphs: paragraphPreviews.length > 4 ? paragraphPreviews.slice(-2) : [],
    pages,
    omittedPageCount: Math.max(0, totalPages - pages.length),
  }
}

interface Props {
  view: EditorView | null
  editorState?: EditorState | null
  pageConfig: PageConfig
  onPageConfigChange: (cfg: PageConfig) => void
  onDocumentStyleMutation?: () => void
  onClose: () => void
}

const SIDEBAR_MIN = 360
const SIDEBAR_MAX = 760
const SIDEBAR_DEFAULT = 560
const FONT = '14px -apple-system, BlinkMacSystemFont, sans-serif'
const LINE_HEIGHT = 20
const PADDING_H = 12
const PADDING_V = 8
const BUBBLE_MAX_RATIO = 0.85
const TEXTAREA_MIN_HEIGHT = 72
const TEXTAREA_MAX_HEIGHT = 200
const STREAMING_WRITE_FLUSH_MS = 80
const STREAMING_WRITE_MAX_BUFFER = 1200
const MAX_IMAGE_ATTACHMENT_COUNT = 5
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
const TOOL_DESCRIPTIONS = Object.fromEntries(agentTools.map(tool => [tool.name, tool.description]))

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

function truncateText(value: string, maxLength = 48) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function describeToolTarget(params: Record<string, unknown>) {
  const range = params.range
  if (range && typeof range === 'object' && !Array.isArray(range)) {
    const type = String((range as Record<string, unknown>).type ?? '')
    if (type === 'selection') return '当前选区'
    if (type === 'all') return '全文'
    if (type === 'paragraph') {
      const paragraphIndex = Number((range as Record<string, unknown>).paragraphIndex)
      if (Number.isFinite(paragraphIndex)) return `第 ${paragraphIndex + 1} 段`
    }
    if (type === 'paragraphs') {
      const from = Number((range as Record<string, unknown>).from)
      const to = Number((range as Record<string, unknown>).to)
      if (Number.isFinite(from) && Number.isFinite(to)) return `第 ${from + 1}-${to + 1} 段`
    }
  }

  if (Number.isFinite(Number(params.paragraphIndex))) return `第 ${Number(params.paragraphIndex) + 1} 段`
  if (Number.isFinite(Number(params.afterParagraph))) return `第 ${Number(params.afterParagraph) + 1} 段后`
  if (Number.isFinite(Number(params.index))) return `第 ${Number(params.index) + 1} 段`
  if (Number.isFinite(Number(params.page))) return `第 ${Number(params.page)} 页`
  return ''
}

function summarizeToolPurpose(toolCall: ToolCallResult) {
  const textKeys = ['purpose', 'goal', 'reason', 'instruction', 'query', 'message', 'text']
  for (const key of textKeys) {
    const value = toolCall.params[key]
    if (typeof value === 'string' && value.trim()) return truncateText(value.trim())
  }

  const target = describeToolTarget(toolCall.params)
  const description = TOOL_DESCRIPTIONS[toolCall.name]

  if (toolCall.name === 'get_todo_list') return '读取当前任务计划状态'
  if (toolCall.name === 'get_document_info') return '读取当前文档的统计信息'
  if (toolCall.name === 'get_document_outline') return '读取整篇文档的分页概览和样式概览'
  if (toolCall.name === 'get_document_content') return target ? `读取${target}的内容和样式` : '读取全文内容和样式，辅助后续判断'
  if (toolCall.name === 'get_page_content') return target ? `查看${target}的分页快照` : '查看指定页面的排版快照'
  if (toolCall.name === 'get_page_style_summary') return target ? `查看${target}的样式摘要` : '查看指定页面的样式摘要'
  if (toolCall.name === 'get_paragraph') return target ? `查看${target}的内容和样式` : '查看指定段落内容和样式'
  if (toolCall.name === 'set_page_config') return '调整纸张大小、方向或页边距'
  if (toolCall.name === 'set_text_style') return target ? `修改${target}的文字样式` : '修改文字样式'
  if (toolCall.name === 'set_paragraph_style') return target ? `调整${target}的段落格式` : '调整段落格式'
  if (toolCall.name === 'clear_formatting') return target ? `清除${target}的排版格式` : '清除排版格式'
  if (toolCall.name === 'begin_streaming_write') return target ? `开始向${target}流式写正文` : '开始流式写正文'
  if (toolCall.name === 'insert_text') return target ? `向${target}补充文字` : '插入新的文字内容'
  if (toolCall.name === 'insert_paragraph_after') return target ? `在${target}后新增段落` : '插入一个新段落'
  if (toolCall.name === 'replace_paragraph_text') return target ? `整体改写${target}` : '整体替换段落内容'
  if (toolCall.name === 'replace_selection_text') return '替换当前选中的文本'
  if (toolCall.name === 'delete_selection_text') return '删除当前选中的文本'
  if (toolCall.name === 'delete_paragraph') return target ? `删除${target}` : '删除指定段落'
  if (toolCall.name === 'insert_page_break') return target ? `在${target}插入分页符` : '插入分页符'
  if (toolCall.name === 'insert_horizontal_rule') return target ? `在${target}插入分割线` : '插入分割线'
  if (toolCall.name === 'insert_table') return target ? `在${target}插入表格` : '插入表格'
  if (toolCall.name === 'apply_style_batch') {
    const ruleCount = Array.isArray(toolCall.params.rules) ? toolCall.params.rules.length : 0
    return ruleCount > 0 ? `批量应用 ${ruleCount} 条样式规则` : '批量应用样式规则'
  }
  if (toolCall.name === 'apply_document_preset') {
    const preset = String(toolCall.params.preset ?? '')
    return preset ? `应用"${preset}"文档预设` : '应用文档预设模板'
  }

  return description || '执行工具调用'
}

function buildToolActionLabel(toolCall: ToolCallResult) {
  return summarizeToolPurpose(toolCall)
}

function toolStatusTone(toolCall: ToolCallResult) {
  if (toolCall.status === 'ok') return 'text-emerald-600'
  if (toolCall.status === 'err') return 'text-red-500'
  return 'text-blue-500'
}

function formatToolParams(params: Record<string, unknown>) {
  try {
    return JSON.stringify(params, null, 2)
  } catch {
    return String(params)
  }
}

function formatToolData(data: unknown) {
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function downloadJsonFile(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function extractSelectionContext(context: Record<string, unknown>) {
  const selection = context.selection
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null
  const from = Number((selection as Record<string, unknown>).from)
  const to = Number((selection as Record<string, unknown>).to)
  const paragraphIndex = Number((selection as Record<string, unknown>).paragraphIndex)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return {
    from,
    to,
    paragraphIndex: Number.isFinite(paragraphIndex) ? paragraphIndex : undefined,
    charOffset: Number((selection as Record<string, unknown>).charOffset ?? 0),
    selectedText: String((selection as Record<string, unknown>).selectedText ?? ''),
    prefixText: String((selection as Record<string, unknown>).prefixText ?? ''),
    suffixText: String((selection as Record<string, unknown>).suffixText ?? ''),
    paragraphText: String((selection as Record<string, unknown>).paragraphText ?? ''),
  }
}

function hasUsableRange(params: Record<string, unknown>) {
  const range = params.range
  if (!range || typeof range !== 'object' || Array.isArray(range)) return false
  const candidate = range as Record<string, unknown>
  return (
    typeof candidate.type === 'string'
    || Number.isFinite(Number(candidate.paragraphIndex))
    || Number.isFinite(Number(candidate.from))
    || Number.isFinite(Number(candidate.to))
    || Number.isFinite(Number(candidate.selectionFrom))
    || Number.isFinite(Number(candidate.selectionTo))
    || typeof candidate.text === 'string'
  )
}

function serializeToolParamsWithSelection(
  toolName: string,
  params: Record<string, unknown>,
  selectionContext: {
    from: number
    to: number
    paragraphIndex?: number
    charOffset?: number
    selectedText?: string
    prefixText?: string
    suffixText?: string
    paragraphText?: string
  } | null,
) {
  const range = params.range
  if (!selectionContext) return params

  if (
    (toolName === 'set_text_style' || toolName === 'set_paragraph_style' || toolName === 'clear_formatting')
    && !hasUsableRange(params)
  ) {
    return {
      ...params,
      range: {
        type: 'selection',
        selectionFrom: selectionContext.from,
        selectionTo: selectionContext.to,
      },
    }
  }

  if (!range || typeof range !== 'object' || Array.isArray(range)) return params
  const nextRange = { ...(range as Record<string, unknown>) }
  if (nextRange.type !== 'selection') return params
  if (!Number.isFinite(Number(nextRange.selectionFrom))) nextRange.selectionFrom = selectionContext.from
  if (!Number.isFinite(Number(nextRange.selectionTo))) nextRange.selectionTo = selectionContext.to
  return { ...params, range: nextRange }
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

function hasToolParams(params: Record<string, unknown> | undefined) {
  return Boolean(params && Object.keys(params).length > 0)
}

function getReplayToolParams(tool: Pick<ToolCallResult, 'params' | 'originalParams'>) {
  return hasToolParams(tool.originalParams) ? normalizeToolParams(tool.originalParams) : normalizeToolParams(tool.params)
}

function makeUserMessage(text: string, sidebarWidth: number): Message {
  const message: Message = {
    id: newId(),
    role: 'user',
    text,
    segments: [{ id: newId(), type: 'content', text }],
    thinking: '',
    isThinkingExpanded: false,
    toolCalls: [],
    streaming: false,
    activityLabel: '',
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
    segments: text ? [{ id: newId(), type: 'content', text }] : [],
    thinking: '',
    isThinkingExpanded: false,
    toolCalls: [],
    streaming,
    activityLabel: streaming ? '正在准备响应...' : '',
    tightWidth: 0,
  }
}

function appendThinkingChunk(message: Message, chunk: string): Message {
  const nextThinking = message.thinking + chunk
  const nextSegments = [...message.segments]
  const lastSegment = nextSegments.at(-1)

  if (lastSegment?.type === 'thinking') {
    nextSegments[nextSegments.length - 1] = { ...lastSegment, text: lastSegment.text + chunk }
  } else {
    nextSegments.push({ id: newId(), type: 'thinking', text: chunk })
  }

  return { ...message, thinking: nextThinking, segments: nextSegments }
}

function appendContentChunk(message: Message, chunk: string, replace = false): Message {
  const nextText = replace ? chunk : message.text + chunk
  const nextToolCalls = message.toolCalls.map(toolCall => (
    toolCall.status === 'pending' ? toolCall : { ...toolCall, isExpanded: false }
  ))
  let toolIndex = -1
  const nextSegments = message.segments.map(segment => {
    if (segment.type !== 'tool') return segment
    toolIndex += 1
    const nextToolCall = nextToolCalls[toolIndex]
    return nextToolCall ? { ...segment, toolCall: nextToolCall } : segment
  })
  const content = replace ? chunk : chunk
  const lastSegment = nextSegments.at(-1)

  if (lastSegment?.type === 'content' && !replace) {
    nextSegments[nextSegments.length - 1] = { ...lastSegment, text: lastSegment.text + content }
  } else if (nextText) {
    nextSegments.push({ id: newId(), type: 'content', text: replace ? nextText : content })
  }

  return { ...message, text: nextText, toolCalls: nextToolCalls, segments: nextSegments }
}

function appendToolSegment(message: Message, toolCall: ToolCallResult): Message {
  return {
    ...message,
    toolCalls: [...message.toolCalls, toolCall],
    segments: [...message.segments, { id: newId(), type: 'tool', toolCall }],
  }
}

function updateToolCallInMessage(
  message: Message,
  matcher: (toolCall: ToolCallResult, index: number, array: ToolCallResult[]) => boolean,
  updater: (toolCall: ToolCallResult) => ToolCallResult,
): Message {
  const nextToolCalls = message.toolCalls.map((toolCall, index, array) => (
    matcher(toolCall, index, array) ? updater(toolCall) : toolCall
  ))

  let toolIndex = -1
  const nextSegments = message.segments.map(segment => {
    if (segment.type !== 'tool') return segment
    toolIndex += 1
    const nextToolCall = nextToolCalls[toolIndex]
    return nextToolCall ? { ...segment, toolCall: nextToolCall } : segment
  })

  return { ...message, toolCalls: nextToolCalls, segments: nextSegments }
}

interface ToolCallRecord {
  id: string
  name: string
  params: Record<string, unknown>
  originalParams?: Record<string, unknown>
  result: ExecuteResult
}

interface ToolPlanExecution {
  executionId: string
  toolName: string
  params: Record<string, unknown>
  sourceToolCallIds: string[]
  mergeStrategy: string
  continueOnError: boolean
}

interface ToolExecutionPlan {
  planId: string
  round: number
  executions: ToolPlanExecution[]
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
        arguments: JSON.stringify(getReplayToolParams(tool)),
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

function serializeToolResultPayload({
  toolName,
  result,
  executedParams,
  originalParams,
  extra = {},
}: {
  toolName: string
  result: ExecuteResult
  executedParams: Record<string, unknown>
  originalParams?: Record<string, unknown>
  extra?: Record<string, unknown>
}) {
  const replayParams = hasToolParams(originalParams)
    ? normalizeToolParams(originalParams)
    : normalizeToolParams(executedParams)
  const payload: Record<string, unknown> = {
    ...extra,
    success: result.success,
    message: result.message,
    data: result.data ?? null,
    toolName,
    originalParams: hasToolParams(originalParams) ? originalParams : null,
    executedParams,
    paramsRepaired: stableStringify(replayParams) !== stableStringify(executedParams),
  }

  if (toolName === 'begin_streaming_write' && result.success) {
    payload.nextAction = 'immediately_stream_markdown_content'
    payload.instruction = '现在必须立刻输出要写入文档的 Markdown 正文内容，不要结束，不要解释，不要再次调用 begin_streaming_write。'
  }

  return JSON.stringify(payload)
}

function serializeToolResult(tool: ToolCallRecord) {
  return serializeToolResultPayload({
    toolName: tool.name,
    result: tool.result,
    executedParams: tool.params,
    originalParams: tool.originalParams,
  })
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function parseToolPlanEvent(event: Record<string, unknown>): ToolExecutionPlan | null {
  const planId = typeof event.planId === 'string' ? event.planId : ''
  const round = Number(event.round)
  if (!planId || !Number.isFinite(round) || !Array.isArray(event.executions)) return null

  const executions = event.executions
    .map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const raw = item as Record<string, unknown>
      const executionId = typeof raw.executionId === 'string' ? raw.executionId : ''
      const toolName = typeof raw.toolName === 'string' ? raw.toolName : ''
      if (!executionId || !toolName) return null
      return {
        executionId,
        toolName,
        params: normalizeToolParams(raw.params),
        sourceToolCallIds: Array.isArray(raw.sourceToolCallIds)
          ? raw.sourceToolCallIds.map(id => String(id)).filter(Boolean)
          : [],
        mergeStrategy: typeof raw.mergeStrategy === 'string' ? raw.mergeStrategy : 'single',
        continueOnError: raw.continueOnError !== false,
      }
    })
    .filter((execution): execution is ToolPlanExecution => Boolean(execution))

  return {
    planId,
    round,
    executions,
  }
}

function buildFallbackToolPlan(round: number, toolCalls: ToolCallResult[]): ToolExecutionPlan {
  return {
    planId: `fallback-${round}`,
    round,
    executions: toolCalls.map((toolCall, index) => ({
      executionId: toolCall.id ?? `fallback-${round}-${index}`,
      toolName: toolCall.name,
      params: normalizeToolParams(toolCall.params),
      sourceToolCallIds: toolCall.id ? [toolCall.id] : [],
      mergeStrategy: 'single',
      continueOnError: true,
    })),
  }
}

function repairToolArgsJson(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.at(-1) !== char) return null
      stack.pop()
    }
  }

  let repaired = text
  if (inString) repaired += '"'
  if (escaped) repaired += '"'
  if (stack.length > 0) repaired += stack.slice().reverse().join('')
  repaired = repaired.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
  return repaired === text ? null : repaired
}

function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return normalizeToolParams(rawArguments)
  }
  if (typeof rawArguments !== 'string') return {}

  try {
    return normalizeToolParams(JSON.parse(rawArguments))
  } catch {
    const repaired = repairToolArgsJson(rawArguments)
    if (!repaired) return {}
    try {
      return normalizeToolParams(JSON.parse(repaired))
    } catch {
      return {}
    }
  }
}

function normalizeStoredToolCalls(message: StoredMessage): ToolCallResult[] {
  if (Array.isArray(message.toolCalls)) {
    return message.toolCalls.map(toolCall => ({
      id: toolCall.id,
      name: toolCall.name,
      params: normalizeToolParams(toolCall.params),
      originalParams: normalizeToolParams(toolCall.originalParams),
      status: toolCall.status,
      message: toolCall.message,
      data: toolCall.data,
      isExpanded: false,
    }))
  }

  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map(call => {
      const params = parseToolArguments(call.function?.arguments)
      return {
        id: call.id,
        name: String(call.function?.name ?? ''),
        params,
        originalParams: params,
        status: 'pending' as const,
        isExpanded: false,
      }
    })
  }

  return []
}

function applyStoredToolResult(message: Message | undefined, stored: StoredMessage) {
  if (!message || message.role !== 'ai' || stored.role !== 'tool') return

  let parsed: { success?: boolean; message?: string; data?: unknown } | null = null
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

  const nextMessageState = updateToolCallInMessage(
    message,
    (toolCall, index, array) => {
      const shouldUse =
        (!matched && targetId && toolCall.id === targetId) ||
        (!matched && !targetId && index === array.length - 1)
      if (shouldUse) matched = true
      return shouldUse
    },
    toolCall => ({ ...toolCall, status: nextStatus, message: nextMessage, data: parsed?.data }),
  )

  message.toolCalls = nextMessageState.toolCalls
  message.segments = nextMessageState.segments
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
      aiMessage.segments = [
        ...(stored.thinking ? [{ id: newId(), type: 'thinking' as const, text: stored.thinking }] : []),
        ...(stored.content ? [{ id: newId(), type: 'content' as const, text: stored.content }] : []),
        ...aiMessage.toolCalls.map(toolCall => ({ id: newId(), type: 'tool' as const, toolCall })),
      ]
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
          tool_calls: normalizeReactToolCalls(message.toolCalls ?? message.tool_calls),
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

  if (message.includes('未接受图片输入') || message.includes('不兼容 image_url 图片格式')) {
    return `❌ 当前模型未接受图片输入：${message}\n\n你可以切换到明确支持视觉的模型，或改用 OCR 路径。`
  }

  if (message.includes('OCR API Key 未配置') || message.includes('OCR 端点未配置') || message.includes('OCR 模型未配置')) {
    return `❌ OCR 配置不完整：${message}\n\n请在设置中检查 OCR 端点、模型 ID 和 API Key。`
  }

  if (message.includes('OCR 模型请求失败')) {
    return `❌ OCR 接口调用失败：${message}\n\n请检查 OCR 服务端点、API Key、模型 ID，以及当前服务是否可达。`
  }

  if (message.includes('OCR 结果解析失败')) {
    return `❌ OCR 已返回响应，但结果格式不可解析：${message}\n\n这通常表示 OCR 模型返回了非预期格式，或输出被截断。建议先换一张更清晰的图片，或检查当前 OCR 模型是否支持该接口格式。`
  }

  return `❌ 请求失败：${message}\n\n请确认后端服务已启动（端口 5174）并已配置 API Key。`
}

function makeConversationTitle(text: string) {
  return text.trim().slice(0, 30) || '新会话'
}

function buildDefaultImagePrompt(mode: AssistantMode) {
  if (mode === 'layout') return '请根据上传的图片内容复现版式到当前文档中。'
  if (mode === 'edit') return '请根据上传的图片内容复现正文到当前文档中。'
  return '请根据上传的图片内容复现到当前文档中。'
}

function createDefaultOcrConfig(): OcrConfigData {
  return {
    enabled: true,
    providerId: 'siliconflow',
    endpoint: 'https://api.siliconflow.cn/v1',
    model: 'PaddlePaddle/PaddleOCR-VL-1.5',
    hasApiKey: false,
    timeoutSeconds: 60,
    maxImages: 5,
  }
}

function extractClipboardImageFiles(event: ReactClipboardEvent<HTMLTextAreaElement>): File[] {
  const items = Array.from(event.clipboardData?.items || [])
  return items
    .filter(item => item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export default function AISidebar({ view: editorView, editorState, pageConfig, onPageConfigChange, onDocumentStyleMutation, onClose }: Props) {
  const [viewMode, setViewMode] = useState<View>('history')
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [currentConversationTitle, setCurrentConversationTitle] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('agent')
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(false)
  const [includeSelection, setIncludeSelection] = useState(true)
  const [providers, setProviders] = useState<AIProviderSettings[]>([])
  const [modelName, setModelName] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [activeProviderId, setActiveProviderId] = useState('')
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([])
  const [imageProcessingMode, setImageProcessingMode] = useState<ImageProcessingMode>('direct_multimodal')
  const [ocrConfig, setOcrConfig] = useState<OcrConfigData>(createDefaultOcrConfig())

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const isDragging = useRef(false)
  const isComposingRef = useRef(false)
  const shouldAutoScrollRef = useRef(true)
  const currentConversationIdRef = useRef<string | null>(null)
  const conversationMessagesRef = useRef<StoredMessage[]>([])
  const activeStreamingWriteRef = useRef<StreamingWriteSession | null>(null)
  const todosRef = useRef<TodoItem[]>([])

  const activeProvider = useMemo(
    () => providers.find(provider => provider.id === activeProviderId) ?? null,
    [providers, activeProviderId],
  )
  const activeOcrProvider = useMemo(
    () => providers.find(provider => provider.id === ocrConfig.providerId) ?? null,
    [ocrConfig.providerId, providers],
  )
  const activeProviderSupportsVision = Boolean(activeProvider?.supportsVision)
  const currentModelId = selectedModel || modelName
  const currentModelSupportsVision = useMemo(() => {
    const matched = availableModels.find(model => model.id === currentModelId)
    return matched?.supportsVision ?? activeProviderSupportsVision
  }, [activeProviderSupportsVision, availableModels, currentModelId])
  const effectiveOcrEndpoint = ocrConfig.endpoint || activeOcrProvider?.endpoint || ''
  const effectiveOcrHasApiKey = ocrConfig.hasApiKey || Boolean(activeOcrProvider?.hasApiKey)
  const isOcrReady = Boolean(
    ocrConfig.enabled
    && ocrConfig.model.trim()
    && effectiveOcrEndpoint
    && effectiveOcrHasApiKey,
  )
  const canUploadImages = imageProcessingMode === 'ocr_text' ? isOcrReady : true
  const canSendMessage = Boolean(input.trim() || pendingImages.length > 0)

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId
  }, [currentConversationId])

  useEffect(() => {
    todosRef.current = todos
  }, [todos])

  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT)}px`
  }, [])

  const scrollToBottomIfNeeded = useCallback(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea || !shouldAutoScrollRef.current) return
    scrollArea.scrollTop = scrollArea.scrollHeight
  }, [])

  const resetTextareaHeight = useCallback(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`
  }, [])

  const getContext = useCallback(() => {
    if (!editorView) return {}
    let paragraphCount = 0
    let wordCount = 0
    editorView.state.doc.forEach((node) => {
      if (node.type.name === 'paragraph') {
        paragraphCount += 1
        wordCount += node.textContent.length
      }
    })
    const preview = buildContextPreview(editorView.state, pageConfig)
    const ctx: Record<string, unknown> = {
      paragraphCount,
      wordCount,
      pageCount: preview.pages.length + preview.omittedPageCount,
      preview,
    }
    if (includeSelection && editorState) {
      const sel = serializeSelection(editorState)
      if (sel) ctx.selection = sel
    }
    return ctx
  }, [editorView, editorState, includeSelection, pageConfig])

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
    let active = true
    fetch('/api/ai/settings')
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<AISettingsData>
      })
      .then(data => {
        if (!active) return
        setProviders(data.providers)
        setActiveProviderId(data.activeProviderId)
        setImageProcessingMode(data.imageProcessingMode || 'direct_multimodal')
        setOcrConfig(data.ocrConfig || createDefaultOcrConfig())
        setModelName(data.model || '')
        setSelectedModel(data.model || '')
      })
      .catch(error => {
        console.error('[AISidebar] load ai settings failed', error)
        if (!active) return
        setModelName('')
        setSelectedModel('')
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!activeProviderId) return

    let active = true
    setModelsLoading(true)
    fetch(`/api/ai/models?providerId=${encodeURIComponent(activeProviderId)}`)
      .then(async response => {
        const data = await response.json() as { models?: ModelOption[]; defaultModel?: string; detail?: string }
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
        return data
      })
      .then(data => {
        if (!active) return
        const models = Array.isArray(data.models) ? data.models : []
        setAvailableModels(models)
        const fallbackModel = data.defaultModel || ''
        setSelectedModel(prev => {
          if (prev && models.some(model => model.id === prev)) return prev
          return fallbackModel || models[0]?.id || prev
        })
      })
      .catch(error => {
        console.error('[AISidebar] load models failed', error)
        if (!active) return
        setAvailableModels([])
      })
      .finally(() => {
        if (active) setModelsLoading(false)
      })

    return () => {
      active = false
    }
  }, [activeProviderId])

  useEffect(() => {
    if (viewMode !== 'chat') return
    scrollToBottomIfNeeded()
  }, [messages, loading, scrollToBottomIfNeeded, viewMode])

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
    shouldAutoScrollRef.current = true
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
      }
    } catch (error) {
      console.error('[AISidebar] delete conversation failed', error)
    }
  }, [])

  const exportConversation = useCallback(async (conversationId?: string | null) => {
    const targetConversationId = conversationId ?? currentConversationIdRef.current
    const title = currentConversationTitle || 'conversation'

    let detail: ConversationDetail | null = null
    let reactTraces: unknown[] = []
    if (targetConversationId) {
      const response = await fetch(`/api/conversations/${targetConversationId}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      detail = await response.json() as ConversationDetail

      const traceResponse = await fetch(`/api/conversations/${targetConversationId}/react-traces`)
      if (traceResponse.ok) {
        const tracePayload = await traceResponse.json() as { traces?: unknown[] }
        reactTraces = Array.isArray(tracePayload.traces) ? tracePayload.traces : []
      }
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      conversationId: targetConversationId,
      title: detail?.title || title,
      mode: assistantMode,
      providerId: activeProviderId || null,
      model: selectedModel || modelName || null,
      imageProcessingMode,
      ocrConfig: {
        providerId: ocrConfig.providerId,
        endpoint: effectiveOcrEndpoint || null,
        model: ocrConfig.model || null,
      },
      includeSelection,
      currentContext: getContext(),
      storedMessages: detail?.messages ?? conversationMessagesRef.current,
      uiMessages: messages,
      reactHistory: buildReactMessages(detail?.messages ?? conversationMessagesRef.current, '').slice(0, -1),
      reactTraces,
    }

    const safeTitle = String(payload.title || 'conversation').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'conversation'
    downloadJsonFile(`${safeTitle}-${targetConversationId ?? 'draft'}.json`, payload)
  }, [activeProviderId, assistantMode, currentConversationTitle, effectiveOcrEndpoint, getContext, imageProcessingMode, includeSelection, messages, modelName, ocrConfig.model, ocrConfig.providerId, selectedModel])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const appendPendingImages = useCallback(async (incomingFiles: File[]) => {
    if (incomingFiles.length === 0) return

    if (imageProcessingMode === 'ocr_text' && !canUploadImages) {
      window.alert(
        imageProcessingMode === 'ocr_text'
          ? '当前已切换到 OCR 模式，但 OCR 配置未就绪。请先在设置中配置 OCR 模型、端点和 API Key。'
          : '当前模型未标记为支持图片输入。请先切换到多模态模型，再上传图片。',
      )
      return
    }

    const imageFiles = incomingFiles.filter(file => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const errors: string[] = []
    const existingTotalSize = pendingImages.reduce((sum, image) => sum + image.size, 0)
    const remainingSlots = Math.max(MAX_IMAGE_ATTACHMENT_COUNT - pendingImages.length, 0)
    if (remainingSlots <= 0) {
      window.alert(`最多只能附带 ${MAX_IMAGE_ATTACHMENT_COUNT} 张图片。`)
      return
    }

    let nextTotalSize = existingTotalSize
    const acceptedFiles: File[] = []
    for (const file of imageFiles.slice(0, remainingSlots)) {
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        errors.push(`${file.name} 超过 ${Math.floor(MAX_IMAGE_SIZE_BYTES / (1024 * 1024))}MB 限制`)
        continue
      }
      if (nextTotalSize + file.size > MAX_TOTAL_IMAGE_BYTES) {
        errors.push(`图片总大小不能超过 ${Math.floor(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))}MB`)
        break
      }
      acceptedFiles.push(file)
      nextTotalSize += file.size
    }

    if (imageFiles.length > remainingSlots) {
      errors.push(`最多只能附带 ${MAX_IMAGE_ATTACHMENT_COUNT} 张图片，超出的图片已忽略`)
    }

    if (acceptedFiles.length === 0) {
      if (errors.length > 0) window.alert(errors.join('\n'))
      return
    }

    const nextImages = await Promise.all(
      acceptedFiles.map(
        file =>
          new Promise<ImageAttachment>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () =>
              resolve({
                id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: file.name,
                size: file.size,
                type: file.type,
                dataUrl: String(reader.result ?? ''),
              })
            reader.onerror = () => reject(reader.error ?? new Error(`读取图片失败：${file.name}`))
            reader.readAsDataURL(file)
          }),
      ),
    )

    setPendingImages(prev => [...prev, ...nextImages])
    if (errors.length > 0) window.alert(errors.join('\n'))
  }, [canUploadImages, imageProcessingMode, pendingImages])

  const handleImagePick = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    await appendPendingImages(Array.from(files))
  }, [appendPendingImages])

  const removePendingImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(image => image.id !== id))
  }, [])

  const handleSend = useCallback(async (overrideText?: string) => {
    const rawText = (overrideText ?? input).trim()
    const text = rawText || (pendingImages.length > 0 ? buildDefaultImagePrompt(assistantMode) : '')
    if (!text || loading) return
    if (pendingImages.length > 0 && imageProcessingMode === 'ocr_text' && !canUploadImages) {
      window.alert(
        imageProcessingMode === 'ocr_text'
          ? 'OCR 配置未就绪，请先在设置中补充 OCR 模型、端点和 API Key。'
          : '当前模型未标记为支持图片输入。请切换到多模态模型后再发送。',
      )
      return
    }

    const shouldStartNewConversation = viewMode === 'history'
    const nextTitle = makeConversationTitle(text)
    const previousConversationMessages = shouldStartNewConversation ? [] : conversationMessagesRef.current
    const userMessage = makeUserMessage(text, sidebarWidth)
    const imagesForRequest = pendingImages

    // Capture selection tag for this message, then clear it from input area
    const currentSel = (includeSelection && editorState) ? serializeSelection(editorState) : null
    if (currentSel) {
      userMessage.selectionTag = {
        text: currentSel.selectedText,
        paragraphIndex: currentSel.paragraphIndex,
      }
    }

    const aiMessage = makeAiMessage('', true)

    setTodos([])
    todosRef.current = []
    setIsTodoPanelExpanded(false)
    setInput('')
    setPendingImages([])
    setIncludeSelection(true)
    resetTextareaHeight()
    shouldAutoScrollRef.current = true
    activeStreamingWriteRef.current = null

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
    let pendingStreamingChunk = ''
    let streamingFlushTimer: number | null = null

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
              arguments: JSON.stringify(getReplayToolParams(tool)),
            },
          }))
          : undefined,
        toolCalls: toolResults.length > 0
          ? toolResults.map(tool => ({
            id: tool.id,
            name: tool.name,
            params: tool.params,
            originalParams: tool.originalParams,
            status: tool.result.success ? 'ok' : 'err',
            message: tool.result.message,
            data: tool.result.data,
          }))
          : undefined,
      })
    }

    const flushStreamingWrite = (final = false) => {
      if (!pendingStreamingChunk) return
      if (streamingFlushTimer != null) {
        window.clearTimeout(streamingFlushTimer)
        streamingFlushTimer = null
      }
      if (!activeStreamingWriteRef.current || !editorView) {
        pendingStreamingChunk = ''
        return
      }

      const streamResult = appendStreamingWrite(
        editorView,
        activeStreamingWriteRef.current,
        pendingStreamingChunk,
        { final },
      )
      pendingStreamingChunk = ''

      if (!streamResult.success) {
        console.error('[AISidebar] append streaming write failed', streamResult.message)
        activeStreamingWriteRef.current = null
      }
    }

    const queueStreamingWrite = (chunk: string) => {
      if (!chunk) return
      pendingStreamingChunk += chunk

      if (pendingStreamingChunk.length >= STREAMING_WRITE_MAX_BUFFER) {
        flushStreamingWrite(false)
        return
      }

      if (streamingFlushTimer != null) return
      streamingFlushTimer = window.setTimeout(() => {
        streamingFlushTimer = null
        flushStreamingWrite(false)
      }, STREAMING_WRITE_FLUSH_MS)
    }

    const closeStreamingWriteSession = (reason: 'done' | 'tool_call' | 'awaiting_tool_results' | 'finish' | 'error') => {
      const session = activeStreamingWriteRef.current
      if (!session || !editorView) {
        activeStreamingWriteRef.current = null
        return null
      }

      if (!session.text.trim()) {
        const rollbackResult = abortStreamingWrite(editorView, session)
        console.warn('[AISidebar] begin_streaming_write finished without streamed content', { reason, rollbackResult })
        activeStreamingWriteRef.current = null
        return '检测到 `begin_streaming_write` 后没有实际输出正文，已自动撤销这次空写入。'
      }

      activeStreamingWriteRef.current = null
      return null
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

      const reactMessages = buildReactMessages(previousConversationMessages, text)
      let finished = false
      let sessionId = ''
      let currentToolPlan: ToolExecutionPlan | null = null

      // ── Single SSE connection for the entire ReAct session ──
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
          mode: assistantMode,
          model: selectedModel || modelName || undefined,
          providerId: activeProviderId || undefined,
          imageProcessingMode,
          ocrConfig: imageProcessingMode === 'ocr_text'
            ? {
              enabled: ocrConfig.enabled,
              providerId: ocrConfig.providerId,
              endpoint: effectiveOcrEndpoint || undefined,
              model: ocrConfig.model || undefined,
              timeoutSeconds: ocrConfig.timeoutSeconds,
              maxImages: ocrConfig.maxImages,
            }
            : undefined,
          images: imagesForRequest.map(image => ({
            name: image.name,
            type: image.type,
            size: image.size,
            dataUrl: image.dataUrl,
          })),
        }),
      })

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let roundAssistantText = ''
      let roundThinkingText = ''
      let roundNumber = 0
      const pendingToolCalls: ToolCallResult[] = []

      // Helper: execute pending tool calls and POST results back to session
      const executeAndPostToolResults = async (plan: ToolExecutionPlan) => {
        const persistedToolResults: ToolCallRecord[] = []
        const executionResults: Array<{ execution_id: string; content: string }> = []
        const selectionContext = extractSelectionContext(context)
        const toolCallsById = new Map<string, ToolCallResult>()
        for (const toolCall of pendingToolCalls) {
          if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
            toolCallsById.set(toolCall.id, toolCall)
          }
        }

        for (const execution of plan.executions) {
          const sourceToolCalls = execution.sourceToolCallIds
            .map(toolCallId => toolCallsById.get(toolCallId))
            .filter((toolCall): toolCall is ToolCallResult => toolCall !== undefined)
          const fallbackSourceCall: ToolCallResult = {
            id: execution.executionId,
            name: execution.toolName,
            params: execution.params,
            originalParams: execution.params,
            status: 'pending',
            isExpanded: false,
          }
          const leaderToolCall = sourceToolCalls[0] ?? fallbackSourceCall
          const executedParams = serializeToolParamsWithSelection(execution.toolName, execution.params, selectionContext)

          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

          let result: ExecuteResult
          if (execution.toolName === 'update_todo_list') {
            const rawTodos = Array.isArray(executedParams.todos) ? executedParams.todos : []
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
            todosRef.current = nextTodos
            result = { success: true, message: 'todo list updated' }
          } else if (execution.toolName === 'get_todo_list') {
            result = {
              success: true,
              message: todosRef.current.length > 0 ? `当前有 ${todosRef.current.length} 个任务` : '当前还没有任务计划',
              data: {
                todos: todosRef.current,
                total: todosRef.current.length,
                completed: todosRef.current.filter(todo => todo.status === 'completed').length,
                pending: todosRef.current.filter(todo => todo.status === 'pending').length,
                inProgress: todosRef.current.filter(todo => todo.status === 'in_progress').length,
                failed: todosRef.current.filter(todo => todo.status === 'failed').length,
              },
            }
          } else if (execution.toolName === 'begin_streaming_write') {
            const beginResult = editorView
              ? beginStreamingWrite(editorView, executedParams)
              : { success: false, message: '编辑器尚未就绪' }
            result = beginResult
            if ('session' in beginResult && beginResult.session) {
              activeStreamingWriteRef.current = beginResult.session
            }
          } else {
            result = editorView
              ? executeTool(editorView, execution.toolName, executedParams, {
                pageConfig,
                onPageConfigChange,
                onDocumentStyleMutation,
                selectionContext,
              })
              : { success: false, message: '编辑器尚未就绪' }
          }

          if (!result.success) {
            console.error('[AISidebar] tool call failed', execution.toolName, executedParams, result.message)
          }

          const mergedFollowerMessage = sourceToolCalls.length > 1
            ? `${result.success ? '已合并到后端执行计划' : '后端执行计划失败'}：${execution.toolName} x${sourceToolCalls.length}`
            : result.message
          const leaderId = sourceToolCalls[0]?.id ?? leaderToolCall.id

          updateMessage(message => {
            let nextMessage = updateToolCallInMessage(
              message,
              currentToolCall => Boolean(currentToolCall.id && execution.sourceToolCallIds.includes(currentToolCall.id)),
              currentToolCall => ({
                ...currentToolCall,
                params: currentToolCall.id === leaderId ? executedParams : currentToolCall.params,
                status: result.success ? 'ok' : 'err',
                message: currentToolCall.id === leaderId ? result.message : mergedFollowerMessage,
                data: result.data,
                isExpanded: false,
              }),
            )

            if (sourceToolCalls.length === 0) {
              nextMessage = updateToolCallInMessage(
                nextMessage,
                (currentToolCall, index, array) => currentToolCall.name === execution.toolName && index === array.findIndex(item => item.name === execution.toolName),
                currentToolCall => ({
                  ...currentToolCall,
                  params: executedParams,
                  status: result.success ? 'ok' : 'err',
                  message: result.message,
                  data: result.data,
                  isExpanded: false,
                }),
              )
            }

            const activityLabel =
              result.success === false
                ? '正在调整执行方案...'
                : execution.toolName === 'begin_streaming_write'
                  ? '正在写入正文...'
                  : '正在整理工具结果...'
            return { ...nextMessage, activityLabel }
          })
          const persistedSourceCalls: ToolCallResult[] = sourceToolCalls.length > 0 ? sourceToolCalls : [fallbackSourceCall]
          const sourceRecords = persistedSourceCalls.map(sourceToolCall => ({
            id: sourceToolCall.id ?? execution.executionId,
            name: sourceToolCall.name,
            params: executedParams,
            originalParams: normalizeToolParams(sourceToolCall.originalParams ?? sourceToolCall.params),
            result,
          }))
          persistedToolResults.push(...sourceRecords)
          executionResults.push({
            execution_id: execution.executionId,
            content: serializeToolResultPayload({
              toolName: execution.toolName,
              result,
              executedParams,
              originalParams: normalizeToolParams(leaderToolCall.originalParams ?? leaderToolCall.params),
              extra: {
                executionId: execution.executionId,
                mergeStrategy: execution.mergeStrategy,
                sourceToolCallIds: execution.sourceToolCallIds,
              },
            }),
          })
        }

        appendAssistantRound(roundAssistantText, roundThinkingText, persistedToolResults)

        persistedRecords.push(
          ...persistedToolResults.map(tool => ({
            role: 'tool' as const,
            tool_call_id: tool.id,
            content: serializeToolResult(tool),
          })),
        )

        if (sessionId) {
          const toolResultsResponse = await fetch(`/api/ai/react/${sessionId}/tool-results`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              plan_id: plan.planId,
              round: plan.round,
              results: executionResults,
              stop: false,
            }),
          })
          if (!toolResultsResponse.ok) throw new Error(`HTTP ${toolResultsResponse.status}`)
        }

        pendingToolCalls.length = 0
        currentToolPlan = null
      }

      // ── Read SSE events from the single long-lived connection ──
      while (!finished) {
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
            case 'session_created':
              sessionId = String(event.sessionId ?? '')
              break

            case 'round_start':
              roundNumber = Number(event.round ?? 0)
              roundAssistantText = ''
              roundThinkingText = ''
              currentToolPlan = null
              break

            case 'thinking':
              roundThinkingText += String(event.content ?? '')
              updateMessage(message => ({
                ...appendThinkingChunk(message, String(event.content ?? '')),
                activityLabel: '正在思考下一步...',
              }))
              break

            case 'content': {
              const chunk = String(event.content ?? '')
              roundAssistantText += chunk
              persistedAssistantText += chunk
              if (activeStreamingWriteRef.current && editorView) {
                queueStreamingWrite(chunk)
              }
              updateMessage(message => ({
                ...appendContentChunk(message, chunk),
                activityLabel: activeStreamingWriteRef.current ? '正在写入正文...' : '正在生成回复...',
              }))
              break
            }

            case 'tool_call': {
              flushStreamingWrite(true)
              const emptyStreamingWarning = closeStreamingWriteSession('tool_call')
              const toolCall: ToolCallResult = {
                id: typeof event.id === 'string' ? event.id : undefined,
                name: String(event.name ?? ''),
                params: normalizeToolParams(event.params),
                originalParams: normalizeToolParams(event.params),
                status: 'pending',
                isExpanded: true,
              }

              updateMessage(message => {
                const withWarning = emptyStreamingWarning
                  ? appendContentChunk(message, `${message.text ? '\n\n' : ''}${emptyStreamingWarning}`)
                  : message
                return {
                  ...appendToolSegment(withWarning, toolCall),
                  activityLabel: `正在调用 ${toolCall.name}...`,
                }
              })
              pendingToolCalls.push(toolCall)
              break
            }

            case 'tool_plan': {
              const nextToolPlan = parseToolPlanEvent(event)
              currentToolPlan = nextToolPlan
              if (nextToolPlan) {
                updateMessage(message => ({
                  ...message,
                  activityLabel: nextToolPlan.executions.length > 1
                    ? `后端已生成 ${nextToolPlan.executions.length} 个执行步骤`
                    : '后端已生成工具执行计划',
                }))
              }
              break
            }

            case 'awaiting_tool_results':
              flushStreamingWrite(true)
              {
                const emptyStreamingWarning = closeStreamingWriteSession('awaiting_tool_results')
                if (emptyStreamingWarning) {
                  updateMessage(message => ({
                    ...appendContentChunk(message, `${message.text ? '\n\n' : ''}${emptyStreamingWarning}`),
                    activityLabel: '正在整理工具结果...',
                  }))
                }
              }

              if (pendingToolCalls.length > 0) {
                const plan = currentToolPlan ?? buildFallbackToolPlan(roundNumber, pendingToolCalls)
                await executeAndPostToolResults(plan)
              }
              break

            case 'round_complete': {
              flushStreamingWrite(true)
              const emptyStreamingWarning = closeStreamingWriteSession('finish')
              if (roundAssistantText || roundThinkingText) {
                appendAssistantRound(roundAssistantText, roundThinkingText, [])
              }
              updateMessage(message => {
                const nextMessage = emptyStreamingWarning
                  ? appendContentChunk(message, `${message.text ? '\n\n' : ''}${emptyStreamingWarning}`)
                  : message
                return {
                  ...nextMessage,
                  activityLabel: String(event.message ?? '正在继续执行后续步骤...'),
                }
              })
              break
            }

            case 'done':
              flushStreamingWrite(true)
              finished = true
              {
                const emptyStreamingWarning = closeStreamingWriteSession('done')
                // Persist the final round (content-only, no tools)
                if (roundAssistantText || roundThinkingText) {
                  appendAssistantRound(roundAssistantText, roundThinkingText, [])
                }
                updateMessage(message => {
                  let nextMessage = emptyStreamingWarning
                    ? appendContentChunk(message, `${message.text ? '\n\n' : ''}${emptyStreamingWarning}`)
                    : message
                  if (String(event.reason ?? '') === 'max_rounds') {
                    nextMessage = appendContentChunk(nextMessage, `${nextMessage.text ? '\n\n' : ''}已执行 ${roundNumber} 轮操作，已停止当前自动链路。请根据当前结果继续下达下一步指令。`)
                  }
                  return { ...nextMessage, streaming: false, activityLabel: '' }
                })
              }
              break

            case 'error':
              throw new Error(String(event.message ?? 'AI 请求失败'))

            case 'recovery': {
              const action = String(event.action ?? '')
              const attempt = Number(event.attempt ?? 0)
              if (action === 'retry') {
                const delay = Number(event.delay ?? 1)
                updateMessage(message => ({
                  ...message,
                  activityLabel: `API 请求失败，${delay}s 后重试（第 ${attempt} 次）...`,
                }))
              } else if (action === 'context_compress') {
                const tier = Number(event.tier ?? 1)
                updateMessage(message => ({
                  ...message,
                  activityLabel: `上下文过长，正在压缩（级别 ${tier}）...`,
                }))
              } else if (action === 'output_continue') {
                updateMessage(message => ({
                  ...message,
                  activityLabel: String(event.message ?? `模型输出被截断，正在继续生成（第 ${attempt} 次）...`),
                }))
              }
              break
            }

            case 'compression': {
              const tier = Number(event.tier ?? 1)
              updateMessage(message => ({
                ...message,
                activityLabel: `上下文压缩（级别 ${tier}）`,
              }))
              break
            }

            case 'budget_warning': {
              updateMessage(message => ({
                ...message,
                activityLabel: String(event.message ?? '自动预算接近上限，正在收敛步骤...'),
              }))
              break
            }

            case 'stop_hook': {
              const hint = String(event.hint ?? '')
              if (hint) {
                updateMessage(message => ({
                  ...appendContentChunk(message, `${message.text ? '\n\n' : ''}> ⚠️ ${hint}`),
                  activityLabel: '检测到异常模式，正在调整策略...',
                }))
              }
              break
            }

            case 'ask_continue':
            case 'round':
              break
          }
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
      if (streamingFlushTimer != null) {
        window.clearTimeout(streamingFlushTimer)
        streamingFlushTimer = null
      }
      flushStreamingWrite(true)
      closeStreamingWriteSession('error')
      if (error instanceof Error && error.name === 'AbortError') {
        persistedAssistantText = '（已取消）'
        if (!persistedRecords.some(message => message.role === 'assistant')) {
          persistedRecords.push({ role: 'assistant', content: persistedAssistantText })
        }
        setMessages(prev =>
          prev.map(message =>
            message.id === aiMessage.id
              ? { ...appendContentChunk(message, message.text ? '' : '（已取消）'), streaming: false, activityLabel: '' }
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
              ? { ...appendContentChunk(message, errorText, true), streaming: false, activityLabel: '' }
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
      if (streamingFlushTimer != null) {
        window.clearTimeout(streamingFlushTimer)
        streamingFlushTimer = null
      }
      flushStreamingWrite(true)
      closeStreamingWriteSession('finish')
      setLoading(false)
      abortRef.current = null
      void loadConversations()
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [activeProviderId, assistantMode, canUploadImages, currentModelSupportsVision, editorState, editorView, effectiveOcrEndpoint, getContext, imageProcessingMode, includeSelection, input, loadConversations, loading, modelName, ocrConfig.enabled, ocrConfig.maxImages, ocrConfig.model, ocrConfig.providerId, ocrConfig.timeoutSeconds, onDocumentStyleMutation, onPageConfigChange, pageConfig, pendingImages, resetTextareaHeight, selectedModel, sidebarWidth, viewMode])

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
            <span className="font-semibold text-sm truncate">🤖 openwps</span>
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
            }}
            className="px-1.5 py-0.5 rounded hover:bg-blue-500 text-sm flex-shrink-0"
            title="返回会话历史"
          >
            ←
          </button>
          <div className="min-w-0 flex-1 font-semibold text-sm truncate">{currentConversationTitle || '新会话'}</div>
          <button
            onClick={() => void exportConversation()}
            className="px-1.5 py-0.5 rounded hover:bg-blue-500 text-sm flex-shrink-0"
            title="导出当前会话调试 JSON"
          >
            ⤓
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-500 text-lg leading-none flex-shrink-0"
            title="关闭侧边栏"
          >
            ×
          </button>
        </div>
      )}

      <div
        ref={scrollAreaRef}
        onScroll={event => {
          const element = event.currentTarget
          const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
          shouldAutoScrollRef.current = distanceToBottom < 48
        }}
        className="flex-1 overflow-y-auto min-h-0 p-3"
      >
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
                    onClick={() => void exportConversation(conversation.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-500 text-sm flex-shrink-0"
                    title="导出会话 JSON"
                  >
                    ⤓
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
              <div className="sticky top-0 z-20 -mx-1 px-1 pb-1">
                <div className="border border-blue-200 rounded-xl overflow-hidden bg-blue-50/95 backdrop-blur-sm shadow-sm flex-shrink-0">
                  {(() => {
                    const activeTodo = todos.find(todo => todo.status === 'in_progress')
                      ?? todos.find(todo => todo.status === 'pending')
                      ?? todos.at(-1)
                    return (
                      <>
                        <button
                          type="button"
                          onClick={() => setIsTodoPanelExpanded(prev => !prev)}
                          className="w-full flex items-center justify-between px-3 py-2 bg-blue-100 hover:bg-blue-200 transition-colors text-left select-none"
                        >
                          <span className="min-w-0">
                            <span className="text-xs font-semibold text-blue-700 tracking-wide">📋 任务计划</span>
                            {!isTodoPanelExpanded && activeTodo && (
                              <span className="mt-0.5 block truncate text-[11px] text-blue-600">
                                {activeTodo.status === 'completed' ? '已完成' :
                                  activeTodo.status === 'failed' ? '失败' :
                                    activeTodo.status === 'in_progress' ? '进行中' : '待处理'}：{activeTodo.title}
                              </span>
                            )}
                          </span>
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
                      </>
                    )
                  })()}
                </div>
              </div>
            )}
            {/* End Todo Panel */}

            {messages.map(message => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {message.role === 'user' ? (
                  <div className="flex flex-col items-end gap-1">
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
                    {message.selectionTag && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-blue-50 border border-blue-200 text-blue-500">
                        <span>📎</span>
                        <span className="max-w-[120px] truncate">
                          {message.selectionTag.text.length > 15
                            ? `${message.selectionTag.text.slice(0, 15)}…`
                            : message.selectionTag.text}
                        </span>
                        <span className="opacity-50">P{message.selectionTag.paragraphIndex + 1}</span>
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="w-full min-w-0 space-y-1.5">
                    {message.segments.length > 0 ? (
                      <div className="relative space-y-2 pl-4 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-gradient-to-b before:from-slate-200 before:via-slate-200 before:to-transparent">
                        {(() => {
                          let toolSegmentIndex = -1
                          return message.segments.map((segment, segmentIndex) => {
                            if (segment.type === 'content') {
                              const isStreamingSegment = message.streaming && segmentIndex === message.segments.length - 1
                              return isStreamingSegment ? (
                                <div
                                  key={segment.id}
                                  className="relative w-full text-sm text-gray-800 leading-6 before:absolute before:-left-4 before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-slate-300"
                                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                >
                                  {segment.text}
                                  <span
                                    className="inline-block w-0.5 h-4 bg-gray-600 ml-0.5 align-middle"
                                    style={{ animation: 'blink 1s step-end infinite' }}
                                  />
                                </div>
                              ) : (
                                <div
                                  key={segment.id}
                                  className="ai-markdown relative w-full text-sm text-gray-800 leading-6 before:absolute before:-left-4 before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-slate-300"
                                  dangerouslySetInnerHTML={{ __html: toHtml(segment.text) }}
                                />
                              )
                            }

                            if (segment.type === 'thinking') {
                              return (
                                <div
                                  key={segment.id}
                                  className="relative border-l-2 border-dashed border-slate-200 pl-3 text-[13px] leading-6 text-slate-500 before:absolute before:-left-[18px] before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-sky-300"
                                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                >
                                  <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-sky-500/80">
                                    Thinking
                                  </div>
                                  <div>{segment.text}</div>
                                </div>
                              )
                            }

                            toolSegmentIndex += 1
                            const toolIndex = toolSegmentIndex
                            const toolCall = segment.toolCall
                            if (toolCall.name === 'update_todo_list') return null
                            const isCollapsed = toolCall.status !== 'pending' && !toolCall.isExpanded

                            return (
                              <div key={segment.id} className="relative space-y-1 before:absolute before:-left-4 before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-slate-300">
                                {!isCollapsed && (
                                  <div className="text-[12px] leading-5 text-gray-500">
                                    准备调用工具：{summarizeToolPurpose(toolCall)}
                                  </div>
                                )}
                                {isCollapsed ? (
                                  <button
                                    type="button"
                                    className={`group flex w-full items-center gap-2 text-left text-[12px] leading-5 text-slate-400 transition-colors hover:text-slate-700 ${toolStatusTone(toolCall)}`}
                                    onClick={() => {
                                      shouldAutoScrollRef.current = false
                                      setMessages(prev =>
                                        prev.map(item => {
                                          if (item.id !== message.id) return item
                                          const nextToolCalls = item.toolCalls.map((currentToolCall, currentIndex) => (
                                            currentIndex === toolIndex
                                              ? { ...currentToolCall, isExpanded: true }
                                              : currentToolCall
                                          ))
                                          let currentToolIdx = -1
                                          const nextSegments = item.segments.map(currentSegment => {
                                            if (currentSegment.type !== 'tool') return currentSegment
                                            currentToolIdx += 1
                                            return currentToolIdx === toolIndex
                                              ? { ...currentSegment, toolCall: { ...currentSegment.toolCall, isExpanded: true } }
                                              : currentSegment
                                          })
                                          return { ...item, toolCalls: nextToolCalls, segments: nextSegments }
                                        }),
                                      )
                                    }}
                                  >
                                    <span className="font-mono text-[12px] text-slate-400 transition-colors group-hover:text-slate-700">
                                      {toolCall.name}
                                    </span>
                                    <span className="text-[11px] text-slate-400 opacity-0 transition-opacity group-hover:opacity-100">
                                      ▸
                                    </span>
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className={`group w-full text-left text-xs ${toolCall.status === 'ok'
                                      ? 'text-green-700'
                                      : toolCall.status === 'err'
                                        ? 'text-red-600'
                                        : 'text-gray-400'
                                      }`}
                                    onClick={() => {
                                      shouldAutoScrollRef.current = false
                                      setMessages(prev =>
                                        prev.map(item => {
                                          if (item.id !== message.id) return item
                                          const isExpanded = !toolCall.isExpanded
                                          const nextToolCalls = item.toolCalls.map((currentToolCall, currentIndex) => (
                                            currentIndex === toolIndex
                                              ? { ...currentToolCall, isExpanded }
                                              : currentToolCall
                                          ))
                                          let currentToolIdx = -1
                                          const nextSegments = item.segments.map(currentSegment => {
                                            if (currentSegment.type !== 'tool') return currentSegment
                                            currentToolIdx += 1
                                            return currentToolIdx === toolIndex
                                              ? { ...currentSegment, toolCall: { ...currentSegment.toolCall, isExpanded } }
                                              : currentSegment
                                          })
                                          return { ...item, toolCalls: nextToolCalls, segments: nextSegments }
                                        }),
                                      )
                                    }}
                                  >
                                    <div className="flex items-start gap-2">
                                      <span className="mt-0.5 flex-shrink-0">
                                        {toolCall.status === 'ok' ? '✅' : toolCall.status === 'err' ? '❌' : '⏳'}
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-start justify-between gap-2">
                                          <div className="font-mono break-all text-[11px] text-gray-700">
                                            {toolCall.name}
                                          </div>
                                          <span className="flex-shrink-0 text-[11px] text-gray-400">
                                            {toolCall.isExpanded ? '▾' : '▸'}
                                          </span>
                                        </div>

                                        {toolCall.isExpanded && (
                                          <div className="mt-2 space-y-2">
                                            <div className="text-[12px] leading-5 text-gray-600">
                                              目的：{buildToolActionLabel(toolCall)}
                                            </div>
                                            <div>
                                              <div className="text-[10px] uppercase tracking-wide text-gray-400">params</div>
                                              <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] leading-4 opacity-80 bg-white border border-gray-200 rounded-md px-2 py-1 text-gray-700">
                                                {formatToolParams(toolCall.params)}
                                              </pre>
                                            </div>
                                            {toolCall.data != null && (
                                              <div>
                                                <div className="text-[10px] uppercase tracking-wide text-gray-400">data</div>
                                                <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] leading-4 opacity-90 bg-white border border-gray-200 rounded-md px-2 py-1 max-h-72 overflow-auto text-gray-700">
                                                  {formatToolData(toolCall.data)}
                                                </pre>
                                              </div>
                                            )}
                                            {toolCall.message && (
                                              <div className="text-[11px] leading-4 text-gray-500 break-all">{toolCall.message}</div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </button>
                                )}
                              </div>
                            )
                          })
                        })()}
                      </div>
                    ) : message.streaming ? (
                      <div className="text-sm text-gray-400 leading-6">等待模型开始输出...</div>
                    ) : null}

                    {message.streaming && message.activityLabel && (
                      <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50/80 px-3 py-1 text-[11px] text-blue-600">
                        <span className="inline-flex h-2 w-2 rounded-full bg-blue-400 ai-status-pulse" />
                        <span className="ai-status-glow">{message.activityLabel}</span>
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

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 p-2.5 flex-shrink-0">
        {(() => {
          const sel = editorState ? serializeSelection(editorState) : null
          const hasTopContent = Boolean(sel) || pendingImages.length > 0

          return (
            <div className="rounded-[24px] border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)] overflow-hidden">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={async event => {
                  try {
                    await handleImagePick(event.target.files)
                  } catch (error) {
                    console.error('[AISidebar] pick image failed', error)
                  } finally {
                    event.target.value = ''
                  }
                }}
              />

              <div className="border-b border-slate-100 bg-slate-50/80 px-3 py-2">
                {hasTopContent ? (
                  <div className="flex flex-wrap gap-2">
                    {pendingImages.map(image => (
                      <div
                        key={image.id}
                        className="group flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-2 py-2 shadow-sm"
                      >
                        <img
                          src={image.dataUrl}
                          alt={image.name}
                          className="h-10 w-10 rounded-xl object-cover border border-slate-200 bg-slate-100"
                        />
                        <div className="min-w-0">
                          <div className="max-w-[140px] truncate text-xs font-medium text-slate-700">{image.name}</div>
                          <div className="text-[11px] text-slate-400">{formatFileSize(image.size)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removePendingImage(image.id)}
                          className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                          title="移除图片"
                        >
                          ×
                        </button>
                      </div>
                    ))}

                    {sel && (
                      <button
                        type="button"
                        onMouseDown={event => {
                          event.preventDefault()
                          setIncludeSelection(prev => !prev)
                        }}
                        className={`inline-flex max-w-full items-center gap-2 rounded-2xl border px-3 py-2 text-left text-xs transition-colors ${includeSelection
                          ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                          : 'border-slate-200 bg-slate-100 text-slate-400 hover:bg-slate-200 line-through'
                          }`}
                        title={includeSelection ? '点击取消携带选中内容' : '点击携带选中内容'}
                      >
                        <span className="text-sm">“</span>
                        <span className="max-w-[180px] truncate">
                          {sel.selectedText.length > 36
                            ? `${sel.selectedText.slice(0, 36)}…`
                            : sel.selectedText}
                        </span>
                        <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] text-current">
                          引用 P{sel.paragraphIndex + 1}
                        </span>
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">
                    {imageProcessingMode === 'ocr_text'
                      ? (isOcrReady
                        ? '当前使用 OCR + 文本模型 路径。上传图片后会先提取内容和样式线索，再交给主模型继续处理。'
                        : '当前已切换到 OCR 模式，但 OCR 配置未就绪；请先在设置中补充 OCR 模型、端点和 API Key。')
                      : (currentModelSupportsVision
                        ? '上传图片或附带当前选区后，会显示在这里并随本轮请求一起发送。'
                        : '当前模型未明确标记为多模态，仍会尝试发送图片；若上游拒绝，请切换到支持视觉的模型或改用 OCR 路径。')}
                  </div>
                )}
                {pendingImages.length > 0 && imageProcessingMode === 'ocr_text' && !canUploadImages && (
                  <div className="mt-2 text-[11px] text-amber-600">
                    {imageProcessingMode === 'ocr_text'
                      ? '当前 OCR 配置未就绪，请先在设置中补充 OCR 模型、端点和 API Key。'
                      : '当前模型未标记为支持图片输入，请先切换到多模态模型再发送。'}
                  </div>
                )}
              </div>

              <div className="px-3 py-2.5">
                <textarea
                  ref={textareaRef}
                  className="w-full resize-none border-0 bg-transparent text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400"
                  rows={3}
                  placeholder={
                    assistantMode === 'agent'
                      ? (viewMode === 'history' ? '输入写作或排版需求，Agent 会边写边排…' : '继续让 Agent 写内容、调样式或处理分页…')
                      : assistantMode === 'layout'
                        ? (viewMode === 'history' ? '输入排版指令，自动新建会话…' : '继续输入排版指令…')
                        : (viewMode === 'history' ? '输入写作/删改指令，自动新建会话…' : '继续输入写作/删改指令…')
                  }
                  value={input}
                  style={{ minHeight: '72px', maxHeight: '200px', overflowY: 'auto' }}
                  onChange={event => {
                    setInput(event.target.value)
                    autoResize(event.target)
                  }}
                  onPaste={event => {
                    const pastedImageFiles = extractClipboardImageFiles(event)
                    if (pastedImageFiles.length === 0) return
                    event.preventDefault()
                    void appendPendingImages(pastedImageFiles)
                  }}
                  onCompositionStart={() => {
                    isComposingRef.current = true
                  }}
                  onCompositionEnd={() => {
                    isComposingRef.current = false
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !isComposingRef.current) {
                      event.preventDefault()
                      void handleSend()
                    }
                  }}
                  disabled={loading}
                />
              </div>

              <div className="border-t border-slate-100 bg-slate-50/90 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-full border border-slate-200 bg-white pl-3 pr-2 py-1.5 text-[11px] text-slate-500">
                    <span className="shrink-0">模型</span>
                    <select
                      value={selectedModel || modelName}
                      onChange={event => setSelectedModel(event.target.value)}
                      disabled={loading || modelsLoading || (availableModels.length === 0 && !modelName)}
                      className="min-w-0 flex-1 bg-transparent text-slate-700 outline-none"
                      title={selectedModel || modelName || '未配置模型'}
                    >
                      {selectedModel && !availableModels.some(model => model.id === selectedModel) && (
                        <option value={selectedModel}>{selectedModel}</option>
                      )}
                      {!selectedModel && modelName && !availableModels.some(model => model.id === modelName) && (
                        <option value={modelName}>{modelName}</option>
                      )}
                      {availableModels.map(model => (
                        <option key={model.id} value={model.id}>{model.supportsVision ? `${model.id} · 多模态` : model.id}</option>
                      ))}
                      {availableModels.length === 0 && (
                        <option value={selectedModel || modelName || ''}>
                          {modelsLoading ? '模型加载中...' : (selectedModel || modelName || '未配置模型')}
                        </option>
                      )}
                    </select>
                  </label>

                  <div className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] ${currentModelSupportsVision ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                    {currentModelSupportsVision ? '多模态' : '视觉待确认'}
                  </div>

                  <div className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] ${imageProcessingMode === 'ocr_text' ? (isOcrReady ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-amber-200 bg-amber-50 text-amber-700') : 'border-slate-200 bg-white text-slate-500'}`}>
                    {imageProcessingMode === 'ocr_text'
                      ? (isOcrReady ? 'OCR 模式' : 'OCR 未就绪')
                      : '直连模式'}
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <div className="inline-flex min-w-0 flex-1 rounded-full border border-slate-200 bg-white p-0.5">
                    <button
                      type="button"
                      onClick={() => setAssistantMode('agent')}
                      className={`flex-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[11px] transition-colors ${assistantMode === 'agent'
                        ? 'bg-violet-600 text-white'
                        : 'text-slate-500 hover:bg-slate-100'
                        }`}
                      title="Agent 模式：可同时写正文和排版，是主推荐模式"
                    >
                      Agent
                    </button>
                    <button
                      type="button"
                      onClick={() => setAssistantMode('layout')}
                      className={`flex-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[11px] transition-colors ${assistantMode === 'layout'
                        ? 'bg-blue-500 text-white'
                        : 'text-slate-500 hover:bg-slate-100'
                        }`}
                      title="排版模式：只能排版，不能改写正文"
                    >
                      排版
                    </button>
                    <button
                      type="button"
                      onClick={() => setAssistantMode('edit')}
                      className={`flex-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[11px] transition-colors ${assistantMode === 'edit'
                        ? 'bg-emerald-500 text-white'
                        : 'text-slate-500 hover:bg-slate-100'
                        }`}
                      title="Edit 模式：可写作、删改正文"
                    >
                      Edit
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={loading || !canUploadImages}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1.5 text-[11px] transition-colors ${loading || !canUploadImages ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'}`}
                    title={imageProcessingMode === 'ocr_text' ? (isOcrReady ? '上传图片并走 OCR 预处理' : 'OCR 配置未就绪') : (currentModelSupportsVision ? '上传图片' : '上传图片并尝试直连多模态；若模型不支持会在发送时提示')}
                  >
                    <span>＋</span>
                    <span>图片</span>
                  </button>

                  <div className="ml-auto shrink-0">
                    {loading ? (
                      <button
                        onClick={handleCancel}
                        className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-red-500 px-3 text-sm text-white transition-colors hover:bg-red-600"
                        title="取消"
                      >
                        ⏹
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleSend()}
                        disabled={!canSendMessage}
                        className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-slate-900 px-3 text-sm text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                        title="发送 (Enter)"
                      >
                        ↑
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })()}
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        @keyframes pulse-soft { 0%,100%{transform:scale(1);opacity:.8} 50%{transform:scale(1.18);opacity:1} }
        .ai-status-glow {
          background-image: linear-gradient(90deg, #64748b 0%, #3b82f6 35%, #0f172a 50%, #3b82f6 65%, #64748b 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: shimmer 2s linear infinite;
        }
        .ai-status-pulse {
          animation: pulse-soft 1.1s ease-in-out infinite;
        }
      `}</style>
    </div>
  )
}
